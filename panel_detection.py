import os
import io
import torch
import warnings
import logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from fastapi.responses import JSONResponse
from PIL import Image
import numpy as np

# Configure logging
logger = logging.getLogger("panel_detection")

# Create router
router = APIRouter(prefix="/api/model", tags=["panel-detection"])

# Globals for model state
class ModelManager:
    _instance = None
    
    def __init__(self):
        self.model = None
        self.processor = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.is_loading = False

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load_model(self):
        if self.model is not None:
            return True # Already loaded
            
        self.is_loading = True
        try:
            from transformers import AutoModelForCausalLM, AutoProcessor
            
            logger.info(f"Loading MagiV3 model on {self.device}...")
            self.model = AutoModelForCausalLM.from_pretrained(
                "ragavsachdeva/magiv3",
                torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
                trust_remote_code=True,
                attn_implementation="eager" # Force eager attention to avoid flash_attn requirement
            ).to(self.device).eval()

            self.processor = AutoProcessor.from_pretrained(
                "ragavsachdeva/magiv3",
                trust_remote_code=True
            )
            logger.info("✅ MagiV3 Model and processor loaded")
            return True
        except Exception as e:
            logger.error(f"❌ Failed to load model: {e}", exc_info=True)
            self.model = None
            self.processor = None
            raise e
        finally:
            self.is_loading = False

    def unload_model(self):
        if self.model is not None:
            del self.model
            del self.processor
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            self.model = None
            self.processor = None
            logger.info("Model unloaded")
        return True

    def get_status(self):
        return {
            "loaded": self.model is not None,
            "loading": self.is_loading,
            "device": self.device,
            "cuda_available": torch.cuda.is_available()
        }

    def predict(self, image: Image.Image):
        if self.model is None or self.processor is None:
            raise RuntimeError("Model not loaded")
            
        with torch.no_grad():
            results = self.model.predict_detections_and_associations([image], self.processor)
            
        return results[0]

# Initialize manager
model_manager = ModelManager.get_instance()

@router.post("/load")
async def load_model_endpoint():
    """Load the panel detection model into memory."""
    try:
        if model_manager.is_loading:
             return JSONResponse({"status": "loading", "message": "Model is already loading"})
             
        if model_manager.model is not None:
            return JSONResponse({"status": "loaded", "message": "Model already loaded"})

        # Run in thread pool to avoid blocking async loop
        import asyncio
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, model_manager.load_model)
        
        return JSONResponse({"status": "loaded", "message": "Model loaded successfully"})
    except Exception as e:
        return JSONResponse(
            status_code=500, 
            content={"status": "error", "message": str(e)}
        )

@router.post("/unload")
async def unload_model_endpoint():
    """Unload the model to free up memory."""
    model_manager.unload_model()
    return JSONResponse({"status": "unloaded", "message": "Model unloaded"})

@router.get("/status")
async def get_model_status():
    """Get current model status."""
    return model_manager.get_status()

@router.post("/detect")
async def detect_panels(file: UploadFile = File(...)):
    """Run panel detection on an uploaded image."""
    if model_manager.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
        
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        
        # Run prediction
        result = model_manager.predict(image)
        panel_boxes = result["panels"] # List of [x1, y1, x2, y2]
        
        # Convert to list of dicts for JSON response
        panels = []
        for i, box in enumerate(panel_boxes):
            panels.append({
                "id": i,
                "box": [int(b) for b in box] # Ensure standard python ints
            })
            
        return {"panels": panels}
        
    except Exception as e:
        logger.error(f"Detection error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

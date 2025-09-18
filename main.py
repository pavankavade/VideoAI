import os
import io
import logging
from typing import List, Dict, Any, Optional, Tuple

from fastapi import FastAPI, File, UploadFile, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from PIL import Image

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("manga_narrator")
try:
    from dotenv import load_dotenv  # type: ignore
    # Load variables from a .env file in project root if present
    load_dotenv()
    logger.info("Loaded environment variables from .env (if present)")
except Exception:
    logger.info("python-dotenv not installed; skipping .env loading")


# Base paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "cv_model"), exist_ok=True)

# No ONNX path; using LayoutParser if available, else fallback

gemini_available = False
genai = None
try:
    import google.generativeai as genai  # type: ignore

    api_key = os.environ.get("GOOGLE_API_KEY")
    if api_key:
        genai.configure(api_key=api_key)
        gemini_available = True
        logger.info("Gemini configured with GOOGLE_API_KEY")
    else:
        logger.warning("GOOGLE_API_KEY not set; will use narration fallback unless REQUIRE_GEMINI is set. Ensure key is in shell or .env")
except Exception:
    genai = None
    gemini_available = False
    logger.exception("Failed to import/configure google-generativeai; will use narration fallback")

REQUIRE_GEMINI = os.environ.get("REQUIRE_GEMINI", "0").lower() in {"1", "true", "yes"}
# Default to using LayoutParser when available unless explicitly disabled
_lp_env = os.environ.get("USE_LAYOUTPARSER")
USE_LAYOUTPARSER = True if _lp_env is None else _lp_env.lower() in {"1", "true", "yes"}

# Optional LayoutParser (Detectron2) model
lp_model = None
lp_available = False
if USE_LAYOUTPARSER:
    try:
        import layoutparser as lp  # type: ignore

        # PubLayNet Faster R-CNN; label_map documented by layoutparser
        lp_model = lp.Detectron2LayoutModel(
            "lp://PubLayNet/faster_rcnn_R_50_FPN_3x/config",
            extra_config=["MODEL.ROI_HEADS.SCORE_THRESH_TEST", 0.5],
            label_map={0: "Text", 1: "Title", 2: "List", 3: "Table", 4: "Figure"},
            device="cpu",
        )
        lp_available = True
        logger.info("LayoutParser PubLayNet model initialized (CPU). Using LP path for panel detection.")
    except Exception as e:
        lp_model = None
        lp_available = False
        logger.warning("LayoutParser not available (%s); will skip LP path", e)
else:
    logger.info("USE_LAYOUTPARSER explicitly disabled; skipping LayoutParser path")

# Optional Ultralytics YOLOv8 model (CPU)
yolo_model = None
yolo_available = False
YOLO_MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", "yolov8n.pt")
try:
    from ultralytics import YOLO  # type: ignore

    # Lazy load later on first use to avoid startup hit; mark available
    yolo_available = True
    logger.info("YOLOv8 available; will load model on first use from %s", YOLO_MODEL_PATH)
except Exception as e:
    yolo_available = False
    YOLO = None  # type: ignore
    logger.info("Ultralytics YOLO not available (%s); skipping YOLO path", e)

# Optional OWL-ViT zero-shot detector (prompt-based)
USE_OWLVIT = os.environ.get("USE_OWLVIT", "0").lower() in {"1", "true", "yes"}
OWLVIT_PROMPTS = [s.strip() for s in os.environ.get("OWLVIT_PROMPTS", "comic panel, panel, frame").split(",") if s.strip()]
owl_model = None
owl_processor = None
owl_available = False
if USE_OWLVIT:
    try:
        from transformers import Owlv2ForObjectDetection, Owlv2Processor  # type: ignore

        owl_available = True
        logger.info("OWL-ViT enabled; will lazy-load model on first use with prompts: %s", OWLVIT_PROMPTS)
    except Exception as e:
        owl_available = False
        logger.info("OWL-ViT transformers not available (%s); skipping OWL path", e)

# Optional DeepPanel (U-Net segmentation) via TensorFlow
USE_DEEPPANEL = os.environ.get("USE_DEEPPANEL", "0").lower() in {"1", "true", "yes"}
DEEPPANEL_MODEL_PATH = os.path.join(BASE_DIR, os.environ.get("DEEPPANEL_MODEL_PATH", "deeppanel_model"))
deeppanel_available = False
deeppanel_model = None
if USE_DEEPPANEL:
    try:
        import tensorflow as tf  # type: ignore
        if os.path.isdir(DEEPPANEL_MODEL_PATH):
            deeppanel_model = tf.saved_model.load(DEEPPANEL_MODEL_PATH)
            deeppanel_available = True
            logger.info("DeepPanel model loaded from %s", DEEPPANEL_MODEL_PATH)
        else:
            logger.warning("DeepPanel model path not found: %s", DEEPPANEL_MODEL_PATH)
    except Exception as e:
        deeppanel_available = False
        deeppanel_model = None
        logger.info("DeepPanel unavailable (%s)", e)

def detect_panels_deeppanel(image: Image.Image) -> List[Tuple[int, int, int, int]]:
    try:
        import numpy as np  # type: ignore
        import cv2  # type: ignore
        import tensorflow as tf  # type: ignore
        if deeppanel_model is None:
            return []
        # DeepPanel examples use 512x512; adjust if your model differs
        img_rgb = image.convert("RGB").resize((512, 512))
        arr = np.asarray(img_rgb).astype("float32") / 255.0
        x = tf.convert_to_tensor(arr[None, ...])
        outputs = deeppanel_model(x)
        # Assume single-channel mask in outputs["masks"] or first tensor
        if isinstance(outputs, dict):
            y = list(outputs.values())[0]
        else:
            y = outputs
        mask = y[0].numpy()
        if mask.ndim == 3:
            mask = mask[..., 0]
        mask = (mask > 0.5).astype("uint8") * 255
        # Resize mask to original size
        mask = cv2.resize(mask, image.size, interpolation=cv2.INTER_NEAREST)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes: List[Tuple[int, int, int, int]] = []
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            if w <= 10 or h <= 10:
                continue
            boxes.append((int(x), int(y), int(w), int(h)))
        if boxes:
            boxes = merge_overlapping_boxes(boxes, iou_threshold=0.2)
            boxes.sort(key=lambda b: (b[1], b[0]))
            return boxes
        return []
    except Exception as e:
        logger.info("DeepPanel detection failed (%s)", e)
        return []

def detect_panels_opencv(image: Image.Image) -> List[Tuple[int, int, int, int]]:
    """Heuristic panel detection via borders/gutters using OpenCV.
    Steps: grayscale -> adaptive threshold -> morphology -> find contours -> rectangles.
    Returns boxes sorted top-to-bottom then left-to-right.
    """
    try:
        import numpy as np  # type: ignore
        import cv2  # type: ignore

        img = np.array(image.convert("L"))
        # Adaptive threshold to emphasize borders/gutters
        th = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, 35, 10)
        # Invert so lines are white
        th_inv = 255 - th
        # Morph close to connect border lines
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        closed = cv2.morphologyEx(th_inv, cv2.MORPH_CLOSE, kernel, iterations=2)
        # Find external contours
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes: List[Tuple[int, int, int, int]] = []
        h_img, w_img = img.shape[:2]
        min_area = (w_img * h_img) * 0.02  # ignore tiny noise
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h
            if area < min_area:
                continue
            # Expand slightly to include borders
            pad = 4
            x = max(0, x - pad)
            y = max(0, y - pad)
            w = min(w_img - x, w + 2 * pad)
            h = min(h_img - y, h + 2 * pad)
            boxes.append((int(x), int(y), int(w), int(h)))
        if boxes:
            # Merge overlapping boxes (simple NMS-like)
            boxes = merge_overlapping_boxes(boxes, iou_threshold=0.2)
            boxes.sort(key=lambda b: (b[1], b[0]))
            return boxes
        return []
    except Exception as e:
        logger.info("OpenCV panel detection unavailable or failed (%s)", e)
        return []


def merge_overlapping_boxes(boxes: List[Tuple[int, int, int, int]], iou_threshold: float = 0.3) -> List[Tuple[int, int, int, int]]:
    def iou(a, b):
        ax1, ay1, aw, ah = a
        bx1, by1, bw, bh = b
        ax2, ay2 = ax1 + aw, ay1 + ah
        bx2, by2 = bx1 + bw, by1 + bh
        inter_x1, inter_y1 = max(ax1, bx1), max(ay1, by1)
        inter_x2, inter_y2 = min(ax2, bx2), min(ay2, by2)
        inter_w, inter_h = max(0, inter_x2 - inter_x1), max(0, inter_y2 - inter_y1)
        inter_area = inter_w * inter_h
        area_a, area_b = aw * ah, bw * bh
        union = area_a + area_b - inter_area
        return inter_area / union if union > 0 else 0.0

    kept: List[Tuple[int, int, int, int]] = []
    for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
        if all(iou(box, k) < iou_threshold for k in kept):
            kept.append(box)
    return kept

app = FastAPI(title="Context-Aware Manga Narrator App")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


# Story context state (simple in-memory for demo; consider persistence for production)
full_story_context: str = ""


def run_panel_detector(image: Image.Image) -> List[Tuple[int, int, int, int]]:
    """Return list of panel bounding boxes (x, y, w, h).

    Prefer LayoutParser; otherwise return a single full-page panel as fallback.
    """
    # Prefer LayoutParser path if requested and available
    if USE_LAYOUTPARSER and lp_available and lp_model is not None:
        try:
            # LayoutParser expects numpy arrays or PIL images
            layout = lp_model.detect(image)
            # Convert to boxes; use all blocks as candidate panels
            boxes: List[Tuple[int, int, int, int]] = []
            for b in layout:
                x_1, y_1, x_2, y_2 = b.block.x_1, b.block.y_1, b.block.x_2, b.block.y_2
                x, y = int(x_1), int(y_1)
                w, h = int(x_2 - x_1), int(y_2 - y_1)
                # Filter tiny boxes
                if w <= 10 or h <= 10:
                    continue
                boxes.append((x, y, w, h))
            if boxes:
                # Sort top-to-bottom, then left-to-right
                boxes.sort(key=lambda b: (b[1], b[0]))
                logger.info("LayoutParser detected %d regions; using as panels", len(boxes))
                return boxes
            logger.warning("LayoutParser returned 0 regions; falling back to full-page panel")
        except Exception as e:
            logger.warning("LayoutParser inference failed (%s); using full-page fallback", e)

    # Try YOLOv8 path
    if yolo_available:
        try:
            global yolo_model  # noqa: PLW0603
            if yolo_model is None:
                yolo_model = YOLO(YOLO_MODEL_PATH)
                logger.info("Loaded YOLOv8 model from %s", YOLO_MODEL_PATH)

            # Run prediction (ultralytics auto-handles PIL)
            results = yolo_model.predict(image, verbose=False, imgsz=960, conf=0.25, device="cpu")
            boxes: List[Tuple[int, int, int, int]] = []
            if results:
                r = results[0]
                if getattr(r, "boxes", None) is not None:
                    for b in r.boxes:
                        # xyxy
                        import numpy as np  # type: ignore

                        xyxy = b.xyxy.cpu().numpy().astype(int)[0]
                        x1, y1, x2, y2 = int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])
                        w, h = x2 - x1, y2 - y1
                        if w <= 10 or h <= 10:
                            continue
                        boxes.append((x1, y1, w, h))
            if boxes:
                boxes.sort(key=lambda b: (b[1], b[0]))
                logger.info("YOLO detected %d regions; using as panels", len(boxes))
                return boxes
            logger.warning("YOLO returned 0 regions; falling back to full-page panel")
        except Exception as e:
            logger.warning("YOLO inference failed (%s); using full-page fallback", e)

    # Try DeepPanel segmentation path
    if deeppanel_available:
        boxes_dp = detect_panels_deeppanel(image)
        if boxes_dp:
            logger.info("DeepPanel detected %d regions; using as panels", len(boxes_dp))
            return boxes_dp

    # Try OWL-ViT path (prompt-based)
    if owl_available:
        try:
            global owl_model, owl_processor  # noqa: PLW0603
            if owl_model is None or owl_processor is None:
                from transformers import Owlv2ForObjectDetection, Owlv2Processor  # type: ignore
                owl_model = Owlv2ForObjectDetection.from_pretrained("google/owlv2-base-patch16-ensemble")
                owl_processor = Owlv2Processor.from_pretrained("google/owlv2-base-patch16-ensemble")
                logger.info("Loaded OWL-ViT model")

            import torch  # type: ignore
            device = torch.device("cpu")
            owl_model.to(device)

            texts = [[p for p in OWLVIT_PROMPTS]]
            inputs = owl_processor(text=texts, images=image, return_tensors="pt").to(device)
            with torch.no_grad():
                outputs = owl_model(**inputs)
            results = owl_processor.post_process_object_detection(outputs=outputs, threshold=0.1, target_sizes=[image.size[::-1]])
            res = results[0]
            boxes: List[Tuple[int, int, int, int]] = []
            for box, score, label in zip(res["boxes"], res["scores"], res["labels"]):
                if float(score) < 0.3:
                    continue
                x1, y1, x2, y2 = [int(v) for v in box.tolist()]
                w, h = x2 - x1, y2 - y1
                if w <= 10 or h <= 10:
                    continue
                boxes.append((x1, y1, w, h))
            if boxes:
                boxes = merge_overlapping_boxes(boxes, iou_threshold=0.2)
                boxes.sort(key=lambda b: (b[1], b[0]))
                logger.info("OWL-ViT detected %d regions; using as panels", len(boxes))
                return boxes
            logger.warning("OWL-ViT returned 0 regions; continue to OpenCV")
        except Exception as e:
            logger.warning("OWL-ViT inference failed (%s); continue to OpenCV", e)

    # Try OpenCV heuristic detector
    boxes_cv = detect_panels_opencv(image)
    if boxes_cv:
        logger.info("OpenCV detected %d regions; using as panels", len(boxes_cv))
        return boxes_cv

    width, height = image.size
    logger.warning("Using single full-page panel fallback")
    return [(0, 0, width, height)]

# External panel detection API (optional)
PANEL_API_URL = os.environ.get("PANEL_API_URL", "").strip()
PANEL_API_MODE = os.environ.get("PANEL_API_MODE", "auto").lower()  # auto|json|zip|image

def call_external_panel_api(page_path: str) -> Dict[str, Any]:
    if not PANEL_API_URL:
        raise HTTPException(status_code=503, detail="PANEL_API_URL not configured")
    import requests  # lazy import
    with open(page_path, "rb") as f:
        files = {"file": (os.path.basename(page_path), f, "image/png")}
        resp = requests.post(PANEL_API_URL, files=files, timeout=120)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Panel API error {resp.status_code}: {resp.text[:200]}")
    content_type = resp.headers.get("content-type", "").lower()
    mode = PANEL_API_MODE
    if mode == "auto":
        if "application/json" in content_type:
            mode = "json"
        elif "zip" in content_type:
            mode = "zip"
        elif "image/" in content_type:
            mode = "image"
        else:
            mode = "json"
    return {"mode": mode, "content": resp.content, "headers": dict(resp.headers)}

def save_crops_from_external(page_path: str, api_result: Dict[str, Any]) -> Tuple[List[Tuple[int,int,int,int]], List[Dict[str,str]]]:
    import json
    from zipfile import ZipFile
    from io import BytesIO
    mode = api_result["mode"]
    content = api_result["content"]
    boxes: List[Tuple[int,int,int,int]] = []
    crops_meta: List[Dict[str,str]] = []
    if mode == "json":
        try:
            data = json.loads(content.decode("utf-8"))
        except Exception:
            data = {}
        panels = data.get("panels") or data.get("panel_boxes") or []
        with Image.open(page_path) as img:
            img = img.convert("RGB")
            tmp_boxes: List[Tuple[int,int,int,int]] = []
            for p in panels:
                if not isinstance(p, (list, tuple)) or len(p) != 4:
                    continue
                x1,y1,x2,y2 = map(int, p)
                tmp_boxes.append((x1, y1, x2 - x1, y2 - y1))
            if not tmp_boxes:
                width, height = img.size
                tmp_boxes = [(0,0,width,height)]
        boxes = tmp_boxes
        crops_meta = save_panel_crops(page_path, boxes)
        return boxes, crops_meta
    if mode == "zip":
        z = ZipFile(BytesIO(content))
        page_name = os.path.basename(page_path)
        page_stem, _ = os.path.splitext(page_name)
        dest_dir = os.path.join(UPLOAD_DIR, "panels", page_stem)
        import shutil
        if os.path.isdir(dest_dir):
            try:
                shutil.rmtree(dest_dir)
            except Exception:
                pass
        os.makedirs(dest_dir, exist_ok=True)
        z.extractall(dest_dir)
        for name in sorted(z.namelist()):
            rel_path = os.path.relpath(os.path.join(dest_dir, name), start=BASE_DIR).replace("\\", "/")
            url = f"/uploads/{rel_path.split('uploads/', 1)[1]}"
            crops_meta.append({"filename": os.path.basename(name), "url": url})
        return boxes, crops_meta
    if mode == "image":
        page_name = os.path.basename(page_path)
        page_stem, _ = os.path.splitext(page_name)
        dest_dir = os.path.join(UPLOAD_DIR, "panels", page_stem)
        os.makedirs(dest_dir, exist_ok=True)
        out_name = "panel_01.png"
        out_path = os.path.join(dest_dir, out_name)
        with open(out_path, "wb") as f:
            f.write(content)
        rel_path = os.path.relpath(out_path, start=BASE_DIR).replace("\\", "/")
        url = f"/uploads/{rel_path.split('uploads/', 1)[1]}"
        crops_meta.append({"filename": out_name, "url": url})
        return boxes, crops_meta
    return boxes, crops_meta

    # Minimal placeholder pre/post-processing.
    # NOTE: Replace with real preprocessing according to your model spec.
    try:
        resized = image.convert("RGB").resize((640, 640))
        import numpy as np  # type: ignore

        input_tensor = (np.asarray(resized).astype("float32") / 255.0)
        # NCHW: 1x3xHxW
        input_tensor = np.transpose(input_tensor, (2, 0, 1))[None, :]

        input_name = onnx_session.get_inputs()[0].name
        outputs = onnx_session.run(None, {input_name: input_tensor})

        # Placeholder: interpret outputs into boxes if possible; otherwise fallback
        # Here we just fallback because output schema is unknown in scaffold
        width, height = image.size
        logger.warning("ONNX output schema unknown; returning full-page fallback")
        return [(0, 0, width, height)]
    except Exception:
        logger.exception("ONNX inference failed; returning full-page fallback")
        width, height = image.size
        return [(0, 0, width, height)]


def crop_panels(image: Image.Image, boxes: List[Tuple[int, int, int, int]]) -> List[Image.Image]:
    panels: List[Image.Image] = []
    for (x, y, w, h) in boxes:
        x2, y2 = x + w, y + h
        panels.append(image.crop((x, y, x2, y2)))
    return panels


def save_panel_crops(page_path: str, boxes: List[Tuple[int, int, int, int]]) -> List[Dict[str, str]]:
    """Crop and save panel images under uploads/panels/<page_stem>/panel_XX.png
    Returns list of dicts with filename and url.
    """
    import shutil
    page_name = os.path.basename(page_path)
    page_stem, _ = os.path.splitext(page_name)
    dest_dir = os.path.join(UPLOAD_DIR, "panels", page_stem)
    # Clean dir for idempotency
    if os.path.isdir(dest_dir):
        try:
            shutil.rmtree(dest_dir)
        except Exception:
            logger.warning("Failed to clear existing panels dir %s", dest_dir)
    os.makedirs(dest_dir, exist_ok=True)

    with Image.open(page_path) as img_full:
        img_full = img_full.convert("RGB")
        crops_meta: List[Dict[str, str]] = []
        for idx, (x, y, w, h) in enumerate(boxes, start=1):
            x2, y2 = x + w, y + h
            crop = img_full.crop((x, y, x2, y2))
            out_name = f"panel_{idx:02d}.png"
            out_path = os.path.join(dest_dir, out_name)
            crop.save(out_path, format="PNG")
            rel_path = os.path.relpath(out_path, start=BASE_DIR).replace("\\", "/")
            url = f"/uploads/{rel_path.split('uploads/', 1)[1]}"
            crops_meta.append({"filename": out_name, "url": url})
    return crops_meta


def call_gemini(prompt: str, panel_images: List[Image.Image]) -> Dict[str, Any]:
    """Call Gemini with text+image prompt. Fallback to deterministic narration if unavailable."""
    if not gemini_available or genai is None:
        if REQUIRE_GEMINI:
            raise HTTPException(status_code=503, detail="Gemini not available and REQUIRE_GEMINI is set.")
        api_present = bool(os.environ.get("GOOGLE_API_KEY"))
        lib_present = genai is not None
        reason = (
            "GOOGLE_API_KEY missing" if not api_present else (
                "google-generativeai import failed" if not lib_present else "unknown"
            )
        )
        logger.warning("Using FAKE narration fallback because Gemini unavailable: %s", reason)
        # Fallback response structure
        return {
            "narration": f"[FAKE] {prompt[:120]}...",
            "panels": [
                {"panel_index": i + 1, "summary": "[FAKE] A panel description.", "characters": [], "dialogue": []}
                for i in range(len(panel_images))
            ],
            "source": "fallback",
        }

    try:
        # Convert PIL images to bytes for upload
        image_parts = []
        for pil in panel_images:
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            buf.seek(0)
            image_parts.append({"mime_type": "image/png", "data": buf.read()})

        model = genai.GenerativeModel("gemini-1.5-flash")
        # Ask for JSON-ish output
        system_prompt = (
            "You are a manga narrator. Output concise JSON with keys: narration (string), panels (array of objects with panel_index, "
            "summary, characters (array), dialogue (array of {speaker,text}))."
        )
        parts = [system_prompt, prompt]
        for ip in image_parts:
            parts.append({"mime_type": ip["mime_type"], "data": ip["data"]})
        response = model.generate_content(parts)

        text = response.text or "{}"
        import json  # lazy import

        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                parsed.setdefault("source", "gemini")
                return parsed
        except Exception:
            pass
        # If not valid JSON, wrap it
        return {"narration": text, "panels": [], "source": "gemini"}
    except Exception as e:
        logger.exception("Gemini call failed; returning error wrapper")
        return {"narration": f"[ERROR] {e}", "panels": [], "source": "gemini"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/upload")
async def upload_images(files: List[UploadFile] = File(...)):
    saved_files: List[str] = []
    for file in files:
        # Basic image guard
        if not file.filename.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        destination = os.path.join(UPLOAD_DIR, file.filename)
        contents = await file.read()
        with open(destination, "wb") as f:
            f.write(contents)
        saved_files.append(file.filename)
    saved_files.sort()
    return {"filenames": saved_files}


@app.post("/process-chapter")
async def process_chapter():
    global full_story_context
    # Reset per request; for persistent multi-chapter context, remove this reset.
    full_story_context = ""

    # Gather images from uploads dir, sorted
    filenames = [fn for fn in os.listdir(UPLOAD_DIR) if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    filenames.sort()

    chapter_results: List[Dict[str, Any]] = []

    for page_index, filename in enumerate(filenames, start=1):
        page_path = os.path.join(UPLOAD_DIR, filename)
        with Image.open(page_path) as img:
            img = img.convert("RGB")
            boxes = run_panel_detector(img)
            panels = crop_panels(img, boxes)

        prompt = (
            f"Given the story so far: '{full_story_context}'. "
            f"Continue the narration for page {page_index}. Provide JSON with narration and per-panel details."
        )

        gemini_output = call_gemini(prompt, panels)
        new_narration = str(gemini_output.get("narration", "")).strip()
        if new_narration:
            # Update rolling context
            full_story_context = (full_story_context + "\n" + new_narration).strip()

        chapter_results.append(
            {
                "page": page_index,
                "filename": filename,
                "narration": new_narration,
                "panels": gemini_output.get("panels", []),
                "source": gemini_output.get("source", "unknown"),
            }
        )

    return JSONResponse({
        "story_context": full_story_context,
        "pages": chapter_results,
        "used_fallback": any(p.get("source") == "fallback" for p in chapter_results),
    })


@app.post("/detect-panels")
async def detect_panels():
    """Detect panels via external API for all images in uploads/, save crops, and return metadata."""
    filenames = [fn for fn in os.listdir(UPLOAD_DIR) if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    filenames.sort()
    results: List[Dict[str, Any]] = []
    for filename in filenames:
        page_path = os.path.join(UPLOAD_DIR, filename)
        api_result = call_external_panel_api(page_path)
        with Image.open(page_path) as img:
            width, height = img.size
        boxes, crops = save_crops_from_external(page_path, api_result)
        results.append({
            "filename": filename,
            "size": {"width": width, "height": height},
            "boxes": [{"x": x, "y": y, "w": w, "h": h} for (x, y, w, h) in boxes],
            "crops": crops,
        })
        logger.info("Saved crops from external API for %s", filename)
        logger.info("results: %s", results)
    return JSONResponse({"pages": results})


@app.post("/process-page")
async def process_page(payload: Dict[str, Any]):
    """Process a single page by filename. Uses saved crops under uploads/panels/<stem>/.
    Updates rolling story context and returns narration and panel data.
    Payload: { filename: str, reset_context?: bool }
    """
    global full_story_context
    filename = str(payload.get("filename", "")).strip()
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")
    if payload.get("reset_context"):
        full_story_context = ""

    page_path = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(page_path):
        raise HTTPException(status_code=404, detail="page not found")

    # Load crops if present; else detect and save
    page_stem, _ = os.path.splitext(os.path.basename(filename))
    crops_dir = os.path.join(UPLOAD_DIR, "panels", page_stem)
    crop_files: List[str] = []
    if os.path.isdir(crops_dir):
        crop_files = [os.path.join(crops_dir, f) for f in os.listdir(crops_dir) if f.lower().endswith(".png")]
        crop_files.sort()
    if not crop_files:
        # Use external API to generate crops if not present
        api_result = call_external_panel_api(page_path)
        _boxes, _crops = save_crops_from_external(page_path, api_result)
        crop_files = [os.path.join(crops_dir, f) for f in os.listdir(crops_dir) if f.lower().endswith(".png")]
        crop_files.sort()

    # Open crops as PIL for Gemini
    panel_images: List[Image.Image] = []
    for p in crop_files:
        with Image.open(p) as im:
            panel_images.append(im.convert("RGB").copy())

    prompt = (
        f"Given the story so far: '{full_story_context}'. "
        f"Continue the narration for page '{filename}'. Provide JSON with narration and per-panel details."
    )
    gemini_output = call_gemini(prompt, panel_images)
    new_narration = str(gemini_output.get("narration", "")).strip()
    if new_narration:
        full_story_context = (full_story_context + "\n" + new_narration).strip()

    # Build crop URLs
    rel_dir = os.path.relpath(crops_dir, start=UPLOAD_DIR).replace("\\", "/")
    crop_urls = [f"/uploads/{rel_dir}/{os.path.basename(p)}" for p in crop_files]

    return JSONResponse({
        "filename": filename,
        "narration": new_narration,
        "panels": gemini_output.get("panels", []),
        "story_context": full_story_context,
        "crops": crop_urls,
        "source": gemini_output.get("source", "unknown"),
    })


if __name__ == "__main__":
    import uvicorn  # type: ignore

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)



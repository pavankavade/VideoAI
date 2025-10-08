import os
import json
import time
import uuid
import threading
from typing import Any, Dict, Deque, Optional
from collections import deque

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

# Reuse DB helpers from the editor module
from mangaeditor import EditorDB  # type: ignore


# ---- Paths and templates ----
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


router = APIRouter(prefix="/editor", tags=["video-editor"])


# ==================== Effect/Transition Config (server defaults) ====================
# These mirror the defaults used by the old video editor, but live independently here.
EFFECT_ANIMATION_SPEED: float = 1.0
EFFECT_SCREEN_MARGIN: float = 0.1
EFFECT_ZOOM_AMOUNT: float = 0.25
EFFECT_MAX_DURATION: float = 5.0
PANEL_BASE_SIZE: float = 0.5
EFFECT_SMOOTHING: float = 1.0

TRANSITION_DURATION: float = 0.8
TRANSITION_OVERLAP: float = 0.4
TRANSITION_SMOOTHING: float = 2.0


@router.get("/api/video/effect-config")
async def get_effect_config():
    return {
        "animationSpeed": EFFECT_ANIMATION_SPEED,
        "screenMargin": EFFECT_SCREEN_MARGIN,
        "zoomAmount": EFFECT_ZOOM_AMOUNT,
        "maxDuration": EFFECT_MAX_DURATION,
        "panelBaseSize": PANEL_BASE_SIZE,
        "smoothing": EFFECT_SMOOTHING,
        "transitionDuration": TRANSITION_DURATION,
        "transitionOverlap": TRANSITION_OVERLAP,
        "transitionSmoothing": TRANSITION_SMOOTHING,
    }


@router.post("/api/video/effect-config")
async def set_effect_config(payload: Dict[str, Any]):
    global EFFECT_ANIMATION_SPEED, EFFECT_SCREEN_MARGIN, EFFECT_ZOOM_AMOUNT
    global EFFECT_MAX_DURATION, PANEL_BASE_SIZE, EFFECT_SMOOTHING
    global TRANSITION_DURATION, TRANSITION_OVERLAP, TRANSITION_SMOOTHING

    def f(v: Any, default: float) -> float:
        try:
            return float(v)
        except Exception:
            return default

    EFFECT_ANIMATION_SPEED = f(payload.get("animationSpeed"), EFFECT_ANIMATION_SPEED)
    EFFECT_SCREEN_MARGIN = f(payload.get("screenMargin"), EFFECT_SCREEN_MARGIN)
    EFFECT_ZOOM_AMOUNT = f(payload.get("zoomAmount"), EFFECT_ZOOM_AMOUNT)
    EFFECT_MAX_DURATION = f(payload.get("maxDuration"), EFFECT_MAX_DURATION)
    PANEL_BASE_SIZE = f(payload.get("panelBaseSize"), PANEL_BASE_SIZE)
    EFFECT_SMOOTHING = f(payload.get("smoothing"), EFFECT_SMOOTHING)

    TRANSITION_DURATION = f(payload.get("transitionDuration"), TRANSITION_DURATION)
    TRANSITION_OVERLAP = f(payload.get("transitionOverlap"), TRANSITION_OVERLAP)
    TRANSITION_SMOOTHING = f(payload.get("transitionSmoothing"), TRANSITION_SMOOTHING)

    return await get_effect_config()


# ==================== Page: Video Editor (DB-backed) ====================
@router.post("/api/project/{project_id}/layers")
async def save_project_layers(project_id: str, payload: Dict[str, Any]):
    layers_data = payload.get("layers")
    if layers_data is None:
        raise HTTPException(status_code=400, detail="Missing 'layers' in payload")
    try:
        EditorDB.save_project_layers(project_id, layers_data)
        return JSONResponse({"status": "ok", "message": "Layers saved successfully."})
    except Exception as e:
        # Log the exception details for debugging
        print(f"Error saving layers for project {project_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save layers: {e}")


@router.get("/video-editor/{project_id}", response_class=HTMLResponse)
async def video_editor_page(request: Request, project_id: str):
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # The frontend expects the full project object, including pages and metadata
    return templates.TemplateResponse(
        "video_editor_db.html",
        {"request": request, "project": project},
    )


# ==================== Minimal Render + Progress (SSE) ====================
# Lightweight in-memory job event queue; enough to drive the UI progress bar.
ProgressEvent = Dict[str, Any]
_channels: Dict[str, Deque[ProgressEvent]] = {}
_channels_lock = threading.Lock()


def _publish(job_id: str, event: ProgressEvent) -> None:
    with _channels_lock:
        q = _channels.get(job_id)
        if q is None:
            q = deque(maxlen=500)
            _channels[job_id] = q
        q.append(event)


def _consume(job_id: str) -> Optional[ProgressEvent]:
    with _channels_lock:
        q = _channels.get(job_id)
        if not q:
            return None
        if q:
            return q.popleft()
        return None


def _render_video_job(job_id: str, project_id: str, payload: Dict[str, Any]) -> None:
    """The actual video rendering job, run in a background thread."""
    try:
        _publish(job_id, {"stage": "queued", "detail": "Preparing render..."})
        time.sleep(0.1) # Give client a moment to connect

        # 1. Fetch all required data from the database
        _publish(job_id, {"stage": "analyzing", "detail": "Fetching project data from DB..."})
        project = EditorDB.get_project(project_id)
        if not project:
            _publish(job_id, {"stage": "error", "detail": f"Project '{project_id}' not found."})
            return

        layers_data = project.get("metadata", {}).get("layers", [])
        if not layers_data:
            _publish(job_id, {"stage": "error", "detail": "Project has no layers to render."})
            return
        
        pages = project.get("pages", [])
        image_paths = [os.path.join(BASE_DIR, p["image_path"].lstrip('/')) for p in pages]
        
        _publish(job_id, {"stage": "analyzing", "detail": f"Found {len(layers_data)} layers and {len(image_paths)} images."})
        time.sleep(0.5)

        # 2. Simulate the rendering process (replace with actual moviepy/ffmpeg calls)
        # This section would involve complex logic using a library like MoviePy.
        # For now, we'll just simulate the steps.
        total_steps = len(layers_data) + len(image_paths) + 5 # Arbitrary number of extra steps
        current_step = 0

        _publish(job_id, {"stage": "rendering", "progress": 0, "detail": "Initializing render engine..."})
        
        # Simulate processing images
        for i, img_path in enumerate(image_paths):
            current_step += 1
            progress = int((current_step / total_steps) * 100)
            if not os.path.exists(img_path):
                 _publish(job_id, {"stage": "warning", "detail": f"Image not found: {os.path.basename(img_path)}"})
            else:
                _publish(job_id, {"stage": "rendering", "progress": progress, "detail": f"Processing image {i+1}/{len(image_paths)}..."})
            time.sleep(0.1)

        # Simulate processing layers
        for i, layer in enumerate(layers_data):
            current_step += 1
            progress = int((current_step / total_steps) * 100)
            layer_type = layer.get('type', 'unknown')
            _publish(job_id, {"stage": "rendering", "progress": progress, "detail": f"Applying layer {i+1}/{len(layers_data)} ({layer_type})..."})
            time.sleep(0.2)

        # Simulate final composition
        _publish(job_id, {"stage": "composing", "progress": 95, "detail": "Composing final video..."})
        time.sleep(1)

        # 3. Finalize and report completion
        # In a real scenario, you'd save the file and provide its actual URL
        output_filename = f"render_{project_id}_{int(time.time())}.mp4"
        project_render_dir = os.path.join(BASE_DIR, "manga_projects", project_id, "renders")
        os.makedirs(project_render_dir, exist_ok=True)
        final_output_path = os.path.join(project_render_dir, output_filename)
        
        # Simulate file creation
        with open(final_output_path, "w") as f:
            f.write("This is a simulated video file.")

        output_url = f"/manga_projects/{project_id}/renders/{output_filename}"
        _publish(job_id, {"stage": "complete", "detail": "Render complete!", "output_url": output_url})

    except Exception as e:
        import traceback
        print(f"Render job {job_id} failed: {e}")
        traceback.print_exc()
        _publish(job_id, {"stage": "error", "detail": f"An unexpected error occurred: {e}"})
    finally:
        # Leave a small tail so the client can read the final message
        time.sleep(0.5)


@router.post("/api/video/render")
async def render_video(payload: Dict[str, Any]):
    project_id = str(payload.get("project_id") or "").strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    if not EditorDB.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")

    job_id = uuid.uuid4().hex
    # Use the new detailed render job
    t = threading.Thread(target=_render_video_job, args=(job_id, project_id, payload), daemon=True)
    t.start()
    return {"job_id": job_id}


@router.get("/api/video/progress/stream/{job_id}")
async def stream_progress(job_id: str):
    async def event_gen():
        # If no channel exists yet, create one so clients don't disconnect immediately
        with _channels_lock:
            _channels.setdefault(job_id, deque(maxlen=500))
        # Basic polling loop
        while True:
            ev = _consume(job_id)
            if ev is None:
                # No new events; sleep briefly and continue
                await _async_sleep(0.25)
                continue
            # Serialize event
            yield f"data: {json.dumps(ev)}\n\n"
            if ev.get("stage") in {"complete", "error"}:
                break
    return StreamingResponse(event_gen(), media_type="text/event-stream")


async def _async_sleep(s: float) -> None:
    # Trivial asyncio-friendly sleep without importing asyncio explicitly in signature
    import asyncio
    await asyncio.sleep(s)

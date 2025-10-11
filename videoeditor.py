import os
import json
import time
import uuid
import threading
import asyncio
from typing import Any, Dict, Deque, Optional
from collections import deque

from fastapi import APIRouter, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.templating import Jinja2Templates

# Reuse DB helpers from the editor module
from mangaeditor import EditorDB  # type: ignore

# Windows asyncio fix
from async_utils import run_async_in_thread

# Headless browser recording (optional)
try:
    from headless_recorder import record_project_headless, PLAYWRIGHT_AVAILABLE
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


# ---- Paths and templates ----
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


router = APIRouter(prefix="/editor", tags=["video-editor"])


# ==================== Effect/Transition Config (server defaults) ====================
# These mirror the defaults used by the old video editor, but live independently here.
EFFECT_ANIMATION_SPEED: float = 0.2  # Default 0.2x speed (slower, more cinematic)
EFFECT_SCREEN_MARGIN: float = 0.1
EFFECT_ZOOM_AMOUNT: float = 0.25
EFFECT_MAX_DURATION: float = 5.0
PANEL_BASE_SIZE: float = 1.2  # Default 120% size (larger panels)
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
        print(f"[SSE] Published to {job_id}: {event.get('stage')} - {event.get('detail', '')[:50]}")



def _consume(job_id: str) -> Optional[ProgressEvent]:
    with _channels_lock:
        q = _channels.get(job_id)
        if not q:
            return None
        if q:
            return q.popleft()
        return None


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
            # Close stream on error OR on complete with download_url (final complete)
            if ev.get("stage") == "error":
                break
            if ev.get("stage") == "complete" and ev.get("download_url"):
                # This is the final complete event with download info
                break
    return StreamingResponse(event_gen(), media_type="text/event-stream")


async def _async_sleep(s: float) -> None:
    # Trivial asyncio-friendly sleep without importing asyncio explicitly in signature
    import asyncio
    await asyncio.sleep(s)


# ==================== Headless Browser Recording ====================
def _headless_render_job(job_id: str, project_id: str) -> None:
    """Background job for headless browser recording."""
    try:
        _publish(job_id, {"stage": "starting", "detail": "Launching headless browser...", "elapsed": 0, "remaining": None})
        
        # Progress callback to publish updates to the client
        def progress_callback(progress_data: Dict[str, Any]):
            # Add job_id and format time values
            event = {"job_id": job_id, **progress_data}
            
            # Format elapsed and remaining times in minutes
            if "elapsed" in event and event["elapsed"] is not None:
                elapsed_mins = event["elapsed"] / 60
                event["elapsed_formatted"] = f"{int(elapsed_mins)}:{int((elapsed_mins % 1) * 60):02d}"
            
            if "remaining" in event and event["remaining"] is not None:
                remaining_mins = event["remaining"] / 60
                event["remaining_formatted"] = f"{int(remaining_mins)}:{int((remaining_mins % 1) * 60):02d}"
            
            _publish(job_id, event)
        
        # Use the Windows-safe async runner with progress callback
        result = run_async_in_thread(record_project_headless(project_id, progress_callback=progress_callback))
        
        if result["status"] == "success":
            # Register the file for download
            _register_render_file(job_id, result.get("output_path"))
            
            _publish(job_id, {
                "stage": "complete",
                "detail": "Recording complete! Starting download...",
                "output_url": result["output_url"],
                "download_url": f"/editor/api/video/download/{job_id}",
                "file_size": result.get("file_size", 0),
                "duration": result.get("duration", 0),
                "output_path": result.get("output_path"),  # Store for cleanup
                "progress": 100
            })
        else:
            _publish(job_id, {
                "stage": "error",
                "detail": f"Recording failed: {result.get('error', 'Unknown error')}"
            })
            
    except Exception as e:
        import traceback
        print(f"Headless render job {job_id} failed: {e}")
        traceback.print_exc()
        _publish(job_id, {"stage": "error", "detail": f"Headless recording failed: {e}"})
    finally:
        time.sleep(0.5)


# Store completed render files for download
_render_files: Dict[str, str] = {}  # job_id -> file_path
_render_files_lock = threading.Lock()


def _register_render_file(job_id: str, file_path: str):
    """Register a completed render file for download."""
    with _render_files_lock:
        _render_files[job_id] = file_path


def _get_render_file(job_id: str) -> Optional[str]:
    """Get the file path for a completed render."""
    with _render_files_lock:
        return _render_files.get(job_id)


def _cleanup_render_file(job_id: str):
    """Remove render file from disk and registry."""
    with _render_files_lock:
        file_path = _render_files.pop(job_id, None)
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"[Cleanup] Deleted render file: {file_path}")
            except Exception as e:
                print(f"[Cleanup] Failed to delete {file_path}: {e}")


@router.post("/api/video/render/headless")
async def render_video_headless(payload: Dict[str, Any]):
    """
    Render video using headless browser (captures audio+video properly).
    """
    if not PLAYWRIGHT_AVAILABLE:
        raise HTTPException(
            status_code=501,
            detail="Headless recording not available. Install with: pip install playwright && playwright install chromium"
        )
    
    project_id = str(payload.get("project_id") or "").strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id is required")
    
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    job_id = uuid.uuid4().hex
    t = threading.Thread(target=_headless_render_job, args=(job_id, project_id), daemon=True)
    t.start()
    
    return {"job_id": job_id}


@router.get("/api/video/headless/available")
async def check_headless_available():
    """Check if headless recording is available."""
    return {
        "available": PLAYWRIGHT_AVAILABLE,
        "message": "Ready" if PLAYWRIGHT_AVAILABLE else "Install with: pip install playwright && playwright install chromium"
    }


@router.get("/api/video/download/{job_id}")
async def download_render(job_id: str, background_tasks: BackgroundTasks):
    """
    Download a completed render and schedule it for cleanup.
    File is automatically deleted after download.
    """
    file_path = _get_render_file(job_id)
    
    if not file_path:
        raise HTTPException(status_code=404, detail="Render file not found or already downloaded")
    
    if not os.path.exists(file_path):
        _cleanup_render_file(job_id)  # Clean up the registry entry
        raise HTTPException(status_code=404, detail="Render file not found on disk")
    
    # Get filename for download
    filename = os.path.basename(file_path)
    
    # Schedule cleanup after response is sent
    background_tasks.add_task(_cleanup_render_file, job_id)
    
    return FileResponse(
        path=file_path,
        media_type='video/webm',
        filename=filename,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


@router.get("/headless-test", response_class=HTMLResponse)
async def headless_test_page(request: Request):
    """Diagnostic page for testing headless rendering."""
    return templates.TemplateResponse("headless_test.html", {"request": request})

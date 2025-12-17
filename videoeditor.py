import os
import json
import re
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
            # Register the file for download (include originating project_id so
            # we can name the file using manga/series metadata)
            _register_render_file(job_id, result.get("output_path"), project_id)
            
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
# Map job_id -> {"file_path": <path>, "project_id": <project_id or None>}
_render_files: Dict[str, Dict[str, Optional[str]]] = {}  # job_id -> dict
_render_files_lock = threading.Lock()


def _register_render_file(job_id: str, file_path: str, project_id: Optional[str] = None):
    """Register a completed render file for download.

    Stores both the file path and the originating project id (if available)
    so the downloader can derive a friendly filename (manga name + chapter).
    """
    with _render_files_lock:
        _render_files[job_id] = {"file_path": file_path, "project_id": project_id}


def _get_render_file(job_id: str) -> Optional[Dict[str, Optional[str]]]:
    """Get the registered info for a completed render.

    Returns a dict with keys 'file_path' and 'project_id' or None if not found.
    """
    with _render_files_lock:
        return _render_files.get(job_id)


def _cleanup_render_file(job_id: str):
    """Remove render file from disk and registry."""
    with _render_files_lock:
        entry = _render_files.pop(job_id, None)
        file_path = entry.get("file_path") if entry else None
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
    entry = _get_render_file(job_id)

    if not entry:
        raise HTTPException(status_code=404, detail="Render file not found or already downloaded")

    file_path = entry.get("file_path")
    project_id = entry.get("project_id")

    if not file_path or not os.path.exists(file_path):
        _cleanup_render_file(job_id)  # Clean up the registry entry
        raise HTTPException(status_code=404, detail="Render file not found on disk")

    # Determine a friendly filename using manga series name + chapter number
    # Fallback to project title or original basename if needed
    filename = os.path.basename(file_path)
    try:
        # Try to read project info from DB if we have a project_id
        if project_id:
            conn = EditorDB.conn()
            row = conn.execute(
                "SELECT title, chapter_number, manga_series_id FROM project_details WHERE id=?",
                (project_id,),
            ).fetchone()
            series_name = None
            chapter_num = None
            proj_title = None
            if row:
                proj_title = row[0]
                chapter_num = row[1]
                series_id = row[2]
                if series_id:
                    srow = conn.execute("SELECT name FROM manga_series WHERE id=?", (series_id,)).fetchone()
                    if srow:
                        series_name = srow[0]

            # Build candidate base name
            base = None
            if series_name and chapter_num is not None:
                # Prefer series name + chapter
                # Use integer chapter if it looks like one
                try:
                    if float(chapter_num).is_integer():
                        chs = str(int(float(chapter_num)))
                    else:
                        chs = str(chapter_num)
                except Exception:
                    chs = str(chapter_num)
                base = f"{series_name}_ch{chs}"
            elif proj_title and chapter_num is not None:
                try:
                    if float(chapter_num).is_integer():
                        chs = str(int(float(chapter_num)))
                    else:
                        chs = str(chapter_num)
                except Exception:
                    chs = str(chapter_num)
                base = f"{proj_title}_ch{chs}"
            elif proj_title:
                base = proj_title

            if base:
                # sanitize base and append original extension
                name, ext = os.path.splitext(filename)
                # Replace spaces with underscores and remove problematic chars
                safe = re.sub(r"[^A-Za-z0-9._\-]", "_", base).strip("_")
                # Limit length to avoid filesystem issues
                safe = safe[:120]
                filename = f"{safe}{ext or '.webm'}"
    except Exception:
        # On any DB error, fall back to original filename
        pass
    
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


# ==================== Series Rendering ====================

# Store series render jobs: job_id -> { status, progress, current_chapter, total_chapters, etc }
_series_jobs: Dict[str, Dict[str, Any]] = {}
_series_jobs_lock = threading.Lock()

async def _series_render_worker(job_id: str, series_id: str, skip_error: bool, override_plan: bool):
    """Background worker for rendering a full series sequentially.
    
    NOTE: This must be a sync function (def, not async def) so FastAPI runs it in a threadpool.
    This allows us to use ensure_proactor logic safely for the subprocess-heavy Playwright code
    without messing up the main event loop.
    """
    def _run_worker_logic(): 
        # Defines the logic but run it synchronously via run_async_in_thread only for the async parts
        # actually, since we are in a thread, we can mostly just run synchronous code
        # BUT record_project_headless is async.
        # So we use run_async_in_thread to call record_project_headless.
        pass

    try:
        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "running"
        
        # Sync DB call is fine here
        projects = EditorDB.get_series_projects(series_id)
        total = len(projects)
        
        with _series_jobs_lock:
            _series_jobs[job_id]["total_chapters"] = total
            _series_jobs[job_id]["log"].append(f"Found {total} chapters for series {series_id}")

        for i, proj in enumerate(projects):
            chapter_num = proj["chapter_number"]
            pid = proj["id"]
            title = proj["title"]
            
            with _series_jobs_lock:
                _series_jobs[job_id]["current_index"] = i + 1
                _series_jobs[job_id]["current_chapter"] = f"Chapter {chapter_num}"
                _series_jobs[job_id]["log"].append(f"Starting render for Chapter {chapter_num} ({title})...")
            
            error_occurred = False
            try:
                # Callback logic
                def specific_progress(data: Dict[str, Any]):
                    pass 
                
                # Execute the async recording task in a dedicated thread-safe loop with Proactor policy
                # run_async_in_thread handles creating a fresh loop with correct policy on Windows
                try:
                    res = run_async_in_thread(
                        record_project_headless(
                            pid, 
                            progress_callback=specific_progress,
                            auto_generate_timeline=override_plan
                        )
                    )
                except RuntimeError as re:
                     # Fallback: if run_async_in_thread fails (e.g. nested loops issues), 
                     # we might be cleaner to just call it invalid.
                     # But it should work if _series_render_worker is run in a threadpool.
                     raise re

                if res["status"] != "success":
                    raise Exception(res.get("error", "Unknown error"))
                
                # Check outcome
                output_path = res.get("output_path")
                with _series_jobs_lock:
                    _series_jobs[job_id]["log"].append(f"Chapter {chapter_num} complete: {os.path.basename(str(output_path))}")
                    _series_jobs[job_id]["completed_chapters"].append(pid)
                    
            except Exception as e:
                error_occurred = True
                msg = f"Error rendering Chapter {chapter_num}: {e}"
                print(msg)
                with _series_jobs_lock:
                    _series_jobs[job_id]["log"].append(msg)
                    _series_jobs[job_id]["failed_chapters"].append(pid)
                
                if not skip_error:
                    raise e # Stop the series render

            # Sleep synchronously
            time.sleep(1)

        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "complete"
            _series_jobs[job_id]["log"].append("Series render finished.")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Series render job {job_id} failed: {e}")
        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "error"
            _series_jobs[job_id]["error"] = str(e)
            _series_jobs[job_id]["log"].append(f"Job failed: {e}")


def _series_render_worker_wrapper(job_id: str, series_id: str, skip_error: bool, override_plan: bool):
    """Wrapper to be compatible with BackgroundTasks which accepts sync functions for threadpool execution."""
    # We rename the async implementation above (conceptually) or simply replace it.
    # To avoid confusion, I will implement this as the actual function body replacement.
    pass

# Actual replacement function:
def _series_render_worker_sync(job_id: str, series_id: str, skip_error: bool, override_plan: bool):
    """Background worker for rendering a full series sequentially (Sync version)."""
    try:
        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "running"
        
        projects = EditorDB.get_series_projects(series_id)
        total = len(projects)
        
        with _series_jobs_lock:
            _series_jobs[job_id]["total_chapters"] = total
            _series_jobs[job_id]["log"].append(f"Found {total} chapters for series {series_id}")

        for i, proj in enumerate(projects):
            chapter_num = proj["chapter_number"]
            pid = proj["id"]
            title = proj["title"]
            
            with _series_jobs_lock:
                _series_jobs[job_id]["current_index"] = i + 1
                _series_jobs[job_id]["current_chapter"] = f"Chapter {chapter_num}"
                _series_jobs[job_id]["log"].append(f"Starting render for Chapter {chapter_num} ({title})...")
            
            error_occurred = False
            try:
                def specific_progress(data: Dict[str, Any]):
                    pass 
                
                # Critical: Use run_async_in_thread to ensure Proactor loop on Windows
                res = run_async_in_thread(
                    record_project_headless(
                        pid, 
                        progress_callback=specific_progress,
                        auto_generate_timeline=override_plan
                    )
                )
                
                if res["status"] != "success":
                    raise Exception(res.get("error", "Unknown error"))
                
                output_path = res.get("output_path")
                with _series_jobs_lock:
                    _series_jobs[job_id]["log"].append(f"Chapter {chapter_num} complete: {os.path.basename(str(output_path))}")
                    _series_jobs[job_id]["completed_chapters"].append(pid)
                    
            except Exception as e:
                error_occurred = True
                msg = f"Error rendering Chapter {chapter_num}: {e}"
                print(msg)
                with _series_jobs_lock:
                    _series_jobs[job_id]["log"].append(msg)
                    _series_jobs[job_id]["failed_chapters"].append(pid)
                
                if not skip_error:
                    raise e 

            time.sleep(1)

        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "complete"
            _series_jobs[job_id]["log"].append("Series render finished.")

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Series render job {job_id} failed: {e}")
        with _series_jobs_lock:
            _series_jobs[job_id]["status"] = "error"
            _series_jobs[job_id]["error"] = str(e)
            _series_jobs[job_id]["log"].append(f"Job failed: {e}")



@router.post("/api/series/{series_id}/render")
async def render_series_headless(series_id: str, request: Request, background_tasks: BackgroundTasks):
    """
    Start a background job to render all chapters in a series.
    Payload: { "skip_error": bool, "override_plan": bool }
    """
    try:
        payload = await request.json()
    except:
        payload = {}
        
    skip_error = payload.get("skip_error", False)
    override_plan = payload.get("override_plan", False)
    
    job_id = f"series_{series_id}_{uuid.uuid4().hex[:6]}"
    
    with _series_jobs_lock:
        _series_jobs[job_id] = {
            "series_id": series_id,
            "status": "pending",
            "log": [],
            "completed_chapters": [],
            "failed_chapters": [],
            "total_chapters": 0,
            "current_chapter": "",
            "current_index": 0,
            "created_at": time.time()
        }

    # Start the worker (using the sync version which FastAPI runs in a thread)
    background_tasks.add_task(_series_render_worker_sync, job_id, series_id, skip_error, override_plan)
    
    return {"job_id": job_id}


@router.get("/api/series/render/status/{job_id}")
async def get_series_render_status(job_id: str):
    """Get status of a series render job."""
    with _series_jobs_lock:
        job = _series_jobs.get(job_id)
        
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    return job

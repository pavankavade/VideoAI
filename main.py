import os
import io
import json
import logging
import re
from typing import List, Dict, Any, Optional, Tuple
import ast
from datetime import datetime
import asyncio
import time

from fastapi import FastAPI, File, UploadFile, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from PIL import Image
# from moviepy.editor import ImageClip, AudioFileClip, concatenate_videoclips, CompositeAudioClip, CompositeVideoClip

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
MANGA_DIR = os.path.join(BASE_DIR, "manga_projects")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(MANGA_DIR, exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "cv_model"), exist_ok=True)


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

app = FastAPI(title="Manga AI Dashboard")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/manga_projects", StaticFiles(directory=MANGA_DIR), name="manga_projects")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# -------------------- In-memory SSE progress channels --------------------
# Simple per-job pubsub so the UI can subscribe to step-by-step progress.
from typing import Deque
from collections import deque

ProgressEvent = Dict[str, Any]
_PROGRESS_CHANNELS: Dict[str, Dict[str, Any]] = {}

def _get_progress_channel(job_id: str) -> Dict[str, Any]:
    """Get or create a progress channel for a job_id.
    Structure: { 'queue': asyncio.Queue[str], 'last': dict, 'created': float }
    """
    ch = _PROGRESS_CHANNELS.get(job_id)
    if ch is None:
        ch = {"queue": asyncio.Queue(), "last": None, "created": time.time()}
        _PROGRESS_CHANNELS[job_id] = ch
    return ch

def _sse_format(payload: Dict[str, Any]) -> str:
    return f"event: progress\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

def push_progress(job_id: Optional[str], stage: str, status: str = "running", pct: Optional[float] = None, **extra: Any) -> None:
    if not job_id:
        return
    ch = _get_progress_channel(job_id)
    evt: Dict[str, Any] = {
        "job_id": job_id,
        "stage": stage,
        "status": status,
        "pct": float(pct) if pct is not None else None,
        "ts": time.time(),
    }
    if extra:
        evt.update(extra)
    msg = _sse_format(evt)
    # store last and enqueue without blocking
    ch["last"] = evt
    try:
        ch["queue"].put_nowait(msg)
    except Exception:
        pass

@app.get("/api/progress/stream/{job_id}")
async def stream_progress(job_id: str):
    """Server-Sent Events (SSE) stream of progress for a given job_id."""
    ch = _get_progress_channel(job_id)

    async def event_gen():
        # send last known immediately (if any)
        last = ch.get("last")
        if last:
            yield _sse_format(last)
        try:
            while True:
                msg = await ch["queue"].get()
                yield msg
        except asyncio.CancelledError:
            return

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # disable buffering on some proxies
    }
    return StreamingResponse(event_gen(), media_type="text/event-stream", headers=headers)


@app.get('/video-editor', response_class=HTMLResponse)
def video_editor(request: Request):
    """Render a simple video editor page for a project id query param (optional)."""
    project_id = request.query_params.get('project_id')
    project = None
    if project_id:
        project = get_manga_project(project_id)
    # If no project, pass an empty placeholder
    context = {"request": request, "project": project or {"id": "", "pages": [], "workflow": {}}}
    return templates.TemplateResponse('video_editor.html', context)


@app.post('/save_project')
async def save_project_endpoint(request: Request):
    """Save editor state (layers) into the project workflow and persist projects.json.
    Expects JSON: { project_id: str, layers: [...] }
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail='Invalid JSON')
    project_id = payload.get('project_id')
    layers = payload.get('layers')
    if not project_id:
        raise HTTPException(status_code=400, detail='project_id required')
    if layers is None:
        raise HTTPException(status_code=400, detail='layers required')
    # Load project and patch workflow.video_editing.data
    projects = get_manga_projects()
    for i, p in enumerate(projects):
        if p.get('id') == project_id:
            # store layers under workflow.video_editing.data for later retrieval
            if 'workflow' not in p:
                p['workflow'] = {}
            if 'video_editing' not in p['workflow']:
                p['workflow']['video_editing'] = {}
            p['workflow']['video_editing']['status'] = 'edited'
            p['workflow']['video_editing']['data'] = {'layers': layers, 'savedAt': datetime.utcnow().isoformat()}
            projects[i] = p
            save_manga_projects(projects)
            return JSONResponse({'ok': True, 'project_id': project_id})
    # If project not found, create a lightweight project entry
    new_proj = {
        'id': project_id,
        'title': project_id,
        'pages': [],
        'workflow': {
            'video_editing': {'status': 'edited', 'data': {'layers': layers, 'savedAt': datetime.utcnow().isoformat()}}
        },
        'createdAt': datetime.utcnow().isoformat()
    }
    projects.append(new_proj)
    save_manga_projects(projects)
    return JSONResponse({'ok': True, 'project_id': project_id, 'created': True})

# Manga project management
def _normalize_quotes_and_commas(text: str) -> str:
    """Best-effort cleanup to make loosely JSON-like text parseable.
    - Convert smart quotes to normal quotes
    - Remove trailing commas before ] or }
    - Replace single quotes with double quotes when likely JSON keys/strings
    """
    cleaned = text.strip()
    # Normalize smart quotes
    cleaned = cleaned.replace("“", '"').replace("”", '"').replace("’", "'")
    cleaned = cleaned.replace("‚", "'").replace("‛", "'")
    # Remove trailing commas like ,] or ,}
    cleaned = re.sub(r",\s*(\]|\})", r"\\1", cleaned)
    return cleaned

def parse_json_array_from_text(text: str) -> List[Any]:
    """Extract a JSON array from free-form model output robustly.
    Returns a Python list on success or raises ValueError.
    """
    if not isinstance(text, str):
        raise ValueError("Input text is not a string")
    cleaned = text.strip()
    # Strip common markdown code fences if still present
    fence_match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", cleaned)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    # Prefer the first top-level [...] span
    array_match = re.search(r"\[[\s\S]*\]", cleaned)
    candidate = array_match.group(0).strip() if array_match else cleaned
    attempts: List[str] = [candidate]
    attempts.append(_normalize_quotes_and_commas(candidate))
    # Try JSON first
    last_err: Optional[Exception] = None
    for attempt in attempts:
        try:
            parsed = json.loads(attempt)
            if isinstance(parsed, list):
                return parsed
        except Exception as e:
            last_err = e
            continue
    # Try Python literal eval for arrays that use single quotes or mixed quotes
    try:
        py_candidate = _normalize_quotes_and_commas(candidate)
        parsed_py = ast.literal_eval(py_candidate)
        if isinstance(parsed_py, list):
            return parsed_py
    except Exception as e2:
        last_err = e2
    raise ValueError(f"Unable to parse JSON array: {last_err}")

def normalize_panel_id(panel_id: str) -> str:
    """Normalize variations like 'panel1', 'panel_1', 'panel01', 'Panel 1' to 'panel1'."""
    s = str(panel_id).strip().lower()
    s = s.replace("panel_", "panel").replace("panel ", "panel")
    # Extract number
    m = re.search(r"panel\s*(\d+)", s)
    if m:
        return f"panel{int(m.group(1))}"
    # As a fallback, if it's just a number
    m2 = re.search(r"(\d+)$", s)
    if m2:
        return f"panel{int(m2.group(1))}"
    return s

def extract_page_number(filename: str) -> int:
    """Extract page number from filename like 'image (4).png' or 'image (5).jpg'
    Returns the number found in parentheses, or 0 if no number found.
    """
    # Look for pattern like "image (4)" or "image (5)"
    match = re.search(r'image\s*\((\d+)\)', filename, re.IGNORECASE)
    if match:
        return int(match.group(1))
    
    # Fallback: look for any number in the filename
    numbers = re.findall(r'\d+', filename)
    if numbers:
        return int(numbers[0])
    
    return 0

def sort_files_by_page_number(files: List[str]) -> List[Tuple[str, int]]:
    """Sort files by their extracted page numbers and return tuples of (filename, page_number)"""
    file_page_pairs = [(filename, extract_page_number(filename)) for filename in files]
    # Sort by page number, then by filename for files with same page number
    file_page_pairs.sort(key=lambda x: (x[1], x[0]))
    return file_page_pairs

def get_sorted_pages_info(files: List[str]) -> List[Dict[str, Any]]:
    """Get sorted pages information for debugging/display purposes"""
    sorted_pairs = sort_files_by_page_number(files)
    pages_info = []
    for i, (filename, original_page_num) in enumerate(sorted_pairs, start=1):
        pages_info.append({
            "sequential_page": i,
            "filename": filename,
            "original_page_num": original_page_num
        })
    return pages_info

def get_manga_projects() -> List[Dict[str, Any]]:
    """Load manga projects from storage"""
    projects_file = os.path.join(MANGA_DIR, "projects.json")
    if os.path.exists(projects_file):
        try:
            with open(projects_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Error loading manga projects: {e}")
    return []

def save_manga_projects(projects: List[Dict[str, Any]]) -> None:
    """Save manga projects to storage"""
    projects_file = os.path.join(MANGA_DIR, "projects.json")
    try:
        with open(projects_file, 'w', encoding='utf-8') as f:
            json.dump(projects, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error saving manga projects: {e}")

def create_manga_project(title: str, files: List[str]) -> Dict[str, Any]:
    """Create a new manga project"""
    project_id = str(int(datetime.now().timestamp() * 1000))
    project_dir = os.path.join(MANGA_DIR, project_id)
    os.makedirs(project_dir, exist_ok=True)
    
    # Sort files by page number and assign sequential page numbers
    sorted_file_pairs = sort_files_by_page_number(files)
    
    # Create pages list with sequential page numbers starting from 1
    pages = []
    for i, (filename, original_page_num) in enumerate(sorted_file_pairs, start=1):
        pages.append({
            "page_number": i,  # Sequential page number starting from 1
            "filename": filename,
            "original_page_num": original_page_num  # Keep original for reference
        })
        
        # Copy uploaded files to project directory
        src_path = os.path.join(UPLOAD_DIR, filename)
        dst_path = os.path.join(project_dir, filename)
        if os.path.exists(src_path):
            import shutil
            shutil.copy2(src_path, dst_path)
    
    project = {
        "id": project_id,
        "title": title,
        "status": "uploaded",
        "chapters": len(files),
        "createdAt": datetime.now().isoformat(),
        "files": files,  # Keep original files list for backward compatibility
        "pages": pages,  # New structured pages with sequential numbering
        "workflow": {
            "narrative": {"status": "pending", "data": None},
            "panels": {"status": "pending", "data": None},
            "text_matching": {"status": "pending", "data": None},
            "tts": {"status": "todo", "data": None},
            "panel_tts": {"status": "todo", "data": None},
            "video_editing": {"status": "todo", "data": None}
        }
    }
    
    # Save to projects list
    projects = get_manga_projects()
    projects.append(project)
    save_manga_projects(projects)
    
    return project

def get_manga_project(project_id: str) -> Optional[Dict[str, Any]]:
    """Get a specific manga project by ID"""
    projects = get_manga_projects()
    return next((p for p in projects if p["id"] == project_id), None)

def update_manga_project(project_id: str, updates: Dict[str, Any]) -> bool:
    """Update a manga project"""
    projects = get_manga_projects()
    for i, project in enumerate(projects):
        if project["id"] == project_id:
            # Handle nested updates (e.g., "workflow.narrative.status")
            for key, value in updates.items():
                if "." in key:
                    keys = key.split(".")
                    current = projects[i]
                    for k in keys[:-1]:
                        if k not in current:
                            current[k] = {}
                        current = current[k]
                    current[keys[-1]] = value
                else:
                    projects[i][key] = value
            save_manga_projects(projects)
            return True
    return False

def delete_manga_project(project_id: str) -> bool:
    """Delete a manga project and its files"""
    projects = get_manga_projects()
    project = next((p for p in projects if p["id"] == project_id), None)
    if project:
        # Delete project directory
        project_dir = os.path.join(MANGA_DIR, project_id)
        if os.path.exists(project_dir):
            import shutil
            shutil.rmtree(project_dir)
        
        # Remove from projects list
        projects = [p for p in projects if p["id"] != project_id]
        save_manga_projects(projects)
        return True
    return False


# Story context state (simple in-memory for demo; consider persistence for production)
full_story_context: str = ""


# Panel detection is now handled by external API only

# External panel detection API (optional)
PANEL_API_URL = os.environ.get("PANEL_API_URL", "").strip()
PANEL_API_MODE = os.environ.get("PANEL_API_MODE", "auto").lower()  # auto|json|zip|image

# External TTS API (optional)
TTS_API_URL = os.environ.get("TTS_API_URL", "").strip()

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
    
    # Get the project directory from the page path
    # page_path is like: /path/to/manga_projects/project_id/filename.png
    project_dir = os.path.dirname(page_path)
    page_name = os.path.basename(page_path)
    page_stem, _ = os.path.splitext(page_name)
    # Normalize to avoid trailing spaces/dots that break Windows paths
    norm_stem = page_stem.strip().rstrip('.')
    
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
        crops_meta = save_panel_crops_to_project(page_path, boxes, project_dir)
        return boxes, crops_meta
        
    if mode == "zip":
        z = ZipFile(BytesIO(content))
        dest_dir = os.path.join(project_dir, "panels", norm_stem)
        import shutil
        if os.path.isdir(dest_dir):
            try:
                shutil.rmtree(dest_dir)
            except Exception:
                pass
        os.makedirs(dest_dir, exist_ok=True)
        z.extractall(dest_dir)
        for name in sorted(z.namelist()):
            crops_meta.append({"filename": os.path.basename(name), "url": ""})  # URL will be set by caller
        return boxes, crops_meta
        
    if mode == "image":
        dest_dir = os.path.join(project_dir, "panels", norm_stem)
        os.makedirs(dest_dir, exist_ok=True)
        out_name = "panel_01.png"
        out_path = os.path.join(dest_dir, out_name)
        with open(out_path, "wb") as f:
            f.write(content)
        crops_meta.append({"filename": out_name, "url": ""})  # URL will be set by caller
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


@app.post('/api/video/render')
async def api_video_render(request: Request):
    """Accepts JSON payload: {project_id: str, timeline: [{type, src, duration, id}]} and returns an mp4 file.
    Timeline image clips must be accessible via HTTP (e.g., /manga_projects/... or /uploads/...). Audio clips should be similarly accessible.
    """
    data = await request.json()
    project_id = data.get('project_id') or ''
    job_id = data.get('job_id') or f"render-{int(datetime.utcnow().timestamp()*1000)}"
    timeline = data.get('timeline') or []
    # requested output resolution height (480, 720, 1080). default 720
    resolution = int(data.get('resolution') or 720)
    # If downloadMode == 'link' or return_url true, return a JSON with a URL to the rendered file (faster on UI)
    download_mode = (data.get('downloadMode') or data.get('mode') or '').strip().lower() if isinstance(data.get('downloadMode') or data.get('mode'), str) else (data.get('return_url') is True)
    return_link = (download_mode == 'link') or (data.get('return_url') is True)
    if not isinstance(timeline, list) or len(timeline) == 0:
        raise HTTPException(status_code=400, detail='Empty or invalid timeline')

    clips = []
    fg_clips = []  # foreground image clips (non-background)
    audio_clips = []  # list of (AudioFileClip, start_time)

    # Create temporary directory for intermediate files if needed
    import tempfile
    import shutil
    from pathlib import Path
    from starlette.responses import FileResponse
    from starlette.background import BackgroundTask

    # Create a temporary working directory that we'll clean up after the response completes
    tmpdir = tempfile.mkdtemp(prefix="video_render_")
    tmp = Path(tmpdir)
    out_path = tmp / 'out.mp4'

    try:
        push_progress(job_id, stage="parse_timeline", status="start")
        for item in timeline:
            ttype = item.get('type')
            src = item.get('src')
            dur = float(item.get('duration')) if item.get('duration') else None
            start_time = float(item.get('startTime') or item.get('start_time') or 0.0)
            is_bg = bool(item.get('_isBackground'))
            layer_index = int(item.get('_layerIndex')) if item.get('_layerIndex') is not None else None
            if ttype == 'image':
                # Expect src to be a local path or URL
                if not src:
                    continue
                if src.startswith('/'):
                    local_path = os.path.join(BASE_DIR, src.lstrip('/'))
                    if not os.path.exists(local_path):
                        local_path = os.path.join(BASE_DIR, src.replace('/', os.sep).lstrip(os.sep))
                else:
                    local_path = src

                if os.path.exists(local_path):
                    clip = ImageClip(local_path, duration=(dur or 2.0)).set_duration(dur or 2.0)
                else:
                    # download into tmp
                    import requests
                    r = requests.get(src, timeout=60)
                    imgfile = tmp / f"img_{len(clips)}.png"
                    imgfile.write_bytes(r.content)
                    clip = ImageClip(str(imgfile), duration=(dur or 2.0)).set_duration(dur or 2.0)

                # Annotate with timing and z info
                if is_bg:
                    # Background may span the whole video; set start
                    clip = clip.set_start(start_time)
                    # Attach transform/crop data
                    clip._layerIndex = layer_index if layer_index is not None else 0
                    clip._transform = item.get('transform') or None
                    clip._crop = item.get('crop') or None
                    clips.append(clip)
                else:
                    # Foreground clips: set start and collect for compositing
                    clip = clip.set_start(start_time)
                    # Store layer index for z-order: higher index should be on top
                    clip._layerIndex = layer_index if layer_index is not None else 999
                    clip._transform = item.get('transform') or None
                    clip._crop = item.get('crop') or None
                    fg_clips.append(clip)
            elif ttype == 'audio':
                srca = src
                if not srca:
                    continue
                # default to provided start_time if any
                astart = start_time
                if srca.startswith('/'):
                    local_a = os.path.join(BASE_DIR, srca.lstrip('/'))
                    if os.path.exists(local_a):
                        try:
                            ac = AudioFileClip(local_a)
                            audio_clips.append((ac, astart))
                        except Exception:
                            logger.exception('Failed to open local audio %s', local_a)
                    else:
                        try:
                            import requests
                            r = requests.get(srca, timeout=60)
                            # preserve original extension when possible
                            ext = os.path.splitext(srca)[1] or '.wav'
                            af = tmp / f"audio_{len(audio_clips)}{ext}"
                            af.write_bytes(r.content)
                            ac = AudioFileClip(str(af))
                            audio_clips.append((ac, astart))
                        except Exception:
                            logger.exception('Failed to fetch audio %s', srca)
                else:
                    try:
                        import requests
                        r = requests.get(srca, timeout=60)
                        ext = os.path.splitext(srca)[1] or '.wav'
                        af = tmp / f"audio_{len(audio_clips)}{ext}"
                        af.write_bytes(r.content)
                        ac = AudioFileClip(str(af))
                        audio_clips.append((ac, astart))
                    except Exception:
                        logger.exception('Failed to fetch audio %s', srca)
        push_progress(job_id, stage="parse_timeline", status="complete")

        if not clips and not fg_clips:
            # cleanup and return
            shutil.rmtree(tmpdir, ignore_errors=True)
            raise HTTPException(status_code=400, detail='No image clips in timeline')

    # Determine target size from requested resolution (16:9)
        target_h = 720
        if resolution in (480, 720, 1080):
            target_h = resolution
        else:
            target_h = 720
        target_w = int((16 / 9) * target_h)

        # Build a black base for the whole timeline duration
        push_progress(job_id, stage="build_base", status="start")
        total_end = 0.0
        for c in clips + fg_clips:
            total_end = max(total_end, float(getattr(c, 'start', 0) or 0) + float(c.duration or 0))
        from moviepy.editor import ColorClip
        base_video = ColorClip((target_w, target_h), color=(0,0,0), duration=(total_end or 2.0))
        push_progress(job_id, stage="build_base", status="complete")

        # Apply canvas-like transform (crop -> resize -> rotate -> position) to all image clips
        push_progress(job_id, stage="process_foreground", status="start")
        processed_all = []
        scale_x = target_w / 1920.0
        scale_y = target_h / 1080.0
        # Helper to process a single clip
        from moviepy.video.fx import all as vfx
        def process_image_clip(iclip: ImageClip) -> ImageClip:
            tr = getattr(iclip, '_transform', None)
            cr = getattr(iclip, '_crop', None)
            out = iclip
            # Crop first (coordinates in source image pixels)
            try:
                if isinstance(cr, dict):
                    cx = float(cr.get('x', 0)); cy = float(cr.get('y', 0))
                    cw = float(cr.get('w', 0)); ch = float(cr.get('h', 0))
                    if cw > 0 and ch > 0:
                        out = out.fx(vfx.crop, x1=max(0, int(cx)), y1=max(0, int(cy)), x2=max(1, int(cx+cw)), y2=max(1, int(cy+ch)))
            except Exception:
                logger.exception('Failed to apply crop; skipping')
            # Transform defaults (center full screen)
            tx = 1920/2.0; ty = 1080/2.0; tw = 1920.0; th = 1080.0; rot = 0.0
            if isinstance(tr, dict):
                tx = float(tr.get('x', tx)); ty = float(tr.get('y', ty));
                tw = float(tr.get('w', tw)); th = float(tr.get('h', th));
                rot = float(tr.get('rotation', 0.0) or 0.0)
            # Resize to target transform size (scaled to output resolution)
            dw = max(1, int(tw * scale_x)); dh = max(1, int(th * scale_y))
            try:
                out = out.resize(newsize=(dw, dh))
            except Exception:
                logger.exception('Failed to resize image clip; leaving original size')
            # Rotate around center (no expand to mimic canvas clipping)
            try:
                if abs(rot) > 1e-3:
                    out = out.rotate(rot, unit='deg', resample='bilinear')
            except Exception:
                logger.exception('Failed to rotate clip; skipping rotation')
            # Position: convert center (tx,ty) to top-left in output coordinates
            dx = int((tx - tw/2.0) * scale_x); dy = int((ty - th/2.0) * scale_y)
            out = out.set_position((dx, dy))
            # preserve timing and z
            out = out.set_start(getattr(iclip, 'start', 0))
            out = out.set_duration(iclip.duration)
            out._layerIndex = getattr(iclip, '_layerIndex', 999)
            return out

        for ic in clips + fg_clips:
            try:
                processed_all.append(process_image_clip(ic))
            except Exception:
                logger.exception('Failed to process image clip; using original placement')
                processed_all.append(ic)
        # Sort by z so later entries are on top
        processed_all.sort(key=lambda c: getattr(c, '_layerIndex', 999))
        push_progress(job_id, stage="process_foreground", status="complete")

        try:
            push_progress(job_id, stage="composite", status="start")
            video = CompositeVideoClip([base_video] + processed_all, size=(target_w, target_h))
            push_progress(job_id, stage="composite", status="complete")
        except Exception:
            logger.exception('Composite assembly failed; falling back to base only')
            video = base_video

        if audio_clips:
            try:
                push_progress(job_id, stage="attach_audio", status="start")
                # Place audio clips on their timeline positions and mix
                from moviepy.editor import CompositeAudioClip as MPCompositeAudioClip
                placed = []
                for ac, st in audio_clips:
                    try:
                        placed.append(ac.set_start(float(st or 0.0)))
                    except Exception:
                        logger.exception('Failed to set audio start; using 0')
                        placed.append(ac)
                if placed:
                    final_audio = MPCompositeAudioClip(placed)
                    video = video.set_audio(final_audio)
                push_progress(job_id, stage="attach_audio", status="complete")
            except Exception:
                logger.exception('Failed to attach audio to video')

        # Write file to out_path with console progress bar
        try:
            logger.info("[render] Starting video write: %s", str(out_path))
            # Use MoviePy's built-in progress bar (printed to console)
            push_progress(job_id, stage="encode", status="start")
            video.write_videofile(
                str(out_path),
                fps=24,
                codec='libx264',
                audio_codec='aac',
                threads=0,
                verbose=True,
                logger='bar'
            )
            push_progress(job_id, stage="encode", status="complete")
            logger.info("[render] Video write complete: %s", str(out_path))
        except Exception:
            logger.exception("[render] Video write failed")
            push_progress(job_id, stage="encode", status="error")
            raise

        # If caller requested a link instead of streaming the whole file back, move it to uploads/renders and return JSON
        if return_link:
            renders_dir = os.path.join(UPLOAD_DIR, 'renders')
            os.makedirs(renders_dir, exist_ok=True)
            ts = int(datetime.utcnow().timestamp())
            safe_pid = re.sub(r"[^A-Za-z0-9_-]", "_", str(project_id) or "project")
            dest_name = f"{safe_pid}-{ts}.mp4"
            dest_path = os.path.join(renders_dir, dest_name)
            try:
                shutil.move(str(out_path), dest_path)
            except Exception:
                logger.exception("[render] Move failed; attempting copy->remove fallback")
                try:
                    shutil.copyfile(str(out_path), dest_path)
                    try:
                        os.remove(str(out_path))
                    except Exception:
                        logger.warning("[render] Failed to remove temp out after copy")
                except Exception:
                    logger.exception("[render] Copy fallback failed; will return direct download response")
                    push_progress(job_id, stage="finalize", status="link_error")
                    return FileResponse(str(out_path), media_type='video/mp4', filename='project_video.mp4', background=BackgroundTask(shutil.rmtree, tmpdir))
            rel_url = f"/uploads/renders/{dest_name}"
            logger.info("[render] Returning link: %s", rel_url)
            push_progress(job_id, stage="finalize", status="complete", url=rel_url)
            return JSONResponse({"ok": True, "url": rel_url, "filename": dest_name, "job_id": job_id}, background=BackgroundTask(shutil.rmtree, tmpdir))

        # Default: stream file back to client and cleanup tmpdir in background after response is complete
        push_progress(job_id, stage="finalize", status="complete", url=None)
        return FileResponse(str(out_path), media_type='video/mp4', filename='project_video.mp4', background=BackgroundTask(shutil.rmtree, tmpdir))

    except HTTPException as e:
        # re-raise HTTPExceptions (like 400) after ensuring cleanup
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        finally:
            push_progress(job_id, stage="error", status="error", detail=str(e))
            raise
    except Exception as e:
        logger.exception('Video render failed')
        shutil.rmtree(tmpdir, ignore_errors=True)
        push_progress(job_id, stage="error", status="error", detail=str(e))
        raise HTTPException(status_code=500, detail=str(e))


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

def save_panel_crops_to_project(page_path: str, boxes: List[Tuple[int, int, int, int]], project_dir: str) -> List[Dict[str, str]]:
    """Crop and save panel images under project directory panels/<page_stem>/panel_XX.png
    Returns list of dicts with filename and url.
    """
    import shutil
    page_name = os.path.basename(page_path)
    page_stem, _ = os.path.splitext(page_name)
    norm_stem = page_stem.strip().rstrip('.')
    dest_dir = os.path.join(project_dir, "panels", norm_stem)
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
            crops_meta.append({"filename": out_name, "url": ""})  # URL will be set by caller
    return crops_meta


def run_panel_detector(image: Image.Image) -> List[Tuple[int, int, int, int]]:
    """Fallback panel detector used by legacy /process-chapter.
    Returns one full-page box so downstream code continues to work.
    """
    try:
        w, h = image.size
        return [(0, 0, int(w), int(h))]
    except Exception:
        logger.exception("run_panel_detector fallback failed; returning empty boxes")
        return []

def call_gemini(prompt: str, panel_images: List[Image.Image], system_instructions: Optional[str] = None) -> Dict[str, Any]:
    """Call Gemini with text+image prompt.
    - Accepts optional system_instructions for caller-specific guidance.
    - Returns a dict with 'text' (markdown code fences removed) and 'source'.
    Parsing of JSON schemas is handled by callers.
    """
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
        # Fallback text only; callers decide how to parse
        return {
            "text": f"[FAKE] {prompt[:500]}",
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

        model = genai.GenerativeModel("gemini-2.5-flash")
        # Build parts: optional system instructions then user prompt and images
        parts: List[Any] = []
        if system_instructions:
            parts.append(system_instructions)
        parts.append(prompt)
        for ip in image_parts:
            parts.append({"mime_type": ip["mime_type"], "data": ip["data"]})
        response = model.generate_content(parts)

        raw = response.text or ""
        cleaned = raw.strip()
        # Remove markdown code fences if present
        if "```json" in cleaned:
            json_match = re.search(r'```json\s*\n?([\s\S]*?)\n?```', cleaned)
            if json_match:
                cleaned = json_match.group(1).strip()
        elif "```" in cleaned:
            json_match = re.search(r'```\s*\n?([\s\S]*?)\n?```', cleaned)
            if json_match:
                cleaned = json_match.group(1).strip()
        return {"text": cleaned, "source": "gemini"}
    except Exception as e:
        logger.exception("Gemini call failed; returning error wrapper")
        return {"text": f"[ERROR] {e}", "source": "gemini"}


async def call_gemini_async(prompt: str, panel_images: List[Image.Image], system_instructions: Optional[str] = None) -> Dict[str, Any]:
    """Run blocking Gemini call in a background thread to avoid blocking the event loop."""
    return await asyncio.to_thread(call_gemini, prompt, panel_images, system_instructions)

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/manga/{project_id}", response_class=HTMLResponse)
async def manga_view(request: Request, project_id: str):
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    return templates.TemplateResponse("manga_view.html", {"request": request, "project": project})

@app.get("/api/manga")
async def get_manga_projects_api():
    """Get all manga projects"""
    return {"projects": get_manga_projects()}

@app.get("/api/manga/{project_id}")
async def get_manga_project_api(project_id: str):
    """Get a specific manga project"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    return {"project": project}

@app.get("/api/manga/{project_id}/pages")
async def get_manga_pages_info(project_id: str):
    """Get page sorting information for a manga project"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    if "pages" in project:
        # Return the structured pages data
        return {"pages": project["pages"]}
    else:
        # For old projects, generate the pages info
        pages_info = get_sorted_pages_info(project["files"])
        return {"pages": pages_info}

@app.post("/api/manga")
async def create_manga_project_api(request: Request):
    """Create a new manga project"""
    try:
        body = await request.json()
        title = body.get("title")
        files = body.get("files", [])
        json_data = body.get("json_data")  # Optional JSON data for narrative
        
        if not title:
            raise HTTPException(status_code=400, detail="Title is required")
        
        if not files and not json_data:
            raise HTTPException(status_code=400, detail="Either files or json_data is required")
        
        project = create_manga_project(title, files)
        
        # If JSON data is provided, update the project with narrative data
        if json_data:
            update_manga_project(project["id"], {
                "workflow.narrative.status": "complete",
                "workflow.narrative.data": {
                    "narration": json_data.get("narration", ""),
                    "page_narrations": json_data.get("page_narrations", []),
                    "page_info": []  # Will be populated when images are processed
                },
                "status": "narrative"
            })
        
        return {"project": project}
    except Exception as e:
        logger.error(f"Error creating manga project: {e}")
        raise HTTPException(status_code=400, detail="Invalid request data")

@app.put("/api/manga/{project_id}")
async def update_manga_project_api(project_id: str, updates: Dict[str, Any]):
    """Update a manga project"""
    if update_manga_project(project_id, updates):
        return {"success": True}
    else:
        raise HTTPException(status_code=404, detail="Manga project not found")

@app.delete("/api/manga/{project_id}")
async def delete_manga_project_api(project_id: str):
    """Delete a manga project"""
    if delete_manga_project(project_id):
        return {"success": True}
    else:
        raise HTTPException(status_code=404, detail="Manga project not found")

@app.post("/api/manga/{project_id}/narrative")
async def generate_narrative_api(project_id: str):
    """Generate narrative story for all images in the project"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    # Load all images from project directory in the correct page order
    project_dir = os.path.join(MANGA_DIR, project_id)
    panel_images = []
    page_info = []
    
    # Use the new pages structure if available, otherwise fall back to files
    if "pages" in project:
        for page_data in project["pages"]:
            filename = page_data["filename"]
            page_number = page_data["page_number"]
            image_path = os.path.join(project_dir, filename)
            if os.path.exists(image_path):
                with Image.open(image_path) as img:
                    panel_images.append(img.convert("RGB"))
                    page_info.append({
                        "page_number": page_number,
                        "filename": filename,
                        "original_page_num": page_data.get("original_page_num", 0)
                    })
    else:
        # Fallback for old projects without pages structure
        for filename in project["files"]:
            image_path = os.path.join(project_dir, filename)
            if os.path.exists(image_path):
                with Image.open(image_path) as img:
                    panel_images.append(img.convert("RGB"))
                    page_info.append({
                        "page_number": len(page_info) + 1,
                        "filename": filename,
                        "original_page_num": extract_page_number(filename)
                    })
    
    if not panel_images:
        raise HTTPException(status_code=400, detail="No images found in project")
    
    # Generate narrative using Gemini
    prompt = (
        "You are a manga narrator. Analyze these manga chapter images in order and provide a detailed narrative story. "
        "The images are already sorted by page number (1, 2, 3, etc.). "
        "For each page, write a descriptive paragraph with 3-4 sentences that captures the key events, emotions, and story progression. "
        "Be vivid and engaging in your descriptions, focusing on character actions, dialogue, emotions, and visual details. "
        "Each page should have its own distinct narrative segment that flows naturally into the next. "
        "Do not mention the pages or chapters in the narration like `this chapter or page starts with` or ` This image is contrasted with a panel ` it should not feel like you are reading from pages"
        "IMPORTANT: Return ONLY a JSON array in this exact format: [[\"Page1\", \"narration text\"], [\"Page2\", \"narration text\"], ...] "
        "Do NOT include any markdown code blocks do NOT include any other text. "
        "Just return the raw JSON [\"Page1\", \"narration text\"], [\"Page2\", \"narration text\"], ...]"
        "Example: [[\"Page1\", \"The story begins with our protagonist...\"], [\"Page2\", \"As the scene continues...\"]]"
    )
    
    system_prompt = (
        "You are a manga narrator. For narrative generation, return ONLY a JSON array in this format: "
        "{[[\"Page1\", \"narration text\"], [\"Page2\", \"narration text\"], ...] }"
        "Do NOT include markdown code blocks or any other text. Just return the raw JSON array."
    )
    gemini_output = await call_gemini_async(prompt, panel_images, system_instructions=system_prompt)
    raw_narration = gemini_output.get("text", "")
    
    # Parse the response to extract structured data
    page_narrations = []
    full_narration = ""
    
    # Cleaned by call_gemini already
    cleaned_response = raw_narration.strip()
    
    # Try to extract JSON array from the response
    try:
        page_narrations = parse_json_array_from_text(cleaned_response)
        # Validate the format - should be list of [page_label, narration] pairs
        if isinstance(page_narrations, list) and all(isinstance(item, list) and len(item) == 2 for item in page_narrations):
            # Create full narration by combining all page narrations
            full_narration = "\n\n".join([f"**{item[0]}:** {item[1]}" for item in page_narrations])
            logger.info(f"Successfully parsed {len(page_narrations)} page narrations")
        else:
            # Invalid format, fallback to old format
            logger.warning("Invalid page narration format, falling back to raw text")
            page_narrations = []
            full_narration = raw_narration
    except Exception as e:
        logger.warning(f"Failed to parse JSON from narration response: {e}")
        # Fallback to old format
        page_narrations = []
        full_narration = raw_narration
    
    # Update project status
    update_manga_project(project_id, {
        "workflow.narrative.status": "complete",
        "workflow.narrative.data": {
            "narration": full_narration,
            "page_narrations": page_narrations,
            "page_info": page_info
        },
        "status": "narrative"
    })
    
    return {
        "narration": full_narration,
        "page_narrations": page_narrations,
        "page_info": page_info,
        "source": gemini_output.get("source", "unknown")
    }

@app.post("/api/manga/{project_id}/panels")
async def detect_panels_api(project_id: str, redo: bool = False):
    """Detect panels for all images in the project using external API"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    project_dir = os.path.join(MANGA_DIR, project_id)
    
    # Check if panels already exist and redo is not requested
    existing_panels_data = project.get("workflow", {}).get("panels", {}).get("data")
    if existing_panels_data and not redo:
        # Return existing panels data
        return {"pages": existing_panels_data, "from_cache": True}
    
    # If redo is requested, clean up existing panel files
    if redo and existing_panels_data:
        logger.info(f"Redoing panel detection for project {project_id}")
        for page_data in existing_panels_data:
            filename = page_data["filename"]
            page_stem, _ = os.path.splitext(filename)
            norm_stem = page_stem.strip().rstrip('.')
            panels_dir = os.path.join(project_dir, "panels", norm_stem)
            if os.path.exists(panels_dir):
                import shutil
                try:
                    shutil.rmtree(panels_dir)
                    logger.info(f"Removed existing panels directory: {panels_dir}")
                except Exception as e:
                    logger.warning(f"Failed to remove panels directory {panels_dir}: {e}")
    
    pages_results = []
    
    # Use the new pages structure if available, otherwise fall back to files
    if "pages" in project:
        files_to_process = [(page_data["filename"], page_data["page_number"]) for page_data in project["pages"]]
    else:
        # Fallback for old projects without pages structure
        files_to_process = [(filename, i + 1) for i, filename in enumerate(project["files"])]
    
    for filename, page_number in files_to_process:
        image_path = os.path.join(project_dir, filename)
        if not os.path.exists(image_path):
            continue
            
        try:
            # Use external panel detection API
            api_result = call_external_panel_api(image_path)
            boxes, crops_meta = save_crops_from_external(image_path, api_result)
            
            # Build panel URLs relative to the project directory
            page_stem, _ = os.path.splitext(filename)
            norm_stem = page_stem.strip().rstrip('.')
            panels_dir = os.path.join(project_dir, "panels", norm_stem)
            
            # Update URLs to be relative to the project structure
            updated_crops = []
            for crop in crops_meta:
                # Convert the URL to be relative to the manga_projects mount
                rel_path = os.path.relpath(panels_dir, start=MANGA_DIR).replace("\\", "/")
                url = f"/manga_projects/{rel_path}/{crop['filename']}"
                updated_crops.append({
                    "filename": crop["filename"],
                    "url": url
                })
            
            pages_results.append({
                "page_number": page_number,
                "filename": filename,
                "panels": updated_crops,
                "boxes": [{"x": x, "y": y, "w": w, "h": h} for (x, y, w, h) in boxes]
            })
            
        except Exception as e:
            logger.error(f"Failed to detect panels for {filename}: {e}")
            # Add empty result for failed pages
            pages_results.append({
                "page_number": page_number,
                "filename": filename,
                "panels": [],
                "boxes": [],
                "error": str(e)
            })
    
    # Update project status
    update_manga_project(project_id, {
        "workflow.panels.status": "complete",
        "workflow.panels.data": pages_results,
        "status": "panels"
    })
    
    return {"pages": pages_results, "from_cache": False}

@app.post("/api/manga/{project_id}/panels/redo")
async def redo_panel_detection_api(project_id: str):
    """Redo panel detection for a project"""
    return await detect_panels_api(project_id, redo=True)

@app.post("/api/manga/{project_id}/panels/page/{page_number}/redo")
async def redo_panel_detection_for_page_api(project_id: str, page_number: int):
    """Redo panel detection for a single page within a project"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")

    project_dir = os.path.join(MANGA_DIR, project_id)

    # Determine filename for the given page_number using structured pages if available
    filename: Optional[str] = None
    if "pages" in project:
        for page in project["pages"]:
            if int(page.get("page_number", 0)) == int(page_number):
                filename = page.get("filename")
                break
    else:
        # Fallback to positional mapping (1-indexed)
        idx = max(0, int(page_number) - 1)
        if 0 <= idx < len(project.get("files", [])):
            filename = project["files"][idx]

    if not filename:
        raise HTTPException(status_code=404, detail=f"Page {page_number} not found in project")

    image_path = os.path.join(project_dir, filename)
    if not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail=f"Image file not found for page {page_number}")

    # Remove existing panels for this page (if any)
    page_stem, _ = os.path.splitext(filename)
    norm_stem = page_stem.strip().rstrip('.')
    panels_dir = os.path.join(project_dir, "panels", norm_stem)
    if os.path.isdir(panels_dir):
        import shutil
        try:
            shutil.rmtree(panels_dir)
        except Exception as e:
            logger.warning(f"Failed to clear panels dir for page {page_number}: {e}")

    # Re-run detection for this single page
    try:
        api_result = call_external_panel_api(image_path)
        boxes, crops_meta = save_crops_from_external(image_path, api_result)

        # Build panel URLs relative to the project structure
        updated_crops = []
        for crop in crops_meta:
            rel_path = os.path.relpath(os.path.join(project_dir, "panels", norm_stem), start=MANGA_DIR).replace("\\", "/")
            url = f"/manga_projects/{rel_path}/{crop['filename']}"
            updated_crops.append({
                "filename": crop["filename"],
                "url": url
            })

        page_result = {
            "page_number": int(page_number),
            "filename": filename,
            "panels": updated_crops,
            "boxes": [{"x": x, "y": y, "w": w, "h": h} for (x, y, w, h) in boxes]
        }

    except Exception as e:
        logger.error(f"Failed to detect panels for page {page_number}: {e}")
        page_result = {
            "page_number": int(page_number),
            "filename": filename,
            "panels": [],
            "boxes": [],
            "error": str(e)
        }

    # Update project workflow.panels.data by replacing this page's entry or inserting
    panels_data = project.get("workflow", {}).get("panels", {}).get("data") or []
    replaced = False
    for i, p in enumerate(panels_data):
        if int(p.get("page_number", 0)) == int(page_number):
            panels_data[i] = page_result
            replaced = True
            break
    if not replaced:
        panels_data.append(page_result)

    # Persist updates
    update_manga_project(project_id, {
        "workflow.panels.status": "complete",
        "workflow.panels.data": panels_data,
        "status": "panels"
    })

    return {"page": page_result}

@app.post("/api/manga/{project_id}/text-matching")
async def match_text_to_panels_api(project_id: str, concurrency: int = 5):
    """Match narrative text to panels for each page"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    # Get narrative data
    narrative_data = project.get("workflow", {}).get("narrative", {}).get("data")
    if not narrative_data:
        raise HTTPException(status_code=400, detail="Narrative not generated yet")
    
    # Get panels data
    panels_data = project.get("workflow", {}).get("panels", {}).get("data")
    if not panels_data:
        raise HTTPException(status_code=400, detail="Panels not detected yet")
    
    # Get page narrations
    page_narrations = narrative_data.get("page_narrations", [])
    if not page_narrations:
        raise HTTPException(status_code=400, detail="Page narrations not available. Please regenerate narrative first.")
    
    project_dir = os.path.join(MANGA_DIR, project_id)
    pages_results: List[Dict[str, Any]] = []
    total_pages = len(panels_data)
    # Mark as processing and initialize progress
    update_manga_project(project_id, {
        "workflow.text_matching.status": "processing",
        "workflow.text_matching.progress": {"current": 0, "total": total_pages},
        "workflow.text_matching.data": pages_results,
        "status": "text_matching"
    })

    # Concurrency control and parallel processing
    concurrency = max(1, min(32, int(concurrency)))
    sem = asyncio.Semaphore(concurrency)

    async def process_one(page_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        async with sem:
            filename = page_data["filename"]
            page_number = page_data.get("page_number", 1)
            panels = page_data["panels"]

            # Find narration
            page_narration = ""
            for page_label, narration in page_narrations:
                if page_label == f"Page{page_number}":
                    page_narration = narration
                    logger.info(f"Narration found for page {page_number}: {narration}")

                    break
            if not page_narration:
                logger.warning(f"No narration found for page {page_number}")
                return None

            # Load panel images
            page_stem, _ = os.path.splitext(filename)
            norm_stem = page_stem.strip().rstrip('.')
            panels_dir = os.path.join(project_dir, "panels", norm_stem)
            panel_images: List[Image.Image] = []
            for panel in panels:
                panel_path = os.path.join(panels_dir, panel["filename"])
                if os.path.exists(panel_path):
                    with Image.open(panel_path) as img:
                        panel_images.append(img.convert("RGB"))
            if not panel_images:
                logger.warning(f"Text-matching: no panel images for page {page_number}; returning empty panels with narration")
                return {
                    "page_number": page_number,
                    "filename": filename,
                    "page_narration": page_narration,
                    "panels": []
                }

            # Build prompts and call model
            prompt = (
                f"Given this page narration: '{page_narration}'\n\n"
                f"Match appropriate parts of this narration to each of these {len(panel_images)} panels from page {page_number}. "
                f"Do not Change the original narration, just match the sentences to the panels.  "
                f"if some sentences are not matched to any panel, just leave them as is in most close panel"
                f"if no sentences match to any panel just randomly assign sentences to panels, do NOT drop any sentences. "
                f"do not assign single sentences to multiple panels, each sentence can only be assigned to one panel. "
                f"We have to make sure original narration is completely available after matching all panels, nothing from original narration should be lost"
                f"Return ONLY a JSON array in this format: [['panel1', 'sentence for panel 1'], ['panel2', 'sentence for panel 2'], ...] "
                f"Do NOT include markdown code blocks or any other text. Just return the raw JSON array."
            )
            system_prompt = (
                "You are matching narration sentences to panels. Return ONLY a JSON array in this format: "
                "[['panel1', 'sentence for panel 1'], ['panel2', 'sentence for panel 2'], ...]. "
                "Do NOT include markdown code blocks or any other text."
            )
            logger.info(f"Text-matching: invoking model for page {page_number} with {len(panel_images)} panels")
            gemini_output = await call_gemini_async(prompt, panel_images, system_instructions=system_prompt)
            raw_response = gemini_output.get("text", "")
            logger.info(f"Text-matching raw response for page {page_number} (first 800 chars): {raw_response[:800]}")

            # Parse
            panel_text_pairs: List[List[Any]] = []
            try:
                cleaned_response = raw_response.strip()
                parsed_pairs = parse_json_array_from_text(cleaned_response)
                if isinstance(parsed_pairs, list):
                    for item in parsed_pairs:
                        if isinstance(item, list) and len(item) == 2:
                            panel_text_pairs.append([str(item[0]), str(item[1])])
                if not panel_text_pairs:
                    raise ValueError("Parsed structure not a list of [panel, text] pairs")
            except Exception as e:
                logger.warning(f"Failed to parse panel text pairs for page {page_number}: {e}")
                panel_text_pairs = []
            else:
                logger.info(f"Text-matching parsed pairs for page {page_number}: {panel_text_pairs}")

            # Match
            panel_results: List[Dict[str, Any]] = []
            matched_count = 0
            for i, panel in enumerate(panels):
                panel_id = f"panel{i + 1}"
                matched_text = ""
                for pair in panel_text_pairs:
                    if len(pair) != 2:
                        continue
                    if normalize_panel_id(pair[0]) == normalize_panel_id(panel_id):
                        matched_text = pair[1]
                        break
                if matched_text:
                    matched_count += 1
                panel_results.append({
                    "filename": panel["filename"],
                    "url": panel["url"],
                    "matched_text": matched_text
                })
            logger.info(f"Text-matching results for page {page_number}: matched {matched_count}/{len(panels)} panels")

            return {
                "page_number": page_number,
                "filename": filename,
                "page_narration": page_narration,
                "panels": panel_results
            }

    # Launch tasks
    tasks = [asyncio.create_task(process_one(pd)) for pd in panels_data]
    completed = 0
    for coro in asyncio.as_completed(tasks):
        result = await coro
        if result is not None:
            pages_results.append(result)
        completed += 1
        update_manga_project(project_id, {
            "workflow.text_matching.status": "processing",
            "workflow.text_matching.progress": {"current": completed, "total": total_pages},
            "workflow.text_matching.data": pages_results,
            "status": "text_matching"
        })
    
    # Update project status
    update_manga_project(project_id, {
        "workflow.text_matching.status": "complete",
        "workflow.text_matching.progress": {"current": total_pages, "total": total_pages},
        "workflow.text_matching.data": pages_results,
        "status": "text_matching"
    })
    
    # Sort results by page_number to keep UI stable
    pages_results.sort(key=lambda p: int(p.get("page_number", 0)))
    return {"pages": pages_results}


@app.post("/api/manga/{project_id}/text-matching/page/{page_number}/redo")
async def redo_text_matching_for_page_api(project_id: str, page_number: int):
    """Redo text-panel matching for a single page within a project"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")

    # Narrative data required
    narrative_data = project.get("workflow", {}).get("narrative", {}).get("data")
    if not narrative_data:
        raise HTTPException(status_code=400, detail="Narrative not generated yet")

    panels_data = project.get("workflow", {}).get("panels", {}).get("data") or []
    if not panels_data:
        raise HTTPException(status_code=400, detail="Panels not detected yet")

    # Locate target page in panels_data
    page_entry: Optional[Dict[str, Any]] = None
    for p in panels_data:
        if int(p.get("page_number", 0)) == int(page_number):
            page_entry = p
            break
    if not page_entry:
        raise HTTPException(status_code=404, detail=f"Page {page_number} not found in project panels")

    page_narrations = narrative_data.get("page_narrations", [])
    page_narration = ""
    for page_label, narration in page_narrations:
        if page_label == f"Page{int(page_number)}":
            page_narration = narration
            break
    if not page_narration:
        raise HTTPException(status_code=400, detail=f"No narration found for page {page_number}")

    project_dir = os.path.join(MANGA_DIR, project_id)
    filename = page_entry.get("filename") or ""
    panels = page_entry.get("panels", [])

    # Load panel images
    page_stem, _ = os.path.splitext(filename)
    norm_stem = page_stem.strip().rstrip('.')
    panels_dir = os.path.join(project_dir, "panels", norm_stem)
    panel_images: List[Image.Image] = []
    for panel in panels:
        panel_path = os.path.join(panels_dir, panel["filename"])
        if os.path.exists(panel_path):
            with Image.open(panel_path) as img:
                panel_images.append(img.convert("RGB"))
    if not panel_images:
        raise HTTPException(status_code=400, detail=f"No panel images found for page {page_number}")

    # Build prompt and call model
    prompt = (
        f"Given this page narration: '{page_narration}'\n\n"
        f"Match appropriate parts of this narration to each of these {len(panel_images)} panels from page {page_number}. "
        f"Do not Change the original narration, just match the sentences to the panels. "
        f"Return ONLY a JSON array in this format: [['panel1', 'sentence for panel 1'], ['panel2', 'sentence for panel 2'], ...] "
        f"Do NOT include markdown code blocks or any other text. Just return the raw JSON array."
    )
    system_prompt = (
        "You are matching narration sentences to panels. Return ONLY a JSON array in this format: "
        "[['panel1', 'sentence for panel 1'], ['panel2', 'sentence for panel 2'], ...]. "
        "Do NOT include markdown code blocks or any other text."
    )
    logger.info(f"Redo text-matching: invoking model for page {page_number} with {len(panel_images)} panels")
    gemini_output = await call_gemini_async(prompt, panel_images, system_instructions=system_prompt)
    raw_response = gemini_output.get("text", "")
    logger.info(f"Redo text-matching raw response for page {page_number} (first 800 chars): {raw_response[:800]}")

    # Parse model output
    panel_text_pairs: List[List[Any]] = []
    try:
        cleaned_response = raw_response.strip()
        parsed_pairs = parse_json_array_from_text(cleaned_response)
        if isinstance(parsed_pairs, list):
            for item in parsed_pairs:
                if isinstance(item, list) and len(item) == 2:
                    panel_text_pairs.append([str(item[0]), str(item[1])])
    except Exception as e:
        logger.warning(f"Redo parse failed for page {page_number}: {e}")
        # Fallback: attempt manual JSON extraction with normalization
        try:
            cleaned = _normalize_quotes_and_commas(cleaned_response)
            json_match = re.search(r'\[[\s\S]*\]', cleaned)
            json_str = json_match.group(0) if json_match else cleaned
            parsed_pairs = json.loads(json_str)
            if isinstance(parsed_pairs, list):
                for item in parsed_pairs:
                    if isinstance(item, list) and len(item) == 2:
                        panel_text_pairs.append([str(item[0]), str(item[1])])
        except Exception as e2:
            logger.warning(f"Redo secondary parse failed for page {page_number}: {e2}")
            panel_text_pairs = []
    else:
        logger.info(f"Redo text-matching parsed pairs for page {page_number}: {panel_text_pairs}")

    # Build result (ensure deterministic order by filename index)
    panel_results: List[Dict[str, Any]] = []
    for i, panel in enumerate(panels):
        panel_id = f"panel{i + 1}"
        matched_text = ""
        for pair in panel_text_pairs:
            if len(pair) != 2:
                continue
            if normalize_panel_id(pair[0]) == normalize_panel_id(panel_id):
                matched_text = pair[1]
                break
        panel_results.append({
            "filename": panel["filename"],
            "url": panel["url"],
            "matched_text": matched_text
        })

    page_result = {
        "page_number": int(page_number),
        "filename": filename,
        "page_narration": page_narration,
        "panels": panel_results
    }

    # Persist into workflow.text_matching.data
    tm_data = project.get("workflow", {}).get("text_matching", {}).get("data") or []
    replaced = False
    for i, p in enumerate(tm_data):
        if int(p.get("page_number", 0)) == int(page_number):
            tm_data[i] = page_result
            replaced = True
            break
    if not replaced:
        tm_data.append(page_result)

    update_manga_project(project_id, {
        "workflow.text_matching.status": project.get("workflow", {}).get("text_matching", {}).get("status", "complete"),
        "workflow.text_matching.data": tm_data,
        "status": "text_matching"
    })

    return {"page": page_result}

@app.post("/api/manga/{project_id}/tts/synthesize")
async def synthesize_tts_api(project_id: str, text: str):
    """Synthesize text to speech for a single panel"""
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    try:
        import requests
        
        # Call external TTS API
        form_data = {
            'text': text,
            'exaggeration': '0.5',
            'cfg_weight': '0.5',
            'temperature': '0.8'
        }
        
        if not TTS_API_URL:
            raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")

        response = requests.post(
            TTS_API_URL,
            data=form_data,
            timeout=30
        )
        
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail=f"TTS API error: {response.status_code}")
        
        # Return the audio data
        return StreamingResponse(
            io.BytesIO(response.content),
            media_type="audio/wav",
            headers={"Content-Disposition": "attachment; filename=synthesized_audio.wav"}
        )
        
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"TTS API request failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {str(e)}")

@app.get("/api/test")
async def test_endpoint():
    """Test endpoint to verify server is working"""
    print("TEST ENDPOINT CALLED")
    logger.info("TEST ENDPOINT CALLED")
    return {"message": "Server is working", "tts_url": TTS_API_URL}

@app.post("/api/manga/{project_id}/panel-tts/synthesize")
async def synthesize_panel_tts_api(project_id: str, page_number: Optional[int] = None):
    """Synthesize text to speech for individual panels"""
    print(f"PANEL TTS ENDPOINT CALLED: project_id={project_id}, page_number={page_number}")
    logger.info(f"PANEL TTS ENDPOINT CALLED: project_id={project_id}, page_number={page_number}")
    logger.info(f"Starting panel TTS synthesis for project {project_id}")
    logger.info(f"TTS_API_URL configured as: '{TTS_API_URL}'")
    
    if not TTS_API_URL:
        logger.error("TTS_API_URL is not configured!")
        raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")
    
    # First, test the TTS API to make sure it's accessible
    try:
        logger.info(f"Testing TTS API connectivity at {TTS_API_URL}")
        test_response = requests.get(TTS_API_URL.replace('/synthesize', '/health'), timeout=10)
        logger.info(f"TTS API health check: {test_response.status_code}")
    except Exception as e:
        logger.warning(f"Could not reach TTS API health endpoint: {e}")
    
    # Also test with a simple POST request
    try:
        logger.info("Testing TTS API with simple request")
        test_data = {
            'text': 'Test',
            'exaggeration': '0.5',
            'cfg_weight': '0.5',
            'temperature': '0.8'
        }
        test_response = requests.post(TTS_API_URL, data=test_data, timeout=10)
        logger.info(f"TTS API test response: {test_response.status_code}, content_type: {test_response.headers.get('content-type')}")
        if test_response.status_code != 200:
            logger.warning(f"TTS API test failed: {test_response.text[:200]}")
    except Exception as e:
        logger.error(f"TTS API test failed with exception: {e}")
    
    project = get_manga_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Manga project not found")
    
    # Get text matching data
    text_matching_data = project.get("workflow", {}).get("text_matching", {}).get("data")
    if not text_matching_data:
        raise HTTPException(status_code=400, detail="Text matching not completed yet")
    
    # Debug: Log structure of text matching data
    logger.info(f"Panel TTS: Text matching data structure for project {project_id}")
    for page_data in text_matching_data[:2]:  # Log first 2 pages for debugging
        page_num = page_data.get("page_number", "?")
        panels = page_data.get("panels", [])
        logger.info(f"  Page {page_num}: {len(panels)} panels")
        for i, panel in enumerate(panels[:3]):  # Log first 3 panels per page
            text = panel.get("matched_text", "")
            logger.info(f"    Panel {i+1}: '{text[:50]}{'...' if len(text) > 50 else ''}' (len={len(text)})")
    
    project_dir = os.path.join(MANGA_DIR, project_id)
    os.makedirs(project_dir, exist_ok=True)
    
    panel_tts_data = {}
    total_panels = 0
    processed_panels = 0
    
    try:
        import requests
        
        if not TTS_API_URL:
            raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")
        
        # Filter pages if page_number is specified
        pages_to_process = text_matching_data
        if page_number is not None:
            pages_to_process = [p for p in text_matching_data if p.get("page_number") == page_number]
            if not pages_to_process:
                raise HTTPException(status_code=404, detail=f"Page {page_number} not found")
        
        # Count total panels and panels with text
        panels_with_text = 0
        for page_data in pages_to_process:
            panels = page_data.get("panels", [])
            total_panels += len(panels)
            for panel in panels:
                if panel.get("matched_text", "").strip():
                    panels_with_text += 1
        
        logger.info(f"Panel TTS: Processing {len(pages_to_process)} pages, {total_panels} total panels, {panels_with_text} panels with text")
        
        if total_panels == 0:
            raise HTTPException(status_code=400, detail="No panels found in text matching data")
        
        if panels_with_text == 0:
            raise HTTPException(status_code=400, detail=f"No panels with text found. Found {total_panels} panels but all have empty text. Please ensure text matching is completed properly.")
        
        # Process each page
        for page_data in pages_to_process:
            page_num = page_data.get("page_number", 1)
            panels = page_data.get("panels", [])
            
            page_panel_data = []
            
            # Process each panel in the page
            for panel_index, panel in enumerate(panels):
                matched_text = panel.get("matched_text", "").strip()
                
                logger.info(f"Panel TTS: Page {page_num}, Panel {panel_index + 1}: Text='{matched_text[:50]}{'...' if len(matched_text) > 50 else ''}'")
                
                if not matched_text:
                    # Add empty entry for panels without text
                    page_panel_data.append({
                        "panelIndex": panel_index,
                        "filename": panel.get("filename", ""),
                        "text": "",
                        "audioFile": None,
                        "duration": 0
                    })
                    continue
                
                try:
                    # Call TTS API
                    form_data = {
                        'text': matched_text,
                        'exaggeration': '0.5',
                        'cfg_weight': '0.5',
                        'temperature': '0.8'
                    }
                    
                    print(f"CALLING TTS API for page {page_num} panel {panel_index + 1}")
                    print(f"TTS_API_URL: {TTS_API_URL}")
                    print(f"Text length: {len(matched_text)}")
                    
                    logger.info(f"Calling TTS API for page {page_num} panel {panel_index + 1}: {TTS_API_URL}")
                    logger.info(f"TTS request data: text='{matched_text[:100]}{'...' if len(matched_text) > 100 else ''}' (len={len(matched_text)})")
                    
                    response = requests.post(TTS_API_URL, data=form_data, timeout=30)
                    
                    print(f"TTS API response status: {response.status_code}")
                    print(f"TTS API response headers: {dict(response.headers)}")
                    
                    logger.info(f"TTS API response: status={response.status_code}, headers={dict(response.headers)}")
                    
                    if response.status_code == 200:
                        print(f"SUCCESS: TTS API returned audio for page {page_num} panel {panel_index + 1}")
                        # Save audio file
                        audio_filename = f"tts_page_{page_num}_panel_{panel_index + 1}.wav"
                        audio_path = os.path.join(project_dir, audio_filename)
                        
                        logger.info(f"Saving audio to: {audio_path}")
                        
                        with open(audio_path, "wb") as f:
                            f.write(response.content)
                        
                        # Get audio duration (approximate based on text length)
                        # For more accurate duration, you could use librosa or similar
                        estimated_duration = max(len(matched_text) * 0.05, 1.0)  # ~0.05 seconds per character, min 1 second
                        
                        page_panel_data.append({
                            "panelIndex": panel_index,
                            "filename": panel.get("filename", ""),
                            "text": matched_text,
                            "audioFile": audio_filename,
                            "duration": estimated_duration
                        })
                        
                        processed_panels += 1
                        print(f"PROCESSED PANEL {processed_panels}")
                        
                    else:
                        print(f"ERROR: TTS API failed with status {response.status_code}")
                        print(f"Error response: {response.text[:500]}")
                        logger.warning(f"TTS API failed for page {page_num} panel {panel_index + 1}: {response.status_code}")
                        logger.warning(f"TTS API error response: {response.text[:500]}")
                        page_panel_data.append({
                            "panelIndex": panel_index,
                            "filename": panel.get("filename", ""),
                            "text": matched_text,
                            "audioFile": None,
                            "duration": 0
                        })
                        
                except Exception as e:
                    print(f"EXCEPTION calling TTS API: {e}")
                    logger.exception(f"Failed to synthesize panel {panel_index + 1} on page {page_num}: {e}")
                    page_panel_data.append({
                        "panelIndex": panel_index,
                        "filename": panel.get("filename", ""),
                        "text": matched_text,
                        "audioFile": None,
                        "duration": 0
                    })
            
            if page_panel_data:
                panel_tts_data[f"page{page_num}"] = page_panel_data
        
        # Update project
        update_manga_project(project_id, {
            "workflow.panel_tts.status": "complete",
            "workflow.panel_tts.data": panel_tts_data
        })
        
        return {
            "success": True,
            "processed_panels": processed_panels,
            "total_panels": total_panels,
            "panels_with_text": panels_with_text,
            "data": panel_tts_data,
            "message": f"Processed {processed_panels} out of {panels_with_text} panels with text (total {total_panels} panels found)"
        }
        
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"TTS API request failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Panel TTS synthesis failed: {str(e)}")

@app.post("/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload files (images or audio). Returns a list of saved filenames.
    Accepts common image and audio extensions (png/jpg/webp/mp3/wav/ogg/m4a).
    """
    saved_files: List[str] = []
    allowed_exts = ('.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.ogg', '.m4a')
    for file in files:
        fname = file.filename or ''
        lower = fname.lower()
        # Basic guard on extension
        if not any(lower.endswith(ext) for ext in allowed_exts):
            continue
        # Avoid overwriting existing files with same name by prefixing timestamp if needed
        dest_name = fname
        destination = os.path.join(UPLOAD_DIR, dest_name)
        # If file exists, add timestamp
        if os.path.exists(destination):
            base, ext = os.path.splitext(dest_name)
            dest_name = f"{base}-{int(datetime.utcnow().timestamp())}{ext}"
            destination = os.path.join(UPLOAD_DIR, dest_name)
        contents = await file.read()
        with open(destination, "wb") as f:
            f.write(contents)
        saved_files.append(dest_name)
    
    # Sort by page number instead of alphabetically
    sorted_file_pairs = sort_files_by_page_number(saved_files)
    saved_files = [filename for filename, _ in sorted_file_pairs]
    
    return {"filenames": saved_files}

@app.post("/upload-json")
async def upload_json_data(file: UploadFile = File(...)):
    """Upload and validate JSON data for manga project"""
    if not file.filename.lower().endswith('.json'):
        raise HTTPException(status_code=400, detail="Only JSON files are allowed")
    
    try:
        contents = await file.read()
        json_data = json.loads(contents.decode('utf-8'))
        
        # Handle different JSON formats
        processed_data = None
        
        # Format 1: Direct page_narrations array (from API response)
        if isinstance(json_data, list):
            # Validate it's an array of [page_label, narration] pairs
            if all(isinstance(item, list) and len(item) == 2 for item in json_data):
                # Transform to internal format
                page_narrations = json_data
                full_narration = "\n\n".join([f"**{item[0]}:** {item[1]}" for item in page_narrations])
                processed_data = {
                    "narration": full_narration,
                    "page_narrations": page_narrations
                }
            else:
                raise HTTPException(status_code=400, detail="If JSON is an array, it must contain [page_label, narration] pairs")
        
        # Format 2: Object with narrative data
        elif isinstance(json_data, dict):
            # Check if it has the expected structure
            if 'page_narrations' in json_data:
                page_narrations = json_data.get('page_narrations', [])
                if not isinstance(page_narrations, list):
                    raise HTTPException(status_code=400, detail="page_narrations must be an array")
                
                # Validate page_narrations format
                for i, item in enumerate(page_narrations):
                    if not isinstance(item, list) or len(item) != 2:
                        raise HTTPException(
                            status_code=400, 
                            detail=f"page_narrations[{i}] must be an array with exactly 2 elements [page_label, narration]"
                        )
                
                # Use provided narration or generate from page_narrations
                full_narration = json_data.get('narration', '')
                if not full_narration:
                    full_narration = "\n\n".join([f"**{item[0]}:** {item[1]}" for item in page_narrations])
                
                processed_data = {
                    "narration": full_narration,
                    "page_narrations": page_narrations
                }
            else:
                raise HTTPException(status_code=400, detail="JSON object must contain 'page_narrations' field")
        else:
            raise HTTPException(status_code=400, detail="JSON must be either an array of [page_label, narration] pairs or an object with page_narrations")
        
        return {
            "success": True,
            "data": processed_data,
            "filename": file.filename
        }
        
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON format: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error processing JSON file: {str(e)}")


@app.post("/process-chapter")
async def process_chapter():
    global full_story_context
    # Reset per request; for persistent multi-chapter context, remove this reset.
    full_story_context = ""

    # Gather images from uploads dir, sorted by page number
    filenames = [fn for fn in os.listdir(UPLOAD_DIR) if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    sorted_file_pairs = sort_files_by_page_number(filenames)
    filenames = [filename for filename, _ in sorted_file_pairs]

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


if __name__ == "__main__":
    import uvicorn  # type: ignore

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)



import os
import io
import json
import logging
import re
from typing import List, Dict, Any, Optional, Tuple
import ast
from datetime import datetime
import asyncio

from fastapi import FastAPI, File, UploadFile, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
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
# Default to using LayoutParser when available unless explicitly disabled
_lp_env = os.environ.get("USE_LAYOUTPARSER")
USE_LAYOUTPARSER = True if _lp_env is None else _lp_env.lower() in {"1", "true", "yes"}

# TTS API endpoint (must be provided via .env as TTS_API_URL)
# Example in .env: TTS_API_URL=https://your-tts-host.example/synthesize
TTS_API_URL = os.environ.get("TTS_API_URL", "").strip()

# Local panel detection functions removed - using external API only


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

app = FastAPI(title="Manga AI Dashboard")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/manga_projects", StaticFiles(directory=MANGA_DIR), name="manga_projects")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

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
        "Make sure each panel is described in the narration with all details that are visible in the panel."
        "Each page should have its own distinct narrative segment that flows naturally into the next. "
        "Do not mention the pages or chapters in the narration like `this chapter starts with` it should not feel like you are reading from pages"
        "IMPORTANT: Return ONLY a JSON array in this exact format: {[[\"Page1\", \"narration text\"], [\"Page2\", \"narration text\"], ...]} "
        "Do NOT include any markdown code blocks do NOT include any other text. "
        "Just return the raw JSON {[\"Page1\", \"narration text\"], [\"Page2\", \"narration text\"], ...]}"
        "Example: {[[\"Page1\", \"The story begins with our protagonist...\"], [\"Page2\", \"As the scene continues...\"]]}"
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


# Old detect-panels endpoint removed - use project-specific panel detection instead


# Old process-page endpoint removed - use project-based workflow instead


if __name__ == "__main__":
    import uvicorn  # type: ignore

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)



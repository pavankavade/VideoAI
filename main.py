import os
import io
import json
import logging
import re
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
import asyncio
import time
import requests

from fastapi import FastAPI, File, UploadFile, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from mangaeditor import router as editor_router
from videoeditor import router as video_router

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

app = FastAPI(title="Manga AI Dashboard")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/manga_projects", StaticFiles(directory=MANGA_DIR), name="manga_projects")
templates = Jinja2Templates(directory=TEMPLATES_DIR)
app.include_router(editor_router)
app.include_router(video_router)

@app.middleware("http")
async def add_coop_coep_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response

@app.middleware("http")
async def log_errors(request: Request, call_next):
    """Middleware to catch and log all unhandled errors"""
    try:
        response = await call_next(request)
        return response
    except Exception as e:
        logger.error(f"Unhandled error on {request.method} {request.url.path}: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Internal server error: {str(e)}"}
        )

# CORS: allow LAN/dev usage from other devices on the same network
# For production, restrict allow_origins via environment variable ALLOW_ORIGINS (comma-separated)
allow_origins_env = os.environ.get("ALLOW_ORIGINS", "*").strip()
if allow_origins_env == "*":
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in allow_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Manga project management
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


# Local panel detection fully removed; legacy code that referenced it now inlines a full-page box fallback.

@app.get("/", response_class=RedirectResponse)
async def index(request: Request):
    """Redirect to new dashboard"""
    return RedirectResponse(url="/editor/dashboard", status_code=302)

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

# MangaDex Integration Routes
@app.get("/mangadex/viewer", response_class=HTMLResponse)
async def mangadex_viewer(request: Request):
    """Render the MangaDex viewer page with advanced filters"""
    return templates.TemplateResponse("mangadex_viewer.html", {"request": request})

@app.post("/mangadex/search")
async def mangadex_search(request: Request):
    """
    Search MangaDex with advanced filters.
    Accepts filters like: title, status, contentRating, year, originalLanguage, includedTags, order
    """
    try:
        body = await request.json()
        filters = body.get("filters", {})
        page = body.get("page", 1)
        limit = body.get("limit", 20)
        
        # Get MangaDex secret from environment
        mangadex_secret = os.environ.get("MANGADX_SECRET", "").strip()
        
        # Build MangaDex API URL
        base_url = "https://api.mangadex.org/manga"
        params = {
            "limit": limit,
            "offset": (page - 1) * limit,
            "includes[]": ["cover_art", "author", "artist"],
        }
        
        # Add title filter
        if filters.get("title"):
            params["title"] = filters["title"]
        
        # Add status filter
        if filters.get("status"):
            for status in filters["status"]:
                params["status[]"] = status
        
        # Add content rating filter
        if filters.get("contentRating"):
            for rating in filters["contentRating"]:
                params["contentRating[]"] = rating
        else:
            # Default to safe, suggestive if not specified
            params["contentRating[]"] = ["safe", "suggestive"]
        
        # Add year filter
        if filters.get("year"):
            params["year"] = filters["year"]
        
        # Add language filter
        if filters.get("originalLanguage"):
            for lang in filters["originalLanguage"]:
                params["originalLanguage[]"] = lang
        
        # Add release date range filter (createdAt)
        if filters.get("releaseDateMonths"):
            months = filters["releaseDateMonths"]
            cutoff_date = datetime.now() - timedelta(days=30 * months)
            params["createdAtSince"] = cutoff_date.strftime("%Y-%m-%dT%H:%M:%S")
        
        # Add availability filter to ensure published chapters exist
        params["availableTranslatedLanguage[]"] = ["en"]
        
        # Add tag filters (Note: MangaDex uses tag IDs, not names)
        # For simplicity, we'll skip tag filtering in the API call
        # and let the frontend handle tag display
        # To properly implement this, you'd need to first fetch tag IDs from MangaDex
        
        # Add sorting
        if filters.get("order"):
            for key, value in filters["order"].items():
                params[f"order[{key}]"] = value
        
        # Make request to MangaDex API
        headers = {}
        if mangadex_secret:
            headers["Authorization"] = f"Bearer {mangadex_secret}"
        
        async with asyncio.timeout(30):
            response = requests.get(base_url, params=params, headers=headers, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            
            # Fetch chapter counts for each manga if minChapters filter is applied
            min_chapters = filters.get("minChapters", 0)
            if min_chapters > 0 and data.get("data"):
                filtered_manga = []
                for manga in data["data"]:
                    manga_id = manga["id"]
                    # Query chapter count
                    chapter_params = {
                        "manga": manga_id,
                        "translatedLanguage[]": ["en"],
                        "limit": 1,
                    }
                    try:
                        chapter_response = requests.get(
                            "https://api.mangadex.org/chapter",
                            params=chapter_params,
                            headers=headers,
                            timeout=10
                        )
                        if chapter_response.status_code == 200:
                            chapter_data = chapter_response.json()
                            total_chapters = chapter_data.get("total", 0)
                            # Add chapter count to manga data
                            manga["chapterCount"] = total_chapters
                            if total_chapters >= min_chapters:
                                filtered_manga.append(manga)
                        else:
                            # If we can't get chapter count, skip this manga
                            continue
                    except Exception:
                        # If chapter request fails, skip this manga
                        continue
                
                data["data"] = filtered_manga
                data["total"] = len(filtered_manga)
            
            return JSONResponse(content=data)
        else:
            logger.error(f"MangaDex API error: {response.status_code} - {response.text}")
            return JSONResponse(
                content={"error": f"MangaDex API returned status {response.status_code}"},
                status_code=response.status_code
            )
    
    except asyncio.TimeoutError:
        logger.error("MangaDex API request timed out")
        return JSONResponse(
            content={"error": "Request to MangaDex timed out"},
            status_code=504
        )
    except Exception as e:
        logger.error(f"Error searching MangaDex: {e}", exc_info=True)
        return JSONResponse(
            content={"error": str(e)},
            status_code=500
        )

@app.get("/mangadex/tags")
async def mangadex_tags():
    """Get all available tags from MangaDex"""
    try:
        base_url = "https://api.mangadex.org/manga/tag"
        
        async with asyncio.timeout(10):
            response = requests.get(base_url, timeout=10)
        
        if response.status_code == 200:
            return JSONResponse(content=response.json())
        else:
            return JSONResponse(
                content={"error": f"MangaDex API returned status {response.status_code}"},
                status_code=response.status_code
            )
    except Exception as e:
        logger.error(f"Error fetching MangaDex tags: {e}", exc_info=True)
        return JSONResponse(
            content={"error": str(e)},
            status_code=500
        )

# Effect Configuration Endpoints
if __name__ == "__main__":
    # Optional direct runner for convenience: `python main.py`
    # Binds to 0.0.0.0 by default so other LAN devices can access this machine.
    import uvicorn  # type: ignore
    import socket
    from urllib.parse import urlparse

    def get_local_ip() -> str:
        ip = "127.0.0.1"
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            # Doesn't need to be reachable; used to determine the default interface
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
        except Exception:
            try:
                ip = socket.gethostbyname(socket.gethostname()) or ip
            except Exception:
                pass
        return ip

    host = os.environ.get("HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("PORT", "8000"))
    except Exception:
        port = 8000
    reload_flag = (os.environ.get("RELOAD", "1").lower() in {"1", "true", "yes"})

    # Friendly startup banner
    env_name = "development" if reload_flag else "production"
    local_ip = get_local_ip()
    print("Manga AI Dashboard starting...")
    print(f" * Environment: {env_name}")
    print(f" * Base directory: {BASE_DIR}")
    print(f" * Uploads dir: {UPLOAD_DIR}")
    print(f" * Manga projects dir: {MANGA_DIR}")
    print(" * Access the application at:")
    print(f"   - Local:   http://127.0.0.1:{port}")
    if host == "0.0.0.0":
        print(f"   - Network: http://{local_ip}:{port}")
    else:
        print("   - Network: (bind to 0.0.0.0 to allow LAN access)")

    # Optional: expose via ngrok only if NGROK_APP_URL and NGROK_APP_AUTHTOKEN exist
    ngrok_url = None
    app_url = (os.environ.get("NGROK_APP_URL") or "").strip()
    app_token = (os.environ.get("NGROK_APP_AUTHTOKEN") or "").strip()
    if app_url and app_token:
        try:
            from pyngrok import ngrok, conf  # type: ignore
            conf.get_default().auth_token = app_token
            opts = {"bind_tls": True}
            parsed = urlparse(app_url)
            hostname = parsed.hostname
            try:
                if hostname:
                    tunnel = ngrok.connect(addr=port, proto="http", hostname=hostname, **opts)
                else:
                    tunnel = ngrok.connect(addr=port, proto="http", **opts)
                ngrok_url = tunnel.public_url
                print(f" * Public (ngrok): {ngrok_url}")
                logger.info(f"ngrok tunnel established: {ngrok_url}")
                logger.info(f"Public URL: {ngrok_url}")
            except Exception:
                logger.exception("ngrok hostname binding failed; falling back to random URL")
                tunnel = ngrok.connect(addr=port, proto="http", **opts)
                ngrok_url = tunnel.public_url
                print(f" * Public (ngrok): {ngrok_url}")
                logger.info(f"ngrok tunnel established: {ngrok_url}")
                logger.info(f"Public URL: {ngrok_url}")
        except Exception:
            logger.exception("Failed to start ngrok tunnel; continuing without public URL")

    logger.info(f"Starting Uvicorn on {host}:{port} reload={reload_flag}")
    uvicorn.run("main:app", host=host, port=port, reload=reload_flag)



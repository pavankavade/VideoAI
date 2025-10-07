import os
import io
import re
import json
import sqlite3
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from PIL import Image
import logging

try:
    import google.generativeai as genai
except Exception:
    genai = None


# Paths and templates
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
MANGA_DIR = os.path.join(BASE_DIR, "manga_projects")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, "mangaeditor.db")
PANEL_API_URL = os.environ.get("PANEL_API_URL", "").strip()
# External TTS API (optional) for DB-backed editor flows
TTS_API_URL = os.environ.get("TTS_API_URL", "").strip()

templates = Jinja2Templates(directory=TEMPLATES_DIR)
router = APIRouter(prefix="/editor", tags=["manga-editor"])
logger = logging.getLogger("mangaeditor")


# ---------------------------- SQLite helpers ----------------------------
class EditorDB:
    _lock = threading.Lock()
    _conn: Optional[sqlite3.Connection] = None

    @classmethod
    def conn(cls) -> sqlite3.Connection:
        if cls._conn is None:
            with cls._lock:
                if cls._conn is None:
                    cls._conn = sqlite3.connect(DB_PATH, check_same_thread=False)
                    # Use Row factory for name-based column access
                    cls._conn.row_factory = sqlite3.Row
                    try:
                        cls._conn.execute("PRAGMA foreign_keys = ON")
                    except Exception:
                        pass
                    cls.init_schema()
        # Ensure schema exists (idempotent) in case the connection persisted across code changes
        try:
            cls.init_schema()
        except Exception:
            pass
        return cls._conn

    @classmethod
    def init_schema(cls) -> None:
        c = cls._conn.cursor()
        # Legacy tables (kept for backward compatibility) and new consolidated storage
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS pages (
                project_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                PRIMARY KEY (project_id, page_number),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            """
        )
        # New consolidated project details
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS project_details (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                pages_json TEXT NOT NULL,
                character_markdown TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS panels (
                project_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                panel_index INTEGER NOT NULL,
                image_path TEXT NOT NULL,
                -- new fields
                narration_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (project_id, page_number, panel_index),
                FOREIGN KEY (project_id) REFERENCES project_details(id) ON DELETE CASCADE
            );
            """
        )
        # If panels table exists but FK still points to legacy 'projects', migrate to reference 'project_details'
        try:
            fk_rows = c.execute("PRAGMA foreign_key_list(panels)").fetchall()
            # PRAGMA foreign_key_list columns: id, seq, table, from, to, on_update, on_delete, match
            targets = {str(r[2]) for r in fk_rows}
            if targets and ("project_details" not in targets):
                # Migrate panels table to correct FK
                c.execute("ALTER TABLE panels RENAME TO panels_old")
                c.execute(
                    """
                    CREATE TABLE panels (
                        project_id TEXT NOT NULL,
                        page_number INTEGER NOT NULL,
                        panel_index INTEGER NOT NULL,
                        image_path TEXT NOT NULL,
                        narration_text TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL DEFAULT '',
                        PRIMARY KEY (project_id, page_number, panel_index),
                        FOREIGN KEY (project_id) REFERENCES project_details(id) ON DELETE CASCADE
                    );
                    """
                )
                # Determine available columns on old table
                old_cols = {row[1] for row in c.execute("PRAGMA table_info(panels_old)").fetchall()}
                # Build SELECT with defaults for missing columns
                select_exprs = []
                for col in ["project_id","page_number","panel_index","image_path","narration_text","created_at","updated_at"]:
                    if col in old_cols:
                        select_exprs.append(col)
                    else:
                        if col == "narration_text":
                            select_exprs.append("'' AS narration_text")
                        elif col in ("created_at","updated_at"):
                            select_exprs.append("'' AS %s" % col)
                        else:
                            # Should not happen, but keep safe default
                            select_exprs.append("'' AS %s" % col)
                c.execute(
                    f"INSERT INTO panels(project_id,page_number,panel_index,image_path,narration_text,created_at,updated_at) "
                    f"SELECT {', '.join(select_exprs)} FROM panels_old"
                )
                c.execute("DROP TABLE panels_old")
        except Exception:
            # Best effort migration; ignore if any step fails
            pass
        # Try to migrate existing panels table to include new columns if missing
        try:
            cols = {row[1] for row in c.execute("PRAGMA table_info(panels)").fetchall()}
            if "narration_text" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN narration_text TEXT NOT NULL DEFAULT ''")
            # New preferred column: audio_url (replace legacy audio_b64 usage)
            if "audio_url" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN audio_url TEXT")
            if "created_at" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
            if "updated_at" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
            # New visual settings
            if "effect" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN effect TEXT NOT NULL DEFAULT 'none'")
            if "transition" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN transition TEXT NOT NULL DEFAULT 'slide_book'")
            # If legacy audio_b64 existed before, a separate migration will have copied to audio_url
        except Exception:
            pass
        cls._conn.commit()

    # -------- Projects CRUD --------
    @classmethod
    def create_project(cls, title: str, files: List[str]) -> Dict[str, Any]:
        pid = str(int(datetime.utcnow().timestamp() * 1000))
        now = datetime.utcnow().isoformat()
        conn = cls.conn()
        def _norm(p: str) -> str:
            if not isinstance(p, str):
                return ""
            p = p.strip()
            if not p:
                return p
            if p.startswith("http://") or p.startswith("https://"):
                return p
            if p.startswith("/uploads/") or p.startswith("uploads/"):
                return p if p.startswith("/") else ("/" + p)
            if p.startswith("/manga_projects/") or p.startswith("manga_projects/"):
                return p if p.startswith("/") else ("/" + p)
            # Assume it's a bare filename coming from /upload
            base = os.path.basename(p)
            return f"/uploads/{base}"
        pages = [{"page_number": i, "image_path": _norm(path)} for i, path in enumerate(files, start=1)]
        # Backfill legacy 'projects' table for compatibility with any old FKs
        try:
            conn.execute(
                "INSERT OR IGNORE INTO projects(id, title, created_at) VALUES(?,?,?)",
                (pid, title, now),
            )
        except Exception:
            pass
        conn.execute(
            "INSERT INTO project_details(id, title, created_at, pages_json, character_markdown, metadata_json) VALUES(?,?,?,?,?,?)",
            (pid, title, now, json.dumps(pages), "", json.dumps({})),
        )
        conn.commit()
        return {"id": pid, "title": title, "created_at": now, "chapters": len(files)}

    @classmethod
    def list_projects(cls) -> List[Dict[str, Any]]:
        rows = cls.conn().execute("SELECT id, title, created_at, pages_json FROM project_details ORDER BY created_at DESC").fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            try:
                pages = json.loads(r[3] or "[]")
                cnt = len(pages)
            except Exception:
                cnt = 0
            out.append({"id": r[0], "title": r[1], "createdAt": r[2], "chapters": int(cnt), "status": "uploaded"})
        return out

    @classmethod
    def get_project(cls, project_id: str) -> Optional[Dict[str, Any]]:
        r = cls.conn().execute("SELECT id, title, created_at FROM project_details WHERE id=?", (project_id,)).fetchone()
        if not r:
            return None
        return {"id": r[0], "title": r[1], "createdAt": r[2]}

    @classmethod
    def get_pages(cls, project_id: str) -> List[Dict[str, Any]]:
        row = cls.conn().execute("SELECT pages_json FROM project_details WHERE id=?", (project_id,)).fetchone()
        if not row:
            return []
        try:
            pages = json.loads(row[0] or "[]")
        except Exception:
            pages = []
        pages = sorted(pages, key=lambda p: int(p.get("page_number") or 0))
        return [{"page_number": int(p.get("page_number") or i + 1), "image_path": p.get("image_path")} for i, p in enumerate(pages)]

    @classmethod
    def delete_project(cls, project_id: str) -> None:
        c = cls.conn()
        c.execute("DELETE FROM panels WHERE project_id=?", (project_id,))
        c.execute("DELETE FROM project_details WHERE id=?", (project_id,))
        # Clean up legacy projects row if present
        try:
            c.execute("DELETE FROM projects WHERE id=?", (project_id,))
        except Exception:
            pass
        c.commit()

    @classmethod
    def set_panels_for_page(cls, project_id: str, page_number: int, panel_paths: List[str]) -> None:
        c = cls.conn()
        now = datetime.utcnow().isoformat()
        # Compatibility: ensure a row exists in legacy 'projects' for old FK constraints
        try:
            c.execute(
                "INSERT OR IGNORE INTO projects(id, title, created_at) SELECT id, title, created_at FROM project_details WHERE id=?",
                (project_id,)
            )
        except Exception:
            pass
        c.execute("DELETE FROM panels WHERE project_id=? AND page_number=?", (project_id, page_number))
        # Store panel_index as 1-based for clearer UX and consistent mapping with UI
        for idx, p in enumerate(panel_paths, start=1):
            c.execute(
                "INSERT INTO panels(project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, page_number, idx, p, "", None, now, now),
            )
        c.commit()

    @classmethod
    def get_panels_for_page(cls, project_id: str, page_number: int) -> List[Dict[str, Any]]:
        rows = cls.conn().execute(
            "SELECT panel_index, image_path, narration_text, audio_url, effect, transition FROM panels WHERE project_id=? AND page_number=? ORDER BY panel_index ASC",
            (project_id, page_number),
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            # Skip legacy/erroneous rows that have no image; these were created by older narration code
            img_path = (r[1] or "").strip()
            if not img_path:
                continue
            idx_db = int(r[0])
            # If legacy rows used 0-based, display as 1-based
            display_idx = (idx_db + 1) if idx_db == 0 else idx_db
            eff = (r[4] if len(r) > 4 else None) or "none"
            trans = (r[5] if len(r) > 5 else None) or "slide_book"
            out.append({
                "index": int(display_idx),
                "image": img_path,
                "text": r[2] or "",
                "audio": r[3],
                "effect": eff,
                "transition": trans,
            })
        return out

    @classmethod
    def upsert_panel_narration(cls, project_id: str, page_number: int, panel_index: int, text: str) -> None:
        now = datetime.utcnow().isoformat()
        c = cls.conn()
        cur = c.execute(
            "UPDATE panels SET narration_text=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
            (text, now, project_id, page_number, panel_index),
        )
        if cur.rowcount == 0:
            # Migration affordance: if DB stored 0-based, try index-1
            if panel_index > 0:
                cur2 = c.execute(
                    "UPDATE panels SET narration_text=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
                    (text, now, project_id, page_number, panel_index - 1),
                )
                if cur2.rowcount > 0:
                    c.commit()
                    return
            c.execute(
                "INSERT INTO panels(project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, page_number, panel_index, "", text, None, now, now),
            )
        c.commit()

    @classmethod
    def get_panel_narrations(cls, project_id: str) -> Dict[Tuple[int, int], str]:
        rows = cls.conn().execute(
            "SELECT page_number, panel_index, narration_text FROM panels WHERE project_id=?",
            (project_id,),
        ).fetchall()
        return {(int(r[0]), int(r[1])): (r[2] or "") for r in rows}

    @classmethod
    def set_character_list(cls, project_id: str, markdown: str) -> None:
        conn = cls.conn()
        conn.execute("UPDATE project_details SET character_markdown=? WHERE id=?", (markdown, project_id))
        conn.commit()

    @classmethod
    def get_character_list(cls, project_id: str) -> str:
        row = cls.conn().execute(
            "SELECT character_markdown FROM project_details WHERE id=?",
            (project_id,),
        ).fetchone()
        return row[0] if row else ""

    @classmethod
    def set_panel_audio(cls, project_id: str, page_number: int, panel_index: int, audio_url: Optional[str]) -> None:
        now = datetime.utcnow().isoformat()
        c = cls.conn()
        # Primary attempt: update exact 1-based index
        cur = c.execute(
            "UPDATE panels SET audio_url=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
            (audio_url, now, project_id, page_number, panel_index),
        )
        if cur.rowcount == 0 and panel_index > 0:
            # Fallback for legacy rows stored with 0-based indices
            cur2 = c.execute(
                "UPDATE panels SET audio_url=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
                (audio_url, now, project_id, page_number, panel_index - 1),
            )
            if cur2.rowcount > 0:
                c.commit()
                return
        if cur.rowcount == 0:
            # No existing row; insert one. Try to derive a sensible image_path from neighboring rows
            src = c.execute(
                "SELECT image_path FROM panels WHERE project_id=? AND page_number=? AND panel_index IN (?, ?) ORDER BY panel_index DESC LIMIT 1",
                (project_id, page_number, panel_index, max(panel_index - 1, 0)),
            ).fetchone()
            img_path = (src[0] if src and src[0] else "")
            c.execute(
                "INSERT INTO panels(project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, page_number, panel_index, img_path, "", audio_url, now, now),
            )
        c.commit()

    @classmethod
    def set_panel_config(cls, project_id: str, page_number: int, panel_index: int, effect: Optional[str], transition: Optional[str]) -> None:
        now = datetime.utcnow().isoformat()
        eff = (effect or "").strip() or "none"
        trans = (transition or "").strip() or "slide_book"
        c = cls.conn()
        cur = c.execute(
            "UPDATE panels SET effect=?, transition=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
            (eff, trans, now, project_id, page_number, panel_index),
        )
        if cur.rowcount == 0:
            # Try legacy index-1 if db stored 0-based
            if panel_index > 0:
                cur2 = c.execute(
                    "UPDATE panels SET effect=?, transition=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
                    (eff, trans, now, project_id, page_number, panel_index - 1),
                )
                if cur2.rowcount > 0:
                    c.commit()
                    return
            c.execute(
                "INSERT INTO panels(project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at, effect, transition) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (project_id, page_number, panel_index, "", "", None, now, now, eff, trans),
            )
        c.commit()


# ---------------------------- Project helpers (DB-based) ----------------------------
def extract_panel_image(panel: Dict[str, Any]) -> Optional[str]:
    # For DB-backed panels, we already return a field named 'image'
    return panel.get("image")


# ---------------------------- Gemini helpers ----------------------------
_GEMINI_KEYS: List[str] = []
if os.environ.get("GOOGLE_API_KEYS"):
    _GEMINI_KEYS = [k.strip() for k in os.environ["GOOGLE_API_KEYS"].split(",") if k.strip()]
elif os.environ.get("GOOGLE_API_KEY"):
    _GEMINI_KEYS = [k.strip() for k in os.environ["GOOGLE_API_KEY"].split(",") if k.strip()]

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_key_lock = threading.Lock()
_key_idx = 0


def _next_key() -> Optional[str]:
    global _key_idx
    if not _GEMINI_KEYS:
        return None
    with _key_lock:
        k = _GEMINI_KEYS[_key_idx % len(_GEMINI_KEYS)]
        _key_idx += 1
        return k


def _load_image_bytes(url_or_path: str) -> Optional[bytes]:
    try:
        if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
            r = requests.get(url_or_path, timeout=30)
            if r.status_code == 200:
                return r.content
            return None
        # local path
        path = url_or_path
        if url_or_path.startswith("/uploads/"):
            path = os.path.join(BASE_DIR, url_or_path.lstrip("/"))
        elif url_or_path.startswith("uploads/"):
            path = os.path.join(BASE_DIR, url_or_path)
        elif url_or_path.startswith("/manga_projects/"):
            path = os.path.join(BASE_DIR, url_or_path.lstrip("/"))
        elif url_or_path.startswith("manga_projects/"):
            path = os.path.join(BASE_DIR, url_or_path)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
    except Exception:
        return None
    return None


def _gemini_client() -> Optional[Any]:
    if genai is None:
        return None
    key = _next_key()
    if not key:
        return None
    genai.configure(api_key=key)
    try:
        return genai.GenerativeModel(GEMINI_MODEL)
    except Exception:
        return None


def _extract_json(text: str) -> Any:
    # Find first JSON object/array in the text
    import re

    candidates = re.findall(r"(\{[\s\S]*\}|\[[\s\S]*\])", text)
    for c in candidates:
        try:
            return json.loads(c)
        except Exception:
            continue
    # fallback: return raw text
    return text


def _build_page_prompt(page_number: int, panel_images: List[bytes], accumulated_context: str, user_characters: str) -> List[Any]:
    sys_instructions = (
        "You are a manga narration assistant. For the given page, write a cohesive, flowing micro‑narrative that spans the panels in order. "
        "Produce one vivid, short sentence per panel, but ensure each sentence connects naturally to the next so it reads like a continuous story, not a list. "
        "Avoid list formatting, numbering, or using the word 'panel'. Do not start every sentence with a proper name. "
        "Use character names sparingly—after the first clear mention, prefer pronouns and varied sentence openings unless a name is needed for clarity. "
        "After a character is introduced (full name allowed once if helpful), do NOT use their full name again; use only their first name (e.g., 'Kusch' not 'Kusch Bilboar') or a pronoun. "
        "Return ONLY JSON with an array 'panels', where each element is {panel_index: number, text: string}. No extra commentary."
    )
    if accumulated_context:
        sys_instructions += "\nContext so far (previous pages):\n" + accumulated_context
    if user_characters:
        sys_instructions += (
            "\nKnown characters (markdown) — use names sparingly for smooth narration; after the first mention, prefer pronouns or first names only (avoid surnames):\n"
            + user_characters
        )

    # Build contents: a system text + images
    content = [{"role": "user", "parts": [sys_instructions]}]
    # The SDK expects parts; use inline images
    parts = [sys_instructions]
    for img in panel_images:
        parts.append({"inline_data": {"mime_type": "image/png", "data": img}})
    content = [
        {
            "role": "user",
            "parts": parts,
        }
    ]
    return content


# ---------------------------- Routes ----------------------------
@router.get("/manga-editor/{project_id}", response_class=HTMLResponse)
async def editor_page(request: Request, project_id: str):
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return templates.TemplateResponse(
        "manga_editor.html",
        {"request": request, "project": project},
    )


@router.get("/dashboard", response_class=HTMLResponse)
async def editor_dashboard(request: Request):
    # Simple page that uses /api/manga to list projects and links into the editor
    return templates.TemplateResponse(
        "manga_editor_dashboard.html",
        {"request": request},
    )


@router.get("/api/project/{project_id}")
async def api_get_project_summary(project_id: str):
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    # Build pages with panels from DB
    pages_db = EditorDB.get_pages(project_id)
    pages: List[Dict[str, Any]] = []
    all_have_panels = True if pages_db else False
    for pg in pages_db:
        pn = int(pg["page_number"])
        panels = EditorDB.get_panels_for_page(project_id, pn)
        if not panels:
            all_have_panels = False
        pages.append({
            "page_number": pn,
            "image_url": pg.get("image_path"),
            "panels": panels,
        })
    char_md = EditorDB.get_character_list(project_id)
    narrs = EditorDB.get_panel_narrations(project_id)
    return {
        "project": {"id": project_id, "title": project.get("title", "Untitled")},
        "pages": pages,
        "allPanelsReady": bool(all_have_panels),
        "characterList": char_md,
    }


@router.post("/api/project/{project_id}/panels/create")
async def api_create_panels(project_id: str):
    """Create panels for all pages using external PANEL_API_URL, store crops in project folder, and save to DB."""
    if not PANEL_API_URL:
        raise HTTPException(status_code=400, detail="PANEL_API_URL not configured")
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    pages = EditorDB.get_pages(project_id)
    if not pages:
        raise HTTPException(status_code=400, detail="No pages in project")

    project_dir = os.path.join(MANGA_DIR, project_id)
    os.makedirs(project_dir, exist_ok=True)

    results: Dict[int, int] = {}
    for pg in pages:
        pn = int(pg["page_number"])
        img_path = pg["image_path"]
        # Resolve local absolute path if needed
        abs_path = img_path
        if img_path.startswith("/uploads/"):
            abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
        elif img_path.startswith("uploads/"):
            abs_path = os.path.join(BASE_DIR, img_path)
        elif not os.path.isabs(abs_path):
            abs_path = os.path.join(BASE_DIR, abs_path)
        # Fallback: look under uploads directory if file not found
        if not os.path.exists(abs_path):
            fallback = os.path.join(UPLOADS_DIR, os.path.basename(img_path))
            if os.path.exists(fallback):
                abs_path = fallback
        if not os.path.exists(abs_path):
            logger.warning(f"[panels/create] Skipping page {pn}: file not found {img_path}")
            continue
        try:
            # Send file with optional upstream params (match legacy behavior)
            with open(abs_path, "rb") as f:
                files = {"file": (os.path.basename(abs_path), f, "image/png")}
                params = {
                    "add_border": "true",
                    "border_width": 4,
                    "border_color": "black",
                    "curved_border": "true",
                    "corner_radius": 20,
                }
                logger.info(f"[panels/create] Posting page {pn} to PANEL_API_URL: {PANEL_API_URL}")
                r = requests.post(PANEL_API_URL, files=files, params=params, timeout=600)
            if r.status_code != 200:
                logger.warning(f"[panels/create] Upstream error for page {pn}: status {r.status_code}")
                continue
            content_type = r.headers.get("content-type", "").lower()
            panel_paths: List[str] = []
            if "application/json" in content_type:
                # Accept multiple shapes from upstream
                try:
                    data = r.json()
                except Exception:
                    data = {}
                boxes = (
                    data.get("panels")
                    or data.get("panel_boxes")
                    or data.get("boxes")
                    or data.get("bboxes")
                    or []
                )
                # Normalize entries to [x1,y1,x2,y2]
                norm_boxes: List[Tuple[int,int,int,int]] = []
                for b in boxes:
                    try:
                        if isinstance(b, dict):
                            # Support dict with x,y,w,h or x1,y1,x2,y2
                            if all(k in b for k in ("x","y","w","h")):
                                x1 = int(b["x"]) ; y1 = int(b["y"]) ; x2 = x1 + int(b["w"]) ; y2 = y1 + int(b["h"]) 
                                norm_boxes.append((x1,y1,x2,y2))
                            elif all(k in b for k in ("x1","y1","x2","y2")):
                                norm_boxes.append((int(b["x1"]), int(b["y1"]), int(b["x2"]), int(b["y2"])))
                        elif isinstance(b, (list, tuple)) and len(b) == 4:
                            x1,y1,x2,y2 = map(int, b)
                            norm_boxes.append((x1,y1,x2,y2))
                    except Exception:
                        continue
                # Crop locally (fallback to full page if no boxes)
                image = Image.open(abs_path).convert("RGB")
                if not norm_boxes:
                    w,h = image.size
                    norm_boxes = [(0,0,w,h)]
                page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                os.makedirs(page_dir, exist_ok=True)
                panel_paths = []
                for idx, (x1,y1,x2,y2) in enumerate(norm_boxes):
                    crop = image.crop((x1,y1,x2,y2))
                    out_name = f"panel_{idx:03d}.png"
                    out_abs = os.path.join(page_dir, out_name)
                    crop.save(out_abs)
                    rel = f"/manga_projects/{project_id}/page_{pn:03d}/{out_name}"
                    panel_paths.append(rel)
            elif ("application/zip" in content_type) or ("zip" in content_type) or (r.content[:2] == b"PK"):
                from zipfile import ZipFile
                from io import BytesIO
                page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                os.makedirs(page_dir, exist_ok=True)
                zf = ZipFile(BytesIO(r.content))
                panel_paths = []
                for name in zf.namelist():
                    if name.endswith("/"):
                        continue
                    data = zf.read(name)
                    # normalize filename
                    base = os.path.basename(name)
                    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", base)
                    out_abs = os.path.join(page_dir, safe)
                    with open(out_abs, "wb") as wf:
                        wf.write(data)
                    rel = f"/manga_projects/{project_id}/page_{pn:03d}/{safe}"
                    panel_paths.append(rel)
            elif ("image/" in content_type) or r.content[:8].startswith(b"\x89PNG") or r.content[:2] == b"\xff\xd8":
                # Single image fallback: treat as one panel
                page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                os.makedirs(page_dir, exist_ok=True)
                out_abs = os.path.join(page_dir, "panel_000.png")
                with open(out_abs, "wb") as wf:
                    wf.write(r.content)
                panel_paths = [f"/manga_projects/{project_id}/page_{pn:03d}/panel_000.png"]
            else:
                # Unknown content-type: attempt to parse as JSON first, else fallback to single image
                try:
                    data = r.json()
                    boxes = data.get("panels") or data.get("panel_boxes") or data.get("boxes") or data.get("bboxes") or []
                    image = Image.open(abs_path).convert("RGB")
                    if not boxes:
                        w,h = image.size
                        boxes = [(0,0,w,h)]
                    page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                    os.makedirs(page_dir, exist_ok=True)
                    panel_paths = []
                    for idx, b in enumerate(boxes):
                        if isinstance(b, dict) and all(k in b for k in ("x","y","w","h")):
                            x1 = int(b["x"]) ; y1 = int(b["y"]) ; x2 = x1 + int(b["w"]) ; y2 = y1 + int(b["h"]) 
                        else:
                            x1,y1,x2,y2 = map(int, b)
                        crop = image.crop((x1,y1,x2,y2))
                        out_name = f"panel_{idx:03d}.png"
                        out_abs = os.path.join(page_dir, out_name)
                        crop.save(out_abs)
                        rel = f"/manga_projects/{project_id}/page_{pn:03d}/{out_name}"
                        panel_paths.append(rel)
                except Exception:
                    page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                    os.makedirs(page_dir, exist_ok=True)
                    out_abs = os.path.join(page_dir, "panel_000.bin")
                    with open(out_abs, "wb") as wf:
                        wf.write(r.content)
                    # Don't register unknown binary as a panel; skip
                    panel_paths = []

            EditorDB.set_panels_for_page(project_id, pn, panel_paths)
            results[pn] = len(panel_paths)
            if panel_paths:
                logging.warning(f"[panels/create] Page {pn}: saved {len(panel_paths)} panels")
            else:
                logging.warning(f"[panels/create] Page {pn}: no panels produced by upstream response")
        except Exception:
            logging.exception(f"[panels/create] Exception while processing page {pn}")
            continue

    return {"ok": True, "created": results}


@router.post("/api/project/{project_id}/panels/create/page/{page_number}")
async def api_create_panels_single_page(project_id: str, page_number: int):
    """Create panels for a single page, used for granular progress in the UI."""
    if not PANEL_API_URL:
        raise HTTPException(status_code=400, detail="PANEL_API_URL not configured")
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    pages = EditorDB.get_pages(project_id)
    pg = next((p for p in pages if int(p.get("page_number") or 0) == int(page_number)), None)
    if not pg:
        raise HTTPException(status_code=404, detail="Page not found")

    project_dir = os.path.join(MANGA_DIR, project_id)
    os.makedirs(project_dir, exist_ok=True)

    pn = int(pg["page_number"])  # normalized
    img_path = pg["image_path"]
    # Resolve local absolute path if needed
    abs_path = img_path
    if img_path.startswith("/uploads/"):
        abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
    elif img_path.startswith("uploads/"):
        abs_path = os.path.join(BASE_DIR, img_path)
    elif not os.path.isabs(abs_path):
        abs_path = os.path.join(BASE_DIR, abs_path)
    # Fallback: look under uploads directory if file not found
    if not os.path.exists(abs_path):
        fallback = os.path.join(UPLOADS_DIR, os.path.basename(img_path))
        if os.path.exists(fallback):
            abs_path = fallback
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail=f"File not found: {img_path}")

    try:
        # Send file with optional upstream params (match legacy behavior)
        with open(abs_path, "rb") as f:
            files = {"file": (os.path.basename(abs_path), f, "image/png")}
            params = {
                "add_border": "true",
                "border_width": 4,
                "border_color": "black",
                "curved_border": "true",
                "corner_radius": 20,
            }
            logger.info(f"[panels/create/page] Posting page {pn} to PANEL_API_URL: {PANEL_API_URL}")
            r = requests.post(PANEL_API_URL, files=files, params=params, timeout=600)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Upstream error: {r.status_code}")
        content_type = r.headers.get("content-type", "").lower()
        panel_paths: List[str] = []
        if "application/json" in content_type:
            try:
                data = r.json()
            except Exception:
                data = {}
            boxes = (
                data.get("panels")
                or data.get("panel_boxes")
                or data.get("boxes")
                or data.get("bboxes")
                or []
            )
            # Normalize entries to [x1,y1,x2,y2]
            norm_boxes: List[Tuple[int,int,int,int]] = []
            for b in boxes:
                try:
                    if isinstance(b, dict):
                        if all(k in b for k in ("x","y","w","h")):
                            x1 = int(b["x"]) ; y1 = int(b["y"]) ; x2 = x1 + int(b["w"]) ; y2 = y1 + int(b["h"]) 
                            norm_boxes.append((x1,y1,x2,y2))
                        elif all(k in b for k in ("x1","y1","x2","y2")):
                            norm_boxes.append((int(b["x1"]), int(b["y1"]), int(b["x2"]), int(b["y2"])))
                    elif isinstance(b, (list, tuple)) and len(b) == 4:
                        x1,y1,x2,y2 = map(int, b)
                        norm_boxes.append((x1,y1,x2,y2))
                except Exception:
                    continue
            image = Image.open(abs_path).convert("RGB")
            if not norm_boxes:
                w,h = image.size
                norm_boxes = [(0,0,w,h)]
            page_dir = os.path.join(project_dir, f"page_{pn:03d}")
            os.makedirs(page_dir, exist_ok=True)
            panel_paths = []
            for idx, (x1,y1,x2,y2) in enumerate(norm_boxes):
                crop = image.crop((x1,y1,x2,y2))
                out_name = f"panel_{idx:03d}.png"
                out_abs = os.path.join(page_dir, out_name)
                crop.save(out_abs)
                rel = f"/manga_projects/{project_id}/page_{pn:03d}/{out_name}"
                panel_paths.append(rel)
        elif ("application/zip" in content_type) or ("zip" in content_type) or (r.content[:2] == b"PK"):
            from zipfile import ZipFile
            from io import BytesIO
            page_dir = os.path.join(project_dir, f"page_{pn:03d}")
            os.makedirs(page_dir, exist_ok=True)
            zf = ZipFile(BytesIO(r.content))
            panel_paths = []
            for name in zf.namelist():
                if name.endswith("/"):
                    continue
                data = zf.read(name)
                base = os.path.basename(name)
                safe = re.sub(r"[^A-Za-z0-9_.-]", "_", base)
                out_abs = os.path.join(page_dir, safe)
                with open(out_abs, "wb") as wf:
                    wf.write(data)
                rel = f"/manga_projects/{project_id}/page_{pn:03d}/{safe}"
                panel_paths.append(rel)
        elif ("image/" in content_type) or r.content[:8].startswith(b"\x89PNG") or r.content[:2] == b"\xff\xd8":
            page_dir = os.path.join(project_dir, f"page_{pn:03d}")
            os.makedirs(page_dir, exist_ok=True)
            out_abs = os.path.join(page_dir, "panel_000.png")
            with open(out_abs, "wb") as wf:
                wf.write(r.content)
            panel_paths = [f"/manga_projects/{project_id}/page_{pn:03d}/panel_000.png"]
        else:
            try:
                data = r.json()
                boxes = data.get("panels") or data.get("panel_boxes") or data.get("boxes") or data.get("bboxes") or []
                image = Image.open(abs_path).convert("RGB")
                if not boxes:
                    w,h = image.size
                    boxes = [(0,0,w,h)]
                page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                os.makedirs(page_dir, exist_ok=True)
                panel_paths = []
                for idx, b in enumerate(boxes):
                    if isinstance(b, dict) and all(k in b for k in ("x","y","w","h")):
                        x1 = int(b["x"]) ; y1 = int(b["y"]) ; x2 = x1 + int(b["w"]) ; y2 = y1 + int(b["h"]) 
                    else:
                        x1,y1,x2,y2 = map(int, b)
                    crop = image.crop((x1,y1,x2,y2))
                    out_name = f"panel_{idx:03d}.png"
                    out_abs = os.path.join(page_dir, out_name)
                    crop.save(out_abs)
                    rel = f"/manga_projects/{project_id}/page_{pn:03d}/{out_name}"
                    panel_paths.append(rel)
            except Exception:
                page_dir = os.path.join(project_dir, f"page_{pn:03d}")
                os.makedirs(page_dir, exist_ok=True)
                out_abs = os.path.join(page_dir, "panel_000.bin")
                with open(out_abs, "wb") as wf:
                    wf.write(r.content)
                panel_paths = []

        EditorDB.set_panels_for_page(project_id, pn, panel_paths)
        created = len(panel_paths)
        logging.warning(f"[panels/create/page] Page {pn}: saved {created} panels")
        return {"ok": True, "page_number": pn, "created": created}
    except HTTPException:
        raise
    except Exception:
        logging.exception(f"[panels/create/page] Exception while processing page {pn}")
        raise HTTPException(status_code=500, detail="Failed to create panels for this page")


@router.post("/api/project/{project_id}/narrate/sequential")
async def api_narrate_sequential(project_id: str, payload: Dict[str, Any]):
    """
    Generate narration page by page (no parallelism). For each page, produce a sentence per panel.
    Payload may include: { startPage?: number, endPage?: number, characterList?: string }
    Stores results into DB and returns combined data.
    """
    if genai is None or not _GEMINI_KEYS:
        raise HTTPException(status_code=400, detail="Gemini not configured. Set GOOGLE_API_KEYS.")

    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    pages = EditorDB.get_pages(project_id)
    if not pages:
        raise HTTPException(status_code=400, detail="Project has no pages")

    start_page = int(payload.get("startPage") or pages[0].get("page_number") or 1)
    end_page = int(payload.get("endPage") or pages[-1].get("page_number") or start_page)
    char_md = str(payload.get("characterList") or EditorDB.get_character_list(project_id) or "")

    # Accumulated narrative context (plain text)
    accumulated_text = ""
    results: List[Dict[str, Any]] = []

    for pg in pages:
        pn = int(pg.get("page_number") or 0)
        if pn < start_page or pn > end_page:
            continue
        panels = EditorDB.get_panels_for_page(project_id, pn)
        # Load images for this page's panels in their order
        imgs: List[bytes] = []
        for p in panels:
            img_url = extract_panel_image(p)
            if not img_url:
                continue
            b = _load_image_bytes(img_url)
            if b:
                imgs.append(b)

        if not imgs:
            # skip pages with no panels
            continue

        model = _gemini_client()
        if model is None:
            raise HTTPException(status_code=500, detail="Failed to initialize Gemini client")

        contents = _build_page_prompt(pn, imgs, accumulated_text, char_md)
        try:
            resp = model.generate_content(contents)
            txt = resp.text or ""
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Gemini error on page {pn}: {e}")

        data = _extract_json(txt)
        # Expect { panels: [ {panel_index, text}, ... ] }
        if isinstance(data, dict) and isinstance(data.get("panels"), list):
            # Aggregate/merge texts into valid panel indices only
            num_panels = len(panels)
            if num_panels <= 0:
                continue
            merged: Dict[int, List[str]] = {i: [] for i in range(1, num_panels + 1)}
            for item in data["panels"]:
                try:
                    idx = int(item.get("panel_index"))
                except Exception:
                    idx = 1
                if idx <= 0:
                    idx = 1
                # If model produced more indices than available panels, route extras to panel 1
                if idx > num_panels:
                    idx = 1
                text = str(item.get("text") or "").strip()
                if text:
                    merged[idx].append(text)
            page_out: List[Dict[str, Any]] = []
            for i in range(1, num_panels + 1):
                combined = " ".join(merged.get(i) or [])
                # Only update if we actually have text for this panel in this run
                if combined:
                    EditorDB.upsert_panel_narration(project_id, pn, i, combined)
                    # Ensure any existing audio URL (if a previous synth created it) remains intact; no change here
                    page_out.append({"panel_index": i, "text": combined})
            # Cleanup any legacy rows without images on this page
            try:
                EditorDB.conn().execute(
                    "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
                    (project_id, pn),
                )
                EditorDB.conn().commit()
            except Exception:
                pass
            # Append to accumulated context
            accumulated_text += f"\nPage {pn}: " + "; ".join([f"[{i['panel_index']}] {i['text']}" for i in page_out])
            results.append({"page_number": pn, "panels": page_out})
        else:
            # Fallback: treat as a single blob, assign in order
            # Split into sentences roughly equal to panel count
            text_blob = txt.strip()
            segs = [s.strip() for s in text_blob.split(".") if s.strip()]
            page_out = []
            if len(panels) == 1:
                # Put all narration into the first panel
                combined = (". ".join(segs).strip() + ".") if segs else ""
                EditorDB.upsert_panel_narration(project_id, pn, 1, combined)
                page_out.append({"panel_index": 1, "text": combined})
            else:
                for idx1 in range(1, len(panels) + 1):
                    t = (segs[idx1 - 1] + ".") if (idx1 - 1) < len(segs) else ""
                    EditorDB.upsert_panel_narration(project_id, pn, idx1, t)
                    page_out.append({"panel_index": idx1, "text": t})
            # Cleanup any legacy rows without images on this page
            try:
                EditorDB.conn().execute(
                    "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
                    (project_id, pn),
                )
                EditorDB.conn().commit()
            except Exception:
                pass
            accumulated_text += f"\nPage {pn}: " + "; ".join([f"[{i['panel_index']}] {i['text']}" for i in page_out])
            results.append({"page_number": pn, "panels": page_out})

    return {"ok": True, "results": results}


@router.post("/api/project/{project_id}/narrate/page/{page_number}")
async def api_narrate_single_page(project_id: str, page_number: int, payload: Dict[str, Any]):
    if genai is None or not _GEMINI_KEYS:
        raise HTTPException(status_code=400, detail="Gemini not configured. Set GOOGLE_API_KEYS.")

    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    pages = EditorDB.get_pages(project_id)
    # Ensure the page exists
    if not any(int(p["page_number"]) == int(page_number) for p in pages):
        raise HTTPException(status_code=404, detail="Page not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    imgs: List[bytes] = []
    for p in panels:
        img_url = extract_panel_image(p)
        if not img_url:
            continue
        b = _load_image_bytes(img_url)
        if b:
            imgs.append(b)
    if not imgs:
        raise HTTPException(status_code=400, detail="Page has no panels")

    char_md = str(payload.get("characterList") or EditorDB.get_character_list(project_id) or "")
    context_txt = str(payload.get("context") or "")

    model = _gemini_client()
    if model is None:
        raise HTTPException(status_code=500, detail="Failed to initialize Gemini client")

    contents = _build_page_prompt(int(page_number), imgs, context_txt, char_md)
    try:
        resp = model.generate_content(contents)
        txt = resp.text or ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")

    data = _extract_json(txt)
    out = []
    if isinstance(data, dict) and isinstance(data.get("panels"), list):
        num_panels = len(panels)
        merged: Dict[int, List[str]] = {i: [] for i in range(1, num_panels + 1)}
        for item in data["panels"]:
            try:
                idx = int(item.get("panel_index"))
            except Exception:
                idx = 1
            if idx <= 0:
                idx = 1
            if num_panels <= 0:
                continue
            if idx > num_panels:
                idx = 1  # route overflow narrations to first panel
            t = str(item.get("text") or "").strip()
            if t:
                merged[idx].append(t)
        for i in range(1, num_panels + 1):
            combined = " ".join(merged.get(i) or [])
            if combined:
                EditorDB.upsert_panel_narration(project_id, int(page_number), i, combined)
                out.append({"panel_index": i, "text": combined})
        # Cleanup any legacy rows without images on this page
        try:
            EditorDB.conn().execute(
                "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
                (project_id, int(page_number)),
            )
            EditorDB.conn().commit()
        except Exception:
            pass
    else:
        # fallback assignment in order
        segs = [s.strip() for s in (txt or "").split(".") if s.strip()]
        if len(panels) == 1:
            combined = (". ".join(segs).strip() + ".") if segs else ""
            EditorDB.upsert_panel_narration(project_id, int(page_number), 1, combined)
            out.append({"panel_index": 1, "text": combined})
        else:
            for idx1 in range(1, len(panels) + 1):
                t = (segs[idx1 - 1] + ".") if (idx1 - 1) < len(segs) else ""
                EditorDB.upsert_panel_narration(project_id, int(page_number), idx1, t)
                out.append({"panel_index": idx1, "text": t})
        # Cleanup any legacy rows without images on this page
        try:
            EditorDB.conn().execute(
                "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
                (project_id, int(page_number)),
            )
            EditorDB.conn().commit()
        except Exception:
            pass

    return {"ok": True, "page_number": int(page_number), "panels": out}


@router.get("/api/project/{project_id}/characters")
async def api_get_characters(project_id: str):
    return {"project_id": project_id, "markdown": EditorDB.get_character_list(project_id)}


@router.put("/api/project/{project_id}/characters")
async def api_set_characters(project_id: str, payload: Dict[str, Any]):
    md = str(payload.get("markdown") or "")
    EditorDB.set_character_list(project_id, md)
    return {"ok": True}


@router.post("/api/project/{project_id}/characters/update")
async def api_update_characters_from_narrations(project_id: str):
    if genai is None or not _GEMINI_KEYS:
        raise HTTPException(status_code=400, detail="Gemini not configured. Set GOOGLE_API_KEYS.")

    # Aggregate narrations
    narr = EditorDB.get_panel_narrations(project_id)
    if not narr:
        raise HTTPException(status_code=400, detail="No narrations found to build character list")
    # Create a compact context
    items = []
    # sort by page/panel
    for (pg, idx), text in sorted(narr.items(), key=lambda x: (x[0][0], x[0][1])):
        items.append(f"Page {pg} Panel {idx}: {text}")
    corpus = "\n".join(items)

    model = _gemini_client()
    if model is None:
        raise HTTPException(status_code=500, detail="Failed to initialize Gemini client")

    prompt = (
        "Extract a character list from the following manga panel narrations. "
        "Return a concise Markdown document listing characters with their names and visual appearance cues. "
        "If a character appears multiple times, merge details."
        "\n\nNarrations:\n" + corpus
    )
    try:
        resp = model.generate_content(prompt)
        md = resp.text or ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")

    EditorDB.set_character_list(project_id, md)
    return {"ok": True, "markdown": md}


# ---------------------------- Project APIs (new DB) ----------------------------
@router.get("/api/projects")
async def api_list_projects():
    return {"projects": EditorDB.list_projects()}


@router.post("/api/projects")
async def api_create_project(payload: Dict[str, Any]):
    title = str(payload.get("title") or "Untitled").strip()
    files = payload.get("files") or []
    if not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="files must be a non-empty array of image paths")
    proj = EditorDB.create_project(title, files)
    return proj


@router.delete("/api/projects/{project_id}")
async def api_delete_project(project_id: str):
    if not EditorDB.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    EditorDB.delete_project(project_id)
    return {"ok": True}


@router.get("/viewer/{project_id}", response_class=HTMLResponse)
async def editor_viewer(request: Request, project_id: str):
    """Render the existing manga_view UI but backed by DB data."""
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    pages = EditorDB.get_pages(project_id)
    # Build legacy-like projectData consumed by manga_view.js
    files: List[str] = []
    for pg in pages:
        img = pg.get("image_path") or ""
        base = os.path.basename(img) if img else ""
        # If it is a /uploads path, strip to filename for legacy carousel
        files.append(base or os.path.basename(img))
    # Panels into workflow.panels.data shape
    panel_pages: List[Dict[str, Any]] = []
    for pg in pages:
        pn = int(pg.get("page_number") or 0)
        panel_rows = EditorDB.get_panels_for_page(project_id, pn)
        panels_list: List[Dict[str, Any]] = []
        for p in panel_rows:
            url = p.get("image") or ""
            panels_list.append({
                "url": url,
                "filename": os.path.basename(url.lstrip("/")) if url else "",
                # carry over optional metadata placeholders used in UI
                "effect": "none",
                "transition": "slide_book",
                "matched_text": p.get("text") or "",
            })
        panel_pages.append({"page_number": pn, "panels": panels_list})
    project_payload = {
        "id": project_id,
        "title": proj.get("title") or "Untitled",
        "files": files,
        "workflow": {
            "panels": {"status": "complete" if any(len(pg["panels"]) for pg in panel_pages) else "pending", "data": panel_pages},
            "narrative": {"status": "pending", "data": None},
            "text_matching": {"status": "pending", "data": None},
            "tts": {"status": "todo", "data": None},
            "panel_tts": {"status": "todo", "data": None},
            "video_editing": {"status": "todo", "data": None},
        },
        "createdAt": proj.get("createdAt") or datetime.utcnow().isoformat(),
        "status": "uploaded",
    }
    return templates.TemplateResponse("manga_view.html", {"request": request, "project": project_payload})


# ---------------------------- New Full-Page Panel Editor ----------------------------
@router.get("/panel-editor/{project_id}", response_class=HTMLResponse)
async def panel_editor_full(request: Request, project_id: str):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return templates.TemplateResponse(
        "panel_editor_full.html",
        {"request": request, "project": proj},
    )


@router.put("/api/project/{project_id}/panel/{page_number}/{panel_index}/text")
async def api_update_panel_text(project_id: str, page_number: int, panel_index: int, payload: Dict[str, Any]):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    text = str(payload.get("text") or "").strip()
    # Clamp to valid panel indices; overflow goes to 1 as per UI convention
    num = len(panels)
    idx = int(panel_index)
    if idx <= 0:
        idx = 1
    if idx > num:
        idx = 1
    EditorDB.upsert_panel_narration(project_id, int(page_number), idx, text)
    # Cleanup any legacy rows without images
    try:
        EditorDB.conn().execute(
            "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
            (project_id, int(page_number)),
        )
        EditorDB.conn().commit()
    except Exception:
        pass
    return {"ok": True, "page_number": int(page_number), "panel_index": idx, "text": text}


@router.put("/api/project/{project_id}/panel/{page_number}/{panel_index}/audio")
async def api_update_panel_audio(project_id: str, page_number: int, panel_index: int, payload: Dict[str, Any]):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    # Accept either a data URL/base64 string or a URL to uploads
    audio_b64_legacy = str(payload.get("audioB64") or "").strip()
    audio_url = str(payload.get("audioUrl") or "").strip()
    if not audio_b64_legacy and not audio_url:
        raise HTTPException(status_code=400, detail="audioB64 or audioUrl is required")
    # Clamp panel index
    num = len(panels)
    idx = int(panel_index)
    if idx <= 0:
        idx = 1
    if idx > num:
        idx = 1
    # Store whichever string we have; consumer can interpret
    val = audio_url or audio_b64_legacy
    EditorDB.set_panel_audio(project_id, int(page_number), idx, val)
    try:
        EditorDB.conn().execute(
            "DELETE FROM panels WHERE project_id=? AND page_number=? AND (image_path IS NULL OR image_path='')",
            (project_id, int(page_number)),
        )
        EditorDB.conn().commit()
    except Exception:
        pass
    return {"ok": True, "page_number": int(page_number), "panel_index": idx}


@router.put("/api/project/{project_id}/panel/{page_number}/{panel_index}/config")
async def api_update_panel_config(project_id: str, page_number: int, panel_index: int, payload: Dict[str, Any]):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    eff = str(payload.get("effect") or "").strip() or "none"
    trans = str(payload.get("transition") or "").strip() or "slide_book"
    # Clamp panel index
    num = len(panels)
    idx = int(panel_index)
    if idx <= 0:
        idx = 1
    if idx > num:
        idx = 1
    EditorDB.set_panel_config(project_id, int(page_number), idx, eff, trans)
    return {"ok": True, "page_number": int(page_number), "panel_index": idx, "effect": eff, "transition": trans}


@router.put("/api/project/{project_id}/page/{page_number}/config")
async def api_update_page_config(project_id: str, page_number: int, payload: Dict[str, Any]):
    """Apply effect/transition to all panels on a page."""
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    eff = str(payload.get("effect") or "").strip() or "none"
    trans = str(payload.get("transition") or "").strip() or "slide_book"
    for p in panels:
        idx = int(p.get("index") or 1)
        EditorDB.set_panel_config(project_id, int(page_number), idx, eff, trans)
    return {"ok": True, "page_number": int(page_number), "count": len(panels), "effect": eff, "transition": trans}


# ---------------------------- TTS synthesis (DB-backed) ----------------------------
@router.post("/api/project/{project_id}/tts/synthesize/page/{page_number}")
async def api_tts_synthesize_page(project_id: str, page_number: int):
    """Synthesize TTS for all panels on a page using narration_text stored in DB.
    Saves audio files under /manga_projects/{project_id}/tts and updates panel audio URLs in DB.
    Returns per-panel results so the UI can update progress without sending text.
    """
    if not TTS_API_URL:
        raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")

    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")

    # Ensure output directory exists
    project_dir = os.path.join(MANGA_DIR, project_id)
    out_dir = os.path.join(project_dir, "tts")
    os.makedirs(out_dir, exist_ok=True)

    created = 0
    results: List[Dict[str, Any]] = []

    for p in panels:
        try:
            idx = int(p.get("index") or 1)
        except Exception:
            idx = 1
        text = str(p.get("text") or "").strip()
        if not text:
            # Nothing to synthesize; keep existing audio if any
            results.append({
                "panel_index": idx,
                "text": "",
                "audio_url": None,
                "status": "skipped"
            })
            continue

        try:
            payload = {
                "text": text,
                "exaggeration": "0.5",
                "cfg_weight": "0.5",
                "temperature": "0.8",
            }
            r = requests.post(TTS_API_URL, data=payload, timeout=60)
            if r.status_code != 200:
                results.append({
                    "panel_index": idx,
                    "text": text,
                    "audio_url": None,
                    "status": f"error:{r.status_code}"
                })
                continue

            # Save audio
            fname = f"tts_page_{int(page_number)}_panel_{idx}.wav"
            abs_path = os.path.join(out_dir, fname)
            with open(abs_path, "wb") as wf:
                wf.write(r.content)
            url = f"/manga_projects/{project_id}/tts/{fname}"

            # Persist to DB (store URL string in audio_b64 column)
            EditorDB.set_panel_audio(project_id, int(page_number), idx, url)

            created += 1
            results.append({
                "panel_index": idx,
                "text": text,
                "audio_url": url,
                "status": "ok"
            })
        except Exception as e:
            logger.exception("TTS failed for page %s panel %s", page_number, idx)
            results.append({
                "panel_index": idx,
                "text": text,
                "audio_url": None,
                "status": f"exception:{e}"
            })

    return {
        "ok": True,
        "page_number": int(page_number),
        "created": int(created),
        "panels": results,
    }


@router.post("/api/project/{project_id}/tts/synthesize/all")
async def api_tts_synthesize_all(project_id: str):
    """Synthesize TTS for all pages in the project sequentially. Returns a summary.
    Note: The UI can also call the page endpoint in a loop to show per-page progress.
    """
    if not TTS_API_URL:
        raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")

    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    pages = EditorDB.get_pages(project_id)
    if not pages:
        raise HTTPException(status_code=400, detail="Project has no pages")

    total_created = 0
    page_summaries: List[Dict[str, Any]] = []
    for pg in pages:
        pn = int(pg.get("page_number") or 0)
        try:
            res = await api_tts_synthesize_page(project_id, pn)  # reuse logic
            total_created += int(res.get("created", 0))
            page_summaries.append({"page_number": pn, **res})
        except HTTPException as e:
            page_summaries.append({"page_number": pn, "ok": False, "error": e.detail})
        except Exception as e:
            page_summaries.append({"page_number": pn, "ok": False, "error": str(e)})

    return {"ok": True, "total_created": int(total_created), "pages": page_summaries}


@router.post("/api/project/{project_id}/tts/backfill")
async def api_tts_backfill_urls(project_id: str):
    """Backfill audio URL entries in DB from files on disk under /manga_projects/{project_id}/tts.
    It scans tts_page_{page}_panel_{idx}.wav and writes the corresponding URL to panels.audio_b64.
    """
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = os.path.join(MANGA_DIR, project_id)
    tts_dir = os.path.join(project_dir, "tts")
    if not os.path.isdir(tts_dir):
        return {"ok": True, "updated": 0, "found": 0, "message": "No tts directory"}

    import re
    updated = 0
    found = 0
    for name in os.listdir(tts_dir):
        if not name.lower().endswith('.wav'):
            continue
        m = re.match(r"tts_page_(\d+)_panel_(\d+)\.wav$", name)
        if not m:
            continue
        found += 1
        page_number = int(m.group(1))
        panel_index = int(m.group(2))
        url = f"/manga_projects/{project_id}/tts/{name}"
        try:
            EditorDB.set_panel_audio(project_id, page_number, panel_index, url)
            updated += 1
        except Exception:
            logger.exception("Backfill failed for %s", name)
            continue

    return {"ok": True, "updated": updated, "found": found}

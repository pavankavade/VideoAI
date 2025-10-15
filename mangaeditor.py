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
        # Manga series table - groups chapters together
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS manga_series (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                mangadex_id TEXT,
                description TEXT,
                author TEXT,
                status TEXT,
                cover_url TEXT,
                mangadex_url TEXT
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
                story_summary TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                manga_series_id TEXT,
                chapter_number REAL,
                mangadex_chapter_id TEXT,
                mangadex_chapter_url TEXT,
                chapter_pages_count INTEGER DEFAULT 0,
                has_images INTEGER DEFAULT 0,
                FOREIGN KEY (manga_series_id) REFERENCES manga_series(id) ON DELETE SET NULL
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
        # Add story_summary column to project_details if missing
        try:
            cols = {row[1] for row in c.execute("PRAGMA table_info(project_details)").fetchall()}
            if "story_summary" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN story_summary TEXT NOT NULL DEFAULT ''")
            if "story_summary_current" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN story_summary_current TEXT NOT NULL DEFAULT ''")
            if "story_summary_previous" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN story_summary_previous TEXT NOT NULL DEFAULT ''")
            if "manga_series_id" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN manga_series_id TEXT")
            if "chapter_number" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN chapter_number INTEGER")
            # Add MangaDex import columns
            if "mangadex_chapter_id" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN mangadex_chapter_id TEXT")
            if "mangadex_chapter_url" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN mangadex_chapter_url TEXT")
            if "chapter_pages_count" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN chapter_pages_count INTEGER DEFAULT 0")
            if "has_images" not in cols:
                c.execute("ALTER TABLE project_details ADD COLUMN has_images INTEGER DEFAULT 0")
        except Exception:
            pass
        
        # Add MangaDex columns to manga_series if missing
        try:
            cols = {row[1] for row in c.execute("PRAGMA table_info(manga_series)").fetchall()}
            if "mangadex_id" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN mangadex_id TEXT")
            if "description" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN description TEXT")
            if "author" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN author TEXT")
            if "status" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN status TEXT")
            if "cover_url" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN cover_url TEXT")
            if "mangadex_url" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN mangadex_url TEXT")
        except Exception:
            pass
        
        cls._conn.commit()

    @classmethod
    def save_project_layers(cls, project_id: str, layers_data: List[Dict[str, Any]]) -> None:
        now = datetime.utcnow().isoformat()
        conn = cls.conn()
        
        # Get current metadata or initialize it
        row = conn.execute("SELECT metadata_json FROM project_details WHERE id=?", (project_id,)).fetchone()
        if row:
            try:
                metadata = json.loads(row[0] or '{}')
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        else:
            # This case should ideally not happen if project exists, but handle defensively
            metadata = {}
            
        metadata['layers'] = layers_data
        metadata['layers_updated_at'] = now
        
        conn.execute(
            "UPDATE project_details SET metadata_json=? WHERE id=?",
            (json.dumps(metadata), project_id)
        )
        conn.commit()

    # -------- Projects CRUD --------
    @classmethod
    def create_project(
        cls,
        title: str = None,
        files: List[str] = None,
        project_id: str = None,
        name: str = None,
        manga_series_id: Optional[str] = None,
        chapter_number: Optional[float] = None,  # Changed to float to support sub-chapters
        mangadex_chapter_id: Optional[str] = None,
        mangadex_chapter_url: Optional[str] = None,
        chapter_pages_count: int = 0,
        has_images: int = 0,
    ) -> Dict[str, Any]:
        # Support both old and new signatures
        if title and not name:
            name = title
        if not project_id:
            project_id = str(int(datetime.utcnow().timestamp() * 1000))
        
        now = datetime.utcnow().isoformat()
        conn = cls.conn()
        
        # Process files if provided
        pages = []
        if files:
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
                (project_id, name or title, now),
            )
        except Exception:
            pass
        
        conn.execute(
            """INSERT INTO project_details(
                id, title, created_at, pages_json, character_markdown, metadata_json,
                manga_series_id, chapter_number, mangadex_chapter_id, mangadex_chapter_url, chapter_pages_count, has_images
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                project_id,
                name or title,
                now,
                json.dumps(pages),
                "",
                json.dumps({}),
                manga_series_id,
                chapter_number,
                mangadex_chapter_id,
                mangadex_chapter_url,
                chapter_pages_count,
                has_images,
            ),
        )
        conn.commit()
        return {"id": project_id, "title": name or title, "created_at": now, "chapters": len(files) if files else 0}

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
        row = cls.conn().execute("SELECT id, title, created_at, pages_json, metadata_json FROM project_details WHERE id=?", (project_id,)).fetchone()
        if not row:
            return None

        try:
            pages_data = json.loads(row["pages_json"] or "[]")
        except (json.JSONDecodeError, TypeError):
            pages_data = []

        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except (json.JSONDecodeError, TypeError):
            metadata = {}

        # To provide the full details the video editor needs, we must also fetch the panels for each page.
        full_pages = []
        for page_info in pages_data:
            page_number = page_info.get("page_number")
            if page_number is not None:
                panels = cls.get_panels_for_page(project_id, page_number)
                # The frontend JS expects `image_path` and `audio_path` for panels
                enriched_panels = []
                for p in panels:
                    enriched_panels.append({
                        "index": p.get("index"),
                        "image_path": p.get("image"),
                        "text": p.get("text"),
                        "audio_path": p.get("audio"),
                        "effect": p.get("effect"),
                        "transition": p.get("transition"),
                    })
                page_info["panels"] = enriched_panels
            full_pages.append(page_info)

        return {
            "id": row["id"],
            "title": row["title"],
            "createdAt": row["created_at"],
            "pages": full_pages,
            "metadata": metadata, # Pass the layers and other metadata
        }

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
    def set_story_summary(cls, project_id: str, summary: str) -> None:
        conn = cls.conn()
        conn.execute("UPDATE project_details SET story_summary=? WHERE id=?", (summary, project_id))
        conn.commit()

    @classmethod
    def get_story_summary(cls, project_id: str) -> str:
        row = cls.conn().execute(
            "SELECT story_summary FROM project_details WHERE id=?",
            (project_id,),
        ).fetchone()
        return row[0] if row else ""

    @classmethod
    def set_story_summary_current(cls, project_id: str, summary: str) -> None:
        """Set the current chapter's summary."""
        conn = cls.conn()
        conn.execute("UPDATE project_details SET story_summary_current=? WHERE id=?", (summary, project_id))
        conn.commit()

    @classmethod
    def get_story_summary_current(cls, project_id: str) -> str:
        """Get the current chapter's summary."""
        row = cls.conn().execute(
            "SELECT story_summary_current FROM project_details WHERE id=?",
            (project_id,),
        ).fetchone()
        return row[0] if row else ""

    @classmethod
    def set_story_summary_previous(cls, project_id: str, summary: str) -> None:
        """Set the accumulated summary from previous chapters."""
        conn = cls.conn()
        conn.execute("UPDATE project_details SET story_summary_previous=? WHERE id=?", (summary, project_id))
        conn.commit()

    @classmethod
    def get_story_summary_previous(cls, project_id: str) -> str:
        """Get the accumulated summary from previous chapters."""
        row = cls.conn().execute(
            "SELECT story_summary_previous FROM project_details WHERE id=?",
            (project_id,),
        ).fetchone()
        return row[0] if row else ""

    @classmethod
    def fetch_and_save_previous_summaries(cls, project_id: str) -> Dict[str, Any]:
        """Fetch all previous chapters' current summaries and save as previous summary for this chapter."""
        conn = cls.conn()
        
        # Check if this project belongs to a series
        row = conn.execute(
            "SELECT manga_series_id, chapter_number FROM project_details WHERE id=?",
            (project_id,)
        ).fetchone()
        
        if not row or not row[0]:
            return {"ok": False, "message": "Project is not part of a manga series"}
        
        series_id = row[0]
        current_chapter = row[1]
        
        if not current_chapter or current_chapter <= 1:
            return {"ok": False, "message": "This is the first chapter, no previous chapters to fetch"}
        
        # Get all previous chapters' current summaries
        chapters = cls.get_chapters_for_series(series_id)
        previous_summaries = []
        
        for ch in chapters:
            if ch["chapter_number"] < current_chapter:
                ch_id = ch["id"]
                current_summary = cls.get_story_summary_current(ch_id)
                if current_summary:
                    previous_summaries.append(f"=== Chapter {ch['chapter_number']}: {ch['title']} ===\n{current_summary}")
        
        if not previous_summaries:
            return {"ok": False, "message": "No previous chapter summaries found"}
        
        # Combine all previous summaries
        combined = "\n\n".join(previous_summaries)
        
        # Save to this chapter's previous summary field
        cls.set_story_summary_previous(project_id, combined)
        
        return {
            "ok": True,
            "message": f"Fetched summaries from {len(previous_summaries)} previous chapter(s)",
            "chapters_count": len(previous_summaries),
            "summary": combined
        }

    # -------- Manga Series Management --------
    @classmethod
    def create_manga_series(cls, name: str) -> Dict[str, Any]:
        """Create a new manga series."""
        series_id = str(int(datetime.utcnow().timestamp() * 1000))
        now = datetime.utcnow().isoformat()
        conn = cls.conn()
        conn.execute(
            "INSERT INTO manga_series(id, name, created_at, updated_at) VALUES(?,?,?,?)",
            (series_id, name, now, now),
        )
        conn.commit()
        return {"id": series_id, "name": name, "created_at": now, "updated_at": now}

    @classmethod
    def add_manga_series(
        cls,
        series_id: str,
        name: str,
        mangadex_id: Optional[str] = None,
        description: Optional[str] = None,
        author: Optional[str] = None,
        status: Optional[str] = None,
        cover_url: Optional[str] = None,
        mangadex_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Add a manga series with optional MangaDex metadata."""
        now = datetime.utcnow().isoformat()
        conn = cls.conn()
        conn.execute(
            """INSERT INTO manga_series(id, name, created_at, updated_at, mangadex_id, description, author, status, cover_url, mangadex_url) 
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (series_id, name, now, now, mangadex_id, description, author, status, cover_url, mangadex_url),
        )
        conn.commit()
        return {
            "id": series_id,
            "name": name,
            "created_at": now,
            "updated_at": now,
            "mangadex_id": mangadex_id,
            "description": description,
            "author": author,
            "status": status,
            "cover_url": cover_url,
            "mangadex_url": mangadex_url,
        }

    @classmethod
    def get_manga_series(cls, series_id: str) -> Optional[Dict[str, Any]]:
        """Get manga series details with all its chapters."""
        row = cls.conn().execute(
            "SELECT id, name, created_at, updated_at FROM manga_series WHERE id=?",
            (series_id,),
        ).fetchone()
        if not row:
            return None
        
        # Get all chapters for this series
        chapters = cls.conn().execute(
            "SELECT id, title, chapter_number, created_at, mangadex_chapter_id, mangadex_chapter_url, chapter_pages_count, has_images FROM project_details WHERE manga_series_id=? ORDER BY chapter_number ASC",
            (series_id,),
        ).fetchall()
        
        chapters_list = []
        for ch in chapters:
            chapters_list.append({
                "id": ch[0],
                "title": ch[1],
                "chapter_number": ch[2],
                "created_at": ch[3],
                "mangadex_chapter_id": ch[4],
                "mangadex_chapter_url": ch[5],
                "chapter_pages_count": ch[6],
                "has_images": ch[7] or False,
            })
        
        return {
            "id": row[0],
            "name": row[1],
            "created_at": row[2],
            "updated_at": row[3],
            "chapters": chapters_list,
        }

    @classmethod
    def list_manga_series(cls) -> List[Dict[str, Any]]:
        """List all manga series with their chapter counts."""
        rows = cls.conn().execute(
            "SELECT id, name, created_at, updated_at FROM manga_series ORDER BY updated_at DESC"
        ).fetchall()
        
        result = []
        for r in rows:
            series_id = r[0]
            # Count chapters
            count_row = cls.conn().execute(
                "SELECT COUNT(*) FROM project_details WHERE manga_series_id=?",
                (series_id,),
            ).fetchone()
            chapter_count = count_row[0] if count_row else 0
            
            result.append({
                "id": series_id,
                "name": r[1],
                "created_at": r[2],
                "updated_at": r[3],
                "chapter_count": chapter_count,
            })
        
        return result

    @classmethod
    def get_chapters_for_series(cls, series_id: str) -> List[Dict[str, Any]]:
        """Get all chapters for a manga series, ordered by chapter number."""
        rows = cls.conn().execute(
            "SELECT id, title, chapter_number, created_at, pages_json, mangadex_chapter_id, mangadex_chapter_url, chapter_pages_count, has_images FROM project_details WHERE manga_series_id=? ORDER BY chapter_number ASC",
            (series_id,),
        ).fetchall()
        
        chapters = []
        for r in rows:
            try:
                pages = json.loads(r[4] or "[]")
                page_count = len(pages)
            except Exception:
                page_count = 0
            
            chapters.append({
                "id": r[0],
                "title": r[1],
                "chapter_number": r[2],
                "created_at": r[3],
                "page_count": page_count,
                "mangadex_chapter_id": r[5],
                "mangadex_chapter_url": r[6],
                "chapter_pages_count": r[7],
                "has_images": r[8] or False,
            })
        
        return chapters

    @classmethod
    def add_chapter_to_series(cls, series_id: str, chapter_number: int, title: str, files: List[str]) -> Dict[str, Any]:
        """Add a new chapter to a manga series."""
        # Verify series exists
        series = cls.get_manga_series(series_id)
        if not series:
            raise ValueError(f"Series {series_id} not found")
        
        # Create the chapter (project)
        chapter_id = str(int(datetime.utcnow().timestamp() * 1000))
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
            base = os.path.basename(p)
            return f"/uploads/{base}"
        
        pages = [{"page_number": i, "image_path": _norm(path)} for i, path in enumerate(files, start=1)]
        
        # Get accumulated context from previous chapters
        previous_chapters = cls.get_chapters_for_series(series_id)
        prev_chars = ""
        prev_summary = ""
        
        if previous_chapters:
            # Get the most recent chapter's character list and summary
            for ch in reversed(previous_chapters):
                if ch["chapter_number"] < chapter_number:
                    prev_ch_id = ch["id"]
                    prev_chars = cls.get_character_list(prev_ch_id)
                    prev_summary = cls.get_story_summary(prev_ch_id)
                    break
        
        # Backfill legacy 'projects' table
        try:
            conn.execute(
                "INSERT OR IGNORE INTO projects(id, title, created_at) VALUES(?,?,?)",
                (chapter_id, title, now),
            )
        except Exception:
            pass
        
        conn.execute(
            "INSERT INTO project_details(id, title, created_at, pages_json, character_markdown, story_summary, metadata_json, manga_series_id, chapter_number) VALUES(?,?,?,?,?,?,?,?,?)",
            (chapter_id, title, now, json.dumps(pages), prev_chars, prev_summary, json.dumps({}), series_id, chapter_number),
        )
        
        # Update series updated_at
        conn.execute(
            "UPDATE manga_series SET updated_at=? WHERE id=?",
            (now, series_id),
        )
        
        conn.commit()
        
        return {
            "id": chapter_id,
            "title": title,
            "chapter_number": chapter_number,
            "created_at": now,
            "manga_series_id": series_id,
            "inherited_characters": bool(prev_chars),
            "inherited_summary": bool(prev_summary),
        }

    @classmethod
    def update_chapter_series_info(cls, project_id: str, series_id: Optional[str], chapter_number: Optional[int]) -> None:
        """Update an existing project to belong to a series."""
        conn = cls.conn()
        now = datetime.utcnow().isoformat()
        
        conn.execute(
            "UPDATE project_details SET manga_series_id=?, chapter_number=? WHERE id=?",
            (series_id, chapter_number, project_id),
        )
        
        if series_id:
            conn.execute(
                "UPDATE manga_series SET updated_at=? WHERE id=?",
                (now, series_id),
            )
        
        conn.commit()

    @classmethod
    def get_previous_chapters_context(cls, series_id: str, current_chapter: int) -> Tuple[str, str]:
        """Get accumulated character list and story summary from all previous chapters."""
        chapters = cls.get_chapters_for_series(series_id)
        
        all_chars = []
        all_summaries = []
        
        for ch in chapters:
            if ch["chapter_number"] < current_chapter:
                ch_id = ch["id"]
                chars = cls.get_character_list(ch_id)
                summary = cls.get_story_summary(ch_id)
                
                if chars:
                    all_chars.append(f"# Chapter {ch['chapter_number']}: {ch['title']}\n{chars}")
                if summary:
                    all_summaries.append(f"Chapter {ch['chapter_number']}: {summary}")
        
        combined_chars = "\n\n".join(all_chars) if all_chars else ""
        combined_summary = "\n\n".join(all_summaries) if all_summaries else ""
        
        return combined_chars, combined_summary

    @classmethod
    def delete_manga_series(cls, series_id: str, delete_chapters: bool = False) -> Dict[str, Any]:
        """Delete a manga series and optionally delete all its chapters.
        
        Args:
            series_id: The ID of the series to delete
            delete_chapters: If True, delete all chapters. If False, unlink them (make standalone)
            
        Returns:
            Dict with deletion results
        """
        conn = cls.conn()
        
        # Get chapters before deletion
        chapters = cls.get_chapters_for_series(series_id)
        
        if delete_chapters:
            # Delete all chapters completely
            for ch in chapters:
                try:
                    # Delete from panels table
                    conn.execute("DELETE FROM panels WHERE project_id=?", (ch["id"],))
                    # Delete from pages table
                    conn.execute("DELETE FROM pages WHERE project_id=?", (ch["id"],))
                    # Delete from project_details
                    conn.execute("DELETE FROM project_details WHERE id=?", (ch["id"],))
                    # Delete from projects (legacy)
                    conn.execute("DELETE FROM projects WHERE id=?", (ch["id"],))
                except Exception as e:
                    print(f"Error deleting chapter {ch['id']}: {e}")
        else:
            # Just unlink chapters from the series (make them standalone)
            for ch in chapters:
                conn.execute(
                    "UPDATE project_details SET manga_series_id=NULL, chapter_number=NULL WHERE id=?",
                    (ch["id"],)
                )
        
        # Delete the series itself
        conn.execute("DELETE FROM manga_series WHERE id=?", (series_id,))
        conn.commit()
        
        return {
            "ok": True,
            "deleted_series_id": series_id,
            "chapters_deleted": delete_chapters,
            "chapters_count": len(chapters),
        }

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
    story_summary = EditorDB.get_story_summary(project_id)
    narrs = EditorDB.get_panel_narrations(project_id)
    return {
        "project": {"id": project_id, "title": project.get("title", "Untitled")},
        "pages": pages,
        "allPanelsReady": bool(all_have_panels),
        "characterList": char_md,
        "storySummary": story_summary,
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

    # Check if this project belongs to a manga series
    # Get previous chapters' context if available
    conn = EditorDB.conn()
    row = conn.execute(
        "SELECT manga_series_id, chapter_number FROM project_details WHERE id=?",
        (project_id,)
    ).fetchone()
    
    previous_context = ""
    if row and row[0]:  # Has a manga_series_id
        series_id = row[0]
        current_chapter = row[1]
        if current_chapter and current_chapter > 1:
            # Get accumulated context from all previous chapters
            prev_chars, prev_summary = EditorDB.get_previous_chapters_context(series_id, current_chapter)
            if prev_summary:
                previous_context = f"\n\n=== STORY SO FAR (From Previous Chapters) ===\n{prev_summary}\n\n=== CURRENT CHAPTER BEGINS ===\n"
            if prev_chars and not char_md:
                # Use accumulated character list from previous chapters if current one is empty
                char_md = prev_chars

    # Accumulated narrative context (plain text)
    accumulated_text = previous_context
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

    # Auto-generate story summary after all narrations are complete
    try:
        narr = EditorDB.get_panel_narrations(project_id)
        if narr:
            # Create a compact context, sorted by page/panel
            items = []
            for (pg, idx), text in sorted(narr.items(), key=lambda x: (x[0][0], x[0][1])):
                items.append(f"Page {pg} Panel {idx}: {text}")
            corpus = "\n".join(items)

            model = _gemini_client()
            if model is not None:
                prompt = (
                    "Based on the following manga panel narrations, generate a cohesive story summary. "
                    "The summary should capture the main plot points, character developments, and key events in a flowing narrative. "
                    "Write it as a concise 'Story So Far' that someone could read to understand what has happened in THIS chapter. "
                    "Keep it engaging and in past tense. Limit to 3-5 paragraphs.\n\n"
                    "Panel Narrations:\n" + corpus
                )
                try:
                    resp = model.generate_content(prompt)
                    summary = resp.text or ""
                    # Save to CURRENT summary field
                    EditorDB.set_story_summary_current(project_id, summary)
                    # Also update legacy field
                    EditorDB.set_story_summary(project_id, summary)
                except Exception:
                    # Don't fail the whole narration if story summary generation fails
                    pass
    except Exception:
        # Best effort; don't fail the narration if summary generation fails
        pass

    return {"ok": True, "results": results}


@router.post("/api/project/{project_id}/narrate/page/{page_number}")
async def api_narrate_single_page(project_id: str, page_number: int, payload: Dict[str, Any]):
    try:
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
        
        # Helper to extract text prompt for copying
        def extract_text_prompt(contents):
            """Extract the text portions of the prompt for user to copy"""
            try:
                if isinstance(contents, list) and len(contents) > 0:
                    parts = contents[0].get("parts", [])
                    text_parts = [p for p in parts if isinstance(p, str)]
                    return "\n".join(text_parts)
            except Exception:
                pass
            return "Could not extract prompt text"
        
        try:
            resp = model.generate_content(contents)
            
            # Check if the response was blocked
            if not resp.candidates:
                block_reason = "UNKNOWN"
                feedback_msg = "No additional information available"
                
                if hasattr(resp, 'prompt_feedback'):
                    feedback = resp.prompt_feedback
                    if hasattr(feedback, 'block_reason'):
                        block_reason = str(feedback.block_reason)
                    feedback_msg = f"Prompt feedback: {feedback}"
                
                logger.warning(f"Gemini blocked prompt for project {project_id}, page {page_number}. Reason: {block_reason}, Feedback: {feedback_msg}")
                
                # Return the prompt text so user can copy it
                prompt_text = extract_text_prompt(contents)
                
                raise HTTPException(
                    status_code=400, 
                    detail={
                        "error": "blocked",
                        "message": f"Content was blocked by Gemini safety filters. Block reason: {block_reason}. This may be due to inappropriate content in the images or context.",
                        "block_reason": block_reason,
                        "prompt": prompt_text,
                        "page_number": int(page_number)
                    }
                )
            
            txt = resp.text or ""
        except HTTPException:
            raise
        except ValueError as e:
            # Handle the specific ValueError from accessing .text when candidates are empty
            if "response.candidates" in str(e) or "blocked prompt" in str(e).lower():
                logger.warning(f"Gemini blocked prompt for project {project_id}, page {page_number}: {e}")
                prompt_text = extract_text_prompt(contents)
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": "blocked",
                        "message": "Content was blocked by Gemini safety filters. This may be due to inappropriate content in the images or context.",
                        "block_reason": "OTHER",
                        "prompt": prompt_text,
                        "page_number": int(page_number)
                    }
                )
            logger.error(f"Gemini API error for project {project_id}, page {page_number}: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Gemini error: {e}")
        except Exception as e:
            logger.error(f"Gemini API error for project {project_id}, page {page_number}: {e}", exc_info=True)
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
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error in api_narrate_single_page for project {project_id}, page {page_number}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.post("/api/project/{project_id}/narrate/page/{page_number}/manual")
async def api_save_manual_narration(project_id: str, page_number: int, payload: Dict[str, Any]):
    """Manually save narration for panels on a page (when AI generation is blocked or user wants manual control)"""
    try:
        project = EditorDB.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        panels_data = payload.get("panels", [])
        if not isinstance(panels_data, list):
            raise HTTPException(status_code=400, detail="panels must be an array")
        
        saved_panels = []
        for panel_item in panels_data:
            panel_index = panel_item.get("panel_index")
            text = panel_item.get("text", "").strip()
            
            if panel_index and text:
                EditorDB.upsert_panel_narration(project_id, int(page_number), int(panel_index), text)
                saved_panels.append({"panel_index": int(panel_index), "text": text})
        
        return {"ok": True, "page_number": int(page_number), "panels": saved_panels}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving manual narration for project {project_id}, page {page_number}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


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


# ---------------------------- Story Summary APIs ----------------------------
@router.get("/api/project/{project_id}/story")
async def api_get_story(project_id: str):
    """Get both current chapter summary and previous chapters summary."""
    current = EditorDB.get_story_summary_current(project_id)
    previous = EditorDB.get_story_summary_previous(project_id)
    # Legacy support: if no current/previous split, return from old field
    legacy = EditorDB.get_story_summary(project_id) if not current and not previous else ""
    
    return {
        "project_id": project_id,
        "summary": legacy,  # For backward compatibility
        "summary_current": current,
        "summary_previous": previous
    }


@router.put("/api/project/{project_id}/story")
async def api_set_story(project_id: str, payload: Dict[str, Any]):
    """Set the current chapter's summary."""
    summary = str(payload.get("summary") or "")
    # Save to current summary field
    EditorDB.set_story_summary_current(project_id, summary)
    # Also update legacy field for backward compatibility
    EditorDB.set_story_summary(project_id, summary)
    return {"ok": True}


@router.post("/api/project/{project_id}/story/generate")
async def api_generate_story_summary(project_id: str):
    """Generate a story summary for the CURRENT chapter from all panel narrations using Gemini AI."""
    if genai is None or not _GEMINI_KEYS:
        raise HTTPException(status_code=400, detail="Gemini not configured. Set GOOGLE_API_KEYS.")

    # Aggregate narrations
    narr = EditorDB.get_panel_narrations(project_id)
    if not narr:
        raise HTTPException(status_code=400, detail="No narrations found to generate story summary")
    
    # Create a compact context, sorted by page/panel
    items = []
    for (pg, idx), text in sorted(narr.items(), key=lambda x: (x[0][0], x[0][1])):
        items.append(f"Page {pg} Panel {idx}: {text}")
    corpus = "\n".join(items)

    model = _gemini_client()
    if model is None:
        raise HTTPException(status_code=500, detail="Failed to initialize Gemini client")

    prompt = (
        "Based on the following manga panel narrations, generate a cohesive story summary. "
        "The summary should capture the main plot points, character developments, and key events in a flowing narrative. "
        "Write it as a concise 'Story So Far' that someone could read to understand what has happened in THIS chapter. "
        "Keep it engaging and in past tense. Limit to 3-5 paragraphs.\n\n"
        "Panel Narrations:\n" + corpus
    )
    try:
        resp = model.generate_content(prompt)
        summary = resp.text or ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")

    # Save to CURRENT summary field
    EditorDB.set_story_summary_current(project_id, summary)
    # Also update legacy field for backward compatibility
    EditorDB.set_story_summary(project_id, summary)
    return {"ok": True, "summary": summary}


@router.post("/api/project/{project_id}/story/fetch-previous")
async def api_fetch_previous_summaries(project_id: str):
    """Fetch and concatenate all previous chapters' summaries into this chapter's 'Story So Far' section."""
    result = EditorDB.fetch_and_save_previous_summaries(project_id)
    
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message", "Failed to fetch previous summaries"))
    
    return result


# ---------------------------- Manga Series APIs ----------------------------
@router.post("/api/manga/series")
async def api_create_manga_series(payload: Dict[str, Any]):
    """Create a new manga series."""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Manga name is required")
    
    series = EditorDB.create_manga_series(name)
    return series


@router.get("/api/manga/series")
async def api_list_manga_series():
    """List all manga series with chapter counts."""
    series_list = EditorDB.list_manga_series()
    return {"series": series_list}


@router.get("/api/manga/series/{series_id}")
async def api_get_manga_series(series_id: str):
    """Get a manga series with all its chapters."""
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    return series


@router.post("/api/manga/series/{series_id}/chapters")
async def api_add_chapter_to_series(series_id: str, payload: Dict[str, Any]):
    """Add a new chapter to a manga series."""
    chapter_number = payload.get("chapter_number")
    if chapter_number is None:
        raise HTTPException(status_code=400, detail="chapter_number is required")
    
    title = str(payload.get("title") or f"Chapter {chapter_number}").strip()
    files = payload.get("files") or []
    
    if not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="files must be a non-empty array of image paths")
    
    try:
        chapter = EditorDB.add_chapter_to_series(series_id, int(chapter_number), title, files)
        return chapter
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create chapter: {e}")


@router.put("/api/manga/series/migrate/{project_id}")
async def api_migrate_project_to_series(project_id: str, payload: Dict[str, Any]):
    """Migrate an existing project to belong to a manga series."""
    series_id = str(payload.get("series_id") or "").strip()
    chapter_number = payload.get("chapter_number")
    
    if not series_id:
        raise HTTPException(status_code=400, detail="series_id is required")
    if chapter_number is None:
        raise HTTPException(status_code=400, detail="chapter_number is required")
    
    # Verify series exists
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    # Verify project exists
    project = EditorDB.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    EditorDB.update_chapter_series_info(project_id, series_id, int(chapter_number))
    
    return {"ok": True, "project_id": project_id, "series_id": series_id, "chapter_number": chapter_number}


@router.delete("/api/manga/series/{series_id}")
async def api_delete_manga_series(series_id: str, delete_chapters: bool = False):
    """Delete a manga series.
    
    Query params:
        delete_chapters: If true, delete all chapters. If false (default), unlink them.
    """
    # Verify series exists
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    try:
        result = EditorDB.delete_manga_series(series_id, delete_chapters)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete series: {e}")


@router.post("/api/manga/migrate-samurai")
async def api_migrate_samurai_projects():
    """Migrate existing Samurai projects into a proper manga series structure."""
    try:
        # Create "Samurai" series
        series = EditorDB.create_manga_series("Samurai")
        series_id = series["id"]
        
        # Find "Samurai" and "Samurai Chapter 2" projects
        conn = EditorDB.conn()
        projects = conn.execute(
            "SELECT id, title FROM project_details WHERE title LIKE '%Samurai%' ORDER BY created_at ASC"
        ).fetchall()
        
        migrated = []
        for idx, proj in enumerate(projects):
            proj_id = proj[0]
            title = proj[1]
            
            # Determine chapter number based on title
            chapter_num = idx + 1
            if "Chapter 2" in title or "chapter 2" in title:
                chapter_num = 2
            elif "Chapter" not in title and "chapter" not in title:
                chapter_num = 1
            
            # Migrate project
            EditorDB.update_chapter_series_info(proj_id, series_id, chapter_num)
            migrated.append({
                "project_id": proj_id,
                "title": title,
                "chapter_number": chapter_num
            })
        
        return {
            "ok": True,
            "series_id": series_id,
            "series_name": "Samurai",
            "migrated_projects": migrated
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")


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

@router.post("/api/upload-chapter-images")
async def upload_chapter_images(request: Request):
    """Upload images for a chapter manually"""
    try:
        from fastapi import UploadFile, File, Form
        
        form = await request.form()
        project_id = form.get("project_id")
        
        if not project_id:
            return JSONResponse(content={"error": "project_id is required"}, status_code=400)
        
        # Get the project to verify it exists
        project = EditorDB.get_project(project_id)
        if not project:
            return JSONResponse(content={"error": "Project not found"}, status_code=404)
        
        # Get uploaded files
        files = form.getlist("files")
        if not files:
            return JSONResponse(content={"error": "No files uploaded"}, status_code=400)
        
        # Create project directory
        project_dir = os.path.join(MANGA_DIR, project_id)
        os.makedirs(project_dir, exist_ok=True)
        
        # Save files
        saved_files = []
        for idx, file in enumerate(files, start=1):
            if not hasattr(file, 'filename'):
                continue
                
            # Get file extension
            ext = os.path.splitext(file.filename)[1] or '.jpg'
            filename = f"page_{idx:03d}{ext}"
            file_path = os.path.join(project_dir, filename)
            
            # Save file
            content = await file.read()
            with open(file_path, 'wb') as f:
                f.write(content)
            
            # Store relative path
            relative_path = f"/manga_projects/{project_id}/{filename}"
            saved_files.append(relative_path)
        
        if not saved_files:
            return JSONResponse(content={"error": "No valid image files uploaded"}, status_code=400)
        
        # Update project with uploaded images
        pages_json = [{"page_number": i, "image_path": path} for i, path in enumerate(saved_files, start=1)]
        
        conn = EditorDB.conn()
        conn.execute(
            "UPDATE project_details SET pages_json=?, has_images=1 WHERE id=?",
            (json.dumps(pages_json), project_id)
        )
        conn.commit()
        
        return JSONResponse(content={
            "success": True,
            "filesUploaded": len(saved_files),
            "projectId": project_id
        })
        
    except Exception as e:
        logger.error(f"Error uploading chapter images: {e}", exc_info=True)
        return JSONResponse(content={"error": str(e)}, status_code=500)

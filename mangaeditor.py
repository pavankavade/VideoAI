import os
import io
import re
import json
import sqlite3
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests
import httpx
from fastapi import APIRouter, HTTPException, Request, Body
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from PIL import Image
import logging

try:
    import google.generativeai as genai
except Exception:
    genai = None

try:
    from groq import Groq
except ImportError:
    Groq = None

try:
    from openai import AzureOpenAI
except ImportError as e:
    # Log the specific error to help debugging
    logging.warning(f"Failed to import AzureOpenAI: {e}")
    AzureOpenAI = None


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
                mangadex_url TEXT,
                character_markdown TEXT DEFAULT ''
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
                is_manual INTEGER DEFAULT 0,
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
                        is_manual INTEGER DEFAULT 0,
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
                for col in ["project_id","page_number","panel_index","image_path","narration_text","is_manual","created_at","updated_at"]:
                    if col in old_cols:
                        select_exprs.append(col)
                    else:
                        if col == "narration_text":
                            select_exprs.append("'' AS narration_text")
                        elif col == "is_manual":
                            select_exprs.append("0 AS is_manual")
                        elif col in ("created_at","updated_at"):
                            select_exprs.append("'' AS %s" % col)
                        else:
                            # Should not happen, but keep safe default
                            select_exprs.append("'' AS %s" % col)
                c.execute(
                    f"INSERT INTO panels(project_id,page_number,panel_index,image_path,narration_text,is_manual,created_at,updated_at) "
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
            if "is_manual" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN is_manual INTEGER DEFAULT 0")
            # New preferred column: audio_url (replace legacy audio_b64 usage)
            if "audio_url" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN audio_url TEXT")
            if "created_at" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
            if "updated_at" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
            # New visual settings
            if "effect" not in cols:
                # Change default to zoom_in so new panels get a zoom-in effect by default
                c.execute("ALTER TABLE panels ADD COLUMN effect TEXT NOT NULL DEFAULT 'zoom_in'")
            if "transition" not in cols:
                c.execute("ALTER TABLE panels ADD COLUMN transition TEXT NOT NULL DEFAULT 'slide_book'")
            # Ensure existing rows default to zoom_in if they were previously 'none' or empty
            try:
                c.execute("UPDATE panels SET effect='zoom_in' WHERE effect IS NULL OR effect='' OR lower(effect) IN ('none','no_effect')")
            except Exception:
                # Some older DBs may not have the effect column yet at this point; ignore
                pass
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
            # New config columns
            if "narration_provider" not in cols:
                # Default to 'gemini' for existing
                c.execute("ALTER TABLE project_details ADD COLUMN narration_provider TEXT DEFAULT 'gemini'")
            
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
            if "character_markdown" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN character_markdown TEXT DEFAULT ''")
            if "story_summary" not in cols:
                c.execute("ALTER TABLE manga_series ADD COLUMN story_summary TEXT DEFAULT ''")
        except Exception:
            pass
        
        cls._conn.commit()
        
        # Background fix: ensure any existing rows with missing/none effect are migrated to zoom_in
        try:
            c.execute("UPDATE panels SET effect='zoom_in' WHERE effect IS NULL OR effect='' OR lower(effect) IN ('none','no_effect')")
            cls._conn.commit()
        except Exception:
            pass

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
        narration_provider: str = "gemini", 
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
                manga_series_id, chapter_number, mangadex_chapter_id, mangadex_chapter_url, chapter_pages_count, has_images, narration_provider
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                narration_provider,
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
    def list_projects_brief(cls, limit: int = 100) -> List[Dict[str, Any]]:
        """Return a compact list of recent projects with a fast allPanelsReady check.

        The implementation uses two queries:
        - select recent projects with pages_json and minimal metadata
        - a single aggregated query to count distinct panel page_numbers per project
          so we can determine if every page has at least one panel without loading
          panel rows for each project.
        """
        conn = cls.conn()
        # Fetch recent projects
        rows = conn.execute(
            "SELECT id, title, created_at, pages_json, metadata_json, manga_series_id, has_images FROM project_details ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()

        if not rows:
            return []

        project_ids = [r[0] for r in rows]

        # Aggregate distinct panel page counts per project in one query
        placeholders = ",".join(["?" for _ in project_ids])
        agg_sql = f"SELECT project_id, COUNT(DISTINCT page_number) as distinct_pages FROM panels WHERE project_id IN ({placeholders}) AND image_path IS NOT NULL AND image_path!='' GROUP BY project_id"
        agg_rows = conn.execute(agg_sql, project_ids).fetchall() if project_ids else []
        distinct_map = {r[0]: int(r[1]) for r in agg_rows}

        out: List[Dict[str, Any]] = []
        for r in rows:
            pid = r[0]
            try:
                pages = json.loads(r[3] or "[]")
                page_count = len(pages)
            except Exception:
                page_count = 0

            distinct_pages = distinct_map.get(pid, 0)
            all_panels_ready = (page_count > 0) and (distinct_pages >= page_count)

            # Parse metadata JSON to expose manga_series_id when present
            try:
                metadata = json.loads(r[4] or "{}")
            except Exception:
                metadata = {}

            series_id = r[5] or metadata.get("manga_series_id") or None

            out.append({
                "id": pid,
                "title": r[1],
                "createdAt": r[2],
                "pageCount": int(page_count),
                "has_images": bool(r[6]),
                "allPanelsReady": bool(all_panels_ready),
                "manga_series_id": series_id,
            })

        return out

    @classmethod
    def get_project(cls, project_id: str) -> Optional[Dict[str, Any]]:
        row = cls.conn().execute(
            "SELECT id, title, created_at, pages_json, metadata_json, manga_series_id, narration_provider FROM project_details WHERE id=?", 
            (project_id,)
        ).fetchone()
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

        # Basic provider fallback if not in DB column (legacy rows)
        provider = "gemini"
        try:
             # Check if column exists in row (it should if migrated)
             if "narration_provider" in row.keys():
                 provider = row["narration_provider"] or "gemini"
        except Exception:
             pass

        # Add manga_series_id to the project data
        series_id = row["manga_series_id"] if len(row) > 5 else None

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
            "manga_series_id": series_id, # Add series ID directly
            "narration_provider": provider,
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
                "INSERT INTO panels(project_id, page_number, panel_index, image_path, narration_text, audio_url, created_at, updated_at, effect, transition) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (project_id, page_number, idx, p, "", None, now, now, "zoom_in", "slide_book"),
            )
        c.commit()

    @classmethod
    def set_project_provider(cls, project_id: str, provider: str) -> None:
        """Update the narration provider for a specific project/chapter."""
        try:
            cls.conn().execute(
                "UPDATE project_details SET narration_provider=? WHERE id=?",
                (provider, project_id)
            )
            cls.conn().commit()
        except Exception as e:
            # If column doesn't exist, it might fail silently or we should log it
            # But the schema init adds it, so it should be fine.
            pass

    @classmethod
    def get_panels_for_page(cls, project_id: str, page_number: int) -> List[Dict[str, Any]]:
        # Check if is_manual column exists (it should after migration)
        try:
            rows = cls.conn().execute(
                "SELECT panel_index, image_path, narration_text, audio_url, effect, transition, is_manual FROM panels WHERE project_id=? AND page_number=? ORDER BY panel_index ASC",
                (project_id, page_number),
            ).fetchall()
        except Exception:
            # Fallback if column missing (though migration should have run)
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
            eff = (r[4] if len(r) > 4 else None) or "zoom_in"
            trans = (r[5] if len(r) > 5 else None) or "slide_book"
            is_manual = bool(r[6]) if len(r) > 6 else False
            
            out.append({
                "index": int(display_idx),
                "image": img_path,
                "text": r[2] or "",
                "audio": r[3],
                "effect": eff,
                "transition": trans,
                "is_manual": is_manual,
            })
        return out

    @classmethod
    def all_pages_have_panels(cls, project_id: str) -> bool:
        """Return True if every page listed for the project has at least one panel recorded in the panels table.

        This is implemented with a small SQL query that counts distinct page_number entries in `panels`
        for the project and compares against the number of pages in the project's pages_json. This
        avoids loading full panel rows (and any heavy processing) when callers only need a yes/no
        about whether panels exist for all pages.
        """
        try:
            conn = cls.conn()
            row = conn.execute("SELECT pages_json FROM project_details WHERE id=?", (project_id,)).fetchone()
            if not row:
                return False
            try:
                pages = json.loads(row[0] or "[]")
            except Exception:
                pages = []
            page_count = len(pages)
            if page_count == 0:
                return False
            # Count distinct page_number values that have an image (skip empty/NULL image rows)
            r = conn.execute(
                "SELECT COUNT(DISTINCT page_number) FROM panels WHERE project_id=? AND image_path IS NOT NULL AND image_path!=''",
                (project_id,)
            ).fetchone()
            distinct_pages = int(r[0]) if r and r[0] is not None else 0
            return distinct_pages >= page_count
        except Exception:
            return False

    # FIX ATTEMPT 2 - Restoring get_panel_narrations

    @classmethod
    def get_panel_narrations(cls, project_id: str) -> Dict[Tuple[int, int], str]:
        rows = cls.conn().execute(
            "SELECT page_number, panel_index, narration_text FROM panels WHERE project_id=?",
            (project_id,),
        ).fetchall()
        return {(int(r[0]), int(r[1])): (r[2] or "") for r in rows}

    @classmethod
    def upsert_panel_narration(cls, project_id: str, page_number: int, panel_index: int, text: str, is_manual: bool = False) -> None:
        conn = cls.conn()
        # We only update existing panels because image_path is required for new ones
        # and panels should have been created by the panel detection step.
        conn.execute(
            "UPDATE panels SET narration_text=?, is_manual=?, updated_at=? WHERE project_id=? AND page_number=? AND panel_index=?",
            (text, 1 if is_manual else 0, datetime.now().isoformat(), project_id, page_number, panel_index)
        )
        conn.commit()

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
    def set_series_character_list(cls, series_id: str, markdown: str) -> None:
        """Set the character list for an entire manga series."""
        conn = cls.conn()
        conn.execute("UPDATE manga_series SET character_markdown=? WHERE id=?", (markdown, series_id))
        conn.commit()

    @classmethod
    def get_series_character_list(cls, series_id: str) -> str:
        """Get the character list for a manga series."""
        row = cls.conn().execute(
            "SELECT character_markdown FROM manga_series WHERE id=?",
            (series_id,),
        ).fetchone()
        return row[0] if row else ""

    @classmethod
    def propagate_character_list_to_chapters(cls, series_id: str, markdown: str) -> int:
        """Update character list for all chapters in a series.
        
        Returns:
            Number of chapters updated
        """
        conn = cls.conn()
        
        # Get all chapters in the series
        chapters = conn.execute(
            "SELECT id FROM project_details WHERE manga_series_id=?",
            (series_id,),
        ).fetchall()
        
        # Update each chapter
        for (chapter_id,) in chapters:
            conn.execute(
                "UPDATE project_details SET character_markdown=? WHERE id=?",
                (markdown, chapter_id),
            )
        
        conn.commit()
        return len(chapters)

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
    def add_chapter_to_series(cls, series_id: str, chapter_number: int, title: str, files: List[str], narration_provider: str = "gemini") -> Dict[str, Any]:
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
        
        # Get character list and summary - prioritize series-level
        series_chars = cls.get_series_character_list(series_id)
        prev_chars = series_chars if series_chars else ""
        prev_summary = ""
        
        # If no series-level character list, get from previous chapters
        if not prev_chars:
            previous_chapters = cls.get_chapters_for_series(series_id)
            
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
            "INSERT INTO project_details(id, title, created_at, pages_json, character_markdown, story_summary, metadata_json, manga_series_id, chapter_number, narration_provider) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (chapter_id, title, now, json.dumps(pages), prev_chars, prev_summary, json.dumps({}), series_id, chapter_number, narration_provider),
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
            "inherited_characters": bool(prev_chars),
            "inherited_summary": bool(prev_summary),
            "narration_provider": narration_provider,
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
                    logger.warning(f"Error deleting chapter {ch['id']}: {e}")
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
    def rename_manga_series(cls, series_id: str, new_name: str, propagate_chapters: bool = True) -> Dict[str, Any]:
        """Rename a manga series and optionally update chapter/project titles downstream.

        Behavior:
        - Update `manga_series.name` and `updated_at`.
        - If `propagate_chapters` is True, for each project_details row with matching
          `manga_series_id`, either replace occurrences of the old series name in the
          chapter title or prefix the chapter title with the new series name.
        Returns a dict with counts of updated chapters.
        """
        conn = cls.conn()
        # Get old name (if any)
        row = conn.execute("SELECT name FROM manga_series WHERE id=?", (series_id,)).fetchone()
        if not row:
            raise ValueError(f"Series {series_id} not found")
        old_name = row[0] or ""
        now = datetime.utcnow().isoformat()

        # Update series name
        conn.execute("UPDATE manga_series SET name=?, updated_at=? WHERE id=?", (new_name, now, series_id))

        chapters_updated = 0
        if propagate_chapters:
            # Fetch chapters tied to this series
            chapters = conn.execute(
                "SELECT id, title FROM project_details WHERE manga_series_id=?",
                (series_id,),
            ).fetchall()

            for ch in chapters:
                ch_id = ch[0]
                title = ch[1] or ""
                updated = title
                try:
                    if old_name and old_name in title:
                        updated = title.replace(old_name, new_name)
                    else:
                        # Don't double-prefix if already contains the new name
                        if new_name not in title:
                            updated = f"{new_name} — {title}" if title.strip() else new_name
                except Exception:
                    updated = f"{new_name} — {title}" if title.strip() else new_name

                if updated != title:
                    conn.execute("UPDATE project_details SET title=? WHERE id= ?", (updated, ch_id))
                    chapters_updated += 1

        conn.commit()
        return {"ok": True, "series_id": series_id, "new_name": new_name, "chapters_updated": chapters_updated}

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
        eff = (effect or "").strip() or "zoom_in"
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

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

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


async def _load_image_bytes(url_or_path: str) -> Optional[bytes]:
    try:
        if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.get(url_or_path)
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


def _validate_narration_length(data: Dict) -> bool:
    """Returns True if all panels adhere to length constraints (<= 500 chars)."""
    if not isinstance(data, dict): return False
    panels = data.get("panels", [])
    if not isinstance(panels, list): return False
    for p in panels:
        txt = p.get("text", "")
        # Ensure text is a string
        if not isinstance(txt, str):
            txt = str(txt)
        if len(txt) > 500:
             logger.warning(f"Validation failed: Panel text length {len(txt)} exceeds 500 chars.")
             return False
    return True


def _force_truncate(data: Dict) -> Dict:
    """Forcefully truncate panel text to 500 tokens (approx) if validation fails repeatedly."""
    if not isinstance(data, dict): return data
    panels = data.get("panels", [])
    if not isinstance(panels, list): return data
    
    new_panels = []
    for p in panels:
        txt = str(p.get("text", ""))
        if len(txt) > 500:
            # Try to cut at last sentence ending within first 500 chars
            truncated = txt[:500]
            last_punc = max(truncated.rfind('.'), truncated.rfind('!'), truncated.rfind('?'))
            if last_punc > 100: # Ensure we don't cut too short
                txt = truncated[:last_punc+1]
            else:
                # If no good punctuation found, just hard cut
                txt = truncated[:497] + "..."
            p["text"] = txt
        new_panels.append(p)
    
    data["panels"] = new_panels
    return data


def _build_page_prompt(page_number: int, panel_images: List[bytes], accumulated_context: str, user_characters: str) -> List[Any]:
    sys_instructions = (
        "You are a manga narration assistant. For the given page, write a cohesive, flowing micro‑narrative that spans the panels in order. "
        "Produce one vivid, short sentence per panel, but ensure each sentence connects naturally to the next so it reads like a continuous story, not a list. "
        "Avoid list formatting, numbering, or using the word 'panel'. Do not start every sentence with a proper name. "
        "Use character names sparingly—after the first clear mention, prefer pronouns and varied sentence openings unless a name is needed for clarity. "
        "After a character is introduced (full name allowed once if helpful), do NOT use their full name again; use only their first name (e.g., 'FirstName' not 'FirstName Lastname') or a pronoun. "
        "CRITICAL: Keep narration EXTREMELY CONCISE. Maximum 50 words (approx 300 characters) per panel. "
        "OUTPUT FORMAT: STRICT VALID JSON ONLY. No markdown. No formatting. "
        "Structure: {\"panels\": [{\"panel_index\": 1, \"text\": \"...\"}]}"
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



def _azure_client() -> Optional[Any]:
    if AzureOpenAI is None:
         logger.warning("AzureOpenAI class is None (import failed)")
         return None
    endpoint = os.environ.get("AzureOpenAI_Endpoint", "").strip()
    key = os.environ.get("AzureOpenAI_Key", "").strip()
    
    logger.info(f"Azure Config Check: Endpoint present={bool(endpoint)}, Key present={bool(key)}")
    if endpoint:
        logger.info(f"Azure Endpoint: {endpoint}")
    
    if not endpoint or not key:
         logger.warning("Azure Endpoint or Key is missing")
         return None
    return AzureOpenAI(
        api_version="2024-12-01-preview",
        azure_endpoint=endpoint,
        api_key=key,
    )

# ---------------------------- Groq Helpers ----------------------------

def _groq_client() -> Optional[Any]:
    if Groq is None:
        return None
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return None
    return Groq(api_key=api_key)


def _build_page_prompt_groq(page_number: int, panel_images: List[bytes], accumulated_context: str, user_characters: str, third_person: bool = False) -> List[Dict[str, Any]]:
    import base64
    
    style_instr = "NARRATION STYLE: THIRD-PERSON ONLY. Never use 'I', 'me', 'my', 'we'. Use character names or pronouns. " if third_person else ""
    num_panels = len(panel_images)
    
    sys_instructions = (
        f"You are a manga narration assistant. There are {num_panels} panels on this page. "
        "Write a cohesive, flowing micro‑narrative that spans the panels in order. "
        f"{style_instr}"
        "Produce one vivid, short sentence per panel. "
        "CRITICAL: Keep narration EXTREMELY CONCISE. Maximum 50 words (approx 300 characters) per panel. "
        "OUTPUT FORMAT: STRICT VALID JSON ONLY. No markdown. No formatting. "
        "Structure: {\"panels\": [{\"panel_index\": 1, \"text\": \"...\"}, ...]}"
    )
    
    user_prompt = "Generate narration for these panels."
    if accumulated_context:
        user_prompt += f"\n\nContext so far (previous pages):\n{accumulated_context}"
    if user_characters:
        user_prompt += f"\n\nKnown characters:\n{user_characters}"
        
    content_parts = [{"type": "text", "text": user_prompt}]
    
    # Add images as base64
    for img_bytes in panel_images:
        b64_str = base64.b64encode(img_bytes).decode('utf-8')
        content_parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/png;base64,{b64_str}"
            }
        })
        
    messages = [
        {"role": "system", "content": sys_instructions},
        {"role": "user", "content": content_parts}
    ]
    return messages


# ---------------------------- Routes ----------------------------
@router.get("/manga-editor/{project_id:path}", response_class=HTMLResponse)
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


@router.get("/tts", response_class=HTMLResponse)
async def tts_interface(request: Request):
    # TTS interface page
    return templates.TemplateResponse(
        "tts_interface.html",
        {"request": request, "tts_api_url": TTS_API_URL},
    )


@router.get("/api/project/{project_id:path}")
async def api_get_project_summary(project_id: str, brief: bool = False):
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
    
    # If brief mode is requested, avoid loading heavy fields like character lists, narrations,
    # and story summaries. Use a fast DB helper to determine if all pages have panels.
    series_id = project.get("manga_series_id")
    if not series_id:
        metadata = project.get("metadata") or {}
        series_id = metadata.get("manga_series_id")

    if brief:
        # Lightweight response used by dashboard/status checks
        panels_ready = EditorDB.all_pages_have_panels(project_id)
        return {
            "project": {"id": project_id, "title": project.get("title", "Untitled")},
            "pages": pages,
            "allPanelsReady": bool(panels_ready),
            "characterList": "",
            "storySummary": "",
            "seriesId": series_id,
        }

    # Full response (editor) - load character list and summaries
    # Get character list - prioritize series-level if available
    char_md = ""
    logger.debug(f"Loading character list for project {project_id}")
    logger.debug(f"Series ID: {series_id}")
    logger.debug(f"Series ID source: {'direct' if project.get('manga_series_id') else 'metadata' if series_id else 'none'}")

    if series_id:
        # If part of a series, prioritize series-level character list
        series_char_md = EditorDB.get_series_character_list(series_id)
        chapter_char_md = EditorDB.get_character_list(project_id)

        logger.debug(f"Series character list length: {len(series_char_md) if series_char_md else 0}")
        logger.debug(f"Chapter character list length: {len(chapter_char_md) if chapter_char_md else 0}")

        if series_char_md and series_char_md.strip():
            char_md = series_char_md
            logger.debug("Using series character list")
        else:
            # Fall back to chapter-level if no series character list
            char_md = chapter_char_md
            logger.debug("Using chapter character list (series empty)")
    else:
        # Not part of a series, use chapter-level
        char_md = EditorDB.get_character_list(project_id)
        logger.debug("Using chapter character list (no series)")

    story_summary = EditorDB.get_story_summary(project_id)
    narrs = EditorDB.get_panel_narrations(project_id)
    return {
        "project": {"id": project_id, "title": project.get("title", "Untitled")},
        "pages": pages,
        "allPanelsReady": bool(all_have_panels),
        "characterList": char_md,
        "storySummary": story_summary,
        "seriesId": series_id,
    }

@router.post("/api/migrate/effects/zoom-in")
async def api_migrate_effects_to_zoom_in():
    """Force-migrate all existing panels with effect none/empty to zoom_in."""
    try:
        c = EditorDB.conn()
        cur = c.execute("UPDATE panels SET effect='zoom_in' WHERE effect IS NULL OR effect='' OR lower(effect) IN ('none','no_effect')")
        c.commit()
        return {"ok": True, "updated": cur.rowcount}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")



@router.post("/api/project/{project_id:path}/settings/provider")
async def api_set_project_provider(project_id: str, payload: Dict[str, str]):
    provider = payload.get("provider", "gemini").lower()
    if provider not in ("gemini", "groq", "azure", "manual_web"):
        raise HTTPException(status_code=400, detail="Invalid provider")
        
    EditorDB.conn().execute(
        "UPDATE project_details SET narration_provider=? WHERE id=?",
        (provider, project_id)
    )
    EditorDB.conn().commit()
    return {"ok": True, "provider": provider}


@router.post("/api/project/{project_id:path}/panels/create")
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
        if img_path.startswith("/manga_projects/"):
            abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
        elif img_path.startswith("manga_projects/"):
            abs_path = os.path.join(BASE_DIR, img_path)
        elif img_path.startswith("/uploads/"):
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
            # Add retry logic for unreliable connections (ngrok, etc.)
            max_retries = 3
            retry_delay = 2
            r = None
            
            for attempt in range(max_retries):
                try:
                    with open(abs_path, "rb") as f:
                        files = {"file": (os.path.basename(abs_path), f, "image/png")}
                        params = {
                            "add_border": "true",
                            "border_width": 4,
                            "border_color": "black",
                            "curved_border": "true",
                            "corner_radius": 20,
                        }
                        logger.info(f"[panels/create] Posting page {pn} to PANEL_API_URL (attempt {attempt+1}/{max_retries}): {PANEL_API_URL}")
                        async with httpx.AsyncClient(timeout=600.0) as client:
                            r = await client.post(PANEL_API_URL, files=files, params=params)
                        break  # Success
                except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as e:
                    if attempt < max_retries - 1:
                        import asyncio
                        wait_time = retry_delay * (2 ** attempt)
                        logger.warning(f"[panels/create] Connection error for page {pn} on attempt {attempt+1}, retrying in {wait_time}s: {str(e)[:100]}")
                        await asyncio.sleep(wait_time)
                    else:
                        logger.error(f"[panels/create] All {max_retries} attempts failed for page {pn}")
                        continue  # Skip this page and continue with next
            
            if r is None:
                logger.warning(f"[panels/create] No response received for page {pn}, skipping")
                continue
                
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


@router.post("/api/project/{project_id:path}/panels/create/page/{page_number}")
async def api_create_panels_single_page(project_id: str, page_number: int):
    """Create panels for a single page, used for granular progress in the UI."""
    # Check local model first
    from panel_detection import model_manager
    if model_manager.model is not None:
        logger.info(f"[panels/create/page] Using local MagiV3 model for page {page_number}")
        try:
            project = EditorDB.get_project(project_id)
            if not project:
                raise HTTPException(status_code=404, detail="Project not found")
            pages = EditorDB.get_pages(project_id)
            pg = next((p for p in pages if int(p.get("page_number") or 0) == int(page_number)), None)
            if not pg:
                raise HTTPException(status_code=404, detail="Page not found")

            project_dir = os.path.join(MANGA_DIR, project_id)
            os.makedirs(project_dir, exist_ok=True)
            pn = int(pg["page_number"])
            img_path = pg["image_path"]
            
            # Resolve path (reusing logic)
            abs_path = img_path
            if img_path.startswith("/manga_projects/"):
                abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
            elif img_path.startswith("manga_projects/"):
                abs_path = os.path.join(BASE_DIR, img_path)
            elif img_path.startswith("/uploads/"):
                abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
            elif img_path.startswith("uploads/"):
                abs_path = os.path.join(BASE_DIR, img_path)
            elif not os.path.isabs(abs_path):
                abs_path = os.path.join(BASE_DIR, abs_path)
            if not os.path.exists(abs_path):
                fallback = os.path.join(UPLOADS_DIR, os.path.basename(img_path))
                if os.path.exists(fallback):
                    abs_path = fallback
            
            if not os.path.exists(abs_path):
                raise HTTPException(status_code=404, detail=f"File not found: {img_path}")

            # Run prediction
            image = Image.open(abs_path).convert("RGB")
            logger.info(f"[panels/create/page] Loaded source image from: {abs_path}")
            # Force load image data into memory so we can safely delete its directory if needed
            image.load()

            result = model_manager.predict(image)
            boxes = result["panels"] # list of [x1, y1, x2, y2]
            
            page_dir = os.path.join(project_dir, f"page_{pn:03d}")
            # Clean up existing directory to avoid ghost panels from renumbering
            if os.path.exists(page_dir):
                import shutil
                try:
                    logger.info(f"[panels/create/page] Cleaning up directory: {page_dir}")
                    shutil.rmtree(page_dir)
                except Exception as e:
                    logger.warning(f"Failed to clean page directory {page_dir}: {e}")

            os.makedirs(page_dir, exist_ok=True)
            panel_paths = []
            
            # Handle empty result
            if not boxes:
                w, h = image.size
                boxes = [[0, 0, w, h]]
                
            for idx, box in enumerate(boxes):
                x1, y1, x2, y2 = map(int, box)
                crop = image.crop((x1, y1, x2, y2))
                out_name = f"panel_{idx:03d}.png"
                out_abs = os.path.join(page_dir, out_name)
                crop.save(out_abs)
                rel = f"/manga_projects/{project_id}/page_{pn:03d}/{out_name}"
                panel_paths.append(rel)
                
            EditorDB.set_panels_for_page(project_id, pn, panel_paths)
            created = len(panel_paths)
            logging.info(f"[panels/create/page] Local model: Page {pn}: saved {created} panels")
            return {"ok": True, "page_number": pn, "created": created}
            
        except Exception as e:
            logger.error(f"Local model failed: {e}", exc_info=True)
            # Fall back to external API if local fails
            pass

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
    if img_path.startswith("/manga_projects/"):
        abs_path = os.path.join(BASE_DIR, img_path.lstrip("/"))
    elif img_path.startswith("manga_projects/"):
        abs_path = os.path.join(BASE_DIR, img_path)
    elif img_path.startswith("/uploads/"):
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
        # Add retry logic for unreliable connections (ngrok, etc.)
        max_retries = 3
        retry_delay = 2  # seconds
        last_exception = None
        r = None
        
        for attempt in range(max_retries):
            try:
                with open(abs_path, "rb") as f:
                    files = {"file": (os.path.basename(abs_path), f, "image/png")}
                    params = {
                        "add_border": "true",
                        "border_width": 4,
                        "border_color": "black",
                        "curved_border": "true",
                        "corner_radius": 20,
                    }
                    logger.info(f"[panels/create/page] Posting page {pn} to PANEL_API_URL (attempt {attempt+1}/{max_retries}): {PANEL_API_URL}")
                    async with httpx.AsyncClient(timeout=600.0) as client:
                        r = await client.post(PANEL_API_URL, files=files, params=params)
                    break  # Success, exit retry loop
            except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as e:
                last_exception = e
                if attempt < max_retries - 1:
                    import asyncio
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    logger.warning(f"[panels/create/page] Connection error on attempt {attempt+1}, retrying in {wait_time}s: {str(e)[:100]}")
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(f"[panels/create/page] All {max_retries} attempts failed for page {pn}")
                    raise HTTPException(status_code=502, detail=f"Failed to connect to panel API after {max_retries} attempts: {str(e)[:200]}")
        
        if r is None:
            raise HTTPException(status_code=502, detail="Failed to get response from panel API")
            
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


@router.post("/api/project/{project_id:path}/narrate/sequential")
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
            b = await _load_image_bytes(img_url)
            if b:
                imgs.append(b)

        if not imgs:
            # skip pages with no panels
            continue

        if not imgs:
            # skip pages with no panels
            continue

        # Determine provider
        provider_override = str(payload.get("narration_provider") or "").strip()
        if provider_override:
             EditorDB.set_project_provider(project_id, provider_override)
             provider = provider_override
             project["narration_provider"] = provider_override # Update local dict
        else:
             provider = str(project.get("narration_provider") or "gemini")
        
        # --- GROQ ---
        if provider == "groq":
            # Groq model restriction: max 5 images
            if len(imgs) > 5:
                logger.warning(f"Page {pg.get('page_number')} has {len(imgs)} panels. Groq limit 5. Truncating.")
                imgs = imgs[:5]
            
            client = _groq_client()
            if not client:
                logging.error("Groq client init failed")
                continue

            messages = _build_page_prompt_groq(pn, imgs, accumulated_text, char_md, third_person=True)
            data = None
            last_error = None
            
            for attempt in range(3):
                try:
                    completion = client.chat.completions.create(
                        model="meta-llama/llama-4-scout-17b-16e-instruct", # Using vision model
                        messages=messages,
                        temperature=0.7,
                        max_tokens=1024,
                        response_format={"type": "json_object"}
                    )
                    txt = completion.choices[0].message.content or ""
                    try:
                        extracted = json.loads(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long"
                                continue
                    except json.JSONDecodeError:
                        # try lenient extraction
                        extracted = _extract_json(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long"
                                continue
                except Exception as e:
                     logger.warning(f"Groq error page {pn} attempt {attempt}: {e}")
                     last_error = str(e)
            
            if not data:
                # If we're here, we failed
                 raise HTTPException(status_code=500, detail=f"Groq failed: {last_error}")

        # --- AZURE ---
        elif provider == "azure":
            if len(imgs) > 5:
                # Truncate
                imgs = imgs[:5]

            client = _azure_client()
            if not client:
                raise HTTPException(status_code=400, detail="Azure OpenAI keys not configured")

            messages = _build_page_prompt_groq(pn, imgs, accumulated_text, char_md)
            data = None
            # Azure Sequential Single Attempt
            try:
                # O1 Adaptation: Merge System -> User
                raw_msgs = messages
                msgs_to_send = []
                sys_c = ""
                for m in raw_msgs:
                     if m['role'] == 'system':
                         sys_c += m['content'] + "\n\n"
                     else:
                         if m['role'] == 'user' and sys_c:
                             if isinstance(m['content'], str):
                                 m['content'] = sys_c + m['content']
                             elif isinstance(m['content'], list):
                                 for part in m['content']:
                                     if part.get('type') == 'text':
                                         part['text'] = sys_c + part['text']
                                         break
                             sys_c = ""
                         msgs_to_send.append(m)

                # DEBUG: Log payload stats
                img_sizes = [len(b) for b in imgs]
                logger.info(f"Azure Sequential Payload: Page {pn}, {len(msgs_to_send)} messages. Images: {len(imgs)}, Sizes: {img_sizes}")

                completion = client.chat.completions.create(
                    model="gpt-5-nano",
                    messages=msgs_to_send,
                    max_completion_tokens=25000,
                    response_format = {"type": "json_object"}
                )
                # DEBUG LOGGING
                choice = completion.choices[0]
                logger.info(f"Azure Sequential Raw Output: finish_reason={choice.finish_reason}, content={choice.message.content}")

                txt = choice.message.content or ""
                extracted = None
                try:
                    extracted = json.loads(txt)
                except json.JSONDecodeError:
                    extracted = _extract_json(txt)
                
                if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                    if _validate_narration_length(extracted):
                        data = extracted
                    else:
                        logger.warning(f"Azure Sequential: Output too long. Truncating immediately.")
                        data = _force_truncate(extracted)
                else:
                    logger.error(f"Azure Sequential: Invalid JSON for page {pn}")
                    continue
            except Exception as e:
                logger.error(f"Global Narration Azure error page {pn}: {e}")
                continue

        # --- GEMINI ---
        else:
            if genai is None:
                 raise HTTPException(status_code=400, detail="Gemini lib not installed")
            
            contents = _build_page_prompt(pn, imgs, accumulated_text, char_md)
            model = _gemini_client()
            if not model:
                 raise HTTPException(status_code=500, detail="Gemini client init failed")
            
            data = None
            last_error = None

            for attempt in range(3):
                try:
                     resp = model.generate_content(contents)
                     txt = resp.text
                     try:
                        extracted = json.loads(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                             # VALIDATE LENGTH
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                logging.warning(f"Gemini page {pn} attempt {attempt}: {last_error}")
                                continue
                     except json.JSONDecodeError:
                        extracted = _extract_json(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                             # VALIDATE LENGTH
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                logging.warning(f"Gemini page {pn} attempt {attempt}: {last_error}")
                                continue
                except Exception as e:
                    logger.warning(f"Gemini error page {pn} attempt {attempt}: {e}")
                    last_error = str(e)
            
            if not data:
                raise HTTPException(status_code=500, detail=f"Gemini failed: {last_error}")

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
                    EditorDB.upsert_panel_narration(project_id, pn, i, combined, is_manual=False)
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
                EditorDB.upsert_panel_narration(project_id, pn, 1, combined, is_manual=False)
                page_out.append({"panel_index": 1, "text": combined})
            else:
                for idx1 in range(1, len(panels) + 1):
                    t = (segs[idx1 - 1] + ".") if (idx1 - 1) < len(segs) else ""
                    EditorDB.upsert_panel_narration(project_id, pn, idx1, t, is_manual=False)
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

    # Auto-update character list from narrations (best-effort)
    updated_character_list = ""
    try:
        narr = EditorDB.get_panel_narrations(project_id)
        logger.debug(f"Auto-update for project {project_id}: Found {len(narr) if narr else 0} narrations")

        if narr:
            # Create a compact context, sorted by page/panel
            items = []
            for (pg, idx), text in sorted(narr.items(), key=lambda x: (x[0][0], x[0][1])):
                items.append(f"Page {pg} Panel {idx}: {text}")
            corpus = "\n".join(items)

            model = _gemini_client()
            if model is not None:
                logger.debug(f"Generating character list from {len(items)} panels")
                # First, auto-update character list
                prompt = (
                    "Analyze the following manga panel narrations and create a comprehensive character list in Markdown format. "
                    "For each character mentioned, list their name and a brief description (role, traits, relationships). "
                    "Format as a bulleted list under '# Characters' heading. "
                    "Only include characters that actually appear or are mentioned in the narration.\n\n"
                    "Panel Narrations:\n" + corpus
                )
                
                # Check provider for auto-update
                proj_data = EditorDB.get_project(project_id)
                provider = proj_data.get("narration_provider", "gemini")
                
                char_markdown = ""
                summary = ""

                if provider == "groq":
                    client = _groq_client()
                    if client:
                         # Character List
                         try:
                             resp = client.chat.completions.create(
                                 model="llama3-8b-8192", # Fast text model
                                 messages=[{"role": "user", "content": prompt}],
                                 temperature=0.7
                             )
                             char_markdown = resp.choices[0].message.content or ""
                         except Exception: pass
                         
                         # Story Summary
                         try:
                             prompt_sum = (
                                "Based on the following manga panel narrations, generate a cohesive story summary. "
                                "The summary should capture the main plot points, character developments, and key events in a flowing narrative. "
                                "Write it as a concise 'Story So Far' that someone could read to understand what has happened in THIS chapter. "
                                "Keep it engaging and in past tense. Limit to 3-5 paragraphs.\n\n"
                                "Panel Narrations:\n" + corpus
                             )
                             resp = client.chat.completions.create(
                                 model="llama3-8b-8192",
                                 messages=[{"role": "user", "content": prompt_sum}],
                                 temperature=0.7
                             )
                             summary = resp.choices[0].message.content or ""
                         except Exception: pass
                
                elif model is not None: # Gemini
                    try:
                        resp = model.generate_content(prompt)
                        char_markdown = resp.text or ""
                    except Exception: pass
                    
                    try:
                        prompt_sum = (
                            "Based on the following manga panel narrations, generate a cohesive story summary. "
                            "The summary should capture the main plot points, character developments, and key events in a flowing narrative. "
                            "Write it as a concise 'Story So Far' that someone could read to understand what has happened in THIS chapter. "
                            "Keep it engaging and in past tense. Limit to 3-5 paragraphs.\n\n"
                            "Panel Narrations:\n" + corpus
                        )
                        resp = model.generate_content(prompt_sum)
                        summary = resp.text or ""
                    except Exception: pass

                if char_markdown:
                    try:
                        logger.debug(f"Generated character list length: {len(char_markdown)}")

                        # Save character list
                        EditorDB.set_character_list(project_id, char_markdown)
                        updated_character_list = char_markdown
                        logger.debug(f"Saved character list to chapter")

                        # If part of a series, propagate to all chapters
                        project = EditorDB.get_project(project_id)
                        series_id = None
                        if project:
                            metadata = project.get("metadata") or {}
                            series_id = metadata.get("manga_series_id") or project.get("manga_series_id")
                        
                        logger.debug(f"Series ID: {series_id}")
                        if series_id:
                            EditorDB.set_series_character_list(series_id, char_markdown)
                            chapters_updated = EditorDB.propagate_character_list_to_chapters(series_id, char_markdown)
                            logger.debug(f"Propagated character list to series and {chapters_updated} chapters")
                    except Exception as e:
                        logger.warning(f"Failed to auto-update character list: {e}")


                if summary:
                    logger.debug(f"Generated summary length: {len(summary)}")
                    # Save to CURRENT summary field
                    EditorDB.set_story_summary_current(project_id, summary)
                    # Also update legacy field
                    EditorDB.set_story_summary(project_id, summary)
                    logger.debug(f"Saved story summary")

            else:
                logger.debug("AI Provider client not available")
    except Exception as e:
        # Best effort; don't fail the narration if auto-updates fail
        logger.warning(f"Failed during auto-update process: {e}")

    return {"ok": True, "results": results, "characterListUpdated": bool(updated_character_list)}


@router.post("/api/project/{project_id:path}/narrate/page/{page_number}")
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
            b = await _load_image_bytes(img_url)
            if b:
                imgs.append(b)
        if not imgs:
            raise HTTPException(status_code=400, detail="Page has no panels")

        char_md = str(payload.get("characterList") or EditorDB.get_character_list(project_id) or "")
        context_txt = str(payload.get("context") or "")

        char_md = str(payload.get("characterList") or EditorDB.get_character_list(project_id) or "")
        context_txt = str(payload.get("context") or "")

        provider = str(project.get("narration_provider") or "gemini")
        txt = ""

        if provider == "manual_web":
            # Just generate the prompt and "block" it so the UI shows the manual entry modal
            sys_instructions = (
                "You are a manga narration assistant. For the given page, write a cohesive, flowing micro‑narrative that spans the panels in order. "
                "Produce one vivid, short sentence per panel, but ensure each sentence connects naturally to the next so it reads like a continuous story, not a list. "
                "Avoid list formatting, numbering, or using the word 'panel'. Do not start every sentence with a proper name. "
                "Use character names sparingly—after the first clear mention, prefer pronouns and varied sentence openings unless a name is needed for clarity. "
                "After a character is introduced (full name allowed once if helpful), do NOT use their full name again; use only their first name (e.g., 'FirstName' not 'FirstName Lastname') or a pronoun. "
                "CRITICAL: Keep narration EXTREMELY CONCISE. Maximum 50 words (approx 300 characters) per panel. "
                "OUTPUT FORMAT: STRICT VALID JSON ONLY. No markdown. No formatting. "
                "Structure: {\"panels\": [{\"panel_index\": 1, \"text\": \"...\"}]}"
            )
            if context_txt:
                sys_instructions += "\nContext so far (previous pages):\n" + context_txt
            if char_md:
                sys_instructions += (
                    "\nKnown characters (markdown) — use names sparingly for smooth narration; after the first mention, prefer pronouns or first names only (avoid surnames):\n"
                    + char_md
                )
            
            # Raise "blocked" error to trigger UI
            raise HTTPException(
                status_code=400, 
                detail={
                    "error": "blocked", 
                    "block_reason": "MANUAL_MODE", 
                    "message": "Manual Web UI Mode: Copy prompt and images to Gemini/ChatGPT",
                    "prompt": sys_instructions
                }
            )

        elif provider == "groq":
             # Groq model restriction: max 5 images
             if len(imgs) > 5:
                 logger.warning(f"Page {page_number} has {len(imgs)} panels. Groq supports max 5. Truncating to first 5.")
                 imgs = imgs[:5]

             client = _groq_client()
             if not client:
                 raise HTTPException(status_code=400, detail="Groq API key not configured")
              
             messages = _build_page_prompt_groq(int(page_number), imgs, context_txt, char_md)
             
             data = None
             last_error = None
             for attempt in range(3):
                 try:
                     completion = client.chat.completions.create(
                            model="meta-llama/llama-4-scout-17b-16e-instruct", # Using vision model
                            messages=messages,
                            temperature=0.7,
                            max_tokens=1024,
                            response_format={"type": "json_object"}
                     )
                     txt = completion.choices[0].message.content or ""
                     try:
                        extracted = json.loads(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                continue
                     except json.JSONDecodeError:
                         extracted = _extract_json(txt)
                         if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                continue
                 except Exception as e:
                     logger.error(f"Groq API error: {e}")
                     last_error = str(e)
            
             if not data:
                  raise HTTPException(status_code=500, detail=f"Groq error: {last_error}")

        elif provider == "azure":
             client = _azure_client()
             if not client:
                 raise HTTPException(status_code=400, detail="Azure OpenAI keys not configured")
             
             # Reuse Groq prompt builder but adapt for O1 (System -> User)
             raw_messages = _build_page_prompt_groq(int(page_number), imgs, context_txt, char_md, third_person=True)
             msgs_to_send = []
             sys_content = ""
             # simple merge: find system, prepend to user
             for m in raw_messages:
                 if m['role'] == 'system':
                     sys_content += m['content'] + "\n\n"
                 else:
                     if m['role'] == 'user' and sys_content:
                         if isinstance(m['content'], str):
                             m['content'] = sys_content + m['content']
                         elif isinstance(m['content'], list):
                             # Ensure text part gets the system prompt
                             for part in m['content']:
                                 if part.get('type') == 'text':
                                     part['text'] = sys_content + part['text']
                                     break
                         sys_content = "" # flushed
                     msgs_to_send.append(m)

             data = None
             last_error = None
             
             # DEBUG: Log payload stats
             img_sizes = [len(b) for b in imgs]
             logger.info(f"Azure Payload check: Page {page_number}, {len(msgs_to_send)} messages. Images: {len(imgs)}, Sizes: {img_sizes}")

             # Azure Single Attempt with Force Truncate
             try:
                 completion = client.chat.completions.create(
                        model="gpt-5-nano",
                        messages=msgs_to_send,
                        max_completion_tokens=25000,
                        response_format={"type": "json_object"}
                 )
                 # DEBUG LOGGING
                 choice = completion.choices[0]
                 logger.info(f"Azure Raw Output: finish_reason={choice.finish_reason}, content={choice.message.content}")
                 
                 txt = choice.message.content or ""
                 extracted = None
                 try:
                    extracted = json.loads(txt)
                 except json.JSONDecodeError:
                    extracted = _extract_json(txt)
                 
                 if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                    # Check length - if too long, truncate immediately (no retry)
                    if _validate_narration_length(extracted):
                        data = extracted
                    else:
                        logger.warning(f"Azure: Output too long. Truncating immediately.")
                        data = _force_truncate(extracted)
                 else:
                     raise HTTPException(status_code=500, detail=f"Azure produced invalid JSON structure: {txt[:200]}")

             except Exception as e:
                 logger.error(f"Azure OpenAI API error: {e}")
                 raise HTTPException(status_code=500, detail=f"Azure error: {e}")


        # GEMINI
        else:
            if genai is None:
                 raise HTTPException(status_code=400, detail="Gemini lib not installed")
            
            contents = _build_page_prompt(int(page_number), imgs, context_txt, char_md)
            model = _gemini_client()
            if not model:
                 raise HTTPException(status_code=500, detail="Gemini client init failed")
            
            data = None
            last_error = None
            txt = ""

            for attempt in range(3):
                try:
                     resp = model.generate_content(contents)
                     txt = resp.text
                     try:
                        extracted = json.loads(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                             # VALIDATE LENGTH
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                logger.warning(f"Gemini page {page_number} attempt {attempt}: {last_error}")
                                continue
                     except json.JSONDecodeError:
                        extracted = _extract_json(txt)
                        if isinstance(extracted, dict) and isinstance(extracted.get("panels"), list):
                             # VALIDATE LENGTH
                            if _validate_narration_length(extracted):
                                data = extracted
                                break
                            else:
                                last_error = "Narration too long (retry)"
                                logger.warning(f"Gemini page {page_number} attempt {attempt}: {last_error}")
                                continue
                except Exception as e:
                    logger.warning(f"Gemini error page {page_number} attempt {attempt}: {e}")
                    last_error = str(e)
            
            if not data:
                # If txt implies we got something but validation failed, we might still process it narrowly?
                # But user asked for retry. If all retries fail, we raise error or fall through?
                # Code below expects data. 
                # If we raise HTTPException here, we stop.
                # If we continue with data=None, the code below 2647 handles logic.
                if not txt:
                     raise HTTPException(status_code=500, detail=f"Gemini failed: {last_error}")
                
        # data is now set (or None if failed but txt exists)
        # We removed the line `data = _extract_json(txt)` so we must ensure data is set if we want to skip fallback.
        if not data and txt:
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


@router.post("/api/project/{project_id:path}/narrate/page/{page_number}/manual")
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
                EditorDB.upsert_panel_narration(project_id, int(page_number), int(panel_index), text, is_manual=True)
                saved_panels.append({"panel_index": int(panel_index), "text": text})
        
        return {"ok": True, "page_number": int(page_number), "panels": saved_panels}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving manual narration for project {project_id}, page {page_number}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/api/project/{project_id:path}/characters")
async def api_get_characters(project_id: str):
    return {"project_id": project_id, "markdown": EditorDB.get_character_list(project_id)}


@router.post("/api/debug/test-character-propagation/{series_id}")
async def api_test_character_propagation(series_id: str):
    """Debug endpoint to test character list propagation."""
    try:
        test_characters = """# Test Characters
- Test Character 1: A brave hero with blue hair
- Test Character 2: A mysterious villain with red eyes
- Test Character 3: A wise mentor figure"""

        logger.debug(f"Testing character propagation for series {series_id}")

        # Save to series
        EditorDB.set_series_character_list(series_id, test_characters)
        logger.debug(f"Saved test characters to series")

        # Propagate to chapters
        chapters_updated = EditorDB.propagate_character_list_to_chapters(series_id, test_characters)
        logger.debug(f"Propagated to {chapters_updated} chapters")

        # Verify by reading back
        series_chars = EditorDB.get_series_character_list(series_id)
        logger.debug(f"Retrieved series characters: {len(series_chars)} chars")

        return {
            "ok": True,
            "series_id": series_id,
            "test_characters": test_characters,
            "chapters_updated": chapters_updated,
            "retrieved_length": len(series_chars),
            "retrieved_match": series_chars == test_characters
        }
    except Exception as e:
        logger.exception(f"Error in test-character-propagation for series {series_id}: {e}")
        return {"error": str(e), "traceback": str(e.__traceback__)}


@router.get("/api/debug/database-schema")
async def api_debug_database_schema():
    """Debug endpoint to check database schema."""
    try:
        conn = EditorDB.conn()
        
        # Check manga_series table structure
        series_schema = conn.execute("PRAGMA table_info(manga_series)").fetchall()
        
        # Check project_details table structure  
        project_schema = conn.execute("PRAGMA table_info(project_details)").fetchall()
        
        # Check if character_markdown field exists in manga_series
        series_has_char_field = any(col[1] == 'character_markdown' for col in series_schema)
        
        return {
            "manga_series_schema": [{"name": col[1], "type": col[2], "notnull": bool(col[3])} for col in series_schema],
            "project_details_schema": [{"name": col[1], "type": col[2], "notnull": bool(col[3])} for col in project_schema],
            "series_has_character_field": series_has_char_field,
            "message": "Check if character_markdown field exists in manga_series table"
        }
    except Exception as e:
        return {"error": str(e)}


@router.get("/api/project/{project_id:path}/debug-characters")
async def api_debug_characters(project_id: str):
    """Debug endpoint to check character list storage and loading."""
    try:
        project = EditorDB.get_project(project_id)
        if not project:
            return {"error": "Project not found"}
        
        metadata = project.get("metadata") or {}
        series_id = metadata.get("manga_series_id")
        
        # Get character lists from both sources
        chapter_chars = EditorDB.get_character_list(project_id)
        series_chars = EditorDB.get_series_character_list(series_id) if series_id else None
        
        # Get raw database data
        conn = EditorDB.conn()
        
        # Check project_details table
        project_row = conn.execute(
            "SELECT character_markdown FROM project_details WHERE project_id=?",
            (project_id,)
        ).fetchone()
        
        # Check manga_series table if series exists
        series_row = None
        if series_id:
            series_row = conn.execute(
                "SELECT character_markdown FROM manga_series WHERE id=?",
                (series_id,)
            ).fetchone()
        
        return {
            "project_id": project_id,
            "series_id": series_id,
            "chapter_character_list": chapter_chars,
            "series_character_list": series_chars,
            "raw_project_row": project_row[0] if project_row else None,
            "raw_series_row": series_row[0] if series_row else None,
            "has_series": bool(series_id),
            "metadata": metadata
        }
    except Exception as e:
        return {"error": str(e)}


@router.put("/api/project/{project_id:path}/characters")
async def api_set_characters(project_id: str, payload: Dict[str, Any]):
    md = str(payload.get("markdown") or "")

    logger.debug(f"Saving character list for project {project_id}")
    logger.debug(f"Character list length: {len(md)}")

    # Save to the current chapter
    EditorDB.set_character_list(project_id, md)
    logger.debug(f"Saved to chapter level")
    
    # Check if this project belongs to a series
    project = EditorDB.get_project(project_id)
    series_id = None
    if project:
        # Get series_id directly from project data, fallback to metadata for backward compatibility
        series_id = project.get("manga_series_id")
        if not series_id:
            metadata = project.get("metadata") or {}
            series_id = metadata.get("manga_series_id")

        logger.debug(f"Series ID: {series_id}")
        logger.debug(f"Series ID source: {'direct' if project.get('manga_series_id') else 'metadata' if series_id else 'none'}")

        if series_id:
            # Save to the series level
            EditorDB.set_series_character_list(series_id, md)
            logger.debug(f"Saved to series level")

            # Propagate to all chapters in the series
            chapters_updated = EditorDB.propagate_character_list_to_chapters(series_id, md)
            logger.debug(f"Propagated to {chapters_updated} chapters")

            return {
                "ok": True,
                "series_id": series_id,
                "chapters_updated": chapters_updated,
                "message": f"Character list saved and propagated to {chapters_updated} chapter(s) in the series"
            }

    logger.debug(f"No series ID found")
    return {"ok": True, "message": "Character list saved for this chapter"}


@router.post("/api/project/{project_id:path}/characters/update")
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
@router.get("/api/project/{project_id:path}/story")
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


@router.put("/api/project/{project_id:path}/story")
async def api_set_story(project_id: str, payload: Dict[str, Any]):
    """Set the current chapter's summary."""
    summary = str(payload.get("summary") or "")
    # Save to current summary field
    EditorDB.set_story_summary_current(project_id, summary)
    # Also update legacy field for backward compatibility
    EditorDB.set_story_summary(project_id, summary)
    return {"ok": True}


@router.post("/api/project/{project_id:path}/story/generate")
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

@router.post("/api/project/{project_id:path}/story/fetch-previous")
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


@router.get("/api/manga/series/{series_id}/characters")
async def api_get_series_characters(series_id: str):
    """Get the series-level character list."""
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    char_md = EditorDB.get_series_character_list(series_id)
    return {"series_id": series_id, "markdown": char_md}


@router.put("/api/manga/series/{series_id}/characters")
async def api_set_series_characters(series_id: str, payload: Dict[str, Any]):
    """Set the character list for an entire series and propagate to all chapters."""
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    md = str(payload.get("markdown") or "")
    
    # Save to series
    EditorDB.set_series_character_list(series_id, md)
    
    # Propagate to all chapters
    chapters_updated = EditorDB.propagate_character_list_to_chapters(series_id, md)
    
    return {
        "ok": True,
        "series_id": series_id,
        "chapters_updated": chapters_updated,
        "message": f"Character list saved and propagated to {chapters_updated} chapter(s)"
    }


@router.post("/api/manga/series/{series_id}/chapters")
async def api_add_chapter_to_series(series_id: str, payload: Dict[str, Any]):
    """Add a new chapter to a manga series."""
    chapter_number = payload.get("chapter_number")
    if chapter_number is None:
        raise HTTPException(status_code=400, detail="chapter_number is required")
    
    
    title = str(payload.get("title") or f"Chapter {chapter_number}").strip()
    files = payload.get("files") or []
    narration_provider = str(payload.get("narration_provider") or "gemini")
    
    if not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="files must be a non-empty array of image paths")
    
    try:
        chapter = EditorDB.add_chapter_to_series(series_id, int(chapter_number), title, files, narration_provider=narration_provider)
        return chapter
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create chapter: {e}")




@router.get("/api/manga/series/{series_id}/narration-status")
async def api_get_narration_status(series_id: str, override: bool = False):
    """
    Get the narration status for all chapters in a series.
    Returns which chapters have narrations and which need them.
    
    Args:
        series_id: The manga series ID
        override: If True, ignores existing narrations and treats all chapters as needing narrations
    """
    # Get series details
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    chapters = series.get("chapters", [])
    if not chapters:
        return {
            "series_id": series_id,
            "series_name": series.get("name"),
            "total_chapters": 0,
            "chapters_with_narrations": [],
            "chapters_needing_narrations": [],
            "chapters_without_panels": [],
            "override_mode": override
        }
    
    chapters_with_narrations = []
    chapters_needing_narrations = []
    chapters_without_panels = []
    
    for ch in chapters:
        chapter_info = {
            "chapter_number": ch["chapter_number"],
            "title": ch["title"],
            "id": ch["id"]
        }
        
        # Check if chapter has panels
        pages = EditorDB.get_pages(ch["id"])
        if not pages:
            chapters_without_panels.append(chapter_info)
            continue
            
        has_all_panels = True
        for pg in pages:
            pn = int(pg.get("page_number") or 0)
            panels = EditorDB.get_panels_for_page(ch["id"], pn)
            if not panels:
                has_all_panels = False
                break
        
        if not has_all_panels:
            chapters_without_panels.append(chapter_info)
            continue
        
        # Check if chapter has narrations (skip this check if override is enabled)
        if override:
            # In override mode, all chapters with panels need narrations (ignore existing)
            chapters_needing_narrations.append(chapter_info)
        else:
            # Normal mode: check if narrations exist
            narrations = EditorDB.get_panel_narrations(ch["id"])
            has_narrations = any(text.strip() for text in narrations.values())
            
            if has_narrations:
                chapters_with_narrations.append(chapter_info)
            else:
                chapters_needing_narrations.append(chapter_info)
    
    return {
        "series_id": series_id,
        "series_name": series.get("name"),
        "total_chapters": len(chapters),
        "chapters_with_narrations": chapters_with_narrations,
        "chapters_needing_narrations": chapters_needing_narrations,
        "chapters_without_panels": chapters_without_panels,
        "override_mode": override
    }


@router.post("/api/manga/series/{series_id}/narrate-all")
async def api_narrate_all_series_chapters_execute(series_id: str, payload: Dict[str, Any] = Body(default={})):
    """Execute narration generation for all chapters in a series."""
    narration_provider = str(payload.get("narration_provider") or "").strip()
    if genai is None or not _GEMINI_KEYS:
        raise HTTPException(status_code=400, detail="Gemini not configured. Set GOOGLE_API_KEYS.")
    
    # Get series details
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")
    
    chapters = series.get("chapters", [])
    if not chapters:
        raise HTTPException(status_code=400, detail="No chapters found in series")
    
    # Filter chapters that need narration
    chapters_to_process = []
    for ch in chapters:
        # Check if chapter has narrations already
        narrations = EditorDB.get_panel_narrations(ch["id"])
        # Check if any narrations have actual text (not empty)
        has_narrations = any(text.strip() for text in narrations.values())
        
        if not has_narrations:
            chapters_to_process.append(ch)
    
    if not chapters_to_process:
        return {
            "ok": True,
            "message": "All chapters already have narrations",
            "processed": 0,
            "skipped": len(chapters),
            "failed": 0,
            "total_chapters": len(chapters),
            "results": []
        }
    
    success_count = 0
    failed_count = 0
    results = []
    
    for ch in chapters_to_process:
        chapter_id = ch["id"]
        chapter_num = ch["chapter_number"]
        chapter_title = ch["title"]
        
        try:
            # Update provider if specified
            if narration_provider:
                EditorDB.set_project_provider(chapter_id, narration_provider)
            # Get chapter details
            project = EditorDB.get_project(chapter_id)
            if not project:
                failed_count += 1
                results.append({
                    "chapter_number": chapter_num,
                    "title": chapter_title,
                    "status": "failed",
                    "error": "Chapter not found"
                })
                continue
            
            pages = EditorDB.get_pages(chapter_id)
            if not pages:
                failed_count += 1
                results.append({
                    "chapter_number": chapter_num,
                    "title": chapter_title,
                    "status": "failed",
                    "error": "No pages found"
                })
                continue
            
            # Check if chapter has panels
            all_have_panels = True
            for pg in pages:
                pn = int(pg.get("page_number") or 0)
                panels = EditorDB.get_panels_for_page(chapter_id, pn)
                if not panels:
                    all_have_panels = False
                    break
            
            if not all_have_panels:
                failed_count += 1
                results.append({
                    "chapter_number": chapter_num,
                    "title": chapter_title,
                    "status": "failed",
                    "error": "Missing panels - create panels first"
                })
                continue
            
            # Generate narrations for this chapter
            start_page = pages[0].get("page_number", 1)
            end_page = pages[-1].get("page_number", start_page)
            
            # Get character list from series level
            char_md = EditorDB.get_series_character_list(series_id)
            if not char_md:
                char_md = EditorDB.get_character_list(chapter_id)
            
            # Call the narration generation (reuse sequential logic)
            payload = {
                "startPage": start_page,
                "endPage": end_page,
                "characterList": char_md
            }
            
            try:
                # Call the existing sequential narration endpoint logic
                narration_result = await api_narrate_sequential(chapter_id, payload)
                
                success_count += 1
                results.append({
                    "chapter_number": chapter_num,
                    "title": chapter_title,
                    "status": "success",
                    "character_list_updated": narration_result.get("characterListUpdated", False)
                })
                
            except Exception as e:
                failed_count += 1
                results.append({
                    "chapter_number": chapter_num,
                    "title": chapter_title,
                    "status": "failed",
                    "error": str(e)
                })
                
        except Exception as e:
            failed_count += 1
            results.append({
                "chapter_number": chapter_num,
                "title": chapter_title,
                "status": "failed",
                "error": str(e)
            })
    
    return {
        "ok": True,
        "series_id": series_id,
        "series_name": series.get("name"),
        "processed": success_count,
        "failed": failed_count,
        "skipped": len(chapters) - len(chapters_to_process),
        "total_chapters": len(chapters),
        "results": results
    }


@router.put("/api/manga/series/migrate/{project_id:path}")
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


@router.put("/api/manga/series/{series_id}")
async def api_rename_manga_series(series_id: str, payload: Dict[str, Any]):
    """Rename a manga series and optionally propagate the change to chapter titles.

    Payload: { name: string, propagate_chapters?: bool }
    """
    name = str(payload.get("name") or "").strip()
    propagate = bool(payload.get("propagate_chapters") if payload.get("propagate_chapters") is not None else True)
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    # Ensure series exists
    series = EditorDB.get_manga_series(series_id)
    if not series:
        raise HTTPException(status_code=404, detail="Manga series not found")

    try:
        res = EditorDB.rename_manga_series(series_id, name, propagate_chapters=propagate)
        return res
    except ValueError as ve:
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        logger.exception("Failed to rename series %s", series_id)
        raise HTTPException(status_code=500, detail=f"Failed to rename series: {e}")


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
async def api_list_projects(brief: bool = False, limit: int = 100):
    """List projects. If brief=true returns a compact representation for up to `limit` projects.
    This is intended to be used by dashboard code to avoid making per-project API calls.
    """
    try:
        if brief:
            projects = EditorDB.list_projects_brief(limit=limit)
            return {"projects": projects}
        else:
            return {"projects": EditorDB.list_projects()}
    except Exception as e:
        logger.exception("Failed to list projects")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/projects")
async def api_create_project(payload: Dict[str, Any]):
    title = str(payload.get("title") or "Untitled").strip()
    files = payload.get("files") or []
    narration_provider = str(payload.get("narration_provider") or "gemini")
    if not isinstance(files, list) or not files:
        raise HTTPException(status_code=400, detail="files must be a non-empty array of image paths")
    proj = EditorDB.create_project(title, files, narration_provider=narration_provider)
    return proj


@router.delete("/api/projects/{project_id:path}")
async def api_delete_project(project_id: str):
    if not EditorDB.get_project(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    EditorDB.delete_project(project_id)
    return {"ok": True}


# ---------------------------- New Full-Page Panel Editor ----------------------------
@router.get("/panel-editor/{project_id:path}", response_class=HTMLResponse)
async def panel_editor_full(request: Request, project_id: str):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return templates.TemplateResponse(
        "panel_editor_full.html",
        {"request": request, "project": proj},
    )


@router.put("/api/project/{project_id:path}/panel/{page_number}/{panel_index}/text")
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


@router.put("/api/project/{project_id:path}/panel/{page_number}/{panel_index}/audio")
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


@router.put("/api/project/{project_id:path}/panel/{page_number}/{panel_index}/config")
async def api_update_panel_config(project_id: str, page_number: int, panel_index: int, payload: Dict[str, Any]):
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    eff = str(payload.get("effect") or "").strip() or "zoom_in"
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


@router.delete("/api/project/{project_id}/panel/{page_number}/{panel_index}")
async def api_delete_panel(project_id: str, page_number: int, panel_index: int):
    """Delete a specific panel and re-index remaining panels on that page."""
    conn = EditorDB.conn()
    
    # Check if panel exists
    row = conn.execute(
        "SELECT 1 FROM panels WHERE project_id=? AND page_number=? AND panel_index=?",
        (project_id, page_number, panel_index)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Panel not found")
        
    # Get all panels for this page before deletion
    rows = conn.execute(
        "SELECT panel_index, image_path, narration_text, is_manual, audio_url, effect, transition FROM panels WHERE project_id=? AND page_number=? ORDER BY panel_index ASC",
        (project_id, page_number)
    ).fetchall()
    
    # Filter out the deleted panel
    remaining = [r for r in rows if int(r[0]) != panel_index]
    
    # Delete all panels for this page
    conn.execute(
        "DELETE FROM panels WHERE project_id=? AND page_number=?",
        (project_id, page_number)
    )
    
    # Re-insert with new sequential indices
    for i, r in enumerate(remaining):
        new_index = i + 1
        # r: (panel_index, image_path, narration_text, is_manual, audio_url, effect, transition)
        conn.execute(
            """
            INSERT INTO panels (project_id, page_number, panel_index, image_path, narration_text, is_manual, audio_url, effect, transition, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id, page_number, new_index, 
                r[1], r[2], r[3], r[4], r[5], r[6], 
                datetime.now().isoformat(), datetime.now().isoformat()
            )
        )
        
    conn.commit()
    return {"status": "ok", "remaining_panels": len(remaining)}


@router.put("/api/project/{project_id:path}/page/{page_number}/config")
async def api_update_page_config(project_id: str, page_number: int, payload: Dict[str, Any]):
    """Apply effect/transition to all panels on a page."""
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")
    eff = str(payload.get("effect") or "").strip() or "zoom_in"
    trans = str(payload.get("transition") or "").strip() or "slide_book"
    for p in panels:
        idx = int(p.get("index") or 1)
        EditorDB.set_panel_config(project_id, int(page_number), idx, eff, trans)
    return {"ok": True, "page_number": int(page_number), "count": len(panels), "effect": eff, "transition": trans}


@router.delete("/api/project/{project_id:path}/page/{page_number}")
async def api_delete_page(project_id: str, page_number: int):
    """Delete a page and its panels from the project, then auto-renumber remaining pages sequentially."""
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    
    try:
        # Get current pages
        pages_json = proj.get("pages") or []
        
        # Remove the page with matching page_number
        updated_pages = [p for p in pages_json if p.get("page_number") != page_number]
        
        if len(updated_pages) == len(pages_json):
            raise HTTPException(status_code=404, detail="Page not found")
        
        # Sort by current page_number to maintain order
        updated_pages.sort(key=lambda x: x.get("page_number", 0))
        
        # Renumber pages sequentially (1, 2, 3, ...)
        for idx, page in enumerate(updated_pages, start=1):
            page["page_number"] = idx
        
        # Update database
        conn = EditorDB.conn()
        conn.execute(
            "UPDATE project_details SET pages_json=? WHERE id=?",
            (json.dumps(updated_pages), project_id)
        )
        conn.commit()
        
        # Also delete panel data for this page and renumber metadata pages
        metadata = json.loads(proj.get("metadata") or "{}")
        if "pages" in metadata:
            # Remove deleted page from metadata
            metadata["pages"] = [p for p in metadata["pages"] if p.get("page_number") != page_number]
            
            # Sort and renumber metadata pages
            metadata["pages"].sort(key=lambda x: x.get("page_number", 0))
            for idx, page in enumerate(metadata["pages"], start=1):
                page["page_number"] = idx
            
            conn.execute(
                "UPDATE project_details SET metadata_json=? WHERE id=?",
                (json.dumps(metadata), project_id)
            )
            conn.commit()
        
        logger.info(f"Deleted page {page_number} from project {project_id}, renumbered {len(updated_pages)} remaining pages")
        return {"ok": True, "deleted_page": page_number, "remaining_pages": len(updated_pages), "renumbered": True}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting page: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete page: {str(e)}")


@router.post("/api/project/{project_id:path}/reorder-pages")
async def api_reorder_pages(project_id: str, payload: Dict[str, Any]):
    """Reorder pages in the project."""
    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    
    new_pages = payload.get("pages", [])
    if not new_pages:
        raise HTTPException(status_code=400, detail="Pages array is required")
    
    try:
        # Get current pages and metadata
        current_pages = proj.get("pages") or []
        metadata = json.loads(proj.get("metadata") or "{}")
        
        # Create a mapping of old page numbers to new page numbers
        page_number_map = {}
        for idx, new_page in enumerate(new_pages):
            old_page = current_pages[idx] if idx < len(current_pages) else None
            if old_page:
                old_page_number = old_page.get("page_number")
                new_page_number = new_page.get("page_number")
                page_number_map[old_page_number] = new_page_number
        
        # Update pages_json with new page numbers
        updated_pages = []
        for idx, new_page in enumerate(new_pages):
            if idx < len(current_pages):
                page = current_pages[idx].copy()
                page["page_number"] = new_page.get("page_number")
                updated_pages.append(page)
        
        # Update metadata pages with new page numbers
        if "pages" in metadata:
            for meta_page in metadata["pages"]:
                old_num = meta_page.get("page_number")
                if old_num in page_number_map:
                    meta_page["page_number"] = page_number_map[old_num]
        
        # Save to database
        conn = EditorDB.conn()
        conn.execute(
            "UPDATE project_details SET pages_json=?, metadata_json=? WHERE id=?",
            (json.dumps(updated_pages), json.dumps(metadata), project_id)
        )
        conn.commit()
        
        logger.info(f"Reordered {len(updated_pages)} pages for project {project_id}")
        return {"ok": True, "pages_count": len(updated_pages)}
        
    except Exception as e:
        logger.error(f"Error reordering pages: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to reorder pages: {str(e)}")


# ---------------------------- TTS synthesis (DB-backed) ----------------------------
@router.post("/api/project/{project_id:path}/tts/synthesize/page/{page_number}")
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
            # Allow optional API key header for TTS provider
            tts_headers = {}
            tts_key = os.environ.get("TTS_API_KEY", "").strip()
            tts_key_header = os.environ.get("TTS_API_KEY_HEADER", "Authorization").strip()
            if tts_key:
                # If header is Authorization and value doesn't start with Bearer, prefix it
                if tts_key_header.lower() == "authorization" and not tts_key.lower().startswith("bearer "):
                    tts_headers[tts_key_header] = f"Bearer {tts_key}"
                else:
                    tts_headers[tts_key_header] = tts_key

            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(TTS_API_URL, data=payload, headers=tts_headers or None)
            if r.status_code != 200:
                # Log provider response for easier debugging (trim to 2k chars)
                try:
                    body = r.text
                except Exception:
                    body = "<unreadable>"
                logger.warning("TTS provider returned %s for project %s page %s panel %s: %s", r.status_code, project_id, page_number, idx, (body[:2000] if body else ""))
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


@router.post("/api/project/{project_id:path}/tts/synthesize/page/{page_number}/panel/{panel_index}")
async def api_tts_synthesize_panel(project_id: str, page_number: int, panel_index: int):
    """Synthesize TTS for a single panel on a page using narration_text stored in DB.
    Saves audio file under /manga_projects/{project_id}/tts and updates panel audio URL in DB.
    Returns the single panel result for UI convenience.
    """
    if not TTS_API_URL:
        raise HTTPException(status_code=503, detail="TTS API not configured (TTS_API_URL)")

    proj = EditorDB.get_project(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    panels = EditorDB.get_panels_for_page(project_id, int(page_number))
    if not panels:
        raise HTTPException(status_code=404, detail="No panels for this page")

    # Find the requested panel. get_panels_for_page returns display 'index' (1-based)
    target = None
    for p in panels:
        try:
            if int(p.get("index") or 0) == int(panel_index):
                target = p
                break
        except Exception:
            continue

    if target is None:
        # try fallback: maybe stored as 0-based in DB
        for p in panels:
            try:
                if int(p.get("index") or 0) == int(panel_index) - 1:
                    target = p
                    break
            except Exception:
                continue

    if target is None:
        raise HTTPException(status_code=404, detail="Panel not found")

    text = str(target.get("text") or "").strip()
    project_dir = os.path.join(MANGA_DIR, project_id)
    out_dir = os.path.join(project_dir, "tts")
    os.makedirs(out_dir, exist_ok=True)

    if not text:
        # nothing to synthesize; return existing audio or skipped
        return {
            "ok": True,
            "page_number": int(page_number),
            "panel": {
                "panel_index": int(panel_index),
                "text": "",
                "audio_url": target.get("audio"),
                "status": "skipped"
            }
        }

    try:
        payload = {
            "text": text,
            "exaggeration": "0.5",
            "cfg_weight": "0.5",
            "temperature": "0.8",
        }
        # Optional API key header support for TTS provider
        tts_headers = {}
        tts_key = os.environ.get("TTS_API_KEY", "").strip()
        tts_key_header = os.environ.get("TTS_API_KEY_HEADER", "Authorization").strip()
        if tts_key:
            if tts_key_header.lower() == "authorization" and not tts_key.lower().startswith("bearer "):
                tts_headers[tts_key_header] = f"Bearer {tts_key}"
            else:
                tts_headers[tts_key_header] = tts_key

        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(TTS_API_URL, data=payload, headers=tts_headers or None)
        if r.status_code != 200:
            try:
                body = r.text
            except Exception:
                body = "<unreadable>"
            logger.warning("TTS provider returned %s for project %s page %s panel %s: %s", r.status_code, project_id, page_number, panel_index, (body[:2000] if body else ""))
            raise HTTPException(status_code=502, detail=f"TTS provider error: {r.status_code}")

        # Save audio
        fname = f"tts_page_{int(page_number)}_panel_{int(panel_index)}.wav"
        abs_path = os.path.join(out_dir, fname)
        with open(abs_path, "wb") as wf:
            wf.write(r.content)
        url = f"/manga_projects/{project_id}/tts/{fname}"

        # Persist to DB
        EditorDB.set_panel_audio(project_id, int(page_number), int(panel_index), url)

        return {
            "ok": True,
            "page_number": int(page_number),
            "panel": {
                "panel_index": int(panel_index),
                "text": text,
                "audio_url": url,
                "status": "ok"
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("TTS failed for page %s panel %s", page_number, panel_index)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/project/{project_id:path}/tts/synthesize/all")
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


@router.post("/api/project/{project_id:path}/tts/backfill")
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


@router.post("/api/fetch-chapter-images")
async def fetch_chapter_images(payload: Dict[str, Any]):
    """Fetch chapter images from MangaDex using their API"""
    try:
        import asyncio
        from concurrent.futures import ThreadPoolExecutor
        
        chapter_id = payload.get("chapter_id")
        mangadex_url = payload.get("mangadex_url")
        
        if not chapter_id or not mangadex_url:
            raise HTTPException(status_code=400, detail="chapter_id and mangadex_url are required")
        
        # Get the project to verify it exists
        project = EditorDB.get_project(chapter_id)
        if not project:
            raise HTTPException(status_code=404, detail="Chapter not found")
        
        # Extract MangaDex chapter ID from URL
        # URL format: https://mangadex.org/chapter/{uuid}
        mangadex_chapter_id = mangadex_url.split('/chapter/')[-1].split('?')[0].split('#')[0]
        
        logger.info(f"Fetching images for chapter {chapter_id} from MangaDex chapter {mangadex_chapter_id}")
        
        # Get chapter pages using MangaDex API
        at_home_url = f"https://api.mangadex.org/at-home/server/{mangadex_chapter_id}"
        
        mangadex_secret = os.environ.get("MANGADX_SECRET", "").strip()
        headers = {}
        if mangadex_secret:
            headers["Authorization"] = f"Bearer {mangadex_secret}"
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            at_home_response = await client.get(at_home_url, headers=headers)
        
        if at_home_response.status_code != 200:
            raise HTTPException(status_code=404, detail=f"MangaDex chapter not found: {mangadex_chapter_id}")
        
        at_home_data = at_home_response.json()
        
        base_url = at_home_data["baseUrl"]
        chapter_hash = at_home_data["chapter"]["hash"]
        filenames = at_home_data["chapter"]["data"]  # High quality images
        
        if not filenames:
            raise HTTPException(status_code=404, detail="No images found for this chapter")
        
        logger.info(f"Found {len(filenames)} images to download")
        
        # Create project directory
        project_dir = os.path.join(MANGA_DIR, chapter_id)
        os.makedirs(project_dir, exist_ok=True)
        
        # Define download function to run in thread
        def download_images():
            """Download images in a separate thread"""
            saved_files = []
            
            for idx, filename in enumerate(filenames, start=1):
                try:
                    # Construct image URL
                    image_url = f"{base_url}/data/{chapter_hash}/{filename}"
                    
                    logger.info(f"Downloading image {idx}/{len(filenames)}: {filename}")
                    
                    # Download image
                    response = requests.get(image_url, timeout=30)
                    response.raise_for_status()
                    image_data = response.content
                    
                    # Determine file extension from original filename
                    ext = os.path.splitext(filename)[1] or '.jpg'
                    
                    # Save image with sequential naming
                    save_filename = f"page_{idx:03d}{ext}"
                    file_path = os.path.join(project_dir, save_filename)
                    
                    with open(file_path, 'wb') as f:
                        f.write(image_data)
                    
                    # Store relative path
                    relative_path = f"/manga_projects/{chapter_id}/{save_filename}"
                    saved_files.append(relative_path)
                    
                    logger.info(f"Saved image {idx}/{len(filenames)}: {save_filename}")
                    
                except Exception as e:
                    logger.error(f"Error downloading image {idx}: {e}")
                    continue
            
            return saved_files
        
        # Run download in thread pool
        loop = asyncio.get_event_loop()
        with ThreadPoolExecutor(max_workers=1) as executor:
            saved_files = await loop.run_in_executor(executor, download_images)
        
        if not saved_files:
            raise HTTPException(status_code=500, detail="Failed to download any images")
        
        # Update project with fetched images
        pages_json = [{"page_number": i, "image_path": path} for i, path in enumerate(saved_files, start=1)]
        
        conn = EditorDB.conn()
        conn.execute(
            "UPDATE project_details SET pages_json=?, has_images=1 WHERE id=?",
            (json.dumps(pages_json), chapter_id)
        )
        conn.commit()
        
        logger.info(f"Successfully fetched {len(saved_files)} images for chapter {chapter_id}")
        
        return {
            "success": True,
            "image_count": len(saved_files),
            "chapter_id": chapter_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching chapter images: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to fetch images: {str(e)}")




# VideoAI - Manga Editor & Video Creator

# VideoAI - Manga to Video Platform

> AI-powered manga panel editor and video creation platform with automated panel detection, narrative generation, and professional video rendering.

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-green.svg)](https://fastapi.tiangolo.com/)
[![Playwright](https://img.shields.io/badge/Playwright-1.48-red.svg)](https://playwright.dev/)

## What is VideoAI?

VideoAI is a comprehensive web application that transforms manga/comic pages into narrated videos. It combines AI-powered panel detection, Google Gemini narrative generation, and a professional video editor with headless browser recording capabilities.

**Key Features:**
- **AI Narration** - Google Gemini generates contextual story narration
- **Panel Detection** - External API integration for automated panel extraction
- **Manga Editor** - SQLite-backed editor with full panel management
- **Panel Editor** - Dedicated interface for TTS generation and audio management
- **Video Editor** - Multi-layer timeline with effects and transitions
- **Headless Recording** - Playwright-based video rendering with audio
- **TTS Support** - Optional text-to-speech integration
- **Persistent Storage** - SQLite database for projects and timeline data

## 🎯 What is VideoAI?

VideoAI is a comprehensive web application that transforms manga/comic pages into narrated videos. It combines AI-powered panel detection, Google Gemini narrative generation, and a professional video editor with headless browser recording capabilities.

**Key Features:**
- 🤖 **AI Narration** - Google Gemini generates contextual story narration
- 🎭 **Panel Detection** - External API integration for automated panel extraction
- 📝 **Manga Editor** - SQLite-backed editor with full panel management
- � **Panel Editor** - Dedicated interface for TTS generation and audio management
- �🎬 **Video Editor** - Multi-layer timeline with effects and transitions
- 🎥 **Headless Recording** - Playwright-based video rendering with audio
- 🎤 **TTS Support** - Optional text-to-speech integration
- 💾 **Persistent Storage** - SQLite database for projects and timeline data

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features-in-detail)
  - [Manga Editor](#manga-editor)
  - [Panel Editor (Dedicated Interface)](#panel-editor-dedicated-interface) ⭐
  - [Video Editor](#video-editor)
- [Project Structure](#-project-structure)
- [API Reference](#-api-reference)
- [Configuration](#-configuration)
- [Usage Guide](#-usage-guide)
- [Development](#-development)
- [Troubleshooting](#-troubleshooting)
- [Architecture](#-architecture)
- [Contributing](#-contributing)

---

## Key Application Pages

| Page | URL | Purpose |
|------|-----|---------|
| **Dashboard** | `/editor/dashboard` | Project list and management |
| **Manga Editor** | `/editor/manga-editor/{project_id}` | Main project editor with narration |
| **Panel Editor** ⭐ | `/editor/panel-editor/{project_id}` | **TTS generation & audio management** |
| **Video Editor** | `/editor/video-editor/{project_id}` | Timeline, effects, and rendering |

⭐ **The Panel Editor is essential for TTS generation and preparing panels for video export**

---

## Quick Start

### Prerequisites

- **Python 3.8+**
- **Node.js 14+** (for frontend dependencies)
- **FFmpeg** (optional, for video post-processing)

### Installation

#### 1. Clone and Setup Python Environment

```bash
# Clone the repository
git clone https://github.com/pavankavade/VideoAI.git
cd VideoAI

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows (PowerShell)
.\venv\Scripts\Activate.ps1
# Windows (CMD)
.\venv\Scripts\activate.bat
# Windows (Git Bash)
source venv/Scripts/activate
# macOS/Linux
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt
```

#### 2. Install Frontend Dependencies

```bash
# Install Node.js packages (for Tailwind CSS)
npm install

# Build Tailwind CSS
npm run build:css
```

> **Note:** The project includes FFmpeg.js files in `package.json` for potential future use, but video rendering currently uses **headless browser recording only**. The npm postinstall script copies FFmpeg.js files but they are not actively used.

#### 3. Install Playwright (for headless recording)

```bash
# Install Playwright browsers
playwright install chromium
```

#### 4. Configure Environment Variables

Create a `.env` file in the project root:

```env
# ============ AI Configuration ============
# Google Gemini API key (required for AI narration)
GOOGLE_API_KEY=your_gemini_api_key_here

# ============ Panel Detection API ============
# External panel detection service (e.g., MagiV3)
PANEL_API_URL=https://your-panel-api.ngrok-free.app/split_panels

# ============ TTS (Optional) ============
# External text-to-speech API
TTS_API_URL=https://your-tts-api.com/synthesize

# ============ Network & CORS ============
# Allowed origins for CORS (comma-separated or "*")
ALLOW_ORIGINS=*
```

#### 5. Run the Application

```bash
# Start the server (localhost only)
uvicorn main:app --reload --host 127.0.0.1 --port 8000

# OR for LAN access (accessible from other devices)
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

#### 6. Access the Application

Open your browser and navigate to:
- **Dashboard**: http://localhost:8000/
- **Manga Editor Dashboard**: http://localhost:8000/editor/dashboard
- **Manga Project Editor**: http://localhost:8000/editor/manga-editor/{project_id}
- **Panel Editor** (TTS & Audio): http://localhost:8000/editor/panel-editor/{project_id}
- **Video Editor**: http://localhost:8000/editor/video-editor/{project_id}

---

## ✨ Features in Detail

### Manga Editor

#### Project Management
- **SQLite-backed storage** - All projects stored in `data/mangaeditor.db`
- **Create projects** from image uploads
- **Automatic page sorting** - Intelligent filename parsing (e.g., "image (1).png", "image (2).png")
- **Character tracking** - Markdown-based character notes per project
- **Project metadata** - Custom JSON metadata storage

#### Panel Detection
- **External API integration** - Connects to panel detection services (MagiV3, custom APIs)
- **Automatic panel extraction** - Detects and crops individual panels
- **Manual panel creation** - Add custom panels manually
- **Page-by-page processing** - Process individual pages or entire projects

#### AI Narrative Generation
- **Google Gemini integration** - Context-aware story narration
- **Sequential narration** - Maintains story flow across pages
- **Per-page generation** - Generate narration for individual pages
- **Character context** - Uses character notes for better narration

#### Panel Editing
- **Individual panel editing** - Update text, audio, and configuration per panel
- **Dedicated panel editor interface** - Full-page panel management at `/editor/panel-editor/{project_id}`
- **Audio management** - Upload and attach audio files to panels
- **Panel configuration** - Custom settings for each panel
- **Drag-and-drop** support (via frontend)
- **Visual panel preview** - See all panels with thumbnails
- **TTS integration** - Generate and manage text-to-speech audio directly from panel editor

#### Text-to-Speech
- **External TTS API support** - Synthesize speech for panel text
- **Batch processing** - Generate TTS for entire pages or projects
- **Audio backfill** - Generate missing audio files
- **Format support** - MP3, WAV, OGG, M4A

### Panel Editor (Dedicated Interface)

The Panel Editor (`/editor/panel-editor/{project_id}`) is a **dedicated full-page interface** specifically designed for managing panels and generating TTS audio. This is integral to the workflow for creating narrated videos.

#### Key Features:
- **Visual Panel Gallery** - Thumbnail view of all panels across all pages
- **Page Organization** - Panels grouped by page number
- **Text Editing** - Click any panel to edit narration text
- **Audio Management**:
  - Upload custom audio files per panel
  - Generate TTS audio for individual panels
  - Batch generate TTS for entire pages or projects
  - Preview audio playback
  - Replace or remove audio
- **Panel Configuration**:
  - Adjust panel duration for video timeline
  - Configure panel-specific effects
  - Set panel metadata
- **TTS Workflow**:
  - "Synthesize Page" - Generate TTS for all panels on current page
  - "Synthesize All" - Generate TTS for entire project
  - "Backfill" - Generate audio only for panels missing TTS
- **Real-time Updates** - Changes saved immediately to database
- **Audio Preview** - Play button on each panel to test audio

**When to Use:**
- After panel detection and narration generation
- Before exporting to video editor
- When you need to fine-tune panel text and audio
- For batch TTS generation across multiple pages

**Example URL:** `http://localhost:8000/editor/panel-editor/1760184821003`

### Video Editor

#### Timeline & Composition
- **Multi-layer timeline** - Unlimited layers for complex compositions
- **Layer management** - Add, remove, reorder layers
- **Drag-and-drop** interface for clip arrangement
- **Background layer support** - Automatic background insertion

#### Effects & Transitions
- **Ken Burns effect** - Zoom and pan animations
- **Transitions** - Fade, wipe, slide-book effects
- **Transform controls** - Position, scale, rotation per clip
- **Effect configuration** - Customizable animation speed, margins, zoom amounts

**Default Effect Settings:**
```javascript
{
  animationSpeed: 0.2,      // Slower = more cinematic
  screenMargin: 0.1,         // 10% margin
  zoomAmount: 0.25,          // 25% zoom
  maxDuration: 5.0,          // seconds
  panelBaseSize: 1.2,        // 120% of original
  smoothing: 1.0,
  transitionDuration: 0.8,   // seconds
  transitionOverlap: 0.4,    // seconds
  transitionSmoothing: 2.0
}
```

#### Rendering

**Headless Browser Recording:**
- Uses Playwright to launch headless Chromium
- Captures both canvas video and audio simultaneously
- Fast and reliable rendering
- Perfect audio-video synchronization
- Automatic FFmpeg post-processing (if FFmpeg installed)
- Output: `renders/headless-recording-{project_id}-{uuid}.webm`

**How it Works:**
1. Click "Render" button in video editor
2. Server saves project timeline to database
3. Playwright launches headless Chromium browser
4. Browser navigates to special playback URL
5. Screen recording captures canvas and audio
6. Video saved to `renders/` directory
7. Optional FFmpeg metadata fixing (if FFmpeg available)
8. Download link provided automatically

**Requirements:**
- Playwright and Chromium browser installed
- Project must be saved to database first
- Timeline must have at least one clip

**Advantages:**
- No client-side memory limitations
- Captures actual audio playback (solves browser security restrictions)
- Faster than software encoding
- Hardware-accelerated when available

#### Progress Tracking
- **Server-Sent Events (SSE)** - Real-time progress updates
- **Job status monitoring** - Track rendering jobs
- **Download management** - Retrieve completed renders

---

## 📂 Project Structure

```
videoai/
├── main.py                     # FastAPI app entry point
├── mangaeditor.py              # Manga editor module (SQLite-backed)
├── videoeditor.py              # Video editor module
├── headless_recorder.py        # Playwright headless recording
├── async_utils.py              # Windows asyncio compatibility
├── requirements.txt            # Python dependencies
├── package.json                # Node.js dependencies
├── .env                        # Environment variables (create this)
│
├── templates/                  # Jinja2 HTML templates
│   ├── manga_editor_dashboard.html
│   ├── manga_editor.html
│   ├── panel_editor_full.html
│   └── video_editor_db.html
│
├── static/                     # Static assets
│   ├── ui.css                  # Tailwind source
│   ├── ui.build.css            # Compiled CSS
│   ├── manga_editor_dashboard.js
│   └── vendor/                 # Third-party libraries
│       └── @ffmpeg/            # FFmpeg.js WebAssembly
│
├── scripts/                    # Build scripts
│   └── copy-ffmpeg-core.js
│
├── data/                       # SQLite databases (auto-created)
│   └── mangaeditor.db          # Project storage
│
├── manga_projects/             # Project files (auto-created)
│   └── {project_id}/
│       ├── page_*.png          # Page images
│       └── panels/             # Detected panel crops
│
├── uploads/                    # User uploads (auto-created)
├── renders/                    # Video renders (auto-created)
└── venv/                       # Python virtual environment
```

---

## 🔌 API Reference

All API endpoints are prefixed with `/editor` (from the `mangaeditor` and `videoeditor` routers).

### Frontend Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Redirects to dashboard |
| `/editor/dashboard` | GET | Main manga editor dashboard (project list) |
| `/editor/manga-editor/{project_id}` | GET | Full manga editor for specific project |
| `/editor/panel-editor/{project_id}` | GET | **Dedicated panel editor** - TTS generation, audio management, panel editing |
| `/editor/video-editor/{project_id}` | GET | Video editor for project |
| `/editor/headless-test` | GET | Headless recording test page |

### Project Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/projects` | GET | List all projects |
| `/editor/api/projects` | POST | Create new project |
| `/editor/api/projects/{project_id}` | DELETE | Delete project |
| `/editor/api/project/{project_id}` | GET | Get project details |

**Create Project Payload:**
```json
{
  "title": "My Manga Project",
  "image_files": ["page1.png", "page2.png"],
  "characters": "# Character Notes\n..."
}
```

### Panel Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/project/{project_id}/panels/create` | POST | Detect panels for all pages |
| `/editor/api/project/{project_id}/panels/create/page/{page_number}` | POST | Detect panels for specific page |
| `/editor/api/project/{project_id}/panel/{page_number}/{panel_index}/text` | PUT | Update panel text |
| `/editor/api/project/{project_id}/panel/{page_number}/{panel_index}/audio` | PUT | Update panel audio |
| `/editor/api/project/{project_id}/panel/{page_number}/{panel_index}/config` | PUT | Update panel config |
| `/editor/api/project/{project_id}/page/{page_number}/config` | PUT | Update page config |

**Panel Detection Payload:**
```json
{
  "use_external_api": true
}
```

### Narrative Generation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/project/{project_id}/narrate/sequential` | POST | Generate narration for entire project |
| `/editor/api/project/{project_id}/narrate/page/{page_number}` | POST | Generate narration for specific page |

**Sequential Narration Payload:**
```json
{
  "batch_size": 1,
  "custom_prompt": "Optional custom instructions..."
}
```

### Character Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/project/{project_id}/characters` | GET | Get character notes |
| `/editor/api/project/{project_id}/characters` | PUT | Update character notes |
| `/editor/api/project/{project_id}/characters/update` | POST | Update character notes (alternative) |

### Text-to-Speech

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/project/{project_id}/tts/synthesize/page/{page_number}` | POST | Generate TTS for page |
| `/editor/api/project/{project_id}/tts/synthesize/all` | POST | Generate TTS for all panels |
| `/editor/api/project/{project_id}/tts/backfill` | POST | Generate missing TTS audio |

### Video Editor

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/editor/api/video/effect-config` | GET | Get effect configuration |
| `/editor/api/video/effect-config` | POST | Update effect configuration |
| `/editor/api/project/{project_id}/layers` | POST | Save timeline layers |
| `/editor/api/video/render/headless` | POST | Start headless recording |
| `/editor/api/video/headless/available` | GET | Check if Playwright is available |
| `/editor/api/video/progress/stream/{job_id}` | GET | SSE progress stream |
| `/editor/api/video/download/{job_id}` | GET | Download completed render |

**Headless Render Payload:**
```json
{
  "project_id": "1234567890",
  "duration": 60,
  "width": 1920,
  "height": 1080
}
```

### File Upload

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload` | POST | Upload images or audio files |

**Supported formats:** PNG, JPG, JPEG, WEBP, MP3, WAV, OGG, M4A

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_API_KEY` | Yes* | - | Google Gemini API key for AI narration |
| `PANEL_API_URL` | Yes** | - | External panel detection API endpoint |
| `TTS_API_URL` | Yes*** | - | External text-to-speech API endpoint |
| `ALLOW_ORIGINS` | No | `*` | CORS allowed origins (comma-separated) |

\* Required for AI narration features  
\*\* Required for automated panel detection
\*\*\* Required for Text to Speech Generation

### External Panel Detection API

Your panel detection API should implement this specification:

**Endpoint:** `POST /split_panels`

**Input:**
- Multipart form data with `file` field (image)
- Optional query parameters:
  - `add_border` (boolean)
  - `border_width` (integer)
  - `border_color` (string: "R,G,B")
  - `curved_border` (boolean)
  - `corner_radius` (integer)

**Output:**
- ZIP file containing panel images: `panel_1.png`, `panel_2.png`, etc.
- OR JSON array of bounding boxes: `[[x1, y1, x2, y2], ...]`

### External TTS API

Your TTS API should implement:

**Endpoint:** `POST /synthesize`

**Input:**
```json
{
  "text": "Text to synthesize",
  "voice": "optional_voice_id"
}
```

**Output:**
- Audio file (MP3, WAV, OGG, etc.)
- OR JSON with audio URL: `{"audio_url": "https://..."}`

---

## 📖 Usage Guide

### Creating a Manga Project

**Complete Workflow:**
```
Dashboard → Create Project → Detect Panels → Generate Narration → Panel Editor (TTS) → Video Editor → Export
```

1. **Navigate to Dashboard**
   - Go to http://localhost:8000/editor/dashboard

2. **Create Project**
   - Click "Create Project" or similar button
   - Enter project title
   - Upload manga page images
   - (Optional) Add character notes

3. **Detect Panels**
   - Click "Detect Panels" in the project view
   - System sends images to external panel detection API
   - Panels are extracted and saved automatically

4. **Generate Narration**
   - Click "Generate Narration"
   - Google Gemini analyzes panels and creates story narration
   - Narration is saved to database

5. **Edit Panels** (Optional)
   - Navigate to the Panel Editor: http://localhost:8000/editor/panel-editor/{project_id}
   - View all panels with thumbnails
   - Click individual panels to edit text
   - Upload custom audio files
   - Adjust panel configuration (duration, effects, etc.)
   - Reorder panels via drag-and-drop

6. **Generate TTS** (Optional)
   - In the Panel Editor, click "Generate TTS" for individual panels, pages, or entire project
   - Text is sent to TTS API
   - Audio files are automatically attached to panels
   - Preview audio playback directly in the panel editor
   - Use "Backfill" to generate missing audio for panels without TTS

### Creating a Video

1. **Open Video Editor**
   - Navigate to http://localhost:8000/editor/video-editor/{project_id}

2. **Build Timeline**
   - Drag panels from asset library to timeline layers
   - Adjust clip duration and position
   - Add multiple layers for complex compositions

3. **Apply Effects**
   - Select clips and apply Ken Burns (zoom/pan)
   - Add transitions between clips
   - Adjust effect parameters

4. **Preview**
   - Click play to preview in real-time
   - Scrub timeline for frame-accurate positioning

5. **Render Video**

   - Click "Render" button in the video editor
   - Server launches Playwright with headless Chromium
   - Video is rendered with synchronized audio
   - Progress shown via real-time updates
   - Download automatically when complete
   - Find output file in `renders/` directory with format: `headless-recording-{project_id}-{uuid}.webm`

---

## 🛠️ Development

### Running in Development Mode

```bash
# Backend with auto-reload
uvicorn main:app --reload --host 127.0.0.1 --port 8000

# Frontend CSS development (watch mode)
npm run dev:css
```

### Database Management

The SQLite database is located at `data/mangaeditor.db`.

**Schema Overview:**

```sql
-- Projects table
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Pages table
CREATE TABLE pages (
    project_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    PRIMARY KEY (project_id, page_number),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Project details (consolidated storage)
CREATE TABLE project_details (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    pages_json TEXT NOT NULL,
    character_markdown TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- Video timeline layers
CREATE TABLE video_timeline (
    project_id TEXT NOT NULL,
    layer_index INTEGER NOT NULL,
    clip_data TEXT NOT NULL,
    PRIMARY KEY (project_id, layer_index)
);
```

**Inspecting Database:**

```bash
# Using sqlite3 CLI
sqlite3 data/mangaeditor.db

# Or use a GUI tool like DB Browser for SQLite
```

### Adding New Features

#### Adding a New API Endpoint

1. Choose the appropriate module:
   - `mangaeditor.py` - Manga-related features
   - `videoeditor.py` - Video-related features
   - `main.py` - Standalone features

2. Add the endpoint:

```python
# In mangaeditor.py
@router.post("/api/project/{project_id}/custom-action")
async def custom_action(project_id: str, payload: Dict[str, Any]):
    # Your logic here
    return JSONResponse({"status": "success"})
```

#### Adding Database Tables

Edit `mangaeditor.py` - `EditorDB.init_schema()`:

```python
c.execute(
    """
    CREATE TABLE IF NOT EXISTS my_table (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    """
)
```

### Code Style

**Python:**
- Follow PEP 8
- Use type hints
- Add docstrings for public functions

**JavaScript:**
- Use camelCase for variables
- Add comments for complex logic
- Keep functions focused

### Testing

Currently, automated tests are not implemented. Contributions welcome!

**Manual Testing:**
1. Test each API endpoint with curl or Postman
2. Test UI workflows in browser
3. Check database integrity after operations
4. Test headless recording with various projects

---

## 🐛 Troubleshooting

### Common Issues

#### "PANEL_API_URL not configured"
**Cause:** Missing environment variable  
**Solution:** Add `PANEL_API_URL=...` to `.env` file

#### "Gemini not available"
**Cause:** Missing or invalid Google API key  
**Solution:**
- Add `GOOGLE_API_KEY=...` to `.env`
- Verify key at [Google AI Studio](https://makersuite.google.com/app/apikey)

#### Panel detection fails
**Cause:** External API unreachable or wrong format  
**Solution:**
- Verify `PANEL_API_URL` is accessible
- Test API with curl
- Check server logs for detailed errors

#### Headless recording fails
**Cause:** Playwright not installed  
**Solution:**
```bash
pip install playwright
playwright install chromium
```

#### FFmpeg warnings during recording
**Cause:** FFmpeg not installed (optional for post-processing)  
**Solution:** 
- Install FFmpeg to enable metadata fixes on rendered videos
- Or ignore warnings - recordings work fine without FFmpeg
- Headless recording produces valid WebM files either way

#### CORS errors
**Cause:** Accessing from different origin  
**Solution:** Set `ALLOW_ORIGINS=http://your-origin.com` in `.env`

#### Database locked
**Cause:** Concurrent writes  
**Solution:** Wait and retry, or restart server

#### TTS not generating audio
**Cause:** Missing TTS API configuration or panel editor not used  
**Solution:**
- Set `TTS_API_URL` in `.env` file
- Navigate to Panel Editor: `/editor/panel-editor/{project_id}`
- Use "Synthesize Page" or "Synthesize All" buttons
- Check server logs for TTS API errors

#### Panels have no audio in video editor
**Cause:** TTS not generated or audio not attached to panels  
**Solution:**
- Go to Panel Editor for the project
- Generate TTS using the dedicated interface
- Verify audio files are attached (play buttons should work)
- Use "Backfill" to generate missing audio

#### Looking for client-side export option?
**Note:** Previous versions supported FFmpeg.js client-side rendering, but this has been removed.  
**Current:** Only headless browser recording is available (faster, more reliable, better audio sync)  
**Why:** Headless recording solves browser audio capture limitations and provides better performance

### Debug Logging

Server logs important events to console:
- API configuration
- Database operations
- Panel detection results
- Rendering progress
- Errors with stack traces

**Enable verbose logging:**

```python
# In main.py or mangaeditor.py
logging.basicConfig(level=logging.DEBUG)
```

### Performance Tips

**For Large Projects:**
- Use headless recording instead of client-side export
- Process pages individually instead of batch
- Reduce panel image resolution if needed

**For Better Narration:**
- Use detailed character notes
- Provide clear panel images
- Use higher-quality Gemini models

---

## 🏗️ Architecture

### Technology Stack

**Backend:**
- FastAPI - Web framework
- SQLite - Database
- Pillow - Image processing
- Google Generative AI - Narrative generation
- Playwright - Headless browser automation

**Frontend:**
- Vanilla JavaScript - No framework overhead
- Tailwind CSS - Utility-first styling
- WebGL - Canvas rendering for real-time preview
- Web Audio API - Multi-track audio playback

### Data Flow

#### Manga Processing Pipeline

```
1. Upload Images (Dashboard)
   ↓
2. Create Project (SQLite)
   ↓
3. Detect Panels (External API)
   ├── Send images
   ├── Receive panel crops (ZIP)
   └── Save to project directory
   ↓
4. Generate Narration (Google Gemini)
   ├── Send panel images + context
   └── Save to database
   ↓
5. Panel Editor (/editor/panel-editor/{project_id}) ← CRITICAL STEP
   ├── Review and edit panel text
   ├── Generate TTS audio
   ├── Upload custom audio
   ├── Configure panel settings
   └── Preview audio playback
   ↓
6. [Optional] Additional TTS Processing
   ├── Send text to TTS API
   ├── Batch generate for pages
   └── Backfill missing audio
   ↓
7. Export to Video Editor
   ├── Timeline uses panel images + audio
   └── Apply effects and transitions
```

**Note:** The Panel Editor step is integral to the workflow, especially for TTS generation and audio management before creating videos.

#### Video Rendering Pipeline

```
1. Build Timeline
   ├── Add clips to layers
   ├── Configure effects
   └── Save to database
   ↓
2. Preview (Browser)
   ├── Canvas rendering
   ├── Audio mixing
   └── Real-time playback
   ↓
3. Render
   └── Headless Browser Recording
       ├── Launch Playwright
       ├── Record canvas + audio in Chromium
       ├── Save to renders/
       └── [Optional] FFmpeg metadata post-process
```

### Security Considerations

**Current Implementation:**
- CORS configuration via environment
- COOP/COEP headers for SharedArrayBuffer
- SQLite parameterized queries (prevents SQL injection)
- File type validation on upload

**Production Recommendations:**
- Add user authentication
- Implement rate limiting
- Restrict file upload sizes
- Add input validation middleware
- Use HTTPS only
- Implement CSRF protection

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

### Reporting Bugs

Include in your bug report:
- Python version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output
- Screenshots (if UI-related)

### Feature Requests

For new features:
- Describe the use case
- Explain why it's valuable
- Suggest implementation approach
- Consider project scope

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

**Before submitting:**
- Follow existing code style
- Add comments for complex logic
- Update documentation if needed
- Test all affected features

---

## 📄 License

This project is open source. Please check individual dependencies for their respective licenses.

### Key Dependencies Licenses

- **FastAPI** - MIT License
- **Pillow** - HPND License
- **Google Generative AI** - Apache 2.0
- **FFmpeg.js** - LGPL 2.1+
- **Playwright** - Apache 2.0
- **Tailwind CSS** - MIT License

---

## 🙏 Acknowledgments

- **[Google Gemini](https://ai.google.dev/)** - AI-powered narrative generation
- **[MagiV3](https://huggingface.co/ragavsachdeva/magiv3)** - Panel detection model reference
- **[FFmpeg.js](https://github.com/ffmpegwasm/ffmpeg.wasm)** - In-browser video processing
- **[Playwright](https://playwright.dev/)** - Headless browser automation
- **[Tailwind CSS](https://tailwindcss.com/)** - UI styling framework

---

## 📞 Support

### Getting Help

1. Check this README thoroughly
2. Review `TODO.md` for known issues
3. Search existing issues (if using GitHub)
4. Check server logs for errors

### Useful Resources

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Playwright Documentation](https://playwright.dev/)
- [Google Gemini API](https://ai.google.dev/)
- [FFmpeg.js Documentation](https://github.com/ffmpegwasm/ffmpeg.wasm)

---

## Project Status

**Current Version:** Development (2024-2025)  
**Status:** Active Development  
**Repository:** [VideoAI](https://github.com/pavankavade/VideoAI)

---

**Built with ❤️ for manga creators and storytellers**

Transform your manga into engaging narrated videos!

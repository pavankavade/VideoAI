# VideoAI Application - Feature Inventory & Analysis

**Purpose**: Complete inventory of all features, functions, and code blocks in the VideoAI application with analysis of necessity, priority, and potential for removal.

**Last Updated**: [Generated via automated analysis]

---

## Table of Contents
1. [Backend Components (FastAPI/Python)](#backend-components)
2. [Frontend Components (JavaScript)](#frontend-components)
3. [API Endpoints](#api-endpoints)
4. [Dependencies Analysis](#dependencies-analysis)
5. [Configuration & Environment](#configuration-environment)
6. [Recommendations Summary](#recommendations-summary)

---

## Backend Components (FastAPI/Python)

### Core Application Setup

#### `FastAPI App Configuration` (lines 103-123)
- **Purpose**: Initializes FastAPI application with static file mounting and CORS
- **Features**:
  - Mounts `/static`, `/uploads`, `/manga_projects` directories
  - Configurable CORS for development/production
  - Template rendering setup
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required - Core application infrastructure
- **Priority**: Keep
- **Notes**: Essential for app to function

#### `Environment & Directory Setup` (lines 36-47)
- **Purpose**: Sets up base directories and ensures they exist
- **Features**:
  - Creates `uploads/`, `templates/`, `static/`, `manga_projects/`, `cv_model/` directories
  - Defines base paths for the application
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep
- **Notes**: Application cannot run without these directories

#### `Logging Configuration` (lines 24-33)
- **Purpose**: Sets up application logging and loads environment variables
- **Features**:
  - Basic logging setup
  - Optional `.env` file loading via python-dotenv
- **Necessity**: **HIGH** 📊
- **Status**: Required for debugging and monitoring
- **Priority**: Keep
- **Notes**: Essential for troubleshooting

---

### AI/ML Integration

#### `Google Gemini API Integration` (lines 62-100)
- **Purpose**: Multi-key support for Google Gemini API with round-robin selection
- **Features**:
  - Accepts multiple API keys (comma-separated)
  - Thread-safe key rotation
  - Fallback support if keys not provided
- **Necessity**: **HIGH** 📊
- **Status**: Required for AI narration generation
- **Priority**: Keep
- **Notes**: Core feature for narrative generation. Can be made optional with proper feature flags.

#### `call_gemini()` function (line 1520)
- **Purpose**: Makes API calls to Google Gemini for narrative generation
- **Features**:
  - REST API based (not SDK based for multi-key support)
  - Supports system instructions and image inputs
  - JSON response parsing
- **Necessity**: **HIGH** 📊
- **Status**: Required for narrative generation
- **Priority**: Keep
- **Notes**: Primary AI integration point

#### `call_gemini_async()` function (line 1608)
- **Purpose**: Async wrapper for Gemini API calls
- **Necessity**: **MEDIUM** 🔄
- **Status**: Optional - wraps synchronous call
- **Priority**: Review/Refactor
- **Notes**: Could be consolidated with main call_gemini function

---

### Panel Detection System

#### `call_external_panel_api()` function (line 678)
- **Purpose**: Calls external panel detection API (e.g., MagiV3)
- **Features**:
  - Sends images to external API
  - Supports border configuration parameters
  - Handles various response formats
- **Necessity**: **HIGH** 📊
- **Status**: Core feature for panel detection
- **Priority**: Keep
- **Notes**: Critical for automated panel detection workflow

#### `save_crops_from_external()` function (line 708)
- **Purpose**: Processes and saves panel crops from external API responses
- **Features**:
  - Handles JSON, ZIP, and image responses
  - Saves panels to project directories
  - Creates metadata for each panel
- **Necessity**: **HIGH** 📊
- **Status**: Required for panel workflow
- **Priority**: Keep
- **Notes**: Essential for panel processing pipeline

#### `run_panel_detector()` function (line 1509)
- **Purpose**: Local panel detection fallback (currently bypassed)
- **Features**:
  - Placeholder for local detection methods
  - LayoutParser, YOLOv8, OWL-ViT, DeepPanel, OpenCV options
- **Necessity**: **LOW** ⚡
- **Status**: Currently unused/bypassed
- **Priority**: **REMOVE or make explicitly optional**
- **Notes**: Not actively used. External API is preferred. Heavy dependencies for unused code.

---

### Image Processing & Effects

#### `create_rounded_rectangle_mask()` function (line 547)
- **Purpose**: Creates rounded rectangle masks for image borders
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used for panel borders
- **Priority**: Keep but consolidate
- **Notes**: **DUPLICATE** - Same function exists at line 2877. Should be consolidated into single implementation.

#### `add_curved_border()` function (line 561)
- **Purpose**: Adds curved borders to panel images
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used for visual effects
- **Priority**: Keep but consolidate
- **Notes**: **DUPLICATE** - Same function exists at line 2908. Should be consolidated.

#### `crop_panels()` function (line 1441)
- **Purpose**: Crops panels from full page image based on bounding boxes
- **Necessity**: **HIGH** 📊
- **Status**: Required for panel extraction
- **Priority**: Keep
- **Notes**: Core image processing function

#### `save_panel_crops()` function (line 1449)
- **Purpose**: Saves cropped panels to disk
- **Necessity**: **HIGH** 📊
- **Status**: Required
- **Priority**: Keep
- **Notes**: Essential for panel workflow

#### `save_panel_crops_to_project()` function (line 1479)
- **Purpose**: Saves panels with project-specific directory structure
- **Necessity**: **HIGH** 📊
- **Status**: Required
- **Priority**: Keep
- **Notes**: Better organized than save_panel_crops, possibly redundant with above

---

### Video Rendering & Effects

#### `apply_panel_transitions()` function (line 795)
- **Purpose**: Applies transition effects between video panels
- **Features**:
  - Slide book transitions
  - Fade transitions
  - Configurable timing
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used in video generation
- **Priority**: Keep if video feature is needed
- **Notes**: Part of video rendering pipeline - may be removed if video feature is not core

#### `apply_transition_effect()` function (line 860)
- **Purpose**: Generic transition effect applicator
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used in video rendering
- **Priority**: Keep with video features
- **Notes**: Depends on MoviePy (commented out imports suggest this is under review)

#### `apply_slide_book_transition()` function (line 886)
- **Purpose**: Specific slide book page turn effect
- **Necessity**: **LOW** ⚡
- **Status**: Nice-to-have visual effect
- **Priority**: **Review/Optional**
- **Notes**: Complex effect that may not be essential

#### `apply_fade_transition()` function (line 930)
- **Purpose**: Fade transition between panels
- **Necessity**: **MEDIUM** 🔄
- **Status**: Common video transition
- **Priority**: Keep with video features

---

### Project Management

#### `get_manga_projects()` function (line 451)
- **Purpose**: Retrieves all manga projects from storage
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep
- **Notes**: Core data access function

#### `save_manga_projects()` function (line 462)
- **Purpose**: Persists manga projects to JSON file
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep but improve
- **Notes**: **NEEDS IMPROVEMENT**: Not concurrency-safe. Should use file locking or atomic writes (noted in TODO.md)

#### `create_manga_project()` function (line 471)
- **Purpose**: Creates new manga project with files
- **Features**:
  - Generates unique project ID
  - Sets up project structure with pages
  - Initializes workflow tracking
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep
- **Notes**: Core project creation logic

#### `get_manga_project()` function (line 521)
- **Purpose**: Retrieves specific project by ID
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep

#### `update_manga_project()` function (line 526)
- **Purpose**: Updates project with new data
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep
- **Notes**: Core data persistence

#### `delete_manga_project()` function (line 639)
- **Purpose**: Deletes project and associated files
- **Necessity**: **HIGH** 📊
- **Status**: Required for project management
- **Priority**: Keep

---

### Utility Functions

#### `_parse_api_keys()` function (line 71)
- **Purpose**: Parses comma-separated API keys from environment
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for multi-key support
- **Priority**: Keep
- **Notes**: Good for API key rotation

#### `_next_gemini_key()` function (line 92)
- **Purpose**: Thread-safe round-robin key selection
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used with multi-key setup
- **Priority**: Keep with Gemini integration

#### `_normalize_quotes_and_commas()` function (line 352)
- **Purpose**: Normalizes quotes and commas in JSON text
- **Necessity**: **LOW** ⚡
- **Status**: JSON parsing helper
- **Priority**: Review
- **Notes**: Workaround for malformed JSON - may indicate upstream data quality issues

#### `parse_json_array_from_text()` function (line 366)
- **Purpose**: Robust JSON array parsing from text
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used for API response parsing
- **Priority**: Keep
- **Notes**: Handles various JSON formats gracefully

#### `normalize_panel_id()` function (line 402)
- **Purpose**: Normalizes panel IDs to consistent format
- **Necessity**: **HIGH** 📊
- **Status**: Data consistency
- **Priority**: Keep

#### `extract_page_number()` function (line 416)
- **Purpose**: Extracts page number from filename
- **Necessity**: **HIGH** 📊
- **Status**: Required for page ordering
- **Priority**: Keep

#### `sort_files_by_page_number()` function (line 432)
- **Purpose**: Sorts files by extracted page numbers
- **Necessity**: **HIGH** 📊
- **Status**: Required for proper page ordering
- **Priority**: Keep

#### `get_sorted_pages_info()` function (line 439)
- **Purpose**: Creates sorted page info structure
- **Necessity**: **HIGH** 📊
- **Status**: Required for project structure
- **Priority**: Keep

---

### Progress Tracking (SSE)

#### `_get_progress_channel()` function (line 133)
- **Purpose**: Creates/retrieves progress channel for job tracking
- **Necessity**: **MEDIUM** 🔄
- **Status**: Nice-to-have for UX
- **Priority**: Keep
- **Notes**: Enables real-time progress updates in UI

#### `push_progress()` function (line 146)
- **Purpose**: Pushes progress events to SSE channel
- **Necessity**: **MEDIUM** 🔄
- **Status**: UX enhancement
- **Priority**: Keep
- **Notes**: Good for long-running operations

#### `_sse_format()` function (line 143)
- **Purpose**: Formats messages for Server-Sent Events
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used with progress tracking
- **Priority**: Keep with SSE features

---

### Global Configuration Variables

#### Effect & Transition Constants (lines 49-60)
- **Purpose**: Global configuration for effects and transitions
- **Variables**:
  - `EFFECT_ANIMATION_SPEED`
  - `EFFECT_SCREEN_MARGIN`
  - `EFFECT_ZOOM_AMOUNT`
  - `EFFECT_MAX_DURATION`
  - `PANEL_BASE_SIZE`
  - `EFFECT_SMOOTHING`
  - `TRANSITION_DURATION`
  - `TRANSITION_OVERLAP`
  - `TRANSITION_SMOOTHING`
- **Necessity**: **MEDIUM** 🔄
- **Status**: Used for video effects
- **Priority**: Keep but refactor
- **Notes**: **TODO ITEM**: Should be moved to single config source accessible by both server and client (see TODO.md)

---

## API Endpoints

### Frontend Page Routes

#### `GET /` (line 1612)
- **Purpose**: Main dashboard/index page
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required - Main entry point
- **Priority**: Keep

#### `GET /manga/{project_id}` (line 1616)
- **Purpose**: Manga project view/editor page
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required - Main workflow page
- **Priority**: Keep

#### `GET /video-editor` (line 212)
- **Purpose**: Video editor interface
- **Necessity**: **MEDIUM** 🔄
- **Status**: Optional advanced feature
- **Priority**: Keep if video generation is core feature
- **Notes**: Depends on user needs - could be made optional

---

### Project Management API

#### `GET /api/manga` (line 1623)
- **Purpose**: List all manga projects
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep

#### `POST /api/manga` (line 1651)
- **Purpose**: Create new manga project
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep

#### `GET /api/manga/{project_id}` (line 1628)
- **Purpose**: Get specific project details
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep

#### `GET /api/manga/{project_id}/pages` (line 1636)
- **Purpose**: Get page sorting information
- **Necessity**: **HIGH** 📊
- **Status**: Required for proper page ordering
- **Priority**: Keep

#### `PUT /api/manga/{project_id}` (line 1685)
- **Purpose**: Update project
- **Necessity**: **CRITICAL** ⚠️
- **Status**: Required
- **Priority**: Keep

#### `DELETE /api/manga/{project_id}` (line 1693)
- **Purpose**: Delete project
- **Necessity**: **HIGH** 📊
- **Status**: Required for project management
- **Priority**: Keep

---

### Narrative Generation API

#### `POST /api/manga/{project_id}/narrative` (line 1701)
- **Purpose**: Generate AI narrative for entire project
- **Necessity**: **HIGH** 📊
- **Status**: Core AI feature
- **Priority**: Keep
- **Notes**: Depends on Gemini API availability

---

### Panel Detection API

#### `POST /api/manga/{project_id}/panels` (line 1814)
- **Purpose**: Detect panels for all images in project
- **Necessity**: **HIGH** 📊
- **Status**: Core feature
- **Priority**: Keep

#### `POST /api/manga/{project_id}/panels/redo` (line 1907)
- **Purpose**: Redo panel detection for entire project
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for corrections
- **Priority**: Keep

#### `POST /api/manga/{project_id}/panels/page/{page_number}/redo` (line 1912)
- **Purpose**: Redo panel detection for single page
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for corrections
- **Priority**: Keep

#### `POST /api/manga/update-panels` (line 2004)
- **Purpose**: Update panel data (reorder, delete)
- **Necessity**: **HIGH** 📊
- **Status**: Required for manual corrections
- **Priority**: Keep

---

### Text-to-Panel Matching API

#### `POST /api/manga/{project_id}/text-matching` (line 2090)
- **Purpose**: Match narrative text to detected panels
- **Necessity**: **HIGH** 📊
- **Status**: Core feature for panel-text alignment
- **Priority**: Keep

#### `POST /api/manga/{project_id}/text-matching/page/{page_number}/redo` (line 2271)
- **Purpose**: Redo text matching for single page
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for corrections
- **Priority**: Keep

---

### Text-to-Speech API

#### `POST /api/manga/{project_id}/tts/synthesize` (line 2410)
- **Purpose**: Synthesize TTS for single text
- **Necessity**: **MEDIUM** 🔄
- **Status**: Optional feature
- **Priority**: Review
- **Notes**: Requires external TTS API. May not be essential.

#### `POST /api/manga/{project_id}/panel-tts/synthesize` (line 2459)
- **Purpose**: Synthesize TTS for individual panels
- **Necessity**: **MEDIUM** 🔄
- **Status**: Optional feature
- **Priority**: Review
- **Notes**: Requires external TTS API. Could be removed if TTS not needed.

---

### Video Rendering API

#### `POST /api/video/render` (line 948)
- **Purpose**: Render video from timeline/clips
- **Complexity**: Very complex (500+ lines)
- **Features**:
  - Multi-layer timeline support
  - Transitions and effects
  - Audio composition
  - Various zoom and pan effects
- **Necessity**: **LOW-MEDIUM** ⚡
- **Status**: Advanced feature
- **Priority**: **Review - possibly optional**
- **Notes**: Heavy feature with MoviePy dependency. Consider if video output is core requirement.

---

### Panel Effects API

#### `POST /api/panel/add-border` (line 604 & 2944)
- **Purpose**: Add borders to panel images
- **Necessity**: **LOW** ⚡
- **Status**: Visual enhancement
- **Priority**: **CONSOLIDATE - DUPLICATE ENDPOINT**
- **Notes**: **CRITICAL**: This endpoint is defined TWICE (lines 604 and 2944). Should be consolidated to single implementation.

---

### Configuration API

#### `GET /api/effect-config` (line 2821)
- **Purpose**: Get current effect configuration
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for video editor
- **Priority**: Keep with video features

#### `POST /api/effect-config` (line 2836)
- **Purpose**: Update effect configuration
- **Necessity**: **MEDIUM** 🔄
- **Status**: Useful for customization
- **Priority**: Keep with video features

---

### Upload & Processing API

#### `POST /upload` (line 2671)
- **Purpose**: Upload manga page images
- **Necessity**: **HIGH** 📊
- **Status**: Core feature
- **Priority**: Keep

#### `POST /upload-json` (line 2703)
- **Purpose**: Upload pre-generated JSON narrative data
- **Necessity**: **MEDIUM** 🔄
- **Status**: Alternative workflow
- **Priority**: Keep
- **Notes**: Useful for importing existing narratives

#### `POST /process-chapter` (line 2772)
- **Purpose**: Process entire chapter/project
- **Necessity**: **MEDIUM** 🔄
- **Status**: Batch processing
- **Priority**: Review
- **Notes**: May overlap with other endpoints

---

### Project Persistence API

#### `POST /save_project` (line 250)
- **Purpose**: Save video editor project state
- **Necessity**: **MEDIUM** 🔄
- **Status**: Required for video editor
- **Priority**: Keep with video features

---

### Testing & Debug API

#### `GET /api/test` (line 2452)
- **Purpose**: Test endpoint to verify server is working
- **Necessity**: **LOW** ⚡
- **Status**: Debug/testing only
- **Priority**: **REMOVE in production** or add feature flag

#### `GET /test-video-editor-project/{project_id}` (line 192)
- **Purpose**: Test endpoint for video editor project handling
- **Necessity**: **LOW** ⚡
- **Status**: Debug/testing only
- **Priority**: **REMOVE in production** or add feature flag

---

### Progress Streaming API

#### `GET /api/progress/stream/{job_id}` (line 167)
- **Purpose**: Server-Sent Events stream for job progress
- **Necessity**: **MEDIUM** 🔄
- **Status**: UX enhancement
- **Priority**: Keep
- **Notes**: Good for long-running operations, improves user experience

---

## Frontend Components (JavaScript)

### Main Dashboard (script.js)

#### File: `/static/script.js` (~388 lines)

**Core Functions:**

1. **`setupEventListeners()`** (line 11)
   - Purpose: Sets up drag & drop and file input handlers
   - Necessity: **HIGH** 📊
   - Priority: Keep
   
2. **`loadMangaProjects()`** (line 268)
   - Purpose: Loads projects from API
   - Necessity: **CRITICAL** ⚠️
   - Priority: Keep

3. **`renderMangaTable()`** (line 288)
   - Purpose: Renders project list table
   - Necessity: **CRITICAL** ⚠️
   - Priority: Keep

4. **`handleAddManga()`** (line 160)
   - Purpose: Handles project creation form
   - Necessity: **CRITICAL** ⚠️
   - Priority: Keep

5. **`deleteManga()`** (line 334)
   - Purpose: Deletes manga project
   - Necessity: **HIGH** 📊
   - Priority: Keep

6. **Theme Functions** (lines 362-386)
   - `initializeTheme()`, `toggleTheme()`, `setTheme()`
   - Purpose: Dark/light mode support
   - Necessity: **LOW-MEDIUM** ⚡
   - Priority: Keep (nice UX feature)

7. **File Upload Handlers** (lines 60-124)
   - `handleFiles()`, `handleJsonFiles()`
   - Purpose: Process file uploads
   - Necessity: **HIGH** 📊
   - Priority: Keep

**Analysis**: Core dashboard functionality. All functions are essential for basic project management.

---

### Manga View Editor (manga_view.js)

#### File: `/static/manga_view.js` (~5686 lines - VERY LARGE)

**Core Functions:**

1. **`generateNarrative()`** (line 107)
   - Purpose: Triggers AI narrative generation
   - Necessity: **HIGH** 📊
   - Priority: Keep

2. **`detectPanels()`** (line 152)
   - Purpose: Triggers panel detection
   - Necessity: **HIGH** 📊
   - Priority: Keep

3. **`matchTextToPanels()`** (line 362)
   - Purpose: Matches narrative to panels
   - Necessity: **HIGH** 📊
   - Priority: Keep

4. **`loadExistingNarration()`** (line 772)
   - Purpose: Loads saved narrative
   - Necessity: **HIGH** 📊
   - Priority: Keep

5. **`loadExistingPanels()`** (line 799)
   - Purpose: Loads saved panels
   - Necessity: **HIGH** 📊
   - Priority: Keep

6. **`openPanelEditor()`** (line 1185)
   - Purpose: Opens panel editing interface
   - Necessity: **HIGH** 📊
   - Priority: Keep

7. **`loadPanelEditorContent()`** (line 1465)
   - Purpose: Loads panel editor UI
   - Necessity: **HIGH** 📊
   - Priority: Keep

8. **Carousel Functions** (lines 56-106)
   - `updateCarouselControls()`, `showImage()`, `nextImage()`, `previousImage()`
   - Purpose: Image carousel navigation
   - Necessity: **MEDIUM** 🔄
   - Priority: Keep (good UX)

9. **Fullscreen Functions** (lines 313-362, 811-831)
   - `openFullscreenCarousel()`, `viewPanelFullscreen()`, `closeFullscreen()`
   - Purpose: Fullscreen image viewing
   - Necessity: **LOW-MEDIUM** ⚡
   - Priority: Keep (UX enhancement)

10. **TTS Functions** (lines 452-484)
    - `loadExistingTTS()`, `loadAllSavedAudio()`
    - Purpose: Loads TTS audio
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep if TTS is needed

11. **IndexedDB Functions** (lines 1716-1850+)
    - `openDB()`, `saveToIndexedDB()`, `getFromIndexedDB()`, `deleteFromIndexedDB()`
    - Purpose: Local storage for audio/data
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep for offline capability

12. **Audio Management** (lines 1013-1181)
    - `convertToBlob()`, `getAudioSrc()`, `uploadAudioBlob()`, `sanitizeTTSForSave()`
    - Purpose: Audio handling utilities
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep if TTS is needed

13. **JSON Upload** (lines 857-994)
    - `toggleJsonUpload()`, `uploadJsonText()`
    - Purpose: Upload pre-generated narratives
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep (alternative workflow)

14. **Workflow Status** (line 731)
    - `updateWorkflowStatus()`
    - Purpose: Updates workflow step indicators
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep (UX)

15. **Effect Migration** (line 9)
    - `migrateProjectEffects()`
    - Purpose: Migrates old effect configs
    - Necessity: **LOW** ⚡
    - Priority: **Remove after migration period**

**Analysis**: Very large file (~5700 lines). Core features are essential, but some features (TTS, fullscreen, IndexedDB) could be made optional modules.

---

### Video Editor (video_editor.js)

#### File: `/static/video_editor.js` (~3404 lines - VERY LARGE)

**Core Functions:**

1. **Canvas/Preview System** (lines 622-731)
   - `initCanvasPreview()`, `togglePlayback()`, `startRaf()`, `stopRaf()`
   - Purpose: Video preview rendering
   - Necessity: **CRITICAL** ⚠️ (for video editor)
   - Priority: Keep if video editor is needed

2. **Rendering Functions** (lines 733-1028)
   - `drawFrame()`, `renderClipToCanvas()`, `renderClipWithTransition()`
   - `renderSlideBookTransition()`, `renderFadeTransition()`, `renderWipeTransition()`
   - Purpose: Frame-by-frame video rendering
   - Necessity: **CRITICAL** ⚠️ (for video editor)
   - Priority: Keep if video editor is needed

3. **Clip Management** (lines 2472-2538)
   - `removeClip()`, `selectClip()`, `updateClipDuration()`
   - Purpose: Timeline clip management
   - Necessity: **CRITICAL** ⚠️ (for video editor)
   - Priority: Keep if video editor is needed

4. **Layer System** (lines 2261-2471)
   - `onDropToLayer()`, `insertClipIntoLayerAt()`, `fixLayerOverlaps()`
   - `selectLayerClip()`, `removeClipFromLayer()`, `addLayer()`, `removeLayer()`
   - Purpose: Multi-layer timeline support
   - Necessity: **HIGH** 📊 (for video editor)
   - Priority: Keep if video editor is needed

5. **Timeline UI** (lines 1825-1993)
   - `renderTimeline()`, `onClipDragStart()`, `onClipDragMove()`, `onClipDragEnd()`
   - Purpose: Timeline drag & drop interface
   - Necessity: **HIGH** 📊 (for video editor)
   - Priority: Keep if video editor is needed

6. **Transform/Crop Controls** (lines 1108-1172)
   - `onCanvasPointerDown()`, `onCanvasPointerMove()`, `onCanvasPointerUp()`
   - Purpose: Interactive transform/crop handles
   - Necessity: **MEDIUM** 🔄 (for video editor)
   - Priority: Keep if video editor is needed

7. **Audio System** (lines 2232-2258, 1199-1334)
   - `ensureAudioContext()`, `fetchAudioBuffer()`, `scheduleAudioForPlayback()`
   - Purpose: WebAudio-based preview
   - Necessity: **HIGH** 📊 (for video editor)
   - Priority: Keep if video editor is needed

8. **Project Persistence** (lines 2080-2228)
   - `saveProject()`, `testSaveFunction()`
   - Purpose: Save video editor state
   - Necessity: **CRITICAL** ⚠️ (for video editor)
   - Priority: Keep if video editor is needed

9. **Asset Management** (lines 1345-1748)
   - `preloadImageAssets()`, `preloadAudioAssets()`
   - Purpose: Asset preloading and caching
   - Necessity: **HIGH** 📊 (for video editor)
   - Priority: Keep if video editor is needed

10. **Effect Configuration** (lines 114-136)
    - `loadEffectConfig()`, `updateEffectConfig()`
    - Purpose: Load/update effect settings
    - Necessity: **MEDIUM** 🔄
    - Priority: Keep with video editor

11. **Export Function** (lines ~2800+)
    - `onExport()`
    - Purpose: Export final video
    - Necessity: **CRITICAL** ⚠️ (for video editor)
    - Priority: Keep if video editor is needed

**Analysis**: Entire file is dedicated to video editor. If video editing is not a core feature, this entire module could be made optional or removed. Very complex implementation (~3400 lines).

---

## Dependencies Analysis

### Core Dependencies (CRITICAL ⚠️)

1. **fastapi** - Web framework
   - Status: **REQUIRED**
   - Usage: Core application framework
   
2. **uvicorn** - ASGI server
   - Status: **REQUIRED**
   - Usage: Runs the application
   
3. **python-multipart** - File upload support
   - Status: **REQUIRED**
   - Usage: File uploads
   
4. **Pillow** - Image processing
   - Status: **REQUIRED**
   - Usage: Image manipulation, panel cropping
   
5. **jinja2** - Template engine
   - Status: **REQUIRED**
   - Usage: HTML rendering
   
6. **python-dotenv** - Environment config
   - Status: **REQUIRED**
   - Usage: Configuration management

### AI/API Dependencies (HIGH 📊)

7. **google-generativeai** - Gemini API client
   - Status: **REQUIRED** for AI features
   - Usage: Narrative generation
   - Notes: Can be made optional with feature flags
   
8. **requests** - HTTP client
   - Status: **REQUIRED**
   - Usage: External panel detection API calls

### Optional/Unused Dependencies (REVIEW ⚡)

9. **layoutparser** - Layout analysis
   - Status: **UNUSED** (bypassed for external API)
   - Priority: **REMOVE** unless local detection needed
   - Impact: Reduces installation complexity
   
10. **ultralytics** - YOLOv8 models
    - Status: **UNUSED** (bypassed for external API)
    - Priority: **REMOVE** unless local detection needed
    - Impact: Large dependency, reduces installation size
    
11. **opencv-python-headless** - OpenCV
    - Status: **UNUSED** (bypassed for external API)
    - Priority: **REMOVE** unless local detection needed
    
12. **transformers** - Hugging Face models
    - Status: **UNUSED** (bypassed for external API)
    - Priority: **REMOVE** unless local detection needed
    - Impact: Very large dependency
    
13. **accelerate** - Model acceleration
    - Status: **UNUSED**
    - Priority: **REMOVE** unless local detection needed
    
14. **tensorflow/tensorflow-cpu** - TensorFlow
    - Status: **UNUSED** (bypassed for external API)
    - Priority: **REMOVE** unless local detection needed
    - Impact: VERY large dependency

### Video Dependencies (CONDITIONAL 🔄)

15. **moviepy** - Video editing
    - Status: **PARTIALLY USED**
    - Priority: Keep if video feature is core, otherwise **REMOVE**
    - Notes: Imports are commented out in main.py, suggesting it's under review
    
16. **imageio-ffmpeg** - FFmpeg wrapper
    - Status: **USED** with MoviePy
    - Priority: Keep with video features

### Network Dependencies (CONDITIONAL 🔄)

17. **pyngrok** - Ngrok tunneling
    - Status: **OPTIONAL** (development feature)
    - Priority: Keep for development, disable in production
    - Usage: Exposes local server publicly

### Frontend Dependencies (package.json)

18. **@ffmpeg/ffmpeg** & **@ffmpeg/core**
    - Status: **USED** (video editor)
    - Priority: Keep if video editor is needed
    - Impact: Large client-side dependency

---

## Configuration & Environment

### Environment Variables

#### CRITICAL ⚠️
- `GOOGLE_API_KEY` / `GOOGLE_API_KEYS` - Gemini API keys (required for AI features)
- `PANEL_API_URL` - External panel detection API URL (required for panel detection)

#### HIGH 📊
- `GEMINI_MODEL` - Model selection (default: gemini-2.5-flash)
- `TTS_API_URL` - Text-to-speech API URL (required for TTS features)

#### MEDIUM 🔄
- `PANEL_API_MODE` - API response mode (auto/json/zip/image)
- `PANEL_API_ADD_BORDER` - Add borders to panels
- `PANEL_API_BORDER_WIDTH` - Border width
- `PANEL_API_BORDER_COLOR` - Border color
- `PANEL_API_CURVED_BORDER` - Curved borders
- `PANEL_API_CORNER_RADIUS` - Corner radius
- `ALLOW_ORIGINS` - CORS configuration

#### OPTIONAL ⚡
- `NGROK_APP_URL` - Ngrok domain
- `NGROK_APP_AUTHTOKEN` - Ngrok auth token
- `REQUIRE_GEMINI` - Strict Gemini requirement flag

---

## Recommendations Summary

### 🔴 CRITICAL Issues (Fix Immediately)

1. **Duplicate Code**:
   - `create_rounded_rectangle_mask()` - duplicated at lines 547 & 2877
   - `add_curved_border()` - duplicated at lines 561 & 2908
   - `/api/panel/add-border` endpoint - duplicated at lines 604 & 2944
   - **Action**: Consolidate to single implementation

2. **Concurrency Safety**:
   - `save_manga_projects()` lacks file locking
   - **Action**: Implement atomic writes or file locking (noted in TODO.md)

3. **Security**:
   - Ensure `.env` is git-ignored
   - No input validation on file uploads (path traversal risk)
   - **Action**: Add validation and security checks

### 🟡 HIGH Priority (Review & Decide)

1. **Unused Dependencies** (Heavy impact on installation):
   - **Remove**: layoutparser, ultralytics, opencv-python-headless, transformers, accelerate, tensorflow
   - **Reasoning**: External panel detection API is used instead
   - **Impact**: Significantly reduces installation size and complexity
   - **Keep only if**: Planning to add local panel detection fallback

2. **Video Editor** (Large codebase ~3400 lines):
   - **Assess**: Is video generation a core feature?
   - **If NO**: Remove video_editor.js, video rendering endpoints, MoviePy dependencies
   - **If YES**: Keep but improve documentation and error handling
   - **Impact**: Could remove ~30% of codebase if not needed

3. **TTS Features**:
   - **Assess**: Is text-to-speech needed?
   - **If NO**: Remove TTS endpoints and related code
   - **Impact**: Simplifies audio handling

### 🟢 MEDIUM Priority (Refactor/Improve)

1. **Configuration Management**:
   - Extract effect constants to shared config
   - Implement per-project config overrides
   - **Action**: Create `/api/config` endpoint with validation

2. **Code Organization**:
   - manga_view.js is very large (5686 lines)
   - video_editor.js is very large (3404 lines)
   - **Action**: Split into modules (carousel, panel-editor, tts, etc.)

3. **Error Handling**:
   - Implement consistent error response format
   - Add proper HTTP status codes
   - **Action**: Use HTTPException with standard error model

4. **Testing**:
   - Remove or feature-flag test endpoints
   - `/api/test` and `/test-video-editor-project/{project_id}`
   - **Action**: Add `DEBUG` or `TESTING` environment flag

### 🔵 LOW Priority (Nice to Have)

1. **Theme Support**: Keep (good UX)
2. **Progress Streaming (SSE)**: Keep (good UX for long operations)
3. **Fullscreen Carousel**: Keep (good UX)
4. **JSON Upload**: Keep (alternative workflow)

---

## Application Can Work Without:

### ❌ Can Be Removed (App will still function):

1. **All Local Panel Detection Models** (if external API is reliable)
   - layoutparser, ultralytics, opencv, transformers, tensorflow
   - ~300+ MB of dependencies
   
2. **Video Editor** (if not core feature)
   - video_editor.js (~3400 lines)
   - Video rendering endpoint
   - MoviePy dependencies
   - @ffmpeg packages
   
3. **TTS Features** (if narration audio not needed)
   - TTS endpoints
   - Audio management code
   - TTS API integration
   
4. **Development/Debug Features**:
   - Test endpoints
   - Ngrok integration (production)
   - Effect migration code (after migration period)
   
5. **Duplicate Functions**:
   - One of each duplicate pair

### ⚠️ Optional Features (Can be feature-flagged):

1. **Progress Streaming** - Keep for better UX
2. **Fullscreen Views** - Keep for better UX  
3. **Theme Support** - Keep for better UX
4. **JSON Upload** - Keep for flexibility
5. **Panel Border Effects** - Keep but simplify

---

## Proposed Minimal Core

If we want the **absolute minimum** application:

### Keep:
- FastAPI + core dependencies (Pillow, requests, Jinja2)
- Project management (CRUD operations)
- External panel detection integration
- Gemini API integration (optional with flag)
- Basic UI (dashboard + manga view)
- File upload handling

### Remove:
- All local detection models & dependencies
- Video editor (entire module)
- TTS features
- Duplicate code
- Test endpoints
- Ngrok integration
- MoviePy dependencies

### Result:
- ~70% reduction in dependencies
- ~40% reduction in codebase
- Faster installation
- Simpler maintenance
- Core functionality preserved

---

## Priority Levels Explained

- **CRITICAL** ⚠️ - Application cannot function without this
- **HIGH** 📊 - Core feature, difficult to work without
- **MEDIUM** 🔄 - Nice to have, improves experience
- **LOW** ⚡ - Optional, can be removed with minimal impact

---

## Next Steps

1. **Immediate**: Fix duplicate code and concurrency issues
2. **Short-term**: Decide on video editor and TTS necessity
3. **Medium-term**: Remove unused dependencies based on decision
4. **Long-term**: Refactor large files into modules
5. **Ongoing**: Improve error handling and testing

---

**End of Feature Inventory**

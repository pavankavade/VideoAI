# VideoAI - Quick Decision Guide

**Based on**: FEATURE_INVENTORY.md comprehensive analysis

---

## 📊 Statistics

| Metric | Value |
|--------|-------|
| Total Backend Functions | ~50+ functions |
| Total API Endpoints | 29 endpoints |
| Total Frontend Lines | ~9,500 lines (3 JS files) |
| Backend Code Lines | ~3,084 lines (main.py) |
| Dependencies (Python) | 19 packages |
| Dependencies (npm) | 2 packages |

---

## 🚨 Critical Issues (Fix Now)

### 1. Duplicate Code (3 instances)
- `create_rounded_rectangle_mask()` at lines **547** & **2877**
- `add_curved_border()` at lines **561** & **2908**  
- `/api/panel/add-border` endpoint at lines **604** & **2944**

**Action**: Consolidate to single implementation for each

### 2. Concurrency Bug
- `save_manga_projects()` lacks file locking
- Risk of data corruption with concurrent writes

**Action**: Implement atomic writes or file locking

### 3. Security Issues
- No input validation on file uploads (path traversal risk)
- `.env` file may not be git-ignored

**Action**: Add validation, verify .gitignore

---

## 🎯 Major Decision Points

### Decision 1: Video Editor Feature
**Question**: Is video generation a core requirement?

| If YES | If NO |
|--------|-------|
| Keep video_editor.js (~3,400 lines) | Remove video_editor.js |
| Keep `/api/video/render` endpoint | Remove video endpoints |
| Keep MoviePy + imageio-ffmpeg | Remove MoviePy dependencies |
| Keep @ffmpeg packages (npm) | Remove @ffmpeg packages |
| **Impact**: Full-featured app | **Impact**: -40% codebase, simpler app |

### Decision 2: Local Panel Detection
**Question**: Do you need offline/local panel detection?

| If YES | If NO |
|--------|-------|
| Keep ML libraries | **Remove** all these dependencies: |
| - layoutparser | - layoutparser (~50 MB) |
| - ultralytics | - ultralytics (~100 MB) |
| - tensorflow | - tensorflow (~200 MB) |
| - transformers | - transformers (~500 MB) |
| - opencv-python | - opencv-python-headless (~50 MB) |
| - accelerate | - accelerate (~50 MB) |
| **Impact**: Offline capable | **Impact**: -70% install size, -300+ MB |

**Current Status**: External API is used, local detection bypassed

### Decision 3: Text-to-Speech (TTS)
**Question**: Is audio narration needed?

| If YES | If NO |
|--------|-------|
| Keep TTS endpoints (2) | Remove TTS endpoints |
| Keep audio handling code | Remove audio utilities |
| Keep TTS API integration | Remove TTS dependencies |
| Keep IndexedDB audio storage | Simplify storage needs |
| **Impact**: Full audio features | **Impact**: Simpler architecture |

---

## 📦 Dependencies Quick Reference

### Must Keep (Core)
✅ fastapi - Web framework  
✅ uvicorn - Server  
✅ python-multipart - File uploads  
✅ Pillow - Image processing  
✅ jinja2 - Templates  
✅ python-dotenv - Config  
✅ requests - External APIs  

### Conditional (Decide)
⚠️ google-generativeai - AI narration (can be optional)  
⚠️ moviepy - Video rendering (if video editor needed)  
⚠️ imageio-ffmpeg - Video support (with moviepy)  
⚠️ pyngrok - Dev tunneling (dev only)  

### Can Remove (Unused)
❌ layoutparser - Local detection (not used)  
❌ ultralytics - YOLOv8 (not used)  
❌ transformers - Hugging Face (not used)  
❌ tensorflow - TF models (not used)  
❌ opencv-python-headless - OpenCV (not used)  
❌ accelerate - Model accel (not used)  

---

## 📋 Component Breakdown

### Backend (main.py)

| Component | Lines | Priority | Keep? |
|-----------|-------|----------|-------|
| Core Setup | ~100 | CRITICAL | ✅ Yes |
| Gemini API | ~100 | HIGH | ✅ Yes (optional) |
| Panel Detection | ~200 | HIGH | ✅ Yes |
| Image Processing | ~150 | HIGH | ✅ Yes |
| Video Rendering | ~500 | MEDIUM | ⚠️ Decide |
| Project CRUD | ~200 | CRITICAL | ✅ Yes |
| Utilities | ~150 | HIGH | ✅ Yes |
| SSE Progress | ~100 | MEDIUM | ✅ Yes |
| Duplicates | ~100 | N/A | ❌ Remove |

### Frontend

| File | Lines | Purpose | Keep? |
|------|-------|---------|-------|
| script.js | 388 | Dashboard | ✅ Yes |
| manga_view.js | 5,686 | Editor | ✅ Yes (refactor) |
| video_editor.js | 3,404 | Video | ⚠️ Decide |

**Note**: manga_view.js is very large, consider splitting into modules

---

## 🎨 Feature Matrix

| Feature | Status | Necessity | Can Remove? |
|---------|--------|-----------|-------------|
| Project Management | ✅ Active | CRITICAL | ❌ No |
| File Upload | ✅ Active | CRITICAL | ❌ No |
| Panel Detection (External) | ✅ Active | HIGH | ❌ No |
| Panel Detection (Local) | 🚫 Bypassed | LOW | ✅ Yes |
| AI Narration (Gemini) | ✅ Active | HIGH | ⚠️ Optional |
| Text-Panel Matching | ✅ Active | HIGH | ❌ No |
| Video Editor | ✅ Active | MEDIUM | ⚠️ Decide |
| Video Rendering | ✅ Active | MEDIUM | ⚠️ Decide |
| TTS Integration | ✅ Active | MEDIUM | ⚠️ Decide |
| Progress Streaming | ✅ Active | MEDIUM | ✅ Yes (UX) |
| Theme Support | ✅ Active | LOW | ✅ Yes (UX) |
| Fullscreen Views | ✅ Active | LOW | ✅ Yes (UX) |
| Border Effects | ✅ Active | LOW | ⚠️ Simplify |
| Test Endpoints | ✅ Active | LOW | ✅ Remove (prod) |

---

## 🏗️ Architecture Recommendations

### Minimal Core (Recommended for MVP)

**Keep**:
- FastAPI + Pillow + requests
- Project management (CRUD)
- External panel detection
- Gemini API (optional flag)
- Basic UI (dashboard + manga view)
- File upload/management

**Remove**:
- All local ML models (300+ MB)
- Video editor (3,400 lines)
- TTS features
- Duplicate code
- Test endpoints (prod)

**Result**:
- ✅ 70% smaller installation
- ✅ 40% less code
- ✅ Faster startup
- ✅ Easier maintenance
- ✅ Core functionality preserved

### Full-Featured (If all features needed)

**Keep Everything Except**:
- Duplicate code (consolidate)
- Unused local detection models
- Test endpoints (flag for dev only)

**Improve**:
- Add file locking to project saves
- Split manga_view.js into modules
- Add input validation
- Implement error standards

---

## 🔧 Immediate Action Items

### Priority 1 (This Week)
1. ✅ Create feature inventory ← **DONE**
2. ⬜ Fix duplicate code (3 instances)
3. ⬜ Add file locking to save_manga_projects()
4. ⬜ Add input validation for uploads
5. ⬜ Verify .env in .gitignore

### Priority 2 (Next Sprint)
6. ⬜ **DECIDE**: Keep video editor? (YES/NO)
7. ⬜ **DECIDE**: Keep local detection? (YES/NO)
8. ⬜ **DECIDE**: Keep TTS features? (YES/NO)
9. ⬜ Remove unused dependencies based on decisions
10. ⬜ Update requirements.txt

### Priority 3 (Refactoring)
11. ⬜ Split manga_view.js into modules
12. ⬜ Extract config to shared source
13. ⬜ Implement standard error format
14. ⬜ Add feature flags for optional features

---

## 💡 Quick Wins

**Easy Removals** (No impact on core functionality):
1. Test endpoints (`/api/test`, `/test-video-editor-project/*`)
2. Migration code (`migrateProjectEffects()` - after migration period)
3. One copy of each duplicate function
4. Unused ML dependencies (if external API works)

**Easy Improvements** (High value, low effort):
1. Add `.env` to `.gitignore`
2. Add file size validation to uploads
3. Add concurrent write protection
4. Feature flag for ngrok (dev only)

---

## 📈 Impact Analysis

### Remove Unused Dependencies
- **Effort**: Low (update requirements.txt)
- **Risk**: Very Low
- **Impact**: Major (70% size reduction)
- **Recommendation**: ✅ **DO IT**

### Remove Video Editor
- **Effort**: Medium (remove files, endpoints)
- **Risk**: Medium (if users expect it)
- **Impact**: Major (40% code reduction)
- **Recommendation**: ⚠️ **DECIDE FIRST**

### Remove TTS Features
- **Effort**: Medium (remove endpoints, UI)
- **Risk**: Low-Medium
- **Impact**: Medium (cleaner architecture)
- **Recommendation**: ⚠️ **DECIDE FIRST**

### Fix Duplicates
- **Effort**: Low (2-3 hours)
- **Risk**: Very Low
- **Impact**: Small but important
- **Recommendation**: ✅ **DO IT NOW**

---

## 🎯 Recommended Path Forward

### Phase 1: Cleanup (1 week)
- Fix duplicate code
- Add file locking
- Add input validation
- Remove test endpoints from production

### Phase 2: Decisions (1 week)
- Assess video editor usage/need
- Assess TTS usage/need
- Assess local detection need
- Document decisions

### Phase 3: Optimization (2 weeks)
- Remove unused features based on decisions
- Remove unused dependencies
- Update documentation
- Test thoroughly

### Phase 4: Refactoring (ongoing)
- Split large files into modules
- Improve error handling
- Add comprehensive tests
- Improve documentation

---

**For detailed analysis, see**: [FEATURE_INVENTORY.md](./FEATURE_INVENTORY.md)

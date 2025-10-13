// Basic video editor client logic
// Layered timeline model: layers is array of {id, name, clips: []}
let timeline = []; // legacy flat timeline kept for compatibility but UI shows layers
let layers = [ { id: 'layer-1', name: 'Layer 1', clips: [] } ];

// Background config
const DEFAULT_BG_SRC = '/static/blur_glitch_background.png';
const BACKGROUND_LAYER_ID = 'background';

// Effect configuration variables (match server-side)
let EFFECT_ANIMATION_SPEED = 0.2;  // Default 0.2x speed (slower, more cinematic)
let EFFECT_SCREEN_MARGIN = 0.1;  
let EFFECT_ZOOM_AMOUNT = 0.25;
let EFFECT_MAX_DURATION = 5.0;
let PANEL_BASE_SIZE = 1.2;  // Default 120% size (larger panels)
let EFFECT_SMOOTHING = 1.0;  // Smoothing intensity

// Transition configuration variables
let TRANSITION_DURATION = 0.8;  // Duration of panel transitions
let TRANSITION_OVERLAP = 0.4;   // Overlap duration for transitions
let TRANSITION_SMOOTHING = 2.0; // Smoothing for transitions

let activeLayerId = 'layer-1';
let panels = [];
let audios = [];
let selectedClip = null;
// Timeline scaling (pixels per second)
let pxPerSec = 100; // 100px == 1s by default; user can zoom in later
let snapSeconds = 0.1; // snap to 0.1s
// The px/sec that's actually used to render the viewport may be reduced
// to avoid extremely wide DOM elements for very long timelines. Keep
// viewPxPerSec in sync with pxPerSec but allow it to be clamped for layout.
let viewPxPerSec = pxPerSec;
let previewControllers = []; // store audio/video controllers to stop preview
let audioCtx = null;
let audioBufferCache = {}; // keyed by src -> AudioBuffer

// Ensure audio context is initialized (required for audio playback)
async function ensureAudioContext(){
  if (audioCtx) return audioCtx;
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }catch(e){ 
    console.warn('Failed to create AudioContext:', e);
    audioCtx = null; 
  }
  return audioCtx;
}

// Loading modal functions
let loadingState = {
  totalAssets: 0,
  loadedAssets: 0,
  currentStatus: 'Initializing...'
};

function showLoadingModal(status = 'Initializing...') {
  const modal = document.getElementById('loadingModal');
  const statusEl = document.getElementById('loadingStatus');
  const progressEl = document.getElementById('loadingProgress');
  const progressTextEl = document.getElementById('loadingProgressText');
  
  loadingState.currentStatus = status;
  loadingState.loadedAssets = 0;
  loadingState.totalAssets = 0;
  
  statusEl.textContent = status;
  progressEl.style.width = '0%';
  progressTextEl.textContent = '0%';
  modal.style.display = 'flex';
}

function updateLoadingProgress(loaded, total, status) {
  const statusEl = document.getElementById('loadingStatus');
  const progressEl = document.getElementById('loadingProgress');
  const progressTextEl = document.getElementById('loadingProgressText');
  
  loadingState.loadedAssets = loaded;
  loadingState.totalAssets = total;
  loadingState.currentStatus = status;
  
  const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;
  
  if (statusEl) statusEl.textContent = status;
  if (progressEl) progressEl.style.width = percentage + '%';
  if (progressTextEl) progressTextEl.textContent = percentage + '%';
}

function hideLoadingModal() {
  const modal = document.getElementById('loadingModal');
  modal.style.display = 'none';
}
let audioFetchControllers = {}; // keyed by src -> AbortController
let audioPreloadInProgress = false; // Flag to prevent duplicate calls
const DBG = (...args)=>{ try{ console.log('[editor-db]', ...args); }catch(e){} };
const preloadedAudioEls = {}; // src -> HTMLAudioElement (preloaded)
// Simplified preview audio state (HTMLAudio-only)
let activeAudio = null; // current HTMLAudio element in use
let activeAudioTimeout = null; // timeout id for scheduling next clip
let playbackTotalOverride = null; // total duration override based on real audio lengths during playback
// Cache mapping of original URLs to object URLs so we can reuse and revoke later
const audioObjectUrlMap = {}; // originalSrc -> { url: objectURL, blob: Blob }
let autosaveTimer = null;
let autosavePending = false;
let isExporting = false; // suppress autosave and UI side-work during export
// Canvas preview state
let canvas = null, ctx = null, overlayEl = null;
let isPlaying = false; // paused by default
let playhead = 0; // seconds
let rafId = null; let lastTs = 0;
let selectedLayerId = null; let selectedIndex = -1; // current selection for canvas
let interaction = null; // active transform/crop interaction
let cropMode = false;

// Add page load state tracking
window.addEventListener('load', () => {
  DBG('Window load event fired - page fully loaded');
});

// Track readyState changes
document.addEventListener('readystatechange', () => {
  DBG('Document readyState changed to:', document.readyState);
});

// Load effect configuration from server
async function loadEffectConfig() {
  try {
    const response = await fetch('/editor/api/video/effect-config');
    if (response.ok) {
      const config = await response.json();
      // Accept both camelCase and snake_case from server
      EFFECT_ANIMATION_SPEED = (config.animationSpeed ?? config.animation_speed ?? 1.0);
      EFFECT_SCREEN_MARGIN = (config.screenMargin ?? config.screen_margin ?? 0.1);
      EFFECT_ZOOM_AMOUNT = (config.zoomAmount ?? config.zoom_amount ?? 0.25);
      EFFECT_MAX_DURATION = (config.maxDuration ?? config.max_duration ?? 5.0);
      PANEL_BASE_SIZE = (config.panelBaseSize ?? config.panel_base_size ?? 0.5);
      EFFECT_SMOOTHING = (config.smoothing ?? config.smoothing ?? 2.0);
      TRANSITION_DURATION = (config.transitionDuration ?? config.transition_duration ?? 0.8);
      TRANSITION_OVERLAP = (config.transitionOverlap ?? config.transition_overlap ?? 0.4);
      TRANSITION_SMOOTHING = (config.transitionSmoothing ?? config.transition_smoothing ?? 2.0);
      console.log('Effect and transition config loaded:', config);
    }
  } catch (err) {
    console.warn('Failed to load effect config:', err);
  }
}

// Update effect configuration on server
async function updateEffectConfig(config) {
  try {
    const response = await fetch('/editor/api/video/effect-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (response.ok) {
      const result = await response.json();
      // Update local variables - API returns camelCase keys
      EFFECT_ANIMATION_SPEED = result.animationSpeed || EFFECT_ANIMATION_SPEED;
      EFFECT_SCREEN_MARGIN = result.screenMargin || EFFECT_SCREEN_MARGIN;
      EFFECT_ZOOM_AMOUNT = result.zoomAmount || EFFECT_ZOOM_AMOUNT;
      EFFECT_MAX_DURATION = result.maxDuration || EFFECT_MAX_DURATION;
      PANEL_BASE_SIZE = result.panelBaseSize || PANEL_BASE_SIZE;
      EFFECT_SMOOTHING = result.smoothing || EFFECT_SMOOTHING;
      TRANSITION_DURATION = result.transitionDuration || TRANSITION_DURATION;
      TRANSITION_OVERLAP = result.transitionOverlap || TRANSITION_OVERLAP;
      TRANSITION_SMOOTHING = result.transitionSmoothing || TRANSITION_SMOOTHING;
      console.log('Effect config updated:', result);
      return result;
    }
  } catch (err) {
    console.warn('Failed to update effect config:', err);
  }
}

// Helper to refresh DB project summary and update window.projectData
async function refreshProjectData(){
  // Try to get project ID from multiple sources
  let projectId = null;
  
  // Method 1: From URL query parameters (?project_id=...)
  const urlParams = new URLSearchParams(window.location.search);
  projectId = urlParams.get('project_id');
  
  // Method 2: From URL path (/editor/video-editor/{project_id})
  if (!projectId) {
    const pathMatch = window.location.pathname.match(/\/video-editor\/([^\/]+)/);
    if (pathMatch) {
      projectId = pathMatch[1];
      DBG('Extracted project ID from path:', projectId);
    }
  }
  
  // Method 3: From global window.projectData (already loaded in template)
  if (!projectId && window.projectData?.id) {
    projectId = window.projectData.id;
    DBG('Using project ID from global projectData:', projectId);
  }
  
  if (!projectId){ 
    console.error('No project ID found in URL parameters, path, or global data'); 
    return null; 
  }
  
  try{
    const response = await fetch(`/editor/api/project/${projectId}`);
    if (response.ok){ 
      const proj = await response.json(); 
      window.projectData = proj; 
      DBG('Project data refreshed (DB):', proj.id); 
      return proj; 
    } else {
      console.error('Failed to fetch project data:', response.status);
      return null;
    }
  }catch(e){ 
    console.error('Error fetching project (DB):', e); 
  }
  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Prevent re-initialization if already loaded
  if (window.videoEditorLoaded) {
    DBG('Video editor already loaded, skipping re-initialization');
    return;
  }
  
  // Show loading modal immediately
  showLoadingModal('Initializing video editor...');
  
  // Initialize project data from script tag
  try {
    console.log('[video-editor-db] Looking for project data script tag...');
    const projectDataScript = document.getElementById('__project_data__');
    console.log('[video-editor-db] Found script element:', !!projectDataScript);
    
    if (projectDataScript && projectDataScript.textContent) {
      window.projectData = JSON.parse(projectDataScript.textContent);
      console.log('[video-editor-db] Successfully loaded project data from script tag.');
      console.log('[video-editor-db] Full project data:', JSON.stringify(window.projectData, null, 2));
    } else {
      console.warn('[video-editor-db] No project data script found, will fetch from API.');
      await refreshProjectData();
    }
  } catch (e) {
    console.error('[video-editor-db] Failed to parse project data, will fetch from API:', e);
    await refreshProjectData();
  }
  
  // Load effect configuration from server
  await loadEffectConfig();
  
  DBG('DOMContentLoaded fired - starting video editor initialization');
  
  const project = window.projectData || {};
  
  // Ensure a hidden audio pool exists for preloading
  try{
    let pool = document.getElementById('hidden-audio-pool');
    if (!pool){
      pool = document.createElement('div');
      pool.id = 'hidden-audio-pool';
      pool.style.position = 'absolute';
      pool.style.left = '-10000px';
      pool.style.top = '-10000px';
      pool.style.width = '1px';
      pool.style.height = '1px';
      pool.setAttribute('aria-hidden','true');
      document.body.appendChild(pool);
    }
  }catch(e){}

  const panelsList = document.getElementById('panelsList');
  const audioList = document.getElementById('audioList');
  
  // Load panels and audio from the project data (fetched from DB)
  panels = [];
  audios = [];
  const projectPages = project.pages || [];
  console.log(`[video-editor-db] Found ${projectPages.length} pages in project data.`);

  projectPages.forEach(page => {
      const pageNumber = page.page_number;
      (page.panels || []).forEach(panel => {
          const panelIdx = panel.index;
          const panelId = `panel-page${pageNumber}-${panelIdx}`;
          const displayName = `Page ${pageNumber} Panel ${panelIdx + 1}`;
          const panelImageUrl = panel.image_path;

          panels.push({
              id: panelId,
              src: panelImageUrl,
              filename: panelImageUrl.split('/').pop(),
              pageNumber: pageNumber,
              panelIndex: panelIdx,
              displayName: displayName,
              effect: panel.effect || 'none',
              transition: panel.transition || (panelIdx === 0 ? 'none' : 'slide_book')
          });

          const panelEl = document.createElement('div');
          panelEl.className = 'asset-item';
          panelEl.draggable = true;
          panelEl.dataset.id = panelId;
          panelEl.dataset.type = 'image';
          panelEl.innerHTML = `<img src="${panelImageUrl}" alt="${displayName}" loading="lazy" decoding="async"/><div class="meta">${displayName}</div>`;
          panelEl.addEventListener('dragstart', onDragStartAsset);
          panelsList.appendChild(panelEl);

          if (panel.audio_path) {
              const audioId = `audio-page${pageNumber}-panel${panelIdx}`;
              const audioUrl = panel.audio_path;
              const audioDisplayName = `${displayName} Audio`;

              audios.push({
                  id: audioId,
                  src: audioUrl,
                  filename: audioUrl.split('/').pop(),
                  pageNumber: pageNumber,
                  panelIndex: panelIdx,
                  displayName: audioDisplayName,
                  duration: panel.duration || 1.0,
                  text: panel.text || ''
              });

              const audioEl = document.createElement('div');
              audioEl.className = 'asset-item';
              audioEl.draggable = true;
              audioEl.dataset.id = audioId;
              audioEl.dataset.type = 'audio';
              audioEl.innerHTML = `<span class="audio-icon">🎵</span><div class="meta">${audioDisplayName}<br><small>${(panel.text || '').substring(0, 50)}...</small></div>`;
              audioEl.addEventListener('dragstart', onDragStartAsset);
              audioList.appendChild(audioEl);
          }
      });
  });

  // If editor state was previously saved on the server, restore layers
  try {
    console.log('[video-editor-db] Checking for saved timeline data in project object:', project);
    const saved = project && project.metadata ? project.metadata.layers : null;
    console.log('[video-editor-db] Extracted saved layers data:', saved);

    if (saved && Array.isArray(saved) && saved.length > 0) {
      console.log(`[video-editor-db] Found ${saved.length} saved layers. Processing...`);
      layers = saved.map((s, li) => ({
        id: s.id || ('layer-' + (Date.now() + li)),
        name: s.name || ('Layer ' + (li + 1)),
        clips: (s.clips || []).map((c) => {
          const clip = Object.assign({}, c);
          if (clip.type === 'audio' && clip.src && clip.src.startsWith('blob:')) {
            if (clip.meta && clip.meta.originalUrl) {
              clip.src = clip.meta.originalUrl;
            }
          }
          return clip;
        })
      }));
      layers.forEach(l => { l.clips.forEach(c => { if (c.duration != null) c.duration = Number(c.duration); if (c.startTime != null) c.startTime = Number(c.startTime); }); recomputeLayerTimings(l); });
      activeLayerId = layers[0].id;
      console.log('[video-editor-db] Successfully processed saved layers. The global `layers` variable is now:', layers);
      console.info('[editor-db] Restored saved layers from project data. Timeline should now be rendered.');
    } else {
      console.log('[video-editor-db] No valid saved layers found in project metadata.');
    }
  } catch (e) { 
    console.error('[video-editor-db] CRITICAL: An error occurred while trying to restore saved layers.', e);
  }

  if (layers.some(l=> l.id === BACKGROUND_LAYER_ID)){
    ensureBackgroundLayer(false);
  }

  const audioFileInputEl = document.getElementById('audioFileInput');
  if (audioFileInputEl) audioFileInputEl.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('files', f, f.name || `audio-${Date.now()}.mp3`);
    try {
      const resp = await fetch('/upload', {method:'POST', body: fd});
      if (!resp.ok) throw new Error('Upload failed: ' + resp.status);
      const dataResp = await resp.json();
      const filenames = (dataResp && Array.isArray(dataResp.filenames)) ? dataResp.filenames : [];
      filenames.forEach((fn) => {
        const src = `/uploads/${fn}`;
        const id = `audio-upload-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
        audios.push({id, src, filename: fn, meta: { uploaded: true }});
        const el = document.createElement('div');
        el.className = 'asset-item'; el.draggable = true; el.dataset.id = id; el.dataset.type = 'audio';
        el.innerHTML = `<div style="width:48px; height:48px; background:#111; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#fff;">♪</div><div class="meta">${fn}</div>`;
        el.addEventListener('dragstart', onDragStartAsset);
        audioList && audioList.appendChild(el);
      });
    } catch (err) {
      console.error('Audio upload error', err);
      alert('Audio upload failed. See console for details.');
    }
  });

  const exportBtnEl = document.getElementById('exportBtn'); if (exportBtnEl) exportBtnEl.addEventListener('click', onExport);
  const previewTimelineBtnEl = document.getElementById('previewTimelineBtn'); if (previewTimelineBtnEl) previewTimelineBtnEl.addEventListener('click', onPreviewTimeline);
  const clearTimelineEl = document.getElementById('clearTimeline'); if (clearTimelineEl) clearTimelineEl.addEventListener('click', () => { layers.forEach(l=> l.clips = []); timeline = []; renderTimeline(); });
  const playTimelineEl = document.getElementById('playTimeline'); if (playTimelineEl) playTimelineEl.addEventListener('click', ()=>{ onPreviewTimeline(); });
  try{
    const saved = window.localStorage.getItem('video_editor_pxPerSec');
    if (saved) {
      const v = Number(saved);
      if (!Number.isNaN(v) && v > 0) pxPerSec = v;
    }
  }catch(e){ /* ignore localStorage errors */ }

  viewPxPerSec = pxPerSec;

  const zIn = document.getElementById('zoomIn'); if (zIn) zIn.addEventListener('click', ()=>{ pxPerSec = Math.min(2000, pxPerSec * 1.25); persistZoom(); recalcViewScale(); renderTimeline(); renderRuler(); scheduleAutosave(); });
  const zOut = document.getElementById('zoomOut'); if (zOut) zOut.addEventListener('click', ()=>{ pxPerSec = Math.max(10, pxPerSec / 1.25); persistZoom(); recalcViewScale(); renderTimeline(); renderRuler(); scheduleAutosave(); });
  const snapSel = document.getElementById('snapSelect'); if (snapSel) { snapSel.addEventListener('change', (e)=>{ snapSeconds = parseFloat(e.target.value) || 0.1; }); }
  const saveNowBtn = document.getElementById('saveNow'); if (saveNowBtn) saveNowBtn.addEventListener('click', ()=> saveProject(true));
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = '';
  
  const generateTimelineBtn = document.getElementById('generatePanelTimeline');
  if (generateTimelineBtn) generateTimelineBtn.addEventListener('click', generatePanelTimeline);
  
  const renderBtn = document.getElementById('renderBtn');
  if (renderBtn) renderBtn.addEventListener('click', renderVideo);
  
  const previewTop = document.getElementById('previewTimelineBtnTop');
  if (previewTop) previewTop.addEventListener('click', onPreviewTimeline);

  updateLoadingProgress(0, 100, 'Initializing canvas preview...');
  initCanvasPreview();

  updateLoadingProgress(0, 100, 'Rendering timeline and components...');
  renderTimeline();
  renderLayerControls();
  renderRuler();
  
  updateLoadingProgress(0, 100, 'Preloading image assets...');
  try{ preloadImageAssets(); }catch(e){ DBG('preloadImageAssets error', e); }
  updateLoadingProgress(0, 100, 'Preloading audio assets...');
  try{ preloadAudioAssets(); }catch(e){ DBG('preloadAudioAssets error', e); }

  updateLoadingProgress(100, 100, 'Video editor ready!');
  
  window.videoEditorLoaded = true;

  window.resizeTimer = null;
  window.addEventListener('resize', () => {
    if (window.resizeTimer) clearTimeout(window.resizeTimer);
    window.resizeTimer = setTimeout(()=>{ try{ renderTimeline(); renderRuler(); }catch(e){} }, 120);
  });

  const timelineTrackEl = document.getElementById('timelineTrack');
  if (timelineTrackEl) {
    timelineTrackEl.addEventListener('click', (ev) => {
      try {
        const removeBtn = ev.target.closest ? ev.target.closest('.remove') : (ev.target.classList && ev.target.classList.contains('remove') ? ev.target : null);
        if (!removeBtn) return;
        ev.stopPropagation(); ev.preventDefault();
        const clipEl = removeBtn.closest('.clip');
        if (!clipEl) return;
        const layerId = clipEl.dataset.layerId;
        const idx = Number(clipEl.dataset.idx);
        if (layerId && !Number.isNaN(idx)){
          removeClipFromLayer(layerId, idx);
        }
      } catch (e) {
        console.warn('Remove handler error', e);
      }
    });
  }
});

// ------------------ Canvas Preview Engine (16:9) ------------------
function initCanvasPreview(){
  canvas = document.getElementById('editorCanvas');
  overlayEl = document.getElementById('previewOverlay');
  const playBtn = document.getElementById('togglePlay');
  const cropBtn = document.getElementById('toggleCrop');
  const seekSlider = document.getElementById('seekSlider');
  const panelSizeSlider = document.getElementById('panelSizeSlider');
  const panelSizeValue = document.getElementById('panelSizeValue');
  const resetPanelSizeBtn = document.getElementById('resetPanelSize');
  const animSpeedSlider = document.getElementById('animSpeedSlider');
  const animSpeedValue = document.getElementById('animSpeedValue');
  const resetAnimSpeedBtn = document.getElementById('resetAnimSpeed');
  const toolbar = overlayEl ? overlayEl.querySelector('.preview-toolbar') : null;
  if (!canvas) return;
  canvas.width = 1920; canvas.height = 1080; // 16:9 backing resolution
  ctx = canvas.getContext('2d');
  if (playBtn) playBtn.addEventListener('click', togglePlayback);
  if (cropBtn) cropBtn.addEventListener('click', ()=>{ if (isPlaying) return; cropMode = !cropMode; cropBtn.textContent = 'Crop: ' + (cropMode? 'On' : 'Off'); renderOverlays(); });
  
  // Panel size slider control
  if (panelSizeSlider && panelSizeValue) {
    // Initialize slider value from current PANEL_BASE_SIZE
    panelSizeSlider.value = PANEL_BASE_SIZE;
    panelSizeValue.textContent = Math.round(PANEL_BASE_SIZE * 100) + '%';
    
    let updateTimeout = null;
    panelSizeSlider.addEventListener('input', (e) => {
      const newSize = parseFloat(e.target.value);
      PANEL_BASE_SIZE = newSize;
      panelSizeValue.textContent = Math.round(newSize * 100) + '%';
      
      // Reset all panel transforms so they recalculate with new size
      resetAllPanelTransforms();
      
      // Redraw the current frame
      if (!isPlaying) {
        drawFrame(playhead);
      }
      
      DBG(`Panel size changed to ${Math.round(newSize * 100)}%`);
      
      // Debounce saving to server (wait 500ms after last change)
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        updateEffectConfig({ panelBaseSize: newSize }).catch(err => {
          DBG('Failed to save panel size to server:', err);
        });
      }, 500);
    });
  }
  
  // Reset panel size button
  if (resetPanelSizeBtn) {
    resetPanelSizeBtn.addEventListener('click', () => {
      const defaultSize = 1.2;  // Default 120%
      PANEL_BASE_SIZE = defaultSize;
      if (panelSizeSlider) panelSizeSlider.value = defaultSize;
      if (panelSizeValue) panelSizeValue.textContent = Math.round(defaultSize * 100) + '%';
      
      // Reset all panel transforms
      resetAllPanelTransforms();
      
      // Redraw the current frame
      if (!isPlaying) {
        drawFrame(playhead);
      }
      
      // Save to server
      updateEffectConfig({ panelBaseSize: defaultSize }).catch(err => {
        DBG('Failed to save panel size to server:', err);
      });
      
      DBG(`Panel size reset to ${Math.round(defaultSize * 100)}%`);
    });
  }
  
  // Animation speed slider control
  if (animSpeedSlider && animSpeedValue) {
    // Initialize slider value from current EFFECT_ANIMATION_SPEED
    animSpeedSlider.value = EFFECT_ANIMATION_SPEED;
    animSpeedValue.textContent = EFFECT_ANIMATION_SPEED.toFixed(1) + 'x';
    
    let updateTimeout = null;
    animSpeedSlider.addEventListener('input', (e) => {
      const newSpeed = parseFloat(e.target.value);
      EFFECT_ANIMATION_SPEED = newSpeed;
      animSpeedValue.textContent = newSpeed.toFixed(1) + 'x';
      
      // Redraw the current frame to apply new speed
      if (!isPlaying) {
        drawFrame(playhead);
      }
      
      DBG(`Animation speed changed to ${newSpeed.toFixed(1)}x`);
      
      // Debounce saving to server (wait 500ms after last change)
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        updateEffectConfig({ animationSpeed: newSpeed }).catch(err => {
          DBG('Failed to save animation speed to server:', err);
        });
      }, 500);
    });
  }
  
  // Reset animation speed button
  if (resetAnimSpeedBtn) {
    resetAnimSpeedBtn.addEventListener('click', () => {
      const defaultSpeed = 0.2;  // Default 0.2x speed
      EFFECT_ANIMATION_SPEED = defaultSpeed;
      if (animSpeedSlider) animSpeedSlider.value = defaultSpeed;
      if (animSpeedValue) animSpeedValue.textContent = defaultSpeed.toFixed(1) + 'x';
      
      // Redraw the current frame
      if (!isPlaying) {
        drawFrame(playhead);
      }
      
      // Save to server
      updateEffectConfig({ animationSpeed: defaultSpeed }).catch(err => {
        DBG('Failed to save animation speed to server:', err);
      });
      
      DBG(`Animation speed reset to ${defaultSpeed.toFixed(1)}x`);
    });
  }
  
  if (seekSlider){
    let scrubbing = false;
    const applySeek = () => {
      const total = getCanvasTotalDuration() || 0;
      const frac = Math.max(0, Math.min(1, Number(seekSlider.value)));
      const t = frac * total;
      playhead = t; drawFrame(playhead);
      if (isPlaying){
        scheduleAudioForPlayback();
      }
    };
    const stop = (e)=>{ e.stopPropagation(); };
    seekSlider.addEventListener('pointerdown', (e)=>{ stop(e); scrubbing = true; stopRaf(); });
    seekSlider.addEventListener('mousedown', stop);
    seekSlider.addEventListener('touchstart', (e)=>{ stop(e); scrubbing = true; stopRaf(); }, {passive:false});
    seekSlider.addEventListener('input', ()=>{ applySeek(); });
    seekSlider.addEventListener('change', (e)=>{ stop(e); scrubbing = false; applySeek(); });
    seekSlider.addEventListener('pointerup', (e)=>{ stop(e); scrubbing = false; drawFrame(playhead); });
    seekSlider.addEventListener('click', stop);
    seekSlider._scrubbing = () => scrubbing;
  }
  if (toolbar){
    const eat = (e)=>{ e.stopPropagation(); };
    ['pointerdown','pointerup','click','mousedown','mouseup','touchstart','touchend'].forEach(evt=> toolbar.addEventListener(evt, eat, {passive:false}));
    try{ toolbar.style.pointerEvents = 'auto'; }catch(e){}
  }
  try{ overlayEl.style.pointerEvents = 'auto'; }catch(e){}
  try{
    const shield = document.createElement('div');
    shield.style.position = 'absolute';
    shield.style.left = '0';
    shield.style.right = '0';
    shield.style.top = '0';
    shield.style.height = '64px';
    shield.style.pointerEvents = 'auto';
    shield.style.background = 'transparent';
    const stopAll = (e)=>{ e.stopPropagation(); };
    ['pointerdown','pointerup','click','mousedown','mouseup','touchstart','touchend'].forEach(evt=> shield.addEventListener(evt, stopAll, {passive:false}));
    overlayEl && overlayEl.insertBefore(shield, overlayEl.firstChild || null);
  }catch(e){ DBG('shield setup failed', e); }
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  if (overlayEl) overlayEl.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointermove', onCanvasPointerMove);
  window.addEventListener('pointerup', onCanvasPointerUp);
  drawFrame(0);
}

function resetAllPanelTransforms() {
  // Clear transforms from all panel clips so they recalculate with new PANEL_BASE_SIZE
  try {
    layers.forEach(layer => {
      (layer.clips || []).forEach(clip => {
        if (clip.type === 'image' && !clip._isBackground) {
          // Clear the transform so it recalculates
          delete clip.transform;
          delete clip._transformDebugLogged;
        }
      });
    });
    
    // Also clear from flattened timeline if it exists
    if (timeline && timeline.length > 0) {
      timeline.forEach(clip => {
        if (clip.type === 'image' && !clip._isBackground) {
          delete clip.transform;
          delete clip._transformDebugLogged;
        }
      });
    }
    
    DBG('Reset all panel transforms for recalculation');
  } catch (e) {
    DBG('Error resetting panel transforms:', e);
  }
}

function togglePlayback(){
  isPlaying = !isPlaying;
  const btn = document.getElementById('togglePlay'); if (btn) btn.textContent = isPlaying ? 'Pause' : 'Play';
  const cropBtn = document.getElementById('toggleCrop'); if (cropBtn) cropBtn.disabled = isPlaying;
  if (isPlaying){
    try{
      const all = flattenLayersToTimeline();
      const auds = all.filter(c=> c.type==='audio' && c.src);
      const now = playhead;
      const active = auds.some(c=> (now >= (c.startTime||0)) && (c.duration!=null ? (now <= (c.startTime||0) + Number(c.duration||0)) : true));
      if (!active && auds.length){
        const next = auds
          .map(c=> Number(c.startTime||0))
          .filter(s=> s >= now)
          .sort((a,b)=> a-b)[0];
        if (next != null && isFinite(next)){
          DBG('Auto-jump to next audio start', { from: now.toFixed(2), to: next.toFixed(2) });
          playhead = next; drawFrame(playhead);
        }
      }
    }catch(e){ DBG('auto-jump failed', e); }
    ensureAudioContext().then(ctx=>{ try{ if (ctx && ctx.state === 'suspended') ctx.resume(); }catch(e){} });
    DBG('Play pressed at', playhead.toFixed(2));
    scheduleAudioForPlayback(); startRaf();
  } else { stopRaf(); clearAudioPlayback(); }
}

function startRaf(){
  lastTs = performance.now();
  if (rafId) cancelAnimationFrame(rafId);
  const total = getCanvasTotalDuration();
  DBG(`[startRaf] Total duration: ${total.toFixed(2)}s, playbackTotalOverride: ${playbackTotalOverride ? playbackTotalOverride.toFixed(2) : 'null'}`);
  const step = (ts) => {
    const dt = (ts - lastTs) / 1000; lastTs = ts;
    playhead = Math.min(total, playhead + dt);
    drawFrame(playhead);
    if (playhead >= total){ 
      DBG(`[RAF] Playback ended at ${playhead.toFixed(2)}s (total: ${total.toFixed(2)}s)`);
      isPlaying = false; 
      const btn = document.getElementById('togglePlay'); 
      if (btn) btn.textContent = 'Play';
      return; 
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopRaf(){ if (rafId){ cancelAnimationFrame(rafId); rafId = null; } drawFrame(playhead); }

function drawFrame(timeSec){
  if (!ctx || !canvas) return;
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const all = flattenLayersToTimeline();
  const bg = all.find(c=> c.type==='image' && c._isBackground);
  if (bg) { renderClipToCanvas(bg, timeSec); }
  const imgs = all.filter(c=> c.type==='image' && !c._isBackground).sort((a,b)=> (a._layerIndex||0) - (b._layerIndex||0));
  
  for (let i = 0; i < imgs.length; i++) {
    const currentClip = imgs[i];
    const nextClip = imgs[i + 1];
    
    if (nextClip && nextClip.transition && nextClip.transition !== 'none') {
      const transitionDuration = TRANSITION_DURATION;
      const transitionStart = (nextClip.startTime || 0) - transitionDuration * 0.5;
      const transitionEnd = (nextClip.startTime || 0) + transitionDuration * 0.5;
      
      if (timeSec >= transitionStart && timeSec <= transitionEnd) {
        const progress = Math.max(0, Math.min(1, (timeSec - transitionStart) / transitionDuration));
        renderClipWithTransition(currentClip, nextClip, timeSec, progress);
        i++;
        continue;
      }
    }
    
    renderClipToCanvas(currentClip, timeSec);
  }
  
  if (!isPlaying) renderOverlays();
  const tr = document.getElementById('timeReadout'); if (tr) tr.textContent = formatTime(timeSec);
  const total = getCanvasTotalDuration();
  const ttr = document.getElementById('totalTimeReadout'); if (ttr) ttr.textContent = '/ ' + formatTime(total);
  const seek = document.getElementById('seekSlider'); if (seek){
    const frac = total>0 ? (timeSec / total) : 0;
    const isScrubbing = typeof seek._scrubbing === 'function' ? seek._scrubbing() : false;
    if (!isScrubbing){ seek.value = String(Math.max(0, Math.min(1, frac))); }
  }
}

// Compute panel fit dimensions (for panel-based rendering)
function computePanelFit(srcW, srcH, dstW, dstH) {
  // For panels: render at configurable size and center in canvas
  const scaleFactor = PANEL_BASE_SIZE;
  const scaledDstW = dstW * scaleFactor;
  const scaledDstH = dstH * scaleFactor;
  
  DBG(`[panel-fit] Source: ${srcW}x${srcH}, Canvas: ${dstW}x${dstH}, Scale: ${scaleFactor}`);
  DBG(`[panel-fit] Scaled target: ${scaledDstW}x${scaledDstH}`);
  
  const srcAR = srcW / srcH;
  const scaledAR = scaledDstW / scaledDstH;
  
  DBG(`[panel-fit] Source AR: ${srcAR}, Scaled AR: ${scaledAR}`);
  
  let sw, sh, sx, sy, dw, dh, dx, dy;
  
  if (srcAR > scaledAR) {
    // Source is wider: fit to width
    dw = scaledDstW;
    dh = scaledDstW / srcAR;
    sw = srcW;
    sh = srcH;
    sx = 0;
    sy = 0;
    DBG(`[panel-fit] Fit to width: dw=${dw}, dh=${dh}`);
  } else {
    // Source is taller: fit to height
    dh = scaledDstH;
    dw = scaledDstH * srcAR;
    sw = srcW;
    sh = srcH;
    sx = 0;
    sy = 0;
    DBG(`[panel-fit] Fit to height: dw=${dw}, dh=${dh}`);
  }
  
  // Center the scaled image in the canvas
  dx = (dstW - dw) / 2;
  dy = (dstH - dh) / 2;
  
  DBG(`[panel-fit] Centering: dx=${dx}, dy=${dy}`);
  DBG(`[panel-fit] Final result: src(${sx},${sy},${sw},${sh}) -> dest(${dx},${dy},${dw},${dh})`);
  
  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

function renderClipToCanvas(clip, t){
  const st = clip.startTime || 0; const dur = (clip.duration!=null)? Number(clip.duration) : (clip.type==='image'?2:0);
  if (t < st || t > st + dur + 1e-4) return;
  
  if (!clip._img && !clip._imgLoading){ 
    clip._imgLoading = true;
    const im = new Image(); 
    im.crossOrigin='anonymous'; 
    im.onload = ()=>{ 
      clip._imgLoading = false;
      clip._imgLoaded = true;
      DBG('Image loaded for clip:', clip.src || clip);
    }; 
    im.onerror = () => {
      clip._imgLoading = false;
      clip._imgError = true;
      DBG('Image load error for:', clip.src);
    };
    im.src = normalizeSrc(clip.src || clip); 
    clip._img = im; 
    return;
  }
  
  const img = clip._img; 
  if (!img || !img.complete || !img.naturalWidth || clip._imgLoading) {
    return;
  }
  
  // Check if this is a panel image for 50% sizing
  // Panel images can be in: /panels/, /manga_projects/, /bordered_, /cropped_, but NOT background images
  const isPanelImage = clip.src && !clip._isBackground && (
    clip.src.includes('/panels/') || 
    clip.src.includes('/manga_projects/') ||
    clip.src.includes('/bordered_') || 
    clip.src.includes('/cropped_')
  );
  
  // Debug: Log every clip rendering to see what's happening
  if (!clip._transformDebugLogged) {
    DBG(`[render-clip-check] src="${clip.src}", isPanelImage=${isPanelImage}, hasTransform=${!!clip.transform}, _isBackground=${!!clip._isBackground}`);
    clip._transformDebugLogged = true;
  }
  
  // Set defaults based on image type - only set once per clip
  if (isPanelImage && !clip.transform) {
    // For panels: 50% size and centered
    const panelFit = computePanelFit(img.naturalWidth, img.naturalHeight, canvas.width, canvas.height);
    clip.transform = {
      x: panelFit.dx + panelFit.dw/2,
      y: panelFit.dy + panelFit.dh/2,
      w: panelFit.dw,
      h: panelFit.dh,
      rotation: 0
    };
    DBG(`[render-clip] ★ PANEL transform initialized: src=${clip.src}`);
    DBG(`  Canvas: ${canvas.width}x${canvas.height}, Panel: ${img.naturalWidth}x${img.naturalHeight}`);
    DBG(`  PANEL_BASE_SIZE: ${PANEL_BASE_SIZE}`);
    DBG(`  panelFit result: dx=${panelFit.dx}, dy=${panelFit.dy}, dw=${panelFit.dw}, dh=${panelFit.dh}`);
    DBG(`  Transform: x=${clip.transform.x}, y=${clip.transform.y}, w=${clip.transform.w}, h=${clip.transform.h}`);
  } else if (!isPanelImage && !clip.transform) {
    // For other images: full canvas (existing behavior)
    clip.transform = { x: canvas.width/2, y: canvas.height/2, w: canvas.width, h: canvas.height, rotation: 0 };
    DBG(`[render-clip] Standard (non-panel) transform: x=${clip.transform.x}, y=${clip.transform.y}, w=${clip.transform.w}, h=${clip.transform.h}`);
  }
  
  clip.crop = clip.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const endCx = clip.transform.x, endCy = clip.transform.y;
  const endW = clip.transform.w, endH = clip.transform.h;

  const eff = (clip.effect || '').toLowerCase();
  const animMax = 5.0;
  const animDur = Math.min(animMax, dur);
  
  // Apply animation speed multiplier: lower speed = slower animation
  // Speed 1.0 = normal, 0.5 = half speed (slower), 2.0 = double speed (faster)
  const effectiveAnimDur = animDur / (EFFECT_ANIMATION_SPEED || 1.0);
  const effectiveProgress = (t - st) / (effectiveAnimDur > 0 ? effectiveAnimDur : 1);
  const rawProgress = Math.max(0, Math.min(1, effectiveProgress));
  
  const configSmoothEasing = (t) => {
    if (EFFECT_SMOOTHING <= 0) {
      return t;
    } else if (EFFECT_SMOOTHING >= 2.0) {
      return t * t * (3.0 - 2.0 * t);
    } else if (EFFECT_SMOOTHING >= 1.0) {
      if (t < 0.5) return 2 * t * t;
      return 1 - Math.pow(-2 * t + 2, 2) / 2;
    } else {
      const smooth_t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      return t + EFFECT_SMOOTHING * (smooth_t - t);
    }
  };
  const rel = configSmoothEasing(rawProgress);
  
  const marginX = canvas.width * 0.1;
  const marginY = canvas.height * 0.1;

  let curCx = endCx, curCy = endCy, curW = endW, curH = endH;
  if (eff && animDur > 0){
    if (eff === 'slide_lr'){
      const startCx = -endW/2;
      curCx = startCx + (endCx - startCx) * rel;
    } else if (eff === 'slide_rl'){
      const startCx = canvas.width + endW/2;
      curCx = startCx + (endCx - startCx) * rel;
    } else if (eff === 'slide_tb'){
      const startCy = -endH/2;
      curCy = startCy + (endCy - startCy) * rel;
    } else if (eff === 'slide_bt'){
      const startCy = canvas.height + endH/2;
      curCy = startCy + (endCy - startCy) * rel;
    } else if (eff === 'zoom_in' || eff === 'zoom_out'){
      const zoomAmount = 0.25;
      const s0 = (eff==='zoom_in')? (1.0 - zoomAmount) : 1.0; 
      const s1 = (eff==='zoom_in')? 1.0 : (1.0 - zoomAmount);
      const s = s0 + (s1 - s0) * rel; 
      
      // Use floating point for smooth sub-pixel rendering (no rounding)
      curW = Math.max(10, endW * s); 
      curH = Math.max(10, endH * s);
      
      // Keep center position stable
      curCx = endCx; 
      curCy = endCy;
    }
  }

  // Use sub-pixel rendering for smoother animations - don't round until final drawImage
  const dx = curCx - curW/2;
  const dy = curCy - curH/2;
  const dw = Math.max(1, curW);
  const dh = Math.max(1, curH);
  const sx = Math.max(0, Math.min(clip.crop.x, img.naturalWidth-1));
  const sy = Math.max(0, Math.min(clip.crop.y, img.naturalHeight-1));
  const sw = Math.max(1, Math.min(clip.crop.w, img.naturalWidth - sx));
  const sh = Math.max(1, Math.min(clip.crop.h, img.naturalHeight - sy));
  try{
    ctx.save();
    
    // Enable high-quality image smoothing for smooth zoom animations
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    if (clip.transform.rotation){
      ctx.translate(curCx, curCy);
      ctx.rotate((clip.transform.rotation || 0) * Math.PI/180);
      ctx.translate(-curCx, -curCy);
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  }catch(e){ /* ignore draw errors */ }
}

function renderClipWithTransition(currentClip, nextClip, t, progress) {
  const smoothEasing = (t) => {
    if (TRANSITION_SMOOTHING <= 0) {
      return t;
    } else if (TRANSITION_SMOOTHING >= 2.0) {
      return t * t * (3.0 - 2.0 * t);
    } else {
      const smooth_t = t * t * (3.0 - 2.0 * t);
      return t + TRANSITION_SMOOTHING/2.0 * (smooth_t - t);
    }
  };
  
  const easedProgress = smoothEasing(progress);
  
  ctx.save();
  
  const transitionType = nextClip.transition || 'slide_book';
  
  switch (transitionType) {
    case 'slide_book':
      renderSlideBookTransition(currentClip, nextClip, t, easedProgress);
      break;
    case 'fade':
      renderFadeTransition(currentClip, nextClip, t, easedProgress);
      break;
    case 'wipe_lr':
      renderWipeTransition(currentClip, nextClip, t, easedProgress, 'lr');
      break;
    case 'wipe_rl':
      renderWipeTransition(currentClip, nextClip, t, easedProgress, 'rl');
      break;
    default:
      renderClipToCanvas(currentClip, t);
      if (progress > 0.5) {
        renderClipToCanvas(nextClip, t);
      }
  }
  
  ctx.restore();
}

function renderSlideBookTransition(currentClip, nextClip, t, progress) {
  const canvasWidth = canvas.width;
  const slideDistance = canvasWidth * 0.8;
  
  ctx.save();
  ctx.translate(-slideDistance * progress, 0);
  renderClipToCanvas(currentClip, t);
  ctx.restore();
  
  ctx.save();
  ctx.translate(slideDistance * (1 - progress), 0);
  renderClipToCanvas(nextClip, t);
  ctx.restore();
}

function renderFadeTransition(currentClip, nextClip, t, progress) {
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  renderClipToCanvas(currentClip, t);
  ctx.restore();
  
  ctx.save();
  ctx.globalAlpha = progress;
  renderClipToCanvas(nextClip, t);
  ctx.restore();
}

function renderWipeTransition(currentClip, nextClip, t, progress, direction) {
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;
  
  renderClipToCanvas(currentClip, t);
  
  ctx.save();
  ctx.beginPath();
  
  if (direction === 'lr') {
    const wipeX = canvasWidth * progress;
    ctx.rect(0, 0, wipeX, canvasHeight);
  } else {
    const wipeX = canvasWidth * (1 - progress);
    ctx.rect(wipeX, 0, canvasWidth - wipeX, canvasHeight);
  }
  
  ctx.clip();
  renderClipToCanvas(nextClip, t);
  ctx.restore();
}

function renderOverlays(){
  if (!overlayEl) return;
  Array.from(overlayEl.children).forEach(ch => { if (!ch.classList.contains('preview-toolbar')) overlayEl.removeChild(ch); });
  const sel = getSelectedClip();

  const r = getClipRectOnCanvas(sel); if (!r) return;
  const canvasRect = canvas.getBoundingClientRect();
  const sx = canvasRect.width / canvas.width; const sy = canvasRect.height / canvas.height;
  const css = { x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) };
  const box = document.createElement('div'); box.className='selection-box'; box.style.left=css.x+'px'; box.style.top=css.y+'px'; box.style.width=css.w+'px'; box.style.height=css.h+'px';
  box.appendChild(makeHandle('nw')); box.appendChild(makeHandle('ne')); box.appendChild(makeHandle('sw')); box.appendChild(makeHandle('se')); box.appendChild(makeHandle('move'));
  overlayEl.appendChild(box);
  if (cropMode){
    const cr = getCropRectOnCanvas(sel);
    const crCss = { x: Math.round(cr.x * sx), y: Math.round(cr.y * sy), w: Math.round(cr.w * sx), h: Math.round(cr.h * sy) };
    const cbox = document.createElement('div'); cbox.className='crop-box'; cbox.style.left=crCss.x+'px'; cbox.style.top=crCss.y+'px'; cbox.style.width=crCss.w+'px'; cbox.style.height=crCss.h+'px';
    cbox.appendChild(makeCropHandle('nw')); cbox.appendChild(makeCropHandle('ne')); cbox.appendChild(makeCropHandle('sw')); cbox.appendChild(makeCropHandle('se')); cbox.appendChild(makeCropHandle('move'));
    overlayEl.appendChild(cbox);
  }
}

function makeHandle(anchor){ const d=document.createElement('div'); d.className='handle '+anchor; d.dataset.role='transform'; d.dataset.anchor=anchor; return d; }
function makeCropHandle(anchor){ const d=document.createElement('div'); d.className='crop-handle '+anchor; d.dataset.role='crop'; d.dataset.anchor=anchor; return d; }

function getSelectedClip(){ if (selectedLayerId && selectedIndex>=0){ const l = layers.find(x=>x.id===selectedLayerId); if (l && l.clips[selectedIndex]) return l.clips[selectedIndex]; } return selectedClip; }

function getClipRectOnCanvas(clip){ if (!clip || !clip.transform) return null; return { x: Math.round(clip.transform.x - clip.transform.w/2), y: Math.round(clip.transform.y - clip.transform.h/2), w: Math.round(clip.transform.w), h: Math.round(clip.transform.h) }; }

function getCropRectOnCanvas(clip){ const img = clip._img; if (!img) return {x:0,y:0,w:0,h:0}; const imgW = img.naturalWidth || 1, imgH = img.naturalHeight || 1; const scaleX = (clip.transform?.w || canvas.width) / imgW; const scaleY = (clip.transform?.h || canvas.height) / imgH; const r = getClipRectOnCanvas(clip); return { x: Math.round(r.x + clip.crop.x * scaleX), y: Math.round(r.y + clip.crop.y * scaleY), w: Math.round(clip.crop.w * scaleX), h: Math.round(clip.crop.h * scaleY) };
}

function canvasToImageDelta(clip, dxCanvas, dyCanvas){ const img = clip._img; if (!img) return {dx:0,dy:0}; const imgW = img.naturalWidth || 1, imgH = img.naturalHeight || 1; const scaleX = (clip.transform?.w || canvas.width) / imgW; const scaleY = (clip.transform?.h || canvas.height) / imgH; return { dx: dxCanvas/scaleX, dy: dyCanvas/scaleY };
}

function canvasPt(ev){
  if (!canvas) return { x: 0, y: 0, cssX: 0, cssY: 0 };
  const r = canvas.getBoundingClientRect();
  let clientX = ev.clientX, clientY = ev.clientY;
  if ((clientX == null || clientY == null) && ev.touches && ev.touches[0]){
    clientX = ev.touches[0].clientX; clientY = ev.touches[0].clientY;
  }
  if (clientX == null || clientY == null){
    try { clientX = ev.pageX; clientY = ev.pageY; } catch(e) { clientX = 0; clientY = 0; }
  }
  return {
    x: (clientX - r.left) * (canvas.width / r.width),
    y: (clientY - r.top) * (canvas.height / r.height),
    cssX: clientX - r.left,
    cssY: clientY - r.top
  };
}

function pickClipAtPoint(x, y, t){
  try{
    const all = flattenLayersToTimeline().filter(c=> c.type==='image');
    const active = all.filter(c=>{
      const st = c.startTime||0; const dur = (c.duration!=null)? Number(c.duration):(c.type==='image'?2:0);
      return t >= st && t <= st + dur + 1e-4;
    });
    active.sort((a,b)=> (a._layerIndex||0) - (b._layerIndex||0));
    for (let i = active.length - 1; i >= 0; i--){
      const c = active[i];
      c.transform = c.transform || { x: canvas.width/2, y: canvas.height/2, w: canvas.width, h: canvas.height, rotation: 0 };
      const r = getClipRectOnCanvas(c);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return c;
    }
  }catch(e){ /* ignore */ }
  return null;
}

function onCanvasPointerDown(ev){ if (isPlaying) return; let sel = getSelectedClip(); const ptCssX = (ev.clientX!=null? ev.clientX : (ev.touches&&ev.touches[0]&&ev.touches[0].clientX)||0); const ptCssY = (ev.clientY!=null? ev.clientY : (ev.touches&&ev.touches[0]&&ev.touches[0].clientY)||0); let elAt = document.elementFromPoint(ptCssX, ptCssY); const pt = canvasPt(ev);
  let role = null, anchor = null;
  try{ if (ev.target && (ev.target.closest && ev.target.closest('.preview-toolbar'))){ ev.preventDefault(); ev.stopPropagation(); return; } }catch(e){}
  if (elAt){
    const handleEl = elAt.closest ? elAt.closest('.handle, .crop-handle') : null;
    elAt = handleEl || elAt;
    role = elAt && elAt.dataset && elAt.dataset.role;
    anchor = elAt && elAt.dataset && elAt.dataset.anchor;
  }
  if (!sel || (sel && role !== 'transform' && role !== 'crop')){
    const pick = pickClipAtPoint(pt.x, pt.y, playhead);
    if (pick){
      selectedLayerId = pick._layerId; selectedIndex = pick._clipIndex; selectedClip = pick; sel = pick; renderOverlays();
    }
  }
  if (role==='transform'){ interaction = { from:'canvas', mode: anchor==='move'?'move':'resize', anchor, start: pt, orig: JSON.parse(JSON.stringify(sel.transform)) }; ev.preventDefault(); ev.stopPropagation(); return; }
  if (role==='crop'){ interaction = { from:'canvas', mode: anchor==='move'?'crop-move':'crop-resize', anchor, start: pt, orig: JSON.parse(JSON.stringify(sel.crop)) }; ev.preventDefault(); ev.stopPropagation(); return; }
  const r = getClipRectOnCanvas(sel); if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h){ interaction = { from:'canvas', mode: 'move', anchor: 'move', start: pt, orig: JSON.parse(JSON.stringify(sel.transform)) }; ev.preventDefault(); ev.stopPropagation(); }
}

function onCanvasPointerMove(ev){
  try{
    if (!interaction || interaction.from !== 'canvas') return;
    const sel = getSelectedClip(); if (!sel) { interaction=null; return; }
    const pt = canvasPt(ev); const dx = pt.x - interaction.start.x; const dy = pt.y - interaction.start.y;
    if (interaction.mode === 'move'){
      sel.transform = sel.transform || { x: 0, y: 0, w: canvas.width, h: canvas.height, rotation: 0 };
      sel.transform.x = interaction.orig.x + dx; sel.transform.y = interaction.orig.y + dy;
    }
    else if (interaction.mode === 'resize'){
      sel.transform = sel.transform || { x: 0, y: 0, w: canvas.width, h: canvas.height, rotation: 0 };
      const start = { x: interaction.orig.x - interaction.orig.w/2, y: interaction.orig.y - interaction.orig.h/2, w: interaction.orig.w, h: interaction.orig.h };
      let nx = start.x, ny = start.y, nw = start.w, nh = start.h;
      if (interaction.anchor==='nw'){ nx += dx; ny += dy; nw -= dx; nh -= dy; }
      if (interaction.anchor==='ne'){ ny += dy; nw += dx; nh -= dy; }
      if (interaction.anchor==='sw'){ nx += dx; nw -= dx; nh += dy; }
      if (interaction.anchor==='se'){ nw += dx; nh += dy; }
      nw = Math.max(40, nw); nh = Math.max(40, nh); sel.transform.x = nx + nw/2; sel.transform.y = ny + nh/2; sel.transform.w = nw; sel.transform.h = nh;
    }
    else if (interaction.mode === 'crop-move' || interaction.mode === 'crop-resize'){
      sel.crop = sel.crop || { x: 0, y: 0, w: 10, h: 10 };
      const start = interaction.orig; let cx = start.x, cy = start.y, cw = start.w, ch = start.h; if (interaction.mode==='crop-move'){ const d = canvasToImageDelta(sel, dx, dy); cx += d.dx; cy += d.dy; } else {
        const d = canvasToImageDelta(sel, dx, dy);
        if (interaction.anchor==='nw'){ cx += d.dx; cy += d.dy; cw -= d.dx; ch -= d.dy; }
        if (interaction.anchor==='ne'){ cy += d.dy; cw += d.dx; ch -= d.dy; }
        if (interaction.anchor==='sw'){ cx += d.dx; cw -= d.dx; ch += d.dy; }
        if (interaction.anchor==='se'){ cw += d.dx; ch += d.dy; }
        cw = Math.max(10, cw); ch = Math.max(10, ch);
      }
      const img = sel._img; const w = (img && img.naturalWidth) || 1, h = (img && img.naturalHeight) || 1; cx = Math.max(0, Math.min(cx, w-1)); cy = Math.max(0, Math.min(cy, h-1)); if (cx+cw> w) cw = w - cx; if (cy+ch> h) ch = h - cy; sel.crop = { x: cx, y: cy, w: cw, h: ch };
    }
    drawFrame(playhead);
  }catch(e){
    console.warn('[canvas] pointer move ignored due to error:', e);
    try { interaction = null; } catch(_e){}
  }
}

function onCanvasPointerUp(){ if (interaction && interaction.from === 'canvas'){ interaction = null; scheduleAutosave(); } }

function getClipDurationEstimate(clip){
  try{
    const d = (clip && clip.duration!=null) ? Number(clip.duration) : 0;
    if (d && isFinite(d) && d>0) return d;
    const playable = getPlayableSrc(clip && clip.src);
    const el = playable && preloadedAudioEls[playable];
    if (el && isFinite(el.duration) && el.duration>0) return Number(el.duration);
  }catch(e){}
  return 0;
}

function findCurrentOrNextAudioClip(auds, t){
  let current = null;
  let next = null;
  for (const c of auds){
    const st = Number(c.startTime||0);
    const dur = getClipDurationEstimate(c) || ((c.duration!=null)? Number(c.duration):0);
    if (dur > 0 && t >= st && t < st + dur){ current = c; break; }
    if (st >= t){ if (!next || st < Number(next.startTime||0)) next = c; }
  }
  return current || next;
}

function scheduleAudioForPlayback(){
  clearAudioPlayback();
  const all = flattenLayersToTimeline();
  const auds = all.filter(c=> c.type==='audio' && c.src).sort((a,b)=> (a.startTime||0) - (b.startTime||0));
  DBG('Scheduling audio - found audio clips:', auds.length);
  // Compute total override from actual durations so RAF won't stop early
  try{
    let total = 0;
    for (const c of auds){ 
      const dur = getClipDurationEstimate(c);
      DBG(`  Audio clip: start=${(c.startTime||0).toFixed(2)}s, duration=${dur.toFixed(2)}s, end=${((c.startTime||0) + dur).toFixed(2)}s`);
      total += dur;
    }
    playbackTotalOverride = (total && isFinite(total) && total>0) ? total : null;
    DBG(`Set playbackTotalOverride to ${playbackTotalOverride ? playbackTotalOverride.toFixed(2) : 'null'}s`);
  }catch(e){ 
    DBG('Error computing playbackTotalOverride:', e);
    playbackTotalOverride = null; 
  }
  
  if (auds.length === 0) return;
  const clip = findCurrentOrNextAudioClip(auds, playhead);
  if (!clip) return;
  
  DBG('Selected audio clip:', { src: clip.src, startTime: clip.startTime, duration: clip.duration });
  
  const playable = getPlayableSrc(clip.src);
  DBG('Playable src after getPlayableSrc:', playable);
  
  if (!playable) {
    DBG('ERROR: No playable src found for clip:', clip.src);
    return;
  }
  let audio;
  if (preloadedAudioEls[playable]){
    audio = preloadedAudioEls[playable];
  } else {
    audio = new Audio(playable);
    try{ audio.crossOrigin = 'anonymous'; }catch(e){}
    audio.preload = 'auto';
    preloadedAudioEls[playable] = audio;
  }
  activeAudio = audio;
  try{ audio.pause(); }catch(e){}
  audio.onended = null; audio.onerror = null; audio.onstalled = null; audio.onwaiting = null; audio.onloadedmetadata = null;
  audio.onerror = ()=>{ const err = audio.error ? audio.error.code : 'unknown'; DBG('HTMLAudio error', { src: playable, code: err, readyState: audio.readyState }); };
  audio.onstalled = ()=>{ DBG('HTMLAudio stalled', { src: playable }); };
  audio.onwaiting = ()=>{ DBG('HTMLAudio waiting', { src: playable }); };
  audio.onended = ()=>{
    const playedDur = (isFinite(audio.duration) && audio.duration>0) ? Number(audio.duration) : (clip.duration!=null? Number(clip.duration):0);
    const curEnd = (clip.startTime||0) + playedDur;
    const nextClip = findCurrentOrNextAudioClip(auds, curEnd + 0.001);
    if (!isPlaying || !nextClip) return;
    playhead = Math.max(playhead, curEnd);
    if (activeAudioTimeout){ try{ clearTimeout(activeAudioTimeout); }catch(e){} }
    activeAudioTimeout = setTimeout(()=>{ scheduleAudioForPlayback(); }, 0);
  };
  if (playhead < (clip.startTime||0)){
    playhead = (clip.startTime||0);
    try{ drawFrame(playhead); }catch(e){}
  }
  const offset = Math.max(0, playhead - (clip.startTime||0));
  const seekAndPlay = ()=>{
    const target = Math.max(0, offset);
    const actuallyPlay = ()=>{
      audio.play().then(()=>{ DBG('HTMLAudio play started', { src: playable, at: (clip.startTime||0)+target }); }).catch(err=>{ DBG('HTMLAudio play error', err); });
    };
    const doSeek = ()=>{
      let want = target;
      try{
        if (isFinite(audio.duration) && audio.duration > 0){
          want = Math.min(audio.duration - 0.05, target);
        } else {
          want = target;
        }
        audio.currentTime = want;
      }catch(e){ /* ignore set error; will try play anyway */ }
      if (audio.seeking){
        const onSeeked = ()=>{ audio.removeEventListener('seeked', onSeeked); actuallyPlay(); };
        audio.addEventListener('seeked', onSeeked, { once: true });
      } else {
        setTimeout(actuallyPlay, 0);
      }
    };
    if (audio.readyState >= 1 && isFinite(audio.duration) && audio.duration > 0){
      doSeek();
    } else {
      audio.onloadedmetadata = ()=>{ audio.onloadedmetadata = null; doSeek(); };
      try{ audio.load(); }catch(e){}
    }
    try{
      if (isFinite(audio.duration) && audio.duration > 0){
        const real = Number(audio.duration);
        const orig = findOriginalClip(clip);
        if (orig && (orig.duration == null || Math.abs(Number(orig.duration) - real) > 0.01)){
          orig.duration = real;
          try{
            const videoLayer = layers.find(l => l.id === 'video-layer');
            if (videoLayer && typeof orig._clipIndex === 'number' && videoLayer.clips[orig._clipIndex]){
              videoLayer.clips[orig._clipIndex].duration = real;
            }
          }catch(_e){}
          timeline = flattenLayersToTimeline();
          renderTimeline();
          updateTotalDuration();
        }
      }
    }catch(_e){}
  };
  if (audio.readyState >= 1){ seekAndPlay(); } else { audio.onloadedmetadata = seekAndPlay; try{ audio.load(); }catch(e){} }
}

function clearAudioPlayback(){
  try{
    if (activeAudioTimeout){ clearTimeout(activeAudioTimeout); activeAudioTimeout = null; }
    if (activeAudio){
      try{ activeAudio.pause(); }catch(e){}
      try{ if (isFinite(activeAudio.duration)) activeAudio.currentTime = 0; }catch(e){}
      activeAudio = null;
    }
    playbackTotalOverride = null;
    Object.values(audioFetchControllers).forEach(ctrl=>{ try{ ctrl.abort(); }catch(e){} });
    audioFetchControllers = {};
  }catch(e){}
  previewControllers = [];
}

function getCanvasTotalDuration(){
  try{
    const t = playbackTotalOverride;
    if (t && isFinite(t) && t>0) return t;
  }catch(e){}
  return computeTotalDuration();
}

function preloadImageAssets(){
  try {
    const all = flattenLayersToTimeline();
    const imageClips = all.filter(c => c.type === 'image' && c.src);
    
    imageClips.forEach(clip => {
      if (!clip._img && !clip._imgLoading) {
        clip._imgLoading = true;
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          clip._imgLoading = false;
          clip._imgLoaded = true;
          
          const originalClip = findOriginalClip(clip);
          if (originalClip) {
            originalClip._img = im;
            originalClip._imgLoading = false;
            originalClip._imgLoaded = true;
          }
          
          DBG('Preloaded image:', clip.src);
        };
        im.onerror = () => {
          clip._imgLoading = false;
          clip._imgError = true;
          
          const originalClip = findOriginalClip(clip);
          if (originalClip) {
            originalClip._imgLoading = false;
            originalClip._imgError = true;
          }
          
          DBG('Failed to preload image:', clip.src);
        };
        im.src = normalizeSrc(clip.src);
        clip._img = im;
        
        const originalClip = findOriginalClip(clip);
        if (originalClip) {
          originalClip._img = im;
          originalClip._imgLoading = true;
        }
      }
    });
  } catch(e) {
  }
}

function findOriginalClip(flattenedClip) {
  try {
    if (typeof flattenedClip._layerIndex === 'number' && typeof flattenedClip._clipIndex === 'number') {
      return layers[flattenedClip._layerIndex]?.clips[flattenedClip._clipIndex];
    }
  } catch(e) {
    DBG('Error finding original clip:', e);
  }
  return null;
}

function preloadAudioAssets(){
  if (audioPreloadInProgress) {
    DBG('Audio preload already in progress, skipping duplicate call');
    return;
  }
  
  audioPreloadInProgress = true;
  DBG('Starting audio preload (locked)');
  
  if (!window.audioAssetsCleanedUp) {
    try {
      DBG('Starting aggressive cleanup of stale blob URLs...');
      
      Object.values(audioObjectUrlMap).forEach(({ url }) => {
        try { URL.revokeObjectURL(url); } catch(e) {}
      });
      Object.keys(audioObjectUrlMap).forEach(key => delete audioObjectUrlMap[key]);
      Object.keys(preloadedAudioEls).forEach(key => {
        if (key.startsWith('blob:')) delete preloadedAudioEls[key];
      });
      
      try {
        layers.forEach((layer, layerIndex) => {
          layer.clips.forEach((clip, clipIndex) => {
            if (clip.type === 'audio' && clip.src) {
              const src = String(clip.src);
              if (src.startsWith('blob:')) {
                DBG(`Found stale blob URL in layer[${layerIndex}].clips[${clipIndex}]:`, src);
                if (clip.meta && clip.meta.originalSrc) {
                  clip.src = clip.meta.originalSrc;
                  DBG('Reset to originalSrc:', clip.meta.originalSrc);
                } else {
                  if (clip.meta && clip.meta.filename) {
                    clip.src = '/uploads/' + clip.meta.filename;
                    DBG('Reset to filename-based URL:', clip.src);
                  } else {
                    DBG('ERROR: No fallback found for stale blob URL, keeping as-is');
                  }
                }
              }
            }
          });
        });
        
        if (window.timeline && Array.isArray(timeline)) {
          timeline.forEach((clip, index) => {
            if (clip.type === 'audio' && clip.src) {
              const src = String(clip.src);
              if (src.startsWith('blob:')) {
                DBG(`Found stale blob URL in timeline[${index}]:`, src);
                if (clip.meta && clip.meta.originalSrc) {
                  clip.src = clip.meta.originalSrc;
                  DBG('Reset timeline clip to originalSrc:', clip.meta.originalSrc);
                }
              }
            }
          });
        }
        
      } catch(e) {
        DBG('Error cleaning clip blob references:', e);
      }
      
      window.audioAssetsCleanedUp = true;
      DBG('Aggressive cleanup completed');
    } catch(e) {
      DBG('Error during blob cleanup:', e);
    }
  }
  
  try{
    const all = flattenLayersToTimeline();
    const clipAuds = all.filter(c=> c.type==='audio' && c.src).map(c=> c.src);
    const assetAuds = (audios||[]).map(a=> a.src || a.meta).filter(Boolean);
    const combined = [...clipAuds, ...assetAuds];
    const seen = new Set();
    const toProcess = [];
    combined.forEach(entry=>{
      const src = getPlayableSrc(entry);
      if (!src || seen.has(src)) return; seen.add(src);
      toProcess.push({ clipRef: entry, src });
    });

    const isBlobLike = (s)=> typeof s === 'string' && (s.startsWith('blob:') || s.startsWith('data:'));
    const isHttpLike = (s)=> typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'));
    const guessMime = (s)=> s && s.toLowerCase().includes('.mp3') ? 'audio/mpeg' : 'audio/wav';
    const fileNameFromPath = (s)=>{ try{ const u = new URL(s, window.location.origin); return (u.pathname.split('/').pop()) || 'audio.wav'; }catch(_e){ const parts = String(s).split('/'); return parts[parts.length-1] || 'audio.wav'; } };

    toProcess.forEach(({clipRef, src})=>{
      if (preloadedAudioEls[src]) return;
      if (isBlobLike(src)){
        const a = new Audio();
        try{ a.crossOrigin = 'anonymous'; }catch(e){}
        a.preload = 'auto'; a.src = src;
        
        const loadTimeout = setTimeout(() => {
          DBG('audio load timeout', { src });
          try { a.src = ''; } catch(e) {}
        }, 5000);
        
        a.addEventListener('loadedmetadata', ()=>{ 
          clearTimeout(loadTimeout);
          DBG('audio preloaded metadata', { src, duration: a.duration }); 
        }, { once: true });
        
        a.addEventListener('canplaythrough', ()=>{ 
          clearTimeout(loadTimeout);
          DBG('audio canplaythrough', { src }); 
          if (window.__audioCompletionCallback) window.__audioCompletionCallback(src);
        }, { once: true });
        
        a.addEventListener('error', ()=>{ 
          clearTimeout(loadTimeout);
          DBG('audio preload error', { src, code: a.error && a.error.code }); 
          if (window.__audioCompletionCallback) window.__audioCompletionCallback(src);
        });
        
        preloadedAudioEls[src] = a; try{ a.load(); }catch(e){ clearTimeout(loadTimeout); }
        try{ const pool = document.getElementById('hidden-audio-pool'); if (pool) pool.appendChild(a); }catch(e){}
        return;
      }
      if (isHttpLike(src)){
        (async()=>{
          try{
            if (!audioObjectUrlMap[src]){
              DBG('Fetching audio from:', src);
              const controller = new AbortController();
              const timeoutId = setTimeout(() => {
                DBG('Audio fetch timeout for:', src);
                controller.abort();
              }, 10000);
              
              const resp = await fetch(src, { signal: controller.signal });
              clearTimeout(timeoutId);
              DBG('Audio fetch response received:', src, resp.status);
              
              if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
              }
              
              const blob = await resp.blob();
              DBG('Audio blob created:', src, blob.size, 'bytes');
              const objUrl = URL.createObjectURL(blob);
              audioObjectUrlMap[src] = { url: objUrl, blob };
              DBG('Audio object URL created:', src, objUrl);
            }
            const { url: objUrl, blob } = audioObjectUrlMap[src];
            const a = new Audio();
            DBG('Creating audio element for:', objUrl);
            try{ a.crossOrigin = 'anonymous'; }catch(e){}
            a.preload = 'auto'; a.src = objUrl;
            
            const loadTimeout = setTimeout(() => {
              DBG('audio load timeout', { src: objUrl });
              try { a.src = ''; } catch(e) {}
            }, 5000);
            
            a.addEventListener('loadedmetadata', ()=>{ 
              clearTimeout(loadTimeout);
              DBG('audio preloaded metadata', { src: objUrl, duration: a.duration }); 
            }, { once: true });
            
            a.addEventListener('canplaythrough', ()=>{ 
              clearTimeout(loadTimeout);
              DBG('audio canplaythrough', { src: objUrl }); 
              if (window.__audioCompletionCallback) window.__audioCompletionCallback(src);
            }, { once: true });
            
            a.addEventListener('error', ()=>{ 
              clearTimeout(loadTimeout);
              DBG('audio preload error', { src: objUrl, code: a.error && a.error.code }); 
              if (window.__audioCompletionCallback) window.__audioCompletionCallback(src);
            });
            
            preloadedAudioEls[src] = a; preloadedAudioEls[objUrl] = a;
            DBG('Starting audio load for:', objUrl);
            try{ a.load(); }catch(e){ 
              clearTimeout(loadTimeout); 
              DBG('Audio load() failed:', e);
            }
            try{ const pool = document.getElementById('hidden-audio-pool'); if (pool) pool.appendChild(a); }catch(e){}
            const applyToClip = (cl)=>{
              if (!cl || cl.type!=='audio') return;
              const norm = getPlayableSrc(cl.src);
              if (norm === src){
                cl.meta = Object.assign({}, cl.meta||{}, {
                  audioBlob: blob,
                  filename: cl.meta?.filename || fileNameFromPath(src),
                  mime: cl.meta?.mime || guessMime(src),
                  originalSrc: src
                });
                cl.src = objUrl;
              }
            };
            try{
              layers.forEach(l=> l.clips.forEach(applyToClip));
              timeline = flattenLayersToTimeline();
            }catch(_e){}
          }catch(err){ 
            DBG('preload fetch error', { src, err }); 
          } finally {
            DBG('Audio preload attempt completed for:', src);
          }
        })();
      }
    });
    if (toProcess.length){ 
      DBG('preload queued', { count: toProcess.length }); 
      
      let completedAudio = 0;
      const totalAudio = toProcess.length;
      const completedSources = new Set();
      
      const checkAllComplete = (src) => {
        if (completedSources.has(src)) return;
        completedSources.add(src);
        completedAudio++;
        if (completedAudio >= totalAudio) {
          audioPreloadInProgress = false;
          
          if (document.getElementById('loadingModal')?.style.display !== 'none') {
            updateLoadingProgress(100, 100, 'All audio preloaded! Video editor ready.');
            setTimeout(() => {
              hideLoadingModal();
            }, 500);
          }
          
          if (document.readyState !== 'complete') {
            stopRaf();
            clearAudioPlayback();
          }
          
          setTimeout(() => {
            if (document.readyState !== 'complete') {
              if (window.pageMonitorInterval) {
                clearInterval(window.pageMonitorInterval);
              }
              
              window.videoEditorLoaded = true;
              
              try {
                stopRaf();
              } catch (e) {
              }
              
              if (window.resizeTimer) {
                clearTimeout(window.resizeTimer);
                window.resizeTimer = null;
                DBG('Cleared resize timer');
              }
              if (window.activeAudioTimeout) {
                clearTimeout(window.activeAudioTimeout);
                window.activeAudioTimeout = null;
                DBG('Cleared audio timeout');
              }
              
              try {
                window.__renderJobId = null;
                DBG('Cleared render job ID to prevent EventSource connections');
              } catch (e) {
                DBG('Error clearing EventSource:', e);
              }
              
              if (window.resizeTimer) {
                clearTimeout(window.resizeTimer);
                window.resizeTimer = null;
              }
              if (window.activeAudioTimeout) {
                clearTimeout(window.activeAudioTimeout);
                window.activeAudioTimeout = null;
              }
              
              try {
                Object.defineProperty(document, 'readyState', {
                  value: 'complete',
                  writable: false,
                  configurable: true
                });
                
                window.dispatchEvent(new CustomEvent('videoEditorComplete', {
                  detail: { message: 'Video editor initialization complete' }
                }));
                
                DBG('Page completion signaled successfully');
              } catch (e) {
                DBG('Error during completion signaling:', e);
              }
            } else {
              DBG('Page already complete, no action needed');
            }
          }, 100);
        }
      };
      
      window.__audioCompletionCallback = checkAllComplete;
      
    } else {
      DBG('No audio assets to preload');
      audioPreloadInProgress = false;
    }
    DBG('Audio preload function completed');
  }catch(e){ 
    DBG('preload error', e); 
    audioPreloadInProgress = false;
  }
}

function renderRuler(){
  const ruler = document.getElementById('timelineRuler');
  if (!ruler) return;
  let total = 0;
  layers.forEach(l=>{ l.clips.forEach(c=> { const end = (c.startTime||0) + ((c.duration!=null)? Number(c.duration): (c.type==='image'?2:0)); total = Math.max(total, end); }) });
  const desiredWidth = Math.ceil(total * pxPerSec);
  const viewportEl = document.querySelector('.timeline-viewport');
  const vpWidth = viewportEl ? Math.floor(viewportEl.getBoundingClientRect().width) : 0;
  const minWidth = Math.max(800, vpWidth || 0);
  const width = Math.max(minWidth, desiredWidth);
  viewPxPerSec = pxPerSec;
  ruler.innerHTML = '';
  ruler.style.width = width + 'px';
  for (let s=0; s<= Math.ceil(Math.max(10, total)); s++){
    const tick = document.createElement('div'); tick.className='tick'; tick.style.left = (s * viewPxPerSec) + 'px'; tick.style.width = Math.max(1, Math.floor(viewPxPerSec)) + 'px'; tick.textContent = formatTime(s);
    ruler.appendChild(tick);
  }
  const outer = document.getElementById('timelineOuter'); if (outer) outer.style.width = width + 'px';
}

function persistZoom(){
  try{ window.localStorage.setItem('video_editor_pxPerSec', String(pxPerSec)); }catch(e){}
}

function recalcViewScale(){
  viewPxPerSec = pxPerSec;
}

function onDragStartAsset(e) {
  const el = e.currentTarget;
  e.dataTransfer.setData('text/plain', JSON.stringify({id: el.dataset.id, type: el.dataset.type}));
}

function onDropToTimeline(e) {
  e.preventDefault();
  const payload = JSON.parse(e.dataTransfer.getData('text/plain'));
  const {id, type} = payload;
  let layer = layers.find(l => l.id === activeLayerId) || layers[0];
  if (isBackgroundLayer(layer)){
    layer = layers.find(l=> !isBackgroundLayer(l));
    if (!layer){ addLayer(); layer = layers[layers.length-1]; }
  }
  if (!layer) return;
  const dropSec = computeDropSecondsFromEvent(e);
  if (type === 'image') {
    const panel = panels.find(p => p.id === id);
    if (!panel) return;
    const clip = {type:'image', src: panel.src, id: panel.id, duration: 2, startTime: 0, effect: panel.effect || 'slide_lr'};
    insertClipIntoLayerAt(layer, clip, dropSec);
    scheduleAutosave();
  } else if (type === 'audio') {
    const audio = audios.find(a => a.id === id);
    if (!audio) return;
    const playable = getPlayableSrc(audio.src || audio.meta);
    const clip = {type:'audio', src: playable || '', id: audio.id, duration: null, startTime: 0, meta: audio.meta};
    insertClipIntoLayerAt(layer, clip, dropSec);
    if (clip.src) {
      extractAudioDuration(clip).then(d => { clip.duration = d; timeline = flattenLayersToTimeline(); renderTimeline(); scheduleAutosave(); });
    }
  }
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
}

function renderTimeline() {
  const track = document.getElementById('timelineTrack');
  track.innerHTML = '';
  renderRuler();
  layers.forEach((layer, lidx) => {
    const layerRoot = document.createElement('div');
    layerRoot.className = 'timeline-layer';
    layerRoot.dataset.layerId = layer.id;
    const header = document.createElement('div');
    header.className = 'layer-header';
    const chip = document.createElement('div'); chip.className = 'layer-chip'; chip.textContent = layer.name + (layer.id === activeLayerId ? ' (active)' : '');
    header.appendChild(chip);
    const addBtn = document.createElement('button'); addBtn.className = 'btn secondary'; addBtn.textContent = 'Select';
    addBtn.addEventListener('click', () => { activeLayerId = layer.id; renderTimeline(); renderLayerControls(); });
    if (!isBackgroundLayer(layer)) {
      const removeBtn = document.createElement('button'); removeBtn.className = 'btn secondary'; removeBtn.textContent = 'Remove Layer';
      removeBtn.addEventListener('click', ()=>{ removeLayer(layer.id); });
      header.appendChild(addBtn); header.appendChild(removeBtn);
    } else {
      header.appendChild(addBtn);
    }
    const container = document.createElement('div'); container.style.display='flex'; container.style.flexDirection='column'; container.appendChild(header);

  const clipsContainer = document.createElement('div'); clipsContainer.className = 'layer-clips'; clipsContainer.style.position='relative'; clipsContainer.style.minHeight='84px'; clipsContainer.dataset.layerId = layer.id;
    clipsContainer.ondragover = (ev)=> ev.preventDefault();
    clipsContainer.ondrop = (ev)=> { ev.stopPropagation(); if (!isBackgroundLayer(layer)) onDropToLayer(ev, layer.id); };

    layer.clips.forEach((clip, idx) => {
      const el = document.createElement('div');
      el.className = 'clip';
      el.dataset.idx = idx; el.dataset.layerId = layer.id; el.draggable = false;
      if (clip.type === 'image') {
        el.innerHTML = `<img src="${clip.src}" alt="clip-${idx}" loading="lazy" decoding="async"/><div class="info"><div style=\"font-weight:700\">Image</div><div class=\"small\">${clip.id || ''}</div></div><div class="duration-badge">${(clip.duration||2).toFixed(1)}s</div><div class="start-badge">${formatTime(clip.startTime||0)}</div><div class="remove" title="Remove">✕</div><div class="clip-handle" title="Resize"></div>`;
      } else {
        el.innerHTML = `<div style=\"width:88px;height:68px;background:#071226;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#9fc0ff\">AUD</div><div class=\"info\"><div style=\"font-weight:700\">Audio</div><div class=\"small\">${clip.id || ''}</div></div><div class=\"duration-badge\">${clip.duration? (clip.duration.toFixed(1)+"s") : '—'}</div><div class=\"start-badge\">${formatTime(clip.startTime||0)}</div><div class=\"remove\" title=\"Remove\">✕</div><div class=\"clip-handle\" title=\"Resize\"></div>`;
      }
      const st = clip.startTime || 0; const dur = (clip.duration != null)? Number(clip.duration) : (clip.type==='image'?2:0);
  el.style.left = (st * viewPxPerSec) + 'px'; el.style.width = Math.max(88, dur * viewPxPerSec) + 'px';
      if (!isBackgroundLayer(layer)){
        el.addEventListener('mousedown', onClipDragStart);
        el.addEventListener('touchstart', onClipDragStart, {passive:false});
      }
      const handle = el.querySelector('.clip-handle');
      if (handle && !isBackgroundLayer(layer)){ handle.addEventListener('mousedown', onClipResizeStart); handle.addEventListener('touchstart', onClipResizeStart, {passive:false}); }
      el.addEventListener('click', ()=> selectLayerClip(layer.id, idx));
      const removeBtns = el.querySelectorAll('.remove');
      removeBtns.forEach(btn => {
        if (!isBackgroundLayer(layer)){
          btn.addEventListener('mousedown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); });
          btn.addEventListener('touchstart', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); }, {passive:false});
          btn.addEventListener('click', (ev) => { ev.stopPropagation(); removeClipFromLayer(layer.id, idx); });
        } else {
          btn.style.display = 'none';
        }
      });
      clipsContainer.appendChild(el);
    });

    container.appendChild(clipsContainer);
    layerRoot.appendChild(container);
    track.appendChild(layerRoot);
  });
  try{ preloadImageAssets(); }catch(e){}
  try{ preloadAudioAssets(); }catch(e){}
}

let dragging = null;
let dragOffsetX = 0;

function onClipDragStart(ev){
  ev.preventDefault();
  const el = ev.currentTarget;
  const layerId = el.dataset.layerId; const idx = Number(el.dataset.idx);
  const layer = layers.find(l=>l.id===layerId); if (!layer) return;
  dragging = {el, layer, idx};
  el.classList.add('dragging');
  const clientX = ev.touches? ev.touches[0].clientX : ev.clientX;
  const rect = el.getBoundingClientRect(); dragOffsetX = clientX - rect.left;
  window.addEventListener('mousemove', onClipDragMove);
  window.addEventListener('mouseup', onClipDragEnd);
  window.addEventListener('touchmove', onClipDragMove, {passive:false});
  window.addEventListener('touchend', onClipDragEnd);
}

function onClipDragMove(ev){
  if (!dragging) return;
  ev.preventDefault();
  const clientX = ev.touches? ev.touches[0].clientX : ev.clientX;
  const outer = document.getElementById('timelineOuter'); if (!outer) return;
  const outerRect = outer.getBoundingClientRect();
  const leftPx = clientX - outerRect.left - dragOffsetX;
  const snappedSec = Math.max(0, Math.round((leftPx / viewPxPerSec) / snapSeconds) * snapSeconds);
  const newLeftPx = snappedSec * viewPxPerSec;
  dragging.el.style.left = newLeftPx + 'px';
}

function onClipDragEnd(ev){
  if (!dragging) return;
  const el = dragging.el; const layer = dragging.layer; const idx = dragging.idx;
  el.classList.remove('dragging');
  const leftPx = parseFloat(el.style.left || '0');
  const newStart = Math.max(0, Math.round((leftPx / viewPxPerSec) / snapSeconds) * snapSeconds);
  const moving = layer.clips.splice(idx, 1)[0];
  let insertIndex = layer.clips.length;
  for (let i=0;i<layer.clips.length;i++){
    const c = layer.clips[i];
    const cStart = c.startTime || 0;
    const cDur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    const cEnd = cStart + (cDur || 0);
    if (newStart < cStart){ insertIndex = i; break; }
    if (newStart >= cStart && newStart <= cEnd){ const mid = cStart + (cDur || 0)/2; insertIndex = (newStart < mid) ? i : i+1; break; }
  }

  layer.clips.splice(insertIndex, 0, moving);
  if (insertIndex > 0){
    const prev = layer.clips[insertIndex-1];
    const prevEnd = (prev.startTime || 0) + ((prev.duration!=null)? Number(prev.duration) : (prev.type==='image'?2:0));
    moving.startTime = Math.max(newStart, prevEnd);
  } else {
    moving.startTime = newStart;
  }

  const movedEnd = (moving.startTime || 0) + ((moving.duration!=null)? Number(moving.duration) : (moving.type==='image'?2:0));
  let cursor = movedEnd;
  for (let i = insertIndex+1; i<layer.clips.length; i++){
    const c = layer.clips[i];
    if ((c.startTime||0) < cursor){ c.startTime = cursor; }
    const dur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    cursor = (c.startTime||0) + (dur || 0);
  }
  timeline = flattenLayersToTimeline(); renderTimeline();
  fixLayerOverlaps(layer);
  scheduleAutosave();
  window.removeEventListener('mousemove', onClipDragMove);
  window.removeEventListener('mouseup', onClipDragEnd);
  window.removeEventListener('touchmove', onClipDragMove);
  window.removeEventListener('touchend', onClipDragEnd);
  dragging = null;
}

let resizing = null;
let resizeStartX = 0;
let resizeStartWidth = 0;
function onClipResizeStart(ev){
  ev.preventDefault(); ev.stopPropagation();
  const handle = ev.currentTarget;
  const clipEl = handle.closest('.clip');
  const layerId = clipEl.dataset.layerId; const idx = Number(clipEl.dataset.idx);
  const layer = layers.find(l=>l.id===layerId); if (!layer) return;
  resizing = { clipEl, layer, idx };
  clipEl.classList.add('resizing');
  resizeStartX = ev.touches? ev.touches[0].clientX : ev.clientX;
  resizeStartWidth = clipEl.getBoundingClientRect().width;
  window.addEventListener('mousemove', onClipResizeMove);
  window.addEventListener('mouseup', onClipResizeEnd);
  window.addEventListener('touchmove', onClipResizeMove, {passive:false});
  window.addEventListener('touchend', onClipResizeEnd);
}

function onClipResizeMove(ev){
  if (!resizing) return;
  ev.preventDefault();
  const clientX = ev.touches? ev.touches[0].clientX : ev.clientX;
  const dx = clientX - resizeStartX;
  const newWidth = Math.max(40, resizeStartWidth + dx);
  resizing.clipEl.style.width = newWidth + 'px';
}

function onClipResizeEnd(ev){
  if (!resizing) return;
  const {clipEl, layer, idx} = resizing;
  clipEl.classList.remove('resizing');
  const newWidth = parseFloat(clipEl.style.width || '0');
  const newDur = Math.max(0.1, Math.round((newWidth / viewPxPerSec) / snapSeconds) * snapSeconds);
  const clip = layer.clips[idx];
  clip.duration = newDur;
  fixLayerOverlaps(layer);
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
  window.removeEventListener('mousemove', onClipResizeMove);
  window.removeEventListener('mouseup', onClipResizeEnd);
  window.removeEventListener('touchmove', onClipResizeMove);
  window.removeEventListener('touchend', onClipResizeEnd);
  resizing = null;
}

function fixLayerOverlaps(layer){
  if (!layer || !Array.isArray(layer.clips)) return;
  let cursor = 0;
  for (let i=0; i<layer.clips.length; i++){
    const c = layer.clips[i];
    const dur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    c.startTime = Math.max(cursor, c.startTime || 0);
    cursor = c.startTime + (dur || 0);
  }
}

function removeClipFromLayer(layerId, idx){
  const layer = layers.find(l=>l.id===layerId);
  if (!layer) return;
  layer.clips.splice(idx, 1);
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
}

function onDropToLayer(e, layerId){
  e.preventDefault();
  try{
    const payload = JSON.parse(e.dataTransfer.getData('text/plain'));
    const {id, type} = payload;
    const layer = layers.find(l=>l.id===layerId);
    if (!layer) return;
    const desiredSec = computeDropSecondsFromEvent(e);
    if (type === 'image'){
      const panel = panels.find(p=>p.id===id);
      if (!panel) return;
      const clip = { type: 'image', src: panel.src, id: panel.id, duration: 2, startTime: 0, effect: panel.effect || 'slide_lr' };
      insertClipIntoLayerAt(layer, clip, desiredSec);
    } else if (type === 'audio'){
      const audio = audios.find(a=>a.id===id);
      if (!audio) return;
      const playable = getPlayableSrc(audio.src || audio.meta);
      const clip = { type: 'audio', src: playable || '', id: audio.id, duration: null, startTime: 0, meta: audio.meta };
      insertClipIntoLayerAt(layer, clip, desiredSec);
      if (clip.src){
        extractAudioDuration(clip).then(d=>{
          clip.duration = d;
          timeline = flattenLayersToTimeline();
          renderTimeline();
          scheduleAutosave();
        });
      }
    }
    timeline = flattenLayersToTimeline();
    renderTimeline();
    scheduleAutosave();
  }catch(e){}
}

function computeDropSecondsFromEvent(e){
  const outer = document.getElementById('timelineOuter');
  if (!outer) return 0;
  const r = outer.getBoundingClientRect();
  const x = (e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || r.left) - r.left;
  const sec = x / viewPxPerSec;
  const snapped = Math.round(sec / snapSeconds) * snapSeconds;
  return Math.max(0, snapped);
}

function insertClipIntoLayerAt(layer, clip, desiredSec){
  let index = layer.clips.length;
  for (let i=0; i<layer.clips.length; i++){
    const c = layer.clips[i];
    const cStart = c.startTime || 0;
    const cDur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    const cEnd = cStart + (cDur || 0);
    if (desiredSec < cStart){
      index = i;
      break;
    }
    if (desiredSec >= cStart && desiredSec <= cEnd){
      const mid = cStart + (cDur || 0)/2;
      index = (desiredSec < mid) ? i : i+1;
      break;
    }
  }
  layer.clips.splice(index, 0, clip);
  fixLayerOverlaps(layer);
  return index;
}

function selectLayerClip(layerId, idx){
  selectedLayerId = layerId;
  selectedIndex = idx;
  selectedClip = null; // clear legacy selection
  renderOverlays();
}

function renderLayerControls(){
  const container = document.getElementById('layerControls');
  if (!container) return;
  container.innerHTML = '';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn primary';
  addBtn.textContent = 'Add Layer';
  addBtn.addEventListener('click', addLayer);
  container.appendChild(addBtn);
}

function addLayer(){
  const newId = 'layer-' + Date.now();
  layers.push({ id: newId, name: 'Layer ' + layers.length, clips: [] });
  activeLayerId = newId;
  renderTimeline();
  renderLayerControls();
  scheduleAutosave();
}

function removeLayer(layerId){
  if (isBackgroundLayer({id:layerId})) return;
  layers = layers.filter(l => l.id !== layerId);
  if (activeLayerId === layerId){
    activeLayerId = (layers.find(l=>!isBackgroundLayer(l)) || layers[0] || {}).id;
  }
  renderTimeline();
  renderLayerControls();
  scheduleAutosave();
}

function isBackgroundLayer(layer){
  return layer && layer.id === BACKGROUND_LAYER_ID;
}

function ensureBackgroundLayer(createClip = true){
  let bgLayer = layers.find(l => l.id === BACKGROUND_LAYER_ID);
  if (!bgLayer){
    bgLayer = { id: BACKGROUND_LAYER_ID, name: 'Background', clips: [] };
    layers.unshift(bgLayer);
  }
  if (createClip && bgLayer.clips.length === 0){
    const totalDur = computeTotalDuration();
    bgLayer.clips.push({
      type: 'image',
      src: DEFAULT_BG_SRC,
      duration: Math.max(10, totalDur),
      startTime: 0,
      _isBackground: true,
      transform: { x: 960, y: 540, w: 1920, h: 1080, rotation: 0 }
    });
  }
  return bgLayer;
}

function recomputeLayerTimings(layer){
  if (!layer || !layer.clips) return;
  let cursor = 0;
  layer.clips.forEach(c => {
    c.startTime = cursor;
    const dur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    cursor += (dur || 0);
  });
}

function flattenLayersToTimeline(){
  const all = [];
  layers.forEach((l, li) => {
    (l.clips || []).forEach((c, ci) => {
      const cc = Object.assign({ _layerId: l.id, _layerIndex: li, _clipIndex: ci }, c);
      all.push(cc);
    });
  });
  all.sort((a,b) => (a._layerIndex || 0) - (b._layerIndex || 0) || (a.startTime || 0) - (b.startTime || 0));
  return all;
}

function computeTotalDuration(){
  let total = 0;
  layers.forEach(l => {
    (l.clips || []).forEach(c => {
      const dur = (c.duration != null) ? Number(c.duration) : (c.type === 'image' ? 2 : 0);
      const end = (c.startTime || 0) + dur;
      if (end > total) {
        DBG(`[computeTotalDuration] New max from ${l.name || l.id}: clip type=${c.type}, start=${(c.startTime||0).toFixed(2)}s, dur=${dur.toFixed(2)}s, end=${end.toFixed(2)}s`);
      }
      total = Math.max(total, end);
    });
  });
  DBG(`[computeTotalDuration] Final total: ${total.toFixed(2)}s`);
  return total;
}

function updateTotalDuration(){
  const el = document.getElementById('totalTimeReadout');
  if (el){
    el.textContent = '/ ' + formatTime(getCanvasTotalDuration());
  }
}

function formatTime(sec){
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s/60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,'0')}`;
}

function getPlayableSrc(raw){
  try{
    if (!raw) return '';
    if (typeof raw === 'string') return raw;
    if (raw && raw.url) return raw.url;
    return '';
  }catch(e){ return ''; }
}

function normalizeSrc(src){
  if (typeof src !== 'string') return '';
  if (src.startsWith('blob:')) return src;
  try {
    const url = new URL(src, window.location.origin);
    return url.pathname + url.search;
  } catch (e) {
    return src;
  }
}

function extractAudioDuration(clip){
  return new Promise((resolve) => {
    try{
      const src = getPlayableSrc(clip.src);
      const el = preloadedAudioEls[src] || new Audio(src);
      if (el && isFinite(el.duration) && el.duration > 0){
        resolve(Number(el.duration));
        return;
      }
      el.addEventListener('loadedmetadata', () => resolve(Number(el.duration) || 0), {once:true});
      el.addEventListener('error', () => resolve(0), {once:true});
      try{ el.load(); }catch(e){}
    }catch(e){ resolve(0); }
  });
}

function scheduleAutosave(){
  try{
    if (isExporting) return;
    autosavePending = true;
    const autosaveEl = document.getElementById('autosaveStatus');
    if (autosaveEl) autosaveEl.textContent = '...';
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => saveProject(false), 1200);
  }catch(e){}
}

function sanitizeAudioMeta(meta) {
    if (!meta) return {};
    const out = {};
    for (const key in meta) {
        if (key !== 'audioBlob') {
            out[key] = meta[key];
        }
    }
    return out;
}

async function saveProject(force = false) {
  if (isExporting) {
    DBG('[saveProject] Skipping save - export in progress');
    return;
  }
  if (!autosavePending && !force) {
    return;
  }

  const autosaveEl = document.getElementById('autosaveStatus');
  if (autosaveEl) autosaveEl.textContent = 'Saving...';

  try {
    // Try to get project ID from multiple sources (same as refreshProjectData)
    let projectId = null;
    
    // Method 1: From URL query parameters (?project_id=...)
    const urlParams = new URLSearchParams(window.location.search);
    projectId = urlParams.get('project_id');
    
    // Method 2: From URL path (/editor/video-editor/{project_id})
    if (!projectId) {
      const pathMatch = window.location.pathname.match(/\/video-editor\/([^\/]+)/);
      if (pathMatch) {
        projectId = pathMatch[1];
        DBG('[saveProject] Extracted project ID from path:', projectId);
      }
    }
    
    // Method 3: From global window.projectData
    if (!projectId && window.projectData?.id) {
      projectId = window.projectData.id;
      DBG('[saveProject] Using project ID from global projectData:', projectId);
    }

    if (!projectId) {
      throw new Error('Project ID is missing. Cannot save.');
    }

    const sanitizedLayers = (layers || []).map(l => ({
      id: l.id,
      name: l.name,
      clips: (l.clips || []).map(c => {
        const out = Object.assign({}, c);
        if (out.type === 'audio') {
          let originalSrc = '';
          if (out.meta && out.meta.originalSrc) {
            originalSrc = out.meta.originalSrc;
          } else if (out.src && !out.src.startsWith('blob:')) {
            originalSrc = out.src;
          }
          out.src = originalSrc || '';
          out.meta = sanitizeAudioMeta(out.meta);
        }
        delete out._img;
        delete out._imgLoading;
        delete out._imgLoaded;
        delete out._imgError;
        delete out._layerId;
        delete out._clipIndex;
        delete out._isBackground;
        return out;
      })
    }));

    const payload = { layers: sanitizedLayers };

    const resp = await fetch(`/editor/api/project/${projectId}/layers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Save failed: ${resp.status} - ${errorText}`);
    }

    await resp.json();
    autosavePending = false;
    if (autosaveEl) autosaveEl.textContent = 'Saved';
    setTimeout(() => { if (autosaveEl) autosaveEl.textContent = ''; }, 2000);
  } catch (e) {
    console.error('Autosave failed', e);
    if (autosaveEl) autosaveEl.textContent = `Save error: ${e.message}`;
  }
}

// ==================== Generate Panel Timeline ====================
async function generatePanelTimeline() {
  DBG('generatePanelTimeline called');
  
  // Refresh project data from server to get latest effects and transitions
  const latestProject = await refreshProjectData();
  if (!latestProject) {
    console.error('Failed to refresh project data');
    return;
  }
  
  const panelsData = latestProject.workflow?.panels?.data || [];
  
  // Update effects and transitions in panels array from latest project data
  panels.forEach(panel => {
    const pageData = panelsData.find(p => p.page_number === panel.pageNumber);
    if (pageData && pageData.panels && pageData.panels[panel.panelIndex]) {
      const projectPanel = pageData.panels[panel.panelIndex];
      panel.effect = projectPanel.effect || 'none';
      panel.transition = projectPanel.transition || (panel.panelIndex === 0 ? 'none' : 'slide_book');
      DBG(`Updated panel ${panel.pageNumber}-${panel.panelIndex}: effect=${panel.effect}, transition=${panel.transition}`);
    }
  });
  
  if (panels.length === 0) {
    console.error('No panels available. Please load a project with panels first.');
    return;
  }

  const panelsWithAudio = audios.filter(audio => audio.id && audio.duration > 0);
  if (panelsWithAudio.length === 0) {
    console.error('No panels with audio found. Please synthesize panel audio first.');
    return;
  }

  DBG('Generating timeline for', panelsWithAudio.length, 'panels with audio');

  // Clear existing layers and create new ones
  layers = [
    { id: 'video-layer', name: 'Video (Panels)', clips: [] },
    { id: 'audio-layer', name: 'Audio (Speech)', clips: [] }
  ];
  
  // Ensure background layer exists with default background
  ensureBackgroundLayer(true);
  
  activeLayerId = 'video-layer';
  
  let currentTime = 0;
  const transitionDuration = 0.2; // 200ms transition between panels
  
  // Debug: Log panel data before sorting
  DBG('Panel data before sorting:');
  panelsWithAudio.forEach((audio, i) => {
    DBG(`  ${i}: pageNumber=${audio.pageNumber}, panelIndex=${audio.panelIndex}, id=${audio.id}`);
  });
  
  // Sort panels by page and panel index
  const sortedPanels = panelsWithAudio.sort((a, b) => {
    // Ensure we're comparing numbers, not strings
    const pageA = parseInt(a.pageNumber) || 0;
    const pageB = parseInt(b.pageNumber) || 0;
    const panelA = parseInt(a.panelIndex) || 0;
    const panelB = parseInt(b.panelIndex) || 0;
    
    if (pageA !== pageB) {
      return pageA - pageB;
    }
    return panelA - panelB;
  });
  
  // Debug: Log panel data after sorting
  DBG('Panel data after sorting:');
  sortedPanels.forEach((audio, i) => {
    DBG(`  ${i}: pageNumber=${audio.pageNumber}, panelIndex=${audio.panelIndex}, id=${audio.id}`);
  });
  
  sortedPanels.forEach((audioData, index) => {
    // Find the corresponding panel image
    const panelData = panels.find(p => 
      p.pageNumber === audioData.pageNumber && 
      p.panelIndex === audioData.panelIndex
    );
    
    if (!panelData) {
      DBG('Warning: No panel image found for audio', audioData.id);
      return;
    }
    
    const duration = audioData.duration || 2.0;
    
    // Add panel image to video layer
    const videoClip = {
      id: `video-${panelData.id}-${Date.now()}`,
      startTime: currentTime,
      duration: duration,
      src: panelData.src,
      type: 'image',
      layer: 'video-layer',
      filename: panelData.filename,
      displayName: panelData.displayName,
      effect: panelData.effect || 'none',
      transition: panelData.transition || (index === 0 ? 'none' : 'slide_book')
    };
    
    // Add audio to audio layer
    const audioClip = {
      id: `audio-${audioData.id}-${Date.now()}`,
      startTime: currentTime,
      duration: duration,
      src: audioData.src,
      type: 'audio',
      layer: 'audio-layer',
      filename: audioData.filename,
      displayName: audioData.displayName,
      text: audioData.text || '',
      meta: {
        originalUrl: audioData.src,
        filename: audioData.filename
      }
    };
    
    // Find video and audio layers (background layer is at index 0)
    const videoLayer = layers.find(l => l.id === 'video-layer');
    const audioLayer = layers.find(l => l.id === 'audio-layer');
    
    if (videoLayer) videoLayer.clips.push(videoClip);
    if (audioLayer) audioLayer.clips.push(audioClip);
    
    currentTime += duration + transitionDuration;
    
    DBG(`Added panel ${panelData.displayName} at ${videoClip.startTime}s for ${duration}s`);
  });
  
  // Update background layer duration to cover entire timeline
  const backgroundLayer = layers.find(l => l.id === BACKGROUND_LAYER_ID);
  if (backgroundLayer && backgroundLayer.clips.length > 0) {
    backgroundLayer.clips[0].duration = Math.max(currentTime, backgroundLayer.clips[0].duration || 10);
    DBG(`Updated background duration to ${backgroundLayer.clips[0].duration}s`);
  }
  
  // Fix any overlaps in all layers after batch adding
  layers.forEach(layer => {
    if (layer.clips && layer.clips.length > 0) {
      fixLayerOverlaps(layer);
    }
  });
  
  // Refresh timeline display
  renderTimeline();
  renderLayerControls();
  
  // Sync canvas to actual audio durations and chain sequentially to match server render
  try {
    await syncTimelineToActualAudio();
  } catch (e) {
    DBG('syncTimelineToActualAudio failed', e);
  }

  // Force redraw of timeline to ensure proper positioning
  setTimeout(() => {
    renderTimeline();

    // Force layout reflow to ensure positioning is applied
    const track = document.getElementById('timelineTrack');
    if (track) {
      track.offsetHeight; // Force layout reflow

      // Double-check clip positions and fix any that are overlapped
      const clips = track.querySelectorAll('.clip');
      clips.forEach((clipEl, index) => {
        const layerId = clipEl.dataset.layerId;
        const clipIndex = parseInt(clipEl.dataset.idx);
        const layer = layers.find(l => l.id === layerId);

        if (layer && layer.clips[clipIndex]) {
          const clip = layer.clips[clipIndex];
          const expectedLeft = (clip.startTime || 0) * viewPxPerSec;
          const currentLeft = parseFloat(clipEl.style.left) || 0;

          // If position is significantly off, force correct it
          if (Math.abs(expectedLeft - currentLeft) > 5) {
            clipEl.style.left = expectedLeft + 'px';
            DBG(`Fixed clip position: ${clip.id || 'clip'} from ${currentLeft}px to ${expectedLeft}px`);
          }
        }
      });
    }
  }, 100);
  
  DBG('Panel timeline generation complete!');
}

async function syncTimelineToActualAudio(){
  try {
    const audioLayer = layers.find(l => l.id === 'audio-layer');
    const videoLayer = layers.find(l => l.id === 'video-layer');
    if (!audioLayer || !videoLayer) return;

    DBG('Syncing timeline to actual audio durations...');

    // Measure real durations for all audio clips
    const auds = audioLayer.clips.slice();
    const realDurs = await Promise.all(auds.map(async (c) => {
      try {
        const d = await extractAudioDuration(c);
        return (d && isFinite(d) && d > 0) ? d : (c.duration || 0);
      } catch(_e){ return c.duration || 0; }
    }));

    DBG('Real audio durations:', realDurs);

    // Apply sequential chaining with real durations; mirror durations to corresponding image clips
    let t = 0;
    for (let i = 0; i < auds.length; i++){
      const d = Number(realDurs[i] || 0);
      auds[i].startTime = t; 
      auds[i].duration = d;
      if (videoLayer.clips[i]){ 
        videoLayer.clips[i].startTime = t; 
        videoLayer.clips[i].duration = d; 
      }
      DBG(`Clip ${i}: startTime=${t.toFixed(2)}s, duration=${d.toFixed(2)}s`);
      t += d; // no gap to match render
    }

    // Ensure background covers the full chained duration
    const bg = layers.find(l => isBackgroundLayer(l));
    if (bg && bg.clips && bg.clips[0]){
      bg.clips[0].startTime = 0;
      bg.clips[0].duration = Math.max(bg.clips[0].duration || 0, t || 10);
    }

    // Recompute flattened timeline and refresh UI
    timeline = flattenLayersToTimeline();
    renderTimeline();
    updateTotalDuration();
    DBG('Synchronized to audio durations. New total (approx):', t.toFixed(2), 'seconds');
  } catch (e) {
    DBG('syncTimelineToActualAudio error', e);
  }
}

// ==================== Headless Browser Rendering ====================
async function renderVideo() {
  // Get the render button
  const renderBtn = document.getElementById('renderBtn');
  
  // Try multiple ways to get the project ID
  let projectId = null;
  
  // Method 1: From URL query parameters (?project_id=...)
  const urlParams = new URLSearchParams(window.location.search);
  projectId = urlParams.get('project_id');
  
  // Method 2: From URL path (/editor/video-editor/{project_id})
  if (!projectId) {
    const pathMatch = window.location.pathname.match(/\/video-editor\/([^\/]+)/);
    if (pathMatch) {
      projectId = pathMatch[1];
    }
  }
  
  // Method 3: From window.projectData
  if (!projectId && window.projectData && window.projectData.id) {
    projectId = window.projectData.id;
  }
  
  // Final check
  if (!projectId) {
    const manualId = prompt('Could not auto-detect project ID. Please enter it manually:');
    if (!manualId) {
      alert('Project ID is required for rendering');
      return;
    }
    projectId = manualId.trim();
  }
  
  console.log('[Render] Using project ID:', projectId);
  
  // Debug info
  console.log('[Render] Current URL:', window.location.href);
  console.log('[Render] Project data:', window.projectData);
  
  // Check if headless rendering is available
  try {
    const checkResp = await fetch('/editor/api/video/headless/available');
    const checkData = await checkResp.json();
    
    if (!checkData.available) {
      const install = confirm(
        'Rendering requires Playwright.\n\n' +
        'Install with:\n' +
        'pip install playwright\n' +
        'playwright install chromium\n\n' +
        'Would you like to see installation instructions?'
      );
      
      if (install) {
        window.open('https://playwright.dev/python/docs/intro', '_blank');
      }
      return;
    }
  } catch (err) {
    console.error('Failed to check rendering availability:', err);
    alert('Could not check if rendering is available');
    return;
  }
  
  const confirm_msg = confirm(
    '🎬 Render Video\n\n' +
    'This will:\n' +
    '✓ Capture video and audio from your timeline\n' +
    '✓ Create a high-quality WebM file\n' +
    '✓ Take approximately real-time (e.g., 2min video = 2min render)\n\n' +
    'Continue?'
  );
  
  if (!confirm_msg) return;
  
  console.log('[Render] Starting render for project:', projectId);
  
  // Disable the render button
  if (renderBtn) {
    renderBtn.disabled = true;
    renderBtn.style.opacity = '0.5';
    renderBtn.style.cursor = 'not-allowed';
    renderBtn.textContent = '🎬 Rendering...';
  }
  
  try {
    const response = await fetch('/editor/api/video/render/headless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Render request failed');
    }
    
    const data = await response.json();
    const jobId = data.job_id;
    
    console.log('[Render] Render job started:', jobId);
    
    // Set the job ID for the progress bar - this will trigger the SSE connection
    window.__renderJobId = jobId;
    
  } catch (err) {
    console.error('[Headless] Render failed:', err);
    alert(`Headless render failed: ${err.message}`);
    
    // Re-enable render button on error
    if (renderBtn) {
      renderBtn.disabled = false;
      renderBtn.style.opacity = '1';
      renderBtn.style.cursor = 'pointer';
      renderBtn.textContent = '🎬 Render';
    }
  }
}

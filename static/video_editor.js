// Basic video editor client logic
// Layered timeline model: layers is array of {id, name, clips: []}
let timeline = []; // legacy flat timeline kept for compatibility but UI shows layers
let layers = [ { id: 'layer-1', name: 'Layer 1', clips: [] } ];
// Background config
const DEFAULT_BG_SRC = '/static/blur_glitch_background.png';
const BACKGROUND_LAYER_ID = 'background';
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
let audioFetchControllers = {}; // keyed by src -> AbortController
let audioPreloadInProgress = false; // Flag to prevent duplicate calls
const DBG = (...args)=>{ try{ console.log('[editor]', ...args); }catch(e){} };
const preloadedAudioEls = {}; // src -> HTMLAudioElement (preloaded)
// Simplified preview audio state (HTMLAudio-only)
let activeAudio = null; // current HTMLAudio element in use
let activeAudioTimeout = null; // timeout id for scheduling next clip
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

document.addEventListener('DOMContentLoaded', () => {
  // Prevent re-initialization if already loaded
  if (window.videoEditorLoaded) {
    DBG('Video editor already loaded, skipping re-initialization');
    return;
  }
  
  DBG('DOMContentLoaded fired - starting video editor initialization');
  const data = window.projectData || {};
  const project = data;
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
  // load panels from project.pages
  const panelsList = document.getElementById('panelsList');
  const audioList = document.getElementById('audioList');
  const timelineTrack = document.getElementById('timelineTrack');

  (project.pages || []).forEach((p, idx) => {
    const url = `/manga_projects/${project.id}/${p.filename}`;
    const id = `panel-${idx}`;
    panels.push({id, src: url, filename: p.filename});
    const el = document.createElement('div');
    el.className = 'asset-item';
    el.draggable = true;
    el.dataset.id = id;
    el.dataset.type = 'image';
    // Lazy-load thumbnails to avoid keeping the tab in a perpetual "loading" state
    el.innerHTML = `<img src="${url}" alt="${p.filename}" loading="lazy" decoding="async"/><div class="meta">${p.filename}</div>`;
    el.addEventListener('dragstart', onDragStartAsset);
    panelsList.appendChild(el);
  });

  // If editor state was previously saved on the server, restore layers
  try {
    const saved = project.workflow && project.workflow.video_editing && project.workflow.video_editing.data && project.workflow.video_editing.data.layers;
    if (saved && Array.isArray(saved) && saved.length > 0) {
      // Deep-clone and normalize saved layers
      layers = saved.map((s, li) => ({
        id: s.id || ('layer-' + (Date.now() + li)),
        name: s.name || ('Layer ' + (li + 1)),
        clips: (s.clips || []).map((c) => Object.assign({}, c))
      }));
      // ensure numeric fields and recompute timings
      layers.forEach(l => { l.clips.forEach(c => { if (c.duration != null) c.duration = Number(c.duration); if (c.startTime != null) c.startTime = Number(c.startTime); }); recomputeLayerTimings(l); });
      activeLayerId = layers[0].id;
      console.info('[editor] restored saved layers from project.workflow.video_editing');
    }
  } catch (e) { console.warn('[editor] failed to restore saved layers', e); }

  // If a background layer exists in saved data, ensure it's at index 0
  if (layers.some(l=> l.id === BACKGROUND_LAYER_ID)){
    ensureBackgroundLayer(false);
  }

  // existing audio from project.workflow.tts.data may contain audio blobs or urls
  let maybeAudio = project.workflow?.tts?.data;
  // Normalize into an array if possible
  if (!maybeAudio) {
    maybeAudio = [];
  } else if (!Array.isArray(maybeAudio)) {
    // If it's an object with keys, convert values to array; if a string/url, wrap it
    if (typeof maybeAudio === 'string') {
      maybeAudio = [maybeAudio];
    } else if (typeof maybeAudio === 'object') {
      // If object has numeric keys or is a map, convert to values
      try {
        maybeAudio = Object.values(maybeAudio);
      } catch (e) {
        maybeAudio = [maybeAudio];
      }
    } else {
      maybeAudio = [];
    }
  }

  // Flatten to array safely
  (maybeAudio || []).forEach((a, i) => {
    // Expect object with page_number and audio url/blob
    const id = `audio-${i}`;
    // preserve original meta and try to derive a playable src immediately
    const meta = a;
    let srcCandidate = null;
    const guessMime = (metaLike, fallback='audio/wav') => {
      try{
        if (!metaLike) return fallback;
        const name = (typeof metaLike === 'string') ? metaLike : (metaLike.filename || metaLike.name || metaLike.file || metaLike.url || metaLike.src || '');
        const mime = (typeof metaLike === 'object') ? (metaLike.mime || metaLike.mimetype || (metaLike.type && String(metaLike.type))) : '';
        const lowerName = String(name||'').toLowerCase();
        const lowerMime = String(mime||'').toLowerCase();
        if (lowerMime.includes('wav') || lowerName.endsWith('.wav')) return 'audio/wav';
        if (lowerMime.includes('mpeg') || lowerMime.includes('mp3') || lowerName.endsWith('.mp3')) return 'audio/mpeg';
        if (lowerMime.includes('ogg') || lowerName.endsWith('.ogg')) return 'audio/ogg';
        return fallback;
      }catch(e){ return fallback; }
    };
    // prefer explicit fields
    if (meta && typeof meta === 'object'){
      srcCandidate = meta.url || meta.audio || meta.src || meta.filename || meta.file || null;
      // If meta contains raw base64 or data, try to build a data URI
      if (!srcCandidate && meta.base64 && typeof meta.base64 === 'string'){
        const mime = guessMime(meta, 'audio/wav');
        srcCandidate = `data:${mime};base64,` + meta.base64.replace(/\s+/g,'');
      }
      // audioBlob may be a serialized object (from server) containing base64/data/url/filename
      if (!srcCandidate && meta.audioBlob){
        try{
          const ab = meta.audioBlob;
          // If it's already a Blob/File (unlikely from JSON), create object URL
          if (ab instanceof Blob || ab instanceof File){ srcCandidate = URL.createObjectURL(ab); }
          else if (typeof ab === 'string'){
            // sometimes stored as base64 string
            const t = ab.trim();
            if (t.startsWith('data:audio')) srcCandidate = t;
            else if (t.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(t)) {
              const mime = guessMime(meta, 'audio/wav');
              srcCandidate = `data:${mime};base64,` + t.replace(/\s+/g,'');
            }
          } else if (typeof ab === 'object'){
            // try common fields
            if (ab.url && typeof ab.url === 'string') srcCandidate = ab.url;
            else if (ab.filename && typeof ab.filename === 'string') srcCandidate = '/uploads/' + ab.filename;
            else if (ab.base64 && typeof ab.base64 === 'string') {
              const mime = guessMime(ab, 'audio/wav');
              srcCandidate = `data:${mime};base64,` + ab.base64.replace(/\s+/g,'');
            }
            else if (ab.data && typeof ab.data === 'string'){
              const t = ab.data.trim(); if (t.startsWith('data:audio')) srcCandidate = t; else if (t.length>100 && /^[A-Za-z0-9+/=\s]+$/.test(t)) srcCandidate = 'data:audio/mpeg;base64,' + t.replace(/\s+/g,'');
            }
          }
        }catch(e){ /* ignore */ }
      }
    } else if (typeof a === 'string') {
      srcCandidate = a;
    }
  const playable = getPlayableSrc(srcCandidate || meta);
  // If no playable src was found, inspect meta.audioBlob for raw data and try to construct a Blob URL
  let finalPlayable = playable;
  if (!finalPlayable && meta && meta.audioBlob){
    try{
      const ab = meta.audioBlob;
      const keys = (ab && typeof ab === 'object') ? Object.keys(ab) : [];
      // If audioBlob contains base64
      if (!finalPlayable && ab && typeof ab.base64 === 'string' && ab.base64.length>100){
        const mime = guessMime(ab, 'audio/wav');
        finalPlayable = `data:${mime};base64,` + ab.base64.replace(/\s+/g,'');
      }
      // If audioBlob contains raw numeric array in 'data' or 'bytes'
      if (!finalPlayable && ab && Array.isArray(ab.data) && ab.data.length>0){
        const arr = new Uint8Array(ab.data);
        const mime = guessMime(ab, 'audio/wav');
        const blob = new Blob([arr], { type: mime });
        finalPlayable = URL.createObjectURL(blob);
      }
      if (!finalPlayable && ab && Array.isArray(ab.bytes) && ab.bytes.length>0){
        const arr = new Uint8Array(ab.bytes);
        const mime = guessMime(ab, 'audio/wav');
        const blob = new Blob([arr], { type: mime });
        finalPlayable = URL.createObjectURL(blob);
      }
      // If audioBlob has .data.buffer-like structure
      if (!finalPlayable && ab && ab.data && ab.data.data && Array.isArray(ab.data.data)){
        const arr = new Uint8Array(ab.data.data);
        const mime = guessMime(ab, 'audio/wav');
        const blob = new Blob([arr], { type: mime });
        finalPlayable = URL.createObjectURL(blob);
      }
      // If no enumerable keys were present (Blob-like object from deserialization), attempt blob/arraybuffer/typedarray handling
      if (!finalPlayable){
        try{
          // ab may be a real Blob/File (size property) or have arrayBuffer method
          if (ab && (typeof ab.size === 'number' || typeof ab.arrayBuffer === 'function' || typeof ab.slice === 'function')){
            try{
              finalPlayable = URL.createObjectURL(ab);
            }catch(err){ console.warn('[audio-load] failed to create objectURL directly', err); }
          }
          // If it's an ArrayBuffer or a typed array
          if (!finalPlayable && ab && (ab instanceof ArrayBuffer || typeof ab.byteLength === 'number')){
            const arr = ab instanceof ArrayBuffer ? new Uint8Array(ab) : (ab.buffer ? new Uint8Array(ab.buffer) : new Uint8Array(ab));
            const mime = guessMime(ab, 'audio/wav');
            const blob = new Blob([arr], { type: mime });
            finalPlayable = URL.createObjectURL(blob);
          }
        }catch(e){ console.warn('[audio-load] blob-like fallback error', e); }
      }
    }catch(e){ console.warn('[audio-load] error inspecting audioBlob', e); }
  }
    // store playable (or empty) but keep original meta for later upload/inspection
  const fname = (meta && (meta.filename || meta.file || meta.name)) || `audio-${i}.wav`;
  audios.push({id, src: finalPlayable || '', filename: fname, meta});
    const el = document.createElement('div');
    el.className = 'asset-item';
    el.draggable = true;
    el.dataset.id = id;
    el.dataset.type = 'audio';
    el.innerHTML = `<div style="width:48px; height:48px; background:#111; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#fff;">♪</div><div class="meta">${id}</div>`;
    el.addEventListener('dragstart', onDragStartAsset);
    if (audioList) audioList.appendChild(el);
  });

  const audioFileInputEl = document.getElementById('audioFileInput');
  if (audioFileInputEl) audioFileInputEl.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // Upload to server uploads/ and add to audio list
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
  // Load persisted zoom (pxPerSec) if available
  try{
    const saved = window.localStorage.getItem('video_editor_pxPerSec');
    if (saved) {
      const v = Number(saved);
      if (!Number.isNaN(v) && v > 0) pxPerSec = v;
    }
  }catch(e){ /* ignore localStorage errors */ }

  // initialize viewPxPerSec
  viewPxPerSec = pxPerSec;

  // Zoom controls (persist zoom to localStorage)
  const zIn = document.getElementById('zoomIn'); if (zIn) zIn.addEventListener('click', ()=>{ pxPerSec = Math.min(2000, pxPerSec * 1.25); persistZoom(); recalcViewScale(); renderTimeline(); renderRuler(); scheduleAutosave(); });
  const zOut = document.getElementById('zoomOut'); if (zOut) zOut.addEventListener('click', ()=>{ pxPerSec = Math.max(10, pxPerSec / 1.25); persistZoom(); recalcViewScale(); renderTimeline(); renderRuler(); scheduleAutosave(); });
  const snapSel = document.getElementById('snapSelect'); if (snapSel) { snapSel.addEventListener('change', (e)=>{ snapSeconds = parseFloat(e.target.value) || 0.1; }); }
  // Reflow toggle is read at action time (no handler needed here)
  const saveNowBtn = document.getElementById('saveNow'); if (saveNowBtn) saveNowBtn.addEventListener('click', ()=> saveProject(true));
  // autosave status element (optional)
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = '';
  // Top export/preview buttons (if present)
  const exportTop = document.getElementById('exportBtnTop');
  if (exportTop) exportTop.addEventListener('click', onExport);
  const exportHeader = document.getElementById('exportBtnHeader');
  if (exportHeader) exportHeader.addEventListener('click', onExport);
  const previewTop = document.getElementById('previewTimelineBtnTop');
  if (previewTop) previewTop.addEventListener('click', onPreviewTimeline);

  // Initialize canvas-based preview
  DBG('Initializing canvas preview');
  initCanvasPreview();

  DBG('Rendering timeline and components');
  renderTimeline();
  renderLayerControls();
  renderRuler();
  
  // Preload after initial render so timeline clips are present
  DBG('Starting image preloading');
  try{ preloadImageAssets(); }catch(e){ DBG('preloadImageAssets error', e); }
  DBG('Starting audio preloading');
  try{ preloadAudioAssets(); }catch(e){ DBG('preloadAudioAssets error', e); }
  DBG('Audio preloading initiated');

  // Mark initialization complete
  DBG('Video editor initialization complete');

  // Disable proactive audio duration prefetch on load to avoid long-running network/audio decode operations.
  // Durations will be computed lazily when audio is added or explicitly requested.

  // Recompute timeline layout on window resize so min width follows the visible viewport width
  window.resizeTimer = null;
  window.addEventListener('resize', () => {
    if (window.resizeTimer) clearTimeout(window.resizeTimer);
    window.resizeTimer = setTimeout(()=>{ try{ renderTimeline(); renderRuler(); }catch(e){} }, 120);
  });

  // Delegated click handler for remove buttons inside timeline (works across re-renders)
  const timelineTrackEl = document.getElementById('timelineTrack');
  if (timelineTrackEl) {
    timelineTrackEl.addEventListener('click', (ev) => {
      try {
        // allow clicks on nested elements inside the remove control
        const removeBtn = ev.target.closest ? ev.target.closest('.remove') : (ev.target.classList && ev.target.classList.contains('remove') ? ev.target : null);
        if (!removeBtn) return;
        ev.stopPropagation(); ev.preventDefault();
        const clipEl = removeBtn.closest('.clip');
        if (!clipEl) return;
        const layerId = clipEl.dataset.layerId;
        const idx = Number(clipEl.dataset.idx);
        console.log('[timeline] remove clicked', { layerId, idx });
        if (layerId && !Number.isNaN(idx)){
          removeClipFromLayer(layerId, idx);
        }
      } catch (e) {
        console.warn('Remove handler error', e);
      }
    });
  }

  // Fallback: global listener to capture remove clicks in case element-specific handlers are not firing
  document.addEventListener('click', (ev) => {
    try {
      const removeBtn = ev.target.closest ? ev.target.closest('.remove') : null;
      if (!removeBtn) return;
      ev.stopPropagation(); ev.preventDefault();
      const clipEl = removeBtn.closest('.clip');
      if (!clipEl) return;
      const layerId = clipEl.dataset.layerId;
      const idx = Number(clipEl.dataset.idx);
      // Use console.error so it is obvious in devtools (some consoles hide info/debug)
      console.error('[timeline][fallback] remove clicked', { layerId, idx, target: ev.target.tagName });
      if (layerId && !Number.isNaN(idx)){
        removeClipFromLayer(layerId, idx);
      }
    } catch (e) {
      console.error('Global remove handler error', e);
    }
  }, true);
});

// ------------------ Canvas Preview Engine (16:9) ------------------
function initCanvasPreview(){
  canvas = document.getElementById('editorCanvas');
  overlayEl = document.getElementById('previewOverlay');
  const playBtn = document.getElementById('togglePlay');
  const cropBtn = document.getElementById('toggleCrop');
  const seekSlider = document.getElementById('seekSlider');
  const toolbar = overlayEl ? overlayEl.querySelector('.preview-toolbar') : null;
  if (!canvas) return;
  canvas.width = 1920; canvas.height = 1080; // 16:9 backing resolution
  ctx = canvas.getContext('2d');
  if (playBtn) playBtn.addEventListener('click', togglePlayback);
  if (cropBtn) cropBtn.addEventListener('click', ()=>{ if (isPlaying) return; cropMode = !cropMode; cropBtn.textContent = 'Crop: ' + (cropMode? 'On' : 'Off'); renderOverlays(); });
  if (seekSlider){
    let scrubbing = false;
    const applySeek = () => {
      const total = computeTotalDuration() || 0;
      const frac = Math.max(0, Math.min(1, Number(seekSlider.value)));
      const t = frac * total;
      playhead = t; drawFrame(playhead);
      if (isPlaying){
        // restart audio chain from new position
        scheduleAudioForPlayback();
      }
    };
    // Ensure toolbar and slider eat pointer events so canvas isn't selected/moved
    const stop = (e)=>{ e.stopPropagation(); };
    seekSlider.addEventListener('pointerdown', (e)=>{ stop(e); scrubbing = true; stopRaf(); });
    seekSlider.addEventListener('mousedown', stop);
    seekSlider.addEventListener('touchstart', (e)=>{ stop(e); scrubbing = true; stopRaf(); }, {passive:false});
    seekSlider.addEventListener('input', ()=>{ applySeek(); });
    seekSlider.addEventListener('change', (e)=>{ stop(e); scrubbing = false; applySeek(); });
    seekSlider.addEventListener('pointerup', (e)=>{ stop(e); scrubbing = false; drawFrame(playhead); });
    seekSlider.addEventListener('click', stop);
    // Expose scrubbing flag for drawFrame to respect
    seekSlider._scrubbing = () => scrubbing;
  }
  if (toolbar){
    const eat = (e)=>{ e.stopPropagation(); };
    ['pointerdown','pointerup','click','mousedown','mouseup','touchstart','touchend'].forEach(evt=> toolbar.addEventListener(evt, eat, {passive:false}));
    try{ toolbar.style.pointerEvents = 'auto'; }catch(e){}
  }
  // Ensure overlay doesn't leak clicks to canvas except for explicit interactive elements
  try{ overlayEl.style.pointerEvents = 'auto'; }catch(e){}
  // Add a transparent shield region behind toolbar to make near-clicks safe
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
    // Insert shield as first child so toolbar remains above visually
    overlayEl && overlayEl.insertBefore(shield, overlayEl.firstChild || null);
  }catch(e){ DBG('shield setup failed', e); }
  // Pointer interactions (only honored when paused)
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  if (overlayEl) overlayEl.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointermove', onCanvasPointerMove);
  window.addEventListener('pointerup', onCanvasPointerUp);
  drawFrame(0);
}

function togglePlayback(){
  isPlaying = !isPlaying;
  const btn = document.getElementById('togglePlay'); if (btn) btn.textContent = isPlaying ? 'Pause' : 'Play';
  const cropBtn = document.getElementById('toggleCrop'); if (cropBtn) cropBtn.disabled = isPlaying;
  if (isPlaying){
    // If no audio is currently active at playhead, jump to next audio start to avoid waiting long delays
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
    // Ensure audio context is resumed (autoplay policies)
    ensureAudioContext().then(ctx=>{ try{ if (ctx && ctx.state === 'suspended') ctx.resume(); }catch(e){} });
    DBG('Play pressed at', playhead.toFixed(2));
    scheduleAudioForPlayback(); startRaf();
  } else { stopRaf(); clearAudioPlayback(); }
}

function startRaf(){
  lastTs = performance.now();
  if (rafId) cancelAnimationFrame(rafId);
  const total = computeTotalDuration();
  const step = (ts) => {
    const dt = (ts - lastTs) / 1000; lastTs = ts;
    playhead = Math.min(total, playhead + dt);
    drawFrame(playhead);
    if (playhead >= total){ isPlaying = false; const btn = document.getElementById('togglePlay'); if (btn) btn.textContent = 'Play'; return; }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopRaf(){ if (rafId){ cancelAnimationFrame(rafId); rafId = null; } drawFrame(playhead); }

function drawFrame(timeSec){
  if (!ctx || !canvas) return;
  // background
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
  // draw background image if present
  const all = flattenLayersToTimeline();
  const bg = all.find(c=> c.type==='image' && c._isBackground);
  if (bg) { renderClipToCanvas(bg, timeSec); }
  // draw image clips in ascending layer order
  const imgs = all.filter(c=> c.type==='image' && !c._isBackground).sort((a,b)=> (a._layerIndex||0) - (b._layerIndex||0));
  for (const c of imgs){ renderClipToCanvas(c, timeSec); }
  // overlays (selection/crop) when paused
  if (!isPlaying) renderOverlays();
  const tr = document.getElementById('timeReadout'); if (tr) tr.textContent = formatTime(timeSec);
  const total = computeTotalDuration();
  const ttr = document.getElementById('totalTimeReadout'); if (ttr) ttr.textContent = '/ ' + formatTime(total);
  const seek = document.getElementById('seekSlider'); if (seek){
    const frac = total>0 ? (timeSec / total) : 0;
    const isScrubbing = typeof seek._scrubbing === 'function' ? seek._scrubbing() : false;
    if (!isScrubbing){ seek.value = String(Math.max(0, Math.min(1, frac))); }
  }
}

function renderClipToCanvas(clip, t){
  const st = clip.startTime || 0; const dur = (clip.duration!=null)? Number(clip.duration) : (clip.type==='image'?2:0);
  if (t < st || t > st + dur + 1e-4) return;
  
  // If image is not loaded yet, start loading but don't render
  if (!clip._img && !clip._imgLoading){ 
    clip._imgLoading = true;
    const im = new Image(); 
    im.crossOrigin='anonymous'; 
    im.onload = ()=>{ 
      clip._imgLoading = false;
      clip._imgLoaded = true; // Mark as successfully loaded
      DBG('Image loaded for clip:', clip.src || clip);
    }; 
    im.onerror = () => {
      clip._imgLoading = false;
      clip._imgError = true; // Mark as failed to load
      DBG('Image load error for:', clip.src);
    };
    im.src = normalizeSrc(clip.src || clip); 
    clip._img = im; 
    return; // Don't try to render while still loading
  }
  
  // Only render if image is fully loaded and ready
  const img = clip._img; 
  if (!img || !img.complete || !img.naturalWidth || clip._imgLoading) {
    return; // Image not ready yet, skip this frame
  }
  // defaults
  clip.transform = clip.transform || { x: canvas.width/2, y: canvas.height/2, w: canvas.width, h: canvas.height, rotation: 0 };
  clip.crop = clip.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const dx = Math.round(clip.transform.x - clip.transform.w/2);
  const dy = Math.round(clip.transform.y - clip.transform.h/2);
  const dw = Math.max(1, Math.round(clip.transform.w));
  const dh = Math.max(1, Math.round(clip.transform.h));
  const sx = Math.max(0, Math.min(clip.crop.x, img.naturalWidth-1));
  const sy = Math.max(0, Math.min(clip.crop.y, img.naturalHeight-1));
  const sw = Math.max(1, Math.min(clip.crop.w, img.naturalWidth - sx));
  const sh = Math.max(1, Math.min(clip.crop.h, img.naturalHeight - sy));
  try{
    ctx.save();
    if (clip.transform.rotation){
      ctx.translate(clip.transform.x, clip.transform.y);
      ctx.rotate((clip.transform.rotation || 0) * Math.PI/180);
      ctx.translate(-clip.transform.x, -clip.transform.y);
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  }catch(e){ /* ignore draw errors */ }
}

function renderOverlays(){
  if (!overlayEl) return;
  // remove previous overlays except toolbar
  Array.from(overlayEl.children).forEach(ch => { if (!ch.classList.contains('preview-toolbar')) overlayEl.removeChild(ch); });
  const sel = getSelectedClip();
  if (!sel){
    // Helpful hint when nothing is selected
    const hint = document.createElement('div');
    hint.className = 'hint-bubble';
    hint.innerHTML = '<strong>Tip</strong>: Select a clip on the timeline (or click on the canvas) to edit. When paused:<br/>• Drag white corners to resize<br/>• Drag the center dot to move<br/>• Toggle \'Crop\' to adjust the green crop box';
    overlayEl.appendChild(hint);
    return;
  }
  const r = getClipRectOnCanvas(sel); if (!r) return;
  // Convert canvas-space rect to CSS pixels based on current canvas display size
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
  // Prefer pointer event coords; fallback to touch/mouse
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

// Hit-test: return topmost visible clip at point (canvas coords) for time t
function pickClipAtPoint(x, y, t){
  try{
    const all = flattenLayersToTimeline().filter(c=> c.type==='image');
    // Only consider clips active at time t
    const active = all.filter(c=>{
      const st = c.startTime||0; const dur = (c.duration!=null)? Number(c.duration):(c.type==='image'?2:0);
      return t >= st && t <= st + dur + 1e-4;
    });
    // Sort by layer index (higher on top)
    active.sort((a,b)=> (a._layerIndex||0) - (b._layerIndex||0));
    // Iterate from topmost to bottom-most
    for (let i = active.length - 1; i >= 0; i--){
      const c = active[i];
      // Ensure transform defaults
      c.transform = c.transform || { x: canvas.width/2, y: canvas.height/2, w: canvas.width, h: canvas.height, rotation: 0 };
      const r = getClipRectOnCanvas(c);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return c;
    }
  }catch(e){ /* ignore */ }
  return null;
}

function onCanvasPointerDown(ev){ if (isPlaying) return; let sel = getSelectedClip(); const ptCssX = (ev.clientX!=null? ev.clientX : (ev.touches&&ev.touches[0]&&ev.touches[0].clientX)||0); const ptCssY = (ev.clientY!=null? ev.clientY : (ev.touches&&ev.touches[0]&&ev.touches[0].clientY)||0); let elAt = document.elementFromPoint(ptCssX, ptCssY); const pt = canvasPt(ev);
  // If we clicked a child, walk up to see if it's a transform or crop handle
  let role = null, anchor = null;
  // Ignore clicks originating from toolbar or its children
  try{ if (ev.target && (ev.target.closest && ev.target.closest('.preview-toolbar'))){ ev.preventDefault(); ev.stopPropagation(); return; } }catch(e){}
  if (elAt){
    const handleEl = elAt.closest ? elAt.closest('.handle, .crop-handle') : null;
    elAt = handleEl || elAt;
    role = elAt && elAt.dataset && elAt.dataset.role;
    anchor = elAt && elAt.dataset && elAt.dataset.anchor;
  }
  // If nothing is selected, or click is outside current selection, try selecting the topmost clip under the cursor at current playhead
  if (!sel || (sel && role !== 'transform' && role !== 'crop')){
    const pick = pickClipAtPoint(pt.x, pt.y, playhead);
    if (pick){
      selectedLayerId = pick._layerId; selectedIndex = pick._clipIndex; selectedClip = pick; sel = pick; renderOverlays();
    }
  }
  if (role==='transform'){ interaction = { from:'canvas', mode: anchor==='move'?'move':'resize', anchor, start: pt, orig: JSON.parse(JSON.stringify(sel.transform)) }; ev.preventDefault(); ev.stopPropagation(); return; }
  if (role==='crop'){ interaction = { from:'canvas', mode: anchor==='move'?'crop-move':'crop-resize', anchor, start: pt, orig: JSON.parse(JSON.stringify(sel.crop)) }; ev.preventDefault(); ev.stopPropagation(); return; }
  // click inside selection to move
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
      // clamp to image bounds
      const img = sel._img; const w = (img && img.naturalWidth) || 1, h = (img && img.naturalHeight) || 1; cx = Math.max(0, Math.min(cx, w-1)); cy = Math.max(0, Math.min(cy, h-1)); if (cx+cw> w) cw = w - cx; if (cy+ch> h) ch = h - cy; sel.crop = { x: cx, y: cy, w: cw, h: ch };
    }
    drawFrame(playhead);
  }catch(e){
    // Avoid breaking other interactions (like timeline drags) if an unexpected event bubbles here
    console.warn('[canvas] pointer move ignored due to error:', e);
    try { interaction = null; } catch(_e){}
  }
}

function onCanvasPointerUp(){ if (interaction && interaction.from === 'canvas'){ interaction = null; scheduleAutosave(); } }

// ------------------ Audio scheduling during canvas playback (HTMLAudio only) ------------------
function findCurrentOrNextAudioClip(auds, t){
  // Prefer the clip active at time t; otherwise the next one after t
  let current = null;
  let next = null;
  for (const c of auds){
    const st = Number(c.startTime||0);
    const dur = (c.duration!=null)? Number(c.duration) : null;
    if (dur != null && t >= st && t < st + dur){ current = c; break; }
    if (st >= t){ if (!next || st < Number(next.startTime||0)) next = c; }
  }
  return current || next;
}

function scheduleAudioForPlayback(){
  clearAudioPlayback();
  const all = flattenLayersToTimeline();
  const auds = all.filter(c=> c.type==='audio' && c.src).sort((a,b)=> (a.startTime||0) - (b.startTime||0));
  DBG('Scheduling audio - found audio clips:', auds.length);
  
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
  // choose element
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
  // Reset handlers to avoid stacking
  audio.onended = null; audio.onerror = null; audio.onstalled = null; audio.onwaiting = null; audio.onloadedmetadata = null;
  // Attach basic logs for diagnostics
  audio.onerror = ()=>{ const err = audio.error ? audio.error.code : 'unknown'; DBG('HTMLAudio error', { src: playable, code: err, readyState: audio.readyState }); };
  audio.onstalled = ()=>{ DBG('HTMLAudio stalled', { src: playable }); };
  audio.onwaiting = ()=>{ DBG('HTMLAudio waiting', { src: playable }); };
  // Chain to the next clip when this one ends
  audio.onended = ()=>{
    const curEnd = (clip.startTime||0) + (clip.duration!=null? Number(clip.duration):0);
    const nextClip = findCurrentOrNextAudioClip(auds, curEnd + 0.001);
    if (!isPlaying || !nextClip) return;
    playhead = Math.max(playhead, curEnd);
    // Schedule next immediately
    window.activeAudioTimeout = setTimeout(()=>{ scheduleAudioForPlayback(); }, 0);
  };
  // Seek to offset within the clip
  if (playhead < (clip.startTime||0)){
    playhead = (clip.startTime||0);
    try{ drawFrame(playhead); }catch(e){}
  }
  const offset = Math.max(0, playhead - (clip.startTime||0));
  const seekAndPlay = ()=>{
    try{
      if (offset>0 && isFinite(audio.duration)){
        audio.currentTime = Math.min(audio.duration-0.05, Math.max(0, offset));
      }
    }catch(e){}
    audio.play().then(()=>{ DBG('HTMLAudio play started', { src: playable, at: playhead.toFixed(2) }); }).catch(err=>{ DBG('HTMLAudio play error', err); });
  };
  if (audio.readyState >= 1){ seekAndPlay(); } else { audio.onloadedmetadata = seekAndPlay; try{ audio.load(); }catch(e){} }
  // Ensure playback element exists in DOM to align with some browsers (not strictly required)
}

function clearAudioPlayback(){
  try{
    // Stop any pending schedule
    if (activeAudioTimeout){ clearTimeout(activeAudioTimeout); activeAudioTimeout = null; }
    // Stop active audio element
    if (activeAudio){
      try{ activeAudio.pause(); }catch(e){}
      try{ if (isFinite(activeAudio.duration)) activeAudio.currentTime = 0; }catch(e){}
      activeAudio = null;
    }
    // Abort any WebAudio fetches (legacy)
    Object.values(audioFetchControllers).forEach(ctrl=>{ try{ ctrl.abort(); }catch(e){} });
    audioFetchControllers = {};
  }catch(e){}
  previewControllers = [];
}

// Preload all images used in the timeline to prevent loading during playback
function preloadImageAssets(){
  try {
    const all = flattenLayersToTimeline();
    const imageClips = all.filter(c => c.type === 'image' && c.src);
    
    DBG('Preloading images:', imageClips.length);
    
    imageClips.forEach(clip => {
      if (!clip._img && !clip._imgLoading) {
        clip._imgLoading = true;
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          clip._imgLoading = false;
          clip._imgLoaded = true;
          
          // Also set the cache on the original clip in layers to ensure persistence
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
          
          // Also set error on original clip
          const originalClip = findOriginalClip(clip);
          if (originalClip) {
            originalClip._imgLoading = false;
            originalClip._imgError = true;
          }
          
          DBG('Failed to preload image:', clip.src);
        };
        im.src = normalizeSrc(clip.src);
        clip._img = im;
        
        // Also set on original clip immediately
        const originalClip = findOriginalClip(clip);
        if (originalClip) {
          originalClip._img = im;
          originalClip._imgLoading = true;
        }
      }
    });
  } catch(e) {
    DBG('Error preloading images:', e);
  }
}

// Helper function to find the original clip in layers based on flattened clip metadata
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

// Preload audio elements by src and keep them around for playback
function preloadAudioAssets(){
  if (audioPreloadInProgress) {
    DBG('Audio preload already in progress, skipping duplicate call');
    return;
  }
  
  audioPreloadInProgress = true;
  DBG('Starting audio preload (locked)');
  
  // Clean up any stale blob URLs from previous sessions - ONLY on first run
  if (!window.audioAssetsCleanedUp) {
    try {
      DBG('Starting aggressive cleanup of stale blob URLs...');
      
      // First revoke old blob URLs
      Object.values(audioObjectUrlMap).forEach(({ url }) => {
        try { URL.revokeObjectURL(url); } catch(e) {}
      });
      Object.keys(audioObjectUrlMap).forEach(key => delete audioObjectUrlMap[key]);
      Object.keys(preloadedAudioEls).forEach(key => {
        if (key.startsWith('blob:')) delete preloadedAudioEls[key];
      });
      
      // More aggressive cleanup of clip data - check ALL clips for blob URLs
      try {
        layers.forEach((layer, layerIndex) => {
          layer.clips.forEach((clip, clipIndex) => {
            if (clip.type === 'audio' && clip.src) {
              const src = String(clip.src);
              if (src.startsWith('blob:')) {
                DBG(`Found stale blob URL in layer[${layerIndex}].clips[${clipIndex}]:`, src);
                // Reset to original source if we have it in meta
                if (clip.meta && clip.meta.originalSrc) {
                  clip.src = clip.meta.originalSrc;
                  DBG('Reset to originalSrc:', clip.meta.originalSrc);
                } else {
                  // Try to find a reasonable fallback from meta
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
        
        // Also check the flattened timeline if it exists
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
      
      window.audioAssetsCleanedUp = true; // Mark as cleaned up
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
      if (preloadedAudioEls[src]) return; // already prepped
      if (isBlobLike(src)){
        // Directly create audio element
        const a = new Audio();
        try{ a.crossOrigin = 'anonymous'; }catch(e){}
        a.preload = 'auto'; a.src = src;
        
        // Add timeout for audio loading to prevent hanging
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
        // Fetch once, create object URL, update clip meta so export can upload the blob
        DBG('Starting HTTP fetch for audio:', src);
        (async()=>{
          try{
            if (!audioObjectUrlMap[src]){
              DBG('Fetching audio from:', src);
              // Add timeout to fetch to prevent hanging
              const controller = new AbortController();
              const timeoutId = setTimeout(() => {
                DBG('Audio fetch timeout for:', src);
                controller.abort();
              }, 10000); // 10 second timeout
              
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
            // Attach to preloader element (key both original and blob URL for lookup)
            const a = new Audio();
            DBG('Creating audio element for:', objUrl);
            try{ a.crossOrigin = 'anonymous'; }catch(e){}
            a.preload = 'auto'; a.src = objUrl;
            
            // Add timeout for audio loading to prevent hanging
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
            // Update original layer clip to use blob URL for instant local playback and store blob in meta
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
      
      // Track completion of all audio operations
      let completedAudio = 0;
      const totalAudio = toProcess.length;
      const completedSources = new Set(); // Track which sources have completed
      
      const checkAllComplete = (src) => {
        if (completedSources.has(src)) return; // Prevent double counting
        completedSources.add(src);
        completedAudio++;
        DBG(`Audio completed: ${completedAudio}/${totalAudio} (${src})`);
        if (completedAudio >= totalAudio) {
          DBG('All audio preloading completed!');
          audioPreloadInProgress = false;
          
          // Only stop operations if we're still loading the page
          if (document.readyState !== 'complete') {
            DBG('Page still loading - stopping operations to help completion');
            stopRaf(); // Stop animation if running
            clearAudioPlayback(); // Stop audio if playing
          } else {
            DBG('Page already loaded - keeping animation system active for playback');
          }
          
          // Force page completion immediately
          setTimeout(() => {
            DBG('Checking document readyState after audio completion:', document.readyState);
            if (document.readyState !== 'complete') {
              DBG('Signaling page completion without re-initialization');
              
              // Method 1: Stop the monitoring interval
              if (window.pageMonitorInterval) {
                clearInterval(window.pageMonitorInterval);
                DBG('Stopped page monitor interval');
              }
              
              // Method 2: Create a completion flag to prevent future operations
              window.videoEditorLoaded = true;
              
              // Stop any ongoing operations that might keep the page loading
              // Only do this if we're still in loading state
              try {
                stopRaf(); // Stop animation frame loop
                // Don't clear audio playback - we want to keep preloaded audio
                DBG('Stopped animation operations during loading (kept audio preloaded)');
              } catch (e) {
                DBG('Error stopping operations:', e);
              }
              
              // Clear any pending timeouts
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
              
              // Close any potential EventSource connections
              try {
                window.__renderJobId = null; // This should prevent new EventSource connections
                DBG('Cleared render job ID to prevent EventSource connections');
              } catch (e) {
                DBG('Error clearing EventSource:', e);
              }
              
              // Clear any pending timeouts
              if (window.resizeTimer) {
                clearTimeout(window.resizeTimer);
                window.resizeTimer = null;
              }
              if (window.activeAudioTimeout) {
                clearTimeout(window.activeAudioTimeout);
                window.activeAudioTimeout = null;
              }
              
              // Method 3: Use a more subtle approach - just signal completion
              try {
                // Set readyState to complete
                Object.defineProperty(document, 'readyState', {
                  value: 'complete',
                  writable: false,
                  configurable: true
                });
                
                // Dispatch a custom completion event instead of browser events
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
      
      // Override the completion tracking in blob and HTTP handlers
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
  // compute total seconds from layers
  let total = 0;
  layers.forEach(l=>{ l.clips.forEach(c=> { const end = (c.startTime||0) + ((c.duration!=null)? Number(c.duration): (c.type==='image'?2:0)); total = Math.max(total, end); }) });
  // compute desired width and use it directly so the viewport will show an internal scrollbar
  const desiredWidth = Math.ceil(total * pxPerSec);
  // Ensure the timeline track is at least as wide as the visible timeline viewport
  const viewportEl = document.querySelector('.timeline-viewport');
  const vpWidth = viewportEl ? Math.floor(viewportEl.getBoundingClientRect().width) : 0;
  const minWidth = Math.max(800, vpWidth || 0);
  const width = Math.max(minWidth, desiredWidth);
  // viewPxPerSec should match the logical zoom so pixel<->second math is consistent
  viewPxPerSec = pxPerSec;
  ruler.innerHTML = '';
  ruler.style.width = width + 'px';
  // draw ticks every second
  for (let s=0; s<= Math.ceil(Math.max(10, total)); s++){
    const tick = document.createElement('div'); tick.className='tick'; tick.style.left = (s * viewPxPerSec) + 'px'; tick.style.width = Math.max(1, Math.floor(viewPxPerSec)) + 'px'; tick.textContent = formatTime(s);
    ruler.appendChild(tick);
  }
  // ensure outer track width matches ruler
  const outer = document.getElementById('timelineOuter'); if (outer) outer.style.width = width + 'px';
}

function persistZoom(){
  try{ window.localStorage.setItem('video_editor_pxPerSec', String(pxPerSec)); }catch(e){}
}

function recalcViewScale(){
  // Ensure viewPxPerSec mirrors pxPerSec (no clamping behavior)
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
  // Drop into active layer at end
  let layer = layers.find(l => l.id === activeLayerId) || layers[0];
  if (isBackgroundLayer(layer)){
    // pick first non-background or create one
    layer = layers.find(l=> !isBackgroundLayer(l));
    if (!layer){ addLayer(); layer = layers[layers.length-1]; }
  }
  if (!layer) return;
  // compute drop position seconds
  const dropSec = computeDropSecondsFromEvent(e);
  if (type === 'image') {
    const panel = panels.find(p => p.id === id);
    if (!panel) return;
    const clip = {type:'image', src: panel.src, id: panel.id, duration: 2, startTime: 0};
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
  // keep legacy flat timeline in sync (flattened)
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
}

function renderTimeline() {
  const track = document.getElementById('timelineTrack');
  track.innerHTML = '';
  renderRuler();
  // Render each layer as a horizontal track
  layers.forEach((layer, lidx) => {
    const layerRoot = document.createElement('div');
    layerRoot.className = 'timeline-layer';
    layerRoot.dataset.layerId = layer.id;
    // If active layer, add header chip and highlight
    const header = document.createElement('div');
    header.className = 'layer-header';
    const chip = document.createElement('div'); chip.className = 'layer-chip'; chip.textContent = layer.name + (layer.id === activeLayerId ? ' (active)' : '');
    header.appendChild(chip);
    const addBtn = document.createElement('button'); addBtn.className = 'btn secondary'; addBtn.textContent = 'Select';
    addBtn.addEventListener('click', () => { activeLayerId = layer.id; renderTimeline(); renderLayerControls(); });
    // Prevent removing the background layer
    if (!isBackgroundLayer(layer)) {
      const removeBtn = document.createElement('button'); removeBtn.className = 'btn secondary'; removeBtn.textContent = 'Remove Layer';
      removeBtn.addEventListener('click', ()=>{ removeLayer(layer.id); });
      header.appendChild(addBtn); header.appendChild(removeBtn);
    } else {
      header.appendChild(addBtn);
    }
    const container = document.createElement('div'); container.style.display='flex'; container.style.flexDirection='column'; container.appendChild(header);

  const clipsContainer = document.createElement('div'); clipsContainer.className = 'layer-clips'; clipsContainer.style.position='relative'; clipsContainer.style.minHeight='84px'; clipsContainer.dataset.layerId = layer.id;
    // allow dropping directly onto a layer
    clipsContainer.ondragover = (ev)=> ev.preventDefault();
    clipsContainer.ondrop = (ev)=> { ev.stopPropagation(); if (!isBackgroundLayer(layer)) onDropToLayer(ev, layer.id); };

    layer.clips.forEach((clip, idx) => {
      const el = document.createElement('div');
      el.className = 'clip';
      el.dataset.idx = idx; el.dataset.layerId = layer.id; el.draggable = false;
      // render content and include a resize handle at the right edge
      if (clip.type === 'image') {
        el.innerHTML = `<img src="${clip.src}" alt="clip-${idx}" loading="lazy" decoding="async"/><div class="info"><div style=\"font-weight:700\">Image</div><div class=\"small\">${clip.id || ''}</div></div><div class="duration-badge">${(clip.duration||2).toFixed(1)}s</div><div class="start-badge">${formatTime(clip.startTime||0)}</div><div class="remove" title="Remove">✕</div><div class="clip-handle" title="Resize"></div>`;
      } else {
        el.innerHTML = `<div style=\"width:88px;height:68px;background:#071226;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#9fc0ff\">AUD</div><div class=\"info\"><div style=\"font-weight:700\">Audio</div><div class=\"small\">${clip.id || ''}</div></div><div class=\"duration-badge\">${clip.duration? (clip.duration.toFixed(1)+"s") : '—'}</div><div class=\"start-badge\">${formatTime(clip.startTime||0)}</div><div class=\"remove\" title=\"Remove\">✕</div><div class=\"clip-handle\" title=\"Resize\"></div>`;
      }
      // position clip by startTime and width by duration
      const st = clip.startTime || 0; const dur = (clip.duration != null)? Number(clip.duration) : (clip.type==='image'?2:0);
  // Use viewPxPerSec for rendering so the DOM widths remain reasonable when clamped
  el.style.left = (st * viewPxPerSec) + 'px'; el.style.width = Math.max(88, dur * viewPxPerSec) + 'px';
      // enable horizontal dragging to reposition startTime
      if (!isBackgroundLayer(layer)){
        el.addEventListener('mousedown', onClipDragStart);
        el.addEventListener('touchstart', onClipDragStart, {passive:false});
      }
      // attach resize handle listeners
      const handle = el.querySelector('.clip-handle');
      if (handle && !isBackgroundLayer(layer)){ handle.addEventListener('mousedown', onClipResizeStart); handle.addEventListener('touchstart', onClipResizeStart, {passive:false}); }
      el.addEventListener('click', ()=> selectLayerClip(layer.id, idx));
      // Prevent remove control from triggering clip drag: intercept mousedown/touchstart
      const removeBtns = el.querySelectorAll('.remove');
      removeBtns.forEach(btn => {
        if (!isBackgroundLayer(layer)){
          btn.addEventListener('mousedown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); });
          btn.addEventListener('touchstart', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); }, {passive:false});
          // keep click as fallback
          btn.addEventListener('click', (ev) => { ev.stopPropagation(); removeClipFromLayer(layer.id, idx); });
        } else {
          // disable remove for background clip
          btn.style.display = 'none';
        }
      });
      clipsContainer.appendChild(el);
    });

    container.appendChild(clipsContainer);
    layerRoot.appendChild(container);
    track.appendChild(layerRoot);
  });
  // After rendering timeline, refresh preloaded assets
  try{ preloadImageAssets(); }catch(e){}
  try{ preloadAudioAssets(); }catch(e){}
}

// Drag-to-position implementation
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
  // compute desired left position in px within track
  const leftPx = clientX - outerRect.left - dragOffsetX;
  // Convert using viewPxPerSec (pixels in the viewport) to seconds
  const snappedSec = Math.max(0, Math.round((leftPx / viewPxPerSec) / snapSeconds) * snapSeconds);
  const newLeftPx = snappedSec * viewPxPerSec;
  // preview move
  dragging.el.style.left = newLeftPx + 'px';
}

function onClipDragEnd(ev){
  if (!dragging) return;
  const el = dragging.el; const layer = dragging.layer; const idx = dragging.idx;
  el.classList.remove('dragging');
  // compute final startTime from left px
  const leftPx = parseFloat(el.style.left || '0');
  // leftPx is in viewport pixels -> convert using viewPxPerSec
  const newStart = Math.max(0, Math.round((leftPx / viewPxPerSec) / snapSeconds) * snapSeconds);
  // Remove the moving clip from its current index so we can re-insert based on newStart
  const moving = layer.clips.splice(idx, 1)[0];
  // Determine new insert index in this layer based on newStart (same logic as insertClipIntoLayerAt)
  let insertIndex = layer.clips.length;
  for (let i=0;i<layer.clips.length;i++){
    const c = layer.clips[i];
    const cStart = c.startTime || 0;
    const cDur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    const cEnd = cStart + (cDur || 0);
    if (newStart < cStart){ insertIndex = i; break; }
    if (newStart >= cStart && newStart <= cEnd){ const mid = cStart + (cDur || 0)/2; insertIndex = (newStart < mid) ? i : i+1; break; }
  }

  // Insert moving clip at determined index
  layer.clips.splice(insertIndex, 0, moving);
  // Ensure moving.startTime doesn't overlap previous clip
  if (insertIndex > 0){
    const prev = layer.clips[insertIndex-1];
    const prevEnd = (prev.startTime || 0) + ((prev.duration!=null)? Number(prev.duration) : (prev.type==='image'?2:0));
    moving.startTime = Math.max(newStart, prevEnd);
  } else {
    moving.startTime = newStart;
  }

  // Always shift subsequent clips to avoid overlap
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
  // cleanup
  window.removeEventListener('mousemove', onClipDragMove);
  window.removeEventListener('mouseup', onClipDragEnd);
  window.removeEventListener('touchmove', onClipDragMove);
  window.removeEventListener('touchend', onClipDragEnd);
  dragging = null;
}

// ------------------ RESIZE (TRIMMING) HANDLERS ------------------
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
  resizeStartX = ev.touches ? ev.touches[0].clientX : ev.clientX;
  resizeStartWidth = parseFloat(clipEl.style.width || '0');
  clipEl.classList.add('clip-resizing');
  window.addEventListener('mousemove', onClipResizeMove);
  window.addEventListener('mouseup', onClipResizeEnd);
  window.addEventListener('touchmove', onClipResizeMove, {passive:false});
  window.addEventListener('touchend', onClipResizeEnd);
}
function onClipResizeMove(ev){
  if (!resizing) return; ev.preventDefault();
  const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
  const dx = clientX - resizeStartX;
  const newWidth = Math.max(40, resizeStartWidth + dx);
  resizing.clipEl.style.width = newWidth + 'px';
  // show duration badge live
  // Convert width (viewport px) to seconds using viewPxPerSec
  const durSec = Math.max(0.05, newWidth / viewPxPerSec);
  const badge = resizing.clipEl.querySelector('.duration-badge'); if (badge) badge.textContent = durSec.toFixed(2) + 's';
}
function onClipResizeEnd(ev){
  if (!resizing) return;
  const { layer, idx, clipEl } = resizing;
  clipEl.classList.remove('clip-resizing');
  // commit new duration
  const width = parseFloat(clipEl.style.width || '0');
  const newDur = Math.max(0.05, Math.round((width / viewPxPerSec) / snapSeconds) * snapSeconds);
  layer.clips[idx].duration = newDur;
  // Always ensure subsequent clips start after this clip's end (prevent overlaps)
  let cursor = (layer.clips[idx].startTime || 0) + newDur;
  for (let i=idx+1;i<layer.clips.length;i++){
    if ((layer.clips[i].startTime||0) < cursor) layer.clips[i].startTime = cursor;
    const dur = (layer.clips[i].duration!=null)? Number(layer.clips[i].duration) : (layer.clips[i].type==='image'?2:0);
    cursor = (layer.clips[i].startTime||0) + (dur || 0);
  }
  timeline = flattenLayersToTimeline(); renderTimeline(); scheduleAutosave();
  fixLayerOverlaps(layer);
  window.removeEventListener('mousemove', onClipResizeMove);
  window.removeEventListener('mouseup', onClipResizeEnd);
  window.removeEventListener('touchmove', onClipResizeMove);
  window.removeEventListener('touchend', onClipResizeEnd);
  resizing = null;
}

// ------------------ AUTOSAVE ------------------
function scheduleAutosave(){
  if (isExporting) return; // skip autosave while exporting
  autosavePending = true;
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = 'Pending...';
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(()=>{ saveProject(false); }, 2000);
  
  // Mark initialization complete
  DBG('Video editor initialization completed');
  
  // Check if page is still loading after our initialization
  setTimeout(() => {
    DBG('Post-init check - document.readyState:', document.readyState);
    if (document.readyState !== 'complete') {
      DBG('WARNING: Page still not in complete state after initialization');
    }
  }, 1000);
}

async function saveProject(force=false){
  if (!autosavePending && !force) return;
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = 'Saving...';
  try{
    const project = window.projectData || {};
    // Sanitize layers to avoid sending heavy blobs/base64 to the server on autosave
    const sanitizedLayers = (layers || []).map(l => ({
      id: l.id,
      name: l.name,
      clips: (l.clips || []).map(c => {
        const out = Object.assign({}, c);
        if (out.type === 'audio'){
          // Normalize src to a simple, playable string if possible
          const playable = getPlayableSrc(out.src || out.meta);
          out.src = playable || '';
          // Strip heavy fields from meta; keep only link-ish fields
          out.meta = sanitizeAudioMeta(out.meta);
        }
        // Drop transient fields used only in UI
        delete out._img; delete out._layerId; delete out._clipIndex; delete out._isBackground;
        return out;
      })
    }));
    const payload = { project_id: project.id, layers: sanitizedLayers };
    const resp = await fetch('/save_project', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)});
    if (!resp.ok) throw new Error('Save failed: ' + resp.status);
    autosavePending = false;
    if (autosaveEl) autosaveEl.textContent = 'Saved';
    setTimeout(()=>{ if (autosaveEl) autosaveEl.textContent = ''; }, 2000);
  }catch(e){
    console.error('Autosave failed', e);
    if (autosaveEl) autosaveEl.textContent = 'Save error';
  }
}

// ------------------ WEBAUDIO-BASED PREVIEW ------------------
async function ensureAudioContext(){
  if (audioCtx) return audioCtx;
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }catch(e){ audioCtx = null; }
  return audioCtx;
}

async function fetchAudioBuffer(src){
  if (!src) return null;
  if (audioBufferCache[src]) return audioBufferCache[src];
  try{
    const ctx = await ensureAudioContext();
    if (!ctx) return null;
    // Use AbortController so pause can cancel long downloads
    const ctrl = new AbortController();
    audioFetchControllers[src] = ctrl;
    const resp = await fetch(src, { signal: ctrl.signal });
    const ab = await resp.arrayBuffer();
    // After completion, delete controller
    delete audioFetchControllers[src];
    const decoded = await ctx.decodeAudioData(ab);
    audioBufferCache[src] = decoded; return decoded;
  }catch(e){ console.warn('AudioBuffer fetch/decoding failed for', src, e); return null; }
}

async function onPreviewTimeline(){ togglePlayback(); }


function onDropToLayer(e, layerId){
  e.preventDefault();
  const payload = JSON.parse(e.dataTransfer.getData('text/plain'));
  const {id, type} = payload;
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return;
  // Compute drop time (in seconds) based on pointer X within timeline
  const dropSec = computeDropSecondsFromEvent(e);
  if (type === 'image'){
    const panel = panels.find(p => p.id === id); if (!panel) return;
    const clip = {type:'image', src: panel.src, id: panel.id, duration:2, startTime:0};
    insertClipIntoLayerAt(layer, clip, dropSec);
    scheduleAutosave();
  } else if (type === 'audio'){
    const audio = audios.find(a => a.id === id);
    if (!audio) return;
    const playable = getPlayableSrc(audio.src || audio.meta);
    const clip = {type:'audio', src: playable || '', id: audio.id, duration:null, startTime:0, meta: audio.meta};
    insertClipIntoLayerAt(layer, clip, dropSec);
    // If we have a playable src, extract duration and then reflow/refresh
    if (clip.src){
      extractAudioDuration(clip).then(d=>{
        clip.duration = d;
        // ensure following clips are shifted if needed
        if (document.getElementById('reflowToggle')?.checked){
          // find this clip in layer and reflow
          const idx = layer.clips.indexOf(clip);
          if (idx >= 0){
            let cursor = (layer.clips[idx].startTime || 0) + (clip.duration || 0);
            for (let i = idx+1; i<layer.clips.length; i++){
              layer.clips[i].startTime = Math.max(layer.clips[i].startTime||0, cursor);
              const dur = (layer.clips[i].duration!=null)? Number(layer.clips[i].duration) : (layer.clips[i].type==='image'?2:0);
              cursor = (layer.clips[i].startTime||0) + (dur || 0);
            }
          }
        }
        timeline = flattenLayersToTimeline(); renderTimeline(); scheduleAutosave();
      });
    }
    scheduleAutosave();
  }
  timeline = flattenLayersToTimeline(); renderTimeline();
  scheduleAutosave();
}

// Compute drop seconds from a drag event relative to timeline outer element
function computeDropSecondsFromEvent(e){
  try{
    const outer = document.getElementById('timelineOuter'); if (!outer) return 0;
    const outerRect = outer.getBoundingClientRect();
    const clientX = (e.touches && e.touches[0])? e.touches[0].clientX : e.clientX;
    const leftPx = clientX - outerRect.left;
    const sec = Math.max(0, leftPx / viewPxPerSec);
    const snapped = Math.max(0, Math.round(sec / snapSeconds) * snapSeconds);
    return snapped;
  }catch(err){ return 0; }
}

// Insert a clip into a layer at a desired second, choose index based on existing clips
function insertClipIntoLayerAt(layer, clip, desiredSec){
  // snap desiredSec
  const sec = Math.max(0, Math.round((desiredSec || 0) / snapSeconds) * snapSeconds);
  // find index and handle drop-inside-a-clip logic
  let insertIndex = layer.clips.length; // default append
  for (let i=0;i<layer.clips.length;i++){
    const c = layer.clips[i];
    const cStart = c.startTime || 0;
    const cDur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    const cEnd = cStart + (cDur || 0);
    if (sec < cStart){
      // drop before this clip
      insertIndex = i; break;
    }
    if (sec >= cStart && sec <= cEnd){
      // dropped inside this clip: choose before/after based on middle
      const mid = cStart + (cDur || 0)/2;
      insertIndex = (sec < mid) ? i : i+1;
      break;
    }
  }

  // Insert clip at index
  layer.clips.splice(insertIndex, 0, clip);
  // ensure clip startTime is set not to overlap previous
  if (insertIndex > 0){
    const prev = layer.clips[insertIndex-1];
    const prevEnd = (prev.startTime || 0) + ((prev.duration!=null)? Number(prev.duration) : (prev.type==='image'?2:0));
    clip.startTime = Math.max(sec, prevEnd);
  } else {
    clip.startTime = sec;
  }

  // Always shift following clips to avoid overlap: enforce sequential layout after insert index
  let cursor = (clip.startTime || 0) + ((clip.duration!=null)? Number(clip.duration) : (clip.type==='image'?2:0));
  for (let i = insertIndex+1; i<layer.clips.length; i++){
    const c = layer.clips[i];
    const dur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    if ((c.startTime||0) < cursor){
      c.startTime = cursor;
    }
    cursor = (c.startTime||0) + (dur || 0);
  }
  // If clip has no duration (audio) we leave duration null and will update later when available
  timeline = flattenLayersToTimeline(); renderTimeline();
  fixLayerOverlaps(layer);
}

// Ensure a layer has no overlaps by shifting subsequent clips sequentially
function fixLayerOverlaps(layer){
  if (!layer || !Array.isArray(layer.clips)) return;
  // Sort clips by current startTime to ensure deterministic order
  layer.clips.sort((a,b)=> (a.startTime||0) - (b.startTime||0));
  let cursor = 0;
  for (let i=0;i<layer.clips.length;i++){
    const c = layer.clips[i];
    const dur = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0);
    if ((c.startTime||0) < cursor) c.startTime = cursor;
    cursor = (c.startTime||0) + (dur || 0);
  }
}

function selectLayerClip(layerId, idx){
  const layer = layers.find(l=>l.id===layerId);
  if (!layer) return;
  selectedClip = layer.clips[idx];
  selectedLayerId = layerId; selectedIndex = idx;
  // reuse inspector UI but need to map update/remove to layer
  const inspector = document.getElementById('inspector');
  const type = selectedClip.type; const src = selectedClip.src || ''; const durationVal = selectedClip.duration || '';
  const isBg = isBackgroundLayer(layer);
  inspector.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Type:</strong> ${type}</div>
      <div><strong>Src:</strong> <a href="${src}" target="_blank" style="color:#9fd2ff">${src}</a></div>
      <div>
        <label style="display:flex;gap:8px;align-items:center"><strong>Duration(s):</strong>
          <input id="clipDur" type="number" value="${durationVal||2}" min="0.1" step="0.1" style="margin-left:8px;padding:6px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.06);color:#dff3ff;" />
        </label>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="insUpdate">Update</button>
        ${isBg ? '' : '<button class="btn secondary" id="insRemove">Remove</button>'}
        <button class="btn secondary" id="insPlay">Play Clip</button>
      </div>
    </div>
  `;
  document.getElementById('insUpdate').addEventListener('click', ()=>{
    const v = parseFloat(document.getElementById('clipDur').value || '2');
    selectedClip.duration = v; timeline = flattenLayersToTimeline(); renderTimeline(); recomputeLayerTimings(layers.find(ld=> ld.id === activeLayerId) || layers[0]); scheduleAutosave();
  });
  if (!isBg){
    const rm = document.getElementById('insRemove'); if (rm) rm.addEventListener('click', ()=>{ const li = layer.clips.indexOf(selectedClip); if (li>=0) { layer.clips.splice(li,1); recomputeLayerTimings(layer); timeline=flattenLayersToTimeline(); renderTimeline(); scheduleAutosave(); } });
  }
  const playBtn = document.getElementById('insPlay'); if (playBtn) playBtn.addEventListener('click', ()=>{ if (typeof drawFrame === 'function'){ playhead = selectedClip.startTime || 0; drawFrame(playhead); } });
  // update overlays on selection
  if (typeof renderOverlays === 'function'){ renderOverlays(); }
}

function removeClipFromLayer(layerId, idx){
  const layer = layers.find(l=>l.id===layerId); if (!layer) return; layer.clips.splice(idx,1); timeline = flattenLayersToTimeline(); renderTimeline(); scheduleAutosave();
}

function flattenLayersToTimeline(){
  // simple flatten by concatenating layers in order (layer 0 first).
  // Include mapping metadata so flat timeline items can be traced back to their layer/clip index.
  // IMPORTANT: Preserve image cache properties (_img, _imgLoading, etc.) when copying
  const out = [];
  layers.forEach((l, li) => { 
    l.clips.forEach((c, ci) => {
      const flattened = Object.assign({}, c, { 
        _layerId: l.id, 
        _layerIndex: li, 
        _clipIndex: ci, 
        _isBackground: isBackgroundLayer(l) 
      });
      
      // Preserve image cache properties to prevent reloading during playback
      if (c._img) flattened._img = c._img;
      if (c._imgLoading) flattened._imgLoading = c._imgLoading;
      if (c._imgLoaded) flattened._imgLoaded = c._imgLoaded;
      if (c._imgError) flattened._imgError = c._imgError;
      
      out.push(flattened);
    });
  });
  return out;
}

function removeLayer(layerId){
  if (layers.length===1) { alert('Cannot remove the last layer'); return; }
  const idx = layers.findIndex(l=>l.id===layerId); if (idx<0) return; layers.splice(idx,1); if (activeLayerId===layerId) activeLayerId = layers[0].id; timeline = flattenLayersToTimeline(); renderTimeline(); renderLayerControls();
}

function addLayer(){
  const id = 'layer-'+(Date.now()); const name = 'Layer '+(layers.length+1); layers.push({id, name, clips:[]}); activeLayerId = id; renderTimeline(); renderLayerControls();
}

function renderLayerControls(){
  // add small UI inside timeline header for layers
  const header = document.querySelector('.timeline-header');
  if (!header) return;
  // remove existing layer-controls if any
  const existing = document.getElementById('layerControls'); if (existing) existing.remove();
  const ctr = document.createElement('div'); ctr.id='layerControls'; ctr.style.display='flex'; ctr.style.gap='8px';
  const addBg = document.createElement('button'); addBg.className='btn secondary'; addBg.textContent='Add Background'; addBg.title = 'Add 1920x1080 background image'; addBg.addEventListener('click', ()=>{ ensureBackgroundLayer(true); renderTimeline(); renderLayerControls(); scheduleAutosave(); });
  const add = document.createElement('button'); add.className='btn'; add.textContent='Add Layer'; add.addEventListener('click', addLayer);
  const select = document.createElement('select'); select.style.padding='6px'; select.style.borderRadius='6px'; layers.forEach(l=>{ const o = document.createElement('option'); o.value=l.id; o.textContent=l.name; if (l.id===activeLayerId) o.selected=true; select.appendChild(o); }); select.addEventListener('change', (e)=>{ activeLayerId = e.target.value; renderTimeline(); });
  ctr.appendChild(select); ctr.appendChild(add); ctr.appendChild(addBg);
  header.appendChild(ctr);
}

function removeClip(idx) {
  // Remove from underlying layer if mapping present, otherwise remove from flat timeline
  const item = timeline[idx];
  if (item && item._layerId != null && typeof item._clipIndex === 'number'){
    const layer = layers.find(l=>l.id===item._layerId);
    if (layer && layer.clips && layer.clips.length > item._clipIndex){
      layer.clips.splice(item._clipIndex, 1);
      // recompute timings for that layer
      recomputeLayerTimings(layer);
    }
  } else {
    timeline.splice(idx, 1);
  }
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
}

function selectClip(idx) {
  selectedClip = timeline[idx];
  selectedLayerId = selectedClip? selectedClip._layerId : null; selectedIndex = selectedClip? selectedClip._clipIndex : -1;
  const inspector = document.getElementById('inspector');
  // Build richer inspector UI
  const type = selectedClip.type;
  const src = selectedClip.src || '';
  const durationVal = selectedClip.duration || '';
  inspector.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Type:</strong> ${type}</div>
      <div><strong>Src:</strong> <a href="${src}" target="_blank" style="color:#9fd2ff">${src}</a></div>
      <div>
        <label style="display:flex;gap:8px;align-items:center"><strong>Duration(s):</strong>
          <input id="clipDur" type="number" value="${durationVal||2}" min="0.1" step="0.1" style="margin-left:8px;padding:6px;border-radius:6px;background:transparent;border:1px solid rgba(255,255,255,0.06);color:#dff3ff;" />
        </label>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="insUpdate">Update</button>
        <button class="btn secondary" id="insRemove">Remove</button>
        <button class="btn secondary" id="insPlay">Play Clip</button>
      </div>
    </div>
  `;

  document.getElementById('insUpdate').addEventListener('click', () => updateClipDuration(idx));
  document.getElementById('insRemove').addEventListener('click', () => { removeClip(idx); });
  document.getElementById('insPlay').addEventListener('click', async () => { if (typeof drawFrame === 'function'){ playhead = timeline[idx].startTime || 0; drawFrame(playhead); } });
}

function updateClipDuration(idx) {
  const v = parseFloat(document.getElementById('clipDur').value || '2');
  const item = timeline[idx];
  if (item && item._layerId != null && typeof item._clipIndex === 'number'){
    const layer = layers.find(l=>l.id===item._layerId);
    if (layer && layer.clips && layer.clips[item._clipIndex]){
      layer.clips[item._clipIndex].duration = v;
      recomputeLayerTimings(layer);
    }
  } else {
    timeline[idx].duration = v;
  }
  timeline = flattenLayersToTimeline();
  renderTimeline();
  scheduleAutosave();
}

// Old onPreviewTimeline (video element) removed; canvas engine is used instead

function stopPreview(){ isPlaying = false; if (rafId){ cancelAnimationFrame(rafId); rafId = null; } }

function drawImageToCanvas(src, ctx, canvas, skipClear=false) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!skipClear) {
        ctx.clearRect(0,0,canvas.width,canvas.height);
      }
      // Fit image to canvas preserving aspect ratio (cover)
      const { sx, sy, sw, sh, dx, dy, dw, dh } = computeCoverFit(img.width, img.height, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      res();
    };
    img.onerror = rej;
    img.src = src;
  });
}

function computeCoverFit(srcW, srcH, dstW, dstH){
  const srcAR = srcW / srcH;
  const dstAR = dstW / dstH;
  let sw, sh, sx, sy;
  if (srcAR > dstAR){
    // source is wider: crop width
    sh = srcH;
    sw = sh * dstAR;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    // source is taller: crop height
    sw = srcW;
    sh = sw / dstAR;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  return { sx, sy, sw, sh, dx: 0, dy: 0, dw: dstW, dh: dstH };
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function playTimelineSequence(){ onPreviewTimeline(); }

function extractAudioDuration(clip){
  return new Promise((resolve) => {
    // Normalize clip.src: it might be an object, blob, or string
    try {
      let src = clip && clip.src;
      // If no src, but meta contains an audio payload (base64/blob/url), try to derive one
      if (!src && clip && clip.meta){
        const m = clip.meta;
        if (m.url) src = m.url;
        else if (m.audio) src = m.audio;
        else if (m.src) src = m.src;
        else if (m.filename) src = '/uploads/' + m.filename;
        else if (m.base64 && typeof m.base64 === 'string') {
          // default to WAV unless meta suggests otherwise
          const mimeGuess = (m.mime || m.mimetype || '').toLowerCase().includes('mp3') ? 'audio/mpeg' : 'audio/wav';
          src = `data:${mimeGuess};base64,` + m.base64.replace(/\s+/g,'');
        }
        else if (m.audioBlob && (m.audioBlob instanceof Blob || m.audioBlob instanceof File)){
          try{ src = URL.createObjectURL(m.audioBlob); }catch(e){ src = null; }
        }
      }
      if (!src) { resolve(0); return; }
      // If src is a Blob (rare), create an object URL
      if (src instanceof Blob) {
        src = URL.createObjectURL(src);
      } else if (typeof src === 'string') {
        // If the string appears to be serialized JSON, try to parse it and extract a usable field
        const maybeJson = src.trim();
        if ((maybeJson.startsWith('{') && maybeJson.endsWith('}')) || (maybeJson.startsWith('[') && maybeJson.endsWith(']'))){
          try{
            const parsed = JSON.parse(maybeJson);
            // Common patterns: { audioBlob: { url: '...'} } or { audio: 'url' } or { url: '...' }
            if (parsed && typeof parsed === 'object'){
              if (parsed.audioBlob && typeof parsed.audioBlob === 'string'){
                src = parsed.audioBlob;
              } else if (parsed.audioBlob && typeof parsed.audioBlob === 'object'){
                // prefer url/name/data
                src = parsed.audioBlob.url || parsed.audioBlob.name || parsed.audioBlob.filename || parsed.audioBlob.file || parsed.audioBlob.data || parsed.audioBlob.base64 || src;
                // If we got raw base64 without data: prefix a default audio mime so Audio can load it
                if (typeof src === 'string' && !src.startsWith('data:') && src.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(src)){
                  // default to WAV
                  src = 'data:audio/wav;base64,' + src.replace(/\s+/g, '');
                }
              } else if (parsed.audio) {
                src = parsed.audio;
              } else if (parsed.url) {
                src = parsed.url;
              } else if (parsed.src) {
                src = parsed.src;
              } else {
                // Nothing usable found in parsed object
                console.warn('extractAudioDuration: parsed src object has no usable url/file field', parsed);
                resolve(0);
                return;
              }
            }
          }catch(err){
            // not JSON or parse failed; fall back to string src
          }
        }
      } else if (typeof src !== 'string') {
        // try normalizeSrc to pull a usable URL string
        try { src = normalizeSrc(src); } catch (e) { src = String(src); }
      }

  const a = new Audio();
      a.preload = 'metadata';
      // allow cross-origin audio metadata if server allows it
      try { a.crossOrigin = 'anonymous'; } catch (e) {}

  let settled = false;
      const cleanup = () => {
        try { a.removeEventListener('loadedmetadata', onLoaded); a.removeEventListener('error', onError); } catch (e) {}
        if (timeout) { clearTimeout(timeout); timeout = null; }
        try { a.src = ''; } catch (e) {}
      };

      const onLoaded = () => {
        if (settled) return; settled = true;
        const d = a.duration || 0; cleanup(); resolve(Number(d.toFixed(3)));
      };
      const onError = (e) => {
        if (settled) return; settled = true;
        console.warn('Audio load error for duration', { src, err: e }); cleanup(); resolve(0);
      };

  a.addEventListener('loadedmetadata', onLoaded);
  a.addEventListener('error', onError);
      // timeout fallback in case metadata never arrives
      let timeout = setTimeout(() => {
        if (settled) return; settled = true; console.warn('Audio duration timeout for', src); cleanup(); resolve(0);
      }, 8000);

      // set src after listeners attached
      a.src = src;
      // In some browsers the metadata may already be available synchronously; guard for that
      if (a.readyState >= 1 && !settled) {
        onLoaded();
      }
    } catch (e) {
      console.warn('extractAudioDuration unexpected error', e, clip);
      resolve(0);
    }
  });
}

function recomputeLayerTimings(layer){
  // sequential layout per layer: startTime accumulates durations
  let t = 0;
  layer.clips.forEach(c => {
    c.startTime = t;
    const dur = (c.duration != null) ? Number(c.duration) : (c.type === 'image' ? 2 : 0);
    t += dur || 0;
  });
  updateTotalDuration();
}

function updateTotalDuration(){
  let total = 0;
  layers.forEach(l=>{
    const end = l.clips.reduce((acc,c)=> Math.max(acc, (c.startTime || 0) + ((c.duration!=null)? Number(c.duration): (c.type==='image'?2:0)) ), 0);
    total = Math.max(total, end);
  });
  // If background exists, ensure its first clip covers total duration
  const bg = layers.find(l=> isBackgroundLayer(l));
  if (bg && bg.clips && bg.clips[0]){
    bg.clips[0].duration = Math.max(bg.clips[0].duration || 0, total || 10);
    bg.clips[0].startTime = 0;
  }
  const header = document.querySelector('.timeline-header'); if (!header) return;
  let el = document.getElementById('totalDuration');
  if (!el){ el = document.createElement('div'); el.id='totalDuration'; el.style.marginLeft='12px'; el.style.fontWeight='600'; header.appendChild(el); }
  el.textContent = 'Total: ' + formatTime(total);
}

function formatTime(sec){ if (!sec) return '0s'; const s = Math.floor(sec%60); const m = Math.floor(sec/60%60); const h = Math.floor(sec/3600); if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; if (m>0) return `${m}:${String(s).padStart(2,'0')}`; return `${s}s`; }


function normalizeSrc(v){
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object'){
    if (typeof v.url === 'string') return v.url;
    if (typeof v.audio === 'string') return v.audio;
    if (typeof v.src === 'string') return v.src;
    if (typeof v.filename === 'string') return '/uploads/'+v.filename;
    // try to find any plausible string property
    for (const k of Object.keys(v)){
      if (typeof v[k] === 'string'){
        const s = v[k];
        if (s.startsWith('http') || s.startsWith('/') || s.endsWith('.mp3') || s.endsWith('.wav') || s.endsWith('.ogg') || s.endsWith('.webm')) return s;
      }
    }
    // If we couldn't extract a usable string URL, return empty string (avoid returning a JSON blob string)
    return '';
  }
  return String(v);
}

function getPlayableSrc(raw){
  if (!raw) return null;
  // Blob -> object URL
  if (raw instanceof Blob) return URL.createObjectURL(raw);
  let s = raw;
  if (typeof raw !== 'string') {
    try { s = normalizeSrc(raw); } catch(e){ s = String(raw); }
  }
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  // If we've pre-fetched this to a Blob URL, prefer that immediately
  try{ if (audioObjectUrlMap[t]) return audioObjectUrlMap[t].url; }catch(_e){}
  // If it looks like JSON, try to parse and extract fields
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))){
    try{
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object'){
        if (parsed.audio && typeof parsed.audio === 'string') s = parsed.audio;
        else if (parsed.url && typeof parsed.url === 'string') s = parsed.url;
        else if (parsed.src && typeof parsed.src === 'string') s = parsed.src;
        else if (parsed.audioBlob){
          if (typeof parsed.audioBlob === 'string') s = parsed.audioBlob;
          else if (typeof parsed.audioBlob === 'object') s = parsed.audioBlob.url || parsed.audioBlob.filename || parsed.audioBlob.base64 || parsed.audioBlob.data || s;
        }
      }
    }catch(e){ /* not JSON */ }
  }
  // data URI / blob / http / absolute path
  if (s.startsWith('data:audio') || s.startsWith('blob:') || s.startsWith('http') || s.startsWith('/')) return s;
  // Raw base64 detection (length heuristic + base64 char set)
  if (s.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(s)) return 'data:audio/wav;base64,' + s.replace(/\s+/g, '');
  return null;
}

function sanitizeAudioMeta(meta){
  if (!meta || typeof meta !== 'object') return null;
  // Preserve only lightweight fields; drop audioBlob/base64/data to keep autosave fast
  const out = {};
  if (typeof meta.url === 'string') out.url = meta.url;
  if (typeof meta.filename === 'string') out.filename = meta.filename;
  if (typeof meta.src === 'string') out.src = meta.src;
  if (typeof meta.audio === 'string') out.audio = meta.audio;
  // Do not include meta.base64, meta.audioBlob, meta.data, etc.
  return Object.keys(out).length ? out : null;
}

async function onExport(){
  // POST timeline to backend render endpoint
  const exportBtn = document.getElementById('exportBtnHeader') || document.getElementById('exportBtn') || document.getElementById('exportBtnTop');
  if (exportBtn) exportBtn.disabled = true;
  const oldText = exportBtn ? exportBtn.textContent : 'Rendering...';
  if (exportBtn) exportBtn.textContent = 'Rendering...';
  isExporting = true;
  const t0 = performance.now();

  try {
    const project = window.projectData || {};
    const sel = document.getElementById('resolutionSelect') || document.getElementById('resolutionSelectFooter');
    const res = sel ? parseInt(sel.value, 10) : 480;
    const jobId = `render-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    try { window.__renderJobId = jobId; } catch(e){}

    // Build export timeline with normalized src
    const exportTimeline = flattenLayersToTimeline().map((c)=>{
      const copy = Object.assign({}, c);
      copy.src = normalizeSrc(copy.src || copy.audio || copy.url || copy.file || copy);
      if (copy.duration != null) copy.duration = Number(copy.duration);
      // pass layer z-order and background info to backend
      copy._layerIndex = c._layerIndex;
      copy._isBackground = !!c._isBackground;
      return copy;
    });

    // Find clips that need uploading (audio with data/blobs or no usable URL src)
    const toUpload = [];
    for (let i=0;i<exportTimeline.length;i++){
      const c = exportTimeline[i];
      if (c.type === 'audio'){
        const srcStr = typeof c.src === 'string' ? c.src : '';
        const needsUpload = !srcStr || srcStr.startsWith('data:') || srcStr.startsWith('blob:');
        if (needsUpload && c.meta){
          let fileToUpload = null;
          if (c.meta.audioBlob && (c.meta.audioBlob instanceof File || c.meta.audioBlob instanceof Blob)) fileToUpload = c.meta.audioBlob;
          if (!fileToUpload && c.meta.base64){
            try{
              const bin = atob(c.meta.base64.replace(/\s+/g,''));
              const len = bin.length; const arr = new Uint8Array(len);
              for (let j=0;j<len;j++) arr[j]=bin.charCodeAt(j);
              // Decide mime and extension from meta
              const lower = String(c.meta.mime || c.meta.mimetype || c.meta.filename || '').toLowerCase();
              const isMp3 = lower.includes('.mp3') || lower.includes('mpeg');
              const mime = isMp3 ? 'audio/mpeg' : 'audio/wav';
              const ext = isMp3 ? 'mp3' : 'wav';
              fileToUpload = new File([arr], `audio-${Date.now()}.${ext}`, { type: mime });
            }catch(e){ fileToUpload = null; }
          }
          if (fileToUpload) toUpload.push({ idx: i, file: fileToUpload });
        }
      }
    }

    // Upload pending files sequentially (small count expected); update timeline srcs on success
    for (const item of toUpload){
      try{
        const fd = new FormData();
        fd.append('files', item.file, item.file.name || (`audio-${Date.now()}.mp3`));
        const upResp = await fetch('/upload', { method: 'POST', body: fd });
        if (!upResp.ok){ console.warn('Upload failed for inline audio', await upResp.text()); continue; }
        const j = await upResp.json();
        // server returns { filenames: [...] }
        const fn = (j && (j.filenames && j.filenames[0])) || j && j.filename || null;
        if (fn){
          exportTimeline[item.idx].src = `/uploads/${fn}`;
        } else {
          console.warn('Upload returned no filename for inline audio', j);
        }
      }catch(e){ console.warn('Inline audio upload error', e); }
    }

    // Now POST the final payload to render endpoint
  const payload = { project_id: project.id, timeline: exportTimeline, resolution: res, downloadMode: 'link', return_url: true, job_id: jobId };
    let resp;
    try {
      resp = await fetch('/api/video/render', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    } catch (netErr) {
      console.error('Network error during export:', netErr);
      alert('Network error: failed to reach the server. See console for details.');
      return;
    }

  if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (e) { text = '<unreadable response>'; }
      console.error('Render failed', resp.status, text);
      try { const j = JSON.parse(text); alert('Render failed: ' + (j.detail || j.error || JSON.stringify(j))); } catch (e) { alert('Render failed: ' + text.slice(0, 200)); }
      return;
    }

    // Try to read JSON (link mode) first; fall back to blob download
    let didDownload = false;
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')){
      try {
        const j = await resp.json();
        if (j && j.url){
          // Immediately restore button state; download proceeds independently
          if (exportBtn) { exportBtn.disabled = false; exportBtn.textContent = oldText; }
          // Open in new tab or trigger download
          const a = document.createElement('a'); a.href = j.url; a.download = j.filename || `project-${project.id}-export.mp4`; a.click();
          try { alert(`Render ready in ${((performance.now()-t0)/1000).toFixed(1)}s`); } catch(e){}
          didDownload = true;
        }
      } catch (e) {
        console.warn('JSON parse failed, falling back to blob', e);
      }
    }
    if (!didDownload){
      try {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `project-${project.id}-export.mp4`; a.click();
        try { alert(`Render ready in ${((performance.now()-t0)/1000).toFixed(1)}s`); } catch(e){}
        didDownload = true;
      } catch (e) {
        console.error('Failed to read response blob', e);
        alert('Download failed: ' + e.message);
      }
    }

  } finally {
    // If we already restored button state on JSON path, this is a no-op
    if (exportBtn) { exportBtn.disabled = false; exportBtn.textContent = oldText; }
    isExporting = false;
  }
}

// ------------------ BACKGROUND LAYER HELPERS ------------------
function isBackgroundLayer(layer){ return layer && layer.id === BACKGROUND_LAYER_ID; }

function ensureBackgroundLayer(createClip){
  // Place background layer at index 0
  let bgIdx = layers.findIndex(l=> l.id === BACKGROUND_LAYER_ID);
  if (bgIdx === -1){
    const bgLayer = { id: BACKGROUND_LAYER_ID, name: 'Background', clips: [] };
    layers.unshift(bgLayer);
    activeLayerId = activeLayerId || bgLayer.id;
    bgIdx = 0;
  } else if (bgIdx !== 0){
    // Move it to the bottom (index 0)
    const [bg] = layers.splice(bgIdx,1);
    layers.unshift(bg);
  }
  if (createClip){
    const bgLayer = layers[0];
    // Single clip covering at least the current total timeline duration or default 10s
    const total = Math.max(10, computeTotalDuration());
    if (bgLayer.clips.length === 0){
      bgLayer.clips.push({ type:'image', id:'bg', src: DEFAULT_BG_SRC, duration: total, startTime: 0 });
    } else {
      // update duration to cover total
      bgLayer.clips[0].src = DEFAULT_BG_SRC;
      bgLayer.clips[0].duration = total;
      bgLayer.clips[0].startTime = 0;
    }
  }
  timeline = flattenLayersToTimeline();
}

function computeTotalDuration(){
  let total = 0;
  layers.forEach(l=>{ l.clips.forEach(c=>{ const d = (c.duration!=null)? Number(c.duration) : (c.type==='image'?2:0); total = Math.max(total, (c.startTime||0)+d); }); });
  return total;
}

// Add debugging to track page loading state
window.addEventListener('load', () => {
  DBG('Window load event fired - page should be fully loaded now');
  DBG('Current readyState:', document.readyState);
});

// Track readyState changes
document.addEventListener('readystatechange', () => {
  DBG('Document readyState changed to:', document.readyState);
});

// Monitor for ongoing network requests that might keep the page loading
let originalFetch = window.fetch;
let activeRequests = new Set();
window.fetch = function(...args) {
  const url = args[0];
  DBG('Fetch started:', url);
  activeRequests.add(url);
  return originalFetch.apply(this, args).then(response => {
    DBG('Fetch completed:', url, response.status);
    activeRequests.delete(url);
    if (activeRequests.size === 0) {
      DBG('All fetch requests completed - active requests:', activeRequests.size);
    }
    return response;
  }).catch(error => {
    DBG('Fetch error:', url, error);
    activeRequests.delete(url);
    throw error;
  });
};

// Check for ongoing operations periodically
window.pageMonitorInterval = setInterval(() => {
  if (document.readyState !== 'complete') {
    DBG('Page still loading - readyState:', document.readyState, 'Active requests:', activeRequests.size);
    if (activeRequests.size > 0) {
      DBG('Active fetch requests:', Array.from(activeRequests));
    }
  } else {
    // Page is complete, stop monitoring
    DBG('Page completed, stopping monitor interval');
    clearInterval(pageMonitorInterval);
  }
}, 2000);

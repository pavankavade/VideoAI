// Basic video editor client logic
// Layered timeline model: layers is array of {id, name, clips: []}
let timeline = []; // legacy flat timeline kept for compatibility but UI shows layers
let layers = [ { id: 'layer-1', name: 'Layer 1', clips: [] } ];
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
let autosaveTimer = null;
let autosavePending = false;

document.addEventListener('DOMContentLoaded', () => {
  const data = window.projectData || {};
  const project = data;
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
    el.innerHTML = `<img src="${url}" alt="${p.filename}"/><div class="meta">${p.filename}</div>`;
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
    // prefer explicit fields
    if (meta && typeof meta === 'object'){
      srcCandidate = meta.url || meta.audio || meta.src || meta.filename || meta.file || null;
      // If meta contains raw base64 or data, try to build a data URI
      if (!srcCandidate && meta.base64 && typeof meta.base64 === 'string'){
        srcCandidate = 'data:audio/mpeg;base64,' + meta.base64.replace(/\s+/g,'');
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
            else if (t.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(t)) srcCandidate = 'data:audio/mpeg;base64,' + t.replace(/\s+/g,'');
          } else if (typeof ab === 'object'){
            // try common fields
            if (ab.url && typeof ab.url === 'string') srcCandidate = ab.url;
            else if (ab.filename && typeof ab.filename === 'string') srcCandidate = '/uploads/' + ab.filename;
            else if (ab.base64 && typeof ab.base64 === 'string') srcCandidate = 'data:audio/mpeg;base64,' + ab.base64.replace(/\s+/g,'');
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
        finalPlayable = 'data:audio/mpeg;base64,' + ab.base64.replace(/\s+/g,'');
      }
      // If audioBlob contains raw numeric array in 'data' or 'bytes'
      if (!finalPlayable && ab && Array.isArray(ab.data) && ab.data.length>0){
        const arr = new Uint8Array(ab.data);
        const blob = new Blob([arr], { type: 'audio/mpeg' });
        finalPlayable = URL.createObjectURL(blob);
      }
      if (!finalPlayable && ab && Array.isArray(ab.bytes) && ab.bytes.length>0){
        const arr = new Uint8Array(ab.bytes);
        const blob = new Blob([arr], { type: 'audio/mpeg' });
        finalPlayable = URL.createObjectURL(blob);
      }
      // If audioBlob has .data.buffer-like structure
      if (!finalPlayable && ab && ab.data && ab.data.data && Array.isArray(ab.data.data)){
        const arr = new Uint8Array(ab.data.data);
        const blob = new Blob([arr], { type: 'audio/mpeg' });
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
            const blob = new Blob([arr], { type: 'audio/mpeg' });
            finalPlayable = URL.createObjectURL(blob);
          }
        }catch(e){ console.warn('[audio-load] blob-like fallback error', e); }
      }
    }catch(e){ console.warn('[audio-load] error inspecting audioBlob', e); }
  }
    // store playable (or empty) but keep original meta for later upload/inspection
  audios.push({id, src: finalPlayable || '', filename: `audio-${i}.mp3`, meta});
    const el = document.createElement('div');
    el.className = 'asset-item';
    el.draggable = true;
    el.dataset.id = id;
    el.dataset.type = 'audio';
    el.innerHTML = `<div style="width:48px; height:48px; background:#111; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#fff;">♪</div><div class="meta">${id}</div>`;
    el.addEventListener('dragstart', onDragStartAsset);
    if (audioList) audioList.appendChild(el);
  });

  document.getElementById('audioFileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // Upload to server uploads/ and add to audio list
    const fd = new FormData();
    fd.append('file', f);
    const resp = await fetch('/upload', {method:'POST', body: fd});
    const dataResp = await resp.json();
      if (dataResp.filename) {
      const src = `/uploads/${dataResp.filename}`;
      const id = `audio-upload-${Date.now()}`;
        audios.push({id, src, filename: dataResp.filename, meta: { uploaded: true }});
      const el = document.createElement('div');
      el.className = 'asset-item'; el.draggable = true; el.dataset.id = id; el.dataset.type = 'audio';
      el.innerHTML = `<div style="width:48px; height:48px; background:#111; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#fff;">♪</div><div class="meta">${dataResp.filename}</div>`;
      el.addEventListener('dragstart', onDragStartAsset);
      audioList.appendChild(el);
    }
  });

  document.getElementById('exportBtn').addEventListener('click', onExport);
  document.getElementById('previewTimelineBtn').addEventListener('click', onPreviewTimeline);
  document.getElementById('clearTimeline').addEventListener('click', () => { layers.forEach(l=> l.clips = []); timeline = []; renderTimeline(); });
  document.getElementById('playTimeline').addEventListener('click', playTimelineSequence);
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

  renderTimeline();
  renderLayerControls();
  renderRuler();

  // Recompute timeline layout on window resize so min width follows the visible viewport width
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(()=>{ try{ renderTimeline(); renderRuler(); }catch(e){} }, 120);
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
  const layer = layers.find(l => l.id === activeLayerId) || layers[0];
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
    const removeBtn = document.createElement('button'); removeBtn.className = 'btn secondary'; removeBtn.textContent = 'Remove Layer';
    removeBtn.addEventListener('click', ()=>{ removeLayer(layer.id); });
    header.appendChild(addBtn); header.appendChild(removeBtn);
    const container = document.createElement('div'); container.style.display='flex'; container.style.flexDirection='column'; container.appendChild(header);

  const clipsContainer = document.createElement('div'); clipsContainer.className = 'layer-clips'; clipsContainer.style.position='relative'; clipsContainer.style.minHeight='84px'; clipsContainer.dataset.layerId = layer.id;
    // allow dropping directly onto a layer
    clipsContainer.ondragover = (ev)=> ev.preventDefault();
    clipsContainer.ondrop = (ev)=> { ev.stopPropagation(); onDropToLayer(ev, layer.id); };

    layer.clips.forEach((clip, idx) => {
      const el = document.createElement('div');
      el.className = 'clip';
      el.dataset.idx = idx; el.dataset.layerId = layer.id; el.draggable = false;
      // render content and include a resize handle at the right edge
      if (clip.type === 'image') {
        el.innerHTML = `<img src="${clip.src}" alt="clip-${idx}"/><div class="info"><div style=\"font-weight:700\">Image</div><div class=\"small\">${clip.id || ''}</div></div><div class="duration-badge">${(clip.duration||2).toFixed(1)}s</div><div class="start-badge">${formatTime(clip.startTime||0)}</div><div class="remove" title="Remove">✕</div><div class="clip-handle" title="Resize"></div>`;
      } else {
        el.innerHTML = `<div style=\"width:88px;height:68px;background:#071226;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#9fc0ff\">AUD</div><div class=\"info\"><div style=\"font-weight:700\">Audio</div><div class=\"small\">${clip.id || ''}</div></div><div class=\"duration-badge\">${clip.duration? (clip.duration.toFixed(1)+"s") : '—'}</div><div class=\"start-badge\">${formatTime(clip.startTime||0)}</div><div class=\"remove\" title=\"Remove\">✕</div><div class=\"clip-handle\" title=\"Resize\"></div>`;
      }
      // position clip by startTime and width by duration
      const st = clip.startTime || 0; const dur = (clip.duration != null)? Number(clip.duration) : (clip.type==='image'?2:0);
  // Use viewPxPerSec for rendering so the DOM widths remain reasonable when clamped
  el.style.left = (st * viewPxPerSec) + 'px'; el.style.width = Math.max(88, dur * viewPxPerSec) + 'px';
      // enable horizontal dragging to reposition startTime
      el.addEventListener('mousedown', onClipDragStart);
      el.addEventListener('touchstart', onClipDragStart, {passive:false});
      // attach resize handle listeners
      const handle = el.querySelector('.clip-handle');
      if (handle){ handle.addEventListener('mousedown', onClipResizeStart); handle.addEventListener('touchstart', onClipResizeStart, {passive:false}); }
      el.addEventListener('click', ()=> selectLayerClip(layer.id, idx));
      // Prevent remove control from triggering clip drag: intercept mousedown/touchstart
      const removeBtns = el.querySelectorAll('.remove');
      removeBtns.forEach(btn => {
        btn.addEventListener('mousedown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); });
        btn.addEventListener('touchstart', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); removeClipFromLayer(layer.id, idx); }, {passive:false});
        // keep click as fallback
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); removeClipFromLayer(layer.id, idx); });
      });
      clipsContainer.appendChild(el);
    });

    container.appendChild(clipsContainer);
    layerRoot.appendChild(container);
    track.appendChild(layerRoot);
  });
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
  autosavePending = true;
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = 'Pending...';
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(()=>{ saveProject(false); }, 2000);
}

async function saveProject(force=false){
  if (!autosavePending && !force) return;
  const autosaveEl = document.getElementById('autosaveStatus'); if (autosaveEl) autosaveEl.textContent = 'Saving...';
  try{
    const project = window.projectData || {};
    const payload = { project_id: project.id, layers };
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
    const resp = await fetch(src); const ab = await resp.arrayBuffer(); const decoded = await ctx.decodeAudioData(ab); audioBufferCache[src] = decoded; return decoded;
  }catch(e){ console.warn('AudioBuffer fetch/decoding failed for', src, e); return null; }
}

async function onPreviewTimeline(){
  stopPreview();
  const videoEl = document.getElementById('previewVideo');
  const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 720; const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30); videoEl.srcObject = stream; videoEl.play();
  const allClips = flattenLayersToTimeline();
  const total = Math.max(...allClips.map(c=> (c.startTime||0) + ((c.duration!=null)? Number(c.duration): (c.type==='image'?2:0))), 0);
  previewControllers = [];
  // Try WebAudio scheduling for audio clips
  const actx = await ensureAudioContext();
  const startAt = actx ? actx.currentTime + 0.1 : performance.now();
  for (const clip of allClips){
    const st = clip.startTime || 0; const dur = (clip.duration!=null)? Number(clip.duration) : (clip.type==='image'?2:0);
    if (clip.type === 'audio'){
      if (actx){
        const buf = await fetchAudioBuffer(clip.src);
        if (buf){
          const srcNode = actx.createBufferSource(); srcNode.buffer = buf; srcNode.connect(actx.destination);
          srcNode.start(startAt + st);
          previewControllers.push({type:'webaudio', node: srcNode});
        } else {
          // fallback to HTMLAudio timed by setTimeout (only if playable)
          const playable = getPlayableSrc(clip.src);
          if (playable){ const audio = new Audio(playable); audio.preload='auto'; const to = setTimeout(()=>{ audio.play().catch(()=>{}); }, st*1000); previewControllers.push({type:'audio', audio, timeout: to}); } else { console.warn('Preview fallback: audio clip not playable, skipping', clip); }
        }
      } else {
        const playable = getPlayableSrc(clip.src);
        if (playable){ const audio = new Audio(playable); audio.preload='auto'; const to = setTimeout(()=>{ audio.play().catch(()=>{}); }, st*1000); previewControllers.push({type:'audio', audio, timeout: to}); } else { console.warn('Preview no-audio: skipping clip (no playable src)', clip); }
      }
    } else if (clip.type === 'image'){
      // schedule draw
      const to = setTimeout(async ()=>{ try{ await drawImageToCanvas(clip.src, ctx, canvas); }catch(e){} }, st*1000);
      previewControllers.push({type:'image', timeout: to});
    }
  }
  // finish
  const finishTimeout = setTimeout(()=>{ stopPreview(); }, Math.max(1000, (total*1000)+200)); previewControllers.push({type:'finish', timeout: finishTimeout});
}


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
  // reuse inspector UI but need to map update/remove to layer
  const inspector = document.getElementById('inspector');
  const type = selectedClip.type; const src = selectedClip.src || ''; const durationVal = selectedClip.duration || '';
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
  document.getElementById('insUpdate').addEventListener('click', ()=>{
    const v = parseFloat(document.getElementById('clipDur').value || '2');
    selectedClip.duration = v; timeline = flattenLayersToTimeline(); renderTimeline(); recomputeLayerTimings(layers.find(ld=> ld.id === activeLayerId) || layers[0]); scheduleAutosave();
  });
  document.getElementById('insRemove').addEventListener('click', ()=>{ const li = layer.clips.indexOf(selectedClip); if (li>=0) { layer.clips.splice(li,1); recomputeLayerTimings(layer); timeline=flattenLayersToTimeline(); renderTimeline(); scheduleAutosave(); } });
  document.getElementById('insPlay').addEventListener('click', async ()=>{
    if (type==='image'){ const videoEl = document.getElementById('previewVideo'); const canvas = document.createElement('canvas'); canvas.width=720; canvas.height=720; const ctx = canvas.getContext('2d'); await drawImageToCanvas(src, ctx, canvas); const stream = canvas.captureStream(30); videoEl.srcObject = stream; videoEl.play(); setTimeout(()=>{ try{ videoEl.pause(); videoEl.srcObject=null;}catch(e){} }, (selectedClip.duration||2)*1000); } else { const playable = getPlayableSrc(src); if (playable){ const a = new Audio(playable); a.play().catch(()=>{}); } else { console.warn('Inspector play: no playable src for clip', selectedClip); } }
  });
}

function removeClipFromLayer(layerId, idx){
  const layer = layers.find(l=>l.id===layerId); if (!layer) return; layer.clips.splice(idx,1); timeline = flattenLayersToTimeline(); renderTimeline(); scheduleAutosave();
}

function flattenLayersToTimeline(){
  // simple flatten by concatenating layers in order (layer 0 first).
  // Include mapping metadata so flat timeline items can be traced back to their layer/clip index.
  const out = [];
  layers.forEach((l, li) => { l.clips.forEach((c, ci) => out.push(Object.assign({}, c, { _layerId: l.id, _clipIndex: ci }))); });
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
  const add = document.createElement('button'); add.className='btn'; add.textContent='Add Layer'; add.addEventListener('click', addLayer);
  const select = document.createElement('select'); select.style.padding='6px'; select.style.borderRadius='6px'; layers.forEach(l=>{ const o = document.createElement('option'); o.value=l.id; o.textContent=l.name; if (l.id===activeLayerId) o.selected=true; select.appendChild(o); }); select.addEventListener('change', (e)=>{ activeLayerId = e.target.value; renderTimeline(); });
  ctr.appendChild(select); ctr.appendChild(add);
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
  document.getElementById('insPlay').addEventListener('click', async () => {
    if (type === 'image') {
      // show image for the clip duration in preview canvas
      const videoEl = document.getElementById('previewVideo');
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 720; const ctx = canvas.getContext('2d');
      await drawImageToCanvas(src, ctx, canvas);
      const stream = canvas.captureStream(30);
      videoEl.srcObject = stream;
      videoEl.play();
      setTimeout(()=>{ try{ videoEl.pause(); videoEl.srcObject = null;}catch(e){} }, (timeline[idx].duration||2)*1000);
    } else {
      const playable = getPlayableSrc(src);
      if (playable){ const a = new Audio(playable); a.play().catch(()=>{}); } else { console.warn('selectClip play: no playable src', selectedClip); }
    }
  });
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

async function onPreviewTimeline() {
  stopPreview();
  const videoEl = document.getElementById('previewVideo');
  const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 720; const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30); videoEl.srcObject = stream; videoEl.play();
  // schedule all clips by their startTime across layers
  const allClips = flattenLayersToTimeline();
  const total = Math.max(...allClips.map(c=> (c.startTime||0) + ((c.duration!=null)? Number(c.duration): (c.type==='image'?2:0))), 0);
  const startTime = performance.now();
  previewControllers = [];
  // schedule images: draw the appropriate image for the current time (supports overlapping by last-written wins)
  allClips.forEach((clip)=>{
    const stMs = (clip.startTime || 0) * 1000;
    const durMs = ((clip.duration!=null)? Number(clip.duration) : (clip.type==='image'?2:0)) * 1000;
    if (clip.type === 'audio'){
      // schedule audio playback at offset relative to now
      const audio = new Audio(clip.src); audio.preload='auto';
      const to = setTimeout(()=>{ audio.play().catch(()=>{}); }, stMs);
      previewControllers.push({type:'audio', audio, timeout:to});
    } else if (clip.type === 'image'){
      // schedule draw start
      const drawStart = setTimeout(async ()=>{ try{ await drawImageToCanvas(clip.src, ctx, canvas); }catch(e){} }, stMs);
      // schedule clear after duration (or overwrite by next image)
      const drawEnd = setTimeout(()=>{}, stMs + durMs);
      previewControllers.push({type:'image', start:drawStart, end:drawEnd});
    }
  });
  // ensure cleanup after total
  const finishTimeout = setTimeout(()=>{ stopPreview(); }, Math.max(1000, (total*1000)+100));
  previewControllers.push({type:'finish', timeout: finishTimeout});
}

function stopPreview(){
  try{
    previewControllers.forEach(c=>{
      if (c.timeout) clearTimeout(c.timeout);
      if (c.start) clearTimeout(c.start);
      if (c.end) clearTimeout(c.end);
      if (c.audio) try{ c.audio.pause(); c.audio.src = ''; }catch(e){}
    });
  }catch(e){}
  previewControllers = [];
  const videoEl = document.getElementById('previewVideo'); if (videoEl){ try{ videoEl.pause(); videoEl.srcObject = null; }catch(e){} }
}

function drawImageToCanvas(src, ctx, canvas) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height); res(); };
    img.onerror = rej;
    img.src = src;
  });
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
        else if (m.base64 && typeof m.base64 === 'string') src = 'data:audio/mpeg;base64,' + m.base64.replace(/\s+/g,'');
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
                  src = 'data:audio/mpeg;base64,' + src.replace(/\s+/g, '');
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
  if (s.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(s)) return 'data:audio/mpeg;base64,' + s.replace(/\s+/g, '');
  return null;
}

async function onExport(){
  // POST timeline to backend render endpoint
  const exportBtn = document.getElementById('exportBtnHeader') || document.getElementById('exportBtn') || document.getElementById('exportBtnTop');
  if (exportBtn) exportBtn.disabled = true;
  const oldText = exportBtn ? exportBtn.textContent : 'Rendering...';
  if (exportBtn) exportBtn.textContent = 'Rendering...';

  try {
    const project = window.projectData || {};
    const sel = document.getElementById('resolutionSelect') || document.getElementById('resolutionSelectFooter');
    const res = sel ? parseInt(sel.value, 10) : 480;

    // Build export timeline with normalized src
    const exportTimeline = flattenLayersToTimeline().map((c)=>{
      const copy = Object.assign({}, c);
      copy.src = normalizeSrc(copy.src || copy.audio || copy.url || copy.file || copy);
      if (copy.duration != null) copy.duration = Number(copy.duration);
      return copy;
    });

    // Find clips that need uploading (audio with no usable src but have meta with base64/blob)
    const toUpload = [];
    for (let i=0;i<exportTimeline.length;i++){
      const c = exportTimeline[i];
      if ((!c.src || c.src==='') && c.type === 'audio' && c.meta){
        let fileToUpload = null;
        if (c.meta.audioBlob && (c.meta.audioBlob instanceof File || c.meta.audioBlob instanceof Blob)) fileToUpload = c.meta.audioBlob;
        if (!fileToUpload && c.meta.base64){
          try{
            const bin = atob(c.meta.base64.replace(/\s+/g,''));
            const len = bin.length; const arr = new Uint8Array(len);
            for (let j=0;j<len;j++) arr[j]=bin.charCodeAt(j);
            fileToUpload = new File([arr], `audio-${Date.now()}.mp3`, { type: 'audio/mpeg' });
          }catch(e){ fileToUpload = null; }
        }
        if (fileToUpload) toUpload.push({ idx: i, file: fileToUpload });
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
    const payload = { project_id: project.id, timeline: exportTimeline, resolution: res };
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

    try {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `project-${project.id}-export.mp4`; a.click();
    } catch (e) {
      console.error('Failed to read response blob', e);
      alert('Download failed: ' + e.message);
    }

  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.textContent = oldText;
    }
  }
}

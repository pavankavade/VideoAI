// DB-backed Video Editor bootstrap
// This file adapts the existing video_editor.js logic to load data from the DB APIs

(function(){
  const projEl = document.getElementById('__project_data__');
  let projectMeta = {};
  try { projectMeta = JSON.parse(projEl?.textContent || '{}'); } catch(e){ projectMeta = {}; }
  const projectId = projectMeta.id;

  // Minimal shims: re-use the existing editor by loading it after we prep globals
  // Provide a fetch helper to get DB project summary and hydrate window.projectData with panels+audio
  async function hydrateProject(){
    if (!projectId) return;
    const loader = (window.__VIDEO_API__ && window.__VIDEO_API__.loadProject) || (async (id)=>({}));
    const summary = await loader(projectId);
    // Shape window.projectData similar to old editor expectations
    // Build arrays: panels (with src, pageNumber, panelIndex, effect/transition) and audios (with src, duration if known)
    const panels = [];
    const audios = [];
    const pages = summary.pages || [];
    pages.forEach(pg => {
      const pn = pg.page_number;
      (pg.panels||[]).forEach(p => {
        const idx = p.index || p.panel_index || 0;
        const imgSrc = p.image_path || p.image_url || p.imagePath || p.image || '';
        panels.push({
          id: `p-${pn}-${idx}`,
          pageNumber: pn,
          panelIndex: idx,
          src: imgSrc,
          filename: (imgSrc || '').split('/').pop() || `panel_${idx}.png`,
          displayName: `Page ${pn} – Panel ${idx}`,
          effect: p.effect || 'none',
          transition: p.transition || (idx===0 ? 'none' : 'slide_book')
        });
        if (p.audio_url || p.audio_b64) {
          const src = (p.audio_url || p.audio_b64 || '');
          audios.push({
            id: `a-${pn}-${idx}`,
            pageNumber: pn,
            panelIndex: idx,
            src,
            filename: (typeof src === 'string' ? src.split('/').pop() : `p${pn}_panel${idx}.wav`),
            displayName: `Narration P${pn}-${idx}`,
            duration: 0
          });
        }
      });
    });
    window.projectData = { id: projectId, title: (summary.project && summary.project.title) || projectMeta.title || 'Untitled', pages, panels, audios };
  }

  // Patch endpoints expected by the original JS to point to our new routes
  const mapEffectEndpoints = ()=>{
    const api = window.__VIDEO_API__ || {};
    window.__EFFECT_CFG__ = {
      get: api.effectGet || '/editor/api/video/effect-config',
      set: api.effectSet || '/editor/api/video/effect-config'
    };
    window.__RENDER_API__ = {
      render: api.render || '/editor/api/video/render',
      progressBase: api.progressStreamBase || '/editor/api/video/progress/stream/'
    };
  };

  // Load the legacy editor logic file, but before that, we define fetch wrappers it relies on
  // Set up endpoint mapping and global fetch shim immediately so the next script sees it
  mapEffectEndpoints();
  (function(){
    const orig = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function(url, opts){
      try{
        if (typeof url === 'string'){
          if (url === '/api/effect-config') url = window.__EFFECT_CFG__.get;
          if (url === '/api/video/render') url = window.__RENDER_API__.render;
          const m = url.match(/^\/api\/manga\/(.+)$/);
          if (m) url = `/editor/api/project/${encodeURIComponent(m[1])}`;
        }
      }catch(_e){}
      return (orig ? orig(url, opts) : Promise.reject(new Error('fetch not available')));
    };
  })();

  // Provide placeholder projectData synchronously; hydrate asynchronously
  window.projectData = { id: projectId, title: projectMeta.title || 'Untitled', pages: [], panels: [], audios: [] };
  // Ensure query param is present for any code relying on it
  try{
    const url = new URL(window.location.href);
    if (!url.searchParams.get('project_id')){
      url.searchParams.set('project_id', projectId);
      history.replaceState(null, '', url.toString());
    }
  }catch(_e){}
  // Start hydration but don't block
  hydrateProject().catch(()=>{});
})();

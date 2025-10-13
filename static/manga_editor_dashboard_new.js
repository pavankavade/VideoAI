// Manga Editor Dashboard - Series Support
document.addEventListener('DOMContentLoaded', () => {
  bindModals();
  loadData();
});

let currentSeriesId = null;

async function loadData(){
  await Promise.all([loadSeries(), loadStandaloneProjects()]);
}

async function loadSeries(){
  const container = document.getElementById('seriesList');
  try{
    const r = await fetch('/editor/api/manga/series');
    if(!r.ok) throw new Error('Failed to load series');
    const data = await r.json();
    const series = data.series || [];
    
    if(series.length === 0){
      container.innerHTML = `<div class="empty-state" style="padding:40px 20px;background:linear-gradient(135deg,rgba(14,26,49,0.5),rgba(11,23,45,0.7));border:1px solid rgba(59,130,246,0.2);border-radius:12px">
        <svg width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 16px;opacity:0.3">
          <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
        </svg>
        <div style="color:#94a3b8;font-size:15px;margin-bottom:6px;font-weight:500">No manga series yet</div>
        <div style="color:#64748b;font-size:13px">Create your first manga to get started</div>
      </div>`;
      return;
    }
    
    const html = await Promise.all(series.map(s => renderSeriesCard(s)));
    container.innerHTML = html.join('');
    
    // Bind toggle events
    document.querySelectorAll('.series-header').forEach(header => {
      header.addEventListener('click', (e) => {
        const card = e.currentTarget.closest('.series-card');
        const content = card.querySelector('.series-content');
        const chevron = card.querySelector('.chevron');
        content.classList.toggle('expanded');
        chevron.classList.toggle('expanded');
      });
    });
    
  }catch(e){
    container.innerHTML = `<div style="color:#ef4444;padding:40px;text-center;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:12px">
      <div style="font-weight:500;margin-bottom:4px">Error loading series</div>
      <div style="font-size:13px;opacity:0.8">${e.message}</div>
    </div>`;
  }
}

async function renderSeriesCard(series){
  // Fetch full details
  const r = await fetch(`/editor/api/manga/series/${series.id}`);
  const details = await r.json();
  const chapters = details.chapters || [];
  
  const chaptersHtml = chapters.length === 0 ? 
    `<div style="padding:24px;text-align:center;color:#64748b;font-size:13px">No chapters yet</div>` :
    chapters.map(ch => `
      <div class="chapter-row">
        <div style="display:flex;align-items:center;gap:12px;flex:1">
          <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,rgba(59,130,246,0.2),rgba(37,99,235,0.3));display:flex;align-items:center;justify-content:center;border:1px solid rgba(59,130,246,0.3);font-weight:700;color:#60a5fa;font-size:13px">
            ${ch.chapter_number}
          </div>
          <div style="flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px">${ch.title}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px">${new Date(ch.created_at).toLocaleDateString()} • ${ch.page_count || 0} pages</div>
          </div>
        </div>
        <div class="actions">
          <a class="btn" href="/editor/panel-editor/${ch.id}" style="font-size:12px;padding:8px 12px" title="Edit panels for this chapter">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            Panels
          </a>
          <a class="btn secondary" href="/editor/manga-editor/${ch.id}" style="font-size:12px;padding:8px 12px" title="Open manga editor for narration and characters">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            Manga Editor
          </a>
        </div>
      </div>
    `).join('');
  
  return `
    <div class="series-card">
      <div class="series-header">
        <div style="display:flex;align-items:center;gap:14px;flex:1">
          <svg class="chevron" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M9 5l7 7-7 7"/>
          </svg>
          <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(59,130,246,0.4)">
            <svg width="24" height="24" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
            </svg>
          </div>
          <div style="flex:1">
            <div style="font-size:18px;font-weight:700;color:#e2e8f0">${series.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:4px">${chapters.length} chapter${chapters.length !== 1 ? 's' : ''} • Created ${new Date(series.created_at).toLocaleDateString()}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn" onclick="event.stopPropagation();openAddChapter('${series.id}', '${series.name}')" style="font-size:13px;padding:10px 16px">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Add Chapter
          </button>
          <button class="btn secondary" onclick="event.stopPropagation();deleteSeries('${series.id}', '${series.name}', ${chapters.length})" style="font-size:13px;padding:10px 16px;border-color:rgba(239,68,68,0.3);color:#ef4444" title="Delete this manga series">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            Delete
          </button>
        </div>
      </div>
      <div class="series-content">
        ${chaptersHtml}
      </div>
    </div>
  `;
}

async function loadStandaloneProjects(){
  const body = document.getElementById('editorDashBody');
  try{
    const r = await fetch('/editor/api/projects');
    if(!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    const allProjects = data.projects || [];
    
    // Filter to only standalone projects (no manga_series_id)
    const projects = [];
    for(const p of allProjects){
      // Check if it belongs to a series
      const pr = await fetch(`/editor/api/project/${p.id}`);
      if(!pr.ok) continue;
      const proj = await pr.json();
      if(!proj.metadata || !proj.metadata.manga_series_id){
        projects.push(p);
      }
    }
    
    if(projects.length === 0){
      body.innerHTML = `<tr><td colspan="4" class="empty-state">
        <div style="padding:60px 20px">
          <svg width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 20px;opacity:0.3">
            <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <div style="color:#94a3b8;font-size:16px;margin-bottom:8px;font-weight:500">No standalone projects</div>
          <div style="color:#64748b;font-size:14px">Projects organized in series appear above</div>
        </div>
      </td></tr>`;
      return;
    }
    
    const rows = [];
    for(const p of projects){
      let panelsReady = false;
      try{
        const sr = await fetch(`/editor/api/project/${encodeURIComponent(p.id)}`);
        if(sr.ok){
          const s = await sr.json();
          panelsReady = !!s.allPanelsReady;
        }
      }catch(e){}
      rows.push(`
        <tr class="project-row">
          <td style="padding:20px 24px">
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,rgba(59,130,246,0.2),rgba(37,99,235,0.3));display:flex;align-items:center;justify-content:center;border:1px solid rgba(59,130,246,0.3)">
                <svg width="22" height="22" fill="none" stroke="#60a5fa" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              </div>
              <div>
                <div style="font-weight:600;color:#e2e8f0;font-size:15px">${p.title}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">${p.chapters || 0} page${(p.chapters !== 1) ? 's' : ''}</div>
              </div>
            </div>
          </td>
          <td style="padding:20px 24px">
            ${panelsReady ? '<span class="status-pill ok">✓ Ready</span>' : '<span class="status-pill warn">⚠ Setup</span>'}
          </td>
          <td style="padding:20px 24px;color:#94a3b8;font-size:14px">${new Date(p.createdAt).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}</td>
          <td style="padding:20px 24px">
            <div class="actions">
              <a class="btn" href="/editor/panel-editor/${p.id}" style="background:linear-gradient(135deg,#3b82f6,#2563eb)" title="Edit panels for this project">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                Panels
              </a>
              <a class="btn secondary" href="/editor/manga-editor/${p.id}" title="Open manga editor for narration and characters">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                Manga Editor
              </a>
              <button class="btn secondary" onclick="deleteProject('${p.id}')" style="border-color:rgba(239,68,68,0.3);color:#ef4444" title="Delete this project">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                Delete
              </button>
            </div>
          </td>
        </tr>
      `);
    }
    body.innerHTML = rows.join('');
  }catch(e){
    body.innerHTML = `<tr><td colspan="4" style="color:#ef4444;padding:40px;text-center">
      <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 12px;opacity:0.5">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
      <div style="font-weight:500;margin-bottom:4px">Error loading projects</div>
      <div style="font-size:13px;opacity:0.8">${e.message}</div>
    </td></tr>`;
  }
}

function bindModals(){
  bindCreateManga();
  bindCreateStandaloneProject();
  bindAddChapter();
}

function bindCreateManga(){
  const box = document.getElementById('createMangaBox');
  const open = document.getElementById('btnAddManga');
  const close = document.getElementById('closeCreateManga');
  const cancel = document.getElementById('cancelCreateManga');
  const save = document.getElementById('saveCreateManga');
  
  open?.addEventListener('click', ()=>{ box.style.display='flex'; });
  close?.addEventListener('click', ()=>{ box.style.display='none'; });
  cancel?.addEventListener('click', ()=>{ box.style.display='none'; });
  
  save?.addEventListener('click', async ()=>{
    const name = document.getElementById('mangaName').value.trim();
    if(!name){ alert('Please enter a manga name'); return; }
    
    const r = await fetch('/editor/api/manga/series', { 
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify({name}) 
    });
    if(!r.ok){ alert('Failed to create manga series'); return; }
    
    box.style.display='none';
    document.getElementById('mangaName').value = '';
    await loadData();
  });
}

function bindCreateStandaloneProject(){
  const box = document.getElementById('createBox');
  const open = document.getElementById('btnAddStandaloneProject');
  const close = document.getElementById('closeCreate');
  const cancel = document.getElementById('cancelCreate');
  const save = document.getElementById('saveCreate');
  const area = document.getElementById('editorFileArea');
  const input = document.getElementById('editorFileInput');
  const list = document.getElementById('editorFileList');
  let pickedFiles = [];
  
  open?.addEventListener('click', ()=>{ box.style.display='flex'; });
  close?.addEventListener('click', ()=>{ box.style.display='none'; pickedFiles=[]; renderFileList(); });
  cancel?.addEventListener('click', ()=>{ box.style.display='none'; pickedFiles=[]; renderFileList(); });
  area?.addEventListener('click', ()=> input?.click());
  
  area?.addEventListener('dragover', (e)=>{ e.preventDefault(); area.style.borderColor='#3b82f6'; area.style.background='rgba(59,130,246,0.1)'; });
  area?.addEventListener('dragleave', (e)=>{ e.preventDefault(); area.style.borderColor='rgba(59,130,246,0.4)'; area.style.background='rgba(11,23,45,0.5)'; });
  area?.addEventListener('drop', (e)=>{
    e.preventDefault(); 
    area.style.borderColor='rgba(59,130,246,0.4)'; 
    area.style.background='rgba(11,23,45,0.5)';
    const files = Array.from(e.dataTransfer.files||[]).filter(f=>f.type.startsWith('image/'));
    appendFiles(files);
  });
  
  input?.addEventListener('change', (e)=>{
    const files = Array.from(e.target.files||[]).filter(f=>f.type.startsWith('image/'));
    appendFiles(files);
  });
  
  function appendFiles(files){
    pickedFiles = pickedFiles.concat(files);
    renderFileList();
  }
  
  function renderFileList(){
    if(!pickedFiles.length){ list.innerHTML = ''; return; }
    list.innerHTML = pickedFiles.map((f,i)=>`
      <div style="padding:14px 16px;border:1px solid rgba(59,130,246,0.35);border-radius:12px;margin-bottom:10px;background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06));display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="20" height="20" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:3px">${(f.size/1024/1024).toFixed(2)} MB</div>
          </div>
        </div>
        <div style="color:#34d399;font-size:12px;font-weight:600">Ready</div>
      </div>
    `).join('');
  }
  
  save?.addEventListener('click', async ()=>{
    const title = document.getElementById('cpTitle').value.trim();
    if(!title || pickedFiles.length===0){ alert('Please enter title and select images'); return; }
    
    const fd = new FormData();
    pickedFiles.forEach(f=> fd.append('files', f));
    const up = await fetch('/upload', { method:'POST', body: fd });
    if(!up.ok){ alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];
    
    const r = await fetch('/editor/api/projects', { 
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify({title, files: filenames}) 
    });
    if(!r.ok){ alert('Create failed'); return; }
    
    box.style.display='none';
    document.getElementById('cpTitle').value = '';
    pickedFiles = []; 
    renderFileList();
    await loadData();
  });
}

function bindAddChapter(){
  const box = document.getElementById('addChapterBox');
  const close = document.getElementById('closeAddChapter');
  const cancel = document.getElementById('cancelAddChapter');
  const save = document.getElementById('saveAddChapter');
  const area = document.getElementById('chapterFileArea');
  const input = document.getElementById('chapterFileInput');
  const list = document.getElementById('chapterFileList');
  let pickedFiles = [];
  
  close?.addEventListener('click', ()=>{ box.style.display='none'; pickedFiles=[]; renderChapterFileList(); });
  cancel?.addEventListener('click', ()=>{ box.style.display='none'; pickedFiles=[]; renderChapterFileList(); });
  area?.addEventListener('click', ()=> input?.click());
  
  area?.addEventListener('dragover', (e)=>{ e.preventDefault(); area.style.borderColor='#3b82f6'; area.style.background='rgba(59,130,246,0.1)'; });
  area?.addEventListener('dragleave', (e)=>{ e.preventDefault(); area.style.borderColor='rgba(59,130,246,0.4)'; area.style.background='rgba(11,23,45,0.5)'; });
  area?.addEventListener('drop', (e)=>{
    e.preventDefault();
    area.style.borderColor='rgba(59,130,246,0.4)';
    area.style.background='rgba(11,23,45,0.5)';
    const files = Array.from(e.dataTransfer.files||[]).filter(f=>f.type.startsWith('image/'));
    pickedFiles = pickedFiles.concat(files);
    renderChapterFileList();
  });
  
  input?.addEventListener('change', (e)=>{
    const files = Array.from(e.target.files||[]).filter(f=>f.type.startsWith('image/'));
    pickedFiles = pickedFiles.concat(files);
    renderChapterFileList();
  });
  
  function renderChapterFileList(){
    if(!pickedFiles.length){ list.innerHTML = ''; return; }
    list.innerHTML = pickedFiles.map(f=>`
      <div style="padding:14px 16px;border:1px solid rgba(59,130,246,0.35);border-radius:12px;margin-bottom:10px;background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06));display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center">
            <svg width="20" height="20" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:3px">${(f.size/1024/1024).toFixed(2)} MB</div>
          </div>
        </div>
        <div style="color:#34d399;font-size:12px;font-weight:600">Ready</div>
      </div>
    `).join('');
  }
  
  save?.addEventListener('click', async ()=>{
    if(!currentSeriesId){ alert('No series selected'); return; }
    
    const chapterNum = parseInt(document.getElementById('chapterNumber').value);
    const title = document.getElementById('chapterTitle').value.trim();
    
    if(!chapterNum || chapterNum < 1){ alert('Please enter a valid chapter number'); return; }
    if(!title){ alert('Please enter a chapter title'); return; }
    if(pickedFiles.length === 0){ alert('Please select images'); return; }
    
    const fd = new FormData();
    pickedFiles.forEach(f=> fd.append('files', f));
    const up = await fetch('/upload', { method:'POST', body: fd });
    if(!up.ok){ alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];
    
    const r = await fetch(`/editor/api/manga/series/${currentSeriesId}/chapters`, { 
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body: JSON.stringify({chapter_number: chapterNum, title, files: filenames}) 
    });
    if(!r.ok){ 
      const err = await r.text();
      alert('Failed to add chapter: ' + err); 
      return; 
    }
    
    box.style.display='none';
    document.getElementById('chapterNumber').value = '';
    document.getElementById('chapterTitle').value = '';
    pickedFiles = [];
    renderChapterFileList();
    await loadData();
  });
}

function openAddChapter(seriesId, seriesName){
  currentSeriesId = seriesId;
  document.getElementById('chapterSeriesName').textContent = seriesName;
  document.getElementById('addChapterBox').style.display = 'flex';
}

async function deleteProject(id){
  if(!confirm('Delete this project? This cannot be undone.')) return;
  const r = await fetch(`/editor/api/projects/${encodeURIComponent(id)}`, { method:'DELETE' });
  if(!r.ok){ alert('Delete failed'); return; }
  await loadData();
}

async function deleteSeries(seriesId, seriesName, chapterCount){
  if(chapterCount > 0){
    const deleteChapters = confirm(
      `Delete "${seriesName}" manga series?\n\n` +
      `This series has ${chapterCount} chapter${chapterCount !== 1 ? 's' : ''}.\n\n` +
      `Click OK to delete the series AND all its chapters.\n` +
      `Click Cancel to keep the chapters as standalone projects.`
    );
    
    if(deleteChapters === null) return; // User closed dialog
    
    const r = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}?delete_chapters=${deleteChapters}`, { 
      method:'DELETE' 
    });
    if(!r.ok){ 
      alert('Delete failed'); 
      return; 
    }
    
    await loadData();
  } else {
    // No chapters, just confirm deletion
    if(!confirm(`Delete "${seriesName}" manga series?`)) return;
    
    const r = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}`, { 
      method:'DELETE' 
    });
    if(!r.ok){ 
      alert('Delete failed'); 
      return; 
    }
    
    await loadData();
  }
}

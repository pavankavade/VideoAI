// Manga Editor Dashboard logic
document.addEventListener('DOMContentLoaded', () => {
  bindCreate();
  loadProjects();
});

async function loadProjects(){
  const body = document.getElementById('editorDashBody');
  try{
    const r = await fetch('/editor/api/projects');
    if(!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    const projects = data.projects || [];
    if(projects.length === 0){
      body.innerHTML = `<tr><td colspan="4" style="color:#9ca3af">No projects yet</td></tr>`;
      return;
    }
    // For each project, fetch summary from new editor API to know panel status
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
        <tr>
          <td><strong>${p.title}</strong></td>
          <td>
            ${panelsReady ? '<span class="status-pill ok">All panels ready</span>' : '<span class="status-pill warn">Panels missing</span>'}
          </td>
          <td>${new Date(p.createdAt).toLocaleDateString()}</td>
          <td>
            <div class="actions">
              <a class="btn" href="/editor/manga-editor/${p.id}">Open Editor</a>
                <a class="btn secondary" href="/editor/viewer/${p.id}">View Panels</a>
              <a class="btn secondary" href="/video-editor?project_id=${p.id}">Video Editor</a>
              <button class="btn secondary" onclick="deleteProject('${p.id}')">Delete</button>
            </div>
          </td>
        </tr>
      `);
    }
    body.innerHTML = rows.join('');
  }catch(e){
    body.innerHTML = `<tr><td colspan="4" style="color:#ef4444">${e.message}</td></tr>`;
  }
}

function bindCreate(){
  const box = document.getElementById('createBox');
  const open = document.getElementById('btnAddProject');
  const close = document.getElementById('closeCreate');
  const cancel = document.getElementById('cancelCreate');
  const save = document.getElementById('saveCreate');
  const area = document.getElementById('editorFileArea');
  const input = document.getElementById('editorFileInput');
  const list = document.getElementById('editorFileList');
  let pickedFiles = [];
  open?.addEventListener('click', ()=>{ box.style.display='flex'; });
  close?.addEventListener('click', ()=>{ box.style.display='none'; });
  cancel?.addEventListener('click', ()=>{ box.style.display='none'; });
  area?.addEventListener('click', ()=> input?.click());
  area?.addEventListener('dragover', (e)=>{ e.preventDefault(); area.style.background='#0a1224'; });
  area?.addEventListener('dragleave', (e)=>{ e.preventDefault(); area.style.background='#0b1324'; });
  area?.addEventListener('drop', (e)=>{
    e.preventDefault(); area.style.background='#0b1324';
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
    list.innerHTML = pickedFiles.map(f=>`<div style="padding:6px 8px;border:1px solid #374151;border-radius:6px;margin-bottom:6px;background:#0a1224">${f.name} <span style="opacity:0.7">(${(f.size/1024/1024).toFixed(2)} MB)</span></div>`).join('');
  }
  save?.addEventListener('click', async ()=>{
    const title = document.getElementById('cpTitle').value.trim();
    if(!title || pickedFiles.length===0){ alert('Please enter title and select at least one image.'); return; }
    // Upload files first using existing /upload (as manga_view does)
    const fd = new FormData();
    pickedFiles.forEach(f=> fd.append('files', f));
    const up = await fetch('/upload', { method:'POST', body: fd });
    if(!up.ok){ alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];
    // Create DB project
    const r = await fetch('/editor/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title, files: filenames}) });
    if(!r.ok){ alert('Create failed'); return; }
    box.style.display='none';
    pickedFiles = []; renderFileList();
    await loadProjects();
  });
}

async function deleteProject(id){
  if(!confirm('Delete project?')) return;
  const r = await fetch(`/editor/api/projects/${encodeURIComponent(id)}`, { method:'DELETE' });
  if(!r.ok){ alert('Delete failed'); return; }
  await loadProjects();
}

// Manga Editor Dashboard
document.addEventListener('DOMContentLoaded', () => {
  bindCreate();
  loadProjects();
});

async function loadProjects(){
  const body = document.getElementById('editorDashBody');
  try{
  const r = await fetch('/editor/api/projects?brief=true&limit=100');
    if(!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    const projects = data.projects || [];
    if(projects.length === 0){
      body.innerHTML = `<tr><td colspan="4" class="empty-state">
        <div style="padding:60px 20px">
          <svg width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 20px;opacity:0.3">
            <path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <div style="color:#94a3b8;font-size:16px;margin-bottom:8px;font-weight:500">No projects yet</div>
          <div style="color:#64748b;font-size:14px">Create your first manga project to get started</div>
        </div>
      </td></tr>`;
      return;
    }
    const rows = [];
    for(const p of projects){
      // `projects` from brief endpoint includes `allPanelsReady` and `pageCount` (fallback to chapters for legacy)
      const panelsReady = !!p.allPanelsReady;
      const pageCount = (typeof p.pageCount !== 'undefined') ? p.pageCount : (p.chapters || 0);
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
                <div style="font-size:12px;color:#64748b;margin-top:2px">ID: ${p.id}</div>
              </div>
            </div>
          </td>
          <td style="padding:20px 24px">
            ${panelsReady ? '<span class="status-pill ok">✓ All Ready</span>' : '<span class="status-pill warn">⚠ Missing</span>'}
          </td>
                <td style="padding:20px 24px;color:#94a3b8;font-size:14px">${pageCount} page${pageCount !== 1 ? 's' : ''}<br>${new Date(p.createdAt).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}</td>
          <td style="padding:20px 24px">
            <div class="actions">
              <a class="btn" href="/editor/panel-editor/${p.id}" style="background:linear-gradient(135deg,#3b82f6,#2563eb);padding:8px 12px;min-width:auto" title="View Panels">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              </a>
              <a class="btn secondary" href="/editor/manga-editor/${p.id}" style="padding:8px 12px;min-width:auto" title="Manga Editor">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              </a>
              <a class="btn secondary" href="/editor/video-editor/${p.id}" style="padding:8px 12px;min-width:auto" title="Video Editor">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              </a>
              <button class="btn secondary" onclick="synthesizeProject('${p.id}')" style="padding:8px 12px;min-width:auto;border-color:rgba(34,197,94,0.3);color:#22c55e" title="Synthesize All Audio">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
              </button>
              <button class="btn secondary" onclick="deleteProject('${p.id}')" style="padding:8px 12px;min-width:auto;border-color:rgba(239,68,68,0.3);color:#ef4444" title="Delete Project">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
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
  area?.addEventListener('dragover', (e)=>{ e.preventDefault(); area.style.borderColor='#3b82f6'; area.style.background='rgba(59,130,246,0.1)'; });
  area?.addEventListener('dragleave', (e)=>{ e.preventDefault(); area.style.borderColor='rgba(59,130,246,0.3)'; area.style.background='rgba(11,23,45,0.4)'; });
  area?.addEventListener('drop', (e)=>{
    e.preventDefault(); area.style.borderColor='rgba(59,130,246,0.3)'; area.style.background='rgba(11,23,45,0.4)';
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
      <div style="padding:14px 16px;border:1px solid rgba(59,130,246,0.35);border-radius:12px;margin-bottom:10px;background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06));display:flex;align-items:center;justify-content:space-between;transition:all 0.2s ease" onmouseover="this.style.background='linear-gradient(135deg,rgba(59,130,246,0.12),rgba(37,99,235,0.1)';this.style.borderColor='rgba(59,130,246,0.5)'" onmouseout="this.style.background='linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06))';this.style.borderColor='rgba(59,130,246,0.35)'">
        <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(59,130,246,0.3)">
            <svg width="20" height="20" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:3px">${(f.size/1024/1024).toFixed(2)} MB</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;color:#34d399;font-size:12px;font-weight:600;flex-shrink:0">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7"/>
          </svg>
          Ready
        </div>
      </div>
    `).join('');
  }
  save?.addEventListener('click', async ()=>{
    const title = document.getElementById('cpTitle').value.trim();
    if(!title || pickedFiles.length===0){ alert('Please enter title and select at least one image.'); return; }
    const fd = new FormData();
    pickedFiles.forEach(f=> fd.append('files', f));
    const up = await fetch('/upload', { method:'POST', body: fd });
    if(!up.ok){ alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];
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

async function synthesizeProject(projectId){
  if(!confirm('Synthesize audio for all panels in this project?\n\nThis will generate TTS audio for all narration text.')) return;
  
  // Create progress modal
  const modal = createProgressModal('Synthesizing Project', 'Initializing...');
  document.body.appendChild(modal);
  
  try {
    const response = await fetch(`/editor/api/project/${encodeURIComponent(projectId)}/tts/synthesize/all`, {
      method: 'POST',
      headers: {'ngrok-skip-browser-warning': 'true'}
    });
    
    if(!response.ok) {
      throw new Error(`Synthesis failed: ${response.status}`);
    }
    
    const result = await response.json();
    updateProgressModal(modal, 'Complete!', `Successfully synthesized ${result.synthesized_count || 0} panels`, 100);
    setTimeout(() => modal.remove(), 2000);
  } catch(error) {
    console.error('Synthesis error:', error);
    updateProgressModal(modal, 'Error', error.message, 0);
    setTimeout(() => modal.remove(), 3000);
  }
}

async function synthesizeAllSeries(){
  if(!confirm('Synthesize audio for ALL projects in the series?\n\nThis will sequentially process each chapter and generate TTS audio for all narration text.\n\nThis may take a while. Continue?')) return;
  
  // Create progress modal
  const modal = createProgressModal('Synthesizing All Series', 'Loading projects...');
  document.body.appendChild(modal);
  
  try {
    // Fetch all projects
    const r = await fetch('/editor/api/projects');
    if(!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    const projects = data.projects || [];
    
    if(projects.length === 0) {
      updateProgressModal(modal, 'No Projects', 'No projects found to synthesize', 0);
      setTimeout(() => modal.remove(), 2000);
      return;
    }
    
    let completed = 0;
    const total = projects.length;
    
    // Process each project sequentially
    for(const project of projects) {
      updateProgressModal(modal, `Processing ${project.title}`, `Chapter ${completed + 1} of ${total}`, Math.round((completed / total) * 100));
      
      try {
        const response = await fetch(`/editor/api/project/${encodeURIComponent(project.id)}/tts/synthesize/all`, {
          method: 'POST',
          headers: {'ngrok-skip-browser-warning': 'true'}
        });
        
        if(response.ok) {
          completed++;
          updateProgressModal(modal, `Completed ${project.title}`, `Chapter ${completed} of ${total} done`, Math.round((completed / total) * 100));
        } else {
          console.error(`Failed to synthesize project ${project.id}:`, response.status);
        }
      } catch(error) {
        console.error(`Error synthesizing project ${project.id}:`, error);
      }
      
      // Small delay between projects to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    updateProgressModal(modal, 'All Complete!', `Successfully processed ${completed} of ${total} projects`, 100);
    setTimeout(() => modal.remove(), 3000);
    
  } catch(error) {
    console.error('Series synthesis error:', error);
    updateProgressModal(modal, 'Error', error.message, 0);
    setTimeout(() => modal.remove(), 3000);
  }
}

function createProgressModal(title, message) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
  `;
  
  modal.innerHTML = `
    <div style="background:#0f1729;border:1px solid #1e293b;border-radius:16px;padding:32px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="24" height="24" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
            <path d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
          </svg>
        </div>
        <div style="flex:1">
          <h3 class="modal-title" style="margin:0;font-size:18px;font-weight:700;color:#e2e8f0">${title}</h3>
        </div>
      </div>
      
      <div class="modal-message" style="margin-bottom:20px;color:#94a3b8;font-size:14px;line-height:1.6">${message}</div>
      
      <div style="background:#0b1220;border-radius:10px;overflow:hidden;height:12px;margin-bottom:12px">
        <div class="modal-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#2563eb);transition:width 0.3s ease"></div>
      </div>
      
      <div class="modal-percentage" style="text-align:center;color:#64748b;font-size:13px;font-weight:600">0%</div>
    </div>
  `;
  
  return modal;
}

function updateProgressModal(modal, title, message, percentage) {
  const titleEl = modal.querySelector('.modal-title');
  const messageEl = modal.querySelector('.modal-message');
  const progressBar = modal.querySelector('.modal-progress-bar');
  const percentageEl = modal.querySelector('.modal-percentage');
  
  if(titleEl) titleEl.textContent = title;
  if(messageEl) messageEl.textContent = message;
  if(progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  if(percentageEl) percentageEl.textContent = `${Math.round(percentage)}%`;
}

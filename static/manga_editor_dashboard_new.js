// Manga Editor Dashboard - Series Support
document.addEventListener('DOMContentLoaded', () => {
  bindModals();
  loadData();
});

let currentSeriesId = null;

// Utility function to check if override is enabled for a series
function isOverrideEnabled(seriesId) {
  const checkbox = document.getElementById(`override-${seriesId}`);
  return checkbox ? checkbox.checked : false;
}

async function loadData() {
  await Promise.all([loadSeries(), loadStandaloneProjects()]);
}

async function loadSeries() {
  const container = document.getElementById('seriesList');
  try {
    const r = await fetch('/editor/api/manga/series');
    if (!r.ok) throw new Error('Failed to load series');
    const data = await r.json();
    const series = data.series || [];

    if (series.length === 0) {
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

  } catch (e) {
    container.innerHTML = `<div style="color:#ef4444;padding:40px;text-center;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:12px">
      <div style="font-weight:500;margin-bottom:4px">Error loading series</div>
      <div style="font-size:13px;opacity:0.8">${e.message}</div>
    </div>`;
  }
}

async function renderSeriesCard(series) {
  // Fetch full details
  const r = await fetch(`/editor/api/manga/series/${series.id}`);
  const details = await r.json();
  const chapters = details.chapters || [];

  const chaptersHtml = chapters.length === 0 ?
    `<div style="padding:24px;text-align:center;color:#64748b;font-size:13px">No chapters yet</div>` :
    chapters.map(ch => {
      const hasImages = ch.has_images === 1 || (ch.page_count && ch.page_count > 0);
      const isMangadexChapter = ch.mangadex_chapter_id && ch.mangadex_chapter_id.length > 0;

      return `
      <div class="chapter-row">
        <div style="display:flex;align-items:center;gap:12px;flex:1">
          <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,rgba(59,130,246,0.2),rgba(37,99,235,0.3));display:flex;align-items:center;justify-content:center;border:1px solid rgba(59,130,246,0.3);font-weight:700;color:#60a5fa;font-size:13px">
            ${ch.chapter_number}
          </div>
          <div style="flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px">
              ${ch.title}
              ${!hasImages ? '<span style="margin-left:8px;font-size:10px;padding:3px 8px;background:rgba(251,191,36,0.2);color:#fbbf24;border-radius:4px;font-weight:600;border:1px solid rgba(251,191,36,0.3)">NO IMAGES</span>' : ''}
              ${isMangadexChapter ? `<a href="${ch.mangadex_chapter_url || 'https://mangadex.org/chapter/' + ch.mangadex_chapter_id}" target="_blank" rel="noopener" style="margin-left:8px;font-size:10px;padding:3px 8px;background:rgba(99,102,241,0.2);color:#818cf8;border-radius:4px;font-weight:600;border:1px solid rgba(99,102,241,0.3);text-decoration:none" title="View on MangaDex">MDex</a>` : ''}
            </div>
            <div style="font-size:11px;color:#64748b;margin-top:2px">${new Date(ch.created_at).toLocaleDateString()} • ${ch.page_count || ch.chapter_pages_count || 0} pages</div>
          </div>
        </div>
        <div class="actions">
          ${!hasImages && isMangadexChapter ? `
          <button class="btn" onclick="event.stopPropagation();fetchChapterImages('${ch.id}', '${ch.mangadex_chapter_url}', '${ch.title.replace(/'/g, "\\'")}', this)" style="font-size:12px;padding:8px 12px;background:#8b5cf6;border-color:#8b5cf6" title="Fetch images from MangaDex using Puppeteer">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 11l3 3m0 0l3-3m-3 3V8"/></svg>
            Fetch Images
          </button>
          <button class="btn" onclick="event.stopPropagation();uploadChapterImages('${ch.id}', '${ch.title.replace(/'/g, "\\'")}', this)" style="font-size:12px;padding:8px 12px;background:#10b981;border-color:#10b981" title="Manually upload images for this chapter">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
            Add Images
          </button>
          ` : ''}
          ${!hasImages && !isMangadexChapter ? `
          <button class="btn" onclick="event.stopPropagation();uploadChapterImages('${ch.id}', '${ch.title.replace(/'/g, "\\'")}', this)" style="font-size:12px;padding:8px 12px;background:#10b981;border-color:#10b981" title="Upload images for this chapter">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
            Add Images
          </button>
          ` : ''}
          <a class="btn" href="/editor/panel-editor/${ch.id}" style="font-size:12px;padding:8px 12px" title="Edit panels for this chapter">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12h6M9 16h6M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            Panels
          </a>
          <a class="btn" href="/editor/video-editor/${ch.id}" style="font-size:12px;padding:8px 12px;min-width:auto" title="Open video editor for this chapter">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            Video Editor
          </a>
          <a class="btn secondary" href="/editor/manga-editor/${ch.id}" style="font-size:12px;padding:8px 12px" title="Open manga editor for narration and characters">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
            Manga Editor
          </a>
        </div>
      </div>
    `;
    }).join('');

  return `
    <div class="series-card" data-series-id="${series.id}" data-chapters='${JSON.stringify(chapters).replace(/'/g, "&apos;")}'>
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
            <div style="display:flex;align-items:center;gap:8px">
              <div class="series-name-container" style="font-size:18px;font-weight:700;color:#e2e8f0">${series.name}</div>
              <button class="btn secondary" style="padding:6px 8px;font-size:13px;min-width:auto" onclick="event.stopPropagation();startSeriesEdit('${series.id}')" title="Edit series name">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4h7v7M3 21l7-7 9-9-7-7L3 21z"/></svg>
              </button>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:4px">${chapters.length} chapter${chapters.length !== 1 ? 's' : ''} • Created ${new Date(series.created_at).toLocaleDateString()}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn" onclick="event.stopPropagation();fetchAllSeriesImages('${series.id}', '${series.name}', this)" style="padding:10px 12px;background:#8b5cf6;border-color:#8b5cf6;min-width:auto" title="Fetch images for all MangaDex chapters without images">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 11l3 3m0 0l3-3m-3 3V8"/></svg>
          </button>
          <button class="btn" onclick="event.stopPropagation();createAllSeriesPanels('${series.id}', '${series.name}', this)" style="padding:10px 12px;background:#06b6d4;border-color:#06b6d4;min-width:auto" title="Create panels for all chapters with images">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>
          </button>
          <button class="btn" onclick="event.stopPropagation();generateAllNarrations('${series.id}', '${series.name}', this)" style="padding:10px 12px;background:#f59e0b;border-color:#f59e0b;min-width:auto" title="Generate narrations for all chapters (auto-updates character list & summary)">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>
          <button class="btn" onclick="event.stopPropagation();synthesizeSeries('${series.id}', '${series.name}', this)" style="padding:10px 12px;background:#22c55e;border-color:#22c55e;min-width:auto" title="Synthesize audio for all chapters in this series">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/></svg>
          </button>
          <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-left:1px solid rgba(255,255,255,0.1);margin-left:4px">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;user-select:none" title="Override existing processed data and start from Chapter 1 for all actions">
              <input type="checkbox" id="override-${series.id}" style="margin:0;transform:scale(0.9)" onclick="event.stopPropagation()">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="opacity:0.7">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
              Override
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1;cursor:pointer;user-select:none;margin-left:8px" title="If unchecked, stops on AI safety errors to allow manual entry">
              <input type="checkbox" id="skip-error-${series.id}" checked style="margin:0;transform:scale(0.9)" onclick="event.stopPropagation()">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="opacity:0.7">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
              Skip Error
            </label>
          </div>
          <button class="btn" onclick="event.stopPropagation();openAddChapter('${series.id}', '${series.name}')" style="padding:10px 12px;min-width:auto" title="Add a new chapter to this series">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="btn secondary" onclick="event.stopPropagation();deleteSeries('${series.id}', '${series.name}', ${chapters.length})" style="padding:10px 12px;border-color:rgba(239,68,68,0.3);color:#ef4444;min-width:auto" title="Delete this manga series">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </div>
      <div class="series-content">
        ${chaptersHtml}
      </div>
    </div>
  `;
}

async function loadStandaloneProjects() {
  const body = document.getElementById('editorDashBody');
  try {
    const r = await fetch('/editor/api/projects?brief=true&limit=200');
    if (!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    // DEBUG: expose the brief projects payload so it's visible in the browser console
    try { console.log('[dashboard] /editor/api/projects?brief payload', data); } catch (e) { }
    const allProjects = data.projects || [];

    // Filter to only standalone projects (no manga_series_id) using brief payload's manga_series_id
    const projects = allProjects.filter(p => !p.manga_series_id);

    if (projects.length === 0) {
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
    for (const p of projects) {
      const panelsReady = !!p.allPanelsReady;
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
                <div style="font-size:12px;color:#64748b;margin-top:2px">${(typeof p.pageCount !== 'undefined' ? p.pageCount : (p.chapters || 0))} page${((typeof p.pageCount !== 'undefined' ? p.pageCount : (p.chapters || 0)) !== 1) ? 's' : ''}</div>
              </div>
            </div>
          </td>
          <td style="padding:20px 24px">
            ${panelsReady ? '<span class="status-pill ok">✓ Ready</span>' : '<span class="status-pill warn">⚠ Setup</span>'}
          </td>
          <td style="padding:20px 24px;color:#94a3b8;font-size:14px">${new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
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
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" style="color:#ef4444;padding:40px;text-center">
      <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 12px;opacity:0.5">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
      <div style="font-weight:500;margin-bottom:4px">Error loading projects</div>
      <div style="font-size:13px;opacity:0.8">${e.message}</div>
    </td></tr>`;
  }
}

function bindModals() {
  bindCreateManga();
  bindCreateStandaloneProject();
  bindAddChapter();
}

function bindCreateManga() {
  const box = document.getElementById('createMangaBox');
  const open = document.getElementById('btnAddManga');
  const close = document.getElementById('closeCreateManga');
  const cancel = document.getElementById('cancelCreateManga');
  const save = document.getElementById('saveCreateManga');

  open?.addEventListener('click', () => { box.style.display = 'flex'; });
  close?.addEventListener('click', () => { box.style.display = 'none'; });
  cancel?.addEventListener('click', () => { box.style.display = 'none'; });

  save?.addEventListener('click', async () => {
    const name = document.getElementById('mangaName').value.trim();
    if (!name) { alert('Please enter a manga name'); return; }

    const r = await fetch('/editor/api/manga/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!r.ok) { alert('Failed to create manga series'); return; }

    box.style.display = 'none';
    document.getElementById('mangaName').value = '';
    await loadData();
  });
}

function bindCreateStandaloneProject() {
  const box = document.getElementById('createBox');
  const open = document.getElementById('btnAddStandaloneProject');
  const close = document.getElementById('closeCreate');
  const cancel = document.getElementById('cancelCreate');
  const save = document.getElementById('saveCreate');
  const area = document.getElementById('editorFileArea');
  const input = document.getElementById('editorFileInput');
  const list = document.getElementById('editorFileList');
  let pickedFiles = [];

  open?.addEventListener('click', () => { box.style.display = 'flex'; });
  close?.addEventListener('click', () => { box.style.display = 'none'; pickedFiles = []; renderFileList(); });
  cancel?.addEventListener('click', () => { box.style.display = 'none'; pickedFiles = []; renderFileList(); });
  area?.addEventListener('click', () => input?.click());

  area?.addEventListener('dragover', (e) => { e.preventDefault(); area.style.borderColor = '#3b82f6'; area.style.background = 'rgba(59,130,246,0.1)'; });
  area?.addEventListener('dragleave', (e) => { e.preventDefault(); area.style.borderColor = 'rgba(59,130,246,0.4)'; area.style.background = 'rgba(11,23,45,0.5)'; });
  area?.addEventListener('drop', (e) => {
    e.preventDefault();
    area.style.borderColor = 'rgba(59,130,246,0.4)';
    area.style.background = 'rgba(11,23,45,0.5)';
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
    appendFiles(files);
  });

  input?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    appendFiles(files);
  });

  function appendFiles(files) {
    pickedFiles = pickedFiles.concat(files);
    renderFileList();
  }

  function renderFileList() {
    if (!pickedFiles.length) { list.innerHTML = ''; return; }
    list.innerHTML = pickedFiles.map((f, i) => `
      <div style="padding:14px 16px;border:1px solid rgba(59,130,246,0.35);border-radius:12px;margin-bottom:10px;background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06));display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="20" height="20" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:3px">${(f.size / 1024 / 1024).toFixed(2)} MB</div>
          </div>
        </div>
        <div style="color:#34d399;font-size:12px;font-weight:600">Ready</div>
      </div>
    `).join('');
  }

  save?.addEventListener('click', async () => {
    const title = document.getElementById('cpTitle').value.trim();
    if (!title || pickedFiles.length === 0) { alert('Please enter title and select images'); return; }

    const fd = new FormData();
    pickedFiles.forEach(f => fd.append('files', f));
    const up = await fetch('/upload', { method: 'POST', body: fd });
    if (!up.ok) { alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];

    const r = await fetch('/editor/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, files: filenames })
    });
    if (!r.ok) { alert('Create failed'); return; }

    box.style.display = 'none';
    document.getElementById('cpTitle').value = '';
    pickedFiles = [];
    renderFileList();
    await loadData();
  });
}

function bindAddChapter() {
  const box = document.getElementById('addChapterBox');
  const close = document.getElementById('closeAddChapter');
  const cancel = document.getElementById('cancelAddChapter');
  const save = document.getElementById('saveAddChapter');
  const area = document.getElementById('chapterFileArea');
  const input = document.getElementById('chapterFileInput');
  const list = document.getElementById('chapterFileList');
  let pickedFiles = [];

  close?.addEventListener('click', () => { box.style.display = 'none'; pickedFiles = []; renderChapterFileList(); });
  cancel?.addEventListener('click', () => { box.style.display = 'none'; pickedFiles = []; renderChapterFileList(); });
  area?.addEventListener('click', () => input?.click());

  area?.addEventListener('dragover', (e) => { e.preventDefault(); area.style.borderColor = '#3b82f6'; area.style.background = 'rgba(59,130,246,0.1)'; });
  area?.addEventListener('dragleave', (e) => { e.preventDefault(); area.style.borderColor = 'rgba(59,130,246,0.4)'; area.style.background = 'rgba(11,23,45,0.5)'; });
  area?.addEventListener('drop', (e) => {
    e.preventDefault();
    area.style.borderColor = 'rgba(59,130,246,0.4)';
    area.style.background = 'rgba(11,23,45,0.5)';
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
    pickedFiles = pickedFiles.concat(files);
    renderChapterFileList();
  });

  input?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
    pickedFiles = pickedFiles.concat(files);
    renderChapterFileList();
  });

  function renderChapterFileList() {
    if (!pickedFiles.length) { list.innerHTML = ''; return; }
    list.innerHTML = pickedFiles.map(f => `
      <div style="padding:14px 16px;border:1px solid rgba(59,130,246,0.35);border-radius:12px;margin-bottom:10px;background:linear-gradient(135deg,rgba(59,130,246,0.08),rgba(37,99,235,0.06));display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);display:flex;align-items:center;justify-content:center">
            <svg width="20" height="20" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;color:#e2e8f0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:12px;color:#64748b;margin-top:3px">${(f.size / 1024 / 1024).toFixed(2)} MB</div>
          </div>
        </div>
        <div style="color:#34d399;font-size:12px;font-weight:600">Ready</div>
      </div>
    `).join('');
  }

  save?.addEventListener('click', async () => {
    if (!currentSeriesId) { alert('No series selected'); return; }

    const chapterNum = parseInt(document.getElementById('chapterNumber').value);
    const title = document.getElementById('chapterTitle').value.trim();

    if (!chapterNum || chapterNum < 1) { alert('Please enter a valid chapter number'); return; }
    if (!title) { alert('Please enter a chapter title'); return; }
    if (pickedFiles.length === 0) { alert('Please select images'); return; }

    const fd = new FormData();
    pickedFiles.forEach(f => fd.append('files', f));
    const up = await fetch('/upload', { method: 'POST', body: fd });
    if (!up.ok) { alert('Upload failed'); return; }
    const upData = await up.json();
    const filenames = upData.filenames || [];

    const r = await fetch(`/editor/api/manga/series/${currentSeriesId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter_number: chapterNum, title, files: filenames })
    });
    if (!r.ok) {
      const err = await r.text();
      alert('Failed to add chapter: ' + err);
      return;
    }

    box.style.display = 'none';
    document.getElementById('chapterNumber').value = '';
    document.getElementById('chapterTitle').value = '';
    pickedFiles = [];
    renderChapterFileList();
    await loadData();
  });
}

function openAddChapter(seriesId, seriesName) {
  currentSeriesId = seriesId;
  document.getElementById('chapterSeriesName').textContent = seriesName;
  document.getElementById('addChapterBox').style.display = 'flex';
}

// Inline series name editing ------------------------------------------------
function startSeriesEdit(seriesId, oldName) {
  try {
    const card = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
    if (!card) return;
    const container = card.querySelector('.series-name-container');
    if (!container) return;
    // Determine current name if not provided
    const currentName = (typeof oldName !== 'undefined' && oldName !== null) ? String(oldName) : (container.textContent || '').trim();

    // Build input + actions
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName || '';
    input.style.cssText = 'font-size:16px;padding:6px 8px;border-radius:8px;background:rgba(11,23,45,0.6);border:1px solid rgba(51,65,85,0.8);color:#e2e8f0';
    input.onkeydown = (e) => { if (e.key === 'Enter') { saveSeriesEdit(seriesId, input.value, currentName); } if (e.key === 'Escape') { cancelSeriesEdit(seriesId, currentName); } };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.style.cssText = 'padding:6px 8px;font-size:13px;min-width:auto;margin-left:8px';
    saveBtn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    saveBtn.onclick = (ev) => { ev.stopPropagation(); saveSeriesEdit(seriesId, input.value, currentName); };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn secondary';
    cancelBtn.style.cssText = 'padding:6px 8px;font-size:13px;min-width:auto;margin-left:6px';
    cancelBtn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>';
    cancelBtn.onclick = (ev) => { ev.stopPropagation(); cancelSeriesEdit(seriesId, currentName); };

    // Clear container and append controls
    container.innerHTML = '';
    container.appendChild(input);
    container.appendChild(saveBtn);
    container.appendChild(cancelBtn);
    input.focus();
    input.select();
  } catch (e) { console.error('startSeriesEdit', e); }
}

function cancelSeriesEdit(seriesId, oldName) {
  // Refresh the series list to restore original rendering
  loadData();
}

async function saveSeriesEdit(seriesId, newName, oldName) {
  newName = (String(newName || '')).trim();
  if (!newName) { alert('Series name cannot be empty'); return; }
  if (newName === oldName) { cancelSeriesEdit(seriesId, oldName); return; }

  try {
    const payload = { name: newName, propagate_chapters: true };
    const r = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const txt = await r.text();
      alert('Failed to rename series: ' + (txt || r.status));
      cancelSeriesEdit(seriesId, oldName);
      return;
    }

    // Refresh UI (reload series list)
    await loadData();
    showNotification(`Renamed series to "${newName}"`, 'success', 3000);
  } catch (e) {
    console.error('saveSeriesEdit', e);
    alert('Error renaming series: ' + e.message);
    cancelSeriesEdit(seriesId, oldName);
  }
}

async function deleteProject(id) {
  if (!confirm('Delete this project? This cannot be undone.')) return;
  const r = await fetch(`/editor/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) { alert('Delete failed'); return; }
  await loadData();
}

async function synthesizeProject(projectId) {
  if (!confirm('Synthesize audio for all panels in this project?\n\nThis will generate TTS audio for all narration text.')) return;

  // Create progress modal
  const modal = createProgressModal('Synthesizing Project', 'Initializing...');
  document.body.appendChild(modal);

  try {
    const response = await fetch(`/editor/api/project/${encodeURIComponent(projectId)}/tts/synthesize/all`, {
      method: 'POST',
      headers: { 'ngrok-skip-browser-warning': 'true' }
    });

    if (!response.ok) {
      throw new Error(`Synthesis failed: ${response.status}`);
    }

    const result = await response.json();
    const panelCount = result.total_created || result.synthesized_count || 0;
    updateProgressModal(modal, 'Complete!', `Successfully synthesized ${panelCount} panels`, 100);
    setTimeout(() => modal.remove(), 2000);
  } catch (error) {
    console.error('Synthesis error:', error);
    updateProgressModal(modal, 'Error', error.message, 0);
    setTimeout(() => modal.remove(), 3000);
  }
}

async function deleteSeries(seriesId, seriesName, chapterCount) {
  if (chapterCount > 0) {
    const deleteChapters = confirm(
      `Delete "${seriesName}" manga series?\n\n` +
      `This series has ${chapterCount} chapter${chapterCount !== 1 ? 's' : ''}.\n\n` +
      `Click OK to delete the series AND all its chapters.\n` +
      `Click Cancel to keep the chapters as standalone projects.`
    );

    if (deleteChapters === null) return; // User closed dialog

    const r = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}?delete_chapters=${deleteChapters}`, {
      method: 'DELETE'
    });
    if (!r.ok) {
      alert('Delete failed');
      return;
    }

    await loadData();
  } else {
    // No chapters, just confirm deletion
    if (!confirm(`Delete "${seriesName}" manga series?`)) return;

    const r = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}`, {
      method: 'DELETE'
    });
    if (!r.ok) {
      alert('Delete failed');
      return;
    }

    await loadData();
  }
}

// Upload chapter images manually
async function uploadChapterImages(chapterId, chapterTitle, buttonElement) {
  // Create file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*';

  fileInput.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const originalHTML = buttonElement.innerHTML;

    try {
      // Disable button and show loading
      buttonElement.disabled = true;
      buttonElement.innerHTML = `
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" class="animate-spin" style="animation: spin 1s linear infinite">
          <circle cx="12" cy="12" r="10" stroke-width="4" stroke="currentColor" stroke-dasharray="32" fill="none" opacity="0.25"/>
          <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor"/>
        </svg>
        Uploading ${files.length} images...
      `;

      // Upload files
      const formData = new FormData();
      files.forEach((file, index) => {
        formData.append('files', file);
      });
      formData.append('project_id', chapterId);

      const response = await fetch('/editor/api/upload-chapter-images', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (response.ok && result.success) {
        // Show success
        buttonElement.innerHTML = `
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7"/>
          </svg>
          Uploaded ${result.filesUploaded} images
        `;
        buttonElement.style.background = '#059669';
        buttonElement.style.borderColor = '#059669';

        showNotification(`Successfully uploaded ${result.filesUploaded} images for "${chapterTitle}"`, 'success');

        // Reload data to update UI
        setTimeout(async () => {
          await loadData();
        }, 2000);
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (error) {
      console.error('Upload error:', error);

      // Show error state
      buttonElement.innerHTML = `
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M6 18L18 6M6 6l12 12"/>
        </svg>
        Upload Failed
      `;
      buttonElement.style.background = '#ef4444';
      buttonElement.style.borderColor = '#ef4444';

      showNotification(`Failed to upload images: ${error.message}`, 'error');

      // Restore button after error
      setTimeout(() => {
        buttonElement.disabled = false;
        buttonElement.innerHTML = originalHTML;
        buttonElement.style.background = '#10b981';
        buttonElement.style.borderColor = '#10b981';
      }, 3000);
    }
  };

  // Trigger file picker
  fileInput.click();
}

// Fetch chapter images from MangaDex using Puppeteer
async function fetchChapterImages(chapterId, mangadexUrl, chapterTitle, buttonElement) {
  if (!confirm(`Fetch images for "${chapterTitle}" from MangaDex?\n\nThis will use Puppeteer to scrape the manga pages and upload them automatically.`)) {
    return;
  }

  const originalHTML = buttonElement.innerHTML;

  try {
    // Show loading state
    buttonElement.disabled = true;
    buttonElement.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="animation: spin 1s linear infinite">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
        <path d="M12 2a10 10 0 0110 10" stroke-opacity="0.75"/>
      </svg>
      Fetching...
    `;

    showNotification('Starting Puppeteer to fetch images...', 'info');

    const r = await fetch('/editor/api/fetch-chapter-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapter_id: chapterId,
        mangadex_url: mangadexUrl
      })
    });

    if (!r.ok) {
      const errorData = await r.json();
      throw new Error(errorData.detail || 'Failed to fetch images');
    }

    const result = await r.json();

    // Show success state
    buttonElement.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M5 13l4 4L19 7"/>
      </svg>
      Fetched ${result.image_count} Images!
    `;
    buttonElement.style.background = '#10b981';
    buttonElement.style.borderColor = '#10b981';

    showNotification(`Successfully fetched ${result.image_count} images for ${chapterTitle}!`, 'success');

    // Reload the page after 2 seconds
    setTimeout(() => {
      window.location.reload();
    }, 2000);

  } catch (error) {
    console.error('Fetch error:', error);

    // Show error state
    buttonElement.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M6 18L18 6M6 6l12 12"/>
      </svg>
      Fetch Failed
    `;
    buttonElement.style.background = '#ef4444';
    buttonElement.style.borderColor = '#ef4444';

    showNotification(`Failed to fetch images: ${error.message}`, 'error');

    // Restore button after error
    setTimeout(() => {
      buttonElement.disabled = false;
      buttonElement.innerHTML = originalHTML;
      buttonElement.style.background = '#8b5cf6';
      buttonElement.style.borderColor = '#8b5cf6';
    }, 3000);
  }
}

// Fetch images for all chapters in a series that need them
async function fetchAllSeriesImages(seriesId, seriesName, buttonElement) {
  // Get the series card and chapters data
  const seriesCard = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!seriesCard) {
    showNotification('Could not find series data', 'error');
    return;
  }

  const chaptersJson = seriesCard.getAttribute('data-chapters');
  const chapters = JSON.parse(chaptersJson);

  // Filter chapters that need images: MangaDex chapters without images
  const chaptersToFetch = chapters.filter(ch => {
    const hasImages = ch.has_images === 1 || (ch.page_count && ch.page_count > 0);
    const isMangadexChapter = ch.mangadex_chapter_id && ch.mangadex_chapter_id.length > 0;
    return !hasImages && isMangadexChapter;
  });

  if (chaptersToFetch.length === 0) {
    showNotification('All chapters already have images!', 'info');
    return;
  }

  const chapterList = chaptersToFetch.map(ch => `Chapter ${ch.chapter_number}: ${ch.title}`).join('\n');
  if (!confirm(`Fetch images for ${chaptersToFetch.length} chapter(s) in "${seriesName}"?\n\n${chapterList}\n\nThis may take a while...`)) {
    return;
  }

  const notificationId = `notification-fetch-${seriesId}`;
  showNotification(`Starting image fetch for ${chaptersToFetch.length} chapters...`, 'info', 0, notificationId);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < chaptersToFetch.length; i++) {
    const ch = chaptersToFetch[i];
    const progress = Math.round(((i + 1) / chaptersToFetch.length) * 100);

    updateNotificationProgress(
      notificationId,
      `Fetching Chapter ${ch.chapter_number}: ${ch.title} (${i + 1}/${chaptersToFetch.length})`,
      progress
    );

    try {
      const r = await fetch('/editor/api/fetch-chapter-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapter_id: ch.id,
          mangadex_url: ch.mangadex_chapter_url || `https://mangadex.org/chapter/${ch.mangadex_chapter_id}`
        })
      });

      if (!r.ok) {
        const errorData = await r.json();
        throw new Error(errorData.detail || 'Failed to fetch images');
      }

      const result = await r.json();
      successCount++;

    } catch (error) {
      console.error(`Error fetching chapter ${ch.chapter_number}:`, error);
      failCount++;
    }

    // Small delay between requests
    if (i < chaptersToFetch.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Show final summary
  removeNotification(notificationId);
  const summary = `Fetch Complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`;
  showNotification(summary, successCount > 0 ? 'success' : 'error', 5000);

  // Reload the page
  setTimeout(() => {
    window.location.reload();
  }, 2000);
}

// Create panels for all chapters in a series
async function createAllSeriesPanels(seriesId, seriesName, buttonElement) {
  // Check override flag
  const override = isOverrideEnabled(seriesId);
  console.log(`Create All Panels - Override mode: ${override}`);

  // Get the series card and chapters data
  const seriesCard = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!seriesCard) {
    showNotification('Could not find series data', 'error');
    return;
  }

  const chaptersJson = seriesCard.getAttribute('data-chapters');
  const chapters = JSON.parse(chaptersJson);

  console.log(`Found ${chapters.length} total chapters in series`);

  // Filter chapters that need panels: chapters with images but no panels yet
  const chaptersToProcess = [];
  for (const ch of chapters) {
    const hasImages = ch.has_images === 1 || (ch.page_count && ch.page_count > 0);
    if (!hasImages) {
      continue; // Skip chapters without images
    }

    // Check if this chapter already has panels (skip this check if override is enabled)
    if (!override) {
      try {
        const projectResp = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}?brief=true`, {
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (projectResp.ok) {
          const projectData = await projectResp.json();
          if (projectData.allPanelsReady) {
            console.log(`Chapter ${ch.chapter_number} already has all panels - skipping`);
            continue; // Skip this chapter as it already has panels
          }
        }
      } catch (e) {
        console.error(`Error checking panels for chapter ${ch.chapter_number}:`, e);
      }
    } else {
      console.log(`Chapter ${ch.chapter_number} - Override enabled, will process regardless of existing panels`);
    }

    // Add this chapter to the list to process
    chaptersToProcess.push(ch);
  }

  console.log(`Filtered to ${chaptersToProcess.length} chapters that need panels`);

  if (chaptersToProcess.length === 0) {
    showNotification('All chapters already have panels created!', 'success');
    return;
  }

  const chapterList = chaptersToProcess.map(ch => `Chapter ${ch.chapter_number}: ${ch.title}`).join('\n');
  const firstChapter = chaptersToProcess[0].chapter_number;
  if (!confirm(`Create panels for ${chaptersToProcess.length} chapter(s) in "${seriesName}"?\n\nStarting from Chapter ${firstChapter}:\n${chapterList}\n\nThis may take a while...`)) {
    return;
  }

  const notificationId = `notification-panels-${seriesId}`;
  showNotification(`Starting panel creation for ${chaptersToProcess.length} chapters...`, 'info', 0, notificationId);

  let successCount = 0;
  let failCount = 0;
  let totalPanelsCreated = 0;

  for (let i = 0; i < chaptersToProcess.length; i++) {
    const ch = chaptersToProcess[i];
    const progress = Math.round(((i + 1) / chaptersToProcess.length) * 100);

    updateNotificationProgress(
      notificationId,
      `Creating panels for Chapter ${ch.chapter_number}: ${ch.title} (${i + 1}/${chaptersToProcess.length})`,
      progress
    );

    try {
      // Get project details to know how many pages
      const projectResp = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}?brief=true`, {
        headers: { 'ngrok-skip-browser-warning': 'true' }
      });

      if (!projectResp.ok) {
        throw new Error('Failed to get chapter details');
      }

      const projectData = await projectResp.json();
      const pages = projectData.pages || [];

      console.log(`Chapter ${ch.chapter_number} has ${pages.length} pages`);

      if (pages.length === 0) {
        throw new Error('No pages found');
      }

      // Create panels for each page
      let chapterPanelCount = 0;
      for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
        const page = pages[pageIdx];

        // Update progress with page detail
        const chapterProgress = Math.round((i / chaptersToProcess.length) * 100);
        const pageProgress = Math.round((pageIdx / pages.length) * 100);
        const totalProgress = Math.round((chapterProgress + (pageProgress / chaptersToProcess.length)));

        updateNotificationProgress(
          notificationId,
          `Ch ${ch.chapter_number} - Page ${pageIdx + 1}/${pages.length} (${i + 1}/${chaptersToProcess.length} chapters)`,
          totalProgress
        );

        try {
          const panelResp = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}/panels/create/page/${encodeURIComponent(page.page_number)}`, {
            method: 'POST',
            headers: { 'ngrok-skip-browser-warning': 'true' }
          });

          if (!panelResp.ok) {
            const errorText = await panelResp.text();
            console.error(`Failed to create panels for page ${page.page_number}:`, errorText);
            continue; // Continue with next page even if one fails
          }

          const panelData = await panelResp.json();
          const panelsCreated = (panelData.created || panelData.panel_count || panelData.panels_created || 0);
          chapterPanelCount += panelsCreated;

          console.log(`Created ${panelsCreated} panels for page ${page.page_number}`);

          // Wait a bit between pages to avoid overwhelming the panel detection service
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (pageError) {
          console.error(`Exception creating panels for page ${page.page_number}:`, pageError);
          continue; // Continue with next page
        }
      }

      successCount++;
      totalPanelsCreated += chapterPanelCount;

    } catch (error) {
      console.error(`Error creating panels for chapter ${ch.chapter_number}:`, error);
      failCount++;
    }

    // Longer delay between chapters to ensure panel service isn't overwhelmed
    if (i < chaptersToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Show final summary
  removeNotification(notificationId);
  const summary = `Panel Creation Complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}\n📊 Total Panels: ${totalPanelsCreated}`;
  showNotification(summary, successCount > 0 ? 'success' : 'error', 5000);

  // Reload the page
  setTimeout(() => {
    window.location.reload();
  }, 2000);
}

// Show notification helper
function showNotification(message, type = 'info', duration = 5000, id = null) {
  // If id is provided and notification exists, update it
  if (id) {
    const existing = document.getElementById(id);
    if (existing) {
      const messageEl = existing.querySelector('.notification-message');
      const progressBar = existing.querySelector('.notification-progress');
      if (messageEl) messageEl.textContent = message;

      // Update color based on type
      if (type === 'success') {
        existing.style.background = '#10b981';
      } else if (type === 'error') {
        existing.style.background = '#ef4444';
      } else {
        existing.style.background = '#6366f1';
      }

      // If duration is provided, auto-remove
      if (duration > 0) {
        setTimeout(() => {
          existing.remove();
        }, duration);
      }

      return existing;
    }
  }

  const notification = document.createElement('div');
  if (id) notification.id = id;

  notification.style.cssText = `
    position: fixed;
    top: ${20 + (document.querySelectorAll('[id^="notification-"]').length * 80)}px;
    right: 20px;
    padding: 16px 20px;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#6366f1'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    max-width: 400px;
    font-size: 14px;
    font-weight: 500;
    min-width: 300px;
  `;

  notification.innerHTML = `
    <div class="notification-message" style="margin-bottom: 8px;">${message}</div>
    <div class="notification-progress" style="height: 4px; background: rgba(255,255,255,0.3); border-radius: 2px; overflow: hidden; display: none;">
      <div class="notification-progress-bar" style="height: 100%; width: 0%; background: rgba(255,255,255,0.9); transition: width 0.3s ease;"></div>
    </div>
  `;

  document.body.appendChild(notification);

  // Auto-remove if duration is provided
  if (duration > 0) {
    setTimeout(() => {
      notification.remove();
    }, duration);
  }

  return notification;
}

function updateNotificationProgress(notificationId, message, percentage) {
  const notification = document.getElementById(notificationId);
  if (!notification) return;

  const messageEl = notification.querySelector('.notification-message');
  const progressContainer = notification.querySelector('.notification-progress');
  const progressBar = notification.querySelector('.notification-progress-bar');

  if (messageEl) messageEl.textContent = message;

  if (progressContainer && progressBar) {
    progressContainer.style.display = 'block';
    progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  }
}

function removeNotification(notificationId) {
  const notification = document.getElementById(notificationId);
  if (notification) {
    notification.remove();
  }
}

async function generateAllNarrations(seriesId, seriesName, buttonElement) {
  // Check override flag
  const override = isOverrideEnabled(seriesId);
  // Check skip-error flag
  const skipErrorCheckbox = document.getElementById(`skip-error-${seriesId}`);
  const skipError = skipErrorCheckbox ? skipErrorCheckbox.checked : true;

  console.log(`Generate All Narrations - Override: ${override}, Skip Error: ${skipError}`);

  // First, get the narration status to show preview
  let needNarrations = [];

  try {
    const statusResponse = await fetch(`/editor/api/manga/series/${encodeURIComponent(seriesId)}/narration-status?override=${override}`, {
      headers: { 'ngrok-skip-browser-warning': 'true' }
    });

    if (!statusResponse.ok) {
      showNotification('Failed to check narration status', 'error');
      return;
    }

    const status = await statusResponse.json();

    // Build confirmation message
    const withNarrations = status.chapters_with_narrations || [];
    needNarrations = status.chapters_needing_narrations || [];
    const withoutPanels = status.chapters_without_panels || [];

    let message = `Generate narrations for "${seriesName}"?\n\n`;
    if (override) {
      message += `🔄 OVERRIDE MODE: Will process ALL chapters (ignoring existing narrations)\n\n`;
    }
    message += `📊 Status:\n`;
    message += `✅ Already done: ${withNarrations.length} chapter(s)\n`;
    message += `🔄 Will process: ${needNarrations.length} chapter(s)\n`;
    message += `⚠️  Missing panels: ${withoutPanels.length} chapter(s)\n`;
    message += `📚 Total: ${status.total_chapters} chapter(s)\n\n`;

    if (withNarrations.length > 0 && withNarrations.length <= 10) {
      message += `✅ Chapters with narrations (will skip):\n`;
      withNarrations.forEach(ch => {
        message += `   - Chapter ${ch.chapter_number}: ${ch.title}\n`;
      });
      message += `\n`;
    }

    if (needNarrations.length > 0) {
      message += `🔄 Chapters to process:\n`;
      const displayCount = Math.min(needNarrations.length, 10);
      needNarrations.slice(0, displayCount).forEach(ch => {
        message += `   - Chapter ${ch.chapter_number}: ${ch.title}\n`;
      });
      if (needNarrations.length > displayCount) {
        message += `   ... and ${needNarrations.length - displayCount} more\n`;
      }
      message += `\n`;
    }

    if (withoutPanels.length > 0) {
      message += `⚠️  Chapters without panels (will skip):\n`;
      withoutPanels.forEach(ch => {
        message += `   - Chapter ${ch.chapter_number}: ${ch.title}\n`;
      });
      message += `\n`;
    }

    if (needNarrations.length === 0) {
      if (withoutPanels.length > 0) {
        message += `\nAction needed: Create panels for chapters ${withoutPanels.map(ch => ch.chapter_number).join(', ')} first.`;
      } else {
        showNotification('All chapters already have narrations! ✅', 'success');
        return;
      }
    } else {
      message += `\nThis will:\n`;
      message += `- Auto-update character list\n`;
      message += `- Auto-generate story summary\n`;
      message += `- May take several minutes...\n`;
      if (!skipError) {
        message += `- 🛑 STOP on any AI error for manual entry\n`;
      } else {
        message += `- ⏭️ SKIP chapters with AI errors\n`;
      }
    }

    message += `\nContinue?`;

    if (!confirm(message)) {
      return;
    }
  } catch (error) {
    console.error('Status check error:', error);
    showNotification('Failed to check status. Please try again.', 'error');
    return;
  }

  const notificationId = `notification-narrations-${seriesId}`;
  showNotification(`Starting narration generation for ${needNarrations.length} chapters...`, 'info', 0, notificationId);

  let successCount = 0;
  let failCount = 0;
  let stoppedOnError = false;

  // Process each chapter one at a time
  for (let i = 0; i < needNarrations.length; i++) {
    const ch = needNarrations[i];
    const progress = Math.round(((i + 1) / needNarrations.length) * 100);

    updateNotificationProgress(
      notificationId,
      `Generating narrations for Chapter ${ch.chapter_number}: ${ch.title} (${i + 1}/${needNarrations.length})`,
      progress
    );

    try {
      // Generate narrations for this chapter
      const response = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}/narrate/sequential`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errDetail = errData.detail || 'Unknown error';
        throw new Error(errDetail);
      }

      const result = await response.json();
      successCount++;

    } catch (error) {
      console.error(`Error generating narrations for chapter ${ch.chapter_number}:`, error);
      failCount++;

      // Check if we should stop on error
      if (!skipError) {
        stoppedOnError = true;
        removeNotification(notificationId);

        // Try to extract page number from error message "Gemini error on page X: ..."
        let pageNum = 1;
        const match = error.message.match(/on page (\d+)/);
        if (match && match[1]) {
          pageNum = parseInt(match[1]);
        }

        const confirmManual = confirm(
          `Error generating narration for Chapter ${ch.chapter_number} (Page ${pageNum}):\n\n${error.message}\n\n` +
          `"Skip on Error" is disabled. Do you want to open the Manual Entry tool for this page?`
        );

        if (confirmManual) {
          // Redirect to manga editor with auto-open params
          window.location.href = `/editor/manga-editor/${ch.id}?page=${pageNum}&manual_entry=true`;
          return; // Stop execution immediately
        } else {
          // If user cancels, just stop the loop but stay on dashboard
          showNotification(`Stopped narration generation at Chapter ${ch.chapter_number} due to error.`, 'error', 5000);
          break;
        }
      } else {
        // If skipping error, still alert the user that a chapter failed
        // Try to extract page number from error message "Gemini error on page X: ..."
        let pageNum = 1;
        const match = error.message.match(/on page (\d+)/);
        if (match && match[1]) {
          pageNum = parseInt(match[1]);
        }
        // We use a non-blocking notification or a toast here, but user asked for an alert
        // Since this is a batch process, a blocking alert might be annoying if many fail.
        // But the user specifically asked "it should create a alert so i know something happened"
        // Let's use a persistent notification instead of a blocking alert to avoid stopping the batch.
        // UPDATE: User reported not seeing the notification. Switching to native alert to ensure visibility.
        alert(`⚠️ Skipped Chapter ${ch.chapter_number} (Page ${pageNum}) due to AI error:\n\n${error.message}`);
      }
    }


    // Delay between chapters to avoid overwhelming the API
    if (i < needNarrations.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!stoppedOnError) {
    // Show final summary
    removeNotification(notificationId);
    const skipped = status.total_chapters - needNarrations.length;
    const summary = `Narration Generation Complete!\n✅ Successful: ${successCount}\n❌ Failed: ${failCount}\n⏭️ Skipped: ${skipped}`;
    showNotification(summary, successCount > 0 ? 'success' : 'error', 5000);

    // Reload the page
    setTimeout(() => {
      window.location.reload();
    }, 2000);
  }
}

// Synthesize all audio for all projects sequentially
async function synthesizeAllSeries() {
  if (!confirm('Synthesize audio for ALL projects?\n\nThis will sequentially process each project and generate TTS audio for all narration text.\n\nThis may take a while. Continue?')) return;

  // Create progress modal
  const modal = createProgressModal('Synthesizing All Series', 'Loading projects...');
  document.body.appendChild(modal);

  try {
    // Fetch all projects
    const r = await fetch('/editor/api/projects');
    if (!r.ok) throw new Error('Failed to load projects');
    const data = await r.json();
    const projects = data.projects || [];

    if (projects.length === 0) {
      updateProgressModal(modal, 'No Projects', 'No projects found to synthesize', 0);
      setTimeout(() => modal.remove(), 2000);
      return;
    }

    let completed = 0;
    let successCount = 0;
    let failCount = 0;
    const total = projects.length;

    // Process each project sequentially
    for (const project of projects) {
      updateProgressModal(modal, `Processing: ${project.title}`, `Project ${completed + 1} of ${total}`, Math.round((completed / total) * 100));

      try {
        const response = await fetch(`/editor/api/project/${encodeURIComponent(project.id)}/tts/synthesize/all`, {
          method: 'POST',
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (response.ok) {
          const result = await response.json();
          successCount++;
          completed++;
          const panelCount = result.total_created || result.synthesized_count || 0;
          updateProgressModal(modal, `✓ Completed: ${project.title}`, `Project ${completed} of ${total} done (${panelCount} panels synthesized)`, Math.round((completed / total) * 100));
        } else {
          failCount++;
          completed++;
          console.error(`Failed to synthesize project ${project.id}:`, response.status);
          updateProgressModal(modal, `✗ Failed: ${project.title}`, `Project ${completed} of ${total} (failed)`, Math.round((completed / total) * 100));
        }
      } catch (error) {
        failCount++;
        completed++;
        console.error(`Error synthesizing project ${project.id}:`, error);
        updateProgressModal(modal, `✗ Error: ${project.title}`, `Project ${completed} of ${total} (error)`, Math.round((completed / total) * 100));
      }

      // Small delay between projects to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Show final summary
    const summary = `✅ Success: ${successCount}\n❌ Failed: ${failCount}\n📊 Total: ${total}`;
    updateProgressModal(modal, 'All Complete!', summary, 100);
    setTimeout(() => modal.remove(), 5000);

  } catch (error) {
    console.error('Series synthesis error:', error);
    updateProgressModal(modal, 'Error', error.message, 0);
    setTimeout(() => modal.remove(), 3000);
  }
}

// Synthesize audio for all chapters in a specific series
async function synthesizeSeries(seriesId, seriesName, buttonElement) {
  // Check override flag
  const override = isOverrideEnabled(seriesId);
  console.log(`Synthesize Series - Override mode: ${override}`);

  // Get the series card and chapters data
  const seriesCard = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!seriesCard) {
    showNotification('Could not find series data', 'error');
    return;
  }

  const chaptersJson = seriesCard.getAttribute('data-chapters');
  const chapters = JSON.parse(chaptersJson);

  console.log(`Found ${chapters.length} total chapters in series`);

  // Filter chapters that need synthesis
  const chaptersToProcess = [];
  for (const ch of chapters) {
    const hasImages = ch.has_images === 1 || (ch.page_count && ch.page_count > 0);
    if (!hasImages) {
      console.log(`Chapter ${ch.chapter_number} has no images - skipping`);
      continue; // Skip chapters without images
    }

    // Check if this chapter already has audio synthesized (skip this check if override is enabled)
    if (!override) {
      try {
        const projectResp = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}`, {
          headers: { 'ngrok-skip-browser-warning': 'true' }
        });

        if (projectResp.ok) {
          const projectData = await projectResp.json();
          const pages = projectData.pages || [];

          // Check if all panels have audio
          let allHaveAudio = true;
          for (const page of pages) {
            const panels = page.panels || [];
            for (const panel of panels) {
              if (!panel.audio || panel.audio.length === 0) {
                allHaveAudio = false;
                break;
              }
            }
            if (!allHaveAudio) break;
          }

          if (allHaveAudio && pages.length > 0) {
            console.log(`Chapter ${ch.chapter_number} already has audio for all panels - skipping`);
            continue; // Skip this chapter as it already has audio
          }
        }
      } catch (e) {
        console.error(`Error checking audio for chapter ${ch.chapter_number}:`, e);
      }
    } else {
      console.log(`Chapter ${ch.chapter_number} - Override enabled, will process regardless of existing audio`);
    }

    // Add this chapter to the list to process
    chaptersToProcess.push(ch);
  }

  console.log(`Filtered to ${chaptersToProcess.length} chapters that need audio synthesis`);

  if (chaptersToProcess.length === 0) {
    showNotification('All chapters already have audio synthesized!', 'success');
    return;
  }

  const chapterList = chaptersToProcess.map(ch => `Chapter ${ch.chapter_number}: ${ch.title}`).join('\n');
  const firstChapter = chaptersToProcess[0].chapter_number;
  if (!confirm(`Synthesize audio for ${chaptersToProcess.length} chapter(s) in "${seriesName}"?\n\nStarting from Chapter ${firstChapter}:\n${chapterList}\n\nThis may take a while...`)) {
    return;
  }

  const notificationId = `notification-synthesize-${seriesId}`;
  showNotification(`Starting audio synthesis for ${chaptersToProcess.length} chapters...`, 'info', 0, notificationId);

  let successCount = 0;
  let failCount = 0;
  let totalPanelsSynthesized = 0;

  for (let i = 0; i < chaptersToProcess.length; i++) {
    const ch = chaptersToProcess[i];
    const progress = Math.round(((i + 1) / chaptersToProcess.length) * 100);

    updateNotificationProgress(
      notificationId,
      `Synthesizing Chapter ${ch.chapter_number}: ${ch.title} (${i + 1}/${chaptersToProcess.length})`,
      progress
    );

    try {
      // Synthesize audio for this chapter
      const response = await fetch(`/editor/api/project/${encodeURIComponent(ch.id)}/tts/synthesize/all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to synthesize audio`);
      }

      const result = await response.json();
      const panelCount = result.total_created || result.synthesized_count || 0;

      successCount++;
      totalPanelsSynthesized += panelCount;

    } catch (error) {
      console.error(`Error synthesizing audio for chapter ${ch.chapter_number}:`, error);
      failCount++;
    }

    // Delay between chapters to avoid overwhelming the TTS API
    if (i < chaptersToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Show final summary
  removeNotification(notificationId);
  const summary = `Audio Synthesis Complete!\n✅ Successful: ${successCount}\n❌ Failed: ${failCount}\n🔊 Total Panels: ${totalPanelsSynthesized}`;
  showNotification(summary, successCount > 0 ? 'success' : 'error', 5000);

  // Reload the page
  setTimeout(() => {
    window.location.reload();
  }, 2000);
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
      
      <div class="modal-message" style="margin-bottom:20px;color:#94a3b8;font-size:14px;line-height:1.6;white-space:pre-line">${message}</div>
      
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

  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  if (percentageEl) percentageEl.textContent = `${Math.round(percentage)}%`;
}

// ---------------- Model Management ----------------
document.addEventListener('DOMContentLoaded', () => {
  const modelStatusEl = document.getElementById('modelStatus');
  const loadModelBtn = document.getElementById('loadModelBtn');
  let modelCheckInterval = null;

  async function checkModelStatus() {
    try {
      const r = await fetch('/api/model/status');
      if (r.ok) {
        const status = await r.json();
        updateModelUI(status);
      }
    } catch (e) {
      console.warn('Failed to check model status', e);
      if (modelStatusEl) modelStatusEl.textContent = 'Model: Error';
    }
  }

  function updateModelUI(status) {
    if (!modelStatusEl || !loadModelBtn) return;
    if (status.loading) {
      modelStatusEl.textContent = 'Model: Loading...';
      loadModelBtn.style.display = 'none';
      if (!modelCheckInterval) startPolling(2000);
    } else if (status.loaded) {
      modelStatusEl.textContent = `Model: Loaded (${status.device})`;
      loadModelBtn.style.display = 'none';
      stopPolling();
    } else {
      modelStatusEl.textContent = 'Model: Not Loaded';
      loadModelBtn.style.display = 'inline-block';
      stopPolling();
    }
  }

  function startPolling(ms) {
    stopPolling();
    modelCheckInterval = setInterval(checkModelStatus, ms);
  }

  function stopPolling() {
    if (modelCheckInterval) {
      clearInterval(modelCheckInterval);
      modelCheckInterval = null;
    }
  }

  if (loadModelBtn) {
    loadModelBtn.addEventListener('click', async () => {
      loadModelBtn.disabled = true;
      loadModelBtn.textContent = 'Loading...';
      try {
        const r = await fetch('/api/model/load', { method: 'POST' });
        const data = await r.json();
        if (data.status === 'loading' || data.status === 'loaded') {
          startPolling(2000);
        } else {
          alert('Failed to trigger model load: ' + (data.message || 'Unknown error'));
          loadModelBtn.disabled = false;
          loadModelBtn.textContent = 'Load Model';
        }
      } catch (e) {
        console.error(e);
        alert('Error loading model');
        loadModelBtn.disabled = false;
        loadModelBtn.textContent = 'Load Model';
      }
    });
  }

  // Check status on load
  checkModelStatus();
});

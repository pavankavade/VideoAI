(() => {
  const uploadInput = document.getElementById('chapterUpload');
  const startButton = document.getElementById('startButton');
  const statusEl = document.getElementById('status');
  const galleryEl = document.getElementById('imageGallery');
  const resultsEl = document.getElementById('results');
  let detectedPages = [];

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function enableStart(enabled) {
    startButton.disabled = !enabled;
  }

  function clearResults() {
    resultsEl.innerHTML = '';
  }

  function renderGallery(filenames) {
    galleryEl.innerHTML = '';
    filenames.forEach((name) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      const img = document.createElement('img');
      // Images live under /uploads on server filesystem; not served statically. We only show client-selected previews.
      // So use object URLs instead of server path.
      div.appendChild(img);
      const cap = document.createElement('div');
      cap.textContent = name;
      cap.style.fontSize = '12px';
      cap.style.color = '#6b7280';
      cap.style.marginTop = '4px';
      div.appendChild(cap);
      galleryEl.appendChild(div);
    });
  }

  uploadInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) {
      enableStart(false);
      setStatus('');
      galleryEl.innerHTML = '';
      return;
    }

    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));

    setStatus('Uploading...');
    enableStart(false);

    try {
      const res = await fetch('/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      const filenames = (data && data.filenames) || [];
      setStatus(`Uploaded ${filenames.length} file(s).`);
      enableStart(filenames.length > 0);
      renderGallery(filenames);
    } catch (err) {
      console.error(err);
      setStatus('Upload error.');
    }
  });

  startButton.addEventListener('click', async () => {
    clearResults();
    setStatus('Detecting panels and generating crops...');
    enableStart(false);
    startButton.textContent = 'Detecting...';

    try {
      const res = await fetch('/detect-panels', { method: 'POST' });
      if (!res.ok) throw new Error('Detection failed');
      const data = await res.json();
      detectedPages = data.pages || [];

      setStatus('Detection completed. Review crops and process pages.');
      startButton.textContent = 'Re-Detect';
      enableStart(true);

      // Render detection review UI
      detectedPages.forEach((page, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'page';

        const title = document.createElement('h3');
        title.textContent = `Page ${idx + 1} — ${page.filename}`;
        wrap.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
        grid.style.gap = '8px';

        (page.crops || []).forEach((c) => {
          const card = document.createElement('div');
          card.className = 'thumb';
          const img = document.createElement('img');
          img.src = c.url;
          card.appendChild(img);
          const cap = document.createElement('div');
          cap.textContent = c.filename;
          cap.style.fontSize = '12px';
          cap.style.color = '#6b7280';
          cap.style.marginTop = '4px';
          card.appendChild(cap);
          grid.appendChild(card);
        });

        wrap.appendChild(grid);

        const btn = document.createElement('button');
        btn.textContent = 'Generate Narration for This Page';
        btn.style.marginTop = '10px';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Generating...';
          try {
            const body = { filename: page.filename };
            const res = await fetch('/process-page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!res.ok) throw new Error('Narration failed');
            const out = await res.json();

            const narr = document.createElement('div');
            narr.className = 'narration';
            narr.textContent = out.narration || '';
            wrap.appendChild(narr);

            if (Array.isArray(out.panels) && out.panels.length) {
              const pre = document.createElement('pre');
              pre.className = 'code';
              pre.textContent = JSON.stringify(out.panels, null, 2);
              wrap.appendChild(pre);
            }
          } catch (e) {
            console.error(e);
            alert('Failed to generate narration for this page.');
          } finally {
            btn.disabled = false;
            btn.textContent = 'Generate Narration for This Page';
          }
        });
        wrap.appendChild(btn);

        resultsEl.appendChild(wrap);
      });
    } catch (err) {
      console.error(err);
      setStatus('Detection error.');
      startButton.textContent = 'Start Narration';
      enableStart(true);
    }
  });
})();



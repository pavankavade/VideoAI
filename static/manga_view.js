// Manga View JavaScript
let currentImageIndex = 0;
let projectData = null;

// Version check for delete functionality
console.log('manga_view.js loaded - Delete panel functionality available v1.1');

// Ensure all panels have effect and transition properties
function migrateProjectEffects() {
    if (!projectData || !projectData.workflow || !projectData.workflow.panels || !projectData.workflow.panels.data) {
        return;
    }
    
    let hasChanges = false;
    projectData.workflow.panels.data.forEach(pageData => {
        if (pageData.panels) {
            pageData.panels.forEach((panel, index) => {
                // Ensure effect property exists (default to 'none')
                if (!panel.effect) {
                    panel.effect = 'none';
                    hasChanges = true;
                }
                // Ensure transition property exists (default to 'none' for first panel, 'slide_book' for others)
                if (!panel.transition) {
                    panel.transition = index === 0 ? 'none' : 'slide_book';
                    hasChanges = true;
                }
            });
        }
    });
    
    if (hasChanges) {
        // Save changes to the server (async)
        fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow: projectData.workflow })
        }).catch(err => console.error('Failed to save migrated project data:', err));
        console.log('Migrated panels to include effect and transition properties');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    projectData = window.projectData;
    updateCarouselControls();
    initializeTheme();
    migrateProjectEffects(); // Ensure all panels have effect property
    loadExistingNarration();
    loadExistingPanels();
    loadExistingTextMatching();
    loadExistingTTS();
    updatePanelButtons();
    enableImageClickToFullscreenCarousel();
});

function updateCarouselControls() {
    const totalImages = projectData.files.length;
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const pageInfo = document.getElementById('pageInfo');
    
    prevBtn.disabled = currentImageIndex === 0;
    nextBtn.disabled = currentImageIndex === totalImages - 1;
    pageInfo.textContent = `Page ${currentImageIndex + 1} of ${totalImages}`;
    
    // Update indicators
    const indicators = document.querySelectorAll('.indicator');
    indicators.forEach((indicator, index) => {
        indicator.classList.toggle('active', index === currentImageIndex);
    });
}

function showImage(index) {
    const images = document.querySelectorAll('.carousel-image');
    images.forEach((img, i) => {
        img.classList.toggle('active', i === index);
    });
    currentImageIndex = index;
    updateCarouselControls();
}

function nextImage() {
    if (currentImageIndex < projectData.files.length - 1) {
        showImage(currentImageIndex + 1);
    }
}

function previousImage() {
    if (currentImageIndex > 0) {
        showImage(currentImageIndex - 1);
    }
}

function goToImage(index) {
    showImage(parseInt(index));
}

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
        previousImage();
    } else if (e.key === 'ArrowRight') {
        nextImage();
    }
});

async function generateNarrative() {
    const btn = document.getElementById('narrativeBtn');
    const output = document.getElementById('narrativeOutput');
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Generating...';
    
    try {
        const response = await fetch(`/api/manga/${projectData.id}/narrative`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error('Failed to generate narrative');
        }
        
        const data = await response.json();
        
        // The API now returns parsed data directly
        const narrationText = data.narration || '';
        const pageNarrations = data.page_narrations || [];
        
        // Display the narration
        displayNarration(narrationText, pageNarrations);
        
        // Update project status
        projectData.workflow.narrative.status = 'complete';
        projectData.workflow.narrative.data = {
            narration: narrationText,
            page_narrations: pageNarrations
        };
        
        // Update UI
        updateWorkflowStatus('narrative', 'complete');
        
    } catch (error) {
        console.error('Error generating narrative:', error);
        alert('Failed to generate narrative. Please try again.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Narrative';
    }
}

async function detectPanels() {
    const btn = document.getElementById('panelsBtn');
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Detecting...';
    
    try {
        const response = await fetch(`/api/manga/${projectData.id}/panels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error('Failed to detect panels');
        }
        
        const data = await response.json();
        
        // Panels detected successfully - no need to display them in main view
        
        // Update project status
        projectData.workflow.panels.status = 'complete';
        projectData.workflow.panels.data = data.pages;
        
        // Update UI
        updateWorkflowStatus('panels', 'complete');
        updatePanelButtons();
        
    } catch (error) {
        console.error('Error detecting panels:', error);
        alert('Failed to detect panels. Please try again.');
    } finally {
        btn.disabled = false;
        updatePanelButtons();
    }
}

async function redoPanelDetection() {
    const btn = document.getElementById('panelsBtn');
    
    if (!confirm('This will delete existing panel files and regenerate them. Continue?')) {
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Redoing...';
    
    try {
        const response = await fetch(`/api/manga/${projectData.id}/panels/redo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            throw new Error('Failed to redo panel detection');
        }
        
        const data = await response.json();
        
        // Panels redetected successfully - no need to display them in main view
        
        // Update project status
        projectData.workflow.panels.status = 'complete';
        projectData.workflow.panels.data = data.pages;
        
        // Update UI
        updateWorkflowStatus('panels', 'complete');
        updatePanelButtons();
        
    } catch (error) {
        console.error('Error redoing panel detection:', error);
        alert('Failed to redo panel detection. Please try again.');
    } finally {
        btn.disabled = false;
        updatePanelButtons();
    }
}

// displayPanels function removed - panels are now only shown in the panel editor

function updatePanelButtons() {
    const btn = document.getElementById('panelsBtn');
    const panelsStatus = projectData.workflow?.panels?.status;
    
    if (panelsStatus === 'complete') {
        btn.textContent = 'Redo Panel Detection';
        btn.onclick = redoPanelDetection;
        btn.className = 'btn-secondary';
    } else {
        btn.textContent = 'Detect Panels';
        btn.onclick = detectPanels;
        btn.className = 'btn-primary';
    }
}

async function redoSinglePage(pageNumber) {
    const btn = document.querySelector(`[data-redo-page="${pageNumber}"]`);
    if (btn) {
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Redoing...';
        try {
            const response = await fetch(`/api/manga/${projectData.id}/panels/page/${pageNumber}/redo`, { method: 'POST' });
            if (!response.ok) throw new Error('Failed');
            const data = await response.json();
            // Update in-memory workflow panels for this page
            let pages = projectData.workflow?.panels?.data || [];
            const idx = pages.findIndex(p => (p.page_number||0) === pageNumber);
            if (idx >= 0) pages[idx] = data.page; else pages.push(data.page);
            projectData.workflow = projectData.workflow || {};
            projectData.workflow.panels = projectData.workflow.panels || {};
            projectData.workflow.panels.data = pages;
            // Re-render only panels
            displayPanels(pages);
        } catch (e) {
            alert('Failed to redo this page panels');
        } finally {
            btn.disabled = false;
            btn.textContent = oldText;
        }
    }
}

function wirePanelCarouselForPage(pageNumber) {
    const containers = document.querySelectorAll('.page-panels-container');
    const container = containers[pageNumber - 1];
    if (!container) return;
    const items = Array.from(container.querySelectorAll('.panel-item'));
    if (items.length === 0) return;
    let activeIndex = 0;

    const setActive = (idx) => {
        activeIndex = Math.max(0, Math.min(items.length - 1, idx));
        items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
        const dots = container.querySelectorAll(`.panel-indicator`);
        dots.forEach((d, i) => d.classList.toggle('active', i === activeIndex));
    };

    const prevBtn = container.querySelector(`[data-panel-prev="${pageNumber}"]`);
    const nextBtn = container.querySelector(`[data-panel-next="${pageNumber}"]`);
    if (prevBtn) prevBtn.addEventListener('click', () => setActive(activeIndex - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => setActive(activeIndex + 1));

    container.querySelectorAll(`[data-panel-dot="${pageNumber}"]`).forEach(dot => {
        dot.addEventListener('click', (e) => {
            const idx = parseInt(e.currentTarget.getAttribute('data-index')) || 0;
            setActive(idx);
        });
    });

    setActive(0);
}

function enableImageClickToFullscreenCarousel() {
    // Make main chapter images open fullscreen carousel on click
    document.querySelectorAll('.carousel-image').forEach((img, idx) => {
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openFullscreenCarousel(idx + 1));
    });
}

function openFullscreenCarousel(pageNumber) {
    // Build a list of panel URLs for the given page
    const pages = projectData.workflow?.panels?.data || [];
    const page = pages.find(p => (p.page_number||0) === pageNumber);
    const images = page && page.panels && page.panels.length ? page.panels.map(p => ({ url: p.url, filename: p.filename })) : [];

    // If no panels yet, fallback to showing the full page image
    if (images.length === 0) {
        const idx = pageNumber - 1;
        const file = projectData.files[idx];
        if (file) images.push({ url: `/uploads/${file}`, filename: file });
    }

    if (images.length === 0) return;

    let active = 0;
    const modal = document.createElement('div');
    modal.className = 'fullscreen-modal';
    modal.innerHTML = `
        <div class="fullscreen-content">
            <div class="fullscreen-header">
                <h3>Page ${pageNumber}</h3>
                <button class="close-fullscreen" onclick="closeFullscreen()">&times;</button>
            </div>
            <div class="fullscreen-image-container">
                <div class="fs-carousel-wrapper">
                    <button class="fs-nav-btn" data-fs-prev>← Prev</button>
                    <img class="fullscreen-image" data-fs-image src="${images[0].url}" alt="${images[0].filename}">
                    <button class="fs-nav-btn" data-fs-next>Next →</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    const update = () => {
        const imgEl = modal.querySelector('[data-fs-image]');
        imgEl.src = images[active].url;
        imgEl.alt = images[active].filename;
        modal.querySelector('[data-fs-prev]').disabled = active === 0;
        modal.querySelector('[data-fs-next]').disabled = active === images.length - 1;
    };

    modal.querySelector('[data-fs-prev]').addEventListener('click', () => { if (active > 0) { active -= 1; update(); } });
    modal.querySelector('[data-fs-next]').addEventListener('click', () => { if (active < images.length - 1) { active += 1; update(); } });
    update();
}

async function matchTextToPanels() {
    const btn = document.getElementById('textMatchingBtn');
    const progressEl = document.getElementById('textMatchingProgress');
    const bar = document.getElementById('tmpBar');
    const label = document.getElementById('tmpLabel');
    const count = document.getElementById('tmpCount');
    const concInput = document.getElementById('tmConcurrency');
    const concurrency = Math.max(1, Math.min(32, parseInt(concInput?.value || '5')));
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Matching...';
    progressEl.classList.remove('hidden');
    bar.style.width = '0%';
    label.textContent = 'Starting text-panel matching...';
    count.textContent = '';
    let pollTimer = null;
    
    try {
        // Fire and poll progress concurrently
        const start = fetch(`/api/manga/${projectData.id}/text-matching?concurrency=${encodeURIComponent(concurrency)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const poll = async () => {
            try {
                const projRes = await fetch(`/api/manga/${projectData.id}`);
                if (!projRes.ok) return;
                const proj = await projRes.json();
                projectData = proj.project;
                const tm = projectData.workflow?.text_matching || {};
                const prog = tm.progress || { current: 0, total: 0 };
                const total = Math.max(1, prog.total || 0);
                const current = Math.min(prog.current || 0, total);
                const pct = Math.round((current / total) * 100);
                bar.style.width = `${pct}%`;
                label.textContent = current < total ? `Matching panels... (${current}/${total})` : 'Finalizing...';
                count.textContent = `${current}/${total} pages`;
            } catch (e) {
                // ignore transient poll errors
            }
        };
        pollTimer = setInterval(poll, 1000);

        const response = await start;
        if (!response.ok) throw new Error('Failed to match text to panels');
        const data = await response.json();
        
        // Text matching completed successfully - no need to display results in main view
        
        // Update project status
        projectData.workflow.text_matching.status = 'complete';
        projectData.workflow.text_matching.progress = { current: data.pages.length, total: data.pages.length };
        projectData.workflow.text_matching.data = data.pages;
        
        // Update UI
        updateWorkflowStatus('text_matching', 'complete');
        bar.style.width = '100%';
        label.textContent = 'Completed';
        count.textContent = `${data.pages.length}/${data.pages.length} pages`;
        
    } catch (error) {
        console.error('Error matching text to panels:', error);
        alert('Failed to match text to panels. Please try again.');
    } finally {
        if (pollTimer) clearInterval(pollTimer);
        btn.disabled = false;
        btn.textContent = 'Match Text to Panels';
        setTimeout(() => progressEl.classList.add('hidden'), 1200);
    }
}

// displayTextMatching function removed - text matching results are now only shown in the panel editor

function loadExistingTextMatching() {
    const tm = projectData.workflow?.text_matching;
    const status = tm?.status;
    const data = tm?.data;
    let pages = [];
    if (Array.isArray(data)) {
        pages = data;
    } else if (data && Array.isArray(data.pages)) {
        pages = data.pages;
    }
    if (status === 'complete' && pages.length > 0) {
        // Text matching data loaded - no need to display in main view
        updateWorkflowStatus('text_matching', 'complete');
    }
}

async function loadExistingTTS() {
    const tts = projectData.workflow?.tts;
    const status = tts?.status;
    const data = tts?.data;
    
    if (status === 'complete' && data) {
        ttsData = data;
        displayTTSResults();
        updateWorkflowStatus('tts', 'complete');
        
        // Update panel editor UI if it's open
        if (currentEditingPage && ttsData[currentEditingPage]) {
            updateNarrationActions(currentEditingPage, true);
        }
    }
    
    // Load locally saved audio for all pages
    await loadAllSavedAudio();
    
    // Initial model status check is no longer necessary; server loads models by default
}

async function loadAllSavedAudio() {
    // Load audio for all pages in the project
    if (projectData && projectData.files) {
        const loadPromises = projectData.files.map((_, index) => {
            const pageNumber = index + 1;
            return loadAudioLocally(pageNumber);
        });
        await Promise.all(loadPromises);
    }
}

async function checkModelStatus() {
    try {
        const response = await fetch('/ngrok/status', { 
            headers: ngrokHeaders 
        });
        
        if (!response.ok) {
            return;
        }
        
        const statusData = await response.json();
        
        const btn = document.getElementById('loadModelsBtn');
        const statusEl = document.getElementById('modelStatus');
        const statusText = document.getElementById('modelStatusText');
        
        if (statusData.loaded) {
            modelsLoaded = true;
            if (btn) btn.textContent = '✅ Models Loaded';
            if (btn) btn.style.background = '#10b981';
            if (statusEl) statusEl.classList.remove('hidden');
            if (statusText) statusText.textContent = '✅ Models are ready for synthesis';
            if (statusEl) statusEl.style.borderLeftColor = '#10b981';
        } else if (statusData.loading) {
            if (statusEl) statusEl.classList.remove('hidden');
            if (statusText) statusText.textContent = '⏳ Models are currently loading...';
            if (statusEl) statusEl.style.borderLeftColor = '#f59e0b';
        }
    } catch (error) {
        console.error('Error checking model status:', error);
        // Don't show error to user on initial load
    }
}

function displayNarration(narrationText, pageNarrations) {
    const output = document.getElementById('narrativeOutput');
    
    // Clear existing content
    output.innerHTML = '';
    
    // Create tabs container
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'narration-tabs';
    
    // Create tab buttons
    const tabButtons = document.createElement('div');
    tabButtons.className = 'tab-buttons';
    
    const fullStoryBtn = document.createElement('button');
    fullStoryBtn.className = 'tab-button active';
    fullStoryBtn.textContent = 'Full Story';
    fullStoryBtn.onclick = () => showTab('full-story');
    
    const pageWiseBtn = document.createElement('button');
    pageWiseBtn.className = 'tab-button';
    pageWiseBtn.textContent = 'Page-wise Sections';
    pageWiseBtn.onclick = () => showTab('page-wise');
    
    tabButtons.appendChild(fullStoryBtn);
    tabButtons.appendChild(pageWiseBtn);
    
    // Create tab content
    const tabContent = document.createElement('div');
    tabContent.className = 'tab-content';
    
    // Full story tab
    const fullStoryTab = document.createElement('div');
    fullStoryTab.id = 'full-story-tab';
    fullStoryTab.className = 'tab-pane active';
    fullStoryTab.innerHTML = `
        <div class="narrative-text">${narrationText}</div>
    `;
    
    // Page-wise tab
    const pageWiseTab = document.createElement('div');
    pageWiseTab.id = 'page-wise-tab';
    pageWiseTab.className = 'tab-pane';
    
    if (pageNarrations.length > 0) {
        const pageSectionsHTML = pageNarrations.map(([pageLabel, narration], index) => `
            <div class="page-section" data-section-index="${index}">
                <button class="edit-section-btn" onclick="editPageSection(${index})">Edit</button>
                <div class="page-number">${pageLabel}</div>
                <div class="section-text" id="section-text-${index}">${narration}</div>
            </div>
        `).join('');
        
        pageWiseTab.innerHTML = `
            <div class="page-sections-container">
                ${pageSectionsHTML}
            </div>
        `;
    } else {
        pageWiseTab.innerHTML = '<div class="no-sections">No page sections available</div>';
    }
    
    tabContent.appendChild(fullStoryTab);
    tabContent.appendChild(pageWiseTab);
    
    tabsContainer.appendChild(tabButtons);
    tabsContainer.appendChild(tabContent);
    output.appendChild(tabsContainer);
    
    output.classList.remove('hidden');
}

function showTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    
    if (tabName === 'full-story') {
        document.querySelector('.tab-button:first-child').classList.add('active');
        document.getElementById('full-story-tab').classList.add('active');
    } else {
        document.querySelector('.tab-button:last-child').classList.add('active');
        document.getElementById('page-wise-tab').classList.add('active');
    }
}

function editPageSection(sectionIndex) {
    const sectionElement = document.querySelector(`[data-section-index="${sectionIndex}"]`);
    const textElement = document.getElementById(`section-text-${sectionIndex}`);
    const editBtn = sectionElement.querySelector('.edit-section-btn');
    
    if (!sectionElement || !textElement) return;
    
    // Get current text
    const currentText = textElement.textContent;
    
    // Create textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'section-textarea';
    textarea.value = currentText;
    
    // Create action buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'section-actions';
    actionsDiv.innerHTML = `
        <button class="btn-cancel-section" onclick="cancelEditPageSection(${sectionIndex})">Cancel</button>
        <button class="btn-save-section" onclick="savePageSection(${sectionIndex})">Save</button>
    `;
    
    // Replace text with textarea
    textElement.style.display = 'none';
    textElement.parentNode.insertBefore(textarea, textElement);
    textElement.parentNode.insertBefore(actionsDiv, textElement);
    
    // Hide edit button
    editBtn.style.display = 'none';
    
    // Focus textarea
    textarea.focus();
    textarea.select();
}

function cancelEditPageSection(sectionIndex) {
    const sectionElement = document.querySelector(`[data-section-index="${sectionIndex}"]`);
    const textElement = document.getElementById(`section-text-${sectionIndex}`);
    const editBtn = sectionElement.querySelector('.edit-section-btn');
    
    // Remove textarea and actions
    const textarea = sectionElement.querySelector('.section-textarea');
    const actionsDiv = sectionElement.querySelector('.section-actions');
    
    if (textarea) textarea.remove();
    if (actionsDiv) actionsDiv.remove();
    
    // Show original text and edit button
    textElement.style.display = 'block';
    editBtn.style.display = 'block';
}

async function savePageSection(sectionIndex) {
    const sectionElement = document.querySelector(`[data-section-index="${sectionIndex}"]`);
    const textElement = document.getElementById(`section-text-${sectionIndex}`);
    const textarea = sectionElement.querySelector('.section-textarea');
    const editBtn = sectionElement.querySelector('.edit-section-btn');
    
    if (!textarea) return;
    
    const newText = textarea.value.trim();
    
    // Update the text element
    textElement.textContent = newText;
    
    // Remove textarea and actions
    const actionsDiv = sectionElement.querySelector('.section-actions');
    if (textarea) textarea.remove();
    if (actionsDiv) actionsDiv.remove();
    
    // Show original text and edit button
    textElement.style.display = 'block';
    editBtn.style.display = 'block';
    
    // Update project data
    const narrativeData = projectData.workflow?.narrative?.data;
    if (narrativeData && narrativeData.page_narrations) {
        narrativeData.page_narrations[sectionIndex][1] = newText;
        
        // Regenerate full narration
        const fullNarration = narrativeData.page_narrations.map(item => `**${item[0]}:** ${item[1]}`).join('\n\n');
        narrativeData.narration = fullNarration;
        
        // Update project data
        projectData.workflow.narrative.data = narrativeData;
        
        // Save to backend
        try {
            const response = await fetch(`/api/manga/${projectData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    'workflow.narrative.data': narrativeData
                })
            });
            
            if (!response.ok) {
                throw new Error('Failed to save page section');
            }
            
            // Update full story tab as well
            const fullStoryTab = document.getElementById('full-story-tab');
            if (fullStoryTab) {
                const narrativeTextElement = fullStoryTab.querySelector('.narrative-text');
                if (narrativeTextElement) {
                    narrativeTextElement.textContent = fullNarration;
                }
            }
            
            // Show success message
            const originalText = editBtn.textContent;
            editBtn.textContent = 'Saved!';
            editBtn.style.background = '#10b981';
            setTimeout(() => {
                editBtn.textContent = originalText;
                editBtn.style.background = '#3b82f6';
            }, 2000);
            
        } catch (error) {
            console.error('Error saving page section:', error);
            alert('Failed to save page section. Please try again.');
        }
    }
}

function updateWorkflowStatus(step, status) {
    const statusBadge = document.querySelector(`[data-step="${step}"] .status-badge`);
    if (statusBadge) {
        statusBadge.className = `status-badge status-${status}`;
        statusBadge.textContent = status;
    }
}

// Dark mode functionality
async function initializeTheme() {
    const savedTheme = await getFromIndexedDB(THEME_STORE, 'theme') || 'light';
    await setTheme(savedTheme);
}

async function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    await setTheme(newTheme);
}

async function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');
    
    if (theme === 'dark') {
        themeIcon.textContent = '☀️';
        themeText.textContent = 'Light';
    } else {
        themeIcon.textContent = '🌙';
        themeText.textContent = 'Dark';
    }
    
    // Save theme to IndexedDB
    try {
        await saveToIndexedDB(THEME_STORE, 'theme', theme);
    } catch (error) {
        console.error('Failed to save theme:', error);
    }
}

function loadExistingNarration() {
    // Check if narrative data already exists
    const narrativeData = projectData.workflow?.narrative?.data;
    if (narrativeData && projectData.workflow.narrative.status === 'complete') {
        let narrationText = '';
        let pageNarrations = [];
        
        if (typeof narrativeData === 'string') {
            // Legacy format - just text
            narrationText = narrativeData;
        } else if (typeof narrativeData === 'object') {
            // New format - structured data
            narrationText = narrativeData.narration || '';
            pageNarrations = narrativeData.page_narrations || [];
            
            // Handle old format with page_sections
            if (pageNarrations.length === 0 && narrativeData.page_sections) {
                pageNarrations = narrativeData.page_sections.map(section => [section.page, section.section]);
            }
        }
        
        if (narrationText) {
            displayNarration(narrationText, pageNarrations);
        }
    }
}

function loadExistingPanels() {
    // Check if panels data already exists
    const panelsData = projectData.workflow?.panels?.data;
    if (panelsData && projectData.workflow.panels.status === 'complete') {
        // Panels data loaded - no need to display in main view
        updateWorkflowStatus('panels', 'complete');
    }
    // No need to create placeholder sections since panels are only shown in panel editor
}

// createPlaceholderPageSections function removed - no longer needed since panels are only shown in panel editor

function viewPanelFullscreen(imageUrl, filename) {
    // Create fullscreen modal
    const modal = document.createElement('div');
    modal.className = 'fullscreen-modal';
    modal.innerHTML = `
        <div class="fullscreen-content">
            <div class="fullscreen-header">
                <h3>${filename}</h3>
                <button class="close-fullscreen" onclick="closeFullscreen()">&times;</button>
            </div>
            <div class="fullscreen-image-container">
                <img src="${imageUrl}" alt="${filename}" class="fullscreen-image">
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';
}

function closeFullscreen() {
    const modal = document.querySelector('.fullscreen-modal');
    if (modal) {
        modal.remove();
        document.body.style.overflow = 'auto';
    }
}

// Close fullscreen on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeFullscreen();
    }
});

// Also close JSON upload modal with Escape when open
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const jsonModal = document.getElementById('jsonUploadModal');
        if (jsonModal && (jsonModal.style.display === 'block' || jsonModal.style.display === 'flex')) {
            closeJsonUploadModal();
        }
    }
});

// JSON Upload functionality for narrative
function toggleJsonUpload() {
    const modal = document.getElementById('jsonUploadModal');
    if (!modal) return;
    modal.style.display = 'block';
    // Prevent background scrolling
    document.body.style.overflow = 'hidden';
    const ta = document.getElementById('jsonTextArea');
    if (ta) {
        ta.focus();
        ta.select();
    }
}

function closeJsonUploadModal() {
    const modal = document.getElementById('jsonUploadModal');
    const textArea = document.getElementById('jsonTextArea');
    if (!modal) return;
    modal.style.display = 'none';
    // Restore background scrolling
    document.body.style.overflow = '';
    if (textArea) textArea.value = '';
}

async function uploadJsonText() {
    const textArea = document.getElementById('jsonTextArea');
    const uploadBtn = document.getElementById('uploadJsonTextBtn');
    const output = document.getElementById('narrativeOutput');
    
    const jsonText = textArea.value.trim();
    if (!jsonText) {
        alert('Please enter JSON data');
        return;
    }
    
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<span class="loading"></span> Processing...';
    
    try {
        // Parse and validate JSON
        let jsonData;
        try {
            jsonData = JSON.parse(jsonText);
        } catch (e) {
            throw new Error(`Invalid JSON format: ${e.message}`);
        }
        
        // Process the JSON data using the same logic as the upload endpoint
        let processedData;
        
        // Format 1: Direct page_narrations array (from API response)
        if (Array.isArray(jsonData)) {
            // Validate it's an array of [page_label, narration] pairs
            if (jsonData.every(item => Array.isArray(item) && item.length === 2)) {
                // Transform to internal format
                const pageNarrations = jsonData;
                const fullNarration = pageNarrations.map(item => `**${item[0]}:** ${item[1]}`).join('\n\n');
                processedData = {
                    narration: fullNarration,
                    page_narrations: pageNarrations
                };
            } else {
                throw new Error('If JSON is an array, it must contain [page_label, narration] pairs');
            }
        }
        // Format 2: Object with narrative data
        else if (typeof jsonData === 'object' && jsonData !== null) {
            // Check if it has the expected structure
            if ('page_narrations' in jsonData) {
                const pageNarrations = jsonData.page_narrations || [];
                if (!Array.isArray(pageNarrations)) {
                    throw new Error('page_narrations must be an array');
                }
                
                // Validate page_narrations format
                for (let i = 0; i < pageNarrations.length; i++) {
                    const item = pageNarrations[i];
                    if (!Array.isArray(item) || item.length !== 2) {
                        throw new Error(`page_narrations[${i}] must be an array with exactly 2 elements [page_label, narration]`);
                    }
                }
                
                // Use provided narration or generate from page_narrations
                let fullNarration = jsonData.narration || '';
                if (!fullNarration) {
                    fullNarration = pageNarrations.map(item => `**${item[0]}:** ${item[1]}`).join('\n\n');
                }
                
                processedData = {
                    narration: fullNarration,
                    page_narrations: pageNarrations
                };
            } else {
                throw new Error('JSON object must contain \'page_narrations\' field');
            }
        } else {
            throw new Error('JSON must be either an array of [page_label, narration] pairs or an object with page_narrations');
        }
        
        // Update project with narrative data
        const updateResponse = await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.narrative.status': 'complete',
                'workflow.narrative.data': processedData,
                'status': 'narrative'
            })
        });
        
        if (!updateResponse.ok) {
            throw new Error('Failed to update project with narrative data');
        }
        
        // Update local project data
        projectData.workflow.narrative.status = 'complete';
        projectData.workflow.narrative.data = processedData;
        
        // Display the narration
        displayNarration(processedData.narration, processedData.page_narrations);
        
        // Update UI
        updateWorkflowStatus('narrative', 'complete');
        
        // Close modal
        closeJsonUploadModal();
        
        alert('Narrative data uploaded successfully!');
        
    } catch (error) {
        console.error('Error uploading narrative JSON:', error);
        alert(`Failed to upload narrative data: ${error.message}`);
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload & Overwrite';
    }
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    const modal = document.getElementById('jsonUploadModal');
    if (e.target === modal) {
        closeJsonUploadModal();
    }
    
    const panelModal = document.getElementById('panelEditorModal');
    if (e.target === panelModal) {
        closePanelEditor();
    }
    
});

// Panel Text Editor functionality
let currentEditingPage = null;
let originalPanelTexts = {};

// Helper: convert various stored audio representations to a Blob when possible
function convertToBlob(maybeAudio) {
    try {
        // Already a Blob
        if (maybeAudio instanceof Blob) return maybeAudio;

        // data URL string: data:audio/wav;base64,...
        if (typeof maybeAudio === 'string') {
            if (maybeAudio.startsWith('data:')) {
                const parts = maybeAudio.split(',');
                const meta = parts[0];
                const b64 = parts[1] || '';
                const contentType = (meta.split(':')[1] || '').split(';')[0] || 'application/octet-stream';
                const byteChars = atob(b64);
                const byteNumbers = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) {
                    byteNumbers[i] = byteChars.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                return new Blob([byteArray], { type: contentType });
            }

            // Plain URL (http/https or relative) - not a Blob, return null to allow using URL directly
            if (/^https?:\/\//.test(maybeAudio) || maybeAudio.startsWith('/')) {
                return null;
            }

            // Possibly a base64 string without data: prefix
            const maybeB64 = maybeAudio.replace(/\s+/g, '');
            if (/^[A-Za-z0-9+/=]+$/.test(maybeB64) && maybeB64.length % 4 === 0) {
                // Heuristic: treat as base64 audio/wav
                const byteChars = atob(maybeB64);
                const byteNumbers = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
                return new Blob([new Uint8Array(byteNumbers)], { type: 'audio/wav' });
            }
        }

        // If it's an object with a numeric array in `data`
        if (maybeAudio && typeof maybeAudio === 'object') {
            if (Array.isArray(maybeAudio.data) && maybeAudio.data.length > 0) {
                return new Blob([new Uint8Array(maybeAudio.data)], { type: maybeAudio.type || 'audio/wav' });
            }

            // If it's an object with base64 string in `data`
            if (maybeAudio.data && typeof maybeAudio.data === 'string') {
                const b64 = maybeAudio.data.replace(/\s+/g, '');
                const byteChars = atob(b64);
                const byteNumbers = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
                return new Blob([new Uint8Array(byteNumbers)], { type: maybeAudio.type || 'audio/wav' });
            }

            // If it's a plain object that looks like a serialized Blob (has "size" and "type")
            if ('size' in maybeAudio && 'type' in maybeAudio && maybeAudio._parts) {
                // Can't reliably reconstruct - return null to avoid throwing
                return null;
            }
        }
    } catch (e) {
        console.warn('convertToBlob failed:', e);
    }
    return null;
}

// Helper: get a safe audio src (either object URL, data URL or http URL). Returns empty string if unavailable.
function getAudioSrc(maybeAudio) {
    try {
        if (!maybeAudio) return '';

        // If it's a full TTS entry object, prefer filename/url/audioBlob
        if (typeof maybeAudio === 'object' && ! (maybeAudio instanceof Blob)) {
            // If it has an audioBlob that's a real Blob, use it
            if (maybeAudio.audioBlob instanceof Blob) {
                const u = URL.createObjectURL(maybeAudio.audioBlob);
                audioObjectURLs.add(u);
                return u;
            }
            // If it has a filename saved on the server, return uploads path
            if (typeof maybeAudio.filename === 'string' && maybeAudio.filename.trim()) {
                return '/uploads/' + maybeAudio.filename;
            }
            // If it has a url, return it
            if (typeof maybeAudio.url === 'string' && maybeAudio.url.trim()) return maybeAudio.url;
            // Otherwise attempt to convert the object to a Blob (if it contains raw bytes)
            const blob = convertToBlob(maybeAudio);
            if (blob) {
                const url = URL.createObjectURL(blob);
                audioObjectURLs.add(url);
                return url;
            }
            return '';
        }

        // If it's already a Blob -> create object URL
        if (maybeAudio instanceof Blob) {
            const url = URL.createObjectURL(maybeAudio);
            // Track created URLs so we can revoke them later
            audioObjectURLs.add(url);
            return url;
        }

        // If it's a string URL or data URL, return as-is
        if (typeof maybeAudio === 'string') {
            if (maybeAudio.startsWith('data:') || /^https?:\/\//.test(maybeAudio) || maybeAudio.startsWith('/')) {
                return maybeAudio;
            }
            // Try to convert base64 / data to Blob
            const maybeBlob = convertToBlob(maybeAudio);
            if (maybeBlob) {
                const url = URL.createObjectURL(maybeBlob);
                audioObjectURLs.add(url);
                return url;
            }
            return '';
        }

    } catch (e) {
        console.warn('getAudioSrc error:', e);
    }
    return '';
}

// Upload an audio Blob to the server /upload endpoint and return the saved filename (or null)
async function uploadAudioBlob(blob, suggestedName) {
    try {
        const fd = new FormData();
        // server accepts form field 'file' for single file and 'files' for multiple; include both to be safe
        fd.append('file', blob, suggestedName || 'audio.wav');
        fd.append('files', blob, suggestedName || 'audio.wav');
        const resp = await fetch('/upload', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!data) return null;
        if (data.filename) return data.filename;
        if (data.filenames && Array.isArray(data.filenames) && data.filenames.length > 0) return data.filenames[0];
        return null;
    } catch (e) {
        console.error('uploadAudioBlob failed:', e);
        return null;
    }
}

// Prepare a copy of ttsData safe for JSON save (remove raw Blob/audioBuffer objects)
function sanitizeTTSForSave(tts) {
    const out = {};
    try {
        Object.keys(tts || {}).forEach(k => {
            const v = tts[k] || {};
            const entry = {};
            if (v.filename) entry.filename = v.filename;
            if (v.url) entry.url = v.url;
            if (v.text) entry.text = v.text;
            entry.pageNumber = v.pageNumber || (isNaN(parseInt(k)) ? null : parseInt(k));
            out[k] = entry;
        });
    } catch (e) { console.warn('sanitizeTTSForSave error', e); }
    return out;
}

// Track object URLs we create so they can be revoked on unload
const audioObjectURLs = new Set();

function revokeAllAudioObjectURLs() {
    audioObjectURLs.forEach(u => {
        try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
    });
    audioObjectURLs.clear();
}

window.addEventListener('unload', () => {
    revokeAllAudioObjectURLs();
});

function openPanelEditor(pageNumber) {
    currentEditingPage = pageNumber;
    const modal = document.getElementById('panelEditorModal');
    const title = document.getElementById('panelEditorTitle');
    const narrationDiv = document.getElementById('panelEditorNarration');
    const contentDiv = document.getElementById('panelEditorContent');
    const statsDiv = document.getElementById('panelEditorStats');
    
    console.log('Opening panel editor for page:', pageNumber, 'with delete functionality'); // Debug log
    
    // Update title and navigation
    title.textContent = `Panel Editor - Page ${pageNumber}`;
    updatePanelEditorNavigation(pageNumber);
    
    // Get page data
    const panelsData = projectData.workflow?.panels?.data || [];
    const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
    
    if (!pageData || !pageData.panels || pageData.panels.length === 0) {
        contentDiv.innerHTML = `
            <div class="no-panels-message">
                <h3>No panels available</h3>
                <p>Please detect panels first before editing text assignments.</p>
            </div>
        `;
        modal.style.display = 'block';
        return;
    }
    
    // Get narration for this page
    const narrativeData = projectData.workflow?.narrative?.data;
    let pageNarration = '';
    if (narrativeData && narrativeData.page_narrations) {
        const pageLabel = `Page${pageNumber}`;
        const narrationEntry = narrativeData.page_narrations.find(p => p[0] === pageLabel);
        if (narrationEntry) {
            pageNarration = narrationEntry[1];
        }
    }
    
    // Remove narration from sidebar since it's now displayed above audio controls
    if (narrationDiv) {
        narrationDiv.innerHTML = '';
    }
    
    // Create all pages sidebar
    createAllPagesSidebar(pageNumber);
    
    // Get existing text from text matching data if available
    const textMatchingData = projectData.workflow?.text_matching?.data || [];
    const tmPageData = textMatchingData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
    
    // Check if audio exists for this page
    const hasAudio = ttsData[pageNumber] && ttsData[pageNumber].audioBlob;
    
    // Display panels with text areas
    contentDiv.innerHTML = `
        <div class="panels-grid-editor" id="panelsGridEditor">
            ${pageData.panels.map((panel, index) => {
                // Get existing text from multiple sources
                let existingText = panel.matched_text || '';
                
                // Also check text matching data
                if (tmPageData && tmPageData.panels && tmPageData.panels[index]) {
                    const tmPanelText = tmPageData.panels[index].matched_text;
                    if (tmPanelText && tmPanelText.trim()) {
                        existingText = tmPanelText;
                    }
                }
                
                const hasText = existingText && existingText.trim();
                
                // Check if panel has audio
                const panelTtsData = projectData.workflow?.panel_tts?.data?.[`page${pageNumber}`];
                const panelAudio = panelTtsData?.find(p => p.panelIndex === index);
                const hasAudio = panelAudio && panelAudio.audioFile;
                
                                // Determine current effect (default none if missing)
                                const effectVal = panel.effect || 'none';
                                // Simple config note (hardcoded)
                                const effectConfigHelp = 'Effects animate up to 5s then hold. Zoom amount = 25%.';
                                return `
                    <div class="panel-editor-item" data-panel-index="${index}" draggable="true">
                        <div class="drag-handle">⋮⋮</div>
                        <div class="panel-edit-overlay">
                            <button class="edit-panel-btn" onclick="openPanelImageEditor(${pageNumber}, ${index})" title="Edit Panel">✂️</button>
                            <button class="add-border-btn" onclick="addBorderToPanel(${pageNumber}, ${index})" title="Add Border">⭕</button>
                            <button class="delete-panel-btn" onclick="deletePanel(${pageNumber}, ${index})" title="Delete Panel">🗑️</button>
                        </div>
                        <!-- Delete button added in openPanelEditor function -->
                        <img src="${panel.url}" alt="Panel ${index + 1}" class="panel-editor-image" onclick="viewPanelFullscreen('${panel.url}', '${panel.filename}')">
                        <div class="panel-editor-info">
                            <div class="panel-editor-label">Panel ${index + 1}${hasText ? ' ✓' : ''}${hasAudio ? ' 🎵' : ''}</div>
                                                        <div class="panel-effect-row" style="display:flex;gap:8px;align-items:center;margin:6px 0;">
                                                            <label style="font-size:12px;color:#9fbfdc;">Effect</label>
                                                            <select class="panel-effect-select" data-panel-index="${index}" style="flex:1;background:transparent;border:1px solid rgba(255,255,255,0.12);color:#dff3ff;padding:4px;border-radius:6px">
                                                                <option value="none" ${effectVal==='none'?'selected':''}>No Effect</option>
                                                                <option value="slide_lr" ${effectVal==='slide_lr'?'selected':''}>Slide: left → right</option>
                                                                <option value="slide_rl" ${effectVal==='slide_rl'?'selected':''}>Slide: right → left</option>
                                                                <option value="slide_tb" ${effectVal==='slide_tb'?'selected':''}>Slide: top → bottom</option>
                                                                <option value="slide_bt" ${effectVal==='slide_bt'?'selected':''}>Slide: bottom → top</option>
                                                                <option value="zoom_in" ${effectVal==='zoom_in'?'selected':''}>Zoom in</option>
                                                                <option value="zoom_out" ${effectVal==='zoom_out'?'selected':''}>Zoom out</option>
                                                            </select>
                                                            <span style="font-size:11px;opacity:0.7" title="${effectConfigHelp}">ⓘ</span>
                                                        </div>
                                                        <div class="panel-transition-row" style="display:flex;gap:8px;align-items:center;margin:6px 0;">
                                                            <label style="font-size:12px;color:#9fbfdc;">Transition</label>
                                                            <select class="panel-transition-select" data-panel-index="${index}" style="flex:1;background:transparent;border:1px solid rgba(255,255,255,0.12);color:#dff3ff;padding:4px;border-radius:6px">
                                                                <option value="none" ${(panel.transition||'none')==='none'?'selected':''}>No Transition</option>
                                                                <option value="slide_book" ${(panel.transition||'slide_book')==='slide_book'?'selected':''}>Slide Book</option>
                                                                <option value="fade" ${(panel.transition||'')==='fade'?'selected':''}>Fade</option>
                                                                <option value="wipe_lr" ${(panel.transition||'')==='wipe_lr'?'selected':''}>Wipe Left → Right</option>
                                                                <option value="wipe_rl" ${(panel.transition||'')==='wipe_rl'?'selected':''}>Wipe Right → Left</option>
                                                            </select>
                                                            <span style="font-size:11px;opacity:0.7" title="How this panel transitions from the previous panel">ⓘ</span>
                                                        </div>
                            <textarea class="panel-editor-textarea ${hasText ? 'has-text' : ''}" data-panel-index="${index}" placeholder="Enter narration text for this panel...">${existingText}</textarea>
                            <div class="panel-audio-controls">
                                ${hasText ? (
                                    hasAudio ? `
                                        <audio controls class="panel-audio-player" style="width: 100%; margin: 4px 0;">
                                            <source src="/manga_projects/${projectData.id}/${panelAudio.audioFile}" type="audio/wav">
                                        </audio>
                                        <div class="panel-audio-actions">
                                            <button class="btn-secondary btn-xs" onclick="synthesizeIndividualPanel(${pageNumber}, ${index})" title="Re-synthesize this panel">
                                                🔄
                                            </button>
                                        </div>
                                    ` : `
                                        <button class="btn-primary btn-xs" onclick="synthesizeIndividualPanel(${pageNumber}, ${index})" style="width: 100%; margin: 4px 0;">
                                            🎵 Synthesize
                                        </button>
                                    `
                                ) : `
                                    <button class="btn-secondary btn-xs" disabled style="width: 100%; margin: 4px 0;" title="Add text first">
                                        🎵 Add Text First
                                    </button>
                                `}
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
        
        <!-- Add New Panel Button -->
        <button class="add-panel-btn" onclick="openAddPanelModal(${pageNumber})">
            ➕ Add New Panel
        </button>
        
        <!-- Audio Controls for Panel Editor -->
        <div class="page-audio-controls" id="panel-editor-audio-controls-${pageNumber}">
            ${pageNarration ? `
                <div class="page-narration-text">
                    <strong>Page Narration:</strong>
                    <p>${pageNarration}</p>
                </div>
            ` : `
                <div class="page-narration-text">
                    <strong>Page Narration:</strong>
                    <p style="color: #6b7280; font-style: italic;">No narration available for this page. Generate narrative first to enable audio synthesis.</p>
                </div>
            `}
            <div class="page-audio-actions" id="panel-editor-audio-actions-${pageNumber}">
                ${pageNarration ? (
                    hasAudio ? `
                        <div class="audio-controls-container">
                            <audio controls id="audio-player-panel-editor-${pageNumber}" style="width: 100%; margin-bottom: 8px;">
                                <source src="${getAudioSrc(ttsData[pageNumber])}" type="audio/wav">
                                Your browser does not support the audio element.
                            </audio>
                            <button class="btn-secondary btn-sm" onclick="resynthesizePage(${pageNumber})" id="resynthesize-panel-editor-${pageNumber}">
                                🔄 Re-synthesize
                            </button>
                        </div>
                    ` : `
                        <button class="btn-primary btn-sm" onclick="synthesizePageFromEditor(${pageNumber})" id="synthesize-panel-editor-${pageNumber}">
                            🎵 Synthesize Narration
                        </button>
                    `
                ) : `
                    <button class="btn-secondary btn-sm" disabled>
                        🎵 Generate Narrative First
                    </button>
                `}
            </div>
        </div>
    `;
    
    // Store original texts for comparison
    originalPanelTexts = {};
    pageData.panels.forEach((panel, index) => {
        // Get existing text from multiple sources (same logic as above)
        let existingText = panel.matched_text || '';
        
        // Also check text matching data
        if (tmPageData && tmPageData.panels && tmPageData.panels[index]) {
            const tmPanelText = tmPageData.panels[index].matched_text;
            if (tmPanelText && tmPanelText.trim()) {
                existingText = tmPanelText;
            }
        }
        
        originalPanelTexts[index] = existingText;
    });
    
    // Update stats
    const totalPanels = pageData.panels.length;
    let filledPanels = 0;
    
    pageData.panels.forEach((panel, index) => {
        // Get existing text from multiple sources (same logic as above)
        let existingText = panel.matched_text || '';
        
        // Also check text matching data
        if (tmPageData && tmPageData.panels && tmPageData.panels[index]) {
            const tmPanelText = tmPageData.panels[index].matched_text;
            if (tmPanelText && tmPanelText.trim()) {
                existingText = tmPanelText;
            }
        }
        
        if (existingText && existingText.trim()) {
            filledPanels++;
        }
    });
    
    statsDiv.textContent = `${filledPanels}/${totalPanels} panels have text assigned`;
    
    // Show modal
    modal.style.display = 'block';
    
    // Update navigation immediately
    updatePanelEditorNavigation(pageNumber);
    
    // Add event listeners for real-time stats updates
    const textareas = contentDiv.querySelectorAll('.panel-editor-textarea');
    textareas.forEach(textarea => {
        textarea.addEventListener('input', updatePanelStats);
    });
        // Effect change handlers
        const effectSelects = contentDiv.querySelectorAll('.panel-effect-select');
        console.log(`Found ${effectSelects.length} effect dropdowns`); // Debug log
        effectSelects.forEach(sel => {
                sel.addEventListener('change', (e)=>{
                        try{
                            const idx = parseInt(sel.dataset.panelIndex);
                            const panelsData = projectData.workflow?.panels?.data || [];
                            const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
                            if (pageData && pageData.panels && pageData.panels[idx]){
                                pageData.panels[idx].effect = sel.value;
                                projectData.workflow.panels.data = panelsData;
                            }
                        }catch(err){ console.warn('effect change err', err); }
                });
        });
    
    // Add drag and drop functionality
    initializeDragAndDrop();
}

function loadPanelEditorContent(pageNumber) {
    console.log('Loading panel editor content for page:', pageNumber);
    console.log('Current project data structure:', {
        workflow: projectData.workflow ? 'exists' : 'missing',
        panels: projectData.workflow?.panels ? 'exists' : 'missing',
        panelsData: projectData.workflow?.panels?.data ? projectData.workflow.panels.data.length + ' pages' : 'missing'
    });
    
    if (!currentEditingPage || currentEditingPage !== pageNumber) {
        currentEditingPage = pageNumber;
    }
    
    const contentDiv = document.getElementById('panelEditorContent');
    const title = document.getElementById('panelEditorTitle');
    
    if (!contentDiv) {
        console.warn('Panel editor content div not found');
        return;
    }
    
    // Update title and navigation
    if (title) {
        title.textContent = `Panel Editor - Page ${pageNumber}`;
    }
    updatePanelEditorNavigation(pageNumber);
    
    // Get page data
    const panelsData = projectData.workflow?.panels?.data || [];
    const pageData = panelsData.find(p => {
        const pageNum = parseInt(p.page_number);
        const targetPage = parseInt(pageNumber);
        console.log('Comparing page numbers:', pageNum, 'vs', targetPage, '- match:', pageNum === targetPage);
        return pageNum === targetPage;
    });
    
    console.log('Panel data for page', pageNumber, ':', pageData);
    console.log('All panel data:', panelsData);
    console.log('Page data panels:', pageData?.panels);
    
    if (!pageData || !pageData.panels || pageData.panels.length === 0) {
        console.log('No panels found for page', pageNumber, '- showing no panels message');
        contentDiv.innerHTML = `
            <div class="no-panels-message">
                <h3>No panels available</h3>
                <p>Please detect panels first before editing text assignments.</p>
                <div style="margin-top: 10px; font-size: 12px; color: #888;">
                    Debug info: Page ${pageNumber}, found ${pageData ? 'page data' : 'no page data'}, 
                    panels: ${pageData?.panels?.length || 0}
                </div>
            </div>
        `;
        return;
    }
    
    // Get narration for this page
    const narrativeData = projectData.workflow?.narrative?.data;
    let pageNarration = '';
    if (narrativeData && narrativeData.page_narrations) {
        const pageLabel = `Page${pageNumber}`;
        const narrationEntry = narrativeData.page_narrations.find(p => p[0] === pageLabel);
        if (narrationEntry) {
            pageNarration = narrationEntry[1];
        }
    }
    
    // Get existing text from text matching data if available
    const textMatchingData = projectData.workflow?.text_matching?.data || [];
    const tmPageData = textMatchingData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
    
    // Check if audio exists for this page
    const hasAudio = ttsData[pageNumber] && ttsData[pageNumber].audioBlob;
    
    // Display panels with text areas
    contentDiv.innerHTML = `
        <div class="panels-grid-editor" id="panelsGridEditor">
            ${pageData.panels.map((panel, index) => {
                // Get existing text from multiple sources
                let existingText = panel.matched_text || '';
                
                // Also check text matching data
                if (tmPageData && tmPageData.panels && tmPageData.panels[index]) {
                    const tmPanelText = tmPageData.panels[index].matched_text;
                    if (tmPanelText && tmPanelText.trim()) {
                        existingText = tmPanelText;
                    }
                }
                
                const hasText = existingText && existingText.trim();
                
                // Check if panel has audio
                const panelTtsData = projectData.workflow?.panel_tts?.data?.[`page${pageNumber}`];
                const panelAudio = panelTtsData?.find(p => p.panelIndex === index);
                const hasAudio = panelAudio && panelAudio.audioFile;
                
                                const effectVal2 = panel.effect || 'slide_lr';
                                const effectConfigHelp2 = 'Effects animate up to 5s then hold. Zoom amount = 25%.';
                                return `
                    <div class="panel-editor-item" data-panel-index="${index}" draggable="true">
                        <div class="drag-handle">⋮⋮</div>
                        <div class="panel-edit-overlay">
                            <button class="edit-panel-btn" onclick="openPanelImageEditor(${pageNumber}, ${index})" title="Edit Panel">✂️</button>
                            <button class="add-border-btn" onclick="addBorderToPanel(${pageNumber}, ${index})" title="Add Border">⭕</button>
                            <button class="delete-panel-btn" onclick="deletePanel(${pageNumber}, ${index})" title="Delete Panel">🗑️</button>
                        </div>
                        <!-- Delete button added in loadPanelEditorContent function -->
                        <img src="${panel.url}" alt="Panel ${index + 1}" class="panel-editor-image" onclick="viewPanelFullscreen('${panel.url}', '${panel.filename}')">
                        <div class="panel-editor-info">
                            <div class="panel-editor-label">Panel ${index + 1}${hasText ? ' ✓' : ''}${hasAudio ? ' 🎵' : ''}</div>
                                                        <div class="panel-effect-row" style="display:flex;gap:8px;align-items:center;margin:6px 0;">
                                                            <label style="font-size:12px;color:#9fbfdc;">Effect</label>
                                                            <select class="panel-effect-select" data-panel-index="${index}" style="flex:1;background:transparent;border:1px solid rgba(255,255,255,0.12);color:#dff3ff;padding:4px;border-radius:6px">
                                                                <option value="slide_lr" ${effectVal2==='slide_lr'?'selected':''}>Slide: left → right</option>
                                                                <option value="slide_rl" ${effectVal2==='slide_rl'?'selected':''}>Slide: right → left</option>
                                                                <option value="slide_tb" ${effectVal2==='slide_tb'?'selected':''}>Slide: top → bottom</option>
                                                                <option value="slide_bt" ${effectVal2==='slide_bt'?'selected':''}>Slide: bottom → top</option>
                                                                <option value="zoom_in" ${effectVal2==='zoom_in'?'selected':''}>Zoom in</option>
                                                                <option value="zoom_out" ${effectVal2==='zoom_out'?'selected':''}>Zoom out</option>
                                                            </select>
                                                            <span style="font-size:11px;opacity:0.7" title="${effectConfigHelp2}">ⓘ</span>
                                                        </div>
                            <textarea class="panel-editor-textarea ${hasText ? 'has-text' : ''}" data-panel-index="${index}" placeholder="Enter narration text for this panel...">${existingText}</textarea>
                            <div class="panel-audio-controls">
                                ${hasText ? (
                                    hasAudio ? `
                                        <audio controls class="panel-audio-player" style="width: 100%; margin: 4px 0;">
                                            <source src="/manga_projects/${projectData.id}/${panelAudio.audioFile}" type="audio/wav">
                                        </audio>
                                        <div class="panel-audio-actions">
                                            <button class="btn-secondary btn-xs" onclick="synthesizeIndividualPanel(${pageNumber}, ${index})" title="Re-synthesize this panel">
                                                🔄
                                            </button>
                                        </div>
                                    ` : `
                                        <button class="btn-primary btn-xs" onclick="synthesizeIndividualPanel(${pageNumber}, ${index})" style="width: 100%; margin: 4px 0;">
                                            🎵 Synthesize
                                        </button>
                                    `
                                ) : `
                                    <button class="btn-secondary btn-xs" disabled style="width: 100%; margin: 4px 0;" title="Add text first">
                                        🎵 Add Text First
                                    </button>
                                `}
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
        
        <!-- Audio Controls for Panel Editor -->
        <div class="page-audio-controls" id="panel-editor-audio-controls-${pageNumber}">
            ${pageNarration ? `
                <div class="page-narration-text">
                    <strong>Page Narration:</strong>
                    <p>${pageNarration}</p>
                </div>
            ` : `
                <div class="page-narration-text">
                    <strong>Page Narration:</strong>
                    <p style="color: #6b7280; font-style: italic;">No narration available for this page. Generate narrative first to enable audio synthesis.</p>
                </div>
            `}
            <div class="page-audio-actions" id="panel-editor-audio-actions-${pageNumber}">
                ${pageNarration ? (
                    hasAudio ? `
                        <div class="audio-controls-container">
                            <audio controls id="audio-player-panel-editor-${pageNumber}" style="width: 100%; margin-bottom: 8px;">
                                <source src="${getAudioSrc(ttsData[pageNumber])}" type="audio/wav">
                                Your browser does not support the audio element.
                            </audio>
                            <button class="btn-secondary btn-sm" onclick="resynthesizePage(${pageNumber})" id="resynthesize-panel-editor-${pageNumber}">
                                🔄 Re-synthesize
                            </button>
                        </div>
                    ` : `
                        <button class="btn-primary btn-sm" onclick="synthesizePageFromEditor(${pageNumber})" id="synthesize-panel-editor-${pageNumber}">
                            🎵 Synthesize Narration
                        </button>
                    `
                ) : `
                    <button class="btn-secondary btn-sm" disabled>
                        🎵 Generate Narrative First
                    </button>
                `}
            </div>
        </div>
    `;
    
    // Store original texts for comparison
    originalPanelTexts = {};
    pageData.panels.forEach((panel, index) => {
        // Get existing text from multiple sources (same logic as above)
        let existingText = panel.matched_text || '';
        
        if (tmPageData && tmPageData.panels && tmPageData.panels[index]) {
            const tmPanelText = tmPageData.panels[index].matched_text;
            if (tmPanelText && tmPanelText.trim()) {
                existingText = tmPanelText;
            }
        }
        
        originalPanelTexts[index] = existingText;
    });
    
    // Update panel stats
    updatePanelStats();
    
    // Add event listeners for real-time stats updates
    const textareas = contentDiv.querySelectorAll('.panel-editor-textarea');
    textareas.forEach(textarea => {
        textarea.addEventListener('input', updatePanelStats);
    });
    
    // Add effect change handlers
    const effectSelects = contentDiv.querySelectorAll('.panel-effect-select');
    effectSelects.forEach(sel => {
        sel.addEventListener('change', (e) => {
            try {
                const idx = parseInt(sel.dataset.panelIndex);
                const panelsData = projectData.workflow?.panels?.data || [];
                const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
                if (pageData && pageData.panels && pageData.panels[idx]) {
                    pageData.panels[idx].effect = sel.value;
                    projectData.workflow.panels.data = panelsData;
                    console.log(`Panel ${idx} effect changed to: ${sel.value}`);
                }
            } catch (err) { 
                console.warn('Effect change error:', err); 
            }
        });
    });
    
    // Add drag and drop functionality
    initializeDragAndDrop();
}

// Make function globally available
window.loadPanelEditorContent = loadPanelEditorContent;

// TTS Functionality
let currentAudio = null;
let ttsData = {};
let modelsLoaded = false;

// IndexedDB utility functions
const DB_NAME = 'VideoAIStorage';
const DB_VERSION = 2;
const AUDIO_STORE = 'audio';
const THEME_STORE = 'theme';

async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const oldVersion = event.oldVersion;
            
            // Handle migration from version 1 to 2
            if (oldVersion < 2) {
                // Delete old theme store if it exists
                if (db.objectStoreNames.contains(THEME_STORE)) {
                    db.deleteObjectStore(THEME_STORE);
                }
            }
            
            // Create audio store
            if (!db.objectStoreNames.contains(AUDIO_STORE)) {
                const audioStore = db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
                audioStore.createIndex('projectId', 'projectId', { unique: false });
            }
            
            // Create theme store (no keyPath, use key as primary key)
            if (!db.objectStoreNames.contains(THEME_STORE)) {
                db.createObjectStore(THEME_STORE);
            }
        };
    });
}

async function saveToIndexedDB(storeName, key, data) {
    try {
        const db = await openDB();
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        
        return new Promise((resolve, reject) => {
            let request;
            if (storeName === AUDIO_STORE) {
                // For audio store, use the structured format with keyPath
                request = store.put({ id: key, data: data });
            } else {
                // For other stores (like theme), store data directly with key
                request = store.put(data, key);
            }
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error(`Failed to save to IndexedDB (${storeName}):`, error);
        throw error;
    }
}

async function getFromIndexedDB(storeName, key) {
    try {
        const db = await openDB();
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => {
                if (storeName === AUDIO_STORE) {
                    // For audio store, extract data from structured format
                    resolve(request.result ? request.result.data : null);
                } else {
                    // For other stores, return data directly
                    resolve(request.result || null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error(`Failed to get from IndexedDB (${storeName}):`, error);
        return null;
    }
}

async function deleteFromIndexedDB(storeName, key) {
    try {
        const db = await openDB();
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error(`Failed to delete from IndexedDB (${storeName}):`, error);
        throw error;
    }
}

// Audio storage functions using IndexedDB
async function saveAudioLocally(pageNumber, audioBlob) {
    try {
        const key = `audio_${projectData.id}_page_${pageNumber}`;
        await saveToIndexedDB(AUDIO_STORE, key, audioBlob);
        return true;
    } catch (error) {
        console.error('Failed to save audio locally:', error);
        return false;
    }
}

async function loadAudioLocally(pageNumber) {
    try {
        const key = `audio_${projectData.id}_page_${pageNumber}`;
        const audioBlob = await getFromIndexedDB(AUDIO_STORE, key);
        
        if (audioBlob) {
            if (ttsData[pageNumber]) {
                ttsData[pageNumber].audioBlob = audioBlob;
            } else {
                ttsData[pageNumber] = {
                    audioBlob: audioBlob,
                    text: '', // Will be filled when needed
                    pageNumber: parseInt(pageNumber)
                };
            }
            // Update the audio controls if they exist
            updatePageAudioControls(pageNumber, true);
            updateNarrationActions(pageNumber, true);
        }
    } catch (error) {
        console.error('Failed to load audio locally:', error);
    }
}

async function clearAudioLocally(pageNumber) {
    try {
        const key = `audio_${projectData.id}_page_${pageNumber}`;
        await deleteFromIndexedDB(AUDIO_STORE, key);
    } catch (error) {
        console.error('Failed to clear audio locally:', error);
    }
}

// Define the header once to avoid repetition
const ngrokHeaders = {
    'ngrok-skip-browser-warning': 'true'
};

// ensureModelsLoaded removed - server now loads models by default. Keep a stub for compatibility.
async function ensureModelsLoaded() {
    // Assume models are available on the server by default.
    modelsLoaded = true;
    return true;
}

async function loadTTSModels() {
    const btn = document.getElementById('loadModelsBtn');
    const statusEl = document.getElementById('modelStatus');
    const spinner = document.getElementById('modelLoadingSpinner');
    const statusText = document.getElementById('modelStatusText');
    
    if (btn) btn.disabled = true;
    if (btn) btn.textContent = 'Loading...';
    if (statusEl) statusEl.classList.remove('hidden');
    if (statusText) statusText.textContent = 'Loading TTS models...';
    
    // Loading models via UI is no longer required since server preloads them.
    if (btn) {
        btn.textContent = '✅ Models Loaded (server)';
        btn.style.background = '#10b981';
    }
    if (statusText) statusText.textContent = '✅ Models are loaded on the server by default';
    if (statusEl) statusEl.style.borderLeftColor = '#10b981';
    if (spinner) spinner.style.display = 'none';
    if (btn) btn.disabled = false;
}

async function synthesizeAllPages() {
    const btn = document.getElementById('synthesizeAllBtn');
    const progressEl = document.getElementById('ttsProgress');
    const bar = document.getElementById('ttsBar');
    const label = document.getElementById('ttsLabel');
    const count = document.getElementById('ttsCount');
    const output = document.getElementById('ttsOutput');
    
    // Models are loaded on the server by default; no client-side validation needed
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Synthesizing...';
    progressEl.classList.remove('hidden');
    bar.style.width = '0%';
    label.textContent = 'Starting text-to-speech synthesis...';
    count.textContent = '';
    
    try {
        // Get page narrations from narrative data
        const narrativeData = projectData.workflow?.narrative?.data;
        if (!narrativeData || !narrativeData.page_narrations) {
            throw new Error('No page narrations available. Please generate narrative first.');
        }
        
        const pageNarrations = narrativeData.page_narrations;
        const totalPages = pageNarrations.length;
        let processedPages = 0;
        
        if (totalPages === 0) {
            throw new Error('No page narrations found. Please generate narrative first.');
        }
        
        // Process each page
        for (const [pageLabel, narration] of pageNarrations) {
            if (!narration || !narration.trim()) continue;
            
            try {
                // Update progress
                const progress = Math.round((processedPages / totalPages) * 100);
                bar.style.width = `${progress}%`;
                label.textContent = `Synthesizing page ${processedPages + 1} of ${totalPages}...`;
                count.textContent = `${processedPages}/${totalPages} pages`;
                
                // Call TTS API
                const audioBlob = await synthesizeText(narration);
                
                // Store audio data: upload to server so we persist filename in project JSON
                const pageNumber = pageLabel.replace('Page', '');
                const filename = await uploadAudioBlob(audioBlob, `tts_page_${pageNumber}.wav`);
                ttsData[pageNumber] = {
                    // keep the raw blob in-memory for immediate playback, but persist filename for reloads
                    audioBlob: audioBlob,
                    filename: filename,
                    text: narration,
                    pageNumber: parseInt(pageNumber)
                };
                
                processedPages++;
                
            } catch (error) {
                console.error(`Failed to synthesize page ${pageLabel}:`, error);
                // Continue with other pages
            }
        }
        
        // Update project status
        projectData.workflow.tts.status = 'complete';
        projectData.workflow.tts.data = ttsData;
        
        // Update UI
        updateWorkflowStatus('tts', 'complete');
        bar.style.width = '100%';
        label.textContent = 'Synthesis completed!';
        count.textContent = `${processedPages}/${totalPages} pages`;
        
        // Display results
        displayTTSResults();
        
        // Save to backend
        await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.tts.status': 'complete',
                'workflow.tts.data': sanitizeTTSForSave(ttsData)
            })
        });
        
    } catch (error) {
        console.error('Error synthesizing text:', error);
        alert(`Failed to synthesize text: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Synthesize All Pages';
        setTimeout(() => progressEl.classList.add('hidden'), 2000);
    }
}

async function synthesizePage(pageNumber) {
    const btn = document.getElementById(`synthesize-page-${pageNumber}`);
    if (!btn) return;
    
    // Models are loaded on the server by default; no client-side validation needed
    
    btn.disabled = true;
    btn.textContent = 'Synthesizing...';
    
    try {
        // Get page narration
        const narrativeData = projectData.workflow?.narrative?.data;
        if (!narrativeData || !narrativeData.page_narrations) {
            throw new Error('No page narrations available. Please generate narrative first.');
        }
        
        const pageLabel = `Page${pageNumber}`;
        const narration = narrativeData.page_narrations.find(p => p[0] === pageLabel);
        if (!narration || !narration[1] || !narration[1].trim()) {
            throw new Error(`No narration found for page ${pageNumber}`);
        }
        
        // Call TTS API
        const audioBlob = await synthesizeText(narration[1]);
        
        // Store audio data: upload and persist filename
        const filename = await uploadAudioBlob(audioBlob, `tts_page_${pageNumber}.wav`);
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            filename: filename,
            text: narration,
            pageNumber: parseInt(pageNumber)
        };
        // Save audio locally as well for offline/cache
        await saveAudioLocally(pageNumber, audioBlob);
        
        // Update UI
        btn.textContent = '🎵 Re-synthesize';
        btn.style.background = '#10b981';
        
        // Update page audio controls
        updatePageAudioControls(pageNumber, true);
        
        // Save to backend
        await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.tts.data': sanitizeTTSForSave(ttsData)
            })
        });
        
        // Update project data
        projectData.workflow.tts.data = ttsData;
        
        // Show success message
        const originalText = btn.textContent;
        btn.textContent = '✓ Synthesized';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
        }, 2000);
        
    } catch (error) {
        console.error('Error synthesizing page:', error);
        alert(`Failed to synthesize page ${pageNumber}: ${error.message}`);
        btn.textContent = '🎵 Synthesize Page';
    } finally {
        btn.disabled = false;
    }
}

async function synthesizePageFromEditor(pageNumber) {
    const btn = document.getElementById(`synthesize-panel-editor-${pageNumber}`) || document.getElementById(`synthesize-narration-${pageNumber}`);
    if (!btn) return;
    
    // Models are loaded on the server by default; no client-side validation needed
    
    btn.disabled = true;
    btn.textContent = 'Synthesizing...';
    
    try {
        // Get page narration
        const narrativeData = projectData.workflow?.narrative?.data;
        console.log('Narrative Data:', narrativeData);
        if (!narrativeData || !narrativeData.page_narrations) {
            throw new Error('No page narrations available. Please generate narrative first.');
        }
        
        const pageLabel = `Page${pageNumber}`;
        const narration = narrativeData.page_narrations.find(p => p[0] === pageLabel);
        if (!narration || !narration[1] || !narration[1].trim()) {
            throw new Error(`No narration found for page ${pageNumber}`);
        }
        
        // Call TTS API
        const audioBlob = await synthesizeText(narration[1]);
        
        // Store audio data: upload and persist filename
        const filename = await uploadAudioBlob(audioBlob, `tts_page_${pageNumber}.wav`);
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            filename: filename,
            text: narration,
            pageNumber: parseInt(pageNumber)
        };
        // Save audio locally as well for offline/cache
        await saveAudioLocally(pageNumber, audioBlob);
        
        // Update project data
        projectData.workflow.tts.data = ttsData;
        
        // Replace button with audio player
        updateNarrationActions(pageNumber, true);
        
        // Save to backend
        await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.tts.data': sanitizeTTSForSave(ttsData)
            })
        });
        
    } catch (error) {
        console.error('Error synthesizing page from editor:', error);
        alert(`Failed to synthesize page ${pageNumber}: ${error.message}`);
        btn.textContent = '🎵 Synthesize Narration';
    } finally {
        btn.disabled = false;
    }
}

function updateNarrationActions(pageNumber, hasAudio = false) {
    // Update Panel Editor audio controls if they exist
    const panelEditorAudioActions = document.getElementById(`panel-editor-audio-actions-${pageNumber}`);
    if (panelEditorAudioActions) {
        // Check if page narration exists
        const pageNarrData = projectData?.workflow?.narrative?.data;
        let pageNarration = '';
        if (pageNarrData && pageNarrData.page_narrations) {
            const pageLabel = `Page${pageNumber}`;
            const narrationEntry = pageNarrData.page_narrations.find(p => p[0] === pageLabel);
            if (narrationEntry) {
                pageNarration = narrationEntry[1];
            }
        }
        
        if (!pageNarration) {
            // No narration available
            panelEditorAudioActions.innerHTML = `
                <button class="btn-secondary btn-sm" disabled>
                    🎵 Generate Narrative First
                </button>
            `;
        } else if (hasAudio && ttsData[pageNumber]) {
            // Show default HTML5 audio player with re-synthesize button
            panelEditorAudioActions.innerHTML = `
                <div class="audio-controls-container">
                    <audio controls id="audio-player-panel-editor-${pageNumber}" style="width: 100%; margin-bottom: 8px;">
                        <source src="${getAudioSrc(ttsData[pageNumber].audioBlob)}" type="audio/wav">
                        Your browser does not support the audio element.
                    </audio>
                    <button class="btn-secondary btn-sm" onclick="resynthesizePage(${pageNumber})" id="resynthesize-panel-editor-${pageNumber}">
                        🔄 Re-synthesize
                    </button>
                </div>
            `;
        } else {
            // Show synthesize button
            panelEditorAudioActions.innerHTML = `
                <button class="btn-primary btn-sm" onclick="synthesizePageFromEditor(${pageNumber})" id="synthesize-panel-editor-${pageNumber}">
                    🎵 Synthesize Narration
                </button>
            `;
        }
    }
    
    // Also update page audio controls if they exist
    updatePageAudioControls(pageNumber, hasAudio);
}

function updatePageAudioControls(pageNumber, hasAudio = false) {
    const pageAudioActions = document.getElementById(`page-audio-actions-${pageNumber}`);
    if (!pageAudioActions) return;
    
    // Check if page narration exists
    const pageNarrData = projectData?.workflow?.narrative?.data;
    let pageNarration = '';
    if (pageNarrData && pageNarrData.page_narrations) {
        const pageLabel = `Page${pageNumber}`;
        const narrationEntry = pageNarrData.page_narrations.find(p => p[0] === pageLabel);
        if (narrationEntry) {
            pageNarration = narrationEntry[1];
        }
    }
    
    if (!pageNarration) {
        // No narration available
        pageAudioActions.innerHTML = `
            <button class="btn-secondary btn-sm" disabled>
                🎵 Generate Narrative First
            </button>
        `;
    } else if (hasAudio && ttsData[pageNumber]) {
        // Show default HTML5 audio player with re-synthesize button
        pageAudioActions.innerHTML = `
            <div class="audio-controls-container">
                <audio controls id="audio-player-page-${pageNumber}" style="width: 100%; margin-bottom: 8px;">
                    <source src="${getAudioSrc(ttsData[pageNumber].audioBlob)}" type="audio/wav">
                    Your browser does not support the audio element.
                </audio>
                <button class="btn-secondary btn-sm" onclick="resynthesizePage(${pageNumber})" id="resynthesize-page-${pageNumber}">
                    🔄 Re-synthesize
                </button>
            </div>
        `;
    } else {
        // Show synthesize button
        pageAudioActions.innerHTML = `
            <button class="btn-primary btn-sm" onclick="synthesizePage(${pageNumber})" id="synthesize-page-audio-${pageNumber}">
                🎵 Synthesize Narration
            </button>
        `;
    }
}

async function resynthesizePage(pageNumber) {
    const btn = document.getElementById(`resynthesize-page-${pageNumber}`) || 
                document.getElementById(`resynthesize-tts-${pageNumber}`) || 
                document.getElementById(`resynthesize-panel-editor-${pageNumber}`);
    if (!btn) return;
    
    // Models are loaded on the server by default; no client-side validation needed
    
    btn.disabled = true;
    btn.textContent = 'Re-synthesizing...';
    
    try {
        // Get page narration
        const narrativeData = projectData.workflow?.narrative?.data;
        if (!narrativeData || !narrativeData.page_narrations) {
            throw new Error('No page narrations available. Please generate narrative first.');
        }
        
        const pageLabel = `Page${pageNumber}`;
        const narration = narrativeData.page_narrations.find(p => p[0] === pageLabel);
        if (!narration || !narration[1] || !narration[1].trim()) {
            throw new Error(`No narration found for page ${pageNumber}`);
        }
        
        // Call TTS API
        const audioBlob = await synthesizeText(narration[1]);
        
        // Store audio data: upload and persist filename
        const filename = await uploadAudioBlob(audioBlob, `tts_page_${pageNumber}.wav`);
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            filename: filename,
            text: narration[1],
            pageNumber: parseInt(pageNumber)
        };
        // Save audio locally as well
        await saveAudioLocally(pageNumber, audioBlob);
        
        // Update page audio controls
        updatePageAudioControls(pageNumber, true);
        
        // Update TTS output display if it exists
        const ttsAudioPlayer = document.getElementById(`audio-player-${pageNumber}`);
        if (ttsAudioPlayer) {
            ttsAudioPlayer.innerHTML = `
                <source src="${getAudioSrc(audioBlob)}" type="audio/wav">
                Your browser does not support the audio element.
            `;
        }
        
        // Update Panel Editor audio player if it exists
        const panelEditorAudioPlayer = document.getElementById(`audio-player-panel-editor-${pageNumber}`);
        if (panelEditorAudioPlayer) {
            panelEditorAudioPlayer.innerHTML = `
                <source src="${getAudioSrc(audioBlob)}" type="audio/wav">
                Your browser does not support the audio element.
            `;
        }
        
        // Save to backend
        await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.tts.data': ttsData
            })
        });
        
        // Update project data
        projectData.workflow.tts.data = ttsData;
        
        // Show success message
        const originalText = btn.textContent;
        btn.textContent = '✓ Re-synthesized';
        btn.style.background = '#10b981';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
        }, 2000);
        
    } catch (error) {
        console.error('Error re-synthesizing page:', error);
        alert(`Failed to re-synthesize page ${pageNumber}: ${error.message}`);
        btn.textContent = '🔄 Re-synthesize';
    } finally {
        btn.disabled = false;
    }
}

async function synthesizeText(text) {
    if (!text || !text.trim()) {
        throw new Error('No text provided for TTS synthesis');
    }

    const formData = new FormData();
    // Keep form data for TTS API but the backend FastAPI endpoint expects
    // the `text` value as a query parameter, so include it in the URL below.
    formData.append('text', text);
    formData.append('exaggeration', '0.5');
    formData.append('cfg_weight', '0.5');
    formData.append('temperature', '0.8');
    
    const url = `/api/manga/${projectData.id}/tts/synthesize?text=${encodeURIComponent(text)}`;
    const response = await fetch(url, {
        method: 'POST',
        body: formData
    });
    
    if (!response.ok) {
        const txt = await response.text();
        throw new Error(`TTS API error: ${response.status} ${txt}`);
    }
    
    return await response.blob();
}

function displayTTSResults() {
    const output = document.getElementById('ttsOutput');
    if (!output) return;
    
    output.innerHTML = '';
    
    // Display each page with audio
    Object.keys(ttsData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(pageNumber => {
        const data = ttsData[pageNumber];
        if (!data) return;
        
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page-panels-container';
        
        const details = document.createElement('details');
        details.innerHTML = `
            <summary class="page-header">
                <div class="page-title">
                    <h4>Page ${pageNumber} - Audio Synthesis</h4>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="panel-count">Audio Available</span>
                    </div>
                </div>
                <span class="page-collapsible-caret">▼</span>
            </summary>
        `;
        
        const content = document.createElement('div');
        content.className = 'page-collapsible-content';
        
        // Add page narration text
        const narrationDiv = document.createElement('div');
        narrationDiv.className = 'panel-narration';
        narrationDiv.innerHTML = `
            <strong>Page Narration:</strong>
            <p>${data.text}</p>
        `;
        content.appendChild(narrationDiv);
        
        // Add default HTML5 audio player
        const audioDiv = document.createElement('div');
        audioDiv.className = 'audio-controls-container';
                audioDiv.innerHTML = `
            <audio controls id="audio-player-${pageNumber}" style="width: 100%; margin-bottom: 8px;">
                <source src="${getAudioSrc(data)}" type="audio/wav">
                Your browser does not support the audio element.
            </audio>
            <button class="btn-secondary btn-sm" onclick="resynthesizePage(${pageNumber})" id="resynthesize-tts-${pageNumber}">
                🔄 Re-synthesize
            </button>
        `;
        content.appendChild(audioDiv);
        
        details.appendChild(content);
        pageDiv.appendChild(details);
        output.appendChild(pageDiv);
    });
    
    output.classList.remove('hidden');
}


// Audio Player Functions - Using default HTML5 audio player
// Custom audio player functions removed as we now use default HTML5 audio controls

function updatePanelStats() {
    const textareas = document.querySelectorAll('.panel-editor-textarea');
    const totalPanels = textareas.length;
    let filledPanels = 0;
    
    textareas.forEach(textarea => {
        const hasText = textarea.value.trim();
        if (hasText) {
            filledPanels++;
        }
        
        // Update visual indicators
        const panelLabel = textarea.parentElement.querySelector('.panel-editor-label');
        if (panelLabel) {
            const baseText = panelLabel.textContent.replace(' ✓', '');
            panelLabel.textContent = hasText ? baseText + ' ✓' : baseText;
        }
        
        // Update textarea styling
        if (hasText) {
            textarea.classList.add('has-text');
        } else {
            textarea.classList.remove('has-text');
        }
    });
    
    const statsDiv = document.getElementById('panelEditorStats');
    statsDiv.textContent = `${filledPanels}/${totalPanels} panels have text assigned`;
}

function closePanelEditor() {
    const modal = document.getElementById('panelEditorModal');
    modal.style.display = 'none';
    currentEditingPage = null;
    originalPanelTexts = {};
    
    // Clear all pages sidebar
    const allPagesSidebar = document.querySelector('.all-pages-sidebar');
    if (allPagesSidebar) {
        allPagesSidebar.remove();
    }
}

// New function to open panel editor from workflow buttons
function openPanelEditorFromWorkflow() {
    if (!projectData.workflow?.panels?.data || projectData.workflow.panels.data.length === 0) {
        alert('Please detect panels first before opening the panel editor.');
        return;
    }
    
    // Open panel editor on the first page
    const firstPage = projectData.workflow.panels.data[0];
    if (firstPage) {
        openPanelEditor(firstPage.page_number);
    }
}

// New function to match text to current page in panel editor
async function matchTextToCurrentPage() {
    if (!currentEditingPage) {
        alert('No page is currently being edited.');
        return;
    }
    
    const btn = document.getElementById('matchTextToPageBtn');
    const originalText = btn.textContent;
    
    btn.disabled = true;
    btn.textContent = 'Matching...';
    
    try {
        const response = await fetch(`/api/manga/${projectData.id}/text-matching/page/${currentEditingPage}/redo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Text matching API error:', response.status, errorText);
            throw new Error(`Failed to match text to panels: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        console.log('Text matching response:', data);
        
        // Update project data
        if (!projectData.workflow.text_matching) {
            projectData.workflow.text_matching = { status: 'complete', data: [] };
        }
        const tmData = projectData.workflow.text_matching.data || [];
        const pageIndex = tmData.findIndex(p => p.page_number === currentEditingPage);
        if (pageIndex >= 0) {
            tmData[pageIndex] = data.page;
        } else {
            tmData.push(data.page);
        }
        projectData.workflow.text_matching.data = tmData;
        projectData.workflow.text_matching.status = 'complete';

        // Refresh the panel editor content
        openPanelEditor(currentEditingPage);
        
        alert('Text matching completed for this page!');
        
    } catch (error) {
        console.error('Error matching text to current page:', error);
        alert(`Failed to match text to panels for this page: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// New function to match text to panels for all pages
async function matchTextToAllPages() {
    const btn = document.getElementById('matchTextToAllPagesBtn');
    const overwriteCheckbox = document.getElementById('overwriteExistingTextCheckbox');
    const originalText = btn.textContent;
    const overwriteExisting = overwriteCheckbox.checked;
    
    // Confirm the action
    const confirmMessage = overwriteExisting 
        ? 'This will match text to panels for ALL pages and overwrite any existing text. This may take several minutes. Continue?'
        : 'This will match text to panels for ALL pages that don\'t already have text assigned. This may take several minutes. Continue?';
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    btn.disabled = true;
    btn.textContent = 'Processing...';
    
    try {
        // Get all pages that have panels
        const panelsData = projectData.workflow?.panels?.data || [];
        if (panelsData.length === 0) {
            alert('No panels detected yet. Please run panel detection first.');
            return;
        }
        
        // Filter pages based on overwrite setting
        let pagesToProcess = panelsData;
        if (!overwriteExisting) {
            // Only process pages that don't have existing text matching
            const textMatchingData = projectData.workflow?.text_matching?.data || [];
            pagesToProcess = panelsData.filter(pageData => {
                const existingTmData = textMatchingData.find(tm => tm.page_number === pageData.page_number);
                return !existingTmData || !existingTmData.panels || existingTmData.panels.length === 0;
            });
        }
        
        if (pagesToProcess.length === 0) {
            alert('No pages need text matching. All pages already have text assigned.');
            return;
        }
        
        console.log(`Processing ${pagesToProcess.length} pages for text matching`);
        btn.textContent = `Processing ${pagesToProcess.length} pages...`;
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        // Process pages sequentially to avoid overwhelming the server
        for (let i = 0; i < pagesToProcess.length; i++) {
            const pageData = pagesToProcess[i];
            const pageNumber = pageData.page_number;
            
            try {
                btn.textContent = `Processing page ${pageNumber} (${i + 1}/${pagesToProcess.length})...`;
                
                const response = await fetch(`/api/manga/${projectData.id}/text-matching/page/${pageNumber}/redo`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Text matching API error for page ${pageNumber}:`, response.status, errorText);
                    throw new Error(`Page ${pageNumber}: ${response.status} ${errorText}`);
                }
                
                const data = await response.json();
                console.log(`Text matching response for page ${pageNumber}:`, data);
                
                // Update project data
                if (!projectData.workflow.text_matching) {
                    projectData.workflow.text_matching = { status: 'complete', data: [] };
                }
                const tmData = projectData.workflow.text_matching.data || [];
                const pageIndex = tmData.findIndex(p => p.page_number === pageNumber);
                if (pageIndex >= 0) {
                    tmData[pageIndex] = data.page;
                } else {
                    tmData.push(data.page);
                }
                projectData.workflow.text_matching.data = tmData;
                
                successCount++;
                
                // Add a small delay to avoid overwhelming the server
                if (i < pagesToProcess.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
            } catch (error) {
                console.error(`Error matching text for page ${pageNumber}:`, error);
                errors.push(`Page ${pageNumber}: ${error.message}`);
                errorCount++;
            }
        }
        
        // Update workflow status
        if (successCount > 0) {
            projectData.workflow.text_matching.status = 'complete';
        }
        
        // Show results
        let resultMessage = `Text matching completed!\n\nSuccessfully processed: ${successCount} pages`;
        if (errorCount > 0) {
            resultMessage += `\nFailed: ${errorCount} pages`;
            if (errors.length > 0) {
                resultMessage += `\n\nErrors:\n${errors.slice(0, 5).join('\n')}`;
                if (errors.length > 5) {
                    resultMessage += `\n... and ${errors.length - 5} more errors`;
                }
            }
        }
        
        alert(resultMessage);
        
        // Refresh the current panel editor if it's open
        if (currentEditingPage) {
            openPanelEditor(currentEditingPage);
        }
        
    } catch (error) {
        console.error('Error in matchTextToAllPages:', error);
        alert(`Failed to process text matching for all pages: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// New function to detect panels for current page in panel editor
async function detectPanelsForCurrentPage() {
    if (!currentEditingPage) {
        alert('No page is currently being edited.');
        return;
    }
    
    const btn = document.getElementById('detectPanelsForPageBtn');
    const originalText = btn.textContent;
    
    btn.disabled = true;
    btn.textContent = 'Detecting...';
    
    try {
        const response = await fetch(`/api/manga/${projectData.id}/panels/page/${currentEditingPage}/redo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Panel detection API error:', response.status, errorText);
            throw new Error(`Failed to detect panels: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        console.log('Panel detection response:', data);
        
        // Update project data
        if (!projectData.workflow.panels) {
            projectData.workflow.panels = { status: 'complete', data: [] };
        }
        const panelsData = projectData.workflow.panels.data || [];
        const pageIndex = panelsData.findIndex(p => p.page_number === currentEditingPage);
        if (pageIndex >= 0) {
            panelsData[pageIndex] = data.page;
        } else {
            panelsData.push(data.page);
        }
        projectData.workflow.panels.data = panelsData;
        projectData.workflow.panels.status = 'complete';

        // Refresh the panel editor content
        openPanelEditor(currentEditingPage);
        
        alert('Panel detection completed for this page!');
        
    } catch (error) {
        console.error('Error detecting panels for current page:', error);
        alert(`Failed to detect panels for this page: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function createAllPagesSidebar(activePageNumber) {
    const sidebar = document.querySelector('.panel-editor-sidebar');
    
    // Replace entire sidebar content with just the all pages section
    sidebar.innerHTML = `
        <div class="all-pages-sidebar">
            <h3>All Pages</h3>
            <div class="pages-container">
                ${projectData.files.map((filename, index) => {
                    const pageNumber = index + 1;
                    const pageImageUrl = `/uploads/${filename}`;
                    const isActive = pageNumber === activePageNumber;
                    
                    return `
                        <div class="page-sidebar-item ${isActive ? 'active' : ''}" data-page="${pageNumber}" onclick="navigateToPageFromSidebar(${pageNumber})">
                            <div class="page-sidebar-title">Page ${pageNumber}</div>
                            <img src="${pageImageUrl}" alt="Page ${pageNumber}" class="page-sidebar-image" onclick="event.stopPropagation(); viewPanelFullscreen('${pageImageUrl}', '${filename}')">
                            <div class="page-sidebar-info">${filename}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    
    // Scroll to active page
    scrollToActivePageInSidebar(activePageNumber);
}

function scrollToActivePageInSidebar(pageNumber) {
    const allPagesSidebar = document.querySelector('.all-pages-sidebar');
    if (!allPagesSidebar) return;
    
    const activeItem = allPagesSidebar.querySelector(`[data-page="${pageNumber}"]`);
    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function navigateToPageFromSidebar(pageNumber) {
    if (pageNumber === currentEditingPage) return;
    
    // Save current changes before navigating
    savePanelTexts().then(() => {
        // Navigate to new page
        openPanelEditor(pageNumber);
    }).catch(() => {
        // If save fails, still navigate
        openPanelEditor(pageNumber);
    });
}

function updatePanelEditorNavigation(pageNumber) {
    const totalPages = projectData.files.length;
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const pageInfo = document.getElementById('pageInfo');
    
    if (prevBtn) prevBtn.disabled = pageNumber <= 1;
    if (nextBtn) nextBtn.disabled = pageNumber >= totalPages;
    if (pageInfo) {
        pageInfo.textContent = `Page ${pageNumber} of ${totalPages}`;
    }
}

function navigateToPage(direction) {
    if (!currentEditingPage) return;
    
    const totalPages = projectData.files.length;
    const newPage = currentEditingPage + direction;
    
    if (newPage >= 1 && newPage <= totalPages) {
        // Save current changes before navigating
        savePanelTexts().then(() => {
            // Navigate to new page
            openPanelEditor(newPage);
        }).catch(() => {
            // If save fails, still navigate
            openPanelEditor(newPage);
        });
    }
}

function initializeDragAndDrop() {
    const panelsGrid = document.getElementById('panelsGridEditor');
    if (!panelsGrid) return;
    
    const panelItems = panelsGrid.querySelectorAll('.panel-editor-item');
    let draggedElement = null;
    
    panelItems.forEach(item => {
        // Drag start
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/html', item.outerHTML);
        });
        
        // Drag end
        item.addEventListener('dragend', (e) => {
            item.classList.remove('dragging');
            panelItems.forEach(el => el.classList.remove('drag-over'));
            draggedElement = null;
        });
        
        // Drag over
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drag-over');
        });
        
        // Drag leave
        item.addEventListener('dragleave', (e) => {
            item.classList.remove('drag-over');
        });
        
        // Drop
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            
            if (draggedElement && draggedElement !== item) {
                const draggedIndex = parseInt(draggedElement.dataset.panelIndex);
                const targetIndex = parseInt(item.dataset.panelIndex);
                
                // Reorder panels
                reorderPanels(draggedIndex, targetIndex);
            }
        });
    });
}

function reorderPanels(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    
    // Get current panel data
    const panelsData = projectData.workflow?.panels?.data || [];
    const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(currentEditingPage));
    
    if (!pageData || !pageData.panels) return;
    
    // Collect current text content from textareas
    const textareas = document.querySelectorAll('.panel-editor-textarea');
    const currentTexts = Array.from(textareas).map(textarea => textarea.value);
    
    // Reorder the panels array (effect travels with its panel)
    const panels = pageData.panels;
    const movedPanel = panels.splice(fromIndex, 1)[0];
    panels.splice(toIndex, 0, movedPanel);
    
    // Reorder the text content array to match the new panel order
    const movedText = currentTexts.splice(fromIndex, 1)[0];
    currentTexts.splice(toIndex, 0, movedText);
    
    // Update panel matched_text with the reordered text content
    panels.forEach((panel, index) => {
        panel.matched_text = currentTexts[index] || '';
        
        // Update panel properties to reflect new index
        panel.panel_index = index;
        
        // Update filename if it contains panel numbering
        const oldFilename = panel.filename;
        if (oldFilename.includes('panel_')) {
            // Replace panel number in filename (e.g., panel_01 -> panel_00, panel_02 -> panel_01)
            const newFilename = oldFilename.replace(/panel_(\d+)/, (match, num) => {
                const paddedIndex = String(index + 1).padStart(2, '0');
                return `panel_${paddedIndex}`;
            });
            panel.filename = newFilename;
        }
    });
    
    // Update panel data
    projectData.workflow.panels.data = panelsData;
    
    // Also update text matching data if it exists
    const textMatchingData = projectData.workflow?.text_matching?.data || [];
    const tmPageData = textMatchingData.find(p => parseInt(p.page_number) === parseInt(currentEditingPage));
    
    if (tmPageData && tmPageData.panels) {
        // Reorder text matching panels to match the new order
        const tmPanels = tmPageData.panels;
        const movedTmPanel = tmPanels.splice(fromIndex, 1)[0];
        tmPanels.splice(toIndex, 0, movedTmPanel);
        
        // Update text matching panel texts
        tmPanels.forEach((panel, index) => {
            panel.matched_text = currentTexts[index] || '';
        });
        
        projectData.workflow.text_matching.data = textMatchingData;
    }
    
    // Re-render the panel editor
    openPanelEditor(currentEditingPage);
    
    // Show success message
    const statsDiv = document.getElementById('panelEditorStats');
    const originalText = statsDiv.textContent;
    statsDiv.textContent = 'Panels and text reordered successfully!';
    setTimeout(() => {
        statsDiv.textContent = originalText;
    }, 2000);
}

async function savePanelTexts() {
    if (!currentEditingPage) return Promise.resolve();
    
    const saveBtn = document.getElementById('savePanelTextsBtn');
    const textareas = document.querySelectorAll('.panel-editor-textarea');
    
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="loading"></span> Saving...';
    
    try {
        // Collect panel texts and effects
        const panelTexts = {};
        const panelEffects = {};
        const panelTransitions = {};
        
        textareas.forEach(textarea => {
            const panelIndex = parseInt(textarea.dataset.panelIndex);
            panelTexts[panelIndex] = textarea.value.trim();
        });
        
        // Collect effect selections
        const effectSelects = document.querySelectorAll('.panel-effect-select');
        effectSelects.forEach(select => {
            const panelIndex = parseInt(select.dataset.panelIndex);
            panelEffects[panelIndex] = select.value;
        });
        
        // Collect transition selections
        const transitionSelects = document.querySelectorAll('.panel-transition-select');
        transitionSelects.forEach(select => {
            const panelIndex = parseInt(select.dataset.panelIndex);
            panelTransitions[panelIndex] = select.value;
        });
        
        // Get current panels data
        const panelsData = projectData.workflow?.panels?.data || [];
        const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(currentEditingPage));
        
        if (!pageData) {
            throw new Error('Page data not found');
        }
        
        // Update panel texts and effects
        pageData.panels.forEach((panel, index) => {
            panel.matched_text = panelTexts[index] || '';
            // Persist selected effect (default to none)
            panel.effect = panelEffects[index] || panel.effect || 'none';
            // Persist selected transition (default to slide_book for panels after first)
            panel.transition = panelTransitions[index] || panel.transition || (index === 0 ? 'none' : 'slide_book');
        });
        
        // Update project data
        projectData.workflow.panels.data = panelsData;
        
        // Save to backend
        const response = await fetch(`/api/manga/${projectData.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'workflow.panels.data': panelsData
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to save panel texts');
        }
        
        // Update text matching data if it exists
        const textMatchingData = projectData.workflow?.text_matching?.data || [];
        const tmPageData = textMatchingData.find(p => parseInt(p.page_number) === parseInt(currentEditingPage));
        
        if (tmPageData) {
            // Update text matching data as well
            tmPageData.panels.forEach((panel, index) => {
                panel.matched_text = panelTexts[index] || '';
            });
            
            // Save text matching data
            await fetch(`/api/manga/${projectData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    'workflow.text_matching.data': textMatchingData
                })
            });
            
            // Update local data
            projectData.workflow.text_matching.data = textMatchingData;
        }
        
        // Panel texts saved successfully - no need to refresh main view displays
        
        // Show success message in stats
        const statsDiv = document.getElementById('panelEditorStats');
        const originalText = statsDiv.textContent;
        statsDiv.textContent = 'Panel texts saved successfully!';
        statsDiv.style.color = '#10b981';
        setTimeout(() => {
            statsDiv.textContent = originalText;
            statsDiv.style.color = '';
        }, 2000);
        
    } catch (error) {
        console.error('Error saving panel texts:', error);
        alert(`Failed to save panel texts: ${error.message}`);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

// Panel TTS Functions
async function synthesizeAllPanels() {
    console.log('synthesizeAllPanels() function called');
    const btn = document.getElementById('synthesizeAllPanelsBtn');
    const progressEl = document.getElementById('panelTtsProgress');
    const bar = document.getElementById('panelTtsBar');
    const label = document.getElementById('panelTtsLabel');
    const count = document.getElementById('panelTtsCount');
    
    console.log('Button and progress elements found:', {btn: !!btn, progressEl: !!progressEl});
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Synthesizing...';
    progressEl.classList.remove('hidden');
    bar.style.width = '0%';
    label.textContent = 'Starting panel text-to-speech synthesis...';
    count.textContent = '';
    
    try {
        // Check if text matching is complete
        const textMatchingData = projectData.workflow?.text_matching?.data;
        if (!textMatchingData || textMatchingData.length === 0) {
            throw new Error('Text matching not completed. Please match text to panels first.');
        }
        
        // Update UI to show we're making the request
        label.textContent = 'Calling panel TTS API...';
        
        // Call the panel TTS API
        console.log('Making panel TTS request to:', `/api/manga/${projectData.id}/panel-tts/synthesize`);
        const response = await fetch(`/api/manga/${projectData.id}/panel-tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('Panel TTS response status:', response.status);
        label.textContent = `API responded with status: ${response.status}`;
        
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Panel TTS error:', errorData);
            throw new Error(errorData.detail || 'Failed to synthesize panel TTS');
        }
        
        const data = await response.json();
        
        // Update project data
        projectData.workflow.panel_tts = {
            status: 'complete',
            data: data.data
        };
        
        // Update UI
        updateWorkflowStatus('panel_tts', 'complete');
        bar.style.width = '100%';
        label.textContent = 'Panel synthesis completed!';
        count.textContent = `${data.processed_panels}/${data.panels_with_text || data.total_panels} panels with text`;
        
        // Update panel editor if open
        if (currentEditingPage) {
            loadPanelEditorContent(currentEditingPage);
        }
        
        const message = data.message || `Panel TTS synthesis completed! Processed ${data.processed_panels} out of ${data.panels_with_text || data.total_panels} panels with text.`;
        alert(message);
        
        // Show the video editor button if synthesis was successful
        if (data.processed_panels > 0) {
            const videoEditorBtn = document.getElementById('openVideoEditorBtn');
            if (videoEditorBtn) {
                videoEditorBtn.style.display = 'inline-block';
            }
        }
        
    } catch (error) {
        console.error('Error synthesizing panel TTS:', error);
        alert(`Failed to synthesize panel TTS: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Synthesize All Panels';
        setTimeout(() => progressEl.classList.add('hidden'), 2000);
    }
}

// Make function globally available
window.synthesizeAllPanels = synthesizeAllPanels;

// Function to open video editor with panel data
function openVideoEditorWithPanels() {
    const panelTtsData = projectData.workflow?.panel_tts?.data;
    if (!panelTtsData) {
        alert('No panel TTS data found. Please synthesize panels first.');
        return;
    }
    
    // Build panels metadata map: { pageNumber: [ { filename, effect, transition } ] }
    const panelsMeta = {};
    try{
        const panelsData = projectData.workflow?.panels?.data || [];
        panelsData.forEach(page => {
            const pn = parseInt(page.page_number);
            panelsMeta[pn] = (page.panels || []).map((p, index) => ({ 
                filename: p.filename, 
                effect: p.effect || 'none',
                transition: p.transition || (index === 0 ? 'none' : 'slide_book')
            }));
        });
    }catch(e){ console.warn('Failed to build panelsMeta', e); }

    // Store panel data for video editor
    sessionStorage.setItem('panelVideoData', JSON.stringify({
        projectId: projectData.id,
        projectTitle: projectData.title,
        panelTtsData: panelTtsData,
        panelsMeta: panelsMeta,
        mode: 'panels'
    }));
    
    // Open video editor in new tab
    window.open('/video_editor.html', '_blank');
}

// Make function globally available  
window.openVideoEditorWithPanels = openVideoEditorWithPanels;

async function synthesizeCurrentPagePanels() {
    if (!currentEditingPage) {
        alert('No page is currently being edited.');
        return;
    }
    
    const btn = document.getElementById('synthesizeCurrentPageBtn');
    const originalText = btn.textContent;
    
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Synthesizing...';
    
    try {
        // Call the panel TTS API for current page only
        const response = await fetch(`/api/manga/${projectData.id}/panel-tts/synthesize?page_number=${currentEditingPage}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to synthesize panel TTS');
        }
        
        const data = await response.json();
        
        // Update project data
        if (!projectData.workflow.panel_tts) {
            projectData.workflow.panel_tts = { status: 'complete', data: {} };
        }
        Object.assign(projectData.workflow.panel_tts.data, data.data);
        
        // Update UI
        loadPanelEditorContent(currentEditingPage);
        
        const message = data.message || `Page ${currentEditingPage} panel TTS synthesis completed! Processed ${data.processed_panels} panels with text.`;
        alert(message);
        
    } catch (error) {
        console.error('Error synthesizing current page panels:', error);
        alert(`Failed to synthesize page panels: ${error.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// Make function globally available
window.synthesizeCurrentPagePanels = synthesizeCurrentPagePanels;

async function synthesizeAllPanelsFromEditor() {
    console.log('synthesizeAllPanelsFromEditor called');
    try {
        // Use the same function as the main workflow
        await synthesizeAllPanels();
    } catch (error) {
        console.error('Error in synthesizeAllPanelsFromEditor:', error);
        showToast('Error synthesizing panels: ' + error.message, 'error');
    }
}

// Make function globally available
window.synthesizeAllPanelsFromEditor = synthesizeAllPanelsFromEditor;

// Delete panel functionality
async function deletePanel(pageNumber, panelIndex) {
    if (!confirm(`Are you sure you want to delete Panel ${panelIndex + 1}? This action cannot be undone.`)) {
        return;
    }

    try {
        console.log(`Deleting panel ${panelIndex} from page ${pageNumber}`);
        
        // Find the page data
        const panelsData = projectData.workflow?.panels?.data || [];
        const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
        
        if (!pageData || !pageData.panels) {
            throw new Error('Page data not found');
        }
        
        if (panelIndex < 0 || panelIndex >= pageData.panels.length) {
            throw new Error('Invalid panel index');
        }
        
        if (pageData.panels.length <= 1) {
            if (!confirm('This is the last panel on this page. Deleting it will leave the page with no panels. Continue?')) {
                return;
            }
        }
        
        const panelToDelete = pageData.panels[panelIndex];
        console.log('Panel to delete:', panelToDelete);
        
        // Store original panel count for validation
        const originalPanelCount = pageData.panels.length;
        
        // Remove the panel from the array
        pageData.panels.splice(panelIndex, 1);
        
        // Renumber remaining panels
        pageData.panels.forEach((panel, newIndex) => {
            // Update panel properties to reflect new index
            panel.panel_index = newIndex;
            
            // Update filename if it contains panel numbering
            const oldFilename = panel.filename;
            if (oldFilename.includes('panel_')) {
                // Replace panel number in filename (e.g., panel_01 -> panel_00, panel_02 -> panel_01)
                const newFilename = oldFilename.replace(/panel_(\d+)/, (match, num) => {
                    const paddedIndex = String(newIndex + 1).padStart(2, '0');
                    return `panel_${paddedIndex}`;
                });
                panel.filename = newFilename;
            }
        });
        
        // Validate that we actually removed a panel
        if (pageData.panels.length !== originalPanelCount - 1) {
            throw new Error('Panel deletion validation failed - incorrect panel count after deletion');
        }
        
        // Also clean up related data
        
        // Remove from text matching data if exists
        const textMatchingData = projectData.workflow?.text_matching?.data || [];
        const tmPageData = textMatchingData.find(p => parseInt(p.page_number) === parseInt(pageNumber));
        if (tmPageData && tmPageData.panels && tmPageData.panels.length > panelIndex) {
            tmPageData.panels.splice(panelIndex, 1);
            console.log('Removed panel from text matching data');
        }
        
        // Remove from panel TTS data if exists
        const panelTtsData = projectData.workflow?.panel_tts?.data;
        if (panelTtsData) {
            const pageKey = `page${pageNumber}`;
            if (panelTtsData[pageKey]) {
                // Store original count for validation
                const originalTtsCount = panelTtsData[pageKey].length;
                
                // Remove the panel's TTS data
                panelTtsData[pageKey] = panelTtsData[pageKey].filter(tts => tts.panelIndex !== panelIndex);
                
                // Renumber remaining panel TTS data
                panelTtsData[pageKey].forEach(tts => {
                    if (tts.panelIndex > panelIndex) {
                        tts.panelIndex = tts.panelIndex - 1;
                    }
                });
                
                console.log(`TTS data: removed ${originalTtsCount - panelTtsData[pageKey].length} entries, renumbered remaining`);
            }
        }
        
        // Remove from original panel texts cache
        if (originalPanelTexts) {
            delete originalPanelTexts[panelIndex];
            // Renumber remaining original texts
            const updatedOriginalTexts = {};
            Object.keys(originalPanelTexts).forEach(key => {
                const oldIndex = parseInt(key);
                if (oldIndex > panelIndex) {
                    updatedOriginalTexts[oldIndex - 1] = originalPanelTexts[key];
                } else if (oldIndex < panelIndex) {
                    updatedOriginalTexts[key] = originalPanelTexts[key];
                }
            });
            originalPanelTexts = updatedOriginalTexts;
            console.log('Updated original panel texts cache');
        }
        
        // Save the updated project data
        const response = await fetch('/api/manga/update-panels', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                project_id: projectData.id,
                page_number: pageNumber,
                panels: pageData.panels,
                deleted_panel: panelToDelete
            })
        });
        
        if (!response.ok) {
            let errorMessage = 'Failed to update panels on server';
            try {
                const errorData = await response.json();
                errorMessage = errorData.detail || errorMessage;
            } catch (parseError) {
                console.warn('Could not parse error response:', parseError);
            }
            throw new Error(errorMessage);
        }
        
        const result = await response.json();
        console.log('Panel deletion result:', result);
        
        // Reload the panel editor content to reflect changes
        loadPanelEditorContent(pageNumber);
        
        // Update panel stats
        updatePanelStats();
        
        // Show success message
        const successMessage = pageData.panels.length === 0 
            ? `Panel ${panelIndex + 1} deleted successfully. Page now has no panels.`
            : `Panel ${panelIndex + 1} deleted successfully. Remaining ${pageData.panels.length} panels have been renumbered.`;
        showToast(successMessage, 'success');
        
    } catch (error) {
        console.error('Error deleting panel:', error);
        
        // Try to restore the panel if we modified data locally but failed to save
        try {
            // Reload the panel editor to restore the original state
            loadPanelEditorContent(pageNumber);
        } catch (restoreError) {
            console.error('Failed to restore panel editor state:', restoreError);
        }
        
        showToast(`Failed to delete panel: ${error.message}`, 'error');
    }
}

// Simple toast notification function
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 16px;
        border-radius: 6px;
        color: white;
        font-weight: 500;
        z-index: 10000;
        max-width: 300px;
        word-wrap: break-word;
    `;
    
    switch (type) {
        case 'success':
            toast.style.backgroundColor = '#10b981';
            break;
        case 'error':
            toast.style.backgroundColor = '#ef4444';
            break;
        default:
            toast.style.backgroundColor = '#3b82f6';
    }
    
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 3000);
}

// Make functions globally available
window.deletePanel = deletePanel;
window.showToast = showToast;

async function synthesizeIndividualPanel(pageNumber, panelIndex) {
    // Get the current text for this panel
    const textarea = document.querySelector(`[data-panel-index="${panelIndex}"]`);
    if (!textarea) {
        alert('Panel not found.');
        return;
    }
    
    const text = textarea.value.trim();
    if (!text) {
        alert('Please enter text for this panel first.');
        return;
    }
    
    try {
        // Call the single panel TTS API
        const response = await fetch(`/api/manga/${projectData.id}/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text })
        });
        
        if (!response.ok) {
            throw new Error('Failed to synthesize panel audio');
        }
        
        // Get the audio blob
        const audioBlob = await response.blob();
        
        // Upload the audio file
        const audioFilename = await uploadAudioBlob(audioBlob, `tts_page_${pageNumber}_panel_${panelIndex + 1}.wav`);
        
        // Update project data
        if (!projectData.workflow.panel_tts) {
            projectData.workflow.panel_tts = { status: 'complete', data: {} };
        }
        if (!projectData.workflow.panel_tts.data[`page${pageNumber}`]) {
            projectData.workflow.panel_tts.data[`page${pageNumber}`] = [];
        }
        
        // Find or create panel data entry
        let panelData = projectData.workflow.panel_tts.data[`page${pageNumber}`].find(p => p.panelIndex === panelIndex);
        if (!panelData) {
            panelData = {
                panelIndex: panelIndex,
                filename: '',
                text: text,
                audioFile: audioFilename,
                duration: Math.max(text.length * 0.05, 1.0)
            };
            projectData.workflow.panel_tts.data[`page${pageNumber}`].push(panelData);
        } else {
            panelData.text = text;
            panelData.audioFile = audioFilename;
            panelData.duration = Math.max(text.length * 0.05, 1.0);
        }
        
        // Update the UI
        loadPanelEditorContent(pageNumber);
        
        alert('Panel audio synthesized successfully!');
        
    } catch (error) {
        console.error('Error synthesizing individual panel:', error);
        alert(`Failed to synthesize panel audio: ${error.message}`);
    }
}

// Make function globally available
window.synthesizeIndividualPanel = synthesizeIndividualPanel;

// Panel Image Editing Functionality - Enhanced
let currentEditingPanel = null;
let cropCanvas = null;
let cropContext = null;
let previewCanvas = null;
let previewContext = null;
let originalImage = null;

// Crop modes and data
let cropMode = 'rectangle'; // 'rectangle' or 'freeform'
let rectangleCrop = null;
let freeformPoints = [];

// Rectangle cropping variables
let isDragging = false;
let isResizing = false;
let resizeHandle = null;
let dragStart = { x: 0, y: 0 };
let maintainAspectRatio = false;

// Zoom functionality variables
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let lastPanX = 0;
let lastPanY = 0;

// Add New Panel Functionality - Enhanced
let addPanelCanvas = null;
let addPanelContext = null;
let addPanelPreviewCanvas = null;
let addPanelPreviewContext = null;
let addPanelImage = null;
let addPanelCropMode = 'rectangle';
let addPanelRectangleCrop = null;
let addPanelFreeformPoints = [];
let addPanelDragState = { isDragging: false, dragType: '', startX: 0, startY: 0, originalCrop: null };
let currentPageForNewPanel = null;
let addPanelZoomLevel = 1;
let addPanelPanX = 0;
let addPanelPanY = 0;

// Additional add panel variables
let addPanelDragging = false;
let addPanelResizing = false;
let addPanelResizeHandle = null;
let addPanelDragStart = { x: 0, y: 0 };
let addPanelMaintainAspect = false;

// Global mouse event handlers for crop functionality
function handleCropMouseDown(e) {
    const rect = cropCanvas.getBoundingClientRect();
    // Adjust coordinates for zoom and pan
    const x = (e.clientX - rect.left - panX) / zoomLevel;
    const y = (e.clientY - rect.top - panY) / zoomLevel;
    
    console.log('Mouse down at:', x, y, 'zoom:', zoomLevel);
    
    if (cropMode === 'freeform') {
        // Add point for freeform crop
        if (freeformPoints.length < 4) {
            freeformPoints.push({ x, y });
            updateFreeformPointsDisplay();
            drawImage();
        }
        return;
    }
    
    if (cropMode === 'rectangle') {
        handleRectangleMouseDown(x, y);
    }
}

function handleCropMouseMove(e) {
    const rect = cropCanvas.getBoundingClientRect();
    // Adjust coordinates for zoom and pan
    const x = (e.clientX - rect.left - panX) / zoomLevel;
    const y = (e.clientY - rect.top - panY) / zoomLevel;
    
    if (cropMode === 'rectangle') {
        handleRectangleMouseMove(x, y);
    }
}

function handleCropMouseUp(e) {
    dragging = false;
    resizing = false;
    resizeHandle = null;
}

function openPanelImageEditor(pageNumber, panelIndex) {
    const modal = document.getElementById('panelImageEditorModal');
    if (!modal) return;
    
    // Clean up any existing state
    if (cropCanvas) {
        cropCanvas.removeEventListener('mousedown', handleCropMouseDown);
        cropCanvas.removeEventListener('mousemove', handleCropMouseMove);
        cropCanvas.removeEventListener('mouseup', handleCropMouseUp);
        cropCanvas.removeEventListener('wheel', handleZoom);
    }
    
    // Get panel data
    const pages = projectData.workflow?.panels?.data || [];
    const pageData = pages.find(p => p.page_number === pageNumber);
    if (!pageData || !pageData.panels || !pageData.panels[panelIndex]) {
        alert('Panel not found');
        return;
    }
    
    currentEditingPanel = {
        pageNumber: pageNumber,
        panelIndex: panelIndex,
        panel: pageData.panels[panelIndex]
    };
    
    // Reset zoom and pan state
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    
    // Reset crop mode to rectangle
    setCropMode('rectangle');
    
    // Setup canvases
    setupCropCanvas(currentEditingPanel.panel.url);
    
    // Setup zoom controls
    setupZoomControls();
    
    console.log('Panel image editor opened for:', currentEditingPanel);
    
    modal.style.display = 'block';
}

function setupCropCanvas(imageUrl) {
    cropCanvas = document.getElementById('cropCanvas');
    cropContext = cropCanvas.getContext('2d');
    previewCanvas = document.getElementById('previewCanvas');
    previewContext = previewCanvas.getContext('2d');
    
    // Reset zoom and pan
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    
    originalImage = new Image();
    originalImage.crossOrigin = 'anonymous';
    originalImage.onload = function() {
        // Set canvas size to fit image while maintaining aspect ratio
        const containerWidth = 600;
        const containerHeight = 400;
        let { width, height } = originalImage;
        
        const scaleX = containerWidth / width;
        const scaleY = containerHeight / height;
        const scale = Math.min(scaleX, scaleY, 1);
        
        width *= scale;
        height *= scale;
        
        cropCanvas.width = width;
        cropCanvas.height = height;
        cropCanvas.style.width = width + 'px';
        cropCanvas.style.height = height + 'px';
        
        drawImage();
        setupCropCanvasEvents();
        
        // Initialize rectangle crop
        if (cropMode === 'rectangle') {
            initializeRectangleCrop();
        }
    };
    originalImage.src = imageUrl;
}

function setupCropCanvasEvents() {
    if (!cropCanvas) return;
    
    // Remove existing event listeners
    cropCanvas.removeEventListener('mousedown', handleCropMouseDown);
    cropCanvas.removeEventListener('mousemove', handleCropMouseMove);
    cropCanvas.removeEventListener('mouseup', handleCropMouseUp);
    cropCanvas.removeEventListener('wheel', handleZoom);
    
    // Add new event listeners
    cropCanvas.addEventListener('mousedown', handleCropMouseDown);
    cropCanvas.addEventListener('mousemove', handleCropMouseMove);
    cropCanvas.addEventListener('mouseup', handleCropMouseUp);
    cropCanvas.addEventListener('mouseleave', handleCropMouseUp);
    cropCanvas.addEventListener('wheel', handleZoom);
}

function drawImage() {
    if (!cropContext || !originalImage || !originalImage.complete || originalImage.naturalWidth === 0) {
        console.warn('Cannot draw image - image not loaded or context not available');
        return;
    }
    
    cropContext.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    
    // Save context state
    cropContext.save();
    
    // Apply zoom and pan transformations
    cropContext.translate(panX, panY);
    cropContext.scale(zoomLevel, zoomLevel);
    
    // Draw the image
    cropContext.drawImage(originalImage, 0, 0, cropCanvas.width / zoomLevel, cropCanvas.height / zoomLevel);
    
    // Restore context state
    cropContext.restore();
    
    if (cropMode === 'rectangle' && rectangleCrop) {
        drawRectangleCrop();
    } else if (cropMode === 'freeform') {
        drawFreeformCrop();
    }
    
    updatePreview();
}

function setCropMode(mode) {
    cropMode = mode;
    
    // Update UI
    document.querySelectorAll('.crop-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    
    // Show/hide settings
    document.getElementById('rectangleSettings').style.display = mode === 'rectangle' ? 'block' : 'none';
    document.getElementById('freeformSettings').style.display = mode === 'freeform' ? 'block' : 'none';
    
    // Reset crop data
    if (mode === 'rectangle') {
        freeformPoints = [];
        initializeRectangleCrop();
        updateFreeformPointsDisplay();
    } else {
        rectangleCrop = null;
    }
    
    if (cropCanvas) {
        drawImage();
    }
}

function initializeRectangleCrop() {
    if (!cropCanvas) return;
    
    const padding = 40;
    rectangleCrop = {
        x: padding,
        y: padding,
        width: cropCanvas.width - padding * 2,
        height: cropCanvas.height - padding * 2
    };
    console.log('Rectangle crop initialized:', rectangleCrop);
}

function drawRectangleCrop() {
    if (!rectangleCrop) return;
    
    // Draw overlay
    cropContext.fillStyle = 'rgba(0, 0, 0, 0.5)';
    cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    
    // Clear crop area
    cropContext.clearRect(rectangleCrop.x, rectangleCrop.y, rectangleCrop.width, rectangleCrop.height);
    cropContext.drawImage(originalImage,
        rectangleCrop.x * (originalImage.width / cropCanvas.width),
        rectangleCrop.y * (originalImage.height / cropCanvas.height),
        rectangleCrop.width * (originalImage.width / cropCanvas.width),
        rectangleCrop.height * (originalImage.height / cropCanvas.height),
        rectangleCrop.x, rectangleCrop.y, rectangleCrop.width, rectangleCrop.height
    );
    
    // Draw crop border
    cropContext.strokeStyle = '#3b82f6';
    cropContext.lineWidth = 2;
    cropContext.setLineDash([5, 5]);
    cropContext.strokeRect(rectangleCrop.x, rectangleCrop.y, rectangleCrop.width, rectangleCrop.height);
    cropContext.setLineDash([]);
    
    // Draw resize handles
    const handleSize = 8;
    cropContext.fillStyle = '#3b82f6';
    
    // Corner handles
    cropContext.fillRect(rectangleCrop.x - handleSize/2, rectangleCrop.y - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x + rectangleCrop.width - handleSize/2, rectangleCrop.y - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x - handleSize/2, rectangleCrop.y + rectangleCrop.height - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x + rectangleCrop.width - handleSize/2, rectangleCrop.y + rectangleCrop.height - handleSize/2, handleSize, handleSize);
    
    // Edge handles  
    cropContext.fillRect(rectangleCrop.x + rectangleCrop.width/2 - handleSize/2, rectangleCrop.y - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x + rectangleCrop.width/2 - handleSize/2, rectangleCrop.y + rectangleCrop.height - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x - handleSize/2, rectangleCrop.y + rectangleCrop.height/2 - handleSize/2, handleSize, handleSize);
    cropContext.fillRect(rectangleCrop.x + rectangleCrop.width - handleSize/2, rectangleCrop.y + rectangleCrop.height/2 - handleSize/2, handleSize, handleSize);
}

function drawFreeformCrop() {
    if (freeformPoints.length === 0) return;
    
    // Draw points
    cropContext.fillStyle = '#3b82f6';
    freeformPoints.forEach((point, index) => {
        cropContext.beginPath();
        cropContext.arc(point.x, point.y, 5, 0, 2 * Math.PI);
        cropContext.fill();
        
        // Draw point number
        cropContext.fillStyle = 'white';
        cropContext.font = '12px Arial';
        cropContext.textAlign = 'center';
        cropContext.fillText(index + 1, point.x, point.y + 4);
        cropContext.fillStyle = '#3b82f6';
    });
    
    // Draw lines connecting points
    if (freeformPoints.length > 1) {
        cropContext.strokeStyle = '#3b82f6';
        cropContext.lineWidth = 2;
        cropContext.setLineDash([5, 5]);
        cropContext.beginPath();
        cropContext.moveTo(freeformPoints[0].x, freeformPoints[0].y);
        for (let i = 1; i < freeformPoints.length; i++) {
            cropContext.lineTo(freeformPoints[i].x, freeformPoints[i].y);
        }
        if (freeformPoints.length === 4) {
            cropContext.closePath();
        }
        cropContext.stroke();
        cropContext.setLineDash([]);
    }
}

function setupCropCanvasEvents() {
    cropCanvas.removeEventListener('mousedown', handleCropMouseDown);
    cropCanvas.removeEventListener('mousemove', handleCropMouseMove);
    cropCanvas.removeEventListener('mouseup', handleCropMouseUp);
    
    cropCanvas.addEventListener('mousedown', handleCropMouseDown);
    cropCanvas.addEventListener('mousemove', handleCropMouseMove);
    cropCanvas.addEventListener('mouseup', handleCropMouseUp);
}

function handleCropMouseDown(e) {
    const rect = cropCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoomLevel;
    const y = (e.clientY - rect.top) / zoomLevel;
    
    console.log('Mouse down at:', x, y, 'zoom:', zoomLevel);
    
    if (cropMode === 'rectangle') {
        handleRectangleMouseDown(x, y);
    } else if (cropMode === 'freeform') {
        handleFreeformMouseDown(x, y);
    }
}

function handleCropMouseMove(e) {
    const rect = cropCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoomLevel;
    const y = (e.clientY - rect.top) / zoomLevel;
    
    if (cropMode === 'rectangle') {
        handleRectangleMouseMove(x, y);
    }
}

function handleCropMouseUp(e) {
    isDragging = false;
    isResizing = false;
    resizeHandle = null;
}

function handleRectangleMouseDown(x, y) {
    if (!rectangleCrop) return;
    
    const handleSize = 8;
    const handles = [
        { name: 'nw', x: rectangleCrop.x, y: rectangleCrop.y },
        { name: 'ne', x: rectangleCrop.x + rectangleCrop.width, y: rectangleCrop.y },
        { name: 'sw', x: rectangleCrop.x, y: rectangleCrop.y + rectangleCrop.height },
        { name: 'se', x: rectangleCrop.x + rectangleCrop.width, y: rectangleCrop.y + rectangleCrop.height },
        { name: 'n', x: rectangleCrop.x + rectangleCrop.width/2, y: rectangleCrop.y },
        { name: 's', x: rectangleCrop.x + rectangleCrop.width/2, y: rectangleCrop.y + rectangleCrop.height },
        { name: 'w', x: rectangleCrop.x, y: rectangleCrop.y + rectangleCrop.height/2 },
        { name: 'e', x: rectangleCrop.x + rectangleCrop.width, y: rectangleCrop.y + rectangleCrop.height/2 }
    ];
    
    // Check if clicking on a handle
    for (const handle of handles) {
        if (x >= handle.x - handleSize/2 && x <= handle.x + handleSize/2 &&
            y >= handle.y - handleSize/2 && y <= handle.y + handleSize/2) {
            isResizing = true;
            resizeHandle = handle.name;
            dragStart = { x, y };
            return;
        }
    }
    
    // Check if clicking inside crop area
    if (x >= rectangleCrop.x && x <= rectangleCrop.x + rectangleCrop.width &&
        y >= rectangleCrop.y && y <= rectangleCrop.y + rectangleCrop.height) {
        isDragging = true;
        dragStart = { x: x - rectangleCrop.x, y: y - rectangleCrop.y };
    }
}

function handleRectangleMouseMove(x, y) {
    if (isDragging && rectangleCrop) {
        const newX = x - dragStart.x;
        const newY = y - dragStart.y;
        
        // Keep within bounds
        rectangleCrop.x = Math.max(0, Math.min(newX, cropCanvas.width - rectangleCrop.width));
        rectangleCrop.y = Math.max(0, Math.min(newY, cropCanvas.height - rectangleCrop.height));
        
        drawImage();
    } else if (isResizing && rectangleCrop && resizeHandle) {
        const dx = x - dragStart.x;
        const dy = y - dragStart.y;
        const aspectRatio = rectangleCrop.width / rectangleCrop.height;
        maintainAspectRatio = document.getElementById('maintainAspect')?.checked || false;
        
        const originalCrop = { ...rectangleCrop };
        
        switch (resizeHandle) {
            case 'nw':
                rectangleCrop.x += dx;
                rectangleCrop.y += dy;
                rectangleCrop.width -= dx;
                rectangleCrop.height -= dy;
                break;
            case 'ne':
                rectangleCrop.y += dy;
                rectangleCrop.width += dx;
                rectangleCrop.height -= dy;
                break;
            case 'sw':
                rectangleCrop.x += dx;
                rectangleCrop.width -= dx;
                rectangleCrop.height += dy;
                break;
            case 'se':
                rectangleCrop.width += dx;
                rectangleCrop.height += dy;
                break;
            case 'n':
                rectangleCrop.y += dy;
                rectangleCrop.height -= dy;
                break;
            case 's':
                rectangleCrop.height += dy;
                break;
            case 'w':
                rectangleCrop.x += dx;
                rectangleCrop.width -= dx;
                break;
            case 'e':
                rectangleCrop.width += dx;
                break;
        }
        
        if (maintainAspectRatio) {
            if (resizeHandle.includes('e') || resizeHandle.includes('w')) {
                rectangleCrop.height = rectangleCrop.width / aspectRatio;
            } else if (resizeHandle.includes('n') || resizeHandle.includes('s')) {
                rectangleCrop.width = rectangleCrop.height * aspectRatio;
            }
        }
        
        // Ensure minimum size
        if (rectangleCrop.width < 20 || rectangleCrop.height < 20) {
            rectangleCrop = originalCrop;
        }
        
        // Keep within bounds
        if (rectangleCrop.x < 0 || rectangleCrop.y < 0 || 
            rectangleCrop.x + rectangleCrop.width > cropCanvas.width ||
            rectangleCrop.y + rectangleCrop.height > cropCanvas.height) {
            rectangleCrop = originalCrop;
        }
        
        dragStart = { x, y };
        drawImage();
    }
}

function handleFreeformMouseDown(x, y) {
    if (freeformPoints.length < 4) {
        freeformPoints.push({ x, y });
        updateFreeformPointsDisplay();
        drawImage();
    }
}

function updateFreeformPointsDisplay() {
    const pointsDiv = document.getElementById('freeformPoints');
    if (!pointsDiv) return;
    
    pointsDiv.innerHTML = '';
    if (freeformPoints.length === 0) {
        pointsDiv.innerHTML = '<div style="text-align: center; color: var(--text-muted);">No points selected</div>';
        return;
    }
    
    freeformPoints.forEach((point, index) => {
        const pointDiv = document.createElement('div');
        pointDiv.className = 'freeform-point';
        pointDiv.innerHTML = `
            <span>Point ${index + 1}:</span>
            <span>(${Math.round(point.x)}, ${Math.round(point.y)})</span>
        `;
        pointsDiv.appendChild(pointDiv);
    });
}

function clearFreeformPoints() {
    freeformPoints = [];
    updateFreeformPointsDisplay();
    if (cropCanvas) {
        drawImage();
    }
}

function updatePreview() {
    if (!previewContext || !originalImage) return;
    
    previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    
    if (cropMode === 'rectangle' && rectangleCrop) {
        // Calculate source coordinates
        const sourceX = rectangleCrop.x * (originalImage.width / cropCanvas.width);
        const sourceY = rectangleCrop.y * (originalImage.height / cropCanvas.height);
        const sourceWidth = rectangleCrop.width * (originalImage.width / cropCanvas.width);
        const sourceHeight = rectangleCrop.height * (originalImage.height / cropCanvas.height);
        
        // Draw cropped preview
        const scale = Math.min(previewCanvas.width / sourceWidth, previewCanvas.height / sourceHeight);
        const previewWidth = sourceWidth * scale;
        const previewHeight = sourceHeight * scale;
        const offsetX = (previewCanvas.width - previewWidth) / 2;
        const offsetY = (previewCanvas.height - previewHeight) / 2;
        
        previewContext.drawImage(originalImage, sourceX, sourceY, sourceWidth, sourceHeight,
                                offsetX, offsetY, previewWidth, previewHeight);
    }
}

async function applyCrop() {
    if (!currentEditingPanel) return;
    
    try {
        let croppedCanvas;
        
        if (cropMode === 'rectangle' && rectangleCrop) {
            croppedCanvas = applyCropRectangle();
        } else if (cropMode === 'freeform' && freeformPoints.length === 4) {
            croppedCanvas = applyCropFreeform();
        } else {
            alert('Please define a crop area first');
            return;
        }
        
        if (!croppedCanvas) return;
        
        // Convert to blob and upload
        croppedCanvas.toBlob(async (blob) => {
            const formData = new FormData();
            const timestamp = Date.now();
            const filename = `panel_${currentEditingPanel.pageNumber}_${currentEditingPanel.panelIndex}_cropped_${timestamp}.png`;
            formData.append('files', blob, filename);
            
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });
            
            if (response.ok) {
                const result = await response.json();
                if (result.urls && result.urls.length > 0) {
                    // Update panel URL
                    updatePanelUrl(currentEditingPanel.pageNumber, currentEditingPanel.panelIndex, result.urls[0]);
                    closePanelImageEditor();
                    // Refresh panel editor content
                    loadPanelEditorContent(currentEditingPanel.pageNumber);
                }
            }
        }, 'image/png');
        
    } catch (error) {
        console.error('Error cropping image:', error);
        alert('Error cropping image: ' + error.message);
    }
}

function applyCropRectangle() {
    if (!rectangleCrop) return null;
    
    // Calculate crop coordinates relative to original image
    const scaleX = originalImage.width / cropCanvas.width;
    const scaleY = originalImage.height / cropCanvas.height;
    
    const cropData = {
        x: Math.round(rectangleCrop.x * scaleX),
        y: Math.round(rectangleCrop.y * scaleY),
        width: Math.round(rectangleCrop.width * scaleX),
        height: Math.round(rectangleCrop.height * scaleY)
    };
    
    const croppedCanvas = document.createElement('canvas');
    const croppedContext = croppedCanvas.getContext('2d');
    croppedCanvas.width = cropData.width;
    croppedCanvas.height = cropData.height;
    
    croppedContext.drawImage(originalImage, 
        cropData.x, cropData.y, cropData.width, cropData.height,
        0, 0, cropData.width, cropData.height
    );
    
    return croppedCanvas;
}

function applyCropFreeform() {
    if (freeformPoints.length !== 4) return null;
    
    // Calculate points relative to original image
    const scaleX = originalImage.width / cropCanvas.width;
    const scaleY = originalImage.height / cropCanvas.height;
    
    const scaledPoints = freeformPoints.map(point => ({
        x: point.x * scaleX,
        y: point.y * scaleY
    }));
    
    // Find bounding box
    const minX = Math.min(...scaledPoints.map(p => p.x));
    const maxX = Math.max(...scaledPoints.map(p => p.x));
    const minY = Math.min(...scaledPoints.map(p => p.y));
    const maxY = Math.max(...scaledPoints.map(p => p.y));
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    const croppedCanvas = document.createElement('canvas');
    const croppedContext = croppedCanvas.getContext('2d');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    
    // Create clipping path
    croppedContext.beginPath();
    croppedContext.moveTo(scaledPoints[0].x - minX, scaledPoints[0].y - minY);
    for (let i = 1; i < scaledPoints.length; i++) {
        croppedContext.lineTo(scaledPoints[i].x - minX, scaledPoints[i].y - minY);
    }
    croppedContext.closePath();
    croppedContext.clip();
    
    // Draw image with clipping
    croppedContext.drawImage(originalImage, -minX, -minY);
    
    return croppedCanvas;
}

function applyCropSquare() {
    console.log('🔥 APPLY CROP BUTTON CLICKED! 🔥');
    console.log('=== APPLY CROP STARTED ===');
    
    // Disable the apply button and show loading state
    const applyBtn = document.getElementById('applyCropBtn');
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.innerHTML = '⏳ Processing...';
        console.log('Apply button disabled and set to loading state');
    }
    
    // Re-enable function to restore button state
    const restoreButton = () => {
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.innerHTML = '✂️ Apply Crop';
        }
    };
    
    console.log('currentEditingPanel:', currentEditingPanel);
    console.log('cropMode:', cropMode);
    console.log('rectangleCrop:', rectangleCrop);
    console.log('freeformPoints:', freeformPoints);
    
    if (!currentEditingPanel) {
        console.error('ERROR: No panel is being edited');
        alert('No panel is being edited');
        restoreButton();
        return;
    }

    let croppedCanvas;
    
    if (cropMode === 'rectangle' && rectangleCrop) {
        console.log('Using rectangle crop mode');
        croppedCanvas = applyCropRectangle();
        console.log('Rectangle crop result:', croppedCanvas);
    } else if (cropMode === 'freeform' && freeformPoints.length === 4) {
        console.log('Using freeform crop mode');
        croppedCanvas = applyCropFreeform();
        console.log('Freeform crop result:', croppedCanvas);
    } else {
        console.warn('No valid crop area defined');
        alert('Please define a crop area first');
        restoreButton();
        return;
    }
    
    if (!croppedCanvas) {
        console.error('ERROR: Failed to create cropped image');
        alert('Failed to create cropped image');
        restoreButton();
        return;
    }
    
    console.log('Cropped canvas created, size:', croppedCanvas.width, 'x', croppedCanvas.height);
    
    // Convert cropped canvas to blob and upload
    croppedCanvas.toBlob(async (blob) => {
        console.log('Blob created, size:', blob.size, 'bytes');
        try {
            const formData = new FormData();
            const timestamp = Date.now();
            const originalFilename = currentEditingPanel.panel.filename || 'panel.png';
            const extension = originalFilename.split('.').pop();
            const newFilename = `cropped_${timestamp}.${extension}`;
            
            console.log('Uploading file:', newFilename);
            formData.append('files', blob, newFilename);
            
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });
            
            console.log('Upload response status:', response.status);
            
            if (response.ok) {
                const result = await response.json();
                console.log('Upload result:', result);
                
                // Handle both possible response formats
                let newImageUrl = null;
                if (result.urls && result.urls.length > 0) {
                    newImageUrl = result.urls[0];
                    console.log('Using URL from result.urls:', newImageUrl);
                } else if (result.filenames && result.filenames.length > 0) {
                    newImageUrl = `/uploads/${result.filenames[0]}`;
                    console.log('Using filename from result.filenames, constructed URL:', newImageUrl);
                } else {
                    console.error('ERROR: No URLs or filenames in upload result:', result);
                    alert('Failed to upload cropped image - no URLs or filenames returned');
                    restoreButton();
                    return;
                }
                
                if (newImageUrl) {
                    // Update panel data with new cropped image
                    console.log('New image URL:', newImageUrl);
                    
                    currentEditingPanel.panel.url = newImageUrl;
                    currentEditingPanel.panel.filename = newFilename;
                    console.log('Panel data updated');
                    
                    // Update the UI immediately
                    updatePanelInUI(currentEditingPanel.pageNumber, currentEditingPanel.panelIndex, newImageUrl);
                    console.log('UI updated');
                    
                    // Update the crop editor with the new cropped image
                    setupCropCanvas(newImageUrl);
                    console.log('Crop canvas updated');
                    
                    // Reset crop tools for the new image
                    rectangleCrop = null;
                    freeformPoints = [];
                    setCropMode('rectangle');
                    console.log('Crop tools reset');
                    
                    // Refresh the panel editor content to show updated image
                    loadPanelEditorContent(currentEditingPanel.pageNumber);
                    console.log('Panel editor content refreshed');
                    
                    console.log('=== APPLY CROP COMPLETED SUCCESSFULLY ===');
                    restoreButton();
                }
            } else {
                const errorText = await response.text();
                console.error('ERROR: Upload failed with status', response.status, ':', errorText);
                alert('Failed to upload cropped image: ' + response.status);
                restoreButton();
            }
        } catch (error) {
            console.error('ERROR: Exception during upload:', error);
            console.error('Error applying crop: ' + error.message);
            restoreButton();
        }
    }, 'image/png');
}

function setupZoomControls() {
    const container = document.querySelector('#panelImageEditorModal .image-crop-container');
    if (!container) {
        console.warn('Image crop container not found for zoom controls');
        return;
    }
    
    console.log('Setting up zoom controls');
    
    console.log('Setting up zoom controls');
    
    // Remove existing zoom controls to prevent duplicates
    const existingControls = container.querySelector('.zoom-controls');
    if (existingControls) {
        existingControls.remove();
    }
    
    // Add new zoom controls
    const zoomControls = document.createElement('div');
    zoomControls.className = 'zoom-controls';
    zoomControls.innerHTML = `
        <button class="zoom-btn" onclick="zoomIn()" title="Zoom In (+)">+</button>
        <span class="zoom-level">${Math.round(zoomLevel * 100)}%</span>
        <button class="zoom-btn" onclick="zoomOut()" title="Zoom Out (-)">−</button>
        <button class="zoom-btn" onclick="resetZoom()" title="Reset Zoom">⌂</button>
    `;
    zoomControls.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        background: linear-gradient(135deg, rgba(0,0,0,0.9), rgba(30,30,30,0.9));
        border-radius: 12px;
        padding: 10px;
        display: flex;
        gap: 8px;
        align-items: center;
        z-index: 1000;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.1);
    `;
    
    // Enhanced styling
    const existingStyle = document.getElementById('zoom-controls-style');
    if (existingStyle) existingStyle.remove();
    
    const style = document.createElement('style');
    style.id = 'zoom-controls-style';
    style.textContent = `
        .zoom-controls .zoom-btn {
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
            border: 1px solid rgba(255,255,255,0.2);
            color: white;
            border-radius: 8px;
            padding: 8px 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 14px;
            font-weight: 600;
            min-width: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .zoom-controls .zoom-btn:hover {
            background: linear-gradient(135deg, #9333ea, #8b5cf6);
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(139, 92, 246, 0.4);
        }
        .zoom-controls .zoom-level {
            min-width: 60px;
            text-align: center;
            font-weight: 700;
            color: #fbbf24;
            font-size: 14px;
            padding: 6px 10px;
            background: rgba(251, 191, 36, 0.15);
            border-radius: 8px;
            border: 1px solid rgba(251, 191, 36, 0.3);
        }
    `;
    document.head.appendChild(style);
    
    container.style.position = 'relative';
    container.appendChild(zoomControls);
    console.log('Enhanced zoom controls added');
}

function handleZoom(e) {
    e.preventDefault();
    const rect = cropCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.1, Math.min(5, zoomLevel * zoomFactor));
    
    // Adjust pan to zoom towards mouse position
    panX = mouseX - (mouseX - panX) * (newZoom / zoomLevel);
    panY = mouseY - (mouseY - panY) * (newZoom / zoomLevel);
    
    zoomLevel = newZoom;
    updateZoomDisplay();
    drawImage();
}

function handlePanStart(e) {
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) { // Middle mouse or Ctrl+Left
        isPanning = true;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        e.preventDefault();
    }
}

function handlePanMove(e) {
    if (isPanning) {
        const deltaX = e.clientX - lastPanX;
        const deltaY = e.clientY - lastPanY;
        
        panX += deltaX;
        panY += deltaY;
        
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        
        drawImage();
        e.preventDefault();
    }
}

function handlePanEnd(e) {
    isPanning = false;
}

function zoomIn() {
    zoomLevel = Math.min(3, zoomLevel * 1.2);
    updateCanvasZoom();
    updateZoomDisplay();
    console.log('Zoomed in to:', zoomLevel);
}

function zoomOut() {
    zoomLevel = Math.max(0.5, zoomLevel / 1.2);
    updateCanvasZoom();
    updateZoomDisplay();
    console.log('Zoomed out to:', zoomLevel);
}

function resetZoom() {
    zoomLevel = 1;
    updateCanvasZoom();
    updateZoomDisplay();
    console.log('Zoom reset to:', zoomLevel);
}

function updateCanvasZoom() {
    if (cropCanvas) {
        const baseWidth = cropCanvas.width;
        const baseHeight = cropCanvas.height;
        cropCanvas.style.width = (baseWidth * zoomLevel) + 'px';
        cropCanvas.style.height = (baseHeight * zoomLevel) + 'px';
    }
}

function updateZoomDisplay() {
    const zoomDisplay = document.querySelector('.zoom-level');
    if (zoomDisplay) {
        zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    }
}

function updatePanelInUI(pageNumber, panelIndex, newImageUrl) {
    // Find and update the panel image in the current page display
    const panelElements = document.querySelectorAll(`[data-page="${pageNumber}"] .panel-item img`);
    if (panelElements[panelIndex]) {
        panelElements[panelIndex].src = newImageUrl;
        // Force reload of the image
        panelElements[panelIndex].onload = function() {
            console.log('Panel image updated in UI');
        };
    }
    
    // Also update any other references to this panel in the UI
    const allPanelImages = document.querySelectorAll(`img[data-panel-page="${pageNumber}"][data-panel-index="${panelIndex}"]`);
    allPanelImages.forEach(img => {
        img.src = newImageUrl;
    });
}

async function addBorderToCurrentPanel() {
    if (!currentEditingPanel || !originalImage) {
        alert('No panel is being edited');
        return;
    }
    
    console.log('🖼️ ADD BORDER BUTTON CLICKED! 🖼️');
    console.log('Adding border to current panel:', currentEditingPanel);
    
    // Disable the border button and show loading state
    const borderBtn = document.querySelector('button[onclick="addBorderToCurrentPanel()"]');
    if (borderBtn) {
        borderBtn.disabled = true;
        borderBtn.innerHTML = '⏳ Adding Border...';
    }
    
    // Re-enable function to restore button state
    const restoreButton = () => {
        if (borderBtn) {
            borderBtn.disabled = false;
            borderBtn.innerHTML = '🖼️ Add Border';
        }
    };
    
    try {
        // Convert current image to blob
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = originalImage.width;
        canvas.height = originalImage.height;
        context.drawImage(originalImage, 0, 0);
        
        canvas.toBlob(async (blob) => {
            if (!blob) {
                alert('Failed to process image');
                restoreButton();
                return;
            }
            
            console.log('Sending image to border API, blob size:', blob.size);
            
            const formData = new FormData();
            formData.append('file', blob, 'panel.png');
            
            const response = await fetch('/api/panel/add-border', {
                method: 'POST',
                body: formData
            });
            
            console.log('Border API response status:', response.status);
            
            if (response.ok) {
                const result = await response.json();
                console.log('Border API result:', result);
                
                if (result.filenames && result.filenames.length > 0) {
                    const newImageUrl = `/uploads/${result.filenames[0]}`;
                    console.log('New bordered image URL:', newImageUrl);
                    
                    // Update panel data with new bordered image
                    currentEditingPanel.panel.url = newImageUrl;
                    currentEditingPanel.panel.filename = result.filenames[0];
                    console.log('Panel data updated with bordered image');
                    
                    // Update the UI immediately
                    updatePanelInUI(currentEditingPanel.pageNumber, currentEditingPanel.panelIndex, newImageUrl);
                    console.log('UI updated with bordered image');
                    
                    // Update the crop editor with the new bordered image
                    setupCropCanvas(newImageUrl);
                    console.log('Crop canvas updated with bordered image');
                    
                    // Reset crop tools for the new image
                    rectangleCrop = null;
                    freeformPoints = [];
                    setCropMode('rectangle');
                    console.log('Crop tools reset for bordered image');
                    
                    // Refresh the panel editor content to show updated image
                    loadPanelEditorContent(currentEditingPanel.pageNumber);
                    console.log('Panel editor content refreshed');
                    
                    console.log('Border added successfully!');
                    console.log('=== ADD BORDER COMPLETED SUCCESSFULLY ===');
                } else {
                    console.error('ERROR: No filenames in border result');
                    console.error('Failed to add border - no filenames returned');
                }
            } else {
                const errorText = await response.text();
                console.error('ERROR: Border API failed with status', response.status, ':', errorText);
                console.error('Failed to add border: ' + response.status);
            }
            
            restoreButton();
        }, 'image/png');
        
    } catch (error) {
        console.error('ERROR: Exception during border addition:', error);
        console.error('Error adding border: ' + error.message);
        restoreButton();
    }
}

function resetCrop() {
    if (cropMode === 'rectangle') {
        initializeRectangleCrop();
    } else {
        freeformPoints = [];
        updateFreeformPointsDisplay();
    }
    
    if (cropCanvas) {
        drawImage();
    }
}

function closePanelImageEditor() {
    const modal = document.getElementById('panelImageEditorModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    currentEditingPanel = null;
    rectangleCrop = null;
    freeformPoints = [];
    originalImage = null;
    
    // Remove event listeners
    if (cropCanvas) {
        cropCanvas.removeEventListener('mousedown', handleCropMouseDown);
        cropCanvas.removeEventListener('mousemove', handleCropMouseMove);
        cropCanvas.removeEventListener('mouseup', handleCropMouseUp);
    }
}

async function addBorderToPanel(pageNumber, panelIndex) {
    const pages = projectData.workflow?.panels?.data || [];
    const pageData = pages.find(p => p.page_number === pageNumber);
    if (!pageData || !pageData.panels || !pageData.panels[panelIndex]) {
        alert('Panel not found');
        return;
    }
    
    const panel = pageData.panels[panelIndex];
    
    try {
        const response = await fetch('/api/panel/add-border', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                project_id: projectData.id,
                page_number: pageNumber,
                panel_index: panelIndex,
                panel_url: panel.url,
                border_width: 10,
                border_color: 'black',
                curved_border: true,
                corner_radius: 15
            })
        });
        
        if (response.ok) {
            const result = await response.json();
            if (result.success) {
                // Update panel URL
                updatePanelUrl(pageNumber, panelIndex, result.url);
                // Refresh panel editor content
                loadPanelEditorContent(pageNumber);
            } else {
                console.error('Failed to add border to panel');
            }
        } else {
            const error = await response.json();
            console.error(`Error adding border: ${error.detail || 'Unknown error'}`);
        }
        
    } catch (error) {
        console.error('Error adding border:', error);
        console.error('Border operation failed. Please try again.');
    }
}

function updatePanelUrl(pageNumber, panelIndex, newUrl) {
    // Update project data
    const pages = projectData.workflow?.panels?.data || [];
    const pageData = pages.find(p => p.page_number === pageNumber);
    if (pageData && pageData.panels && pageData.panels[panelIndex]) {
        pageData.panels[panelIndex].url = newUrl;
        pageData.panels[panelIndex].filename = newUrl.split('/').pop();
    }
}

// Add New Panel Functionality - Enhanced
function openAddPanelModal(pageNumber) {
    console.log('Opening add panel modal for page:', pageNumber);
    const modal = document.getElementById('addPanelModal');
    if (!modal) return;
    
    // Clean up any existing state
    if (addPanelCanvas) {
        addPanelCanvas.removeEventListener('mousedown', addPanelCanvasMouseDown);
        addPanelCanvas.removeEventListener('mousemove', addPanelCanvasMouseMove);
        addPanelCanvas.removeEventListener('mouseup', addPanelCanvasMouseUp);
        addPanelCanvas.removeEventListener('wheel', handleAddPanelZoom);
    }
    
    currentPageForNewPanel = pageNumber;
    console.log('Set currentPageForNewPanel to:', currentPageForNewPanel);
    
    // Get original page image
    const pageFile = projectData.files[pageNumber - 1];
    if (!pageFile) {
        alert('Page not found');
        return;
    }
    
    // Reset zoom and pan state
    addPanelZoomLevel = 1;
    addPanelPanX = 0;
    addPanelPanY = 0;
    
    // Reset crop mode to rectangle
    setAddPanelCropMode('rectangle');
    
    // Setup canvas with original page image
    setupAddPanelCanvas(`/uploads/${pageFile}`);
    
    // Setup zoom controls for add panel modal
    setupAddPanelZoomControls();
    
    modal.style.display = 'block';
}

function setupAddPanelCanvas(imageUrl) {
    addPanelCanvas = document.getElementById('addPanelCanvas');
    addPanelContext = addPanelCanvas.getContext('2d');
    addPanelPreviewCanvas = document.getElementById('addPanelPreviewCanvas');
    addPanelPreviewContext = addPanelPreviewCanvas.getContext('2d');
    
    addPanelImage = new Image();
    addPanelImage.crossOrigin = 'anonymous';
    addPanelImage.onload = function() {
        // Set canvas size to fit image while maintaining aspect ratio
        const containerWidth = 600;
        const containerHeight = 400;
        let { width, height } = addPanelImage;
        
        const scaleX = containerWidth / width;
        const scaleY = containerHeight / height;
        const scale = Math.min(scaleX, scaleY, 1);
        
        width *= scale;
        height *= scale;
        
        addPanelCanvas.width = width;
        addPanelCanvas.height = height;
        addPanelCanvas.style.width = width + 'px';
        addPanelCanvas.style.height = height + 'px';
        
        drawAddPanelImage();
        setupAddPanelCanvasEvents();
        
        // Initialize rectangle crop
        if (addPanelCropMode === 'rectangle') {
            initializeAddPanelRectangleCrop();
        }
    };
    addPanelImage.src = imageUrl;
}

function setupAddPanelCanvasEvents() {
    addPanelCanvas.addEventListener('mousedown', addPanelCanvasMouseDown);
    addPanelCanvas.addEventListener('mousemove', addPanelCanvasMouseMove);
    addPanelCanvas.addEventListener('mouseup', addPanelCanvasMouseUp);
    addPanelCanvas.addEventListener('mouseleave', addPanelCanvasMouseUp);
    addPanelCanvas.addEventListener('wheel', handleAddPanelZoom);
}

function setupAddPanelZoomControls() {
    const container = document.querySelector('#addPanelModal .image-crop-container');
    if (!container) return;
    
    console.log('Setting up add panel zoom controls');
    
    // Remove existing zoom controls
    const existingControls = container.querySelector('.zoom-controls');
    if (existingControls) {
        existingControls.remove();
    }
    
    // Add new zoom controls
    const zoomControls = document.createElement('div');
    zoomControls.className = 'zoom-controls';
    zoomControls.innerHTML = `
        <button class="zoom-btn" onclick="addPanelZoomIn()" title="Zoom In">+</button>
        <span class="zoom-level">${Math.round(addPanelZoomLevel * 100)}%</span>
        <button class="zoom-btn" onclick="addPanelZoomOut()" title="Zoom Out">−</button>
        <button class="zoom-btn" onclick="addPanelResetZoom()" title="Reset">⌂</button>
    `;
    zoomControls.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        background: linear-gradient(135deg, rgba(0,0,0,0.9), rgba(30,30,30,0.9));
        border-radius: 12px;
        padding: 10px;
        display: flex;
        gap: 8px;
        align-items: center;
        z-index: 1000;
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.1);
    `;
    // Add styling for add panel zoom controls
    const existingStyle = document.getElementById('add-panel-zoom-style');
    if (existingStyle) existingStyle.remove();
    
    const style = document.createElement('style');
    style.id = 'add-panel-zoom-style';
    style.textContent = `
        #addPanelModal .zoom-controls .zoom-btn {
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.8), rgba(124, 58, 237, 0.8));
            border: 1px solid rgba(255,255,255,0.2);
            color: white;
            border-radius: 8px;
            padding: 8px 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 14px;
            font-weight: 600;
            min-width: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #addPanelModal .zoom-controls .zoom-btn:hover {
            background: linear-gradient(135deg, rgba(147, 97, 255, 0.9), rgba(138, 73, 244, 0.9));
            transform: translateY(-2px);
            box-shadow: 0 2px 8px rgba(139, 92, 246, 0.4);
        }
        #addPanelModal .zoom-controls .zoom-level {
            min-width: 60px;
            text-align: center;
            font-weight: 700;
            color: #fbbf24;
            font-size: 14px;
            padding: 4px 8px;
            background: rgba(251, 191, 36, 0.1);
            border-radius: 6px;
            border: 1px solid rgba(251, 191, 36, 0.3);
        }
    `;
    document.head.appendChild(style);
    
    container.style.position = 'relative';
    container.appendChild(zoomControls);
    console.log('Add panel zoom controls added');
}

function setAddPanelCropMode(mode) {
    addPanelCropMode = mode;
    
    // Update UI
    document.querySelectorAll('#addPanelModal .crop-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    
    // Show/hide settings
    document.getElementById('addPanelRectangleSettings').style.display = mode === 'rectangle' ? 'block' : 'none';
    document.getElementById('addPanelFreeformSettings').style.display = mode === 'freeform' ? 'block' : 'none';
    
    // Reset crop data
    if (mode === 'rectangle') {
        addPanelFreeformPoints = [];
        initializeAddPanelRectangleCrop();
        updateAddPanelFreeformPointsDisplay();
    } else {
        addPanelRectangleCrop = null;
    }
    
    if (addPanelCanvas) {
        drawAddPanelImage();
    }
}

function initializeAddPanelRectangleCrop() {
    if (!addPanelCanvas) return;
    
    const padding = 40;
    addPanelRectangleCrop = {
        x: padding,
        y: padding,
        width: addPanelCanvas.width - padding * 2,
        height: addPanelCanvas.height - padding * 2
    };
}

function drawAddPanelImage() {
    if (!addPanelContext || !addPanelImage || !addPanelImage.complete || addPanelImage.naturalWidth === 0) {
        console.warn('Cannot draw add panel image - image not loaded or context not available');
        return;
    }
    
    addPanelContext.clearRect(0, 0, addPanelCanvas.width, addPanelCanvas.height);
    
    // Save context state
    addPanelContext.save();
    
    // Apply zoom and pan transformations
    addPanelContext.translate(addPanelPanX, addPanelPanY);
    addPanelContext.scale(addPanelZoomLevel, addPanelZoomLevel);
    
    // Draw the image
    addPanelContext.drawImage(addPanelImage, 0, 0, addPanelCanvas.width / addPanelZoomLevel, addPanelCanvas.height / addPanelZoomLevel);
    
    // Restore context state
    addPanelContext.restore();
    
    if (addPanelCropMode === 'rectangle' && addPanelRectangleCrop) {
        drawAddPanelRectangleCrop();
    } else if (addPanelCropMode === 'freeform') {
        drawAddPanelFreeformCrop();
    }
    
    updateAddPanelPreview();
}

function drawAddPanelRectangleCrop() {
    if (!addPanelRectangleCrop) return;
    
    // Draw overlay
    addPanelContext.fillStyle = 'rgba(0, 0, 0, 0.5)';
    addPanelContext.fillRect(0, 0, addPanelCanvas.width, addPanelCanvas.height);
    
    // Clear crop area
    addPanelContext.clearRect(addPanelRectangleCrop.x, addPanelRectangleCrop.y, addPanelRectangleCrop.width, addPanelRectangleCrop.height);
    addPanelContext.drawImage(addPanelImage,
        addPanelRectangleCrop.x * (addPanelImage.width / addPanelCanvas.width),
        addPanelRectangleCrop.y * (addPanelImage.height / addPanelCanvas.height),
        addPanelRectangleCrop.width * (addPanelImage.width / addPanelCanvas.width),
        addPanelRectangleCrop.height * (addPanelImage.height / addPanelCanvas.height),
        addPanelRectangleCrop.x, addPanelRectangleCrop.y, addPanelRectangleCrop.width, addPanelRectangleCrop.height
    );
    
    // Draw crop border
    addPanelContext.strokeStyle = '#8b5cf6';
    addPanelContext.lineWidth = 2;
    addPanelContext.setLineDash([5, 5]);
    addPanelContext.strokeRect(addPanelRectangleCrop.x, addPanelRectangleCrop.y, addPanelRectangleCrop.width, addPanelRectangleCrop.height);
    addPanelContext.setLineDash([]);
    
    // Draw resize handles
    const handleSize = 8;
    addPanelContext.fillStyle = '#8b5cf6';
    
    // Corner handles
    addPanelContext.fillRect(addPanelRectangleCrop.x - handleSize/2, addPanelRectangleCrop.y - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x + addPanelRectangleCrop.width - handleSize/2, addPanelRectangleCrop.y - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x - handleSize/2, addPanelRectangleCrop.y + addPanelRectangleCrop.height - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x + addPanelRectangleCrop.width - handleSize/2, addPanelRectangleCrop.y + addPanelRectangleCrop.height - handleSize/2, handleSize, handleSize);
    
    // Edge handles
    addPanelContext.fillRect(addPanelRectangleCrop.x + addPanelRectangleCrop.width/2 - handleSize/2, addPanelRectangleCrop.y - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x + addPanelRectangleCrop.width/2 - handleSize/2, addPanelRectangleCrop.y + addPanelRectangleCrop.height - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x - handleSize/2, addPanelRectangleCrop.y + addPanelRectangleCrop.height/2 - handleSize/2, handleSize, handleSize);
    addPanelContext.fillRect(addPanelRectangleCrop.x + addPanelRectangleCrop.width - handleSize/2, addPanelRectangleCrop.y + addPanelRectangleCrop.height/2 - handleSize/2, handleSize, handleSize);
}

function drawAddPanelFreeformCrop() {
    if (addPanelFreeformPoints.length === 0) return;
    
    // Draw points
    addPanelContext.fillStyle = '#8b5cf6';
    addPanelFreeformPoints.forEach((point, index) => {
        addPanelContext.beginPath();
        addPanelContext.arc(point.x, point.y, 5, 0, 2 * Math.PI);
        addPanelContext.fill();
        
        // Draw point number
        addPanelContext.fillStyle = 'white';
        addPanelContext.font = '12px Arial';
        addPanelContext.textAlign = 'center';
        addPanelContext.fillText(index + 1, point.x, point.y + 4);
        addPanelContext.fillStyle = '#8b5cf6';
    });
    
    // Draw lines connecting points
    if (addPanelFreeformPoints.length > 1) {
        addPanelContext.strokeStyle = '#8b5cf6';
        addPanelContext.lineWidth = 2;
        addPanelContext.setLineDash([5, 5]);
        addPanelContext.beginPath();
        addPanelContext.moveTo(addPanelFreeformPoints[0].x, addPanelFreeformPoints[0].y);
        for (let i = 1; i < addPanelFreeformPoints.length; i++) {
            addPanelContext.lineTo(addPanelFreeformPoints[i].x, addPanelFreeformPoints[i].y);
        }
        if (addPanelFreeformPoints.length === 4) {
            addPanelContext.closePath();
        }
        addPanelContext.stroke();
        addPanelContext.setLineDash([]);
    }
}

function setupAddPanelCanvasEvents() {
    addPanelCanvas.removeEventListener('mousedown', addPanelCanvasMouseDown);
    addPanelCanvas.removeEventListener('mousemove', addPanelCanvasMouseMove);
    addPanelCanvas.removeEventListener('mouseup', addPanelCanvasMouseUp);
    addPanelCanvas.removeEventListener('wheel', handleAddPanelZoom);
    
    addPanelCanvas.addEventListener('mousedown', addPanelCanvasMouseDown);
    addPanelCanvas.addEventListener('mousemove', addPanelCanvasMouseMove);
    addPanelCanvas.addEventListener('mouseup', addPanelCanvasMouseUp);
    addPanelCanvas.addEventListener('mouseleave', addPanelCanvasMouseUp);
    addPanelCanvas.addEventListener('wheel', handleAddPanelZoom);
}

// Add Panel Canvas Mouse Events with Zoom Support
function addPanelCanvasMouseDown(e) {
    const rect = addPanelCanvas.getBoundingClientRect();
    // Adjust coordinates for zoom and pan
    const x = (e.clientX - rect.left - addPanelPanX) / addPanelZoomLevel;
    const y = (e.clientY - rect.top - addPanelPanY) / addPanelZoomLevel;
    
    console.log('Add panel mouse down at:', x, y, 'zoom:', addPanelZoomLevel);
    
    if (addPanelCropMode === 'freeform') {
        // Add point for freeform crop
        if (addPanelFreeformPoints.length < 4) {
            addPanelFreeformPoints.push({ x, y });
            updateAddPanelFreeformPointsDisplay();
            drawAddPanelImage();
        }
        return;
    }
    
    if (addPanelCropMode === 'rectangle') {
        handleAddPanelRectangleMouseDown(x, y);
    }
}

function addPanelCanvasMouseMove(e) {
    const rect = addPanelCanvas.getBoundingClientRect();
    // Adjust coordinates for zoom and pan
    const x = (e.clientX - rect.left - addPanelPanX) / addPanelZoomLevel;
    const y = (e.clientY - rect.top - addPanelPanY) / addPanelZoomLevel;
    
    if (addPanelCropMode === 'rectangle') {
        handleAddPanelRectangleMouseMove(x, y);
    }
}

function addPanelCanvasMouseUp(e) {
    addPanelDragging = false;
    addPanelResizing = false;
    addPanelResizeHandle = null;
}

function handleAddPanelRectangleMouseDown(x, y) {
    if (!addPanelRectangleCrop) return;
    
    const handleSize = 8;
    const handles = [
        { name: 'nw', x: addPanelRectangleCrop.x, y: addPanelRectangleCrop.y },
        { name: 'ne', x: addPanelRectangleCrop.x + addPanelRectangleCrop.width, y: addPanelRectangleCrop.y },
        { name: 'sw', x: addPanelRectangleCrop.x, y: addPanelRectangleCrop.y + addPanelRectangleCrop.height },
        { name: 'se', x: addPanelRectangleCrop.x + addPanelRectangleCrop.width, y: addPanelRectangleCrop.y + addPanelRectangleCrop.height },
        { name: 'n', x: addPanelRectangleCrop.x + addPanelRectangleCrop.width/2, y: addPanelRectangleCrop.y },
        { name: 's', x: addPanelRectangleCrop.x + addPanelRectangleCrop.width/2, y: addPanelRectangleCrop.y + addPanelRectangleCrop.height },
        { name: 'w', x: addPanelRectangleCrop.x, y: addPanelRectangleCrop.y + addPanelRectangleCrop.height/2 },
        { name: 'e', x: addPanelRectangleCrop.x + addPanelRectangleCrop.width, y: addPanelRectangleCrop.y + addPanelRectangleCrop.height/2 }
    ];
    
    // Check if clicking on a handle
    for (const handle of handles) {
        if (x >= handle.x - handleSize/2 && x <= handle.x + handleSize/2 &&
            y >= handle.y - handleSize/2 && y <= handle.y + handleSize/2) {
            addPanelResizing = true;
            addPanelResizeHandle = handle.name;
            addPanelDragStart = { x, y };
            return;
        }
    }
    
    // Check if clicking inside crop area
    if (x >= addPanelRectangleCrop.x && x <= addPanelRectangleCrop.x + addPanelRectangleCrop.width &&
        y >= addPanelRectangleCrop.y && y <= addPanelRectangleCrop.y + addPanelRectangleCrop.height) {
        addPanelDragging = true;
        addPanelDragStart = { x: x - addPanelRectangleCrop.x, y: y - addPanelRectangleCrop.y };
    }
}

function handleAddPanelRectangleMouseMove(x, y) {
    if (addPanelDragging && addPanelRectangleCrop) {
        const newX = x - addPanelDragStart.x;
        const newY = y - addPanelDragStart.y;
        
        // Keep within bounds
        addPanelRectangleCrop.x = Math.max(0, Math.min(newX, addPanelCanvas.width - addPanelRectangleCrop.width));
        addPanelRectangleCrop.y = Math.max(0, Math.min(newY, addPanelCanvas.height - addPanelRectangleCrop.height));
        
        drawAddPanelImage();
    } else if (addPanelResizing && addPanelRectangleCrop && addPanelResizeHandle) {
        const dx = x - addPanelDragStart.x;
        const dy = y - addPanelDragStart.y;
        const aspectRatio = addPanelRectangleCrop.width / addPanelRectangleCrop.height;
        addPanelMaintainAspect = document.getElementById('addPanelMaintainAspect')?.checked || false;
        
        const originalCrop = { ...addPanelRectangleCrop };
        
        switch (addPanelResizeHandle) {
            case 'nw':
                addPanelRectangleCrop.x += dx;
                addPanelRectangleCrop.y += dy;
                addPanelRectangleCrop.width -= dx;
                addPanelRectangleCrop.height -= dy;
                break;
            case 'ne':
                addPanelRectangleCrop.y += dy;
                addPanelRectangleCrop.width += dx;
                addPanelRectangleCrop.height -= dy;
                break;
            case 'sw':
                addPanelRectangleCrop.x += dx;
                addPanelRectangleCrop.width -= dx;
                addPanelRectangleCrop.height += dy;
                break;
            case 'se':
                addPanelRectangleCrop.width += dx;
                addPanelRectangleCrop.height += dy;
                break;
            case 'n':
                addPanelRectangleCrop.y += dy;
                addPanelRectangleCrop.height -= dy;
                break;
            case 's':
                addPanelRectangleCrop.height += dy;
                break;
            case 'w':
                addPanelRectangleCrop.x += dx;
                addPanelRectangleCrop.width -= dx;
                break;
            case 'e':
                addPanelRectangleCrop.width += dx;
                break;
        }
        
        if (addPanelMaintainAspect) {
            if (addPanelResizeHandle.includes('e') || addPanelResizeHandle.includes('w')) {
                addPanelRectangleCrop.height = addPanelRectangleCrop.width / aspectRatio;
            } else if (addPanelResizeHandle.includes('n') || addPanelResizeHandle.includes('s')) {
                addPanelRectangleCrop.width = addPanelRectangleCrop.height * aspectRatio;
            }
        }
        
        // Ensure minimum size
        if (addPanelRectangleCrop.width < 20 || addPanelRectangleCrop.height < 20) {
            addPanelRectangleCrop = originalCrop;
        }
        
        // Keep within bounds
        if (addPanelRectangleCrop.x < 0 || addPanelRectangleCrop.y < 0 || 
            addPanelRectangleCrop.x + addPanelRectangleCrop.width > addPanelCanvas.width ||
            addPanelRectangleCrop.y + addPanelRectangleCrop.height > addPanelCanvas.height) {
            addPanelRectangleCrop = originalCrop;
        }
        
        addPanelDragStart = { x, y };
        drawAddPanelImage();
    }
}

function handleAddPanelFreeformMouseDown(x, y) {
    if (addPanelFreeformPoints.length < 4) {
        addPanelFreeformPoints.push({ x, y });
        updateAddPanelFreeformPointsDisplay();
        drawAddPanelImage();
    }
}

function updateAddPanelFreeformPointsDisplay() {
    const pointsDiv = document.getElementById('addPanelFreeformPoints');
    if (!pointsDiv) return;
    
    pointsDiv.innerHTML = '';
    if (addPanelFreeformPoints.length === 0) {
        pointsDiv.innerHTML = '<div style="text-align: center; color: var(--text-muted);">No points selected</div>';
        return;
    }
    
    addPanelFreeformPoints.forEach((point, index) => {
        const pointDiv = document.createElement('div');
        pointDiv.className = 'freeform-point';
        pointDiv.innerHTML = `
            <span>Point ${index + 1}:</span>
            <span>(${Math.round(point.x)}, ${Math.round(point.y)})</span>
        `;
        pointsDiv.appendChild(pointDiv);
    });
}

function clearAddPanelFreeformPoints() {
    addPanelFreeformPoints = [];
    updateAddPanelFreeformPointsDisplay();
    if (addPanelCanvas) {
        drawAddPanelImage();
    }
}

function updateAddPanelPreview() {
    if (!addPanelPreviewContext || !addPanelImage) return;
    
    addPanelPreviewContext.clearRect(0, 0, addPanelPreviewCanvas.width, addPanelPreviewCanvas.height);
    
    if (addPanelCropMode === 'rectangle' && addPanelRectangleCrop) {
        // Calculate source coordinates
        const sourceX = addPanelRectangleCrop.x * (addPanelImage.width / addPanelCanvas.width);
        const sourceY = addPanelRectangleCrop.y * (addPanelImage.height / addPanelCanvas.height);
        const sourceWidth = addPanelRectangleCrop.width * (addPanelImage.width / addPanelCanvas.width);
        const sourceHeight = addPanelRectangleCrop.height * (addPanelImage.height / addPanelCanvas.height);
        
        // Draw cropped preview
        const scale = Math.min(addPanelPreviewCanvas.width / sourceWidth, addPanelPreviewCanvas.height / sourceHeight);
        const previewWidth = sourceWidth * scale;
        const previewHeight = sourceHeight * scale;
        const offsetX = (addPanelPreviewCanvas.width - previewWidth) / 2;
        const offsetY = (addPanelPreviewCanvas.height - previewHeight) / 2;
        
        addPanelPreviewContext.drawImage(addPanelImage, sourceX, sourceY, sourceWidth, sourceHeight,
                                        offsetX, offsetY, previewWidth, previewHeight);
    }
}

async function createNewPanel() {
    console.log('Creating new panel for page:', currentPageForNewPanel);
    
    if (!currentPageForNewPanel) {
        console.error('No page selected for new panel');
        return;
    }
    
    try {
        let croppedCanvas;
        
        if (addPanelCropMode === 'rectangle' && addPanelRectangleCrop) {
            console.log('Applying rectangle crop:', addPanelRectangleCrop);
            croppedCanvas = applyAddPanelCropRectangle();
        } else if (addPanelCropMode === 'freeform' && addPanelFreeformPoints.length === 4) {
            console.log('Applying freeform crop with points:', addPanelFreeformPoints);
            croppedCanvas = applyAddPanelCropFreeform();
        } else {
            console.error('No valid crop area defined. Mode:', addPanelCropMode, 'Rectangle crop:', addPanelRectangleCrop, 'Freeform points:', addPanelFreeformPoints.length);
            return;
        }
        
        if (!croppedCanvas) {
            console.error('Failed to create cropped canvas');
            return;
        }
        
        console.log('Cropped canvas created, converting to blob...');
        
        // Convert to blob and upload
        croppedCanvas.toBlob(async (blob) => {
            console.log('Blob created, size:', blob.size);
            const formData = new FormData();
            const timestamp = Date.now();
            const filename = `panel_${currentPageForNewPanel}_new_${timestamp}.png`;
            formData.append('files', blob, filename);
            
            console.log('Uploading panel:', filename);
            
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });
            
            console.log('Upload response status:', response.status);
            
            if (response.ok) {
                const result = await response.json();
                console.log('Upload result:', result);
                
                if (result.filenames && result.filenames.length > 0) {
                    // Add new panel to project data
                    const panelUrl = `/uploads/${result.filenames[0]}`;
                    console.log('Adding new panel to page:', currentPageForNewPanel, 'URL:', panelUrl);
                    
                    // Store the page number before closing modal (which resets currentPageForNewPanel)
                    const targetPageNumber = currentPageForNewPanel;
                    
                    addNewPanelToPage(targetPageNumber, panelUrl);
                    closeAddPanelModal();
                    
                    // Save the updated project data to the backend
                    try {
                        const response = await fetch(`/api/manga/${projectData.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                workflow: projectData.workflow
                            })
                        });
                        
                        if (response.ok) {
                            console.log('Project data saved after adding new panel');
                        } else {
                            console.error('Failed to save project data:', response.status, await response.text());
                        }
                    } catch (error) {
                        console.error('Failed to save project data:', error);
                    }
                    
                    // Small delay to ensure data is updated before opening panel editor
                    setTimeout(() => {
                        // Open the panel editor modal to show the new panel
                        console.log('Opening panel editor modal for page:', targetPageNumber);
                        const panelEditorModal = document.getElementById('panelEditorModal');
                        if (panelEditorModal) {
                            panelEditorModal.style.display = 'block';
                        } else {
                            console.error('Panel editor modal not found');
                        }
                        
                        // Refresh panel editor content
                        console.log('Loading panel editor content after panel creation for page:', targetPageNumber);
                        console.log('Project data after panel creation:', {
                            hasWorkflow: !!projectData.workflow,
                            hasPanels: !!(projectData.workflow?.panels),
                            panelsDataLength: projectData.workflow?.panels?.data?.length || 0,
                            targetPageData: projectData.workflow?.panels?.data?.find(p => parseInt(p.page_number) === parseInt(targetPageNumber))
                        });
                        loadPanelEditorContent(targetPageNumber);
                        console.log('New panel created successfully');
                    }, 100);
                } else {
                    console.error('No filenames in upload response:', result);
                }
            } else {
                const errorText = await response.text();
                console.error('Upload failed:', response.status, errorText);
            }
        }, 'image/png');
        
    } catch (error) {
        console.error('Error creating panel:', error);
    }
}

function applyAddPanelCropRectangle() {
    if (!addPanelRectangleCrop) return null;
    
    // Calculate crop coordinates relative to original image
    const scaleX = addPanelImage.width / addPanelCanvas.width;
    const scaleY = addPanelImage.height / addPanelCanvas.height;
    
    const cropData = {
        x: Math.round(addPanelRectangleCrop.x * scaleX),
        y: Math.round(addPanelRectangleCrop.y * scaleY),
        width: Math.round(addPanelRectangleCrop.width * scaleX),
        height: Math.round(addPanelRectangleCrop.height * scaleY)
    };
    
    const croppedCanvas = document.createElement('canvas');
    const croppedContext = croppedCanvas.getContext('2d');
    croppedCanvas.width = cropData.width;
    croppedCanvas.height = cropData.height;
    
    croppedContext.drawImage(addPanelImage, 
        cropData.x, cropData.y, cropData.width, cropData.height,
        0, 0, cropData.width, cropData.height
    );
    
    return croppedCanvas;
}

function applyAddPanelCropFreeform() {
    if (addPanelFreeformPoints.length !== 4) return null;
    
    // Calculate points relative to original image
    const scaleX = addPanelImage.width / addPanelCanvas.width;
    const scaleY = addPanelImage.height / addPanelCanvas.height;
    
    const scaledPoints = addPanelFreeformPoints.map(point => ({
        x: point.x * scaleX,
        y: point.y * scaleY
    }));
    
    // Find bounding box
    const minX = Math.min(...scaledPoints.map(p => p.x));
    const maxX = Math.max(...scaledPoints.map(p => p.x));
    const minY = Math.min(...scaledPoints.map(p => p.y));
    const maxY = Math.max(...scaledPoints.map(p => p.y));
    
    const width = maxX - minX;
    const height = maxY - minY;
    
    const croppedCanvas = document.createElement('canvas');
    const croppedContext = croppedCanvas.getContext('2d');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    
    // Create clipping path
    croppedContext.beginPath();
    croppedContext.moveTo(scaledPoints[0].x - minX, scaledPoints[0].y - minY);
    for (let i = 1; i < scaledPoints.length; i++) {
        croppedContext.lineTo(scaledPoints[i].x - minX, scaledPoints[i].y - minY);
    }
    croppedContext.closePath();
    croppedContext.clip();
    
    // Draw image with clipping
    croppedContext.drawImage(addPanelImage, -minX, -minY);
    
    return croppedCanvas;
}

function resetAddPanelCrop() {
    if (addPanelCropMode === 'rectangle') {
        initializeAddPanelRectangleCrop();
    } else {
        addPanelFreeformPoints = [];
        updateAddPanelFreeformPointsDisplay();
    }
    
    if (addPanelCanvas) {
        drawAddPanelImage();
    }
}

function closeAddPanelModal() {
    const modal = document.getElementById('addPanelModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    currentPageForNewPanel = null;
    addPanelRectangleCrop = null;
    addPanelFreeformPoints = [];
    addPanelImage = null;
    
    // Remove event listeners
    if (addPanelCanvas) {
        addPanelCanvas.removeEventListener('mousedown', addPanelCanvasMouseDown);
        addPanelCanvas.removeEventListener('mousemove', addPanelCanvasMouseMove);
        addPanelCanvas.removeEventListener('mouseup', addPanelCanvasMouseUp);
    }
}

function addNewPanelToPage(pageNumber, panelUrl) {
    console.log('Adding new panel to page:', pageNumber, 'URL:', panelUrl);
    
    // Get or create page data
    if (!projectData.workflow) projectData.workflow = {};
    if (!projectData.workflow.panels) projectData.workflow.panels = { status: 'pending', data: [] };
    
    let pageData = projectData.workflow.panels.data.find(p => parseInt(p.page_number) === parseInt(pageNumber));
    if (!pageData) {
        pageData = {
            page_number: parseInt(pageNumber),
            filename: '', // Will be updated if needed
            panels: [],
            boxes: []
        };
        projectData.workflow.panels.data.push(pageData);
        console.log('Created new page data for page:', pageNumber);
    }
    
    // Add new panel - using matched_text instead of text to match existing structure
    const newPanel = {
        filename: panelUrl.split('/').pop(),
        url: panelUrl,
        matched_text: '', // Use matched_text instead of text
        effect: 'slide_lr',
        transition: 'fade'
    };
    
    pageData.panels.push(newPanel);
    console.log('Added panel to page. Page now has', pageData.panels.length, 'panels');
    console.log('New panel:', newPanel);
    console.log('Full page data after adding panel:', pageData);
}

// Make functions globally available
window.openPanelImageEditor = openPanelImageEditor;
window.closePanelImageEditor = closePanelImageEditor;
window.setCropMode = setCropMode;
window.applyCropSquare = applyCropSquare;
window.resetCrop = resetCrop;
window.addBorderToPanel = addBorderToPanel;
window.addBorderToCurrentPanel = addBorderToCurrentPanel;
window.clearFreeformPoints = clearFreeformPoints;
window.updatePanelInUI = updatePanelInUI;
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.resetZoom = resetZoom;
window.openAddPanelModal = openAddPanelModal;
window.closeAddPanelModal = closeAddPanelModal;
window.setAddPanelCropMode = setAddPanelCropMode;
window.createNewPanel = createNewPanel;
window.resetAddPanelCrop = resetAddPanelCrop;
window.clearAddPanelFreeformPoints = clearAddPanelFreeformPoints;
window.addPanelZoomIn = addPanelZoomIn;
window.addPanelZoomOut = addPanelZoomOut;
window.addPanelResetZoom = addPanelResetZoom;

function handleAddPanelZoom(e) {
    e.preventDefault();
    const rect = addPanelCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.1, Math.min(5, addPanelZoomLevel * zoomFactor));
    
    // Adjust pan to zoom towards mouse position
    addPanelPanX = mouseX - (mouseX - addPanelPanX) * (newZoom / addPanelZoomLevel);
    addPanelPanY = mouseY - (mouseY - addPanelPanY) * (newZoom / addPanelZoomLevel);
    
    addPanelZoomLevel = newZoom;
    updateAddPanelZoomDisplay();
    drawAddPanelImage();
}

function addPanelZoomIn() {
    addPanelZoomLevel = Math.min(5, addPanelZoomLevel * 1.2);
    updateAddPanelZoomDisplay();
    drawAddPanelImage();
    console.log('Add panel zoomed in to:', addPanelZoomLevel);
}

function addPanelZoomOut() {
    addPanelZoomLevel = Math.max(0.1, addPanelZoomLevel / 1.2);
    updateAddPanelZoomDisplay();
    drawAddPanelImage();
    console.log('Add panel zoomed out to:', addPanelZoomLevel);
}

function addPanelResetZoom() {
    addPanelZoomLevel = 1;
    addPanelPanX = 0;
    addPanelPanY = 0;
    updateAddPanelZoomDisplay();
    drawAddPanelImage();
    console.log('Add panel zoom reset');
}

function updateAddPanelZoomDisplay() {
    const zoomDisplay = document.querySelector('#addPanelModal .zoom-level');
    if (zoomDisplay) {
        zoomDisplay.textContent = `${Math.round(addPanelZoomLevel * 100)}%`;
    }
}
window.addPanelZoomIn = addPanelZoomIn;
window.addPanelZoomOut = addPanelZoomOut;
window.addPanelResetZoom = addPanelResetZoom;

function handleAddPanelZoom(e) {
    e.preventDefault();
    const rect = addPanelCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.1, Math.min(5, addPanelZoomLevel * zoomFactor));
    
    // Adjust pan to zoom towards mouse position
    addPanelPanX = mouseX - (mouseX - addPanelPanX) * (newZoom / addPanelZoomLevel);
    addPanelPanY = mouseY - (mouseY - addPanelPanY) * (newZoom / addPanelZoomLevel);
    
    addPanelZoomLevel = newZoom;
    updateAddPanelZoomDisplay();
    drawAddPanelImage();
}

// Add keyboard shortcuts for panel editing modals
document.addEventListener('keydown', function(e) {
    // Panel Image Editor shortcuts
    const panelImageModal = document.getElementById('panelImageEditorModal');
    const addPanelModal = document.getElementById('addPanelModal');
    
    if (panelImageModal && panelImageModal.style.display === 'block') {
        if (e.key === 'Escape') {
            closePanelImageEditor();
        } else if (e.key === 'Enter') {
            applyCropSquare();
        } else if (e.key === 'r' || e.key === 'R') {
            resetCrop();
        }
    }
    
    if (addPanelModal && addPanelModal.style.display === 'block') {
        if (e.key === 'Escape') {
            closeAddPanelModal();
        } else if (e.key === 'Enter') {
            createNewPanel();
        } else if (e.key === 'r' || e.key === 'R') {
            resetAddPanelCrop();
        }
    }
});

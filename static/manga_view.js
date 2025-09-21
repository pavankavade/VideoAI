// Manga View JavaScript
let currentImageIndex = 0;
let projectData = null;

document.addEventListener('DOMContentLoaded', () => {
    projectData = window.projectData;
    updateCarouselControls();
    initializeTheme();
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
    
    // Check initial model status
    checkModelStatus();
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

// JSON Upload functionality for narrative
function toggleJsonUpload() {
    const modal = document.getElementById('jsonUploadModal');
    modal.style.display = 'block';
    document.getElementById('jsonTextArea').focus();
}

function closeJsonUploadModal() {
    const modal = document.getElementById('jsonUploadModal');
    const textArea = document.getElementById('jsonTextArea');
    modal.style.display = 'none';
    textArea.value = '';
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

function openPanelEditor(pageNumber) {
    currentEditingPage = pageNumber;
    const modal = document.getElementById('panelEditorModal');
    const title = document.getElementById('panelEditorTitle');
    const narrationDiv = document.getElementById('panelEditorNarration');
    const contentDiv = document.getElementById('panelEditorContent');
    const statsDiv = document.getElementById('panelEditorStats');
    
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
                return `
                    <div class="panel-editor-item" data-panel-index="${index}" draggable="true">
                        <div class="drag-handle">⋮⋮</div>
                        <img src="${panel.url}" alt="Panel ${index + 1}" class="panel-editor-image" onclick="viewPanelFullscreen('${panel.url}', '${panel.filename}')">
                        <div class="panel-editor-info">
                            <div class="panel-editor-label">Panel ${index + 1}${hasText ? ' ✓' : ''}</div>
                            <textarea class="panel-editor-textarea ${hasText ? 'has-text' : ''}" data-panel-index="${index}" placeholder="Enter narration text for this panel...">${existingText}</textarea>
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
                                <source src="${URL.createObjectURL(ttsData[pageNumber].audioBlob)}" type="audio/wav">
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
    
    // Add drag and drop functionality
    initializeDragAndDrop();
}

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

async function ensureModelsLoaded() {
    try {
    const r = await fetch('/ngrok/status', { headers: ngrokHeaders });
        if (!r.ok) { 
            return false; 
        }
        const j = await r.json();
        
        if (j.loaded) {
            modelsLoaded = true;
            return true;
        }

        // Models not loaded, start background load
        const desiredDevice = 'cpu';
        await fetch(`/ngrok/load_models?device=${encodeURIComponent(desiredDevice)}&force=true`, { 
            method: 'POST', 
            headers: ngrokHeaders 
        });
        
        for (let i = 0; i < 600; i++) {
            await new Promise(res => setTimeout(res, 1000));
            const s = await fetch('/ngrok/status', { headers: ngrokHeaders });
            if (s.ok) {
                const js = await s.json();
                if (js.loaded) {
                    modelsLoaded = true;
                    return true;
                }
            }
        }
        return false;
    } catch (e) {
        console.warn(e);
        return false;
    }
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
    
    try {
        // Use the reference implementation pattern
        const desiredDevice = 'cpu'; // Default to CPU
        const response = await fetch(`/ngrok/load_models?device=${encodeURIComponent(desiredDevice)}&force=true`, {
            method: 'POST',
            headers: ngrokHeaders
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load models: ${response.status}`);
        }
        
        if (statusText) statusText.textContent = 'Models are loading in the background...';
        
        // Poll for status using the reference implementation pattern
        for (let i = 0; i < 600; i++) {
            await new Promise(res => setTimeout(res, 1000));
            const statusResponse = await fetch('/ngrok/status', { 
                headers: ngrokHeaders 
            });
            
            if (statusResponse.ok) {
                const statusData = await statusResponse.json();
                
                if (statusData.loaded) {
                    modelsLoaded = true;
                    if (statusText) statusText.textContent = '✅ Models loaded successfully!';
                    if (statusEl) statusEl.style.borderLeftColor = '#10b981';
                    if (btn) btn.textContent = '✅ Models Loaded';
                    if (btn) btn.style.background = '#10b981';
                    if (spinner) spinner.style.display = 'none';
                    return;
                } else if (statusData.loading) {
                    if (statusText) statusText.textContent = `Loading models... (${i + 1}s)`;
                } else {
                    if (statusText) statusText.textContent = '❌ Failed to load models';
                    if (statusEl) statusEl.style.borderLeftColor = '#dc2626';
                    if (btn) btn.textContent = '🔧 Load TTS Models';
                    if (btn) btn.style.background = '';
                    if (spinner) spinner.style.display = 'none';
                    return;
                }
            }
        }
        
        // Timeout
        if (statusText) statusText.textContent = '❌ Model loading timed out';
        if (statusEl) statusEl.style.borderLeftColor = '#dc2626';
        if (btn) btn.textContent = '🔧 Load TTS Models';
        if (btn) btn.style.background = '';
        if (spinner) spinner.style.display = 'none';
        
    } catch (error) {
        console.error('Error loading TTS models:', error);
        if (statusText) statusText.textContent = `❌ Failed to load models: ${error.message}`;
        if (statusEl) statusEl.style.borderLeftColor = '#dc2626';
        if (btn) btn.textContent = '🔧 Load TTS Models';
        if (btn) btn.style.background = '';
        if (spinner) spinner.style.display = 'none';
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function synthesizeAllPages() {
    const btn = document.getElementById('synthesizeAllBtn');
    const progressEl = document.getElementById('ttsProgress');
    const bar = document.getElementById('ttsBar');
    const label = document.getElementById('ttsLabel');
    const count = document.getElementById('ttsCount');
    const output = document.getElementById('ttsOutput');
    
    // Check if models are loaded using the reference implementation pattern
    const loaded = await ensureModelsLoaded();
    if (!loaded) {
        alert('Models not available. Try clicking Load Models.');
        return;
    }
    
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
                
                // Store audio data
                const pageNumber = pageLabel.replace('Page', '');
                ttsData[pageNumber] = {
                    audioBlob: audioBlob,
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
                'workflow.tts.data': ttsData
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
    
    // Check if models are loaded using the reference implementation pattern
    const loaded = await ensureModelsLoaded();
    if (!loaded) {
        alert('Models not available. Try clicking Load Models.');
        return;
    }
    
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
        
        // Store audio data
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            text: narration[1],
            pageNumber: parseInt(pageNumber)
        };
        
        // Save audio locally
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
                'workflow.tts.data': ttsData
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
    
    // Check if models are loaded using the reference implementation pattern
    const loaded = await ensureModelsLoaded();
    if (!loaded) {
        alert('Models not available. Try clicking Load Models.');
        return;
    }
    
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
        
        // Store audio data
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            text: narration[1],
            pageNumber: parseInt(pageNumber)
        };
        
        // Save audio locally
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
                'workflow.tts.data': ttsData
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
                        <source src="${URL.createObjectURL(ttsData[pageNumber].audioBlob)}" type="audio/wav">
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
                    <source src="${URL.createObjectURL(ttsData[pageNumber].audioBlob)}" type="audio/wav">
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
    
    // Check if models are loaded using the reference implementation pattern
    const loaded = await ensureModelsLoaded();
    if (!loaded) {
        alert('Models not available. Try clicking Load Models.');
        return;
    }
    
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
        
        // Store audio data
        ttsData[pageNumber] = {
            audioBlob: audioBlob,
            text: narration[1],
            pageNumber: parseInt(pageNumber)
        };
        
        // Save audio locally
        await saveAudioLocally(pageNumber, audioBlob);
        
        // Update page audio controls
        updatePageAudioControls(pageNumber, true);
        
        // Update TTS output display if it exists
        const ttsAudioPlayer = document.getElementById(`audio-player-${pageNumber}`);
        if (ttsAudioPlayer) {
            ttsAudioPlayer.innerHTML = `
                <source src="${URL.createObjectURL(audioBlob)}" type="audio/wav">
                Your browser does not support the audio element.
            `;
        }
        
        // Update Panel Editor audio player if it exists
        const panelEditorAudioPlayer = document.getElementById(`audio-player-panel-editor-${pageNumber}`);
        if (panelEditorAudioPlayer) {
            panelEditorAudioPlayer.innerHTML = `
                <source src="${URL.createObjectURL(audioBlob)}" type="audio/wav">
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
    const formData = new FormData();
    formData.append('text', text);
    formData.append('exaggeration', '0.5');
    formData.append('cfg_weight', '0.5');
    formData.append('temperature', '0.8');
    
    const response = await fetch(`/api/manga/${projectData.id}/tts/synthesize`, {
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
                <source src="${URL.createObjectURL(data.audioBlob)}" type="audio/wav">
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
            throw new Error('Failed to match text to panels');
        }
        
        const data = await response.json();
        
        // Update project data
        const tmData = projectData.workflow.text_matching.data || [];
        const pageIndex = tmData.findIndex(p => p.page_number === currentEditingPage);
        if (pageIndex >= 0) {
            tmData[pageIndex] = data.page;
        } else {
            tmData.push(data.page);
        }
        projectData.workflow.text_matching.data = tmData;
        
        // Refresh the panel editor content
        loadPanelEditorContent(currentEditingPage);
        
        alert('Text matching completed for this page!');
        
    } catch (error) {
        console.error('Error matching text to current page:', error);
        alert('Failed to match text to panels for this page. Please try again.');
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
            throw new Error('Failed to detect panels');
        }
        
        const data = await response.json();
        
        // Update project data
        const panelsData = projectData.workflow.panels.data || [];
        const pageIndex = panelsData.findIndex(p => p.page_number === currentEditingPage);
        if (pageIndex >= 0) {
            panelsData[pageIndex] = data.page;
        } else {
            panelsData.push(data.page);
        }
        projectData.workflow.panels.data = panelsData;
        
        // Refresh the panel editor content
        loadPanelEditorContent(currentEditingPage);
        
        alert('Panel detection completed for this page!');
        
    } catch (error) {
        console.error('Error detecting panels for current page:', error);
        alert('Failed to detect panels for this page. Please try again.');
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
    
    // Reorder the panels array
    const panels = pageData.panels;
    const movedPanel = panels.splice(fromIndex, 1)[0];
    panels.splice(toIndex, 0, movedPanel);
    
    // Reorder the text content array to match the new panel order
    const movedText = currentTexts.splice(fromIndex, 1)[0];
    currentTexts.splice(toIndex, 0, movedText);
    
    // Update panel matched_text with the reordered text content
    panels.forEach((panel, index) => {
        panel.matched_text = currentTexts[index] || '';
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
        // Collect panel texts
        const panelTexts = {};
        textareas.forEach(textarea => {
            const panelIndex = parseInt(textarea.dataset.panelIndex);
            panelTexts[panelIndex] = textarea.value.trim();
        });
        
        // Get current panels data
        const panelsData = projectData.workflow?.panels?.data || [];
        const pageData = panelsData.find(p => parseInt(p.page_number) === parseInt(currentEditingPage));
        
        if (!pageData) {
            throw new Error('Page data not found');
        }
        
        // Update panel texts
        pageData.panels.forEach((panel, index) => {
            panel.matched_text = panelTexts[index] || '';
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

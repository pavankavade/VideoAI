// Manga Dashboard JavaScript
let mangaProjects = [];

// Load manga projects from localStorage on page load
document.addEventListener('DOMContentLoaded', () => {
  loadMangaProjects();
  setupEventListeners();
  initializeTheme();
});

function setupEventListeners() {
  // Image file upload area
  const fileUploadArea = document.getElementById('fileUploadArea');
  const fileInput = document.getElementById('chapterUpload');
  
  fileUploadArea.addEventListener('click', () => fileInput.click());
  fileUploadArea.addEventListener('dragover', handleDragOver);
  fileUploadArea.addEventListener('dragleave', handleDragLeave);
  fileUploadArea.addEventListener('drop', handleDrop);
  
  fileInput.addEventListener('change', handleFileSelect);
  
  // JSON file upload area
  const jsonUploadArea = document.getElementById('jsonUploadArea');
  const jsonInput = document.getElementById('jsonUpload');
  
  jsonUploadArea.addEventListener('click', () => jsonInput.click());
  jsonUploadArea.addEventListener('dragover', handleDragOver);
  jsonUploadArea.addEventListener('dragleave', handleDragLeave);
  jsonUploadArea.addEventListener('drop', handleJsonDrop);
  
  jsonInput.addEventListener('change', handleJsonFileSelect);
  
  // Form submission
  document.getElementById('addMangaForm').addEventListener('submit', handleAddManga);
}

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
}

function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files);
  handleFiles(files);
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  handleFiles(files);
}

function handleFiles(files) {
  const fileList = document.getElementById('fileList');
  fileList.innerHTML = '';
  fileList.classList.remove('hidden');
  
  files.forEach((file, index) => {
    const fileItem = document.createElement('div');
    fileItem.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px; background: #f8fafc; border-radius: 6px; margin-bottom: 8px;';
    
    const fileName = document.createElement('span');
    fileName.textContent = file.name;
    fileName.style.flex = '1';
    
    const fileSize = document.createElement('span');
    fileSize.textContent = `(${(file.size / 1024 / 1024).toFixed(2)} MB)`;
    fileSize.style.color = '#6b7280';
    fileSize.style.fontSize = '12px';
    
    fileItem.appendChild(fileName);
    fileItem.appendChild(fileSize);
    fileList.appendChild(fileItem);
  });
}

function handleJsonDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files);
  handleJsonFiles(files);
}

function handleJsonFileSelect(e) {
  const files = Array.from(e.target.files);
  handleJsonFiles(files);
}

function handleJsonFiles(files) {
  const jsonFileInfo = document.getElementById('jsonFileInfo');
  jsonFileInfo.innerHTML = '';
  jsonFileInfo.classList.remove('hidden');
  
  files.forEach((file, index) => {
    if (file.type === 'application/json' || file.name.toLowerCase().endsWith('.json')) {
      const fileItem = document.createElement('div');
      fileItem.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px; background: #f0f9ff; border-radius: 6px; margin-bottom: 8px; border: 1px solid #0ea5e9;';
      
      const fileName = document.createElement('span');
      fileName.textContent = file.name;
      fileName.style.flex = '1';
      fileName.style.fontWeight = '500';
      
      const fileSize = document.createElement('span');
      fileSize.textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
      fileSize.style.color = '#6b7280';
      fileSize.style.fontSize = '12px';
      
      fileItem.appendChild(fileName);
      fileItem.appendChild(fileSize);
      jsonFileInfo.appendChild(fileItem);
    } else {
      alert('Please select a valid JSON file');
    }
  });
}

function toggleUploadType() {
  const uploadType = document.querySelector('input[name="uploadType"]:checked').value;
  const imageGroup = document.getElementById('imageUploadGroup');
  const jsonGroup = document.getElementById('jsonUploadGroup');
  
  if (uploadType === 'images') {
    imageGroup.classList.remove('hidden');
    jsonGroup.classList.add('hidden');
    // Clear JSON file selection
    document.getElementById('jsonUpload').value = '';
    document.getElementById('jsonFileInfo').classList.add('hidden');
  } else {
    imageGroup.classList.add('hidden');
    jsonGroup.classList.remove('hidden');
    // Clear image file selection
    document.getElementById('chapterUpload').value = '';
    document.getElementById('fileList').classList.add('hidden');
  }
}

function openAddModal() {
  document.getElementById('addModal').style.display = 'block';
  document.getElementById('mangaTitle').focus();
}

function closeAddModal() {
  document.getElementById('addModal').style.display = 'none';
  document.getElementById('addMangaForm').reset();
  document.getElementById('fileList').classList.add('hidden');
  document.getElementById('jsonFileInfo').classList.add('hidden');
  // Reset to images upload type
  document.querySelector('input[name="uploadType"][value="images"]').checked = true;
  toggleUploadType();
}

async function handleAddManga(e) {
  e.preventDefault();
  
  const title = document.getElementById('mangaTitle').value.trim();
  const uploadType = document.querySelector('input[name="uploadType"]:checked').value;
  
  if (!title) {
    alert('Please enter a manga title');
    return;
  }

  try {
    let projectData;
    
    if (uploadType === 'images') {
      // Handle image upload
      const files = Array.from(document.getElementById('chapterUpload').files);
      
      if (files.length === 0) {
        alert('Please select at least one image file');
        return;
      }
      
      // Upload files first
      const formData = new FormData();
      files.forEach(file => formData.append('files', file));
      
      const uploadResponse = await fetch('/upload', {
        method: 'POST',
        body: formData
      });
      
      if (!uploadResponse.ok) {
        throw new Error('Upload failed');
      }
      
      const uploadData = await uploadResponse.json();
      const filenames = uploadData.filenames || [];
      
      // Create manga project via API
      const createResponse = await fetch('/api/manga', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          files: filenames
        })
      });
      
      if (!createResponse.ok) {
        throw new Error('Failed to create manga project');
      }
      
      projectData = await createResponse.json();
      
    } else {
      // Handle JSON upload
      const jsonFile = document.getElementById('jsonUpload').files[0];
      
      if (!jsonFile) {
        alert('Please select a JSON file');
        return;
      }
      
      // Upload JSON file first
      const formData = new FormData();
      formData.append('file', jsonFile);
      
      const jsonUploadResponse = await fetch('/upload-json', {
        method: 'POST',
        body: formData
      });
      
      if (!jsonUploadResponse.ok) {
        const errorData = await jsonUploadResponse.json();
        throw new Error(errorData.detail || 'JSON upload failed');
      }
      
      const jsonUploadData = await jsonUploadResponse.json();
      
      // Create manga project with JSON data
      const createResponse = await fetch('/api/manga', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          files: [], // No image files for JSON upload
          json_data: jsonUploadData.data
        })
      });
      
      if (!createResponse.ok) {
        throw new Error('Failed to create manga project');
      }
      
      projectData = await createResponse.json();
    }
    
    // Refresh projects list
    await loadMangaProjects();
    closeAddModal();
    
  } catch (error) {
    console.error('Error creating manga:', error);
    alert(`Failed to create manga project: ${error.message}`);
  }
}

async function loadMangaProjects() {
  try {
    const response = await fetch('/api/manga');
    if (response.ok) {
      const data = await response.json();
      mangaProjects = data.projects || [];
    } else {
      mangaProjects = [];
    }
  } catch (error) {
    console.error('Error loading manga projects:', error);
    mangaProjects = [];
  }
  renderMangaTable();
}

function saveMangaProjects() {
  // No longer needed - using API
}

function renderMangaTable() {
  const tbody = document.getElementById('mangaTableBody');
  
  if (mangaProjects.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          <h3>No manga projects yet</h3>
          <p>Click "Add New Manga" to get started</p>
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = mangaProjects.map(manga => `
    <tr>
      <td>
        <strong>${manga.title}</strong>
      </td>
      <td>
        <span class="status-badge status-${manga.status}">${manga.status}</span>
      </td>
      <td>${manga.chapters} images</td>
      <td>${new Date(manga.createdAt).toLocaleDateString()}</td>
      <td>
        <div class="actions">
          <button class="btn-secondary btn-sm" onclick="viewManga('${manga.id}')">View</button>
          <a class="btn-primary btn-sm" href="/video-editor?project_id=${manga.id}" style="background:#10b981; padding:6px 10px; text-decoration:none; display:inline-flex; align-items:center;">Video Editor</a>
          <button class="btn-danger btn-sm" onclick="deleteManga('${manga.id}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function viewManga(mangaId) {
  const manga = mangaProjects.find(m => m.id === mangaId);
  if (manga) {
    // Store current manga in localStorage for the view page
    localStorage.setItem('currentManga', JSON.stringify(manga));
    // Redirect to manga view page
    window.location.href = `/manga/${mangaId}`;
  }
}

async function deleteManga(mangaId) {
  if (confirm('Are you sure you want to delete this manga project?')) {
    try {
      const response = await fetch(`/api/manga/${mangaId}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        await loadMangaProjects();
      } else {
        alert('Failed to delete manga project');
      }
    } catch (error) {
      console.error('Error deleting manga:', error);
      alert('Failed to delete manga project');
    }
  }
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
  const modal = document.getElementById('addModal');
  if (e.target === modal) {
    closeAddModal();
  }
});

// Dark mode functionality
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  setTheme(savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  localStorage.setItem('theme', newTheme);
}

function setTheme(theme) {
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
}



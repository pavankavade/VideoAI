// MangaDex Viewer - Advanced Search and Filter
(function() {
  'use strict';

  // State
  let currentPage = 1;
  let totalPages = 1;
  let currentFilters = {};
  let selectedTags = [];

  // DOM Elements
  const searchTitle = document.getElementById('searchTitle');
  const statusFilter = document.getElementById('statusFilter');
  const contentRating = document.getElementById('contentRating');
  const yearFilter = document.getElementById('yearFilter');
  const languageFilter = document.getElementById('languageFilter');
  const sortOrder = document.getElementById('sortOrder');
  const minChapters = document.getElementById('minChapters');
  const releaseDateRange = document.getElementById('releaseDateRange');
  const customTag = document.getElementById('customTag');
  const popularTags = document.getElementById('popularTags');
  const selectedTagsContainer = document.getElementById('selectedTags');
  const applyFiltersBtn = document.getElementById('applyFilters');
  const clearFiltersBtn = document.getElementById('clearFilters');
  const quickFilterPopular = document.getElementById('quickFilterPopular');
  const quickFilterRecent = document.getElementById('quickFilterRecent');
  const quickFilterNewReleases = document.getElementById('quickFilterNewReleases');
  const resultsSection = document.getElementById('resultsSection');
  const loadingState = document.getElementById('loadingState');
  const emptyState = document.getElementById('emptyState');
  const mangaResults = document.getElementById('mangaResults');
  const resultsCount = document.getElementById('resultsCount');
  const pagination = document.getElementById('pagination');

  // Initialize
  function init() {
    setupEventListeners();
    // Optionally load some initial data
    // performSearch();
  }

  function setupEventListeners() {
    // Apply filters
    applyFiltersBtn.addEventListener('click', () => {
      currentPage = 1;
      performSearch();
    });

    // Clear filters
    clearFiltersBtn.addEventListener('click', clearAllFilters);

    // Quick filters
    quickFilterPopular.addEventListener('click', () => {
      clearAllFilters();
      minChapters.value = '10';
      releaseDateRange.value = '12';
      sortOrder.value = 'followedCount';
      currentPage = 1;
      performSearch();
    });

    quickFilterRecent.addEventListener('click', () => {
      clearAllFilters();
      minChapters.value = '10';
      releaseDateRange.value = '6';
      sortOrder.value = 'latestUploadedChapter';
      currentPage = 1;
      performSearch();
    });

    quickFilterNewReleases.addEventListener('click', () => {
      clearAllFilters();
      releaseDateRange.value = '3';
      sortOrder.value = 'createdAt';
      currentPage = 1;
      performSearch();
    });

    // Enter key on search
    searchTitle.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        currentPage = 1;
        performSearch();
      }
    });

    // Custom tag input
    customTag.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && customTag.value.trim()) {
        addTag(customTag.value.trim());
        customTag.value = '';
      }
    });

    // Popular tags
    popularTags.addEventListener('click', (e) => {
      const tagPill = e.target.closest('.tag-pill');
      if (tagPill) {
        const tagName = tagPill.dataset.tag;
        if (tagPill.classList.contains('selected')) {
          removeTag(tagName);
          tagPill.classList.remove('selected');
        } else {
          addTag(tagName);
          tagPill.classList.add('selected');
        }
      }
    });

    // View toggle
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (view === 'list') {
          mangaResults.classList.add('list-view');
        } else {
          mangaResults.classList.remove('list-view');
        }
      });
    });
  }

  function addTag(tagName) {
    if (!selectedTags.includes(tagName)) {
      selectedTags.push(tagName);
      renderSelectedTags();
    }
  }

  function removeTag(tagName) {
    selectedTags = selectedTags.filter(t => t !== tagName);
    renderSelectedTags();
    // Also remove selected state from popular tags
    popularTags.querySelectorAll('.tag-pill').forEach(pill => {
      if (pill.dataset.tag === tagName) {
        pill.classList.remove('selected');
      }
    });
  }

  function renderSelectedTags() {
    selectedTagsContainer.innerHTML = '';
    selectedTags.forEach(tag => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill selected';
      pill.innerHTML = `
        ${tag}
        <span class="remove" data-tag="${tag}">×</span>
      `;
      pill.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeTag(tag);
      });
      selectedTagsContainer.appendChild(pill);
    });
  }

  function clearAllFilters() {
    searchTitle.value = '';
    statusFilter.value = '';
    contentRating.value = '';
    yearFilter.value = '';
    languageFilter.value = '';
    sortOrder.value = 'relevance';
    minChapters.value = '';
    releaseDateRange.value = '';
    customTag.value = '';
    selectedTags = [];
    renderSelectedTags();
    popularTags.querySelectorAll('.tag-pill').forEach(pill => {
      pill.classList.remove('selected');
    });
  }

  function gatherFilters() {
    const filters = {};
    
    if (searchTitle.value.trim()) {
      filters.title = searchTitle.value.trim();
    }
    
    if (statusFilter.value) {
      filters.status = [statusFilter.value];
    }
    
    if (contentRating.value) {
      filters.contentRating = [contentRating.value];
    }
    
    if (yearFilter.value) {
      filters.year = parseInt(yearFilter.value);
    }
    
    if (languageFilter.value) {
      filters.originalLanguage = [languageFilter.value];
    }
    
    if (sortOrder.value) {
      filters.order = {};
      filters.order[sortOrder.value] = 'desc';
    }
    
    if (minChapters.value) {
      filters.minChapters = parseInt(minChapters.value);
    }
    
    if (releaseDateRange.value) {
      filters.releaseDateMonths = parseInt(releaseDateRange.value);
    }
    
    if (selectedTags.length > 0) {
      filters.includedTags = selectedTags;
    }
    
    return filters;
  }

  async function performSearch() {
    currentFilters = gatherFilters();
    
    // Show loading, hide others
    showLoading();
    
    try {
      const response = await fetch('/mangadex/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filters: currentFilters,
          page: currentPage,
          limit: 20
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      displayResults(data);
    } catch (error) {
      console.error('Search error:', error);
      showError('Failed to search manga. Please try again.');
      hideLoading();
      showEmpty();
    }
  }

  function displayResults(data) {
    hideLoading();
    
    if (!data.data || data.data.length === 0) {
      showEmpty();
      return;
    }
    
    showResults();
    
    // Update count
    const total = data.total || data.data.length;
    resultsCount.textContent = `${total} result${total !== 1 ? 's' : ''} found`;
    
    // Calculate total pages
    const limit = data.limit || 20;
    totalPages = Math.ceil(total / limit);
    
    // Render manga cards
    renderMangaCards(data.data);
    
    // Render pagination
    renderPagination();
  }

  function renderMangaCards(mangaList) {
    mangaResults.innerHTML = '';
    
    mangaList.forEach(manga => {
      const card = createMangaCard(manga);
      mangaResults.appendChild(card);
    });
  }

  function createMangaCard(manga) {
    const card = document.createElement('div');
    card.className = 'manga-card';
    
    // Get title (preferring English)
    const title = manga.attributes?.title?.en || 
                  manga.attributes?.title?.['ja-ro'] || 
                  manga.attributes?.title?.[Object.keys(manga.attributes?.title || {})[0]] ||
                  'Untitled';
    
    // Get description (preferring English)
    const description = manga.attributes?.description?.en || 
                       manga.attributes?.description?.[Object.keys(manga.attributes?.description || {})[0]] ||
                       'No description available.';
    
    // Get cover image
    const coverRel = manga.relationships?.find(rel => rel.type === 'cover_art');
    const coverFileName = coverRel?.attributes?.fileName || '';
    // MangaDex cover URL format - using 512px version for better quality
    const coverUrl = coverFileName ? 
      `https://uploads.mangadex.org/covers/${manga.id}/${coverFileName}.512.jpg` :
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"%3E%3Crect fill="%231e293b" width="400" height="600"/%3E%3Ctext x="50%25" y="50%25" fill="%2364748b" font-size="20" text-anchor="middle" dominant-baseline="middle"%3ENo Cover%3C/text%3E%3C/svg%3E';
    
    
    // Get author
    const authorRel = manga.relationships?.find(rel => rel.type === 'author');
    const author = authorRel?.attributes?.name || 'Unknown';
    
    // Get status
    const status = manga.attributes?.status || 'unknown';
    
    // Get rating
    const rating = manga.attributes?.rating || 0;
    
    // Get tags
    const tags = manga.attributes?.tags?.slice(0, 5) || [];
    
    // Get year
    const year = manga.attributes?.year || '';
    
    // Get chapter count if available
    const chapterCount = manga.chapterCount || 0;
    
    card.innerHTML = `
      <div class="manga-cover">
        <img src="${coverUrl}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 600%22%3E%3Crect fill=%22%231e293b%22 width=%22400%22 height=%22600%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 fill=%22%2364748b%22 font-size=%2220%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22%3ENo Cover%3C/text%3E%3C/svg%3E'">
        ${rating > 0 ? `
          <div class="manga-rating">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
            ${rating.toFixed(1)}
          </div>
        ` : ''}
        ${status ? `<div class="manga-status status-${status}">${status}</div>` : ''}
      </div>
      <div class="manga-info">
        <h3 class="manga-title">${escapeHtml(title)}</h3>
        <div class="manga-author">by ${escapeHtml(author)}</div>
        <p class="manga-description">${escapeHtml(description)}</p>
        ${tags.length > 0 ? `
          <div class="manga-tags">
            ${tags.map(tag => {
              const tagName = tag.attributes?.name?.en || tag.attributes?.name?.[Object.keys(tag.attributes?.name || {})[0]] || '';
              return `<span class="manga-tag">${escapeHtml(tagName)}</span>`;
            }).join('')}
          </div>
        ` : ''}
        <div class="manga-meta">
          <span>${year || 'Unknown Year'}${chapterCount > 0 ? ` • ${chapterCount} Ch` : ''}</span>
          <span>
            <a href="https://mangadex.org/title/${manga.id}" target="_blank" rel="noopener" style="color: #6366f1; text-decoration: none; font-weight: 600;">
              View on MangaDex →
            </a>
          </span>
        </div>
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(71, 85, 105, 0.3); display: grid; gap: 8px;">
          <button class="btn btn-primary" onclick="window.viewMangaChapters('${manga.id}', '${escapeHtml(title).replace(/'/g, "\\'")}')"; style="width: 100%; justify-content: center; font-size: 14px; padding: 10px;">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
            </svg>
            View Chapters
          </button>
          <button class="btn btn-success" onclick="window.importMangaToDashboard('${manga.id}', '${escapeHtml(title).replace(/'/g, "\\'")}', this)" style="width: 100%; justify-content: center; font-size: 14px; padding: 10px; background: #10b981; border-color: #10b981;">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
            Import to Dashboard
          </button>
        </div>
      </div>
    `;
    
    return card;
  }

  function renderPagination() {
    pagination.innerHTML = '';
    
    if (totalPages <= 1) {
      return;
    }
    
    // Previous button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.innerHTML = '← Previous';
    prevBtn.disabled = currentPage === 1;
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        performSearch();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    pagination.appendChild(prevBtn);
    
    // Page info
    const pageInfo = document.createElement('span');
    pageInfo.className = 'page-info';
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    pagination.appendChild(pageInfo);
    
    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.innerHTML = 'Next →';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        currentPage++;
        performSearch();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    pagination.appendChild(nextBtn);
  }

  function showLoading() {
    resultsSection.style.display = 'none';
    emptyState.style.display = 'none';
    loadingState.style.display = 'block';
  }

  function hideLoading() {
    loadingState.style.display = 'none';
  }

  function showResults() {
    resultsSection.style.display = 'block';
    emptyState.style.display = 'none';
  }

  function showEmpty() {
    resultsSection.style.display = 'none';
    emptyState.style.display = 'block';
  }

  function showError(message) {
    alert(message);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Chapter viewer functionality
  let currentMangaId = null;
  let currentMangaTitle = null;
  let currentChapterId = null;
  let currentPages = [];
  let currentPageIndex = 0;

  window.viewMangaChapters = async function(mangaId, mangaTitle) {
    currentMangaId = mangaId;
    currentMangaTitle = mangaTitle;
    
    const modal = document.getElementById('chapterListModal');
    const modalTitle = document.getElementById('chapterListTitle');
    const chapterListContainer = document.getElementById('chapterListContainer');
    
    modalTitle.textContent = mangaTitle;
    chapterListContainer.innerHTML = '<div style="text-align: center; padding: 40px;"><div class="spinner"></div><div style="margin-top: 16px; color: #94a3b8;">Loading chapters...</div></div>';
    
    modal.style.display = 'flex';
    
    try {
      const response = await fetch(`/mangadex/manga/${mangaId}/chapters?limit=100&order=asc`);
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      displayChapterList(data.data);
    } catch (error) {
      console.error('Error loading chapters:', error);
      chapterListContainer.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #f87171;">
          <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin: 0 auto 16px;">
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">Failed to load chapters</div>
          <div style="font-size: 14px; opacity: 0.7;">${error.message}</div>
        </div>
      `;
    }
  };

  function displayChapterList(chapters) {
    const container = document.getElementById('chapterListContainer');
    
    if (!chapters || chapters.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #94a3b8;">
          <svg width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin: 0 auto 16px; opacity: 0.4;">
            <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
          </svg>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No chapters available</div>
          <div style="font-size: 14px; opacity: 0.7;">This manga doesn't have any English chapters yet</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = '';
    
    chapters.forEach(chapter => {
      const attrs = chapter.attributes || {};
      const chapterNum = attrs.chapter || 'N/A';
      const chapterTitle = attrs.title || '';
      const pages = attrs.pages || 0;
      const publishAt = attrs.publishAt ? new Date(attrs.publishAt).toLocaleDateString() : '';
      
      // Get scanlation group
      const scanlationRel = chapter.relationships?.find(rel => rel.type === 'scanlation_group');
      const scanlationGroup = scanlationRel?.attributes?.name || 'Unknown';
      
      const chapterDiv = document.createElement('div');
      chapterDiv.className = 'chapter-item';
      chapterDiv.innerHTML = `
        <div style="flex: 1;">
          <div style="font-size: 16px; font-weight: 600; color: #e2e8f0; margin-bottom: 4px;">
            Chapter ${chapterNum}${chapterTitle ? ': ' + escapeHtml(chapterTitle) : ''}
          </div>
          <div style="font-size: 13px; color: #94a3b8;">
            ${pages} pages • ${scanlationGroup} • ${publishAt}
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary" onclick="window.previewChapter('${chapter.id}')" style="font-size: 13px; padding: 8px 16px;">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
            </svg>
            Preview
          </button>
          <button class="btn btn-primary" onclick="window.readChapter('${chapter.id}')" style="font-size: 13px; padding: 8px 16px;">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
            </svg>
            Read
          </button>
        </div>
      `;
      container.appendChild(chapterDiv);
    });
  }

  window.previewChapter = async function(chapterId) {
    await loadChapter(chapterId, true);
  };

  window.readChapter = async function(chapterId) {
    await loadChapter(chapterId, false);
  };

  async function loadChapter(chapterId, previewOnly = false) {
    currentChapterId = chapterId;
    currentPageIndex = 0;
    
    const readerModal = document.getElementById('chapterReaderModal');
    const readerContent = document.getElementById('readerContent');
    const readerTitle = document.getElementById('readerTitle');
    
    readerContent.innerHTML = '<div style="text-align: center; padding: 80px;"><div class="spinner"></div><div style="margin-top: 16px; color: #94a3b8;">Loading pages...</div></div>';
    readerModal.style.display = 'flex';
    
    try {
      const response = await fetch(`/mangadex/chapter/${chapterId}/pages`);
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      currentPages = data.pages;
      const chapterInfo = `Chapter ${data.chapterNumber || 'N/A'}${data.chapterTitle ? ': ' + data.chapterTitle : ''}`;
      readerTitle.textContent = `${currentMangaTitle} - ${chapterInfo}`;
      
      if (previewOnly) {
        displayPreview(data);
      } else {
        displayFullReader(data);
      }
    } catch (error) {
      console.error('Error loading chapter:', error);
      readerContent.innerHTML = `
        <div style="text-align: center; padding: 80px; color: #f87171;">
          <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin: 0 auto 16px;">
            <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">Failed to load chapter</div>
          <div style="font-size: 14px; opacity: 0.7;">${error.message}</div>
        </div>
      `;
    }
  }

  function displayPreview(data) {
    const container = document.getElementById('readerContent');
    const previewPages = data.pages.slice(0, 5); // Show first 5 pages
    
    container.innerHTML = `
      <div style="max-width: 900px; margin: 0 auto;">
        <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 16px; margin-bottom: 24px; text-align: center;">
          <div style="font-size: 14px; color: #a5b4fc; font-weight: 600;">
            📖 Preview Mode - Showing first ${previewPages.length} of ${data.totalPages} pages
          </div>
        </div>
        <div id="previewPagesContainer"></div>
        <div style="text-align: center; margin-top: 32px; padding: 32px; background: rgba(15, 23, 42, 0.6); border-radius: 12px;">
          <div style="font-size: 16px; font-weight: 600; color: #e2e8f0; margin-bottom: 16px;">
            Want to read more?
          </div>
          <a href="https://mangadex.org/chapter/${data.chapterId}" target="_blank" rel="noopener" class="btn btn-primary" style="text-decoration: none; display: inline-flex;">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
            </svg>
            Continue Reading on MangaDex
          </a>
        </div>
      </div>
    `;
    
    const pagesContainer = document.getElementById('previewPagesContainer');
    previewPages.forEach((pageUrl, index) => {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'manga-page';
      pageDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 8px; font-size: 13px; color: #94a3b8; font-weight: 600;">
          Page ${index + 1}
        </div>
        <img src="${pageUrl}" alt="Page ${index + 1}" loading="lazy" style="width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);">
      `;
      pagesContainer.appendChild(pageDiv);
    });
  }

  function displayFullReader(data) {
    const container = document.getElementById('readerContent');
    
    container.innerHTML = `
      <div style="max-width: 1000px; margin: 0 auto;">
        <div style="background: rgba(30, 41, 59, 0.8); border-radius: 12px; padding: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; backdrop-filter: blur(10px);">
          <div style="font-size: 14px; color: #cbd5e1; font-weight: 600;">
            Page <span id="currentPageNum">1</span> of ${data.totalPages}
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary" onclick="window.previousPage()" id="prevPageBtn" style="font-size: 13px; padding: 8px 12px;">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7"/>
              </svg>
              Previous
            </button>
            <button class="btn btn-secondary" onclick="window.nextPage()" id="nextPageBtn" style="font-size: 13px; padding: 8px 12px;">
              Next
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
        </div>
        <div id="fullReaderPages"></div>
      </div>
    `;
    
    const pagesContainer = document.getElementById('fullReaderPages');
    data.pages.forEach((pageUrl, index) => {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'manga-page';
      pageDiv.id = `page-${index}`;
      pageDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 12px; font-size: 14px; color: #94a3b8; font-weight: 600;">
          Page ${index + 1}
        </div>
        <img src="${pageUrl}" alt="Page ${index + 1}" loading="lazy" style="width: 100%; border-radius: 8px; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4); margin-bottom: 24px;">
      `;
      pagesContainer.appendChild(pageDiv);
    });
    
    updatePageNavigation();
  }

  window.previousPage = function() {
    if (currentPageIndex > 0) {
      currentPageIndex--;
      scrollToPage(currentPageIndex);
      updatePageNavigation();
    }
  };

  window.nextPage = function() {
    if (currentPageIndex < currentPages.length - 1) {
      currentPageIndex++;
      scrollToPage(currentPageIndex);
      updatePageNavigation();
    }
  };

  function scrollToPage(index) {
    const pageElement = document.getElementById(`page-${index}`);
    if (pageElement) {
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function updatePageNavigation() {
    const currentPageNum = document.getElementById('currentPageNum');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    
    if (currentPageNum) {
      currentPageNum.textContent = currentPageIndex + 1;
    }
    
    if (prevBtn) {
      prevBtn.disabled = currentPageIndex === 0;
    }
    
    if (nextBtn) {
      nextBtn.disabled = currentPageIndex === currentPages.length - 1;
    }
  }

  window.closeChapterList = function() {
    document.getElementById('chapterListModal').style.display = 'none';
  };

  window.closeChapterReader = function() {
    document.getElementById('chapterReaderModal').style.display = 'none';
    currentChapterId = null;
    currentPages = [];
    currentPageIndex = 0;
  };

  // Import manga to dashboard
  window.importMangaToDashboard = async function(mangaId, title, buttonElement) {
    const originalText = buttonElement.innerHTML;
    
    try {
      // Disable button and show loading
      buttonElement.disabled = true;
      buttonElement.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" class="animate-spin">
          <circle cx="12" cy="12" r="10" stroke-width="4" stroke="currentColor" stroke-dasharray="32" fill="none" opacity="0.25"/>
          <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor"/>
        </svg>
        Importing...
      `;
      
      const response = await fetch('/mangadex/import-series', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mangaId }),
      });
      
      const result = await response.json();
      
      if (response.ok && result.success) {
        // Show success message
        const actionText = result.isUpdate ? 'Updated' : 'Imported';
        buttonElement.innerHTML = `
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7"/>
          </svg>
          ${actionText} (${result.chaptersImported} chapters)
        `;
        buttonElement.style.background = '#059669';
        buttonElement.style.borderColor = '#059669';
        
        // Show notification
        const message = result.isUpdate 
          ? `Successfully updated "${result.title}" with ${result.chaptersImported} chapters!`
          : `Successfully imported "${result.title}" with ${result.chaptersImported} chapters!`;
        showNotification(message, 'success');
        
        // Keep success state for a moment, then allow re-import
        setTimeout(() => {
          buttonElement.disabled = false;
          buttonElement.innerHTML = originalText;
          buttonElement.style.background = '#10b981';
          buttonElement.style.borderColor = '#10b981';
        }, 3000);
      } else {
        throw new Error(result.error || 'Import failed');
      }
    } catch (error) {
      console.error('Import error:', error);
      
      // Show error state
      buttonElement.innerHTML = `
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M6 18L18 6M6 6l12 12"/>
        </svg>
        Import Failed
      `;
      buttonElement.style.background = '#ef4444';
      buttonElement.style.borderColor = '#ef4444';
      
      showNotification(`Failed to import: ${error.message}`, 'error');
      
      // Restore button after error
      setTimeout(() => {
        buttonElement.disabled = false;
        buttonElement.innerHTML = originalText;
        buttonElement.style.background = '#10b981';
        buttonElement.style.borderColor = '#10b981';
      }, 3000);
    }
  };

  // Show notification helper
  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
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
      animation: slideIn 0.3s ease-out;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, 5000);
  }

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

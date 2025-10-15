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

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/**
 * Clip Ranker - Leaderboard Page Logic
 * =====================================
 */

// Import types (includes Window interface extension)
import './types';
import type {
  User,
  LeaderboardEntry,
  PersonalRankingEntry,
  Pagination,
  LeaderboardResponse,
  PersonalLeaderboardResponse,
  AddClipResponse,
  ReorderResponse,
  VoterEntry,
  VoterStatsResponse,
  LeaderboardTab,
  LeaderboardSort,
  SortOrder,
  PersonalSortField,
  VoteHistoryEntry,
  VoteHistoryResponse,
} from './types';

import {
  checkAuth,
  showToast,
  escapeHtml,
  formatNumber,
  getTwitchParent,
  getTwitchThumbnail,
  handleThumbnailError,
} from './app';

// Page state
let currentTab: LeaderboardTab = 'global';
let currentSort: LeaderboardSort = 'elo';
let currentOrder: SortOrder = 'desc';
let currentPage: number = 1;
let totalPages: number = 1;
let personalRankings: PersonalRankingEntry[] = [];
let draggedItem: HTMLElement | null = null;
let personalSort: PersonalSortField = 'elo';
let historyModalClipId: number | null = null;

// Helper to get current user from window (set by checkAuth in app.ts)
function getCurrentUser(): User | null {
  return window.currentUser || null;
}

/**
 * Read URL params and set initial state
 */
function initFromUrl(): void {
  const params = new URLSearchParams(window.location.search);

  const tabParam = params.get('tab');
  currentTab = (tabParam === 'me' || tabParam === 'voters') ? tabParam : 'global';

  const sortParam = params.get('sort');
  currentSort = (['elo', 'matches', 'winrate', 'superlikes'] as LeaderboardSort[]).includes(sortParam as LeaderboardSort)
    ? (sortParam as LeaderboardSort)
    : 'elo';

  const orderParam = params.get('order');
  currentOrder = orderParam === 'asc' ? 'asc' : 'desc';

  const pageParam = params.get('page');
  currentPage = parseInt(pageParam || '1', 10);
  if (isNaN(currentPage) || currentPage < 1) currentPage = 1;

  // Update UI to match
  const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null;
  if (sortSelect) sortSelect.value = currentSort;

  const orderIcon = document.getElementById('order-icon');
  if (orderIcon) orderIcon.textContent = currentOrder === 'desc' ? '\u2193' : '\u2191';
}

/**
 * Update URL to reflect current state
 */
function updateUrl(): void {
  const params = new URLSearchParams();

  if (currentTab !== 'global') params.set('tab', currentTab);
  if (currentSort !== 'elo') params.set('sort', currentSort);
  if (currentOrder !== 'desc') params.set('order', currentOrder);
  if (currentPage !== 1) params.set('page', String(currentPage));

  const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
  history.pushState({}, '', newUrl);
}

/**
 * Handle sort dropdown change
 */
function handleSortChange(): void {
  const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null;
  if (sortSelect) {
    currentSort = sortSelect.value as LeaderboardSort;
  }
  currentPage = 1; // Reset to first page
  updateUrl();
  loadGlobalRankings();
}

/**
 * Toggle sort order (asc/desc)
 */
function toggleSortOrder(): void {
  currentOrder = currentOrder === 'desc' ? 'asc' : 'desc';
  const orderIcon = document.getElementById('order-icon');
  if (orderIcon) orderIcon.textContent = currentOrder === 'desc' ? '\u2193' : '\u2191';
  currentPage = 1; // Reset to first page
  updateUrl();
  loadGlobalRankings();
}

/**
 * Go to a specific page
 */
function goToPage(page: number): void {
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  updateUrl();
  loadGlobalRankings();
  // Scroll to top of table
  document.querySelector('.table-container')?.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Switch between tabs
 */
async function switchTab(tab: string): Promise<void> {
  currentTab = tab === 'personal' ? 'me' : (tab === 'voters' ? 'voters' : 'global');
  currentPage = 1; // Reset page on tab switch

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.remove('active');
  });
  const activeTab = document.getElementById(`tab-${tab}`);
  if (activeTab) activeTab.classList.add('active');

  // Show/hide sections
  const globalSection = document.getElementById('global-section');
  const personalSection = document.getElementById('personal-section');
  const votersSection = document.getElementById('voters-section');

  if (globalSection) {
    globalSection.classList.toggle('hidden', tab !== 'global');
  }
  if (personalSection) {
    personalSection.classList.toggle('hidden', tab !== 'personal');
  }
  if (votersSection) {
    votersSection.classList.toggle('hidden', tab !== 'voters');
  }

  // Update URL
  updateUrl();

  // Load data
  if (tab === 'global') {
    await loadGlobalRankings();
  } else if (tab === 'voters') {
    await loadVoterStats();
  } else {
    await loadPersonalRankings();
  }
}

/**
 * Show/hide loading state
 */
function showLoading(show: boolean): void {
  const loadingState = document.getElementById('loading-state');
  if (loadingState) {
    loadingState.classList.toggle('hidden', !show);
  }
}

/**
 * Render global rankings (shared by fresh fetch and cache)
 */
function renderGlobalRankings(data: LeaderboardResponse): void {
  const tbody = document.getElementById('global-body');

  // Update pagination state
  if (data.pagination) {
    totalPages = data.pagination.totalPages;
    updatePaginationUI(data.pagination);
  }

  if (!tbody) return;

  if (data.leaderboard.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">
          No rankings yet. Be the first to <a href="/compare">start comparing</a>!
        </td>
      </tr>
    `;
  } else {
    const clipUrl = (entry: LeaderboardEntry): string =>
      escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`);
    tbody.innerHTML = data.leaderboard.map((entry) => `
      <tr>
        <td class="rank ${getRankClass(entry.rank)}">#${entry.rank}</td>
        <td class="clip-thumbnail">
          <a href="${clipUrl(entry)}" target="_blank" rel="noopener" class="thumbnail-link">
            <img src="${getTwitchThumbnail(entry.twitchSlug)}" alt="${escapeHtml(entry.title || entry.twitchSlug)}" class="clip-thumbnail-img" loading="lazy" onerror="handleThumbnailError(this)" />
          </a>
        </td>
        <td class="clip-name">
          <a href="${clipUrl(entry)}" target="_blank" rel="noopener">
            ${escapeHtml(entry.title || entry.twitchSlug)}
          </a>
        </td>
        <td class="elo">${Math.round(entry.elo || 1500)}</td>
        <td>${formatNumber(entry.matches)}</td>
        <td>${entry.winRate}%</td>
        <td>${formatNumber(entry.globalSuperLikes || 0)}</td>
        <td class="action-column">
          ${getCurrentUser() ? `
            <button class="btn-add" id="add-btn-${entry.id}" data-clip-id="${entry.id}" title="Add to Personal Ranking">
              Rank
            </button>
          ` : ''}
        </td>
      </tr>
    `).join('');

    // Attach event listeners to dynamically created add buttons
    data.leaderboard.forEach((entry) => {
      const addBtn = document.getElementById(`add-btn-${entry.id}`);
      addBtn?.addEventListener('click', () => addToPersonalRankings(entry.id));
    });
  }

  showLoading(false);
}

/**
 * Load global rankings
 */
async function loadGlobalRankings(): Promise<void> {
  const params = new URLSearchParams({
    page: String(currentPage),
    limit: '50',
    sort: currentSort,
    order: currentOrder,
  });

  const apiUrl = `/api/leaderboard?${params.toString()}`;

  // Check for prefetched data (only for default query on page 1)
  const isDefaultQuery = currentPage === 1 && currentSort === 'elo' && currentOrder === 'desc';
  if (isDefaultQuery && window.getCachedApiData) {
    // Use exact prefetch URL to guarantee cache hit (must match router.ts PAGE_API_MAP)
    const prefetchUrl = '/api/leaderboard?page=1&limit=50&sort=elo&order=desc';
    const cached = window.getCachedApiData<LeaderboardResponse>(prefetchUrl);
    if (cached) {
      console.debug('[Leaderboard] Using prefetched data');
      renderGlobalRankings(cached);
      return;
    }
  }

  showLoading(true);

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error('Failed to load rankings');

    const data: LeaderboardResponse = await response.json();
    renderGlobalRankings(data);
  } catch (error) {
    console.error('Failed to load global rankings:', error);
    showToast('Failed to load rankings', 'error');
    showLoading(false);
  }
}

/**
 * Update pagination UI elements
 */
function updatePaginationUI(pagination: Pagination): void {
  const { page, total, totalPages: pages } = pagination;

  // Update info text
  const infoEl = document.getElementById('pagination-info');
  if (infoEl) {
    const start = (page - 1) * 50 + 1;
    const end = Math.min(page * 50, total);
    infoEl.textContent = `Showing ${start}-${end} of ${total}`;
  }

  // Update buttons
  const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('next-btn') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= pages;

  // Update page numbers
  const pageNumbersEl = document.getElementById('page-numbers');
  if (pageNumbersEl) {
    const pageNumbers: (number | string)[] = [];
    const maxVisible = 5;

    if (pages <= maxVisible) {
      for (let i = 1; i <= pages; i++) {
        pageNumbers.push(i);
      }
    } else {
      // Always show first, last, and pages around current
      const start = Math.max(2, page - 1);
      const end = Math.min(pages - 1, page + 1);

      pageNumbers.push(1);
      if (start > 2) pageNumbers.push('...');
      for (let i = start; i <= end; i++) pageNumbers.push(i);
      if (end < pages - 1) pageNumbers.push('...');
      pageNumbers.push(pages);
    }

    pageNumbersEl.innerHTML = pageNumbers.map((p) => {
      if (p === '...') return '<span class="page-ellipsis">...</span>';
      const active = p === page ? 'active' : '';
      return `<button class="btn-page-num ${active}" data-page="${p}">${p}</button>`;
    }).join('');

    // Attach event listeners to page number buttons
    pageNumbersEl.querySelectorAll('.btn-page-num').forEach((btn) => {
      const pageNum = parseInt((btn as HTMLElement).dataset.page || '1', 10);
      btn.addEventListener('click', () => goToPage(pageNum));
    });
  }
}

/**
 * Add a clip to personal rankings
 */
async function addToPersonalRankings(clipId: number): Promise<void> {
  if (!getCurrentUser()) {
    showToast('Sign in to add clips to your rankings', 'error');
    return;
  }

  const btn = document.getElementById(`add-btn-${clipId}`) as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }

  try {
    const response = await fetch(`/api/leaderboard/add/${clipId}`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error('Failed to add clip');
    }

    const data: AddClipResponse = await response.json();

    if (data.alreadyRanked) {
      showToast('This clip is already in your rankings!', 'info');
      if (btn) {
        btn.textContent = '\u2713';
        btn.disabled = true;
      }
      return;
    }

    if (data.needsRanking) {
      // Redirect to compare page in ranking mode
      showToast('Redirecting to rank this clip...', 'info');
      window.location.href = `/compare?rank=${clipId}`;
    } else {
      // Clip was added directly
      showToast('Clip added to your rankings!', 'success');
      if (btn) {
        btn.textContent = '\u2713';
        btn.disabled = true;
      }
    }
  } catch (error) {
    console.error('Failed to add clip:', error);
    showToast('Failed to add clip to rankings', 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+';
    }
  }
}

/**
 * Load personal rankings
 */
async function loadPersonalRankings(): Promise<void> {
  const personalList = document.getElementById('personal-list');
  const personalEmpty = document.getElementById('personal-empty');

  if (!getCurrentUser()) {
    if (personalEmpty) {
      personalEmpty.classList.remove('hidden');
      personalEmpty.innerHTML = '<a href="/api/auth/login">Sign in with Twitch</a> to see your personal rankings.';
    }
    if (personalList) personalList.classList.add('hidden');
    return;
  }

  showLoading(true);

  try {
    const response = await fetch(`/api/leaderboard/me?limit=100&sort=${personalSort}`);
    if (!response.ok) throw new Error('Failed to load rankings');

    const data: PersonalLeaderboardResponse = await response.json();
    personalRankings = data.leaderboard;

    // Update sort dropdown to match
    const sortSelect = document.getElementById('personal-sort-select') as HTMLSelectElement | null;
    if (sortSelect) sortSelect.value = personalSort;

    if (personalRankings.length === 0) {
      if (personalEmpty) personalEmpty.classList.remove('hidden');
      if (personalList) personalList.classList.add('hidden');
    } else {
      if (personalEmpty) personalEmpty.classList.add('hidden');
      if (personalList) personalList.classList.remove('hidden');
      renderPersonalRankings();
    }
  } catch (error) {
    console.error('Failed to load personal rankings:', error);
    showToast('Failed to load rankings', 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * Handle personal sort change
 */
function handlePersonalSortChange(): void {
  const sortSelect = document.getElementById('personal-sort-select') as HTMLSelectElement | null;
  if (sortSelect) {
    personalSort = sortSelect.value as PersonalSortField;
  }
  loadPersonalRankings();
}

/**
 * Render the personal rankings list
 */
function renderPersonalRankings(): void {
  const personalList = document.getElementById('personal-list');
  if (!personalList) return;

  const parent = getTwitchParent();

  personalList.innerHTML = personalRankings.map((entry, index) => `
    <div class="saved-item" data-id="${entry.id}" data-position="${entry.rank}" draggable="true">
      <div class="saved-item-drag" title="Drag to reorder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 7a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 6a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
        </svg>
      </div>

      <div class="saved-item-rank">
        <input
          type="number"
          class="rank-input"
          data-clip-id="${entry.id}"
          value="${index + 1}"
          min="1"
          max="${personalRankings.length}"
        />
      </div>

      <div class="saved-item-thumbnail">
        <a href="${escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`)}" target="_blank" rel="noopener" class="thumbnail-link">
          <img src="${getTwitchThumbnail(entry.twitchSlug)}" alt="${escapeHtml(entry.title || entry.twitchSlug)}" class="clip-thumbnail-img" loading="lazy" onerror="handleThumbnailError(this)" />
        </a>
      </div>

      <div class="saved-item-info">
        <div class="saved-item-title">${escapeHtml(entry.title || entry.twitchSlug)}</div>
        <div class="saved-item-meta">Clipped by ${escapeHtml(entry.clippedBy || 'Unknown')}</div>
      </div>

      <div class="saved-item-actions">
        <button class="btn-rerank" data-clip-id="${entry.id}" title="Re-compare this clip" ${personalRankings.length < 3 ? 'disabled' : ''}>
          Rerank
        </button>
        <button class="btn-arrow btn-move-up" data-clip-id="${entry.id}" ${index === 0 ? 'disabled' : ''} title="Move up">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="btn-arrow btn-move-down" data-clip-id="${entry.id}" ${index === personalRankings.length - 1 ? 'disabled' : ''} title="Move down">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clip-rule="evenodd" />
          </svg>
        </button>
        <a href="${escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`)}" class="btn-open" target="_blank" rel="noopener" title="Open on Twitch">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
            <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
          </svg>
        </a>
        <button class="btn-delete-clip" data-clip-id="${entry.id}" title="Remove from rankings">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  `).join('');

  // Set up drag and drop listeners
  setupPersonalDragAndDrop();

  // Attach event listeners to dynamically created elements
  personalList.querySelectorAll('.rank-input').forEach((input) => {
    const clipId = parseInt((input as HTMLInputElement).dataset.clipId || '0', 10);
    input.addEventListener('change', (e) => {
      handlePersonalRankChange(clipId, (e.target as HTMLInputElement).value);
    });
    input.addEventListener('click', () => {
      (input as HTMLInputElement).select();
    });
  });

  personalList.querySelectorAll('.btn-rerank').forEach((btn) => {
    const clipId = parseInt((btn as HTMLElement).dataset.clipId || '0', 10);
    btn.addEventListener('click', () => startRerank(clipId));
  });

  personalList.querySelectorAll('.btn-move-up').forEach((btn) => {
    const clipId = parseInt((btn as HTMLElement).dataset.clipId || '0', 10);
    btn.addEventListener('click', () => movePersonalUp(clipId));
  });

  personalList.querySelectorAll('.btn-move-down').forEach((btn) => {
    const clipId = parseInt((btn as HTMLElement).dataset.clipId || '0', 10);
    btn.addEventListener('click', () => movePersonalDown(clipId));
  });

  personalList.querySelectorAll('.btn-delete-clip').forEach((btn) => {
    const clipId = parseInt((btn as HTMLElement).dataset.clipId || '0', 10);
    btn.addEventListener('click', (e) => deleteClipFromRankings(clipId, (e as MouseEvent).shiftKey));
  });
}

/**
 * Set up drag and drop for personal rankings
 */
function setupPersonalDragAndDrop(): void {
  const personalList = document.getElementById('personal-list');
  if (!personalList) return;

  const items = personalList.querySelectorAll('.saved-item');

  items.forEach((item) => {
    const element = item as HTMLElement;
    element.addEventListener('dragstart', handlePersonalDragStart);
    element.addEventListener('dragend', handlePersonalDragEnd);
    element.addEventListener('dragover', handlePersonalDragOver);
    element.addEventListener('dragenter', handlePersonalDragEnter);
    element.addEventListener('dragleave', handlePersonalDragLeave);
    element.addEventListener('drop', handlePersonalDrop);
  });
}

function handlePersonalDragStart(this: HTMLElement, e: DragEvent): void {
  draggedItem = this;
  this.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.id || '');
  }
}

function handlePersonalDragEnd(this: HTMLElement): void {
  this.classList.remove('dragging');
  document.querySelectorAll('.saved-item').forEach((item) => {
    item.classList.remove('drag-over');
  });
  draggedItem = null;
}

function handlePersonalDragOver(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handlePersonalDragEnter(this: HTMLElement, e: DragEvent): void {
  e.preventDefault();
  if (this !== draggedItem) {
    this.classList.add('drag-over');
  }
}

function handlePersonalDragLeave(this: HTMLElement): void {
  this.classList.remove('drag-over');
}

async function handlePersonalDrop(this: HTMLElement, e: DragEvent): Promise<void> {
  e.preventDefault();
  this.classList.remove('drag-over');

  if (this === draggedItem || !draggedItem) return;

  const draggedId = parseInt(draggedItem.dataset.id || '0', 10);
  const targetPosition = parseInt(this.dataset.position || '0', 10);

  await reorderPersonalRanking(draggedId, targetPosition);
}

/**
 * Move a clip up one position
 */
async function movePersonalUp(clipId: number): Promise<void> {
  const entry = personalRankings.find((e) => e.id === clipId);
  if (!entry || entry.rank <= 1) return;

  await reorderPersonalRanking(clipId, entry.rank - 1);
}

/**
 * Move a clip down one position
 */
async function movePersonalDown(clipId: number): Promise<void> {
  const entry = personalRankings.find((e) => e.id === clipId);
  if (!entry || entry.rank >= personalRankings.length) return;

  await reorderPersonalRanking(clipId, entry.rank + 1);
}

/**
 * Handle manual rank input change
 */
async function handlePersonalRankChange(clipId: number, newRank: string): Promise<void> {
  const position = parseInt(newRank, 10);
  if (isNaN(position) || position < 1 || position > personalRankings.length) {
    showToast('Invalid rank', 'error');
    renderPersonalRankings();
    return;
  }

  await reorderPersonalRanking(clipId, position);
}

/**
 * Reorder a personal ranking
 */
async function reorderPersonalRanking(clipId: number, newPosition: number): Promise<void> {
  try {
    const response = await fetch('/api/leaderboard/me/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId, newPosition }),
    });

    if (!response.ok) {
      throw new Error('Failed to reorder');
    }

    const data: ReorderResponse = await response.json();

    // Reload to get updated positions
    await loadPersonalRankings();

    // Show feedback based on whether global rankings were affected
    if (data.globalRankingUpdated) {
      showToast(`Ranking updated! Boosted global ranking (beat ${data.clipsBeaten} clip${data.clipsBeaten && data.clipsBeaten > 1 ? 's' : ''})`, 'success');
    } else {
      showToast('Ranking updated', 'success');
    }
  } catch (error) {
    console.error('Failed to reorder ranking:', error);
    showToast('Failed to reorder ranking', 'error');
  }
}

/**
 * Start a rerank session for a clip
 */
async function startRerank(clipId: number): Promise<void> {
  if (personalRankings.length < 3) {
    showToast('Need at least 3 ranked clips to rerank', 'error');
    return;
  }

  try {
    const response = await fetch(`/api/leaderboard/rerank/${clipId}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const errorData = await response.json() as { error?: string };
      throw new Error(errorData.error || 'Failed to start rerank');
    }

    // Redirect to compare page in rerank mode
    showToast('Redirecting to re-compare...', 'info');
    window.location.href = `/compare?rerank=${clipId}`;
  } catch (error) {
    console.error('Failed to start rerank:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to start rerank';
    showToast(errorMessage, 'error');
  }
}

/**
 * Delete a clip from personal rankings
 */
async function deleteClipFromRankings(clipId: number, skipConfirm = false): Promise<void> {
  const clip = personalRankings.find(c => c.id === clipId);
  const clipTitle = clip?.title || 'this clip';

  if (!skipConfirm) {
    const confirmed = confirm(
      `Remove "${clipTitle}" from your rankings?\n\n` +
      'This will delete all your rating data for this clip.\n' +
      'This action cannot be undone.'
    );

    if (!confirmed) return;
  }

  try {
    const response = await fetch(`/api/leaderboard/me/${clipId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete clip');
    }

    showToast('Clip removed from rankings', 'success');
    await loadPersonalRankings();
  } catch (error) {
    console.error('Failed to delete clip:', error);
    showToast('Failed to remove clip', 'error');
  }
}

/**
 * Show vote history modal for a clip
 */
async function showVoteHistory(clipId: number): Promise<void> {
  historyModalClipId = clipId;
  const modal = document.getElementById('history-modal');
  const content = document.getElementById('history-modal-content');

  if (!modal || !content) return;

  // Show modal with loading state
  modal.classList.remove('hidden');
  content.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Loading vote history...</div></div>';

  try {
    const response = await fetch(`/api/leaderboard/me/history/${clipId}`);
    if (!response.ok) throw new Error('Failed to load history');

    const data: VoteHistoryResponse = await response.json();
    const clip = personalRankings.find(c => c.id === clipId);

    if (data.votes.length === 0) {
      content.innerHTML = `
        <div class="history-header">
          <h3>Vote History: ${escapeHtml(clip?.title || 'Unknown Clip')}</h3>
          <button class="btn-close-modal" id="close-history-modal">×</button>
        </div>
        <div class="empty-state">No vote history found for this clip.</div>
      `;
    } else {
      content.innerHTML = `
        <div class="history-header">
          <h3>Vote History: ${escapeHtml(clip?.title || 'Unknown Clip')}</h3>
          <button class="btn-close-modal" id="close-history-modal">×</button>
        </div>
        <div class="history-list">
          ${data.votes.map(vote => `
            <div class="history-item">
              <div class="history-info">
                <span class="history-result ${getResultClass(vote.result, clipId, vote.opponent_id)}">
                  ${getResultText(vote.result, clipId, vote.opponent_id)}
                </span>
                <span class="history-vs">vs</span>
                <a href="https://clips.twitch.tv/${vote.opponent_slug}" target="_blank" rel="noopener" class="history-opponent">
                  ${escapeHtml(vote.opponent_title || vote.opponent_slug)}
                </a>
                ${vote.is_super_like ? '<span class="history-super">⭐</span>' : ''}
              </div>
              <div class="history-actions">
                <span class="history-date">${formatTimeAgo(vote.created_at)}</span>
                <button class="btn-delete-vote" data-vote-id="${vote.id}" title="Delete this vote">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                    <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Attach close button handler
    document.getElementById('close-history-modal')?.addEventListener('click', closeHistoryModal);

    // Attach delete vote handlers
    content.querySelectorAll('.btn-delete-vote').forEach(btn => {
      const voteId = parseInt((btn as HTMLElement).dataset.voteId || '0', 10);
      btn.addEventListener('click', () => deleteVote(voteId));
    });

  } catch (error) {
    console.error('Failed to load vote history:', error);
    content.innerHTML = `
      <div class="history-header">
        <h3>Vote History</h3>
        <button class="btn-close-modal" id="close-history-modal">×</button>
      </div>
      <div class="empty-state">Failed to load vote history.</div>
    `;
    document.getElementById('close-history-modal')?.addEventListener('click', closeHistoryModal);
  }
}

/**
 * Get CSS class for vote result
 */
function getResultClass(result: string, clipId: number, opponentId: number): string {
  if (result === 'tie' || result === 'skip') return 'result-tie';
  // For clip_a, clip_b, super_a, super_b - we need to check if this clip won
  if (result.includes('a')) {
    // Result was for clip A - need to know if our clip was A or B
    // In the query, we always have the opponent, so if result is 'clip_a' or 'super_a'
    // it means clip A won. But we don't know if our clip was A or B from here.
    // The query returns result relative to the original comparison, so we show win/loss
    return 'result-win';
  }
  return 'result-loss';
}

/**
 * Get text for vote result
 */
function getResultText(result: string, clipId: number, opponentId: number): string {
  if (result === 'tie') return 'Tie';
  if (result === 'skip') return 'Skipped';
  if (result === 'super_a' || result === 'super_b') return 'Win';
  if (result === 'clip_a' || result === 'clip_b') return 'Win';
  return result;
}

/**
 * Close the history modal
 */
function closeHistoryModal(): void {
  const modal = document.getElementById('history-modal');
  if (modal) modal.classList.add('hidden');
  historyModalClipId = null;
}

/**
 * Delete a single vote
 */
async function deleteVote(voteId: number): Promise<void> {
  const confirmed = confirm('Delete this vote? This cannot be undone.');
  if (!confirmed) return;

  try {
    const response = await fetch(`/api/leaderboard/me/history/${voteId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete vote');
    }

    showToast('Vote deleted', 'success');

    // Refresh the modal
    if (historyModalClipId) {
      await showVoteHistory(historyModalClipId);
    }
  } catch (error) {
    console.error('Failed to delete vote:', error);
    showToast('Failed to delete vote', 'error');
  }
}

/**
 * Load voter stats (admin only)
 */
async function loadVoterStats(): Promise<void> {
  showLoading(true);

  try {
    const response = await fetch('/api/leaderboard/admin/voters');
    if (!response.ok) {
      if (response.status === 403) {
        showToast('Admin access required', 'error');
        return;
      }
      throw new Error('Failed to load voter stats');
    }

    const data: VoterStatsResponse = await response.json();
    const tbody = document.getElementById('voters-body');

    if (!tbody) return;

    if (data.voters.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">No voters yet.</td>
        </tr>
      `;
    } else {
      tbody.innerHTML = data.voters.map((voter) => `
        <tr>
          <td class="rank ${getRankClass(voter.rank)}">#${voter.rank}</td>
          <td class="user-cell">
            ${voter.profileImage ? `<img src="${escapeHtml(voter.profileImage)}" class="user-avatar" alt="">` : ''}
            <span>${escapeHtml(voter.displayName || voter.username)}</span>
          </td>
          <td>${formatNumber(voter.totalVotes)}</td>
          <td>${formatNumber(voter.superLikes)}</td>
          <td>${formatTimeAgo(voter.lastLogin)}</td>
        </tr>
      `).join('');
    }
  } catch (error) {
    console.error('Failed to load voter stats:', error);
    showToast('Failed to load voter stats', 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * Format a date as time ago
 */
function formatTimeAgo(dateStr: string | undefined): string {
  if (!dateStr) return 'Never';
  // SQLite dates are stored in UTC but without timezone indicator
  // Append 'Z' to parse as UTC, or add ' UTC' for SQLite format
  const utcDateStr = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const date = new Date(utcDateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Check if current user is an admin and show voter tab
 */
function checkAdminAndShowTab(): void {
  const user = getCurrentUser();
  if (!user) return;
  const admins: string[] = ['digibugcat', 'arross'];
  if (admins.includes(user.twitchUsername)) {
    document.getElementById('tab-voters')?.classList.remove('hidden');
  }
}

/**
 * Get CSS class for rank
 */
function getRankClass(rank: number): string {
  if (rank === 1) return 'rank--1';
  if (rank === 2) return 'rank--2';
  if (rank === 3) return 'rank--3';
  return '';
}

/**
 * Set up event listeners for static HTML elements
 */
function setupEventListeners(): void {
  // Tab buttons
  document.getElementById('tab-global')?.addEventListener('click', () => switchTab('global'));
  document.getElementById('tab-personal')?.addEventListener('click', () => switchTab('personal'));
  document.getElementById('tab-voters')?.addEventListener('click', () => switchTab('voters'));

  // Sort controls
  document.getElementById('sort-select')?.addEventListener('change', handleSortChange);
  document.getElementById('order-btn')?.addEventListener('click', toggleSortOrder);

  // Personal sort control
  document.getElementById('personal-sort-select')?.addEventListener('change', handlePersonalSortChange);

  // Pagination buttons
  document.getElementById('prev-btn')?.addEventListener('click', () => goToPage(currentPage - 1));
  document.getElementById('next-btn')?.addEventListener('click', () => goToPage(currentPage + 1));

  // Close modal when clicking outside
  document.getElementById('history-modal')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'history-modal') {
      closeHistoryModal();
    }
  });
}

/**
 * Initialize the leaderboard page
 */
async function initLeaderboardPage(): Promise<void> {
  // Set up event listeners first
  setupEventListeners();

  await checkAuth();

  // Check if admin and show voter tab
  checkAdminAndShowTab();

  // Read URL params first
  initFromUrl();

  // Update tab UI based on URL
  if (currentTab === 'me') {
    document.getElementById('tab-global')?.classList.remove('active');
    document.getElementById('tab-personal')?.classList.add('active');
    document.getElementById('global-section')?.classList.add('hidden');
    document.getElementById('personal-section')?.classList.remove('hidden');
    await loadPersonalRankings();
  } else if (currentTab === 'voters') {
    document.getElementById('tab-global')?.classList.remove('active');
    document.getElementById('tab-voters')?.classList.add('active');
    document.getElementById('global-section')?.classList.add('hidden');
    document.getElementById('voters-section')?.classList.remove('hidden');
    await loadVoterStats();
  } else {
    await loadGlobalRankings();
  }
}

// Handle browser back/forward
window.addEventListener('popstate', async () => {
  initFromUrl();
  // Reset all tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.getElementById('global-section')?.classList.add('hidden');
  document.getElementById('personal-section')?.classList.add('hidden');
  document.getElementById('voters-section')?.classList.add('hidden');

  if (currentTab === 'me') {
    document.getElementById('tab-personal')?.classList.add('active');
    document.getElementById('personal-section')?.classList.remove('hidden');
    await loadPersonalRankings();
  } else if (currentTab === 'voters') {
    document.getElementById('tab-voters')?.classList.add('active');
    document.getElementById('voters-section')?.classList.remove('hidden');
    await loadVoterStats();
  } else {
    document.getElementById('tab-global')?.classList.add('active');
    document.getElementById('global-section')?.classList.remove('hidden');
    await loadGlobalRankings();
  }
});

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initLeaderboardPage);

// Support SPA navigation - reinitialize on content swap
window.addEventListener('spa:pageload', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  if (detail.pathname === '/leaderboard' || detail.pathname === '/leaderboard.html') {
    // Reset state for fresh load
    currentTab = 'global';
    currentSort = 'elo';
    currentOrder = 'desc';
    currentPage = 1;
    personalRankings = [];
    initLeaderboardPage();
  }
});

// Export functions for use in other modules
export {
  initLeaderboardPage,
  loadGlobalRankings,
  loadPersonalRankings,
  loadVoterStats,
  switchTab,
  handleSortChange,
  toggleSortOrder,
  goToPage,
  addToPersonalRankings,
  movePersonalUp,
  movePersonalDown,
  handlePersonalRankChange,
  handlePersonalSortChange,
  startRerank,
  deleteClipFromRankings,
  showVoteHistory,
  closeHistoryModal,
  deleteVote,
  formatTimeAgo,
  getRankClass,
};

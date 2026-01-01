/**
 * Clip Ranker - Leaderboard Page Logic
 * =====================================
 */

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

// Reference to current user (set by checkAuth in app.ts)
declare const currentUser: User | null;

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
 * Load global rankings
 */
async function loadGlobalRankings(): Promise<void> {
  showLoading(true);

  try {
    const params = new URLSearchParams({
      page: String(currentPage),
      limit: '50',
      sort: currentSort,
      order: currentOrder,
    });

    const response = await fetch(`/api/leaderboard?${params.toString()}`);
    if (!response.ok) throw new Error('Failed to load rankings');

    const data: LeaderboardResponse = await response.json();
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
            ${currentUser ? `
              <button class="btn-add" id="add-btn-${entry.id}" onclick="addToPersonalRankings(${entry.id})" title="Add to Personal Ranking">
                Rank
              </button>
            ` : ''}
          </td>
        </tr>
      `).join('');
    }
  } catch (error) {
    console.error('Failed to load global rankings:', error);
    showToast('Failed to load rankings', 'error');
  } finally {
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
      return `<button class="btn-page-num ${active}" onclick="goToPage(${p})">${p}</button>`;
    }).join('');
  }
}

/**
 * Add a clip to personal rankings
 */
async function addToPersonalRankings(clipId: number): Promise<void> {
  if (!currentUser) {
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

  if (!currentUser) {
    if (personalEmpty) {
      personalEmpty.classList.remove('hidden');
      personalEmpty.innerHTML = '<a href="/api/auth/login">Sign in with Twitch</a> to see your personal rankings.';
    }
    if (personalList) personalList.classList.add('hidden');
    return;
  }

  showLoading(true);

  try {
    const response = await fetch('/api/leaderboard/me?limit=100');
    if (!response.ok) throw new Error('Failed to load rankings');

    const data: PersonalLeaderboardResponse = await response.json();
    personalRankings = data.leaderboard;

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
          value="${index + 1}"
          min="1"
          max="${personalRankings.length}"
          onchange="handlePersonalRankChange(${entry.id}, this.value)"
          onclick="this.select()"
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
        <button class="btn-rerank" onclick="startRerank(${entry.id})" title="Re-compare this clip" ${personalRankings.length < 3 ? 'disabled' : ''}>
          Rerank
        </button>
        <button class="btn-arrow" onclick="movePersonalUp(${entry.id})" ${index === 0 ? 'disabled' : ''} title="Move up">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="btn-arrow" onclick="movePersonalDown(${entry.id})" ${index === personalRankings.length - 1 ? 'disabled' : ''} title="Move down">
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
      </div>
    </div>
  `).join('');

  // Set up drag and drop listeners
  setupPersonalDragAndDrop();
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
  const date = new Date(dateStr);
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
  if (!currentUser) return;
  const admins: string[] = ['digibugcat', 'arross'];
  if (admins.includes(currentUser.twitchUsername)) {
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
 * Initialize the leaderboard page
 */
async function initLeaderboardPage(): Promise<void> {
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
  startRerank,
  formatTimeAgo,
  getRankClass,
};

// Make functions available globally for inline onclick handlers
declare global {
  interface Window {
    // Note: switchTab is typed loosely to allow different page implementations
    switchTab: (tab: string) => void | Promise<void>;
    handleSortChange: typeof handleSortChange;
    toggleSortOrder: typeof toggleSortOrder;
    goToPage: typeof goToPage;
    addToPersonalRankings: typeof addToPersonalRankings;
    movePersonalUp: typeof movePersonalUp;
    movePersonalDown: typeof movePersonalDown;
    handlePersonalRankChange: typeof handlePersonalRankChange;
    startRerank: typeof startRerank;
  }
}

// Assign to window for global access (needed for inline onclick handlers)
window.switchTab = switchTab as (tab: string) => void | Promise<void>;
window.handleSortChange = handleSortChange;
window.toggleSortOrder = toggleSortOrder;
window.goToPage = goToPage;
window.addToPersonalRankings = addToPersonalRankings;
window.movePersonalUp = movePersonalUp;
window.movePersonalDown = movePersonalDown;
window.handlePersonalRankChange = handlePersonalRankChange;
window.startRerank = startRerank;

/**
 * Clip Ranker - Leaderboard Page Logic
 * =====================================
 */

// Page state
let currentTab = 'global';
let personalRankings = [];
let draggedItem = null;

/**
 * Switch between tabs
 */
async function switchTab(tab) {
  currentTab = tab;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeTab = document.getElementById(`tab-${tab}`);
  if (activeTab) activeTab.classList.add('active');

  // Show/hide sections
  const globalSection = document.getElementById('global-section');
  const personalSection = document.getElementById('personal-section');

  if (globalSection) {
    globalSection.classList.toggle('hidden', tab !== 'global');
  }
  if (personalSection) {
    personalSection.classList.toggle('hidden', tab !== 'personal');
  }

  // Load data
  if (tab === 'global') {
    await loadGlobalRankings();
  } else {
    await loadPersonalRankings();
  }
}

/**
 * Show/hide loading state
 */
function showLoading(show) {
  const loadingState = document.getElementById('loading-state');
  if (loadingState) {
    loadingState.classList.toggle('hidden', !show);
  }
}

/**
 * Load global rankings
 */
async function loadGlobalRankings() {
  showLoading(true);

  try {
    const response = await fetch('/api/leaderboard?limit=100');
    if (!response.ok) throw new Error('Failed to load rankings');

    const data = await response.json();
    const tbody = document.getElementById('global-body');

    if (!tbody) return;

    if (data.leaderboard.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">
            No rankings yet. Be the first to <a href="/compare">start comparing</a>!
          </td>
        </tr>
      `;
    } else {
      const parent = getTwitchParent();
      tbody.innerHTML = data.leaderboard.map(entry => `
        <tr>
          <td class="rank ${getRankClass(entry.rank)}">#${entry.rank}</td>
          <td class="clip-thumbnail">
            <iframe
              src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(entry.twitchSlug)}&parent=${encodeURIComponent(parent)}&autoplay=false"
              allowfullscreen
              loading="lazy"
            ></iframe>
          </td>
          <td class="clip-name">
            <a href="${escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`)}" target="_blank" rel="noopener">
              ${escapeHtml(entry.title || entry.twitchSlug)}
            </a>
          </td>
          <td>${formatNumber(entry.matches)}</td>
          <td>${formatNumber(entry.superLikes)}</td>
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
 * Load personal rankings
 */
async function loadPersonalRankings() {
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

    const data = await response.json();
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
function renderPersonalRankings() {
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
        <iframe
          src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(entry.twitchSlug)}&parent=${encodeURIComponent(parent)}&autoplay=false&muted=true"
          allowfullscreen
          loading="lazy"
        ></iframe>
      </div>

      <div class="saved-item-info">
        <div class="saved-item-title">${escapeHtml(entry.title || entry.twitchSlug)}</div>
        <div class="saved-item-meta">Clipped by ${escapeHtml(entry.clippedBy || 'Unknown')}</div>
      </div>

      <div class="saved-item-actions">
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
function setupPersonalDragAndDrop() {
  const personalList = document.getElementById('personal-list');
  const items = personalList.querySelectorAll('.saved-item');

  items.forEach(item => {
    item.addEventListener('dragstart', handlePersonalDragStart);
    item.addEventListener('dragend', handlePersonalDragEnd);
    item.addEventListener('dragover', handlePersonalDragOver);
    item.addEventListener('dragenter', handlePersonalDragEnter);
    item.addEventListener('dragleave', handlePersonalDragLeave);
    item.addEventListener('drop', handlePersonalDrop);
  });
}

function handlePersonalDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.id);
}

function handlePersonalDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.saved-item').forEach(item => {
    item.classList.remove('drag-over');
  });
  draggedItem = null;
}

function handlePersonalDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handlePersonalDragEnter(e) {
  e.preventDefault();
  if (this !== draggedItem) {
    this.classList.add('drag-over');
  }
}

function handlePersonalDragLeave(e) {
  this.classList.remove('drag-over');
}

async function handlePersonalDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');

  if (this === draggedItem) return;

  const draggedId = parseInt(draggedItem.dataset.id, 10);
  const targetPosition = parseInt(this.dataset.position, 10);

  await reorderPersonalRanking(draggedId, targetPosition);
}

/**
 * Move a clip up one position
 */
async function movePersonalUp(clipId) {
  const entry = personalRankings.find(e => e.id === clipId);
  if (!entry || entry.rank <= 1) return;

  await reorderPersonalRanking(clipId, entry.rank - 1);
}

/**
 * Move a clip down one position
 */
async function movePersonalDown(clipId) {
  const entry = personalRankings.find(e => e.id === clipId);
  if (!entry || entry.rank >= personalRankings.length) return;

  await reorderPersonalRanking(clipId, entry.rank + 1);
}

/**
 * Handle manual rank input change
 */
async function handlePersonalRankChange(clipId, newRank) {
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
async function reorderPersonalRanking(clipId, newPosition) {
  try {
    const response = await fetch('/api/leaderboard/me/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId, newPosition }),
    });

    if (!response.ok) {
      throw new Error('Failed to reorder');
    }

    const data = await response.json();

    // Reload to get updated positions
    await loadPersonalRankings();

    // Show feedback based on whether global rankings were affected
    if (data.globalRankingUpdated) {
      showToast(`Ranking updated! Boosted global ranking (beat ${data.clipsBeaten} clip${data.clipsBeaten > 1 ? 's' : ''})`, 'success');
    } else {
      showToast('Ranking updated', 'success');
    }
  } catch (error) {
    console.error('Failed to reorder ranking:', error);
    showToast('Failed to reorder ranking', 'error');
  }
}

/**
 * Get CSS class for rank
 */
function getRankClass(rank) {
  if (rank === 1) return 'rank--1';
  if (rank === 2) return 'rank--2';
  if (rank === 3) return 'rank--3';
  return '';
}

/**
 * Initialize the leaderboard page
 */
async function initLeaderboardPage() {
  await checkAuth();
  await loadGlobalRankings();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initLeaderboardPage);

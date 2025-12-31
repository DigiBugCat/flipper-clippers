// Leaderboard state
let currentTab = 'global';

// Initialize leaderboard page
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadGlobalLeaderboard();
});

// Switch between tabs
async function switchTab(tab) {
  currentTab = tab;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.remove('active');
  });
  document.getElementById(`tab-${tab}`).classList.add('active');

  // Show/hide sections
  document.getElementById('global-section').style.display = tab === 'global' ? 'block' : 'none';
  document.getElementById('personal-section').style.display = tab === 'personal' ? 'block' : 'none';
  document.getElementById('super-section').style.display = tab === 'super' ? 'block' : 'none';

  // Load data
  if (tab === 'global') {
    await loadGlobalLeaderboard();
  } else if (tab === 'personal') {
    await loadPersonalLeaderboard();
  } else if (tab === 'super') {
    await loadSuperLikes();
  }
}

// Load global leaderboard
async function loadGlobalLeaderboard() {
  showLoading(true);

  try {
    const response = await fetch('/api/leaderboard?limit=100');
    const data = await response.json();

    const tbody = document.getElementById('global-leaderboard-body');
    tbody.innerHTML = data.leaderboard
      .map(
        (entry) => `
      <tr>
        <td class="rank-cell rank-${entry.rank <= 3 ? entry.rank : ''}">#${entry.rank}</td>
        <td class="clip-title-cell">
          <a href="https://clips.twitch.tv/${entry.twitchSlug}" target="_blank" style="color: inherit; text-decoration: none;">
            ${entry.title || entry.twitchSlug}
          </a>
        </td>
        <td class="elo-cell">${entry.elo}</td>
        <td>${entry.matches}</td>
        <td>${entry.winRate}%</td>
        <td>${entry.superLikes} ⭐</td>
        <td>
          <div class="confidence-bar">
            <div class="confidence-fill" style="width: ${entry.confidence}%"></div>
          </div>
          ${entry.confidence}%
        </td>
      </tr>
    `
      )
      .join('');

    showLoading(false);
  } catch (error) {
    console.error('Failed to load leaderboard:', error);
    showToast('Failed to load leaderboard', 'error');
    showLoading(false);
  }
}

// Load personal leaderboard
async function loadPersonalLeaderboard() {
  if (!currentUser) {
    document.getElementById('personal-auth-required').style.display = 'block';
    document.getElementById('personal-table').style.display = 'none';
    return;
  }

  document.getElementById('personal-auth-required').style.display = 'none';
  document.getElementById('personal-table').style.display = 'table';

  showLoading(true);

  try {
    const response = await fetch('/api/leaderboard/me?limit=100');

    if (!response.ok) {
      if (response.status === 401) {
        document.getElementById('personal-auth-required').style.display = 'block';
        document.getElementById('personal-table').style.display = 'none';
        showLoading(false);
        return;
      }
      throw new Error('Failed to load personal leaderboard');
    }

    const data = await response.json();

    const tbody = document.getElementById('personal-leaderboard-body');

    if (data.leaderboard.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 2rem; color: var(--text-secondary);">
            You haven't ranked any clips yet. <a href="/compare">Start comparing!</a>
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = data.leaderboard
        .map(
          (entry) => `
        <tr>
          <td class="rank-cell rank-${entry.rank <= 3 ? entry.rank : ''}">#${entry.rank}</td>
          <td class="clip-title-cell">
            <a href="https://clips.twitch.tv/${entry.twitchSlug}" target="_blank" style="color: inherit; text-decoration: none;">
              ${entry.title || entry.twitchSlug}
            </a>
          </td>
          <td class="elo-cell">${entry.elo}</td>
          <td>${entry.globalElo}</td>
        </tr>
      `
        )
        .join('');
    }

    showLoading(false);
  } catch (error) {
    console.error('Failed to load personal leaderboard:', error);
    showToast('Failed to load your rankings', 'error');
    showLoading(false);
  }
}

// Load super liked clips
async function loadSuperLikes() {
  if (!currentUser) {
    document.getElementById('super-auth-required').style.display = 'block';
    document.getElementById('super-likes-grid').style.display = 'none';
    document.getElementById('no-super-likes').style.display = 'none';
    return;
  }

  document.getElementById('super-auth-required').style.display = 'none';

  showLoading(true);

  try {
    const response = await fetch('/api/compare/super-likes');

    if (!response.ok) {
      if (response.status === 401) {
        document.getElementById('super-auth-required').style.display = 'block';
        document.getElementById('super-likes-grid').style.display = 'none';
        showLoading(false);
        return;
      }
      throw new Error('Failed to load super likes');
    }

    const data = await response.json();
    const grid = document.getElementById('super-likes-grid');
    const noSuperLikes = document.getElementById('no-super-likes');

    if (data.clips.length === 0) {
      grid.style.display = 'none';
      noSuperLikes.style.display = 'block';
    } else {
      grid.style.display = 'grid';
      noSuperLikes.style.display = 'none';

      grid.innerHTML = data.clips
        .map(
          (clip) => `
        <div class="super-like-card">
          <div class="video-wrapper">
            <iframe src="${getTwitchEmbedUrl(clip.twitchSlug)}" allowfullscreen></iframe>
          </div>
          <div class="video-info">
            <div class="video-title">${clip.title || clip.twitchSlug}</div>
          </div>
        </div>
      `
        )
        .join('');
    }

    showLoading(false);
  } catch (error) {
    console.error('Failed to load super likes:', error);
    showToast('Failed to load super likes', 'error');
    showLoading(false);
  }
}

// Show/hide loading state
function showLoading(show) {
  const loading = document.getElementById('loading-state');
  if (loading) {
    loading.style.display = show ? 'flex' : 'none';
  }
}

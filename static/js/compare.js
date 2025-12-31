// Comparison state
let clipA = null;
let clipB = null;
let startTime = null;
let isLoading = false;

// Initialize comparison page
document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkAuth();

  if (!user) {
    document.getElementById('auth-required').style.display = 'block';
    document.getElementById('compare-ui').style.display = 'none';
    return;
  }

  document.getElementById('auth-required').style.display = 'none';
  document.getElementById('compare-ui').style.display = 'block';

  await loadUserStats();
  await loadNextPair();

  // Setup keyboard shortcuts
  setupKeyboardShortcuts();
});

// Load user comparison stats
async function loadUserStats() {
  try {
    const response = await fetch('/api/compare/stats');
    const data = await response.json();

    document.getElementById('user-comparisons').textContent = formatNumber(data.totalComparisons || 0);
    document.getElementById('user-super-likes').textContent = formatNumber(data.totalSuperLikes || 0);
    document.getElementById('coverage-percent').textContent = `${Math.round(data.coveragePercent || 0)}%`;
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Load next pair of clips
async function loadNextPair() {
  if (isLoading) return;

  isLoading = true;
  showLoading(true);

  try {
    const response = await fetch('/api/compare/next');

    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/api/auth/login';
        return;
      }
      throw new Error('Failed to load clips');
    }

    const data = await response.json();

    clipA = data.clipA;
    clipB = data.clipB;
    startTime = Date.now();

    // Update UI
    document.getElementById('title-a').textContent = clipA.title || clipA.twitchSlug;
    document.getElementById('title-b').textContent = clipB.title || clipB.twitchSlug;

    // Load Twitch embeds
    createTwitchEmbed(clipA.twitchSlug, 'video-wrapper-a');
    createTwitchEmbed(clipB.twitchSlug, 'video-wrapper-b');

    showLoading(false);
  } catch (error) {
    console.error('Failed to load pair:', error);
    showToast('Failed to load clips. Please try again.', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

// Submit vote
async function vote(result) {
  if (isLoading || !clipA || !clipB) return;

  isLoading = true;
  const timeSpent = Date.now() - startTime;

  try {
    const response = await fetch('/api/compare/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clip_a_id: clipA.id,
        clip_b_id: clipB.id,
        result: result,
        time_spent_ms: timeSpent,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/api/auth/login';
        return;
      }
      throw new Error('Failed to submit vote');
    }

    // Show feedback
    if (result.startsWith('super')) {
      showToast('⭐ Super Like recorded!', 'success');
    } else if (result === 'skip') {
      showToast('Skipped', 'info');
    }

    // Update stats
    await loadUserStats();

    // Load next pair
    await loadNextPair();
  } catch (error) {
    console.error('Failed to vote:', error);
    showToast('Failed to record vote. Please try again.', 'error');
  } finally {
    isLoading = false;
  }
}

// Show/hide loading state
function showLoading(show) {
  const loading = document.getElementById('loading-state');
  const container = document.getElementById('comparison-container');
  const buttons = document.getElementById('action-buttons');

  if (show) {
    loading.style.display = 'flex';
    container.style.opacity = '0.5';
    buttons.style.pointerEvents = 'none';
  } else {
    loading.style.display = 'none';
    container.style.opacity = '1';
    buttons.style.pointerEvents = 'auto';
  }
}

// Keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case '1':
        if (e.shiftKey) {
          vote('super_a');
        } else {
          vote('clip_a');
        }
        break;
      case '2':
        if (e.shiftKey) {
          vote('super_b');
        } else {
          vote('clip_b');
        }
        break;
      case 't':
      case 'T':
        vote('tie');
        break;
      case 's':
      case 'S':
        vote('skip');
        break;
    }
  });
}

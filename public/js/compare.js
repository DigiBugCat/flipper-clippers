/**
 * Clip Ranker - Compare Page Logic
 * =================================
 */

// Page state
let clipA = null;
let clipB = null;
let startTime = null;
let isLoading = false;
let savedStates = { a: false, b: false };

// Ranking mode state
let isRankingMode = false;
let rankingClipId = null;
let rankingClip = null;

/**
 * Update the browser URL with current clip IDs
 */
function updateUrl(a, b, replace = false) {
  const url = `/compare?a=${a.id}&b=${b.id}`;
  const state = { clipA: a, clipB: b };

  if (replace) {
    history.replaceState(state, '', url);
  } else {
    history.pushState(state, '', url);
  }
}

/**
 * Display clips from state (used for back/forward navigation)
 */
function displayClips(a, b) {
  clipA = a;
  clipB = b;
  startTime = Date.now();

  // Update titles
  const titleA = document.getElementById('title-a');
  const titleB = document.getElementById('title-b');
  if (titleA) titleA.textContent = a.title || a.twitchSlug;
  if (titleB) titleB.textContent = b.title || b.twitchSlug;

  // Update clipped by
  const clippedByA = document.getElementById('clipped-by-a');
  const clippedByB = document.getElementById('clipped-by-b');
  if (clippedByA) clippedByA.textContent = `Clipped by ${a.clippedBy || 'Unknown'}`;
  if (clippedByB) clippedByB.textContent = `Clipped by ${b.clippedBy || 'Unknown'}`;

  // Update clipped at
  const clippedAtA = document.getElementById('clipped-at-a');
  const clippedAtB = document.getElementById('clipped-at-b');
  if (clippedAtA) clippedAtA.textContent = a.clippedAt ? formatDate(a.clippedAt) : '';
  if (clippedAtB) clippedAtB.textContent = b.clippedAt ? formatDate(b.clippedAt) : '';

  // Update links
  const linkA = document.getElementById('link-a');
  const linkB = document.getElementById('link-b');
  if (linkA) linkA.href = a.twitchUrl || `https://clips.twitch.tv/${a.twitchSlug}`;
  if (linkB) linkB.href = b.twitchUrl || `https://clips.twitch.tv/${b.twitchSlug}`;

  // Create embeds
  createTwitchEmbed(a.twitchSlug, 'video-wrapper-a');
  createTwitchEmbed(b.twitchSlug, 'video-wrapper-b');

  // Check saved states
  checkSavedStates();
}

/**
 * Load a specific pair by IDs
 */
async function loadSpecificPair(aId, bId) {
  if (isLoading) return;

  isLoading = true;
  showLoading(true);

  try {
    const response = await fetch(`/api/compare/pair?a=${aId}&b=${bId}`);

    if (!response.ok) {
      if (response.status === 401) {
        window.location.href = '/api/auth/login';
        return;
      }
      // If pair not found, load random pair instead
      if (response.status === 404) {
        await loadNextPair();
        return;
      }
      throw new Error('Failed to load clips');
    }

    const data = await response.json();
    displayClips(data.clipA, data.clipB);
    // Replace URL state (don't add to history since we loaded from URL)
    updateUrl(data.clipA, data.clipB, true);
    // Check saved states
    await checkSavedStates();
    showLoading(false);
  } catch (error) {
    console.error('Failed to load specific pair:', error);
    showToast('Failed to load clips', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Update save button appearance
 */
function updateSaveButtons() {
  const saveA = document.getElementById('save-a');
  const saveB = document.getElementById('save-b');

  if (saveA) {
    saveA.textContent = savedStates.a ? '★' : '☆';
    saveA.classList.toggle('saved', savedStates.a);
    saveA.title = savedStates.a ? 'Unsave clip' : 'Save clip';
  }
  if (saveB) {
    saveB.textContent = savedStates.b ? '★' : '☆';
    saveB.classList.toggle('saved', savedStates.b);
    saveB.title = savedStates.b ? 'Unsave clip' : 'Save clip';
  }
}

/**
 * Check saved state for current clips
 */
async function checkSavedStates() {
  if (!clipA || !clipB) return;

  try {
    const response = await fetch('/api/saved/check-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds: [clipA.id, clipB.id] }),
    });

    if (response.ok) {
      const data = await response.json();
      savedStates.a = data.saved[clipA.id] || false;
      savedStates.b = data.saved[clipB.id] || false;
      updateSaveButtons();
    }
  } catch (error) {
    console.error('Failed to check saved states:', error);
  }
}

/**
 * Toggle save state for a clip
 */
async function toggleSave(side) {
  const clip = side === 'a' ? clipA : clipB;
  if (!clip) return;

  const isSaved = savedStates[side];

  try {
    const response = await fetch(`/api/saved/${clip.id}`, {
      method: isSaved ? 'DELETE' : 'POST',
    });

    if (response.ok) {
      savedStates[side] = !isSaved;
      updateSaveButtons();
      showToast(savedStates[side] ? 'Clip saved!' : 'Clip unsaved', 'success');
    } else {
      throw new Error('Failed to update save state');
    }
  } catch (error) {
    console.error('Failed to toggle save:', error);
    showToast('Failed to save clip', 'error');
  }
}

/**
 * Load user stats
 */
async function loadStats() {
  try {
    const response = await fetch('/api/compare/stats');
    if (!response.ok) return;

    const data = await response.json();

    const comparisonsEl = document.getElementById('user-comparisons');
    const superLikesEl = document.getElementById('user-super-likes');

    if (comparisonsEl) {
      comparisonsEl.textContent = formatNumber(data.totalComparisons || 0);
    }
    if (superLikesEl) {
      superLikesEl.textContent = formatNumber(data.totalSuperLikes || 0);
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

/**
 * Load the next pair of clips to compare
 */
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

    // Update titles
    const titleA = document.getElementById('title-a');
    const titleB = document.getElementById('title-b');

    if (titleA) titleA.textContent = clipA.title || clipA.twitchSlug;
    if (titleB) titleB.textContent = clipB.title || clipB.twitchSlug;

    // Update clipped by
    const clippedByA = document.getElementById('clipped-by-a');
    const clippedByB = document.getElementById('clipped-by-b');

    if (clippedByA) clippedByA.textContent = `Clipped by ${clipA.clippedBy || 'Unknown'}`;
    if (clippedByB) clippedByB.textContent = `Clipped by ${clipB.clippedBy || 'Unknown'}`;

    // Update clipped at
    const clippedAtA = document.getElementById('clipped-at-a');
    const clippedAtB = document.getElementById('clipped-at-b');

    if (clippedAtA) clippedAtA.textContent = clipA.clippedAt ? formatDate(clipA.clippedAt) : '';
    if (clippedAtB) clippedAtB.textContent = clipB.clippedAt ? formatDate(clipB.clippedAt) : '';

    // Update links
    const linkA = document.getElementById('link-a');
    const linkB = document.getElementById('link-b');

    if (linkA) {
      linkA.href = clipA.twitchUrl || `https://clips.twitch.tv/${clipA.twitchSlug}`;
    }
    if (linkB) {
      linkB.href = clipB.twitchUrl || `https://clips.twitch.tv/${clipB.twitchSlug}`;
    }

    // Create embeds
    createTwitchEmbed(clipA.twitchSlug, 'video-wrapper-a');
    createTwitchEmbed(clipB.twitchSlug, 'video-wrapper-b');

    // Update URL for browser history
    updateUrl(clipA, clipB);

    // Check saved states for the new clips
    await checkSavedStates();

    showLoading(false);
  } catch (error) {
    console.error('Failed to load clips:', error);
    showToast('Failed to load clips', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Submit a vote
 */
async function vote(result) {
  if (isLoading || !clipA || !clipB) return;

  // Handle ranking mode separately
  if (isRankingMode) {
    await submitRankingVote(result);
    return;
  }

  isLoading = true;

  try {
    const response = await fetch('/api/compare/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clip_a_id: clipA.id,
        clip_b_id: clipB.id,
        result: result,
        time_spent_ms: Date.now() - startTime,
      }),
    });

    if (!response.ok) {
      throw new Error('Vote failed');
    }

    // Show feedback for super likes
    if (result.startsWith('super')) {
      showToast('Super Like!', 'success');
    }

    // Reset loading state before loading next pair
    isLoading = false;

    // Reload stats and next pair
    await loadStats();
    await loadNextPair();
  } catch (error) {
    console.error('Vote failed:', error);
    showToast('Failed to submit vote', 'error');
    isLoading = false;
  }
}

/**
 * Toggle loading state
 */
function showLoading(show) {
  const loadingState = document.getElementById('loading-state');
  const comparisonContainer = document.getElementById('comparison-container');
  const actionButtons = document.querySelectorAll('.action-buttons');

  if (show) {
    if (loadingState) loadingState.classList.remove('hidden');
    if (comparisonContainer) comparisonContainer.style.opacity = '0.5';
    actionButtons.forEach(btn => btn.style.pointerEvents = 'none');
  } else {
    if (loadingState) loadingState.classList.add('hidden');
    if (comparisonContainer) comparisonContainer.style.opacity = '1';
    actionButtons.forEach(btn => btn.style.pointerEvents = 'auto');
  }
}

/**
 * Initialize ranking mode
 */
async function initRankingMode(clipId) {
  isRankingMode = true;
  rankingClipId = clipId;

  showLoading(true);

  try {
    // Get the ranking session state
    const response = await fetch(`/api/clips/rank-session/${clipId}`);

    if (!response.ok) {
      if (response.status === 404) {
        showToast('Ranking session not found or expired', 'error');
        window.location.href = '/leaderboard';
        return;
      }
      throw new Error('Failed to load ranking session');
    }

    const data = await response.json();
    rankingClip = data.clipToRank;

    // Update UI for ranking mode
    updateRankingModeUI(data);

    // Display the clips
    displayRankingComparison(data.clipToRank, data.compareWith, data.progress);

    showLoading(false);
  } catch (error) {
    console.error('Failed to initialize ranking mode:', error);
    showToast('Failed to load ranking session', 'error');
    showLoading(false);
  }
}

/**
 * Update UI elements for ranking mode
 */
function updateRankingModeUI(data) {
  // Hide skip button in ranking mode
  const skipBtn = document.querySelector('.btn-vote--skip');
  if (skipBtn) {
    skipBtn.parentElement.style.display = 'none';
  }

  // Update page title/header if there's a progress indicator
  const progressEl = document.getElementById('ranking-progress');
  if (progressEl && data.progress) {
    progressEl.textContent = `Step ${data.progress.step} of ${data.progress.totalSteps}`;
    progressEl.classList.remove('hidden');
  }

  // Update shortcuts to reflect ranking mode
  const shortcuts = document.querySelector('.shortcuts');
  if (shortcuts) {
    shortcuts.innerHTML = `
      <span class="key">1</span> New clip is better
      <span class="key">2</span> Existing clip is better
      <span class="key">T</span> Tie
    `;
  }
}

/**
 * Display clips for ranking comparison
 */
function displayRankingComparison(clipToRank, compareWith, progress) {
  clipA = clipToRank;
  clipB = compareWith;
  startTime = Date.now();

  // Update titles
  const titleA = document.getElementById('title-a');
  const titleB = document.getElementById('title-b');
  if (titleA) titleA.textContent = (clipToRank?.title || clipToRank?.twitchSlug) + ' (NEW)';
  if (titleB) titleB.textContent = compareWith?.title || compareWith?.twitchSlug;

  // Clear clipped by (not available in ranking session data)
  const clippedByA = document.getElementById('clipped-by-a');
  const clippedByB = document.getElementById('clipped-by-b');
  if (clippedByA) clippedByA.textContent = '';
  if (clippedByB) clippedByB.textContent = '';

  // Clear clipped at
  const clippedAtA = document.getElementById('clipped-at-a');
  const clippedAtB = document.getElementById('clipped-at-b');
  if (clippedAtA) clippedAtA.textContent = '';
  if (clippedAtB) clippedAtB.textContent = '';

  // Update links
  const linkA = document.getElementById('link-a');
  const linkB = document.getElementById('link-b');
  if (linkA && clipToRank) linkA.href = clipToRank.twitchUrl || `https://clips.twitch.tv/${clipToRank.twitchSlug}`;
  if (linkB && compareWith) linkB.href = compareWith.twitchUrl || `https://clips.twitch.tv/${compareWith.twitchSlug}`;

  // Create embeds
  if (clipToRank) createTwitchEmbed(clipToRank.twitchSlug, 'video-wrapper-a');
  if (compareWith) createTwitchEmbed(compareWith.twitchSlug, 'video-wrapper-b');

  // Update progress indicator
  const progressEl = document.getElementById('ranking-progress');
  if (progressEl && progress) {
    progressEl.textContent = `Step ${progress.step} of ${progress.totalSteps}`;
  }
}

/**
 * Submit a ranking vote
 */
async function submitRankingVote(result) {
  if (isLoading) return;

  isLoading = true;
  showLoading(true);

  // Map vote result to ranking result
  let rankingResult;
  if (result === 'clip_a' || result === 'super_a') {
    rankingResult = 'submitted'; // New clip is better
  } else if (result === 'clip_b' || result === 'super_b') {
    rankingResult = 'existing'; // Existing clip is better
  } else {
    rankingResult = 'tie';
  }

  try {
    const response = await fetch(`/api/clips/rank-session/${rankingClipId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: rankingResult }),
    });

    if (!response.ok) {
      throw new Error('Failed to submit ranking vote');
    }

    const data = await response.json();

    if (data.done) {
      // Ranking complete!
      showToast(`Clip ranked at position #${data.finalPosition}!`, 'success');
      setTimeout(() => {
        window.location.href = '/leaderboard?tab=personal';
      }, 1500);
    } else {
      // Continue with next comparison
      displayRankingComparison(rankingClip, data.compareWith, data.progress);
      showLoading(false);
    }
  } catch (error) {
    console.error('Failed to submit ranking vote:', error);
    showToast('Failed to submit vote', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Initialize the compare page
 */
async function initComparePage() {
  const user = await checkAuth();

  const authRequired = document.getElementById('auth-required');
  const compareUi = document.getElementById('compare-ui');

  if (!user) {
    if (authRequired) authRequired.classList.remove('hidden');
    if (compareUi) compareUi.classList.add('hidden');
    return;
  }

  if (authRequired) authRequired.classList.add('hidden');
  if (compareUi) compareUi.classList.remove('hidden');

  await loadStats();

  // Check URL params
  const params = new URLSearchParams(window.location.search);

  // Check for ranking mode
  const rankClipId = params.get('rank');
  if (rankClipId) {
    await initRankingMode(rankClipId);
    // Set up keyboard shortcuts for ranking mode
    document.addEventListener('keydown', handleKeyboard);
    return;
  }

  // Check for specific pair
  const clipAId = params.get('a');
  const clipBId = params.get('b');

  if (clipAId && clipBId) {
    await loadSpecificPair(clipAId, clipBId);
  } else {
    await loadNextPair();
  }

  // Set up keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (event) => {
    if (event.state?.clipA && event.state?.clipB) {
      displayClips(event.state.clipA, event.state.clipB);
    }
  });
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboard(event) {
  // Ignore if typing in an input
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
    return;
  }

  switch (event.key) {
    case '1':
      vote(event.shiftKey ? 'super_a' : 'clip_a');
      break;
    case '2':
      vote(event.shiftKey ? 'super_b' : 'clip_b');
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
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initComparePage);

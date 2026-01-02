/**
 * Clip Ranker - Compare Page Logic
 * =================================
 */

import type { Clip, ClipPair, VoteResult, User } from './types';

// API response types
interface UserStatsResponse {
  totalComparisons: number;
  totalSuperLikes: number;
  // Pairing coverage stats
  totalClips: number;
  totalPossiblePairs: number;
  userComparisons: number;
  coveragePercent: number;
}

interface VoteResponse {
  success: boolean;
  newRatings: {
    clipA: { id: number; elo: number };
    clipB: { id: number; elo: number };
  };
  stats?: {
    totalComparisons: number;
    totalSuperLikes: number;
  };
}

interface CheckSavedResponse {
  saved: Record<number, boolean>;
}

interface RankingProgress {
  step: number;
  totalSteps: number;
}

interface RankingSessionResponse {
  clipToRank: Clip;
  compareWith: Clip;
  progress: RankingProgress;
}

interface RankingVoteResponse {
  done: boolean;
  finalPosition?: number;
  compareWith?: Clip;
  progress?: RankingProgress;
}

type RankingResult = 'submitted' | 'existing' | 'tie';

interface SavedStates {
  a: boolean;
  b: boolean;
}

interface HistoryState {
  clipA: Clip;
  clipB: Clip;
}

// Extended ClipPair response with prefetch info
interface ClipPairResponse extends ClipPair {
  remainingPairs?: number;
  batchSize?: number;
}

// Peek response for prefetching
interface PeekResponse {
  pairs: ClipPair[];
  remainingCount: number;
}

// Page state
let clipA: Clip | null = null;
let clipB: Clip | null = null;
let startTime: number | null = null;
let isLoading: boolean = false;
let savedStates: SavedStates = { a: false, b: false };

// Ranking mode state
let isRankingMode: boolean = false;
let isRerankMode: boolean = false;
let rankingClipId: string | null = null;
let rankingClip: Clip | null = null;

// Prefetch state
let prefetchedPairs: ClipPair[] = [];
let prefetchInProgress: boolean = false;
const PREFETCH_THRESHOLD = 3; // Trigger batch refresh when this many pairs left
const PREFETCH_COUNT = 3; // Number of pairs to prefetch

// Local stats tracking (for optimistic UI updates during rapid voting)
let localComparisons: number = 0;
let localSuperLikes: number = 0;

// In-place preload tracking
let preloadedSlugA: string | null = null;
let preloadedSlugB: string | null = null;

/**
 * Prefetch a thumbnail image using link rel="prefetch"
 */
function prefetchThumbnail(twitchSlug: string): void {
  // Use the same thumbnail URL format as getTwitchThumbnail in app.ts
  const thumbnailUrl = `https://clips-media-assets2.twitch.tv/${twitchSlug}-preview-480x272.jpg`;

  // Check if already prefetched
  if (document.querySelector(`link[href="${thumbnailUrl}"]`)) {
    return;
  }

  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'image';
  link.href = thumbnailUrl;
  document.head.appendChild(link);
}

/**
 * Preload a Twitch embed iframe in-place as a hidden overlay
 */
function preloadEmbedInPlace(slug: string, wrapperId: string, overlayId: string): void {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;

  // Remove any existing preload overlay
  document.getElementById(overlayId)?.remove();

  // Create new overlay with iframe
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'preload-overlay';
  overlay.innerHTML = `
    <iframe
      src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false"
      allowfullscreen
    ></iframe>
  `;
  wrapper.appendChild(overlay);
  console.debug(`[Preload] Created in-place overlay for ${slug}`);
}

/**
 * Preload the next pair's embeds as hidden overlays
 */
function preloadNextPairInPlace(nextClipA: Clip, nextClipB: Clip): void {
  preloadEmbedInPlace(nextClipA.twitchSlug, 'video-wrapper-a', 'preload-a');
  preloadEmbedInPlace(nextClipB.twitchSlug, 'video-wrapper-b', 'preload-b');
  preloadedSlugA = nextClipA.twitchSlug;
  preloadedSlugB = nextClipB.twitchSlug;
}

/**
 * Show embed - use preloaded overlay if available, otherwise create fresh
 */
function showEmbed(slug: string, wrapperId: string, overlayId: string, currentId: string): void {
  const wrapper = document.getElementById(wrapperId);
  if (!wrapper) return;

  // Remove current embed
  document.getElementById(currentId)?.remove();

  // Check if we have a preloaded overlay for this slug
  const preload = document.getElementById(overlayId);
  const preloadedSlug = overlayId === 'preload-a' ? preloadedSlugA : preloadedSlugB;

  if (preload && preloadedSlug === slug) {
    // Activate the preloaded overlay (no DOM move - just toggle visibility)
    preload.classList.add('active');
    preload.id = currentId; // Rename to current
    console.debug(`[Preload] Activated preloaded embed for ${slug}`);
  } else {
    // Fallback: create fresh embed
    preload?.remove();
    const div = document.createElement('div');
    div.id = currentId;
    div.className = 'preload-overlay active';
    div.innerHTML = `
      <iframe
        src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false"
        allowfullscreen
      ></iframe>
    `;
    wrapper.appendChild(div);
  }

  // Reset preloaded slug tracking
  if (overlayId === 'preload-a') preloadedSlugA = null;
  else preloadedSlugB = null;
}

/**
 * Clear preload state (used when leaving compare page)
 */
function clearPreloadState(): void {
  preloadedSlugA = null;
  preloadedSlugB = null;
  document.getElementById('preload-a')?.remove();
  document.getElementById('preload-b')?.remove();
}

/**
 * Prefetch upcoming clip pairs and their thumbnails
 */
async function prefetchUpcomingPairs(): Promise<void> {
  if (prefetchInProgress) return;

  prefetchInProgress = true;

  try {
    const response = await fetch(`/api/compare/peek?count=${PREFETCH_COUNT}`);

    if (!response.ok) {
      console.debug('Prefetch peek failed:', response.status);
      return;
    }

    const data: PeekResponse = await response.json();

    // Store prefetched pairs for instant loading
    prefetchedPairs = data.pairs;

    // Prefetch thumbnails for all upcoming clips
    for (const pair of data.pairs) {
      prefetchThumbnail(pair.clipA.twitchSlug);
      prefetchThumbnail(pair.clipB.twitchSlug);
    }

    // Preload embeds for FIRST upcoming pair only (in-place)
    if (data.pairs.length > 0) {
      preloadNextPairInPlace(data.pairs[0].clipA, data.pairs[0].clipB);
    }

    console.debug(`[Prefetch] ${data.pairs.length} pairs, ${data.remainingCount} remaining in batch`);
  } catch (error) {
    console.debug('Prefetch failed:', error);
  } finally {
    prefetchInProgress = false;
  }
}

/**
 * Update the browser URL with current clip IDs
 */
function updateUrl(a: Clip, b: Clip, replace: boolean = false): void {
  const url = `/compare?a=${a.id}&b=${b.id}`;
  const state: HistoryState = { clipA: a, clipB: b };

  if (replace) {
    history.replaceState(state, '', url);
  } else {
    history.pushState(state, '', url);
  }
}

/**
 * Display clips from state (used for back/forward navigation)
 */
function displayClips(a: Clip, b: Clip): void {
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
  if (clippedAtA) clippedAtA.textContent = a.clippedAt ? window.formatDate(a.clippedAt) : '';
  if (clippedAtB) clippedAtB.textContent = b.clippedAt ? window.formatDate(b.clippedAt) : '';

  // Update links
  const linkA = document.getElementById('link-a') as HTMLAnchorElement | null;
  const linkB = document.getElementById('link-b') as HTMLAnchorElement | null;
  if (linkA) linkA.href = a.twitchUrl || `https://clips.twitch.tv/${a.twitchSlug}`;
  if (linkB) linkB.href = b.twitchUrl || `https://clips.twitch.tv/${b.twitchSlug}`;

  // Create embeds (use preloaded if available)
  showEmbed(a.twitchSlug, 'video-wrapper-a', 'preload-a', 'current-a');
  showEmbed(b.twitchSlug, 'video-wrapper-b', 'preload-b', 'current-b');

  // Check saved states
  checkSavedStates();
}

/**
 * Load a specific pair by IDs
 */
async function loadSpecificPair(aId: string, bId: string): Promise<void> {
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

    const data: ClipPair = await response.json();
    displayClips(data.clipA, data.clipB);
    // Replace URL state (don't add to history since we loaded from URL)
    updateUrl(data.clipA, data.clipB, true);
    // Check saved states
    await checkSavedStates();
    showLoading(false);
  } catch (error) {
    console.error('Failed to load specific pair:', error);
    window.showToast('Failed to load clips', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Update save button appearance
 */
function updateSaveButtons(): void {
  const saveA = document.getElementById('save-a');
  const saveB = document.getElementById('save-b');

  if (saveA) {
    saveA.textContent = savedStates.a ? '\u2605' : '\u2606';
    saveA.classList.toggle('saved', savedStates.a);
    saveA.title = savedStates.a ? 'Unsave clip' : 'Save clip';
  }
  if (saveB) {
    saveB.textContent = savedStates.b ? '\u2605' : '\u2606';
    saveB.classList.toggle('saved', savedStates.b);
    saveB.title = savedStates.b ? 'Unsave clip' : 'Save clip';
  }
}

/**
 * Check saved state for current clips
 */
async function checkSavedStates(): Promise<void> {
  if (!clipA || !clipB) return;

  try {
    const response = await fetch('/api/saved/check-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds: [clipA.id, clipB.id] }),
    });

    if (response.ok) {
      const data: CheckSavedResponse = await response.json();
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
async function toggleSave(side: 'a' | 'b'): Promise<void> {
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
      window.showToast(savedStates[side] ? 'Clip saved!' : 'Clip unsaved', 'success');
    } else {
      throw new Error('Failed to update save state');
    }
  } catch (error) {
    console.error('Failed to toggle save:', error);
    window.showToast('Failed to save clip', 'error');
  }
}

/**
 * Load user stats
 */
async function loadStats(): Promise<void> {
  try {
    const response = await fetch('/api/compare/stats');
    if (!response.ok) return;

    const data: UserStatsResponse = await response.json();

    // Initialize local tracking from server values
    localComparisons = data.totalComparisons || 0;
    localSuperLikes = data.totalSuperLikes || 0;

    const comparisonsEl = document.getElementById('user-comparisons');
    const superLikesEl = document.getElementById('user-super-likes');
    const coverageEl = document.getElementById('coverage-percent');

    if (comparisonsEl) {
      comparisonsEl.textContent = window.formatNumber(localComparisons);
    }
    if (superLikesEl) {
      superLikesEl.textContent = window.formatNumber(localSuperLikes);
    }
    if (coverageEl) {
      coverageEl.textContent = `${data.coveragePercent?.toFixed(1) || '0'}%`;
      coverageEl.title = `${data.userComparisons || 0} unique pairs out of ${data.totalPossiblePairs || 0} possible`;
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

/**
 * Load the next pair of clips to compare
 */
async function loadNextPair(): Promise<void> {
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

    const data: ClipPairResponse = await response.json();

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

    if (clippedAtA) clippedAtA.textContent = clipA.clippedAt ? window.formatDate(clipA.clippedAt) : '';
    if (clippedAtB) clippedAtB.textContent = clipB.clippedAt ? window.formatDate(clipB.clippedAt) : '';

    // Update links
    const linkA = document.getElementById('link-a') as HTMLAnchorElement | null;
    const linkB = document.getElementById('link-b') as HTMLAnchorElement | null;

    if (linkA) {
      linkA.href = clipA.twitchUrl || `https://clips.twitch.tv/${clipA.twitchSlug}`;
    }
    if (linkB) {
      linkB.href = clipB.twitchUrl || `https://clips.twitch.tv/${clipB.twitchSlug}`;
    }

    // Create embeds (use in-place preloaded if available, otherwise fresh)
    showEmbed(clipA.twitchSlug, 'video-wrapper-a', 'preload-a', 'current-a');
    showEmbed(clipB.twitchSlug, 'video-wrapper-b', 'preload-b', 'current-b');

    // Update URL for browser history
    updateUrl(clipA, clipB);

    // Check saved states for the new clips
    await checkSavedStates();

    showLoading(false);

    // Trigger prefetch if remaining pairs is low (don't await - fire and forget)
    if (
      typeof data.remainingPairs === 'number' &&
      data.remainingPairs <= PREFETCH_THRESHOLD
    ) {
      prefetchUpcomingPairs();
    }
  } catch (error) {
    console.error('Failed to load clips:', error);
    window.showToast('Failed to load clips', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Submit a vote
 */
async function vote(result: VoteResult): Promise<void> {
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
        time_spent_ms: startTime ? Date.now() - startTime : 0,
      }),
    });

    if (!response.ok) {
      throw new Error('Vote failed');
    }

    const data: VoteResponse = await response.json();

    // Increment local stats immediately (don't wait for async queue)
    localComparisons++;
    if (result.startsWith('super')) {
      localSuperLikes++;
    }

    // Update UI with local values
    const comparisonsEl = document.getElementById('user-comparisons');
    const superLikesEl = document.getElementById('user-super-likes');

    if (comparisonsEl) {
      comparisonsEl.textContent = window.formatNumber(localComparisons);
    }
    if (superLikesEl) {
      superLikesEl.textContent = window.formatNumber(localSuperLikes);
    }

    // Show feedback for super likes
    if (result.startsWith('super')) {
      window.showToast('Super Like!', 'success');
    }

    // Reset loading state before loading next pair
    isLoading = false;

    // Load next pair (no need to reload stats - we have them from response)
    await loadNextPair();
  } catch (error) {
    console.error('Vote failed:', error);
    window.showToast('Failed to submit vote', 'error');
    isLoading = false;
  }
}

/**
 * Toggle loading state
 */
function showLoading(show: boolean): void {
  const loadingState = document.getElementById('loading-state');
  const comparisonContainer = document.getElementById('comparison-container');
  const actionButtons = document.querySelectorAll<HTMLElement>('.action-buttons');

  if (show) {
    if (loadingState) loadingState.classList.remove('hidden');
    if (comparisonContainer) comparisonContainer.style.opacity = '0.5';
    actionButtons.forEach((btn) => (btn.style.pointerEvents = 'none'));
  } else {
    if (loadingState) loadingState.classList.add('hidden');
    if (comparisonContainer) comparisonContainer.style.opacity = '1';
    actionButtons.forEach((btn) => (btn.style.pointerEvents = 'auto'));
  }
}

/**
 * Initialize ranking mode
 */
async function initRankingMode(clipId: string, isRerank: boolean = false): Promise<void> {
  isRankingMode = true;
  isRerankMode = isRerank;
  rankingClipId = clipId;

  showLoading(true);

  try {
    // Get the ranking session state
    const response = await fetch(`/api/clips/rank-session/${clipId}`);

    if (!response.ok) {
      if (response.status === 404) {
        window.showToast('Ranking session not found or expired', 'error');
        window.location.href = '/leaderboard';
        return;
      }
      throw new Error('Failed to load ranking session');
    }

    const data: RankingSessionResponse = await response.json();
    rankingClip = data.clipToRank;

    // Update UI for ranking mode
    updateRankingModeUI(data);

    // Display the clips
    displayRankingComparison(data.clipToRank, data.compareWith, data.progress);

    showLoading(false);
  } catch (error) {
    console.error('Failed to initialize ranking mode:', error);
    window.showToast('Failed to load ranking session', 'error');
    showLoading(false);
  }
}

/**
 * Update UI elements for ranking mode
 */
function updateRankingModeUI(data: RankingSessionResponse): void {
  // Hide skip button in ranking mode
  const skipBtn = document.querySelector('.btn-vote--skip') as HTMLElement | null;
  if (skipBtn) {
    const parentElement = skipBtn.parentElement;
    if (parentElement) {
      parentElement.style.display = 'none';
    }
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
    const clipLabel = isRerankMode ? 'This clip' : 'New clip';
    shortcuts.innerHTML = `
      <span class="key">1</span> ${clipLabel} is better
      <span class="key">2</span> Other clip is better
      <span class="key">T</span> Tie
    `;
  }
}

/**
 * Display clips for ranking comparison
 */
function displayRankingComparison(
  clipToRank: Clip,
  compareWith: Clip,
  progress: RankingProgress
): void {
  clipA = clipToRank;
  clipB = compareWith;
  startTime = Date.now();

  // Update titles
  const titleA = document.getElementById('title-a');
  const titleB = document.getElementById('title-b');
  const label = isRerankMode ? '(RERANKING)' : '(NEW)';
  if (titleA) titleA.textContent = (clipToRank?.title || clipToRank?.twitchSlug) + ' ' + label;
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
  const linkA = document.getElementById('link-a') as HTMLAnchorElement | null;
  const linkB = document.getElementById('link-b') as HTMLAnchorElement | null;
  if (linkA && clipToRank)
    linkA.href = clipToRank.twitchUrl || `https://clips.twitch.tv/${clipToRank.twitchSlug}`;
  if (linkB && compareWith)
    linkB.href = compareWith.twitchUrl || `https://clips.twitch.tv/${compareWith.twitchSlug}`;

  // Create embeds (use preloaded if available)
  if (clipToRank) showEmbed(clipToRank.twitchSlug, 'video-wrapper-a', 'preload-a', 'current-a');
  if (compareWith) showEmbed(compareWith.twitchSlug, 'video-wrapper-b', 'preload-b', 'current-b');

  // Update progress indicator
  const progressEl = document.getElementById('ranking-progress');
  if (progressEl && progress) {
    progressEl.textContent = `Step ${progress.step} of ${progress.totalSteps}`;
  }
}

/**
 * Submit a ranking vote
 */
async function submitRankingVote(result: VoteResult): Promise<void> {
  if (isLoading) return;

  isLoading = true;
  showLoading(true);

  // Map vote result to ranking result
  let rankingResult: RankingResult;
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

    const data: RankingVoteResponse = await response.json();

    if (data.done) {
      // Ranking complete!
      const action = isRerankMode ? 'reranked' : 'ranked';
      window.showToast(`Clip ${action} at position #${data.finalPosition}!`, 'success');
      setTimeout(() => {
        window.location.href = '/leaderboard?tab=personal';
      }, 1500);
    } else {
      // Continue with next comparison
      if (rankingClip && data.compareWith && data.progress) {
        displayRankingComparison(rankingClip, data.compareWith, data.progress);
      }
      showLoading(false);
    }
  } catch (error) {
    console.error('Failed to submit ranking vote:', error);
    window.showToast('Failed to submit vote', 'error');
    showLoading(false);
  } finally {
    isLoading = false;
  }
}

/**
 * Set up event listeners for static HTML elements
 */
function setupEventListeners(): void {
  // Save buttons
  document.getElementById('save-a')?.addEventListener('click', () => toggleSave('a'));
  document.getElementById('save-b')?.addEventListener('click', () => toggleSave('b'));

  // Vote buttons
  document.getElementById('vote-super-a')?.addEventListener('click', () => vote('super_a'));
  document.getElementById('vote-clip-a')?.addEventListener('click', () => vote('clip_a'));
  document.getElementById('vote-tie')?.addEventListener('click', () => vote('tie'));
  document.getElementById('vote-clip-b')?.addEventListener('click', () => vote('clip_b'));
  document.getElementById('vote-super-b')?.addEventListener('click', () => vote('super_b'));
  document.getElementById('vote-skip')?.addEventListener('click', () => vote('skip'));
}

/**
 * Initialize the compare page
 */
async function initComparePage(): Promise<void> {
  // Set up event listeners first
  setupEventListeners();

  const user: User | null = await window.checkAuth();

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

  // Check for ranking mode (new clip or rerank existing)
  const rankClipId = params.get('rank');
  const rerankClipId = params.get('rerank');
  if (rankClipId) {
    await initRankingMode(rankClipId, false);
    // Set up keyboard shortcuts for ranking mode
    document.addEventListener('keydown', handleKeyboard);
    return;
  }
  if (rerankClipId) {
    await initRankingMode(rerankClipId, true);
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

  // Start prefetching immediately after first load (fire and forget)
  prefetchUpcomingPairs();

  // Set up keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (event: PopStateEvent) => {
    const state = event.state as HistoryState | null;
    if (state?.clipA && state?.clipB) {
      displayClips(state.clipA, state.clipB);
    }
  });
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboard(event: KeyboardEvent): void {
  // Ignore if typing in an input
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
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

// Export functions for use in other modules
export {
  clipA,
  clipB,
  vote,
  toggleSave,
  loadNextPair,
  initComparePage,
  displayClips,
  loadSpecificPair,
  loadStats,
  initRankingMode,
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initComparePage);


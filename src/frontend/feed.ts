/**
 * Activity Feed Page
 * ==================
 */

import type { ActivityEntry, User } from './types';
import {
  checkAuth,
  escapeHtml,
  getTwitchThumbnail,
  handleThumbnailError
} from './app';

// API response types
interface GlobalActivityResponse {
  activities: ActivityEntry[];
}

interface TrendingClip {
  id: number;
  twitchSlug: string;
  title: string;
  voteCount: number;
  superLikeCount: number;
}

interface TrendingResponse {
  clips: TrendingClip[];
}

interface MyActivityResponse {
  activities: ActivityEntry[];
}

// Activity type for icon/label mapping
type ActivityType = 'vote' | 'super_like' | 'comment' | 'save';

// Tab type
type TabType = 'global' | 'trending' | 'my';

// Trending period type
type TrendingPeriod = 'day' | 'week' | 'month' | 'all';

// State
let currentTab: TabType = 'global';
let globalOffset: number = 0;
let myOffset: number = 0;
const PAGE_SIZE: number = 20;

// Activity type icons
const ACTIVITY_ICONS: Record<ActivityType, string> = {
  vote: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M1 8.25a1.25 1.25 0 112.5 0v7.5a1.25 1.25 0 11-2.5 0v-7.5zM11 3V1.7c0-.268.14-.526.395-.607A2 2 0 0114 3c0 .995-.182 1.948-.514 2.826-.204.54.166 1.174.744 1.174h2.52c1.243 0 2.261 1.01 2.146 2.247a23.864 23.864 0 01-1.341 5.974C17.153 16.323 16.072 17 14.9 17h-3.192a3 3 0 01-1.341-.317l-2.734-1.366A3 3 0 006.292 15H5V8h1.292a3 3 0 002.042-.793l1.932-1.78A3 3 0 0011 3z"/></svg>',
  super_like: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clip-rule="evenodd"/></svg>',
  comment: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.43 2.524A41.29 41.29 0 0110 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 01-5.183.501l-2.926 2.927A.75.75 0 017 16.06v-2.867c-1.018-.09-2.025-.232-3.013-.424-1.437-.231-2.43-1.49-2.43-2.902V5.426c0-1.413.993-2.67 2.43-2.902z" clip-rule="evenodd"/></svg>',
  save: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2c-1.716 0-3.408.106-5.07.31C3.806 2.45 3 3.414 3 4.517V17.25a.75.75 0 001.075.676L10 15.082l5.925 2.844A.75.75 0 0017 17.25V4.517c0-1.103-.806-2.068-1.93-2.207A41.403 41.403 0 0010 2z" clip-rule="evenodd"/></svg>'
};

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  vote: 'voted for',
  super_like: 'super liked',
  comment: 'commented on',
  save: 'saved'
};

/**
 * Switch between tabs
 */
function switchTab(tab: TabType): void {
  currentTab = tab;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn: Element) => btn.classList.remove('active'));
  const tabBtn = document.getElementById(`tab-${tab}`);
  if (tabBtn) {
    tabBtn.classList.add('active');
  }

  // Show/hide sections
  const globalSection = document.getElementById('global-section');
  const trendingSection = document.getElementById('trending-section');
  const mySection = document.getElementById('my-section');

  if (globalSection) globalSection.classList.toggle('hidden', tab !== 'global');
  if (trendingSection) trendingSection.classList.toggle('hidden', tab !== 'trending');
  if (mySection) mySection.classList.toggle('hidden', tab !== 'my');

  // Load data for the selected tab
  if (tab === 'global') {
    loadGlobalActivity();
  } else if (tab === 'trending') {
    loadTrending();
  } else if (tab === 'my') {
    loadMyActivity();
  }
}

/**
 * Format relative time
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = (now.getTime() - date.getTime()) / 1000; // seconds

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

/**
 * Render activity item
 */
function renderActivityItem(activity: ActivityEntry, showUser: boolean = true): string {
  const icon: string = ACTIVITY_ICONS[activity.type] || '';
  const label: string = ACTIVITY_LABELS[activity.type] || activity.type;
  const userHtml: string = showUser && activity.user ? `
    <img class="activity-avatar" src="${escapeHtml(activity.user.profileImage || '/img/default-avatar.png')}" alt="" onerror="this.style.display='none'">
    <span class="activity-user">${escapeHtml(activity.user.displayName || 'Anonymous')}</span>
  ` : '';

  const clipLink: string = activity.clipSlug
    ? `<a href="https://clips.twitch.tv/${encodeURIComponent(activity.clipSlug)}" target="_blank" rel="noopener" class="activity-clip-link">${escapeHtml(activity.clipTitle || 'Untitled Clip')}</a>`
    : `<span class="activity-clip-title">${escapeHtml(activity.clipTitle || 'Untitled Clip')}</span>`;

  return `
    <div class="activity-item activity-type-${activity.type}">
      <div class="activity-icon">${icon}</div>
      <div class="activity-content">
        ${userHtml}
        <span class="activity-label">${label}</span>
        ${clipLink}
      </div>
      <div class="activity-time">${formatRelativeTime(activity.createdAt)}</div>
    </div>
  `;
}

/**
 * Render global activity (shared by fresh fetch and cache)
 */
function renderGlobalActivity(
  data: GlobalActivityResponse,
  container: HTMLElement,
  loadMoreBtn: HTMLElement | null
): void {
  container.innerHTML = '';

  if (data.activities.length === 0) {
    container.innerHTML = '<div class="empty-state">No activity yet. Be the first to vote!</div>';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }

  data.activities.forEach((activity: ActivityEntry) => {
    container.insertAdjacentHTML('beforeend', renderActivityItem(activity, true));
  });

  globalOffset = data.activities.length;
  if (loadMoreBtn) {
    loadMoreBtn.classList.toggle('hidden', data.activities.length < PAGE_SIZE);
  }
}

/**
 * Load global activity feed
 */
async function loadGlobalActivity(append: boolean = false): Promise<void> {
  const container = document.getElementById('global-activity');
  const loadMoreBtn = document.getElementById('load-more-global');

  if (!container) return;

  if (!append) {
    globalOffset = 0;
  }

  const apiUrl = `/api/feed/global?limit=${PAGE_SIZE}&offset=${globalOffset}`;

  // Check for prefetched data (only for initial load)
  if (!append && globalOffset === 0 && window.getCachedApiData) {
    const cached = window.getCachedApiData<GlobalActivityResponse>(apiUrl);
    if (cached) {
      console.debug('[Feed] Using prefetched data');
      renderGlobalActivity(cached, container, loadMoreBtn);
      return;
    }
  }

  if (!append) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  }

  try {
    const response: Response = await fetch(apiUrl);
    if (!response.ok) throw new Error('Failed to load activity');

    const data: GlobalActivityResponse = await response.json();

    if (!append) {
      container.innerHTML = '';
    }

    if (data.activities.length === 0 && !append) {
      container.innerHTML = '<div class="empty-state">No activity yet. Be the first to vote!</div>';
      if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
      return;
    }

    data.activities.forEach((activity: ActivityEntry) => {
      container.insertAdjacentHTML('beforeend', renderActivityItem(activity, true));
    });

    globalOffset += data.activities.length;
    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', data.activities.length < PAGE_SIZE);
    }
  } catch (error) {
    console.error('Load global activity failed:', error);
    if (!append) {
      container.innerHTML = '<div class="empty-state">Failed to load activity. Please try again.</div>';
    }
  }
}

/**
 * Load more global activity
 */
function loadMoreGlobal(): void {
  loadGlobalActivity(true);
}

/**
 * Load trending clips
 */
async function loadTrending(): Promise<void> {
  const container = document.getElementById('trending-list');
  const periodSelect = document.getElementById('period-select') as HTMLSelectElement | null;

  if (!container) return;

  const period: TrendingPeriod = (periodSelect?.value as TrendingPeriod) || 'week';

  container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  try {
    const response: Response = await fetch(`/api/feed/trending?period=${period}&limit=20`);
    if (!response.ok) throw new Error('Failed to load trending');

    const data: TrendingResponse = await response.json();

    if (data.clips.length === 0) {
      container.innerHTML = '<div class="empty-state">No trending clips in this period.</div>';
      return;
    }

    container.innerHTML = data.clips.map((clip: TrendingClip, index: number): string => `
      <div class="trending-item">
        <span class="trending-rank">#${index + 1}</span>
        <img class="trending-thumbnail" src="${getTwitchThumbnail(clip.twitchSlug)}" alt="" onerror="handleThumbnailError(this)">
        <div class="trending-info">
          <a href="https://clips.twitch.tv/${encodeURIComponent(clip.twitchSlug)}" target="_blank" rel="noopener" class="trending-title">
            ${escapeHtml(clip.title || 'Untitled Clip')}
          </a>
          <div class="trending-stats">
            <span class="stat">${clip.voteCount} votes</span>
            <span class="stat">${clip.superLikeCount} super likes</span>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Load trending failed:', error);
    container.innerHTML = '<div class="empty-state">Failed to load trending. Please try again.</div>';
  }
}

/**
 * Load my activity
 */
async function loadMyActivity(append: boolean = false): Promise<void> {
  const container = document.getElementById('my-activity');
  const authPrompt = document.getElementById('my-activity-auth');
  const loadMoreBtn = document.getElementById('load-more-my');

  if (!container) return;

  // Access currentUser from window (set by app.ts)
  const currentUser: User | null = window.currentUser;

  if (!currentUser) {
    container.classList.add('hidden');
    if (authPrompt) authPrompt.classList.remove('hidden');
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  if (authPrompt) authPrompt.classList.add('hidden');

  if (!append) {
    myOffset = 0;
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  }

  try {
    const response: Response = await fetch(`/api/feed/me?limit=${PAGE_SIZE}&offset=${myOffset}`);
    if (!response.ok) throw new Error('Failed to load activity');

    const data: MyActivityResponse = await response.json();

    if (!append) {
      container.innerHTML = '';
    }

    if (data.activities.length === 0 && !append) {
      container.innerHTML = '<div class="empty-state">No activity yet. <a href="/compare">Start comparing</a> to build your history!</div>';
      if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
      return;
    }

    data.activities.forEach((activity: ActivityEntry) => {
      container.insertAdjacentHTML('beforeend', renderActivityItem(activity, false));
    });

    myOffset += data.activities.length;
    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', data.activities.length < PAGE_SIZE);
    }
  } catch (error) {
    console.error('Load my activity failed:', error);
    if (!append) {
      container.innerHTML = '<div class="empty-state">Failed to load activity. Please try again.</div>';
    }
  }
}

/**
 * Load more my activity
 */
function loadMoreMy(): void {
  loadMyActivity(true);
}

/**
 * Set up event listeners for static HTML elements
 */
function setupEventListeners(): void {
  // Tab buttons
  document.getElementById('tab-global')?.addEventListener('click', () => switchTab('global'));
  document.getElementById('tab-trending')?.addEventListener('click', () => switchTab('trending'));
  document.getElementById('tab-my')?.addEventListener('click', () => switchTab('my'));

  // Load more buttons
  document.getElementById('load-more-global')?.addEventListener('click', loadMoreGlobal);
  document.getElementById('load-more-my')?.addEventListener('click', loadMoreMy);

  // Period select
  document.getElementById('period-select')?.addEventListener('change', loadTrending);
}

/**
 * Initialize page
 */
async function init(): Promise<void> {
  setupEventListeners();
  await checkAuth();
  loadGlobalActivity();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

// Support SPA navigation - reinitialize on content swap
window.addEventListener('spa:pageload', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  if (detail.pathname === '/feed' || detail.pathname === '/feed.html') {
    // Reset state for fresh load
    currentTab = 'global';
    globalOffset = 0;
    myOffset = 0;
    init();
  }
});

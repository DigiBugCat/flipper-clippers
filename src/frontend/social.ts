/**
 * Social/Profile Page
 * ====================
 */

import type { User } from './types';
import {
  currentUser,
  checkAuth,
  formatNumber,
  escapeHtml,
  getTwitchThumbnail,
} from './app';

// API Response Types

interface TopClip {
  id: number;
  twitchSlug: string;
  title: string | null;
  userElo: number;
}

interface ProfileData {
  userId: number;
  displayName: string | null;
  profileImage: string | null;
  totalComparisons: number;
  coveragePercent: number;
  uniquePairs: number;
  totalPossiblePairs: number;
}

interface CompatibilityData {
  score: number;
  sharedClips: number;
}

interface ProfileResponse {
  profile: ProfileData;
  topClips: TopClip[];
  compatibility?: CompatibilityData;
}

interface SimilarUser {
  userId: number;
  displayName: string | null;
  profileImage: string | null;
  compatibilityScore: number;
  sharedClips: number;
}

interface SimilarUsersResponse {
  users: SimilarUser[];
}

interface ApiErrorResponse {
  error: string;
}

// Get user ID from URL
function getUserIdFromUrl(): number {
  const params = new URLSearchParams(window.location.search);
  return parseInt(params.get('id') || '0', 10);
}

/**
 * Load user profile
 */
async function loadProfile(userId: number): Promise<void> {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('profile-content');

  try {
    const response = await fetch(`/api/social/profile/${userId}`);

    if (!response.ok) {
      const error: ApiErrorResponse = await response.json();
      throw new Error(error.error || 'Profile not found');
    }

    const data: ProfileResponse = await response.json();

    // Update profile header
    const profileImageEl = document.getElementById('profile-image') as HTMLImageElement | null;
    const profileNameEl = document.getElementById('profile-name');
    const profileStatsEl = document.getElementById('profile-stats');

    if (profileImageEl) {
      profileImageEl.src = data.profile.profileImage || '/img/default-avatar.png';
    }
    if (profileNameEl) {
      profileNameEl.textContent = data.profile.displayName || 'Anonymous';
    }
    if (profileStatsEl) {
      // Only show vote count on other users' profiles (coverage shown only on own profile)
      profileStatsEl.textContent = `${formatNumber(data.profile.totalComparisons)} votes cast`;
    }

    // Show compatibility if available
    if (data.compatibility) {
      const badge = document.getElementById('compatibility-badge');
      if (badge) {
        const scoreEl = badge.querySelector('.compat-score');
        if (scoreEl) {
          scoreEl.textContent = `${data.compatibility.score}%`;
        }
        badge.classList.remove('hidden');
      }
    }

    // Render top clips
    renderTopClips(data.topClips);

    // Hide loading, show content
    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

  } catch (error) {
    console.error('Failed to load profile:', error);
    const errorMessageEl = document.getElementById('error-message');
    if (errorMessageEl && error instanceof Error) {
      errorMessageEl.textContent = error.message;
    }
    if (loadingEl) loadingEl.classList.add('hidden');
    if (errorEl) errorEl.classList.remove('hidden');
  }
}

/**
 * Render top clips list
 */
function renderTopClips(clips: TopClip[]): void {
  const container = document.getElementById('top-clips-list');
  if (!container) return;

  if (!clips || clips.length === 0) {
    container.innerHTML = '<div class="empty-state">No clips rated yet.</div>';
    return;
  }

  container.innerHTML = clips.map((clip: TopClip, index: number): string => `
    <div class="top-clip-item">
      <span class="top-clip-rank">#${index + 1}</span>
      <img class="top-clip-thumbnail" src="${getTwitchThumbnail(clip.twitchSlug)}" alt="" onerror="handleThumbnailError(this)">
      <div class="top-clip-info">
        <a href="https://clips.twitch.tv/${encodeURIComponent(clip.twitchSlug)}" target="_blank" rel="noopener" class="top-clip-title">
          ${escapeHtml(clip.title || 'Untitled Clip')}
        </a>
        <span class="top-clip-elo">${clip.userElo} ELO</span>
      </div>
    </div>
  `).join('');
}

/**
 * Load similar users (for own profile)
 */
async function loadSimilarUsers(): Promise<void> {
  const section = document.getElementById('similar-users-section');
  const container = document.getElementById('similar-users-list');

  if (!section || !container) return;

  section.classList.remove('hidden');

  try {
    const response = await fetch('/api/social/similar?limit=10');
    if (!response.ok) throw new Error('Failed to load');

    const data: SimilarUsersResponse = await response.json();

    if (data.users.length === 0) {
      container.innerHTML = '<div class="empty-state">No similar users found yet. Keep voting to find people with similar taste!</div>';
      return;
    }

    container.innerHTML = data.users.map((user: SimilarUser): string => `
      <a href="/profile?id=${user.userId}" class="similar-user-card">
        <img class="similar-user-avatar" src="${escapeHtml(user.profileImage || '/img/default-avatar.png')}" alt="" onerror="this.style.display='none'">
        <div class="similar-user-info">
          <span class="similar-user-name">${escapeHtml(user.displayName || 'Anonymous')}</span>
          <span class="similar-user-compat">${user.compatibilityScore}% match (${user.sharedClips} clips)</span>
        </div>
      </a>
    `).join('');

  } catch (error) {
    console.error('Failed to load similar users:', error);
    container.innerHTML = '<div class="empty-state">Failed to load similar users.</div>';
  }
}

/**
 * Handle reset votes button click
 */
async function handleResetVotes(): Promise<void> {
  const confirmed = confirm(
    'Are you sure you want to reset ALL your votes?\n\n' +
    'This will:\n' +
    '• Delete all your comparisons\n' +
    '• Reset all clip ratings\n' +
    '• Clear your voting history\n\n' +
    'This action cannot be undone!'
  );

  if (!confirmed) return;

  try {
    const response = await fetch('/api/auth/reset-votes', { method: 'POST' });
    if (!response.ok) throw new Error('Failed to reset votes');

    alert('Your votes have been reset. The page will reload.');
    window.location.reload();
  } catch (error) {
    console.error('Failed to reset votes:', error);
    alert('Failed to reset votes. Please try again.');
  }
}

/**
 * Handle delete account button click
 */
async function handleDeleteAccount(): Promise<void> {
  const confirmed = confirm(
    'Are you sure you want to DELETE your account?\n\n' +
    'This will permanently delete:\n' +
    '• Your profile\n' +
    '• All votes and ratings\n' +
    '• Saved clips and comments\n' +
    '• All other account data\n\n' +
    'This action cannot be undone!'
  );

  if (!confirmed) return;

  // Double confirmation for account deletion
  const doubleConfirmed = confirm(
    'This is your FINAL warning.\n\n' +
    'Your account will be permanently deleted.\n\n' +
    'Are you absolutely sure?'
  );

  if (!doubleConfirmed) return;

  try {
    const response = await fetch('/api/auth/delete-account', { method: 'POST' });
    if (!response.ok) throw new Error('Failed to delete account');

    alert('Your account has been deleted.');
    window.location.href = '/';
  } catch (error) {
    console.error('Failed to delete account:', error);
    alert('Failed to delete account. Please try again.');
  }
}

/**
 * Initialize page
 */
async function init(): Promise<void> {
  await checkAuth();

  const userId = getUserIdFromUrl();

  if (userId) {
    // Viewing someone else's profile
    await loadProfile(userId);
  } else if (currentUser) {
    // Viewing own profile
    const loadingEl = document.getElementById('loading-state');
    const contentEl = document.getElementById('profile-content');
    const profileImageEl = document.getElementById('profile-image') as HTMLImageElement | null;
    const profileNameEl = document.getElementById('profile-name');
    const profileStatsEl = document.getElementById('profile-stats');

    if (loadingEl) loadingEl.classList.add('hidden');
    if (contentEl) contentEl.classList.remove('hidden');

    if (profileImageEl) {
      profileImageEl.src = currentUser.profileImage || '/img/default-avatar.png';
    }
    if (profileNameEl) {
      profileNameEl.textContent = currentUser.displayName || 'Anonymous';
    }
    // Load own top clips and get coverage stats
    const response = await fetch(`/api/social/profile/${currentUser.id}`);
    if (response.ok) {
      const data: ProfileResponse = await response.json();
      renderTopClips(data.topClips);

      // Update stats with coverage info
      if (profileStatsEl) {
        const coverageText = data.profile.coveragePercent
          ? ` • ${data.profile.coveragePercent.toFixed(1)}% coverage`
          : '';
        profileStatsEl.textContent = `${formatNumber(data.profile.totalComparisons)} votes cast${coverageText}`;
        profileStatsEl.title = `${data.profile.uniquePairs || 0} unique pairs out of ${data.profile.totalPossiblePairs || 0} possible`;
      }
    } else if (profileStatsEl) {
      profileStatsEl.textContent = `${formatNumber(currentUser.totalComparisons)} votes cast`;
    }

    // Load similar users
    await loadSimilarUsers();

    // Show account settings section for admins only
    const ADMIN_USERS = ['digibugcat', 'arross'];
    if (currentUser.twitchUsername && ADMIN_USERS.includes(currentUser.twitchUsername)) {
      const accountSection = document.getElementById('account-settings-section');
      if (accountSection) accountSection.classList.remove('hidden');

      const resetBtn = document.getElementById('reset-votes-btn');
      const deleteBtn = document.getElementById('delete-account-btn');

      if (resetBtn) {
        resetBtn.addEventListener('click', handleResetVotes);
      }
      if (deleteBtn) {
        deleteBtn.addEventListener('click', handleDeleteAccount);
      }
    }
  } else {
    // Not logged in and no user ID
    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const errorMessageEl = document.getElementById('error-message');

    if (loadingEl) loadingEl.classList.add('hidden');
    if (errorEl) errorEl.classList.remove('hidden');
    if (errorMessageEl) errorMessageEl.textContent = 'Sign in to view your profile.';
  }
}

// Export functions for module usage
export {
  getUserIdFromUrl,
  loadProfile,
  renderTopClips,
  loadSimilarUsers,
  init,
};

// Type declarations for API response types (for other modules that may need them)
export type {
  TopClip,
  ProfileData,
  CompatibilityData,
  ProfileResponse,
  SimilarUser,
  SimilarUsersResponse,
};

// Make functions available globally for inline onclick handlers
declare global {
  interface Window {
    loadProfile: typeof loadProfile;
    loadSimilarUsers: typeof loadSimilarUsers;
    renderTopClips: typeof renderTopClips;
  }
}

// Assign to window for global access (needed for inline onclick handlers)
window.loadProfile = loadProfile;
window.loadSimilarUsers = loadSimilarUsers;
window.renderTopClips = renderTopClips;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

// Support SPA navigation - reinitialize on content swap
window.addEventListener('spa:pageload', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  if (detail.pathname === '/profile.html' || detail.pathname.startsWith('/profile')) {
    init();
  }
});

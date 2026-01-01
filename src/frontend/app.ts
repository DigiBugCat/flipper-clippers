/**
 * Clip Ranker - Shared Application Utilities
 * ==========================================
 */

// Import types (includes Window interface extension)
import './types';
import type { User } from './types';
import { initRouter } from './router';

// Global state
let currentUser: User | null = null;
// Expose to window immediately for other scripts (typed via Window interface in types.ts)
window.currentUser = currentUser;


/**
 * Check if user is authenticated
 */
async function checkAuth(): Promise<User | null> {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) {
      currentUser = null;
      window.currentUser = currentUser;
      return null;
    }
    const data = await response.json();
    currentUser = data.user;
    window.currentUser = currentUser;
    updateNavUser();

    return currentUser;
  } catch (error) {
    console.error('Auth check failed:', error);
    currentUser = null;
    window.currentUser = currentUser;
    return null;
  }
}

/**
 * Update navigation user display
 */
function updateNavUser(): void {
  const navUser = document.getElementById('nav-user');
  if (!navUser) return;

  if (currentUser) {
    navUser.innerHTML = `
      <a href="/profile.html" class="nav-user-name">${escapeHtml(currentUser.displayName)}</a>
      <button class="btn btn-ghost" onclick="logout()">Logout</button>
    `;
  } else {
    navUser.innerHTML = `
      <a href="/api/auth/login" class="btn btn-primary">Sign In with Twitch</a>
    `;
  }
}

/**
 * Log out the current user
 */
async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('Logout failed:', error);
  }
  currentUser = null;
  window.currentUser = currentUser;
  window.location.href = '/';
}

/**
 * Show toast notification
 */
function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast toast--${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

/**
 * Get the parent domain for Twitch embeds
 */
function getTwitchParent(): string {
  return window.location.hostname;
}

/**
 * Create a Twitch clip embed
 */
function createTwitchEmbed(slug: string, containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;

  const parent = getTwitchParent();
  container.innerHTML = `
    <iframe
      src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(parent)}&autoplay=false"
      allowfullscreen
      loading="lazy"
    ></iframe>
  `;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format large numbers with commas
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Format a date string (YYYY-MM-DD) to a readable format
 */
function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Initialize common functionality
 */
document.addEventListener('DOMContentLoaded', () => {
  // Set active nav link
  const currentPath = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach((link) => {
    if (link.getAttribute('href') === currentPath) {
      link.classList.add('active');
    }
  });

  // Initialize SPA-like router (handles mousedown navigation + prefetching + content swapping)
  initRouter();
});

/**
 * Get thumbnail URL from our cached proxy
 * This serves from Cloudflare KV edge cache for fast loading
 */
function getTwitchThumbnail(slug: string): string {
  return `/api/thumbnails/${encodeURIComponent(slug)}`;
}

/**
 * Handle thumbnail load error - show placeholder
 */
function handleThumbnailError(img: HTMLImageElement): void {
  img.style.display = 'none';
  // Show a play icon placeholder instead
  const placeholder = document.createElement('div');
  placeholder.className = 'thumbnail-placeholder';
  placeholder.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z"/>
    </svg>
  `;
  const parentNode = img.parentNode;
  if (parentNode) {
    parentNode.appendChild(placeholder);
  }
}

// External link icon SVG
const EXTERNAL_LINK_ICON: string = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
  <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
  <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
</svg>
`;

// Export functions for use in other modules and global access
export {
  currentUser,
  checkAuth,
  updateNavUser,
  logout,
  showToast,
  getTwitchParent,
  createTwitchEmbed,
  escapeHtml,
  formatNumber,
  formatDate,
  getTwitchThumbnail,
  handleThumbnailError,
  EXTERNAL_LINK_ICON
};

// Make functions available globally for inline onclick handlers
declare global {
  interface Window {
    logout: typeof logout;
    showToast: typeof showToast;
    createTwitchEmbed: typeof createTwitchEmbed;
    escapeHtml: typeof escapeHtml;
    formatNumber: typeof formatNumber;
    formatDate: typeof formatDate;
    getTwitchThumbnail: typeof getTwitchThumbnail;
    handleThumbnailError: typeof handleThumbnailError;
    checkAuth: typeof checkAuth;
    currentUser: User | null;
  }
}

// Assign to window for global access (needed for inline onclick handlers)
window.logout = logout;
window.showToast = showToast;
window.createTwitchEmbed = createTwitchEmbed;
window.escapeHtml = escapeHtml;
window.formatNumber = formatNumber;
window.formatDate = formatDate;
window.getTwitchThumbnail = getTwitchThumbnail;
window.handleThumbnailError = handleThumbnailError;
window.checkAuth = checkAuth;

/**
 * SPA-like Navigation Router
 * McMaster-Carr style prefetching and instant navigation
 * =====================================================
 */

// Cached page data
interface CachedPage {
  html: string;
  title: string;
  fetchedAt: number;
}

// Router state
interface RouterState {
  pathname: string;
  scrollY?: number;
}

// Cache configuration
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pageCache = new Map<string, CachedPage>();

// API data cache
interface CachedApiData {
  data: unknown;
  fetchedAt: number;
}
const apiDataCache = new Map<string, CachedApiData>();

// Page-to-API mapping for prefetching
const PAGE_API_MAP: Record<string, string[]> = {
  '/leaderboard': ['/api/leaderboard?page=1&limit=50&sort=elo&order=desc'],
  '/feed': ['/api/feed/global?limit=20&offset=0'],
  // Compare already has its own prefetch strategy
  // Saved requires auth, handled separately
};

// Prefetch tracking to avoid duplicate requests
const prefetchInProgress = new Set<string>();
const apiPrefetchInProgress = new Set<string>();

// Pages that can use SPA navigation (share common navbar layout)
const SWAPPABLE_PATHS = [
  '/',
  '/compare',
  '/compare.html',
  '/leaderboard',
  '/leaderboard.html',
  '/feed',
  '/feed.html',
  '/saved',
  '/saved.html',
  '/profile.html',
];

// State tracking
let routerEnabled = true;

/**
 * Check if a path supports SPA navigation
 */
function isSwappable(pathname: string): boolean {
  // Normalize path
  const normalized = pathname.replace(/\.html$/, '');
  return SWAPPABLE_PATHS.some(p => {
    const pNormalized = p.replace(/\.html$/, '');
    return normalized === pNormalized || pathname === p;
  });
}

/**
 * Check if URL is an internal link that should be handled
 */
function shouldHandleLink(href: string | null): boolean {
  if (!href) return false;
  if (href.startsWith('http')) return false;
  if (href.startsWith('#')) return false;
  if (href.startsWith('/api/')) return false;
  if (href.startsWith('javascript:')) return false;
  return true;
}

/**
 * Extract main content and title from HTML string
 */
function extractContent(html: string): { content: string; title: string } | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const container = doc.querySelector('.container');
    const titleEl = doc.querySelector('title');

    if (!container) return null;

    return {
      content: container.innerHTML,
      title: titleEl?.textContent || document.title,
    };
  } catch {
    return null;
  }
}

/**
 * Prefetch a page in the background
 */
async function prefetchPage(url: string): Promise<void> {
  const pathname = new URL(url, window.location.origin).pathname;

  // Skip if not swappable
  if (!isSwappable(pathname)) return;

  // Check cache - if fresh, skip
  const cached = pageCache.get(pathname);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return;
  }

  // Skip if already fetching
  if (prefetchInProgress.has(pathname)) return;
  prefetchInProgress.add(pathname);

  try {
    const response = await fetch(url, {
      headers: { 'X-Prefetch': '1' },
      credentials: 'same-origin',
    });

    if (!response.ok) return;

    const html = await response.text();
    const extracted = extractContent(html);

    if (extracted) {
      pageCache.set(pathname, {
        html: extracted.content,
        title: extracted.title,
        fetchedAt: Date.now(),
      });
    }
  } catch (error) {
    console.debug('[Router] Prefetch failed:', url, error);
  } finally {
    prefetchInProgress.delete(pathname);
  }
}

/**
 * Prefetch API data for a page
 */
async function prefetchApiData(pathname: string): Promise<void> {
  // Normalize pathname
  const normalized = pathname.replace(/\.html$/, '');
  const apis = PAGE_API_MAP[normalized];
  if (!apis) return;

  for (const apiUrl of apis) {
    // Check cache freshness
    const cached = apiDataCache.get(apiUrl);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      continue;
    }

    // Skip if already fetching
    if (apiPrefetchInProgress.has(apiUrl)) continue;
    apiPrefetchInProgress.add(apiUrl);

    try {
      const response = await fetch(apiUrl, {
        headers: { 'X-Prefetch': '1' },
        credentials: 'same-origin',
      });

      if (response.ok) {
        const data = await response.json();
        apiDataCache.set(apiUrl, { data, fetchedAt: Date.now() });
        console.debug(`[Router] API prefetch cached: ${apiUrl}`);
      }
    } catch (error) {
      console.debug(`[Router] API prefetch failed: ${apiUrl}`, error);
    } finally {
      apiPrefetchInProgress.delete(apiUrl);
    }
  }
}

/**
 * Get cached API data (for page scripts to use)
 */
function getCachedApiData<T>(apiUrl: string): T | null {
  const cached = apiDataCache.get(apiUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data as T;
  }
  return null;
}

/**
 * Update navbar active state
 */
function updateActiveNavLink(pathname: string): void {
  const normalized = pathname.replace(/\.html$/, '');

  document.querySelectorAll('.nav-link').forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    const hrefNormalized = href.replace(/\.html$/, '');
    const isActive = normalized === hrefNormalized ||
                     (normalized === '' && hrefNormalized === '/') ||
                     (normalized === '/' && hrefNormalized === '/');

    link.classList.toggle('active', isActive);
  });
}

/**
 * Dispatch custom event for page-specific initialization
 */
function dispatchPageLoad(pathname: string): void {
  window.dispatchEvent(new CustomEvent('spa:pageload', {
    detail: { pathname }
  }));
}

/**
 * Navigate to a page using content swap
 */
async function navigateTo(url: string, pushState = true): Promise<boolean> {
  if (!routerEnabled) {
    window.location.href = url;
    return false;
  }

  const urlObj = new URL(url, window.location.origin);
  const pathname = urlObj.pathname;

  // If not swappable, do regular navigation
  if (!isSwappable(pathname)) {
    window.location.href = url;
    return false;
  }

  // Save current scroll position
  const currentState: RouterState = {
    pathname: window.location.pathname,
    scrollY: window.scrollY,
  };
  history.replaceState(currentState, '');

  // Try to get from cache
  let cached = pageCache.get(pathname);

  // If not cached or stale, fetch fresh
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        window.location.href = url;
        return false;
      }

      const html = await response.text();
      const extracted = extractContent(html);

      if (!extracted) {
        window.location.href = url;
        return false;
      }

      cached = {
        html: extracted.content,
        title: extracted.title,
        fetchedAt: Date.now(),
      };
      pageCache.set(pathname, cached);
    } catch {
      window.location.href = url;
      return false;
    }
  }

  // Swap content
  const container = document.querySelector('.container');
  if (!container || !cached) {
    window.location.href = url;
    return false;
  }

  // Update page content
  container.innerHTML = cached.html;
  document.title = cached.title;

  // Update history
  if (pushState) {
    const newState: RouterState = { pathname };
    history.pushState(newState, '', url);
  }

  // Scroll to top
  window.scrollTo(0, 0);

  // Update active nav link
  updateActiveNavLink(pathname);

  // Dispatch event for page initialization
  dispatchPageLoad(pathname);

  return true;
}

/**
 * Handle hover for prefetching
 */
function handleHover(e: MouseEvent): void {
  const target = e.target as Element;
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (!link) return;

  const href = link.getAttribute('href');
  if (!shouldHandleLink(href)) return;

  // Get pathname for API prefetch
  const pathname = new URL(href!, window.location.origin).pathname;

  // Prefetch HTML and API data in parallel (fire and forget)
  prefetchPage(href!);
  prefetchApiData(pathname);
}

/**
 * Handle mousedown for instant navigation
 */
function handleMousedown(e: MouseEvent): void {
  const target = e.target as Element;
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (!link) return;

  const href = link.getAttribute('href');
  if (!shouldHandleLink(href)) return;

  // Skip if modifier keys pressed
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

  // Skip links with target="_blank"
  if (link.target === '_blank') return;

  // Try SPA navigation
  e.preventDefault();
  navigateTo(href!);
}

/**
 * Handle browser back/forward
 */
function handlePopstate(e: PopStateEvent): void {
  const state = e.state as RouterState | null;
  if (!state?.pathname) {
    // Fallback - reload the page
    window.location.reload();
    return;
  }

  navigateTo(window.location.href, false).then(success => {
    if (success && state.scrollY !== undefined) {
      // Restore scroll position after content loads
      requestAnimationFrame(() => {
        window.scrollTo(0, state.scrollY!);
      });
    }
  });
}

/**
 * Disable SPA router (useful for pages that need special handling)
 */
function disableRouter(): void {
  routerEnabled = false;
}

/**
 * Enable SPA router
 */
function enableRouter(): void {
  routerEnabled = true;
}

/**
 * Clear the page cache
 */
function clearCache(): void {
  pageCache.clear();
}

/**
 * Initialize the SPA router
 */
function initRouter(): void {
  // Handle hover for prefetching
  document.addEventListener('mouseover', handleHover, { passive: true });

  // Handle mousedown for instant navigation (replaces the simple one in app.ts)
  // Note: This adds SPA behavior on top of mousedown navigation
  document.addEventListener('mousedown', handleMousedown);

  // Handle browser back/forward
  window.addEventListener('popstate', handlePopstate);

  // Store initial state
  const initialState: RouterState = { pathname: window.location.pathname };
  history.replaceState(initialState, '');

  console.debug('[Router] SPA router initialized');
}

// Extend Window interface for global access
declare global {
  interface Window {
    spaRouter?: {
      navigateTo: typeof navigateTo;
      prefetchPage: typeof prefetchPage;
      clearCache: typeof clearCache;
      disableRouter: typeof disableRouter;
      enableRouter: typeof enableRouter;
      getCachedApiData: typeof getCachedApiData;
    };
    getCachedApiData: typeof getCachedApiData;
  }
}

// Expose router API on window for debugging and external use
window.spaRouter = {
  navigateTo,
  prefetchPage,
  clearCache,
  disableRouter,
  enableRouter,
  getCachedApiData,
};

// Also expose getCachedApiData directly on window for easy access
window.getCachedApiData = getCachedApiData;

export {
  initRouter,
  navigateTo,
  prefetchPage,
  clearCache,
  disableRouter,
  enableRouter,
  getCachedApiData,
  pageCache,
  apiDataCache,
};

"use strict";
(() => {
  // src/frontend/router.ts
  var CACHE_TTL_MS = 5 * 60 * 1e3;
  var pageCache = /* @__PURE__ */ new Map();
  var apiDataCache = /* @__PURE__ */ new Map();
  var PAGE_API_MAP = {
    "/leaderboard": ["/api/leaderboard?page=1&limit=50&sort=elo&order=desc"],
    "/feed": ["/api/feed/global?limit=20&offset=0"]
    // Compare already has its own prefetch strategy
    // Saved requires auth, handled separately
  };
  var prefetchInProgress = /* @__PURE__ */ new Set();
  var apiPrefetchInProgress = /* @__PURE__ */ new Set();
  var SWAPPABLE_PATHS = [
    "/",
    "/compare",
    "/compare.html",
    "/leaderboard",
    "/leaderboard.html",
    "/feed",
    "/feed.html",
    "/saved",
    "/saved.html",
    "/profile.html"
  ];
  var routerEnabled = true;
  function isSwappable(pathname) {
    const normalized = pathname.replace(/\.html$/, "");
    return SWAPPABLE_PATHS.some((p) => {
      const pNormalized = p.replace(/\.html$/, "");
      return normalized === pNormalized || pathname === p;
    });
  }
  function shouldHandleLink(href) {
    if (!href) return false;
    if (href.startsWith("http")) return false;
    if (href.startsWith("#")) return false;
    if (href.startsWith("/api/")) return false;
    if (href.startsWith("javascript:")) return false;
    return true;
  }
  function extractContent(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const container = doc.querySelector(".container");
      const titleEl = doc.querySelector("title");
      if (!container) return null;
      return {
        content: container.innerHTML,
        title: titleEl?.textContent || document.title
      };
    } catch {
      return null;
    }
  }
  async function prefetchPage(url) {
    const pathname = new URL(url, window.location.origin).pathname;
    if (!isSwappable(pathname)) return;
    const cached = pageCache.get(pathname);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return;
    }
    if (prefetchInProgress.has(pathname)) return;
    prefetchInProgress.add(pathname);
    try {
      const response = await fetch(url, {
        headers: { "X-Prefetch": "1" },
        credentials: "same-origin"
      });
      if (!response.ok) return;
      const html = await response.text();
      const extracted = extractContent(html);
      if (extracted) {
        pageCache.set(pathname, {
          html: extracted.content,
          title: extracted.title,
          fetchedAt: Date.now()
        });
      }
    } catch (error) {
      console.debug("[Router] Prefetch failed:", url, error);
    } finally {
      prefetchInProgress.delete(pathname);
    }
  }
  async function prefetchApiData(pathname) {
    const normalized = pathname.replace(/\.html$/, "");
    const apis = PAGE_API_MAP[normalized];
    if (!apis) return;
    for (const apiUrl of apis) {
      const cached = apiDataCache.get(apiUrl);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        continue;
      }
      if (apiPrefetchInProgress.has(apiUrl)) continue;
      apiPrefetchInProgress.add(apiUrl);
      try {
        const response = await fetch(apiUrl, {
          headers: { "X-Prefetch": "1" },
          credentials: "same-origin"
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
  function getCachedApiData(apiUrl) {
    const cached = apiDataCache.get(apiUrl);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    return null;
  }
  function updateActiveNavLink(pathname) {
    const normalized = pathname.replace(/\.html$/, "");
    document.querySelectorAll(".nav-link").forEach((link) => {
      const href = link.getAttribute("href");
      if (!href) return;
      const hrefNormalized = href.replace(/\.html$/, "");
      const isActive = normalized === hrefNormalized || normalized === "" && hrefNormalized === "/" || normalized === "/" && hrefNormalized === "/";
      link.classList.toggle("active", isActive);
    });
  }
  function dispatchPageLoad(pathname) {
    window.dispatchEvent(new CustomEvent("spa:pageload", {
      detail: { pathname }
    }));
  }
  async function navigateTo(url, pushState = true) {
    if (!routerEnabled) {
      window.location.href = url;
      return false;
    }
    const urlObj = new URL(url, window.location.origin);
    const pathname = urlObj.pathname;
    if (!isSwappable(pathname)) {
      window.location.href = url;
      return false;
    }
    const currentState = {
      pathname: window.location.pathname,
      scrollY: window.scrollY
    };
    history.replaceState(currentState, "");
    let cached = pageCache.get(pathname);
    if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
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
          fetchedAt: Date.now()
        };
        pageCache.set(pathname, cached);
      } catch {
        window.location.href = url;
        return false;
      }
    }
    const container = document.querySelector(".container");
    if (!container || !cached) {
      window.location.href = url;
      return false;
    }
    container.innerHTML = cached.html;
    document.title = cached.title;
    if (pushState) {
      const newState = { pathname };
      history.pushState(newState, "", url);
    }
    window.scrollTo(0, 0);
    updateActiveNavLink(pathname);
    dispatchPageLoad(pathname);
    return true;
  }
  function handleHover(e) {
    const target = e.target;
    const link = target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!shouldHandleLink(href)) return;
    const pathname = new URL(href, window.location.origin).pathname;
    prefetchPage(href);
    prefetchApiData(pathname);
  }
  function handleMousedown(e) {
    const target = e.target;
    const link = target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!shouldHandleLink(href)) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (link.target === "_blank") return;
    e.preventDefault();
    navigateTo(href);
  }
  function handlePopstate(e) {
    const state = e.state;
    if (!state?.pathname) {
      window.location.reload();
      return;
    }
    navigateTo(window.location.href, false).then((success) => {
      if (success && state.scrollY !== void 0) {
        requestAnimationFrame(() => {
          window.scrollTo(0, state.scrollY);
        });
      }
    });
  }
  function disableRouter() {
    routerEnabled = false;
  }
  function enableRouter() {
    routerEnabled = true;
  }
  function clearCache() {
    pageCache.clear();
  }
  function initRouter() {
    document.addEventListener("mouseover", handleHover, { passive: true });
    document.addEventListener("mousedown", handleMousedown);
    window.addEventListener("popstate", handlePopstate);
    const initialState = { pathname: window.location.pathname };
    history.replaceState(initialState, "");
    console.debug("[Router] SPA router initialized");
  }
  window.spaRouter = {
    navigateTo,
    prefetchPage,
    clearCache,
    disableRouter,
    enableRouter,
    getCachedApiData
  };
  window.getCachedApiData = getCachedApiData;

  // src/frontend/app.ts
  var currentUser = null;
  window.currentUser = currentUser;
  async function checkAuth() {
    try {
      const response = await fetch("/api/auth/me");
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
      console.error("Auth check failed:", error);
      currentUser = null;
      window.currentUser = currentUser;
      return null;
    }
  }
  function updateNavUser() {
    const navUser = document.getElementById("nav-user");
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
  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.error("Logout failed:", error);
    }
    currentUser = null;
    window.currentUser = currentUser;
    window.location.href = "/";
  }
  function showToast(message, type = "info") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast toast--${type} show`;
    setTimeout(() => {
      toast.classList.remove("show");
    }, 3e3);
  }
  function getTwitchParent() {
    return window.location.hostname;
  }
  function createTwitchEmbed(slug, containerId) {
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
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
  function formatNumber(num) {
    return num.toLocaleString();
  }
  function formatDate(dateStr) {
    if (!dateStr) return "";
    const date = /* @__PURE__ */ new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
  document.addEventListener("DOMContentLoaded", () => {
    const currentPath = window.location.pathname;
    document.querySelectorAll(".nav-link").forEach((link) => {
      if (link.getAttribute("href") === currentPath) {
        link.classList.add("active");
      }
    });
    initRouter();
  });
  function getTwitchThumbnail(slug) {
    return `/api/thumbnails/${encodeURIComponent(slug)}`;
  }
  function handleThumbnailError(img) {
    img.style.display = "none";
    const placeholder = document.createElement("div");
    placeholder.className = "thumbnail-placeholder";
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
  window.logout = logout;
  window.showToast = showToast;
  window.createTwitchEmbed = createTwitchEmbed;
  window.escapeHtml = escapeHtml;
  window.formatNumber = formatNumber;
  window.formatDate = formatDate;
  window.getTwitchThumbnail = getTwitchThumbnail;
  window.handleThumbnailError = handleThumbnailError;
  window.checkAuth = checkAuth;

  // src/frontend/feed.ts
  var currentTab = "global";
  var globalOffset = 0;
  var myOffset = 0;
  var PAGE_SIZE = 20;
  var ACTIVITY_ICONS = {
    vote: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M1 8.25a1.25 1.25 0 112.5 0v7.5a1.25 1.25 0 11-2.5 0v-7.5zM11 3V1.7c0-.268.14-.526.395-.607A2 2 0 0114 3c0 .995-.182 1.948-.514 2.826-.204.54.166 1.174.744 1.174h2.52c1.243 0 2.261 1.01 2.146 2.247a23.864 23.864 0 01-1.341 5.974C17.153 16.323 16.072 17 14.9 17h-3.192a3 3 0 01-1.341-.317l-2.734-1.366A3 3 0 006.292 15H5V8h1.292a3 3 0 002.042-.793l1.932-1.78A3 3 0 0011 3z"/></svg>',
    super_like: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clip-rule="evenodd"/></svg>',
    comment: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.43 2.524A41.29 41.29 0 0110 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 01-5.183.501l-2.926 2.927A.75.75 0 017 16.06v-2.867c-1.018-.09-2.025-.232-3.013-.424-1.437-.231-2.43-1.49-2.43-2.902V5.426c0-1.413.993-2.67 2.43-2.902z" clip-rule="evenodd"/></svg>',
    save: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2c-1.716 0-3.408.106-5.07.31C3.806 2.45 3 3.414 3 4.517V17.25a.75.75 0 001.075.676L10 15.082l5.925 2.844A.75.75 0 0017 17.25V4.517c0-1.103-.806-2.068-1.93-2.207A41.403 41.403 0 0010 2z" clip-rule="evenodd"/></svg>'
  };
  var ACTIVITY_LABELS = {
    vote: "voted for",
    super_like: "super liked",
    comment: "commented on",
    save: "saved"
  };
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    const tabBtn = document.getElementById(`tab-${tab}`);
    if (tabBtn) {
      tabBtn.classList.add("active");
    }
    const globalSection = document.getElementById("global-section");
    const trendingSection = document.getElementById("trending-section");
    const mySection = document.getElementById("my-section");
    if (globalSection) globalSection.classList.toggle("hidden", tab !== "global");
    if (trendingSection) trendingSection.classList.toggle("hidden", tab !== "trending");
    if (mySection) mySection.classList.toggle("hidden", tab !== "my");
    if (tab === "global") {
      loadGlobalActivity();
    } else if (tab === "trending") {
      loadTrending();
    } else if (tab === "my") {
      loadMyActivity();
    }
  }
  function formatRelativeTime(dateStr) {
    const date = new Date(dateStr);
    const now = /* @__PURE__ */ new Date();
    const diff = (now.getTime() - date.getTime()) / 1e3;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return date.toLocaleDateString();
  }
  function renderActivityItem(activity, showUser = true) {
    const icon = ACTIVITY_ICONS[activity.type] || "";
    const label = ACTIVITY_LABELS[activity.type] || activity.type;
    const userHtml = showUser && activity.user ? `
    <img class="activity-avatar" src="${escapeHtml(activity.user.profileImage || "/img/default-avatar.png")}" alt="" onerror="this.style.display='none'">
    <span class="activity-user">${escapeHtml(activity.user.displayName || "Anonymous")}</span>
  ` : "";
    const clipLink = activity.clipSlug ? `<a href="https://clips.twitch.tv/${encodeURIComponent(activity.clipSlug)}" target="_blank" rel="noopener" class="activity-clip-link">${escapeHtml(activity.clipTitle || "Untitled Clip")}</a>` : `<span class="activity-clip-title">${escapeHtml(activity.clipTitle || "Untitled Clip")}</span>`;
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
  function renderGlobalActivity(data, container, loadMoreBtn) {
    container.innerHTML = "";
    if (data.activities.length === 0) {
      container.innerHTML = '<div class="empty-state">No activity yet. Be the first to vote!</div>';
      if (loadMoreBtn) loadMoreBtn.classList.add("hidden");
      return;
    }
    data.activities.forEach((activity) => {
      container.insertAdjacentHTML("beforeend", renderActivityItem(activity, true));
    });
    globalOffset = data.activities.length;
    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle("hidden", data.activities.length < PAGE_SIZE);
    }
  }
  async function loadGlobalActivity(append = false) {
    const container = document.getElementById("global-activity");
    const loadMoreBtn = document.getElementById("load-more-global");
    if (!container) return;
    if (!append) {
      globalOffset = 0;
    }
    const apiUrl = `/api/feed/global?limit=${PAGE_SIZE}&offset=${globalOffset}`;
    if (!append && globalOffset === 0 && window.getCachedApiData) {
      const cached = window.getCachedApiData(apiUrl);
      if (cached) {
        console.debug("[Feed] Using prefetched data");
        renderGlobalActivity(cached, container, loadMoreBtn);
        return;
      }
    }
    if (!append) {
      container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error("Failed to load activity");
      const data = await response.json();
      if (!append) {
        container.innerHTML = "";
      }
      if (data.activities.length === 0 && !append) {
        container.innerHTML = '<div class="empty-state">No activity yet. Be the first to vote!</div>';
        if (loadMoreBtn) loadMoreBtn.classList.add("hidden");
        return;
      }
      data.activities.forEach((activity) => {
        container.insertAdjacentHTML("beforeend", renderActivityItem(activity, true));
      });
      globalOffset += data.activities.length;
      if (loadMoreBtn) {
        loadMoreBtn.classList.toggle("hidden", data.activities.length < PAGE_SIZE);
      }
    } catch (error) {
      console.error("Load global activity failed:", error);
      if (!append) {
        container.innerHTML = '<div class="empty-state">Failed to load activity. Please try again.</div>';
      }
    }
  }
  function loadMoreGlobal() {
    loadGlobalActivity(true);
  }
  async function loadTrending() {
    const container = document.getElementById("trending-list");
    const periodSelect = document.getElementById("period-select");
    if (!container) return;
    const period = periodSelect?.value || "week";
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const response = await fetch(`/api/feed/trending?period=${period}&limit=20`);
      if (!response.ok) throw new Error("Failed to load trending");
      const data = await response.json();
      if (data.clips.length === 0) {
        container.innerHTML = '<div class="empty-state">No trending clips in this period.</div>';
        return;
      }
      container.innerHTML = data.clips.map((clip, index) => `
      <div class="trending-item">
        <span class="trending-rank">#${index + 1}</span>
        <img class="trending-thumbnail" src="${getTwitchThumbnail(clip.twitchSlug)}" alt="" onerror="handleThumbnailError(this)">
        <div class="trending-info">
          <a href="https://clips.twitch.tv/${encodeURIComponent(clip.twitchSlug)}" target="_blank" rel="noopener" class="trending-title">
            ${escapeHtml(clip.title || "Untitled Clip")}
          </a>
          <div class="trending-stats">
            <span class="stat">${clip.voteCount} votes</span>
            <span class="stat">${clip.superLikeCount} super likes</span>
          </div>
        </div>
      </div>
    `).join("");
    } catch (error) {
      console.error("Load trending failed:", error);
      container.innerHTML = '<div class="empty-state">Failed to load trending. Please try again.</div>';
    }
  }
  async function loadMyActivity(append = false) {
    const container = document.getElementById("my-activity");
    const authPrompt = document.getElementById("my-activity-auth");
    const loadMoreBtn = document.getElementById("load-more-my");
    if (!container) return;
    const currentUser2 = window.currentUser;
    if (!currentUser2) {
      container.classList.add("hidden");
      if (authPrompt) authPrompt.classList.remove("hidden");
      if (loadMoreBtn) loadMoreBtn.classList.add("hidden");
      return;
    }
    container.classList.remove("hidden");
    if (authPrompt) authPrompt.classList.add("hidden");
    if (!append) {
      myOffset = 0;
      container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }
    try {
      const response = await fetch(`/api/feed/me?limit=${PAGE_SIZE}&offset=${myOffset}`);
      if (!response.ok) throw new Error("Failed to load activity");
      const data = await response.json();
      if (!append) {
        container.innerHTML = "";
      }
      if (data.activities.length === 0 && !append) {
        container.innerHTML = '<div class="empty-state">No activity yet. <a href="/compare">Start comparing</a> to build your history!</div>';
        if (loadMoreBtn) loadMoreBtn.classList.add("hidden");
        return;
      }
      data.activities.forEach((activity) => {
        container.insertAdjacentHTML("beforeend", renderActivityItem(activity, false));
      });
      myOffset += data.activities.length;
      if (loadMoreBtn) {
        loadMoreBtn.classList.toggle("hidden", data.activities.length < PAGE_SIZE);
      }
    } catch (error) {
      console.error("Load my activity failed:", error);
      if (!append) {
        container.innerHTML = '<div class="empty-state">Failed to load activity. Please try again.</div>';
      }
    }
  }
  function loadMoreMy() {
    loadMyActivity(true);
  }
  function setupEventListeners() {
    document.getElementById("tab-global")?.addEventListener("click", () => switchTab("global"));
    document.getElementById("tab-trending")?.addEventListener("click", () => switchTab("trending"));
    document.getElementById("tab-my")?.addEventListener("click", () => switchTab("my"));
    document.getElementById("load-more-global")?.addEventListener("click", loadMoreGlobal);
    document.getElementById("load-more-my")?.addEventListener("click", loadMoreMy);
    document.getElementById("period-select")?.addEventListener("change", loadTrending);
  }
  async function init() {
    setupEventListeners();
    await checkAuth();
    loadGlobalActivity();
  }
  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("spa:pageload", (e) => {
    const detail = e.detail;
    if (detail.pathname === "/feed" || detail.pathname === "/feed.html") {
      currentTab = "global";
      globalOffset = 0;
      myOffset = 0;
      init();
    }
  });
})();
//# sourceMappingURL=feed.js.map

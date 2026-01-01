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
  var EXTERNAL_LINK_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
  <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
  <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
</svg>
`;
  window.logout = logout;
  window.showToast = showToast;
  window.createTwitchEmbed = createTwitchEmbed;
  window.escapeHtml = escapeHtml;
  window.formatNumber = formatNumber;
  window.formatDate = formatDate;
  window.getTwitchThumbnail = getTwitchThumbnail;
  window.handleThumbnailError = handleThumbnailError;
  window.checkAuth = checkAuth;
})();
//# sourceMappingURL=app.js.map

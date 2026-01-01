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

  // src/frontend/social.ts
  function getUserIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return parseInt(params.get("id") || "0", 10);
  }
  async function loadProfile(userId) {
    const loadingEl = document.getElementById("loading-state");
    const errorEl = document.getElementById("error-state");
    const contentEl = document.getElementById("profile-content");
    try {
      const response = await fetch(`/api/social/profile/${userId}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Profile not found");
      }
      const data = await response.json();
      const profileImageEl = document.getElementById("profile-image");
      const profileNameEl = document.getElementById("profile-name");
      const profileStatsEl = document.getElementById("profile-stats");
      if (profileImageEl) {
        profileImageEl.src = data.profile.profileImage || "/img/default-avatar.png";
      }
      if (profileNameEl) {
        profileNameEl.textContent = data.profile.displayName || "Anonymous";
      }
      if (profileStatsEl) {
        profileStatsEl.textContent = `${formatNumber(data.profile.totalComparisons)} votes cast`;
      }
      if (data.compatibility) {
        const badge = document.getElementById("compatibility-badge");
        if (badge) {
          const scoreEl = badge.querySelector(".compat-score");
          if (scoreEl) {
            scoreEl.textContent = `${data.compatibility.score}%`;
          }
          badge.classList.remove("hidden");
        }
      }
      renderTopClips(data.topClips);
      if (loadingEl) loadingEl.classList.add("hidden");
      if (contentEl) contentEl.classList.remove("hidden");
    } catch (error) {
      console.error("Failed to load profile:", error);
      const errorMessageEl = document.getElementById("error-message");
      if (errorMessageEl && error instanceof Error) {
        errorMessageEl.textContent = error.message;
      }
      if (loadingEl) loadingEl.classList.add("hidden");
      if (errorEl) errorEl.classList.remove("hidden");
    }
  }
  function renderTopClips(clips) {
    const container = document.getElementById("top-clips-list");
    if (!container) return;
    if (!clips || clips.length === 0) {
      container.innerHTML = '<div class="empty-state">No clips rated yet.</div>';
      return;
    }
    container.innerHTML = clips.map((clip, index) => `
    <div class="top-clip-item">
      <span class="top-clip-rank">#${index + 1}</span>
      <img class="top-clip-thumbnail" src="${getTwitchThumbnail(clip.twitchSlug)}" alt="" onerror="handleThumbnailError(this)">
      <div class="top-clip-info">
        <a href="https://clips.twitch.tv/${encodeURIComponent(clip.twitchSlug)}" target="_blank" rel="noopener" class="top-clip-title">
          ${escapeHtml(clip.title || "Untitled Clip")}
        </a>
        <span class="top-clip-elo">${clip.userElo} ELO</span>
      </div>
    </div>
  `).join("");
  }
  async function loadSimilarUsers() {
    const section = document.getElementById("similar-users-section");
    const container = document.getElementById("similar-users-list");
    if (!section || !container) return;
    section.classList.remove("hidden");
    try {
      const response = await fetch("/api/social/similar?limit=10");
      if (!response.ok) throw new Error("Failed to load");
      const data = await response.json();
      if (data.users.length === 0) {
        container.innerHTML = '<div class="empty-state">No similar users found yet. Keep voting to find people with similar taste!</div>';
        return;
      }
      container.innerHTML = data.users.map((user) => `
      <a href="/profile?id=${user.userId}" class="similar-user-card">
        <img class="similar-user-avatar" src="${escapeHtml(user.profileImage || "/img/default-avatar.png")}" alt="" onerror="this.style.display='none'">
        <div class="similar-user-info">
          <span class="similar-user-name">${escapeHtml(user.displayName || "Anonymous")}</span>
          <span class="similar-user-compat">${user.compatibilityScore}% match (${user.sharedClips} clips)</span>
        </div>
      </a>
    `).join("");
    } catch (error) {
      console.error("Failed to load similar users:", error);
      container.innerHTML = '<div class="empty-state">Failed to load similar users.</div>';
    }
  }
  async function handleResetVotes() {
    const confirmed = confirm(
      "Are you sure you want to reset ALL your votes?\n\nThis will:\n\u2022 Delete all your comparisons\n\u2022 Reset all clip ratings\n\u2022 Clear your voting history\n\nThis action cannot be undone!"
    );
    if (!confirmed) return;
    try {
      const response = await fetch("/api/auth/reset-votes", { method: "POST" });
      if (!response.ok) throw new Error("Failed to reset votes");
      alert("Your votes have been reset. The page will reload.");
      window.location.reload();
    } catch (error) {
      console.error("Failed to reset votes:", error);
      alert("Failed to reset votes. Please try again.");
    }
  }
  async function handleDeleteAccount() {
    const confirmed = confirm(
      "Are you sure you want to DELETE your account?\n\nThis will permanently delete:\n\u2022 Your profile\n\u2022 All votes and ratings\n\u2022 Saved clips and comments\n\u2022 All other account data\n\nThis action cannot be undone!"
    );
    if (!confirmed) return;
    const doubleConfirmed = confirm(
      "This is your FINAL warning.\n\nYour account will be permanently deleted.\n\nAre you absolutely sure?"
    );
    if (!doubleConfirmed) return;
    try {
      const response = await fetch("/api/auth/delete-account", { method: "POST" });
      if (!response.ok) throw new Error("Failed to delete account");
      alert("Your account has been deleted.");
      window.location.href = "/";
    } catch (error) {
      console.error("Failed to delete account:", error);
      alert("Failed to delete account. Please try again.");
    }
  }
  async function init() {
    await checkAuth();
    const userId = getUserIdFromUrl();
    if (userId) {
      await loadProfile(userId);
    } else if (currentUser) {
      const loadingEl = document.getElementById("loading-state");
      const contentEl = document.getElementById("profile-content");
      const profileImageEl = document.getElementById("profile-image");
      const profileNameEl = document.getElementById("profile-name");
      const profileStatsEl = document.getElementById("profile-stats");
      if (loadingEl) loadingEl.classList.add("hidden");
      if (contentEl) contentEl.classList.remove("hidden");
      if (profileImageEl) {
        profileImageEl.src = currentUser.profileImage || "/img/default-avatar.png";
      }
      if (profileNameEl) {
        profileNameEl.textContent = currentUser.displayName || "Anonymous";
      }
      if (profileStatsEl) {
        profileStatsEl.textContent = `${formatNumber(currentUser.totalComparisons)} votes cast`;
      }
      const response = await fetch(`/api/social/profile/${currentUser.id}`);
      if (response.ok) {
        const data = await response.json();
        renderTopClips(data.topClips);
      }
      await loadSimilarUsers();
      const ADMIN_USERS = ["digibugcat", "arross"];
      if (currentUser.twitchUsername && ADMIN_USERS.includes(currentUser.twitchUsername)) {
        const accountSection = document.getElementById("account-settings-section");
        if (accountSection) accountSection.classList.remove("hidden");
        const resetBtn = document.getElementById("reset-votes-btn");
        const deleteBtn = document.getElementById("delete-account-btn");
        if (resetBtn) {
          resetBtn.addEventListener("click", handleResetVotes);
        }
        if (deleteBtn) {
          deleteBtn.addEventListener("click", handleDeleteAccount);
        }
      }
    } else {
      const loadingEl = document.getElementById("loading-state");
      const errorEl = document.getElementById("error-state");
      const errorMessageEl = document.getElementById("error-message");
      if (loadingEl) loadingEl.classList.add("hidden");
      if (errorEl) errorEl.classList.remove("hidden");
      if (errorMessageEl) errorMessageEl.textContent = "Sign in to view your profile.";
    }
  }
  window.loadProfile = loadProfile;
  window.loadSimilarUsers = loadSimilarUsers;
  window.renderTopClips = renderTopClips;
  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("spa:pageload", (e) => {
    const detail = e.detail;
    if (detail.pathname === "/profile.html" || detail.pathname.startsWith("/profile")) {
      init();
    }
  });
})();
//# sourceMappingURL=social.js.map

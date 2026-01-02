"use strict";
(() => {
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

  // src/frontend/leaderboard.ts
  var currentTab = "global";
  var currentSort = "elo";
  var currentOrder = "desc";
  var currentPage = 1;
  var totalPages = 1;
  var personalRankings = [];
  var draggedItem = null;
  var personalSort = "elo";
  var historyModalClipId = null;
  function getCurrentUser() {
    return window.currentUser || null;
  }
  function initFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    currentTab = tabParam === "me" || tabParam === "voters" ? tabParam : "global";
    const sortParam = params.get("sort");
    currentSort = ["elo", "matches", "winrate", "superlikes"].includes(sortParam) ? sortParam : "elo";
    const orderParam = params.get("order");
    currentOrder = orderParam === "asc" ? "asc" : "desc";
    const pageParam = params.get("page");
    currentPage = parseInt(pageParam || "1", 10);
    if (isNaN(currentPage) || currentPage < 1) currentPage = 1;
    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) sortSelect.value = currentSort;
    const orderIcon = document.getElementById("order-icon");
    if (orderIcon) orderIcon.textContent = currentOrder === "desc" ? "\u2193" : "\u2191";
  }
  function updateUrl() {
    const params = new URLSearchParams();
    if (currentTab !== "global") params.set("tab", currentTab);
    if (currentSort !== "elo") params.set("sort", currentSort);
    if (currentOrder !== "desc") params.set("order", currentOrder);
    if (currentPage !== 1) params.set("page", String(currentPage));
    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    history.pushState({}, "", newUrl);
  }
  function handleSortChange() {
    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) {
      currentSort = sortSelect.value;
    }
    currentPage = 1;
    updateUrl();
    loadGlobalRankings();
  }
  function toggleSortOrder() {
    currentOrder = currentOrder === "desc" ? "asc" : "desc";
    const orderIcon = document.getElementById("order-icon");
    if (orderIcon) orderIcon.textContent = currentOrder === "desc" ? "\u2193" : "\u2191";
    currentPage = 1;
    updateUrl();
    loadGlobalRankings();
  }
  function goToPage(page) {
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    updateUrl();
    loadGlobalRankings();
    document.querySelector(".table-container")?.scrollIntoView({ behavior: "smooth" });
  }
  async function switchTab(tab) {
    currentTab = tab === "personal" ? "me" : tab === "voters" ? "voters" : "global";
    currentPage = 1;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.remove("active");
    });
    const activeTab = document.getElementById(`tab-${tab}`);
    if (activeTab) activeTab.classList.add("active");
    const globalSection = document.getElementById("global-section");
    const personalSection = document.getElementById("personal-section");
    const votersSection = document.getElementById("voters-section");
    if (globalSection) {
      globalSection.classList.toggle("hidden", tab !== "global");
    }
    if (personalSection) {
      personalSection.classList.toggle("hidden", tab !== "personal");
    }
    if (votersSection) {
      votersSection.classList.toggle("hidden", tab !== "voters");
    }
    updateUrl();
    if (tab === "global") {
      await loadGlobalRankings();
    } else if (tab === "voters") {
      await loadVoterStats();
    } else {
      await loadPersonalRankings();
    }
  }
  function showLoading(show) {
    const loadingState = document.getElementById("loading-state");
    if (loadingState) {
      loadingState.classList.toggle("hidden", !show);
    }
  }
  function renderGlobalRankings(data) {
    const tbody = document.getElementById("global-body");
    if (data.pagination) {
      totalPages = data.pagination.totalPages;
      updatePaginationUI(data.pagination);
    }
    if (!tbody) return;
    if (data.leaderboard.length === 0) {
      tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">
          No rankings yet. Be the first to <a href="/compare">start comparing</a>!
        </td>
      </tr>
    `;
    } else {
      const clipUrl = (entry) => escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`);
      tbody.innerHTML = data.leaderboard.map((entry) => `
      <tr>
        <td class="rank ${getRankClass(entry.rank)}">#${entry.rank}</td>
        <td class="clip-thumbnail">
          <a href="${clipUrl(entry)}" target="_blank" rel="noopener" class="thumbnail-link">
            <img src="${getTwitchThumbnail(entry.twitchSlug)}" alt="${escapeHtml(entry.title || entry.twitchSlug)}" class="clip-thumbnail-img" loading="lazy" onerror="handleThumbnailError(this)" />
          </a>
        </td>
        <td class="clip-name">
          <a href="${clipUrl(entry)}" target="_blank" rel="noopener">
            ${escapeHtml(entry.title || entry.twitchSlug)}
          </a>
        </td>
        <td class="elo">${Math.round(entry.elo || 1500)}</td>
        <td>${formatNumber(entry.matches)}</td>
        <td>${entry.winRate}%</td>
        <td>${formatNumber(entry.globalSuperLikes || 0)}</td>
        <td class="action-column">
          ${getCurrentUser() ? `
            <button class="btn-add" id="add-btn-${entry.id}" data-clip-id="${entry.id}" title="Add to Personal Ranking">
              Rank
            </button>
          ` : ""}
        </td>
      </tr>
    `).join("");
      data.leaderboard.forEach((entry) => {
        const addBtn = document.getElementById(`add-btn-${entry.id}`);
        addBtn?.addEventListener("click", () => addToPersonalRankings(entry.id));
      });
    }
    showLoading(false);
  }
  async function loadGlobalRankings() {
    const params = new URLSearchParams({
      page: String(currentPage),
      limit: "50",
      sort: currentSort,
      order: currentOrder
    });
    const apiUrl = `/api/leaderboard?${params.toString()}`;
    const isDefaultQuery = currentPage === 1 && currentSort === "elo" && currentOrder === "desc";
    if (isDefaultQuery && window.getCachedApiData) {
      const prefetchUrl = "/api/leaderboard?page=1&limit=50&sort=elo&order=desc";
      const cached = window.getCachedApiData(prefetchUrl);
      if (cached) {
        console.debug("[Leaderboard] Using prefetched data");
        renderGlobalRankings(cached);
        return;
      }
    }
    showLoading(true);
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error("Failed to load rankings");
      const data = await response.json();
      renderGlobalRankings(data);
    } catch (error) {
      console.error("Failed to load global rankings:", error);
      showToast("Failed to load rankings", "error");
      showLoading(false);
    }
  }
  function updatePaginationUI(pagination) {
    const { page, total, totalPages: pages } = pagination;
    const infoEl = document.getElementById("pagination-info");
    if (infoEl) {
      const start = (page - 1) * 50 + 1;
      const end = Math.min(page * 50, total);
      infoEl.textContent = `Showing ${start}-${end} of ${total}`;
    }
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= pages;
    const pageNumbersEl = document.getElementById("page-numbers");
    if (pageNumbersEl) {
      const pageNumbers = [];
      const maxVisible = 5;
      if (pages <= maxVisible) {
        for (let i = 1; i <= pages; i++) {
          pageNumbers.push(i);
        }
      } else {
        const start = Math.max(2, page - 1);
        const end = Math.min(pages - 1, page + 1);
        pageNumbers.push(1);
        if (start > 2) pageNumbers.push("...");
        for (let i = start; i <= end; i++) pageNumbers.push(i);
        if (end < pages - 1) pageNumbers.push("...");
        pageNumbers.push(pages);
      }
      pageNumbersEl.innerHTML = pageNumbers.map((p) => {
        if (p === "...") return '<span class="page-ellipsis">...</span>';
        const active = p === page ? "active" : "";
        return `<button class="btn-page-num ${active}" data-page="${p}">${p}</button>`;
      }).join("");
      pageNumbersEl.querySelectorAll(".btn-page-num").forEach((btn) => {
        const pageNum = parseInt(btn.dataset.page || "1", 10);
        btn.addEventListener("click", () => goToPage(pageNum));
      });
    }
  }
  async function addToPersonalRankings(clipId) {
    if (!getCurrentUser()) {
      showToast("Sign in to add clips to your rankings", "error");
      return;
    }
    const btn = document.getElementById(`add-btn-${clipId}`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "...";
    }
    try {
      const response = await fetch(`/api/leaderboard/add/${clipId}`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error("Failed to add clip");
      }
      const data = await response.json();
      if (data.alreadyRanked) {
        showToast("This clip is already in your rankings!", "info");
        if (btn) {
          btn.textContent = "\u2713";
          btn.disabled = true;
        }
        return;
      }
      if (data.needsRanking) {
        showToast("Redirecting to rank this clip...", "info");
        window.location.href = `/compare?rank=${clipId}`;
      } else {
        showToast("Clip added to your rankings!", "success");
        if (btn) {
          btn.textContent = "\u2713";
          btn.disabled = true;
        }
      }
    } catch (error) {
      console.error("Failed to add clip:", error);
      showToast("Failed to add clip to rankings", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "+";
      }
    }
  }
  async function loadPersonalRankings() {
    const personalList = document.getElementById("personal-list");
    const personalEmpty = document.getElementById("personal-empty");
    if (!getCurrentUser()) {
      if (personalEmpty) {
        personalEmpty.classList.remove("hidden");
        personalEmpty.innerHTML = '<a href="/api/auth/login">Sign in with Twitch</a> to see your personal rankings.';
      }
      if (personalList) personalList.classList.add("hidden");
      return;
    }
    showLoading(true);
    try {
      const response = await fetch(`/api/leaderboard/me?limit=100&sort=${personalSort}`);
      if (!response.ok) throw new Error("Failed to load rankings");
      const data = await response.json();
      personalRankings = data.leaderboard;
      const sortSelect = document.getElementById("personal-sort-select");
      if (sortSelect) sortSelect.value = personalSort;
      if (personalRankings.length === 0) {
        if (personalEmpty) personalEmpty.classList.remove("hidden");
        if (personalList) personalList.classList.add("hidden");
      } else {
        if (personalEmpty) personalEmpty.classList.add("hidden");
        if (personalList) personalList.classList.remove("hidden");
        renderPersonalRankings();
      }
    } catch (error) {
      console.error("Failed to load personal rankings:", error);
      showToast("Failed to load rankings", "error");
    } finally {
      showLoading(false);
    }
  }
  function handlePersonalSortChange() {
    const sortSelect = document.getElementById("personal-sort-select");
    if (sortSelect) {
      personalSort = sortSelect.value;
    }
    loadPersonalRankings();
  }
  function renderPersonalRankings() {
    const personalList = document.getElementById("personal-list");
    if (!personalList) return;
    const parent = getTwitchParent();
    personalList.innerHTML = personalRankings.map((entry, index) => `
    <div class="saved-item" data-id="${entry.id}" data-position="${entry.rank}" draggable="true">
      <div class="saved-item-drag" title="Drag to reorder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 7a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 6a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
        </svg>
      </div>

      <div class="saved-item-rank">
        <input
          type="number"
          class="rank-input"
          data-clip-id="${entry.id}"
          value="${index + 1}"
          min="1"
          max="${personalRankings.length}"
        />
      </div>

      <div class="saved-item-thumbnail">
        <a href="${escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`)}" target="_blank" rel="noopener" class="thumbnail-link">
          <img src="${getTwitchThumbnail(entry.twitchSlug)}" alt="${escapeHtml(entry.title || entry.twitchSlug)}" class="clip-thumbnail-img" loading="lazy" onerror="handleThumbnailError(this)" />
        </a>
      </div>

      <div class="saved-item-info">
        <div class="saved-item-title">${escapeHtml(entry.title || entry.twitchSlug)}</div>
        <div class="saved-item-meta">Clipped by ${escapeHtml(entry.clippedBy || "Unknown")}</div>
      </div>

      <div class="saved-item-actions">
        <button class="btn-rerank" data-clip-id="${entry.id}" title="Re-compare this clip" ${personalRankings.length < 3 ? "disabled" : ""}>
          Rerank
        </button>
        <button class="btn-arrow btn-move-up" data-clip-id="${entry.id}" ${index === 0 ? "disabled" : ""} title="Move up">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="btn-arrow btn-move-down" data-clip-id="${entry.id}" ${index === personalRankings.length - 1 ? "disabled" : ""} title="Move down">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clip-rule="evenodd" />
          </svg>
        </button>
        <a href="${escapeHtml(entry.twitchUrl || `https://clips.twitch.tv/${entry.twitchSlug}`)}" class="btn-open" target="_blank" rel="noopener" title="Open on Twitch">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
            <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
          </svg>
        </a>
        <button class="btn-delete-clip" data-clip-id="${entry.id}" title="Remove from rankings">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  `).join("");
    setupPersonalDragAndDrop();
    personalList.querySelectorAll(".rank-input").forEach((input) => {
      const clipId = parseInt(input.dataset.clipId || "0", 10);
      input.addEventListener("change", (e) => {
        handlePersonalRankChange(clipId, e.target.value);
      });
      input.addEventListener("click", () => {
        input.select();
      });
    });
    personalList.querySelectorAll(".btn-rerank").forEach((btn) => {
      const clipId = parseInt(btn.dataset.clipId || "0", 10);
      btn.addEventListener("click", () => startRerank(clipId));
    });
    personalList.querySelectorAll(".btn-move-up").forEach((btn) => {
      const clipId = parseInt(btn.dataset.clipId || "0", 10);
      btn.addEventListener("click", () => movePersonalUp(clipId));
    });
    personalList.querySelectorAll(".btn-move-down").forEach((btn) => {
      const clipId = parseInt(btn.dataset.clipId || "0", 10);
      btn.addEventListener("click", () => movePersonalDown(clipId));
    });
    personalList.querySelectorAll(".btn-delete-clip").forEach((btn) => {
      const clipId = parseInt(btn.dataset.clipId || "0", 10);
      btn.addEventListener("click", (e) => deleteClipFromRankings(clipId, e.shiftKey));
    });
  }
  function setupPersonalDragAndDrop() {
    const personalList = document.getElementById("personal-list");
    if (!personalList) return;
    const items = personalList.querySelectorAll(".saved-item");
    items.forEach((item) => {
      const element = item;
      element.addEventListener("dragstart", handlePersonalDragStart);
      element.addEventListener("dragend", handlePersonalDragEnd);
      element.addEventListener("dragover", handlePersonalDragOver);
      element.addEventListener("dragenter", handlePersonalDragEnter);
      element.addEventListener("dragleave", handlePersonalDragLeave);
      element.addEventListener("drop", handlePersonalDrop);
    });
  }
  function handlePersonalDragStart(e) {
    draggedItem = this;
    this.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.dataset.id || "");
    }
  }
  function handlePersonalDragEnd() {
    this.classList.remove("dragging");
    document.querySelectorAll(".saved-item").forEach((item) => {
      item.classList.remove("drag-over");
    });
    draggedItem = null;
  }
  function handlePersonalDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  }
  function handlePersonalDragEnter(e) {
    e.preventDefault();
    if (this !== draggedItem) {
      this.classList.add("drag-over");
    }
  }
  function handlePersonalDragLeave() {
    this.classList.remove("drag-over");
  }
  async function handlePersonalDrop(e) {
    e.preventDefault();
    this.classList.remove("drag-over");
    if (this === draggedItem || !draggedItem) return;
    const draggedId = parseInt(draggedItem.dataset.id || "0", 10);
    const targetPosition = parseInt(this.dataset.position || "0", 10);
    await reorderPersonalRanking(draggedId, targetPosition);
  }
  async function movePersonalUp(clipId) {
    const entry = personalRankings.find((e) => e.id === clipId);
    if (!entry || entry.rank <= 1) return;
    await reorderPersonalRanking(clipId, entry.rank - 1);
  }
  async function movePersonalDown(clipId) {
    const entry = personalRankings.find((e) => e.id === clipId);
    if (!entry || entry.rank >= personalRankings.length) return;
    await reorderPersonalRanking(clipId, entry.rank + 1);
  }
  async function handlePersonalRankChange(clipId, newRank) {
    const position = parseInt(newRank, 10);
    if (isNaN(position) || position < 1 || position > personalRankings.length) {
      showToast("Invalid rank", "error");
      renderPersonalRankings();
      return;
    }
    await reorderPersonalRanking(clipId, position);
  }
  async function reorderPersonalRanking(clipId, newPosition) {
    try {
      const response = await fetch("/api/leaderboard/me/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, newPosition })
      });
      if (!response.ok) {
        throw new Error("Failed to reorder");
      }
      const data = await response.json();
      await loadPersonalRankings();
      if (data.globalRankingUpdated) {
        showToast(`Ranking updated! Boosted global ranking (beat ${data.clipsBeaten} clip${data.clipsBeaten && data.clipsBeaten > 1 ? "s" : ""})`, "success");
      } else {
        showToast("Ranking updated", "success");
      }
    } catch (error) {
      console.error("Failed to reorder ranking:", error);
      showToast("Failed to reorder ranking", "error");
    }
  }
  async function startRerank(clipId) {
    if (personalRankings.length < 3) {
      showToast("Need at least 3 ranked clips to rerank", "error");
      return;
    }
    try {
      const response = await fetch(`/api/leaderboard/rerank/${clipId}`, {
        method: "POST"
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to start rerank");
      }
      showToast("Redirecting to re-compare...", "info");
      window.location.href = `/compare?rerank=${clipId}`;
    } catch (error) {
      console.error("Failed to start rerank:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to start rerank";
      showToast(errorMessage, "error");
    }
  }
  async function deleteClipFromRankings(clipId, skipConfirm = false) {
    const clip = personalRankings.find((c) => c.id === clipId);
    const clipTitle = clip?.title || "this clip";
    if (!skipConfirm) {
      const confirmed = confirm(
        `Remove "${clipTitle}" from your rankings?

This will delete all your rating data for this clip.
This action cannot be undone.`
      );
      if (!confirmed) return;
    }
    try {
      const response = await fetch(`/api/leaderboard/me/${clipId}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error("Failed to delete clip");
      }
      showToast("Clip removed from rankings", "success");
      await loadPersonalRankings();
    } catch (error) {
      console.error("Failed to delete clip:", error);
      showToast("Failed to remove clip", "error");
    }
  }
  async function showVoteHistory(clipId) {
    historyModalClipId = clipId;
    const modal = document.getElementById("history-modal");
    const content = document.getElementById("history-modal-content");
    if (!modal || !content) return;
    modal.classList.remove("hidden");
    content.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Loading vote history...</div></div>';
    try {
      const response = await fetch(`/api/leaderboard/me/history/${clipId}`);
      if (!response.ok) throw new Error("Failed to load history");
      const data = await response.json();
      const clip = personalRankings.find((c) => c.id === clipId);
      if (data.votes.length === 0) {
        content.innerHTML = `
        <div class="history-header">
          <h3>Vote History: ${escapeHtml(clip?.title || "Unknown Clip")}</h3>
          <button class="btn-close-modal" id="close-history-modal">\xD7</button>
        </div>
        <div class="empty-state">No vote history found for this clip.</div>
      `;
      } else {
        content.innerHTML = `
        <div class="history-header">
          <h3>Vote History: ${escapeHtml(clip?.title || "Unknown Clip")}</h3>
          <button class="btn-close-modal" id="close-history-modal">\xD7</button>
        </div>
        <div class="history-list">
          ${data.votes.map((vote) => `
            <div class="history-item">
              <div class="history-info">
                <span class="history-result ${getResultClass(vote.result, clipId, vote.opponent_id)}">
                  ${getResultText(vote.result, clipId, vote.opponent_id)}
                </span>
                <span class="history-vs">vs</span>
                <a href="https://clips.twitch.tv/${vote.opponent_slug}" target="_blank" rel="noopener" class="history-opponent">
                  ${escapeHtml(vote.opponent_title || vote.opponent_slug)}
                </a>
                ${vote.is_super_like ? '<span class="history-super">\u2B50</span>' : ""}
              </div>
              <div class="history-actions">
                <span class="history-date">${formatTimeAgo(vote.created_at)}</span>
                <button class="btn-delete-vote" data-vote-id="${vote.id}" title="Delete this vote">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                    <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          `).join("")}
        </div>
      `;
      }
      document.getElementById("close-history-modal")?.addEventListener("click", closeHistoryModal);
      content.querySelectorAll(".btn-delete-vote").forEach((btn) => {
        const voteId = parseInt(btn.dataset.voteId || "0", 10);
        btn.addEventListener("click", () => deleteVote(voteId));
      });
    } catch (error) {
      console.error("Failed to load vote history:", error);
      content.innerHTML = `
      <div class="history-header">
        <h3>Vote History</h3>
        <button class="btn-close-modal" id="close-history-modal">\xD7</button>
      </div>
      <div class="empty-state">Failed to load vote history.</div>
    `;
      document.getElementById("close-history-modal")?.addEventListener("click", closeHistoryModal);
    }
  }
  function getResultClass(result, clipId, opponentId) {
    if (result === "tie" || result === "skip") return "result-tie";
    if (result.includes("a")) {
      return "result-win";
    }
    return "result-loss";
  }
  function getResultText(result, clipId, opponentId) {
    if (result === "tie") return "Tie";
    if (result === "skip") return "Skipped";
    if (result === "super_a" || result === "super_b") return "Win";
    if (result === "clip_a" || result === "clip_b") return "Win";
    return result;
  }
  function closeHistoryModal() {
    const modal = document.getElementById("history-modal");
    if (modal) modal.classList.add("hidden");
    historyModalClipId = null;
  }
  async function deleteVote(voteId) {
    const confirmed = confirm("Delete this vote? This cannot be undone.");
    if (!confirmed) return;
    try {
      const response = await fetch(`/api/leaderboard/me/history/${voteId}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error("Failed to delete vote");
      }
      showToast("Vote deleted", "success");
      if (historyModalClipId) {
        await showVoteHistory(historyModalClipId);
      }
    } catch (error) {
      console.error("Failed to delete vote:", error);
      showToast("Failed to delete vote", "error");
    }
  }
  async function loadVoterStats() {
    showLoading(true);
    try {
      const response = await fetch("/api/leaderboard/admin/voters");
      if (!response.ok) {
        if (response.status === 403) {
          showToast("Admin access required", "error");
          return;
        }
        throw new Error("Failed to load voter stats");
      }
      const data = await response.json();
      const tbody = document.getElementById("voters-body");
      if (!tbody) return;
      if (data.voters.length === 0) {
        tbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">No voters yet.</td>
        </tr>
      `;
      } else {
        tbody.innerHTML = data.voters.map((voter) => `
        <tr>
          <td class="rank ${getRankClass(voter.rank)}">#${voter.rank}</td>
          <td class="user-cell">
            ${voter.profileImage ? `<img src="${escapeHtml(voter.profileImage)}" class="user-avatar" alt="">` : ""}
            <span>${escapeHtml(voter.displayName || voter.username)}</span>
          </td>
          <td>${formatNumber(voter.totalVotes)}</td>
          <td>${formatNumber(voter.superLikes)}</td>
          <td>${formatTimeAgo(voter.lastLogin)}</td>
        </tr>
      `).join("");
      }
    } catch (error) {
      console.error("Failed to load voter stats:", error);
      showToast("Failed to load voter stats", "error");
    } finally {
      showLoading(false);
    }
  }
  function formatTimeAgo(dateStr) {
    if (!dateStr) return "Never";
    const utcDateStr = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
    const date = new Date(utcDateStr);
    const now = /* @__PURE__ */ new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 6e4);
    const diffHours = Math.floor(diffMs / 36e5);
    const diffDays = Math.floor(diffMs / 864e5);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }
  function checkAdminAndShowTab() {
    const user = getCurrentUser();
    if (!user) return;
    const admins = ["digibugcat", "arross"];
    if (admins.includes(user.twitchUsername)) {
      document.getElementById("tab-voters")?.classList.remove("hidden");
    }
  }
  function getRankClass(rank) {
    if (rank === 1) return "rank--1";
    if (rank === 2) return "rank--2";
    if (rank === 3) return "rank--3";
    return "";
  }
  function setupEventListeners() {
    document.getElementById("tab-global")?.addEventListener("click", () => switchTab("global"));
    document.getElementById("tab-personal")?.addEventListener("click", () => switchTab("personal"));
    document.getElementById("tab-voters")?.addEventListener("click", () => switchTab("voters"));
    document.getElementById("sort-select")?.addEventListener("change", handleSortChange);
    document.getElementById("order-btn")?.addEventListener("click", toggleSortOrder);
    document.getElementById("personal-sort-select")?.addEventListener("change", handlePersonalSortChange);
    document.getElementById("prev-btn")?.addEventListener("click", () => goToPage(currentPage - 1));
    document.getElementById("next-btn")?.addEventListener("click", () => goToPage(currentPage + 1));
    document.getElementById("history-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "history-modal") {
        closeHistoryModal();
      }
    });
  }
  async function initLeaderboardPage() {
    setupEventListeners();
    await checkAuth();
    checkAdminAndShowTab();
    initFromUrl();
    if (currentTab === "me") {
      document.getElementById("tab-global")?.classList.remove("active");
      document.getElementById("tab-personal")?.classList.add("active");
      document.getElementById("global-section")?.classList.add("hidden");
      document.getElementById("personal-section")?.classList.remove("hidden");
      await loadPersonalRankings();
    } else if (currentTab === "voters") {
      document.getElementById("tab-global")?.classList.remove("active");
      document.getElementById("tab-voters")?.classList.add("active");
      document.getElementById("global-section")?.classList.add("hidden");
      document.getElementById("voters-section")?.classList.remove("hidden");
      await loadVoterStats();
    } else {
      await loadGlobalRankings();
    }
  }
  window.addEventListener("popstate", async () => {
    initFromUrl();
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    document.getElementById("global-section")?.classList.add("hidden");
    document.getElementById("personal-section")?.classList.add("hidden");
    document.getElementById("voters-section")?.classList.add("hidden");
    if (currentTab === "me") {
      document.getElementById("tab-personal")?.classList.add("active");
      document.getElementById("personal-section")?.classList.remove("hidden");
      await loadPersonalRankings();
    } else if (currentTab === "voters") {
      document.getElementById("tab-voters")?.classList.add("active");
      document.getElementById("voters-section")?.classList.remove("hidden");
      await loadVoterStats();
    } else {
      document.getElementById("tab-global")?.classList.add("active");
      document.getElementById("global-section")?.classList.remove("hidden");
      await loadGlobalRankings();
    }
  });
  document.addEventListener("DOMContentLoaded", initLeaderboardPage);
})();
//# sourceMappingURL=leaderboard.js.map

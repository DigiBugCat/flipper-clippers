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

  // src/frontend/saved.ts
  var savedClips = [];
  var draggedItem = null;
  async function initSavedPage() {
    const user = await checkAuth();
    const authRequired = document.getElementById("auth-required");
    const savedUi = document.getElementById("saved-ui");
    if (!user) {
      if (authRequired) authRequired.classList.remove("hidden");
      if (savedUi) savedUi.classList.add("hidden");
      return;
    }
    if (authRequired) authRequired.classList.add("hidden");
    if (savedUi) savedUi.classList.remove("hidden");
    await loadSavedClips();
  }
  async function loadSavedClips() {
    const loadingState = document.getElementById("loading-state");
    const emptyState = document.getElementById("empty-state");
    const savedList = document.getElementById("saved-list");
    try {
      const response = await fetch("/api/saved");
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/api/auth/login";
          return;
        }
        throw new Error("Failed to load saved clips");
      }
      const data = await response.json();
      savedClips = data.clips;
      if (loadingState) loadingState.classList.add("hidden");
      if (savedClips.length === 0) {
        if (emptyState) emptyState.classList.remove("hidden");
        if (savedList) savedList.classList.add("hidden");
      } else {
        if (emptyState) emptyState.classList.add("hidden");
        if (savedList) savedList.classList.remove("hidden");
        renderSavedClips();
      }
    } catch (error) {
      console.error("Failed to load saved clips:", error);
      showToast("Failed to load saved clips", "error");
      if (loadingState) loadingState.classList.add("hidden");
    }
  }
  function renderSavedClips() {
    const savedList = document.getElementById("saved-list");
    if (!savedList) return;
    savedList.innerHTML = savedClips.map(
      (clip, index) => `
    <div class="saved-item" data-id="${clip.id}" data-position="${clip.position}" draggable="true">
      <div class="saved-item-drag" title="Drag to reorder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 7a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 6a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
        </svg>
      </div>

      <div class="saved-item-rank">
        <input
          type="number"
          class="rank-input"
          value="${index + 1}"
          min="1"
          max="${savedClips.length}"
          onchange="handleRankChange(${clip.id}, this.value)"
          onclick="this.select()"
        />
      </div>

      <div class="saved-item-thumbnail">
        <a href="${clip.twitchUrl || `https://clips.twitch.tv/${clip.twitchSlug}`}" target="_blank" rel="noopener" class="thumbnail-link">
          <img src="${getTwitchThumbnail(clip.twitchSlug)}" alt="${escapeHtml(clip.title || clip.twitchSlug)}" class="clip-thumbnail-img" loading="lazy" onerror="handleThumbnailError(this)" />
        </a>
      </div>

      <div class="saved-item-info">
        <div class="saved-item-title">${escapeHtml(clip.title || clip.twitchSlug)}</div>
        <div class="saved-item-meta">Clipped by ${escapeHtml(clip.clippedBy || "Unknown")}</div>
      </div>

      <div class="saved-item-actions">
        <button class="btn-arrow" onclick="moveUp(${clip.id})" ${index === 0 ? "disabled" : ""} title="Move up">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="btn-arrow" onclick="moveDown(${clip.id})" ${index === savedClips.length - 1 ? "disabled" : ""} title="Move down">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z" clip-rule="evenodd" />
          </svg>
        </button>
        <button class="btn-unsave" onclick="unsaveClip(${clip.id})" title="Remove from saved">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401z" clip-rule="evenodd" />
          </svg>
        </button>
        <a href="${clip.twitchUrl || `https://clips.twitch.tv/${clip.twitchSlug}`}" class="btn-open" target="_blank" rel="noopener" title="Open on Twitch">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" clip-rule="evenodd" />
            <path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" clip-rule="evenodd" />
          </svg>
        </a>
      </div>
    </div>
  `
    ).join("");
    setupDragAndDrop();
  }
  function setupDragAndDrop() {
    const savedList = document.getElementById("saved-list");
    if (!savedList) return;
    const items = savedList.querySelectorAll(".saved-item");
    items.forEach((item) => {
      item.addEventListener("dragstart", handleDragStart);
      item.addEventListener("dragend", handleDragEnd);
      item.addEventListener("dragover", handleDragOver);
      item.addEventListener("dragenter", handleDragEnter);
      item.addEventListener("dragleave", handleDragLeave);
      item.addEventListener("drop", handleDrop);
    });
  }
  function handleDragStart(e) {
    draggedItem = this;
    this.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.dataset.id || "");
    }
  }
  function handleDragEnd(_e) {
    this.classList.remove("dragging");
    document.querySelectorAll(".saved-item").forEach((item) => {
      item.classList.remove("drag-over");
    });
    draggedItem = null;
  }
  function handleDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  }
  function handleDragEnter(e) {
    e.preventDefault();
    if (this !== draggedItem) {
      this.classList.add("drag-over");
    }
  }
  function handleDragLeave(_e) {
    this.classList.remove("drag-over");
  }
  async function handleDrop(e) {
    e.preventDefault();
    this.classList.remove("drag-over");
    if (this === draggedItem || !draggedItem) return;
    const draggedId = parseInt(draggedItem.dataset.id || "0", 10);
    const targetPosition = parseInt(this.dataset.position || "0", 10);
    await reorderClip(draggedId, targetPosition);
  }
  async function moveUp(clipId) {
    const clip = savedClips.find((c) => c.id === clipId);
    if (!clip || clip.position <= 1) return;
    await reorderClip(clipId, clip.position - 1);
  }
  async function moveDown(clipId) {
    const clip = savedClips.find((c) => c.id === clipId);
    if (!clip || clip.position >= savedClips.length) return;
    await reorderClip(clipId, clip.position + 1);
  }
  async function handleRankChange(clipId, newRank) {
    const position = parseInt(newRank, 10);
    if (isNaN(position) || position < 1 || position > savedClips.length) {
      showToast("Invalid rank", "error");
      renderSavedClips();
      return;
    }
    await reorderClip(clipId, position);
  }
  async function reorderClip(clipId, newPosition) {
    try {
      const response = await fetch("/api/saved/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, newPosition })
      });
      if (!response.ok) {
        throw new Error("Failed to reorder");
      }
      await loadSavedClips();
      showToast("Clip reordered", "success");
    } catch (error) {
      console.error("Failed to reorder clip:", error);
      showToast("Failed to reorder clip", "error");
    }
  }
  async function unsaveClip(clipId) {
    try {
      const response = await fetch(`/api/saved/${clipId}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error("Failed to unsave");
      }
      await loadSavedClips();
      showToast("Clip removed", "success");
    } catch (error) {
      console.error("Failed to unsave clip:", error);
      showToast("Failed to remove clip", "error");
    }
  }
  document.addEventListener("DOMContentLoaded", initSavedPage);
  window.moveUp = moveUp;
  window.moveDown = moveDown;
  window.handleRankChange = handleRankChange;
  window.unsaveClip = unsaveClip;
  window.initSavedPage = initSavedPage;
  window.loadSavedClips = loadSavedClips;
})();
//# sourceMappingURL=saved.js.map

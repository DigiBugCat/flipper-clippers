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
      const response = await fetch(`/api/social/profile/${currentUser.id}`);
      if (response.ok) {
        const data = await response.json();
        renderTopClips(data.topClips);
        if (profileStatsEl) {
          const coverageText = data.profile.coveragePercent ? ` \u2022 ${data.profile.coveragePercent.toFixed(1)}% coverage` : "";
          profileStatsEl.textContent = `${formatNumber(data.profile.totalComparisons)} votes cast${coverageText}`;
          profileStatsEl.title = `${data.profile.uniquePairs || 0} unique pairs out of ${data.profile.totalPossiblePairs || 0} possible`;
        }
      } else if (profileStatsEl) {
        profileStatsEl.textContent = `${formatNumber(currentUser.totalComparisons)} votes cast`;
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
})();
//# sourceMappingURL=social.js.map

"use strict";
(() => {
  // src/frontend/comments.ts
  var EMOJI_CONFIG = {
    fire: { label: "Fire", display: "" },
    skull: { label: "Dead", display: "" },
    crying: { label: "Crying", display: "" },
    poggers: { label: "Poggers", display: "" },
    pepehands: { label: "PepeHands", display: "" },
    lul: { label: "LUL", display: "" }
  };
  async function loadReactions(clipId) {
    try {
      const response = await fetch(`/api/comments/reactions/${clipId}`);
      if (!response.ok) return {};
      const data = await response.json();
      return data.reactions || {};
    } catch (error) {
      console.error("Failed to load reactions:", error);
      return {};
    }
  }
  async function loadMyComment(clipId) {
    try {
      const response = await fetch(`/api/comments/my/${clipId}`);
      if (!response.ok) return null;
      const data = await response.json();
      return data.comment;
    } catch (error) {
      console.error("Failed to load comment:", error);
      return null;
    }
  }
  async function submitComment(clipId, emoji, comment = "", isPublic = true) {
    try {
      const response = await fetch(`/api/comments/${clipId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji, comment, isPublic })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to submit");
      }
      return true;
    } catch (error) {
      console.error("Failed to submit comment:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to submit";
      showToast(errorMessage, "error");
      return false;
    }
  }
  async function deleteComment(clipId) {
    try {
      const response = await fetch(`/api/comments/${clipId}`, { method: "DELETE" });
      return response.ok;
    } catch (error) {
      console.error("Failed to delete comment:", error);
      return false;
    }
  }
  function renderEmojiPicker(clipId, selectedEmoji = null, _onSelect = null) {
    const buttons = Object.entries(EMOJI_CONFIG).map(([key, config]) => {
      const isSelected = selectedEmoji === key;
      return `
      <button class="emoji-btn ${isSelected ? "selected" : ""}"
              data-emoji="${key}"
              title="${config.label}"
              onclick="handleEmojiClick(${clipId}, '${key}', this)">
        ${config.display}
      </button>
    `;
    }).join("");
    return `<div class="emoji-picker">${buttons}</div>`;
  }
  async function handleEmojiClick(clipId, emoji, button) {
    if (!currentUser) {
      showToast("Sign in to react", "info");
      return;
    }
    const picker = button.closest(".emoji-picker");
    if (!picker) return;
    const wasSelected = button.classList.contains("selected");
    picker.querySelectorAll(".emoji-btn").forEach((btn) => btn.classList.remove("selected"));
    if (!wasSelected) {
      button.classList.add("selected");
    }
    if (wasSelected) {
      await deleteComment(clipId);
    } else {
      await submitComment(clipId, emoji, "", true);
    }
    refreshReactionCounts(clipId);
  }
  async function refreshReactionCounts(clipId) {
    const container = document.querySelector(`[data-reaction-counts="${clipId}"]`);
    if (!container) return;
    const reactions = await loadReactions(clipId);
    container.innerHTML = renderReactionCounts(reactions);
  }
  function renderReactionCounts(reactions) {
    const counts = Object.entries(reactions).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([emoji, count]) => {
      const config = EMOJI_CONFIG[emoji];
      if (!config) return "";
      return `<span class="reaction-count">${config.display} ${count}</span>`;
    }).join("");
    return counts || '<span class="no-reactions">No reactions yet</span>';
  }
  function handleEscapeKey(e) {
    if (e.key === "Escape") closeCommentModal();
  }
  function createCommentModal(clipId, clipTitle, existingComment = null) {
    const existing = document.getElementById("comment-modal");
    if (existing) existing.remove();
    const selectedEmoji = existingComment?.emoji || "";
    const commentText = existingComment?.comment || "";
    const isPublic = existingComment?.isPublic !== false;
    const modal = document.createElement("div");
    modal.id = "comment-modal";
    modal.className = "modal-overlay";
    modal.innerHTML = `
    <div class="modal-content comment-modal">
      <button class="modal-close" onclick="closeCommentModal()">&times;</button>
      <h3>React to Clip</h3>
      <p class="modal-clip-title">${escapeHtml(clipTitle || "Untitled Clip")}</p>

      <div class="emoji-picker-large">
        ${Object.entries(EMOJI_CONFIG).map(
      ([key, config]) => `
          <button class="emoji-btn-large ${selectedEmoji === key ? "selected" : ""}"
                  data-emoji="${key}"
                  title="${config.label}"
                  onclick="selectModalEmoji('${key}', this)">
            ${config.display}
            <span class="emoji-label">${config.label}</span>
          </button>
        `
    ).join("")}
      </div>

      <textarea id="comment-text"
                placeholder="Add a note (optional, max 500 chars)"
                maxlength="500">${escapeHtml(commentText)}</textarea>

      <label class="checkbox-label">
        <input type="checkbox" id="comment-public" ${isPublic ? "checked" : ""}>
        Make reaction public
      </label>

      <div class="modal-actions">
        ${existingComment ? '<button class="btn btn-ghost" onclick="handleDeleteComment(' + clipId + ')">Delete</button>' : ""}
        <button class="btn btn-primary" onclick="handleSaveComment(${clipId})">Save</button>
      </div>
    </div>
  `;
    document.body.appendChild(modal);
    const textArea = modal.querySelector("#comment-text");
    if (textArea) textArea.focus();
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeCommentModal();
    });
    document.addEventListener("keydown", handleEscapeKey);
  }
  function closeCommentModal() {
    const modal = document.getElementById("comment-modal");
    if (modal) modal.remove();
    document.removeEventListener("keydown", handleEscapeKey);
  }
  function selectModalEmoji(emoji, button) {
    const picker = button.closest(".emoji-picker-large");
    if (!picker) return;
    picker.querySelectorAll(".emoji-btn-large").forEach((btn) => btn.classList.remove("selected"));
    button.classList.add("selected");
  }
  async function handleSaveComment(clipId) {
    const selectedBtn = document.querySelector(
      ".emoji-picker-large .emoji-btn-large.selected"
    );
    const emoji = selectedBtn?.dataset.emoji || null;
    const commentTextArea = document.getElementById(
      "comment-text"
    );
    const comment = commentTextArea?.value.trim() || "";
    const publicCheckbox = document.getElementById(
      "comment-public"
    );
    const isPublic = publicCheckbox?.checked ?? true;
    if (!emoji && !comment) {
      showToast("Select an emoji or add a comment", "info");
      return;
    }
    const success = await submitComment(clipId, emoji, comment, isPublic);
    if (success) {
      closeCommentModal();
      showToast("Reaction saved!", "success");
      refreshReactionCounts(clipId);
    }
  }
  async function handleDeleteComment(clipId) {
    const success = await deleteComment(clipId);
    if (success) {
      closeCommentModal();
      showToast("Reaction removed", "info");
      refreshReactionCounts(clipId);
    }
  }
  async function openCommentModal(clipId, clipTitle) {
    if (!currentUser) {
      showToast("Sign in to react", "info");
      return;
    }
    const existingComment = await loadMyComment(clipId);
    createCommentModal(clipId, clipTitle, existingComment);
  }
  window.handleEmojiClick = handleEmojiClick;
  window.closeCommentModal = closeCommentModal;
  window.selectModalEmoji = selectModalEmoji;
  window.handleSaveComment = handleSaveComment;
  window.handleDeleteComment = handleDeleteComment;
  window.openCommentModal = openCommentModal;
  window.renderEmojiPicker = renderEmojiPicker;
  window.refreshReactionCounts = refreshReactionCounts;
  window.loadReactions = loadReactions;
  window.loadMyComment = loadMyComment;
})();
//# sourceMappingURL=comments.js.map

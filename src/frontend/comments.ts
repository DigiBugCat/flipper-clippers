/**
 * Clip Comments Module
 * ====================
 * Handles emoji reactions and comments on clips
 */

import type { Comment, ReactionEmoji, User } from './types';

// Declare globals from app.ts
declare const currentUser: User | null;
declare function showToast(message: string, type?: 'info' | 'success' | 'error'): void;
declare function escapeHtml(text: string): string;

// Emoji configuration with display info
interface EmojiConfig {
  label: string;
  display: string;
}

type EmojiConfigMap = Record<ReactionEmoji, EmojiConfig>;

const EMOJI_CONFIG: EmojiConfigMap = {
  fire: { label: 'Fire', display: '' },
  skull: { label: 'Dead', display: '' },
  crying: { label: 'Crying', display: '' },
  poggers: { label: 'Poggers', display: '' },
  pepehands: { label: 'PepeHands', display: '' },
  lul: { label: 'LUL', display: '' }
};

// API response types
interface ReactionsResponse {
  reactions: Record<ReactionEmoji, number>;
}

interface MyCommentResponse {
  comment: Comment | null;
}

interface ErrorResponse {
  error: string;
}

/**
 * Load reactions for a clip
 */
async function loadReactions(clipId: number): Promise<Record<ReactionEmoji, number>> {
  try {
    const response: Response = await fetch(`/api/comments/reactions/${clipId}`);
    if (!response.ok) return {} as Record<ReactionEmoji, number>;
    const data: ReactionsResponse = await response.json();
    return data.reactions || ({} as Record<ReactionEmoji, number>);
  } catch (error) {
    console.error('Failed to load reactions:', error);
    return {} as Record<ReactionEmoji, number>;
  }
}

/**
 * Load user's own comment for a clip
 */
async function loadMyComment(clipId: number): Promise<Comment | null> {
  try {
    const response: Response = await fetch(`/api/comments/my/${clipId}`);
    if (!response.ok) return null;
    const data: MyCommentResponse = await response.json();
    return data.comment;
  } catch (error) {
    console.error('Failed to load comment:', error);
    return null;
  }
}

/**
 * Submit a reaction/comment
 */
async function submitComment(
  clipId: number,
  emoji: ReactionEmoji | null,
  comment: string = '',
  isPublic: boolean = true
): Promise<boolean> {
  try {
    const response: Response = await fetch(`/api/comments/${clipId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, comment, isPublic })
    });

    if (!response.ok) {
      const error: ErrorResponse = await response.json();
      throw new Error(error.error || 'Failed to submit');
    }

    return true;
  } catch (error) {
    console.error('Failed to submit comment:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to submit';
    showToast(errorMessage, 'error');
    return false;
  }
}

/**
 * Delete a comment
 */
async function deleteComment(clipId: number): Promise<boolean> {
  try {
    const response: Response = await fetch(`/api/comments/${clipId}`, { method: 'DELETE' });
    return response.ok;
  } catch (error) {
    console.error('Failed to delete comment:', error);
    return false;
  }
}

/**
 * Render emoji reaction picker
 */
function renderEmojiPicker(
  clipId: number,
  selectedEmoji: ReactionEmoji | null = null,
  _onSelect: ((emoji: ReactionEmoji) => void) | null = null
): string {
  const buttons: string = (Object.entries(EMOJI_CONFIG) as [ReactionEmoji, EmojiConfig][])
    .map(([key, config]) => {
      const isSelected: boolean = selectedEmoji === key;
      return `
      <button class="emoji-btn ${isSelected ? 'selected' : ''}"
              data-emoji="${key}"
              title="${config.label}"
              onclick="handleEmojiClick(${clipId}, '${key}', this)">
        ${config.display}
      </button>
    `;
    })
    .join('');

  return `<div class="emoji-picker">${buttons}</div>`;
}

/**
 * Handle emoji button click
 */
async function handleEmojiClick(
  clipId: number,
  emoji: ReactionEmoji,
  button: HTMLButtonElement
): Promise<void> {
  if (!currentUser) {
    showToast('Sign in to react', 'info');
    return;
  }

  const picker: HTMLElement | null = button.closest('.emoji-picker');
  if (!picker) return;

  const wasSelected: boolean = button.classList.contains('selected');

  // Update UI immediately
  picker.querySelectorAll('.emoji-btn').forEach((btn: Element) => btn.classList.remove('selected'));
  if (!wasSelected) {
    button.classList.add('selected');
  }

  // Submit or delete
  if (wasSelected) {
    await deleteComment(clipId);
  } else {
    await submitComment(clipId, emoji, '', true);
  }

  // Refresh reaction counts if there's a display
  refreshReactionCounts(clipId);
}

/**
 * Refresh reaction count display
 */
async function refreshReactionCounts(clipId: number): Promise<void> {
  const container: Element | null = document.querySelector(`[data-reaction-counts="${clipId}"]`);
  if (!container) return;

  const reactions: Record<ReactionEmoji, number> = await loadReactions(clipId);
  container.innerHTML = renderReactionCounts(reactions);
}

/**
 * Render reaction counts display
 */
function renderReactionCounts(reactions: Record<ReactionEmoji, number>): string {
  const counts: string = (Object.entries(reactions) as [ReactionEmoji, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4) // Show top 4
    .map(([emoji, count]) => {
      const config: EmojiConfig | undefined = EMOJI_CONFIG[emoji];
      if (!config) return '';
      return `<span class="reaction-count">${config.display} ${count}</span>`;
    })
    .join('');

  return counts || '<span class="no-reactions">No reactions yet</span>';
}

/**
 * Handle escape key press for modal
 */
function handleEscapeKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCommentModal();
}

/**
 * Create a comment modal/popup
 */
function createCommentModal(
  clipId: number,
  clipTitle: string,
  existingComment: Comment | null = null
): void {
  // Remove existing modal if any
  const existing: HTMLElement | null = document.getElementById('comment-modal');
  if (existing) existing.remove();

  const selectedEmoji: string = existingComment?.emoji || '';
  const commentText: string = existingComment?.comment || '';
  const isPublic: boolean = existingComment?.isPublic !== false;

  const modal: HTMLDivElement = document.createElement('div');
  modal.id = 'comment-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content comment-modal">
      <button class="modal-close" onclick="closeCommentModal()">&times;</button>
      <h3>React to Clip</h3>
      <p class="modal-clip-title">${escapeHtml(clipTitle || 'Untitled Clip')}</p>

      <div class="emoji-picker-large">
        ${(Object.entries(EMOJI_CONFIG) as [ReactionEmoji, EmojiConfig][])
          .map(
            ([key, config]) => `
          <button class="emoji-btn-large ${selectedEmoji === key ? 'selected' : ''}"
                  data-emoji="${key}"
                  title="${config.label}"
                  onclick="selectModalEmoji('${key}', this)">
            ${config.display}
            <span class="emoji-label">${config.label}</span>
          </button>
        `
          )
          .join('')}
      </div>

      <textarea id="comment-text"
                placeholder="Add a note (optional, max 500 chars)"
                maxlength="500">${escapeHtml(commentText)}</textarea>

      <label class="checkbox-label">
        <input type="checkbox" id="comment-public" ${isPublic ? 'checked' : ''}>
        Make reaction public
      </label>

      <div class="modal-actions">
        ${existingComment ? '<button class="btn btn-ghost" onclick="handleDeleteComment(' + clipId + ')">Delete</button>' : ''}
        <button class="btn btn-primary" onclick="handleSaveComment(${clipId})">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const textArea: HTMLTextAreaElement | null = modal.querySelector('#comment-text');
  if (textArea) textArea.focus();

  // Close on backdrop click
  modal.addEventListener('click', (e: MouseEvent) => {
    if (e.target === modal) closeCommentModal();
  });

  // Close on escape
  document.addEventListener('keydown', handleEscapeKey);
}

/**
 * Close the comment modal
 */
function closeCommentModal(): void {
  const modal: HTMLElement | null = document.getElementById('comment-modal');
  if (modal) modal.remove();
  document.removeEventListener('keydown', handleEscapeKey);
}

/**
 * Select an emoji in the modal
 */
function selectModalEmoji(emoji: ReactionEmoji, button: HTMLButtonElement): void {
  const picker: HTMLElement | null = button.closest('.emoji-picker-large');
  if (!picker) return;
  picker.querySelectorAll('.emoji-btn-large').forEach((btn: Element) => btn.classList.remove('selected'));
  button.classList.add('selected');
}

/**
 * Handle saving a comment from the modal
 */
async function handleSaveComment(clipId: number): Promise<void> {
  const selectedBtn: HTMLButtonElement | null = document.querySelector(
    '.emoji-picker-large .emoji-btn-large.selected'
  );
  const emoji: ReactionEmoji | null = (selectedBtn?.dataset.emoji as ReactionEmoji) || null;
  const commentTextArea: HTMLTextAreaElement | null = document.getElementById(
    'comment-text'
  ) as HTMLTextAreaElement | null;
  const comment: string = commentTextArea?.value.trim() || '';
  const publicCheckbox: HTMLInputElement | null = document.getElementById(
    'comment-public'
  ) as HTMLInputElement | null;
  const isPublic: boolean = publicCheckbox?.checked ?? true;

  if (!emoji && !comment) {
    showToast('Select an emoji or add a comment', 'info');
    return;
  }

  const success: boolean = await submitComment(clipId, emoji, comment, isPublic);
  if (success) {
    closeCommentModal();
    showToast('Reaction saved!', 'success');
    refreshReactionCounts(clipId);
  }
}

/**
 * Handle deleting a comment from the modal
 */
async function handleDeleteComment(clipId: number): Promise<void> {
  const success: boolean = await deleteComment(clipId);
  if (success) {
    closeCommentModal();
    showToast('Reaction removed', 'info');
    refreshReactionCounts(clipId);
  }
}

/**
 * Open comment modal for a clip
 */
async function openCommentModal(clipId: number, clipTitle: string): Promise<void> {
  if (!currentUser) {
    showToast('Sign in to react', 'info');
    return;
  }

  const existingComment: Comment | null = await loadMyComment(clipId);
  createCommentModal(clipId, clipTitle, existingComment);
}

// Export functions for use in other modules
export {
  EMOJI_CONFIG,
  loadReactions,
  loadMyComment,
  submitComment,
  deleteComment,
  renderEmojiPicker,
  handleEmojiClick,
  refreshReactionCounts,
  renderReactionCounts,
  createCommentModal,
  closeCommentModal,
  selectModalEmoji,
  handleSaveComment,
  handleDeleteComment,
  openCommentModal
};

// Export types for external use
export type { EmojiConfig, EmojiConfigMap, ReactionsResponse, MyCommentResponse, ErrorResponse };

// Make functions available globally for inline onclick handlers
declare global {
  interface Window {
    handleEmojiClick: typeof handleEmojiClick;
    closeCommentModal: typeof closeCommentModal;
    selectModalEmoji: typeof selectModalEmoji;
    handleSaveComment: typeof handleSaveComment;
    handleDeleteComment: typeof handleDeleteComment;
    openCommentModal: typeof openCommentModal;
    renderEmojiPicker: typeof renderEmojiPicker;
    refreshReactionCounts: typeof refreshReactionCounts;
    loadReactions: typeof loadReactions;
    loadMyComment: typeof loadMyComment;
  }
}

// Assign to window for global access (needed for inline onclick handlers)
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

/**
 * Reusable drag and drop utility for sortable lists
 */

export interface DragDropOptions {
  /** Container element or selector */
  container: HTMLElement | string;
  /** Selector for draggable items within container */
  itemSelector: string;
  /** Data attribute name for item ID (default: 'id') */
  idAttribute?: string;
  /** Data attribute name for position (default: 'position') */
  positionAttribute?: string;
  /** CSS class added to item being dragged (default: 'dragging') */
  draggingClass?: string;
  /** CSS class added to drop target (default: 'drag-over') */
  dragOverClass?: string;
  /** Callback when item is dropped on another item */
  onDrop: (draggedId: number, targetPosition: number) => Promise<void>;
}

/**
 * State for current drag operation
 */
let currentDraggedItem: HTMLElement | null = null;
let currentDragOverClass = 'drag-over';

/**
 * Set up drag and drop for a sortable list
 *
 * @example
 * setupDragAndDrop({
 *   container: '#saved-list',
 *   itemSelector: '.saved-item',
 *   onDrop: async (clipId, newPosition) => {
 *     await reorderClip(clipId, newPosition);
 *   }
 * });
 */
export function setupDragAndDrop(options: DragDropOptions): () => void {
  const {
    container,
    itemSelector,
    idAttribute = 'id',
    positionAttribute = 'position',
    draggingClass = 'dragging',
    dragOverClass = 'drag-over',
    onDrop,
  } = options;

  // Resolve container
  const containerEl = typeof container === 'string'
    ? document.querySelector<HTMLElement>(container)
    : container;

  if (!containerEl) {
    console.warn('Drag and drop: container not found');
    return () => {};
  }

  // Store drag over class for use in handlers
  currentDragOverClass = dragOverClass;

  // Get all items
  const items = containerEl.querySelectorAll<HTMLElement>(itemSelector);

  // Handler functions bound to this setup
  function handleDragStart(this: HTMLElement, e: DragEvent): void {
    currentDraggedItem = this;
    this.classList.add(draggingClass);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.dataset[idAttribute] || '');
    }
  }

  function handleDragEnd(this: HTMLElement): void {
    this.classList.remove(draggingClass);
    containerEl.querySelectorAll(itemSelector).forEach((item) => {
      item.classList.remove(dragOverClass);
    });
    currentDraggedItem = null;
  }

  function handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDragEnter(this: HTMLElement, e: DragEvent): void {
    e.preventDefault();
    if (this !== currentDraggedItem) {
      this.classList.add(dragOverClass);
    }
  }

  function handleDragLeave(this: HTMLElement): void {
    this.classList.remove(dragOverClass);
  }

  async function handleDrop(this: HTMLElement, e: DragEvent): Promise<void> {
    e.preventDefault();
    this.classList.remove(dragOverClass);

    if (this === currentDraggedItem || !currentDraggedItem) return;

    const draggedId = parseInt(currentDraggedItem.dataset[idAttribute] || '0', 10);
    const targetPosition = parseInt(this.dataset[positionAttribute] || '0', 10);

    await onDrop(draggedId, targetPosition);
  }

  // Attach listeners
  items.forEach((item) => {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
  });

  // Return cleanup function
  return () => {
    items.forEach((item) => {
      item.removeEventListener('dragstart', handleDragStart);
      item.removeEventListener('dragend', handleDragEnd);
      item.removeEventListener('dragover', handleDragOver);
      item.removeEventListener('dragenter', handleDragEnter);
      item.removeEventListener('dragleave', handleDragLeave);
      item.removeEventListener('drop', handleDrop);
    });
  };
}

/**
 * Re-initialize drag and drop after list re-render
 * Call this after updating the list contents
 */
export function refreshDragAndDrop(options: DragDropOptions): () => void {
  return setupDragAndDrop(options);
}

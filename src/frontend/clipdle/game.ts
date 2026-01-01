/**
 * Clipdle - Guess Which Clip is Ranked Higher
 * ============================================
 * A daily guessing game where players predict which Twitch clip has a higher ELO rating.
 */

import type { Clip } from '../types';

// =============================================================================
// Types
// =============================================================================

/** Clip data specific to Clipdle game, extending the base Clip type */
interface ClipdleClip extends Pick<Clip, 'id' | 'twitchSlug' | 'title' | 'clippedBy'> {}

/** Current clips in play (left and right panels) */
interface CurrentClips {
  left: ClipdleClip | null;
  right: ClipdleClip | null;
}

/** Twitch embed iframe references */
interface TwitchEmbeds {
  left: HTMLIFrameElement | null;
  right: HTMLIFrameElement | null;
}

/** API response for starting/loading a game */
interface GameDataResponse {
  totalRounds: number;
  left: ClipdleClip;
  right: ClipdleClip;
}

/** API response for a single round */
interface RoundDataResponse {
  left: ClipdleClip;
  right: ClipdleClip;
}

/** API response for revealing the correct answer */
interface RevealResponse {
  correct: 'left' | 'right' | 'tie';
  leftElo: number;
  rightElo: number;
}

/** Choice made by the player */
type PlayerChoice = 'left' | 'right';

/** Attributes for createElement utility */
interface ElementAttributes {
  className?: string;
  textContent?: string;
  id?: string;
  src?: string;
  allowfullscreen?: string;
  frameborder?: string;
  [key: string]: string | EventListener | undefined;
}

// =============================================================================
// Game State
// =============================================================================

let currentSeed: string | null = null;
let currentRound: number = 0;
let totalRounds: number = 8;
let score: number = 0;
let roundResults: boolean[] = []; // true = correct, false = incorrect
let currentClips: CurrentClips = { left: null, right: null };
let twitchEmbeds: TwitchEmbeds = { left: null, right: null };

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create an HTML element with attributes and children
 */
function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElementAttributes = {},
  children: (HTMLElement | string | null)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined) return;

    if (key === 'className') {
      el.className = value as string;
    } else if (key === 'textContent') {
      el.textContent = value as string;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      el.setAttribute(key, value as string);
    }
  });

  children.forEach((child) => {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child) {
      el.appendChild(child);
    }
  });

  return el;
}

/**
 * Clear all children from an element
 */
function clearElement(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * Get today's seed in YYYYMMDD format
 */
function getTodaySeed(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Generate a random seed (9-digit number)
 */
function generateRandomSeed(): number {
  return Math.floor(Math.random() * 900000000) + 100000000;
}

/**
 * Format date seed for display (MM/DD format for 8-digit seeds)
 */
function formatDateShort(seed: string): string {
  if (seed.length === 8 && !isNaN(Number(seed))) {
    const month = seed.slice(4, 6);
    const day = seed.slice(6, 8);
    return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
  }
  return seed;
}

// =============================================================================
// Game State Management
// =============================================================================

/**
 * Reset all game state to initial values
 */
function resetGameState(): void {
  currentRound = 0;
  score = 0;
  roundResults = [];
  currentClips = { left: null, right: null };

  // Clean up Twitch embeds
  if (twitchEmbeds.left) {
    twitchEmbeds.left = null;
  }
  if (twitchEmbeds.right) {
    twitchEmbeds.right = null;
  }
}

// =============================================================================
// Header & Progress Display
// =============================================================================

/**
 * Render the result squares in the header showing game progress
 */
function renderHeaderSquares(): void {
  const container = document.getElementById('headerSquares');
  if (!container) return;

  clearElement(container);

  for (let i = 0; i < totalRounds; i++) {
    const square = createElement('div', { className: 'result-square' });

    if (i < roundResults.length) {
      if (roundResults[i]) {
        square.classList.add('correct');
        square.textContent = '✓';
      } else {
        square.classList.add('incorrect');
        square.textContent = '✗';
      }
    } else if (i === currentRound) {
      square.classList.add('current');
      square.textContent = String(i + 1);
    } else {
      square.textContent = String(i + 1);
    }

    container.appendChild(square);
  }
}

// =============================================================================
// Home Screen
// =============================================================================

/**
 * Render the home screen with game mode options
 */
function renderHome(): void {
  const app = document.getElementById('app');
  if (!app) return;

  clearElement(app);

  // Clear header squares
  const headerSquares = document.getElementById('headerSquares');
  if (headerSquares) clearElement(headerSquares);

  const gameSeed = document.getElementById('gameSeed');
  if (gameSeed) {
    gameSeed.textContent = formatDateShort(getTodaySeed());
  }

  const template = document.getElementById('homeTemplate') as HTMLTemplateElement | null;
  if (!template) return;

  const content = template.content.cloneNode(true) as DocumentFragment;

  // Play Today's Challenge button
  const playDailyBtn = content.getElementById('playDailyBtn');
  playDailyBtn?.addEventListener('click', () => {
    startGame(getTodaySeed());
  });

  // Random Game button
  const playRandomBtn = content.getElementById('playRandomBtn');
  playRandomBtn?.addEventListener('click', () => {
    startGame(String(generateRandomSeed()));
  });

  // Custom seed input
  const playSeedBtn = content.getElementById('playSeedBtn');
  playSeedBtn?.addEventListener('click', () => {
    const input = document.getElementById('customSeedInput') as HTMLInputElement | null;
    const seed = input?.value.trim();
    if (seed) {
      startGame(seed);
    }
  });

  // Enter key on input
  const customSeedInput = content.getElementById('customSeedInput') as HTMLInputElement | null;
  customSeedInput?.addEventListener('keypress', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const target = e.target as HTMLInputElement;
      const seed = target.value.trim();
      if (seed) {
        startGame(seed);
      }
    }
  });

  app.appendChild(content);
}

// =============================================================================
// Game Initialization
// =============================================================================

/**
 * Start a new game with a specific seed
 */
async function startGame(seed: string | number): Promise<void> {
  resetGameState();
  currentSeed = String(seed);

  // Update URL without reload
  const url = new URL(window.location.href);
  url.searchParams.set('seed', currentSeed);
  window.history.pushState({}, '', url.toString());

  const app = document.getElementById('app');
  if (!app) return;

  clearElement(app);
  app.appendChild(
    createElement('div', { className: 'loading' }, [
      createElement('div', { className: 'loading-spinner' }),
      createElement('p', { textContent: 'Loading clips...' }),
    ])
  );

  try {
    const response = await fetch(`/api/clipdle/game?seed=${encodeURIComponent(currentSeed)}`);
    if (!response.ok) throw new Error('Failed to load game');

    const gameData: GameDataResponse = await response.json();

    totalRounds = gameData.totalRounds;
    currentRound = 0;
    currentClips = { left: gameData.left, right: gameData.right };

    const gameSeedEl = document.getElementById('gameSeed');
    if (gameSeedEl) {
      gameSeedEl.textContent = `Seed: ${currentSeed}`;
    }

    renderHeaderSquares();
    renderComparison();
  } catch (error) {
    console.error('Error loading game:', error);
    clearElement(app);
    app.appendChild(
      createElement('div', { className: 'error-state' }, [
        createElement('p', { textContent: 'Failed to load the game. Please try again.' }),
        createElement('button', {
          className: 'home-btn secondary',
          textContent: '← Back to Home',
          onClick: () => {
            window.history.pushState({}, '', window.location.pathname);
            renderHome();
          },
        }),
      ])
    );
  }
}

// =============================================================================
// Twitch Embed
// =============================================================================

/**
 * Create a Twitch clip embed iframe
 */
function createTwitchEmbed(slug: string, containerId: string): HTMLIFrameElement | null {
  const container = document.getElementById(containerId);
  if (!container) return null;

  clearElement(container);

  // Create iframe for Twitch clip
  const iframe = createElement('iframe', {
    src: `https://clips.twitch.tv/embed?clip=${slug}&parent=${window.location.hostname}&autoplay=false`,
    className: 'twitch-embed',
    allowfullscreen: 'true',
    frameborder: '0',
  });

  container.appendChild(iframe);
  return iframe;
}

// =============================================================================
// Comparison Screen
// =============================================================================

/**
 * Render the comparison screen for the current round
 */
function renderComparison(): void {
  if (currentRound >= totalRounds) {
    renderGameOver();
    return;
  }

  const app = document.getElementById('app');
  if (!app) return;

  clearElement(app);

  const template = document.getElementById('comparisonTemplate') as HTMLTemplateElement | null;
  if (!template) return;

  const content = template.content.cloneNode(true) as DocumentFragment;

  renderHeaderSquares();

  // Render left clip
  const leftTitle = content.getElementById('leftTitle');
  const leftAuthor = content.getElementById('leftAuthor');
  if (leftTitle && currentClips.left) {
    leftTitle.textContent = currentClips.left.title || 'Untitled Clip';
  }
  if (leftAuthor && currentClips.left) {
    leftAuthor.textContent = currentClips.left.clippedBy
      ? `Clipped by ${currentClips.left.clippedBy}`
      : '';
  }

  // Render right clip
  const rightTitle = content.getElementById('rightTitle');
  const rightAuthor = content.getElementById('rightAuthor');
  if (rightTitle && currentClips.right) {
    rightTitle.textContent = currentClips.right.title || 'Untitled Clip';
  }
  if (rightAuthor && currentClips.right) {
    rightAuthor.textContent = currentClips.right.clippedBy
      ? `Clipped by ${currentClips.right.clippedBy}`
      : '';
  }

  // Add event listeners for choice buttons
  const leftChooseBtn = content.getElementById('leftChooseBtn');
  const rightChooseBtn = content.getElementById('rightChooseBtn');
  leftChooseBtn?.addEventListener('click', () => makeChoice('left'));
  rightChooseBtn?.addEventListener('click', () => makeChoice('right'));

  app.appendChild(content);

  // Create Twitch embeds after DOM is ready
  setTimeout(() => {
    if (currentClips.left) {
      twitchEmbeds.left = createTwitchEmbed(currentClips.left.twitchSlug, 'leftEmbed');
    }
    if (currentClips.right) {
      twitchEmbeds.right = createTwitchEmbed(currentClips.right.twitchSlug, 'rightEmbed');
    }
  }, 0);
}

// =============================================================================
// Choice & Result Handling
// =============================================================================

/**
 * Process the player's choice for the current round
 */
async function makeChoice(choice: PlayerChoice): Promise<void> {
  const leftBtn = document.getElementById('leftChooseBtn') as HTMLButtonElement | null;
  const rightBtn = document.getElementById('rightChooseBtn') as HTMLButtonElement | null;

  if (leftBtn) {
    leftBtn.disabled = true;
    leftBtn.textContent = 'Checking...';
  }
  if (rightBtn) {
    rightBtn.disabled = true;
    rightBtn.textContent = 'Checking...';
  }

  try {
    if (!currentClips.left || !currentClips.right) {
      throw new Error('Missing clip data');
    }

    const response = await fetch(
      `/api/clipdle/reveal?seed=${encodeURIComponent(currentSeed || '')}&left=${currentClips.left.id}&right=${currentClips.right.id}`
    );
    const result: RevealResponse = await response.json();

    const isCorrect: boolean = result.correct === 'tie' || choice === result.correct;

    roundResults.push(isCorrect);
    if (isCorrect) {
      score++;
    }

    renderHeaderSquares();
    showResult(result, choice, isCorrect);
    showContinueButton();
  } catch (error) {
    console.error('Error revealing choice:', error);
    if (leftBtn) {
      leftBtn.disabled = false;
      leftBtn.textContent = 'This One';
    }
    if (rightBtn) {
      rightBtn.disabled = false;
      rightBtn.textContent = 'This One';
    }
    alert('Error checking your choice. Please try again.');
  }
}

/**
 * Display the result with ELO reveal and highlighting
 */
function showResult(result: RevealResponse, choice: PlayerChoice, _isCorrect: boolean): void {
  const leftPanel = document.getElementById('leftPanel');
  const rightPanel = document.getElementById('rightPanel');
  const leftElo = document.getElementById('leftElo');
  const rightElo = document.getElementById('rightElo');

  // Show ELOs
  if (leftElo) {
    leftElo.textContent = `${result.leftElo} ELO`;
    leftElo.classList.add('show');
  }
  if (rightElo) {
    rightElo.textContent = `${result.rightElo} ELO`;
    rightElo.classList.add('show');
  }

  // Highlight the winner
  if (result.correct === 'left') {
    leftPanel?.classList.add('winner');
    leftElo?.classList.add('winner-elo');
  } else if (result.correct === 'right') {
    rightPanel?.classList.add('winner');
    rightElo?.classList.add('winner-elo');
  } else {
    // Tie
    leftPanel?.classList.add('winner');
    rightPanel?.classList.add('winner');
  }

  // Show which one user picked
  if (choice === 'left') {
    leftPanel?.classList.add('chosen');
  } else {
    rightPanel?.classList.add('chosen');
  }
}

/**
 * Show the continue button in the VS divider
 */
function showContinueButton(): void {
  const leftBtn = document.getElementById('leftChooseBtn') as HTMLElement | null;
  const rightBtn = document.getElementById('rightChooseBtn') as HTMLElement | null;

  if (leftBtn) leftBtn.style.display = 'none';
  if (rightBtn) rightBtn.style.display = 'none';

  const vsDivider = document.querySelector('.vs-divider') as HTMLElement | null;
  if (vsDivider) {
    vsDivider.innerHTML = '';

    const isLastRound: boolean = currentRound >= totalRounds - 1;
    const continueBtn = createElement('button', {
      className: 'continue-btn',
      textContent: isLastRound ? 'See Results' : 'Next Round',
      onClick: handleContinue,
    });
    vsDivider.appendChild(continueBtn);
  }
}

/**
 * Handle the continue button click - advance to next round or game over
 */
async function handleContinue(): Promise<void> {
  currentRound++;

  if (currentRound >= totalRounds) {
    renderGameOver();
    return;
  }

  const vsDivider = document.querySelector('.vs-divider') as HTMLElement | null;
  if (vsDivider) {
    vsDivider.innerHTML = '<span>Loading...</span>';
  }

  try {
    const response = await fetch(
      `/api/clipdle/round?seed=${encodeURIComponent(currentSeed || '')}&round=${currentRound}`
    );
    if (!response.ok) throw new Error('Failed to fetch round');

    const roundData: RoundDataResponse = await response.json();
    currentClips = { left: roundData.left, right: roundData.right };
    renderComparison();
  } catch (error) {
    console.error('Error fetching next round:', error);
    renderGameOver();
  }
}

// =============================================================================
// Game Over Screen
// =============================================================================

/**
 * Render the game over screen with final score and sharing options
 */
function renderGameOver(): void {
  const app = document.getElementById('app');
  if (!app) return;

  clearElement(app);

  const template = document.getElementById('gameOverTemplate') as HTMLTemplateElement | null;
  if (!template) return;

  const content = template.content.cloneNode(true) as DocumentFragment;

  const isPerfect: boolean = score === totalRounds;

  // Title
  const gameOverTitle = content.getElementById('gameOverTitle');
  if (gameOverTitle) {
    if (isPerfect) {
      gameOverTitle.textContent = 'Perfect Score!';
      gameOverTitle.classList.add('perfect');
    } else {
      gameOverTitle.textContent = 'Game Complete!';
    }
  }

  // Score
  const finalScore = content.getElementById('finalScore');
  if (finalScore) {
    finalScore.textContent = `${score}/${totalRounds}`;
  }

  renderHeaderSquares();

  // Seed display
  const displaySeed = content.getElementById('displaySeed');
  if (displaySeed && currentSeed) {
    displaySeed.textContent = currentSeed;
  }

  // Message
  let message: string;
  if (isPerfect) {
    message = `Incredible! You got all ${totalRounds} right!`;
  } else if (score >= totalRounds - 1) {
    message = "So close! Amazing run.";
  } else if (score >= Math.floor(totalRounds * 0.75)) {
    message = "Great job! You really know your clips.";
  } else if (score >= Math.floor(totalRounds * 0.5)) {
    message = "Not bad! You've got good taste.";
  } else {
    message = "Better luck next time!";
  }

  const gameOverMessage = content.getElementById('gameOverMessage');
  if (gameOverMessage) {
    gameOverMessage.textContent = message;
  }

  // Button event listeners
  const shareBtn = content.getElementById('shareBtn');
  shareBtn?.addEventListener('click', shareResults);

  const playAgainBtn = content.getElementById('playAgainBtn');
  playAgainBtn?.addEventListener('click', () => startGame(currentSeed || getTodaySeed()));

  const newRandomBtn = content.getElementById('newRandomBtn');
  newRandomBtn?.addEventListener('click', () => startGame(String(generateRandomSeed())));

  const homeBtn = content.getElementById('homeBtn');
  homeBtn?.addEventListener('click', () => {
    window.history.pushState({}, '', window.location.pathname);
    renderHome();
  });

  app.appendChild(content);
}

// =============================================================================
// Share Results
// =============================================================================

/**
 * Copy shareable results to clipboard
 */
function shareResults(): void {
  const isPerfect: boolean = score >= totalRounds;
  const streakEmoji: string = isPerfect
    ? '🏆'
    : score >= totalRounds - 1
      ? '🔥🔥🔥'
      : score >= Math.floor(totalRounds * 0.6)
        ? '🔥🔥'
        : score >= Math.floor(totalRounds * 0.4)
          ? '🔥'
          : '💫';

  // Build result grid
  const resultGrid: string = roundResults.map((r) => (r ? '🟩' : '🟥')).join('');

  const shareUrl = `${window.location.origin}?seed=${currentSeed}`;
  const dateStr: string = formatDateShort(currentSeed || '');
  const text = `🎬 Clipdle ${dateStr}
${score}/${totalRounds} ${streakEmoji}
${resultGrid}
${shareUrl}`;

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const btn = document.getElementById('shareBtn');
      if (btn) {
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
          btn.textContent = '📋 Share Results';
        }, 2000);
      }
    })
    .catch(() => {
      alert('Failed to copy. Please copy manually:\n\n' + text);
    });
}

// =============================================================================
// App Initialization
// =============================================================================

/**
 * Initialize the application
 */
function initApp(): void {
  const urlParams = new URLSearchParams(window.location.search);
  const seedParam = urlParams.get('seed');

  if (seedParam) {
    startGame(seedParam);
  } else {
    renderHome();
  }
}

// Handle browser back/forward navigation
window.addEventListener('popstate', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const seedParam = urlParams.get('seed');
  if (seedParam) {
    startGame(seedParam);
  } else {
    renderHome();
  }
});

// Start app on load
initApp();

// =============================================================================
// Global Window Exports (for onclick handlers in HTML)
// =============================================================================

declare global {
  interface Window {
    // Clipdle game functions
    initApp: typeof initApp;
    renderHome: typeof renderHome;
    startGame: typeof startGame;
    makeChoice: typeof makeChoice;
    handleContinue: typeof handleContinue;
    shareResults: typeof shareResults;
    // Utility functions
    getTodaySeed: typeof getTodaySeed;
    generateRandomSeed: typeof generateRandomSeed;
    formatDateShort: typeof formatDateShort;
  }
}

// Assign to window for global access (needed for inline onclick handlers)
window.initApp = initApp;
window.renderHome = renderHome;
window.startGame = startGame;
window.makeChoice = makeChoice;
window.handleContinue = handleContinue;
window.shareResults = shareResults;
window.getTodaySeed = getTodaySeed;
window.generateRandomSeed = generateRandomSeed;
window.formatDateShort = formatDateShort;

// Module exports
export {
  // Types
  type ClipdleClip,
  type CurrentClips,
  type TwitchEmbeds,
  type GameDataResponse,
  type RoundDataResponse,
  type RevealResponse,
  type PlayerChoice,
  // State
  currentSeed,
  currentRound,
  totalRounds,
  score,
  roundResults,
  currentClips,
  // Functions
  initApp,
  renderHome,
  startGame,
  renderComparison,
  makeChoice,
  handleContinue,
  renderGameOver,
  shareResults,
  // Utilities
  createElement,
  clearElement,
  getTodaySeed,
  generateRandomSeed,
  formatDateShort,
  resetGameState,
  renderHeaderSquares,
  createTwitchEmbed,
  showResult,
  showContinueButton,
};

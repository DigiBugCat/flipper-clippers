// Game state
let currentSeed = null;
let currentRound = 0;
let totalRounds = 8;
let score = 0;
let roundResults = []; // true = correct, false = incorrect
let currentClips = { left: null, right: null };
let twitchEmbeds = { left: null, right: null };

// Utility: Create element with attributes and children
function createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
        if (key === 'className') {
            el.className = value;
        } else if (key === 'textContent') {
            el.textContent = value;
        } else if (key.startsWith('on')) {
            el.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            el.setAttribute(key, value);
        }
    });
    children.forEach(child => {
        if (typeof child === 'string') {
            el.appendChild(document.createTextNode(child));
        } else if (child) {
            el.appendChild(child);
        }
    });
    return el;
}

// Utility: Clear element children
function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

// Get today's seed (YYYYMMDD format)
function getTodaySeed() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

// Generate random seed
function generateRandomSeed() {
    return Math.floor(Math.random() * 900000000) + 100000000;
}

// Format date for display (MM/DD)
function formatDateShort(seed) {
    if (seed.length === 8 && !isNaN(seed)) {
        const month = seed.slice(4, 6);
        const day = seed.slice(6, 8);
        return `${parseInt(month)}/${parseInt(day)}`;
    }
    return seed;
}

// Initialize app
function initApp() {
    const urlParams = new URLSearchParams(window.location.search);
    const seedParam = urlParams.get('seed');

    if (seedParam) {
        startGame(seedParam);
    } else {
        renderHome();
    }
}

// Render home screen
function renderHome() {
    const app = document.getElementById('app');
    clearElement(app);

    // Clear header squares
    const headerSquares = document.getElementById('headerSquares');
    if (headerSquares) clearElement(headerSquares);
    document.getElementById('gameSeed').textContent = formatDateShort(getTodaySeed());

    const template = document.getElementById('homeTemplate');
    const content = template.content.cloneNode(true);

    // Play Today's Challenge button
    content.getElementById('playDailyBtn').addEventListener('click', () => {
        startGame(getTodaySeed());
    });

    // Random Game button
    content.getElementById('playRandomBtn').addEventListener('click', () => {
        startGame(generateRandomSeed());
    });

    // Custom seed input
    content.getElementById('playSeedBtn').addEventListener('click', () => {
        const input = document.getElementById('customSeedInput');
        const seed = input.value.trim();
        if (seed) {
            startGame(seed);
        }
    });

    // Enter key on input
    content.getElementById('customSeedInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const seed = e.target.value.trim();
            if (seed) {
                startGame(seed);
            }
        }
    });

    app.appendChild(content);
}

// Reset game state
function resetGameState() {
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

// Render result squares in header
function renderHeaderSquares() {
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
            square.textContent = i + 1;
        } else {
            square.textContent = i + 1;
        }

        container.appendChild(square);
    }
}

// Start game with a specific seed
async function startGame(seed) {
    resetGameState();
    currentSeed = String(seed);

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('seed', currentSeed);
    window.history.pushState({}, '', url);

    const app = document.getElementById('app');
    clearElement(app);
    app.appendChild(createElement('div', { className: 'loading' }, [
        createElement('div', { className: 'loading-spinner' }),
        createElement('p', { textContent: 'Loading clips...' })
    ]));

    try {
        const response = await fetch(`/api/clipdle/game?seed=${encodeURIComponent(currentSeed)}`);
        if (!response.ok) throw new Error('Failed to load game');

        const gameData = await response.json();

        totalRounds = gameData.totalRounds;
        currentRound = 0;
        currentClips = { left: gameData.left, right: gameData.right };

        document.getElementById('gameSeed').textContent = `Seed: ${currentSeed}`;

        renderHeaderSquares();
        renderComparison();
    } catch (error) {
        console.error('Error loading game:', error);
        clearElement(app);
        app.appendChild(createElement('div', { className: 'error-state' }, [
            createElement('p', { textContent: 'Failed to load the game. Please try again.' }),
            createElement('button', {
                className: 'home-btn secondary',
                textContent: '← Back to Home',
                onClick: () => {
                    window.history.pushState({}, '', window.location.pathname);
                    renderHome();
                }
            })
        ]));
    }
}

// Create Twitch embed
function createTwitchEmbed(slug, containerId) {
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

// Render current comparison
function renderComparison() {
    if (currentRound >= totalRounds) {
        renderGameOver();
        return;
    }

    const app = document.getElementById('app');
    clearElement(app);

    const template = document.getElementById('comparisonTemplate');
    const content = template.content.cloneNode(true);

    renderHeaderSquares();

    // Render left clip
    const leftTitle = content.getElementById('leftTitle');
    const leftAuthor = content.getElementById('leftAuthor');
    leftTitle.textContent = currentClips.left.title || 'Untitled Clip';
    leftAuthor.textContent = currentClips.left.clippedBy ? `Clipped by ${currentClips.left.clippedBy}` : '';

    // Render right clip
    const rightTitle = content.getElementById('rightTitle');
    const rightAuthor = content.getElementById('rightAuthor');
    rightTitle.textContent = currentClips.right.title || 'Untitled Clip';
    rightAuthor.textContent = currentClips.right.clippedBy ? `Clipped by ${currentClips.right.clippedBy}` : '';

    // Add event listeners for choice buttons
    content.getElementById('leftChooseBtn').addEventListener('click', () => makeChoice('left'));
    content.getElementById('rightChooseBtn').addEventListener('click', () => makeChoice('right'));

    app.appendChild(content);

    // Create Twitch embeds after DOM is ready
    setTimeout(() => {
        createTwitchEmbed(currentClips.left.twitchSlug, 'leftEmbed');
        createTwitchEmbed(currentClips.right.twitchSlug, 'rightEmbed');
    }, 0);
}

// Make a choice
async function makeChoice(choice) {
    const leftBtn = document.getElementById('leftChooseBtn');
    const rightBtn = document.getElementById('rightChooseBtn');
    leftBtn.disabled = true;
    rightBtn.disabled = true;
    leftBtn.textContent = 'Checking...';
    rightBtn.textContent = 'Checking...';

    try {
        const response = await fetch(
            `/api/clipdle/reveal?seed=${encodeURIComponent(currentSeed)}&left=${currentClips.left.id}&right=${currentClips.right.id}`
        );
        const result = await response.json();

        const isCorrect = (result.correct === 'tie') || (choice === result.correct);

        roundResults.push(isCorrect);
        if (isCorrect) {
            score++;
        }

        renderHeaderSquares();
        showResult(result, choice, isCorrect);
        showContinueButton();
    } catch (error) {
        console.error('Error revealing choice:', error);
        leftBtn.disabled = false;
        rightBtn.disabled = false;
        leftBtn.textContent = 'This One';
        rightBtn.textContent = 'This One';
        alert('Error checking your choice. Please try again.');
    }
}

// Show result with ELO reveal
function showResult(result, choice, isCorrect) {
    const leftPanel = document.getElementById('leftPanel');
    const rightPanel = document.getElementById('rightPanel');
    const leftElo = document.getElementById('leftElo');
    const rightElo = document.getElementById('rightElo');

    // Show ELOs
    leftElo.textContent = `${result.leftElo} ELO`;
    rightElo.textContent = `${result.rightElo} ELO`;
    leftElo.classList.add('show');
    rightElo.classList.add('show');

    // Highlight the winner
    if (result.correct === 'left') {
        leftPanel.classList.add('winner');
        leftElo.classList.add('winner-elo');
    } else if (result.correct === 'right') {
        rightPanel.classList.add('winner');
        rightElo.classList.add('winner-elo');
    } else {
        // Tie
        leftPanel.classList.add('winner');
        rightPanel.classList.add('winner');
    }

    // Show which one user picked
    if (choice === 'left') {
        leftPanel.classList.add('chosen');
    } else {
        rightPanel.classList.add('chosen');
    }
}

// Show continue button
function showContinueButton() {
    const leftBtn = document.getElementById('leftChooseBtn');
    const rightBtn = document.getElementById('rightChooseBtn');
    leftBtn.style.display = 'none';
    rightBtn.style.display = 'none';

    const vsDivider = document.querySelector('.vs-divider');
    if (vsDivider) {
        vsDivider.innerHTML = '';

        const isLastRound = currentRound >= totalRounds - 1;
        const continueBtn = createElement('button', {
            className: 'continue-btn',
            textContent: isLastRound ? 'See Results' : 'Next Round',
            onClick: handleContinue
        });
        vsDivider.appendChild(continueBtn);
    }
}

// Handle continue button
async function handleContinue() {
    currentRound++;

    if (currentRound >= totalRounds) {
        renderGameOver();
        return;
    }

    const vsDivider = document.querySelector('.vs-divider');
    if (vsDivider) {
        vsDivider.innerHTML = '<span>Loading...</span>';
    }

    try {
        const response = await fetch(`/api/clipdle/round?seed=${encodeURIComponent(currentSeed)}&round=${currentRound}`);
        if (!response.ok) throw new Error('Failed to fetch round');

        const roundData = await response.json();
        currentClips = { left: roundData.left, right: roundData.right };
        renderComparison();
    } catch (error) {
        console.error('Error fetching next round:', error);
        renderGameOver();
    }
}

// Render game over screen
function renderGameOver() {
    const app = document.getElementById('app');
    clearElement(app);

    const template = document.getElementById('gameOverTemplate');
    const content = template.content.cloneNode(true);

    const isPerfect = score === totalRounds;

    // Title
    if (isPerfect) {
        content.getElementById('gameOverTitle').textContent = 'Perfect Score!';
        content.getElementById('gameOverTitle').classList.add('perfect');
    } else {
        content.getElementById('gameOverTitle').textContent = 'Game Complete!';
    }

    // Score
    content.getElementById('finalScore').textContent = `${score}/${totalRounds}`;

    renderHeaderSquares();

    // Seed display
    content.getElementById('displaySeed').textContent = currentSeed;

    // Message
    let message;
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
    content.getElementById('gameOverMessage').textContent = message;

    // Button event listeners
    content.getElementById('shareBtn').addEventListener('click', shareResults);
    content.getElementById('playAgainBtn').addEventListener('click', () => startGame(currentSeed));
    content.getElementById('newRandomBtn').addEventListener('click', () => startGame(generateRandomSeed()));
    content.getElementById('homeBtn').addEventListener('click', () => {
        window.history.pushState({}, '', window.location.pathname);
        renderHome();
    });

    app.appendChild(content);
}

// Share results
function shareResults() {
    const isPerfect = score >= totalRounds;
    const streakEmoji = isPerfect ? '🏆' :
                        score >= totalRounds - 1 ? '🔥🔥🔥' :
                        score >= Math.floor(totalRounds * 0.6) ? '🔥🔥' :
                        score >= Math.floor(totalRounds * 0.4) ? '🔥' : '💫';

    // Build result grid
    const resultGrid = roundResults.map(r => r ? '🟩' : '🟥').join('');

    const shareUrl = `${window.location.origin}?seed=${currentSeed}`;
    const dateStr = formatDateShort(currentSeed);
    const text = `🎬 Clipdle ${dateStr}
${score}/${totalRounds} ${streakEmoji}
${resultGrid}
${shareUrl}`;

    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('shareBtn');
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
            btn.textContent = '📋 Share Results';
        }, 2000);
    }).catch(() => {
        alert('Failed to copy. Please copy manually:\n\n' + text);
    });
}

// Handle browser back/forward
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

"use strict";
(() => {
  // src/frontend/clipdle/game.ts
  var currentSeed = null;
  var currentRound = 0;
  var totalRounds = 8;
  var score = 0;
  var roundResults = [];
  var currentClips = { left: null, right: null };
  var twitchEmbeds = { left: null, right: null };
  function createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === void 0) return;
      if (key === "className") {
        el.className = value;
      } else if (key === "textContent") {
        el.textContent = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        el.setAttribute(key, value);
      }
    });
    children.forEach((child) => {
      if (typeof child === "string") {
        el.appendChild(document.createTextNode(child));
      } else if (child) {
        el.appendChild(child);
      }
    });
    return el;
  }
  function clearElement(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }
  function getTodaySeed() {
    const now = /* @__PURE__ */ new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }
  function generateRandomSeed() {
    return Math.floor(Math.random() * 9e8) + 1e8;
  }
  function formatDateShort(seed) {
    if (seed.length === 8 && !isNaN(Number(seed))) {
      const month = seed.slice(4, 6);
      const day = seed.slice(6, 8);
      return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
    }
    return seed;
  }
  function resetGameState() {
    currentRound = 0;
    score = 0;
    roundResults = [];
    currentClips = { left: null, right: null };
    if (twitchEmbeds.left) {
      twitchEmbeds.left = null;
    }
    if (twitchEmbeds.right) {
      twitchEmbeds.right = null;
    }
  }
  function renderHeaderSquares() {
    const container = document.getElementById("headerSquares");
    if (!container) return;
    clearElement(container);
    for (let i = 0; i < totalRounds; i++) {
      const square = createElement("div", { className: "result-square" });
      if (i < roundResults.length) {
        if (roundResults[i]) {
          square.classList.add("correct");
          square.textContent = "\u2713";
        } else {
          square.classList.add("incorrect");
          square.textContent = "\u2717";
        }
      } else if (i === currentRound) {
        square.classList.add("current");
        square.textContent = String(i + 1);
      } else {
        square.textContent = String(i + 1);
      }
      container.appendChild(square);
    }
  }
  function renderHome() {
    const app = document.getElementById("app");
    if (!app) return;
    clearElement(app);
    const headerSquares = document.getElementById("headerSquares");
    if (headerSquares) clearElement(headerSquares);
    const gameSeed = document.getElementById("gameSeed");
    if (gameSeed) {
      gameSeed.textContent = formatDateShort(getTodaySeed());
    }
    const template = document.getElementById("homeTemplate");
    if (!template) return;
    const content = template.content.cloneNode(true);
    const playDailyBtn = content.getElementById("playDailyBtn");
    playDailyBtn?.addEventListener("click", () => {
      startGame(getTodaySeed());
    });
    const playRandomBtn = content.getElementById("playRandomBtn");
    playRandomBtn?.addEventListener("click", () => {
      startGame(String(generateRandomSeed()));
    });
    const playSeedBtn = content.getElementById("playSeedBtn");
    playSeedBtn?.addEventListener("click", () => {
      const input = document.getElementById("customSeedInput");
      const seed = input?.value.trim();
      if (seed) {
        startGame(seed);
      }
    });
    const customSeedInput = content.getElementById("customSeedInput");
    customSeedInput?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        const target = e.target;
        const seed = target.value.trim();
        if (seed) {
          startGame(seed);
        }
      }
    });
    app.appendChild(content);
  }
  async function startGame(seed) {
    resetGameState();
    currentSeed = String(seed);
    const url = new URL(window.location.href);
    url.searchParams.set("seed", currentSeed);
    window.history.pushState({}, "", url.toString());
    const app = document.getElementById("app");
    if (!app) return;
    clearElement(app);
    app.appendChild(
      createElement("div", { className: "loading" }, [
        createElement("div", { className: "loading-spinner" }),
        createElement("p", { textContent: "Loading clips..." })
      ])
    );
    try {
      const response = await fetch(`/api/clipdle/game?seed=${encodeURIComponent(currentSeed)}`);
      if (!response.ok) throw new Error("Failed to load game");
      const gameData = await response.json();
      totalRounds = gameData.totalRounds;
      currentRound = 0;
      currentClips = { left: gameData.left, right: gameData.right };
      const gameSeedEl = document.getElementById("gameSeed");
      if (gameSeedEl) {
        gameSeedEl.textContent = `Seed: ${currentSeed}`;
      }
      renderHeaderSquares();
      renderComparison();
    } catch (error) {
      console.error("Error loading game:", error);
      clearElement(app);
      app.appendChild(
        createElement("div", { className: "error-state" }, [
          createElement("p", { textContent: "Failed to load the game. Please try again." }),
          createElement("button", {
            className: "home-btn secondary",
            textContent: "\u2190 Back to Home",
            onClick: () => {
              window.history.pushState({}, "", window.location.pathname);
              renderHome();
            }
          })
        ])
      );
    }
  }
  function createTwitchEmbed(slug, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    clearElement(container);
    const iframe = createElement("iframe", {
      src: `https://clips.twitch.tv/embed?clip=${slug}&parent=${window.location.hostname}&autoplay=false`,
      className: "twitch-embed",
      allowfullscreen: "true",
      frameborder: "0"
    });
    container.appendChild(iframe);
    return iframe;
  }
  function renderComparison() {
    if (currentRound >= totalRounds) {
      renderGameOver();
      return;
    }
    const app = document.getElementById("app");
    if (!app) return;
    clearElement(app);
    const template = document.getElementById("comparisonTemplate");
    if (!template) return;
    const content = template.content.cloneNode(true);
    renderHeaderSquares();
    const leftTitle = content.getElementById("leftTitle");
    const leftAuthor = content.getElementById("leftAuthor");
    if (leftTitle && currentClips.left) {
      leftTitle.textContent = currentClips.left.title || "Untitled Clip";
    }
    if (leftAuthor && currentClips.left) {
      leftAuthor.textContent = currentClips.left.clippedBy ? `Clipped by ${currentClips.left.clippedBy}` : "";
    }
    const rightTitle = content.getElementById("rightTitle");
    const rightAuthor = content.getElementById("rightAuthor");
    if (rightTitle && currentClips.right) {
      rightTitle.textContent = currentClips.right.title || "Untitled Clip";
    }
    if (rightAuthor && currentClips.right) {
      rightAuthor.textContent = currentClips.right.clippedBy ? `Clipped by ${currentClips.right.clippedBy}` : "";
    }
    const leftChooseBtn = content.getElementById("leftChooseBtn");
    const rightChooseBtn = content.getElementById("rightChooseBtn");
    leftChooseBtn?.addEventListener("click", () => makeChoice("left"));
    rightChooseBtn?.addEventListener("click", () => makeChoice("right"));
    app.appendChild(content);
    setTimeout(() => {
      if (currentClips.left) {
        twitchEmbeds.left = createTwitchEmbed(currentClips.left.twitchSlug, "leftEmbed");
      }
      if (currentClips.right) {
        twitchEmbeds.right = createTwitchEmbed(currentClips.right.twitchSlug, "rightEmbed");
      }
    }, 0);
  }
  async function makeChoice(choice) {
    const leftBtn = document.getElementById("leftChooseBtn");
    const rightBtn = document.getElementById("rightChooseBtn");
    if (leftBtn) {
      leftBtn.disabled = true;
      leftBtn.textContent = "Checking...";
    }
    if (rightBtn) {
      rightBtn.disabled = true;
      rightBtn.textContent = "Checking...";
    }
    try {
      if (!currentClips.left || !currentClips.right) {
        throw new Error("Missing clip data");
      }
      const response = await fetch(
        `/api/clipdle/reveal?seed=${encodeURIComponent(currentSeed || "")}&left=${currentClips.left.id}&right=${currentClips.right.id}`
      );
      const result = await response.json();
      const isCorrect = result.correct === "tie" || choice === result.correct;
      roundResults.push(isCorrect);
      if (isCorrect) {
        score++;
      }
      renderHeaderSquares();
      showResult(result, choice, isCorrect);
      showContinueButton();
    } catch (error) {
      console.error("Error revealing choice:", error);
      if (leftBtn) {
        leftBtn.disabled = false;
        leftBtn.textContent = "This One";
      }
      if (rightBtn) {
        rightBtn.disabled = false;
        rightBtn.textContent = "This One";
      }
      alert("Error checking your choice. Please try again.");
    }
  }
  function showResult(result, choice, _isCorrect) {
    const leftPanel = document.getElementById("leftPanel");
    const rightPanel = document.getElementById("rightPanel");
    const leftElo = document.getElementById("leftElo");
    const rightElo = document.getElementById("rightElo");
    if (leftElo) {
      leftElo.textContent = `${result.leftElo} ELO`;
      leftElo.classList.add("show");
    }
    if (rightElo) {
      rightElo.textContent = `${result.rightElo} ELO`;
      rightElo.classList.add("show");
    }
    if (result.correct === "left") {
      leftPanel?.classList.add("winner");
      leftElo?.classList.add("winner-elo");
    } else if (result.correct === "right") {
      rightPanel?.classList.add("winner");
      rightElo?.classList.add("winner-elo");
    } else {
      leftPanel?.classList.add("winner");
      rightPanel?.classList.add("winner");
    }
    if (choice === "left") {
      leftPanel?.classList.add("chosen");
    } else {
      rightPanel?.classList.add("chosen");
    }
  }
  function showContinueButton() {
    const leftBtn = document.getElementById("leftChooseBtn");
    const rightBtn = document.getElementById("rightChooseBtn");
    if (leftBtn) leftBtn.style.display = "none";
    if (rightBtn) rightBtn.style.display = "none";
    const vsDivider = document.querySelector(".vs-divider");
    if (vsDivider) {
      vsDivider.innerHTML = "";
      const isLastRound = currentRound >= totalRounds - 1;
      const continueBtn = createElement("button", {
        className: "continue-btn",
        textContent: isLastRound ? "See Results" : "Next Round",
        onClick: handleContinue
      });
      vsDivider.appendChild(continueBtn);
    }
  }
  async function handleContinue() {
    currentRound++;
    if (currentRound >= totalRounds) {
      renderGameOver();
      return;
    }
    const vsDivider = document.querySelector(".vs-divider");
    if (vsDivider) {
      vsDivider.innerHTML = "<span>Loading...</span>";
    }
    try {
      const response = await fetch(
        `/api/clipdle/round?seed=${encodeURIComponent(currentSeed || "")}&round=${currentRound}`
      );
      if (!response.ok) throw new Error("Failed to fetch round");
      const roundData = await response.json();
      currentClips = { left: roundData.left, right: roundData.right };
      renderComparison();
    } catch (error) {
      console.error("Error fetching next round:", error);
      renderGameOver();
    }
  }
  function renderGameOver() {
    const app = document.getElementById("app");
    if (!app) return;
    clearElement(app);
    const template = document.getElementById("gameOverTemplate");
    if (!template) return;
    const content = template.content.cloneNode(true);
    const isPerfect = score === totalRounds;
    const gameOverTitle = content.getElementById("gameOverTitle");
    if (gameOverTitle) {
      if (isPerfect) {
        gameOverTitle.textContent = "Perfect Score!";
        gameOverTitle.classList.add("perfect");
      } else {
        gameOverTitle.textContent = "Game Complete!";
      }
    }
    const finalScore = content.getElementById("finalScore");
    if (finalScore) {
      finalScore.textContent = `${score}/${totalRounds}`;
    }
    renderHeaderSquares();
    const displaySeed = content.getElementById("displaySeed");
    if (displaySeed && currentSeed) {
      displaySeed.textContent = currentSeed;
    }
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
    const gameOverMessage = content.getElementById("gameOverMessage");
    if (gameOverMessage) {
      gameOverMessage.textContent = message;
    }
    const shareBtn = content.getElementById("shareBtn");
    shareBtn?.addEventListener("click", shareResults);
    const playAgainBtn = content.getElementById("playAgainBtn");
    playAgainBtn?.addEventListener("click", () => startGame(currentSeed || getTodaySeed()));
    const newRandomBtn = content.getElementById("newRandomBtn");
    newRandomBtn?.addEventListener("click", () => startGame(String(generateRandomSeed())));
    const homeBtn = content.getElementById("homeBtn");
    homeBtn?.addEventListener("click", () => {
      window.history.pushState({}, "", window.location.pathname);
      renderHome();
    });
    app.appendChild(content);
  }
  function shareResults() {
    const isPerfect = score >= totalRounds;
    const streakEmoji = isPerfect ? "\u{1F3C6}" : score >= totalRounds - 1 ? "\u{1F525}\u{1F525}\u{1F525}" : score >= Math.floor(totalRounds * 0.6) ? "\u{1F525}\u{1F525}" : score >= Math.floor(totalRounds * 0.4) ? "\u{1F525}" : "\u{1F4AB}";
    const resultGrid = roundResults.map((r) => r ? "\u{1F7E9}" : "\u{1F7E5}").join("");
    const shareUrl = `${window.location.origin}?seed=${currentSeed}`;
    const dateStr = formatDateShort(currentSeed || "");
    const text = `\u{1F3AC} Clipdle ${dateStr}
${score}/${totalRounds} ${streakEmoji}
${resultGrid}
${shareUrl}`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("shareBtn");
      if (btn) {
        btn.textContent = "\u2713 Copied!";
        setTimeout(() => {
          btn.textContent = "\u{1F4CB} Share Results";
        }, 2e3);
      }
    }).catch(() => {
      alert("Failed to copy. Please copy manually:\n\n" + text);
    });
  }
  function initApp() {
    const urlParams = new URLSearchParams(window.location.search);
    const seedParam = urlParams.get("seed");
    if (seedParam) {
      startGame(seedParam);
    } else {
      renderHome();
    }
  }
  window.addEventListener("popstate", () => {
    const urlParams = new URLSearchParams(window.location.search);
    const seedParam = urlParams.get("seed");
    if (seedParam) {
      startGame(seedParam);
    } else {
      renderHome();
    }
  });
  initApp();
  window.initApp = initApp;
  window.renderHome = renderHome;
  window.startGame = startGame;
  window.makeChoice = makeChoice;
  window.handleContinue = handleContinue;
  window.shareResults = shareResults;
  window.getTodaySeed = getTodaySeed;
  window.generateRandomSeed = generateRandomSeed;
  window.formatDateShort = formatDateShort;
})();
//# sourceMappingURL=game.js.map

"use strict";
(() => {
  // src/frontend/compare.ts
  var clipA = null;
  var clipB = null;
  var startTime = null;
  var isLoading = false;
  var savedStates = { a: false, b: false };
  var isRankingMode = false;
  var isRerankMode = false;
  var rankingClipId = null;
  var rankingClip = null;
  var prefetchedPairs = [];
  var prefetchInProgress = false;
  var PREFETCH_THRESHOLD = 3;
  var PREFETCH_COUNT = 3;
  var localComparisons = 0;
  var localSuperLikes = 0;
  var preloadedSlugA = null;
  var preloadedSlugB = null;
  function prefetchThumbnail(twitchSlug) {
    const thumbnailUrl = `https://clips-media-assets2.twitch.tv/${twitchSlug}-preview-480x272.jpg`;
    if (document.querySelector(`link[href="${thumbnailUrl}"]`)) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "image";
    link.href = thumbnailUrl;
    document.head.appendChild(link);
  }
  function preloadEmbedInPlace(slug, wrapperId, overlayId) {
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    document.getElementById(overlayId)?.remove();
    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.className = "preload-overlay";
    overlay.innerHTML = `
    <iframe
      src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false"
      allowfullscreen
    ></iframe>
  `;
    wrapper.appendChild(overlay);
    console.debug(`[Preload] Created in-place overlay for ${slug}`);
  }
  function preloadNextPairInPlace(nextClipA, nextClipB) {
    preloadEmbedInPlace(nextClipA.twitchSlug, "video-wrapper-a", "preload-a");
    preloadEmbedInPlace(nextClipB.twitchSlug, "video-wrapper-b", "preload-b");
    preloadedSlugA = nextClipA.twitchSlug;
    preloadedSlugB = nextClipB.twitchSlug;
  }
  function showEmbed(slug, wrapperId, overlayId, currentId) {
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    document.getElementById(currentId)?.remove();
    const preload = document.getElementById(overlayId);
    const preloadedSlug = overlayId === "preload-a" ? preloadedSlugA : preloadedSlugB;
    if (preload && preloadedSlug === slug) {
      preload.classList.add("active");
      preload.id = currentId;
      console.debug(`[Preload] Activated preloaded embed for ${slug}`);
    } else {
      preload?.remove();
      const div = document.createElement("div");
      div.id = currentId;
      div.className = "preload-overlay active";
      div.innerHTML = `
      <iframe
        src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=false"
        allowfullscreen
      ></iframe>
    `;
      wrapper.appendChild(div);
    }
    if (overlayId === "preload-a") preloadedSlugA = null;
    else preloadedSlugB = null;
  }
  async function prefetchUpcomingPairs() {
    if (prefetchInProgress) return;
    prefetchInProgress = true;
    try {
      const response = await fetch(`/api/compare/peek?count=${PREFETCH_COUNT}`);
      if (!response.ok) {
        console.debug("Prefetch peek failed:", response.status);
        return;
      }
      const data = await response.json();
      prefetchedPairs = data.pairs;
      for (const pair of data.pairs) {
        prefetchThumbnail(pair.clipA.twitchSlug);
        prefetchThumbnail(pair.clipB.twitchSlug);
      }
      if (data.pairs.length > 0) {
        preloadNextPairInPlace(data.pairs[0].clipA, data.pairs[0].clipB);
      }
      console.debug(`[Prefetch] ${data.pairs.length} pairs, ${data.remainingCount} remaining in batch`);
    } catch (error) {
      console.debug("Prefetch failed:", error);
    } finally {
      prefetchInProgress = false;
    }
  }
  function updateUrl(a, b, replace = false) {
    const url = `/compare?a=${a.id}&b=${b.id}`;
    const state = { clipA: a, clipB: b };
    if (replace) {
      history.replaceState(state, "", url);
    } else {
      history.pushState(state, "", url);
    }
  }
  function displayClips(a, b) {
    clipA = a;
    clipB = b;
    startTime = Date.now();
    const titleA = document.getElementById("title-a");
    const titleB = document.getElementById("title-b");
    if (titleA) titleA.textContent = a.title || a.twitchSlug;
    if (titleB) titleB.textContent = b.title || b.twitchSlug;
    const clippedByA = document.getElementById("clipped-by-a");
    const clippedByB = document.getElementById("clipped-by-b");
    if (clippedByA) clippedByA.textContent = `Clipped by ${a.clippedBy || "Unknown"}`;
    if (clippedByB) clippedByB.textContent = `Clipped by ${b.clippedBy || "Unknown"}`;
    const clippedAtA = document.getElementById("clipped-at-a");
    const clippedAtB = document.getElementById("clipped-at-b");
    if (clippedAtA) clippedAtA.textContent = a.clippedAt ? window.formatDate(a.clippedAt) : "";
    if (clippedAtB) clippedAtB.textContent = b.clippedAt ? window.formatDate(b.clippedAt) : "";
    const linkA = document.getElementById("link-a");
    const linkB = document.getElementById("link-b");
    if (linkA) linkA.href = a.twitchUrl || `https://clips.twitch.tv/${a.twitchSlug}`;
    if (linkB) linkB.href = b.twitchUrl || `https://clips.twitch.tv/${b.twitchSlug}`;
    showEmbed(a.twitchSlug, "video-wrapper-a", "preload-a", "current-a");
    showEmbed(b.twitchSlug, "video-wrapper-b", "preload-b", "current-b");
    checkSavedStates();
  }
  async function loadSpecificPair(aId, bId) {
    if (isLoading) return;
    isLoading = true;
    showLoading(true);
    try {
      const response = await fetch(`/api/compare/pair?a=${aId}&b=${bId}`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/api/auth/login";
          return;
        }
        if (response.status === 404) {
          await loadNextPair();
          return;
        }
        throw new Error("Failed to load clips");
      }
      const data = await response.json();
      displayClips(data.clipA, data.clipB);
      updateUrl(data.clipA, data.clipB, true);
      await checkSavedStates();
      showLoading(false);
    } catch (error) {
      console.error("Failed to load specific pair:", error);
      window.showToast("Failed to load clips", "error");
      showLoading(false);
    } finally {
      isLoading = false;
    }
  }
  function updateSaveButtons() {
    const saveA = document.getElementById("save-a");
    const saveB = document.getElementById("save-b");
    if (saveA) {
      saveA.textContent = savedStates.a ? "\u2605" : "\u2606";
      saveA.classList.toggle("saved", savedStates.a);
      saveA.title = savedStates.a ? "Unsave clip" : "Save clip";
    }
    if (saveB) {
      saveB.textContent = savedStates.b ? "\u2605" : "\u2606";
      saveB.classList.toggle("saved", savedStates.b);
      saveB.title = savedStates.b ? "Unsave clip" : "Save clip";
    }
  }
  async function checkSavedStates() {
    if (!clipA || !clipB) return;
    try {
      const response = await fetch("/api/saved/check-multiple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: [clipA.id, clipB.id] })
      });
      if (response.ok) {
        const data = await response.json();
        savedStates.a = data.saved[clipA.id] || false;
        savedStates.b = data.saved[clipB.id] || false;
        updateSaveButtons();
      }
    } catch (error) {
      console.error("Failed to check saved states:", error);
    }
  }
  async function toggleSave(side) {
    const clip = side === "a" ? clipA : clipB;
    if (!clip) return;
    const isSaved = savedStates[side];
    try {
      const response = await fetch(`/api/saved/${clip.id}`, {
        method: isSaved ? "DELETE" : "POST"
      });
      if (response.ok) {
        savedStates[side] = !isSaved;
        updateSaveButtons();
        window.showToast(savedStates[side] ? "Clip saved!" : "Clip unsaved", "success");
      } else {
        throw new Error("Failed to update save state");
      }
    } catch (error) {
      console.error("Failed to toggle save:", error);
      window.showToast("Failed to save clip", "error");
    }
  }
  async function loadStats() {
    try {
      const response = await fetch("/api/compare/stats");
      if (!response.ok) return;
      const data = await response.json();
      localComparisons = data.totalComparisons || 0;
      localSuperLikes = data.totalSuperLikes || 0;
      const comparisonsEl = document.getElementById("user-comparisons");
      const superLikesEl = document.getElementById("user-super-likes");
      const coverageEl = document.getElementById("coverage-percent");
      if (comparisonsEl) {
        comparisonsEl.textContent = window.formatNumber(localComparisons);
      }
      if (superLikesEl) {
        superLikesEl.textContent = window.formatNumber(localSuperLikes);
      }
      if (coverageEl) {
        coverageEl.textContent = `${data.coveragePercent?.toFixed(1) || "0"}%`;
        coverageEl.title = `${data.userComparisons || 0} unique pairs out of ${data.totalPossiblePairs || 0} possible`;
      }
    } catch (error) {
      console.error("Failed to load stats:", error);
    }
  }
  async function loadNextPair() {
    if (isLoading) return;
    isLoading = true;
    showLoading(true);
    try {
      const response = await fetch("/api/compare/next");
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = "/api/auth/login";
          return;
        }
        throw new Error("Failed to load clips");
      }
      const data = await response.json();
      clipA = data.clipA;
      clipB = data.clipB;
      startTime = Date.now();
      const titleA = document.getElementById("title-a");
      const titleB = document.getElementById("title-b");
      if (titleA) titleA.textContent = clipA.title || clipA.twitchSlug;
      if (titleB) titleB.textContent = clipB.title || clipB.twitchSlug;
      const clippedByA = document.getElementById("clipped-by-a");
      const clippedByB = document.getElementById("clipped-by-b");
      if (clippedByA) clippedByA.textContent = `Clipped by ${clipA.clippedBy || "Unknown"}`;
      if (clippedByB) clippedByB.textContent = `Clipped by ${clipB.clippedBy || "Unknown"}`;
      const clippedAtA = document.getElementById("clipped-at-a");
      const clippedAtB = document.getElementById("clipped-at-b");
      if (clippedAtA) clippedAtA.textContent = clipA.clippedAt ? window.formatDate(clipA.clippedAt) : "";
      if (clippedAtB) clippedAtB.textContent = clipB.clippedAt ? window.formatDate(clipB.clippedAt) : "";
      const linkA = document.getElementById("link-a");
      const linkB = document.getElementById("link-b");
      if (linkA) {
        linkA.href = clipA.twitchUrl || `https://clips.twitch.tv/${clipA.twitchSlug}`;
      }
      if (linkB) {
        linkB.href = clipB.twitchUrl || `https://clips.twitch.tv/${clipB.twitchSlug}`;
      }
      showEmbed(clipA.twitchSlug, "video-wrapper-a", "preload-a", "current-a");
      showEmbed(clipB.twitchSlug, "video-wrapper-b", "preload-b", "current-b");
      updateUrl(clipA, clipB);
      await checkSavedStates();
      showLoading(false);
      if (typeof data.remainingPairs === "number" && data.remainingPairs <= PREFETCH_THRESHOLD) {
        prefetchUpcomingPairs();
      }
    } catch (error) {
      console.error("Failed to load clips:", error);
      window.showToast("Failed to load clips", "error");
      showLoading(false);
    } finally {
      isLoading = false;
    }
  }
  async function vote(result) {
    if (isLoading || !clipA || !clipB) return;
    if (isRankingMode) {
      await submitRankingVote(result);
      return;
    }
    isLoading = true;
    try {
      const response = await fetch("/api/compare/vote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          clip_a_id: clipA.id,
          clip_b_id: clipB.id,
          result,
          time_spent_ms: startTime ? Date.now() - startTime : 0
        })
      });
      if (!response.ok) {
        throw new Error("Vote failed");
      }
      const data = await response.json();
      localComparisons++;
      if (result.startsWith("super")) {
        localSuperLikes++;
      }
      const comparisonsEl = document.getElementById("user-comparisons");
      const superLikesEl = document.getElementById("user-super-likes");
      if (comparisonsEl) {
        comparisonsEl.textContent = window.formatNumber(localComparisons);
      }
      if (superLikesEl) {
        superLikesEl.textContent = window.formatNumber(localSuperLikes);
      }
      if (result.startsWith("super")) {
        window.showToast("Super Like!", "success");
      }
      isLoading = false;
      await loadNextPair();
    } catch (error) {
      console.error("Vote failed:", error);
      window.showToast("Failed to submit vote", "error");
      isLoading = false;
    }
  }
  function showLoading(show) {
    const loadingState = document.getElementById("loading-state");
    const comparisonContainer = document.getElementById("comparison-container");
    const actionButtons = document.querySelectorAll(".action-buttons");
    if (show) {
      if (loadingState) loadingState.classList.remove("hidden");
      if (comparisonContainer) comparisonContainer.style.opacity = "0.5";
      actionButtons.forEach((btn) => btn.style.pointerEvents = "none");
    } else {
      if (loadingState) loadingState.classList.add("hidden");
      if (comparisonContainer) comparisonContainer.style.opacity = "1";
      actionButtons.forEach((btn) => btn.style.pointerEvents = "auto");
    }
  }
  async function initRankingMode(clipId, isRerank = false) {
    isRankingMode = true;
    isRerankMode = isRerank;
    rankingClipId = clipId;
    showLoading(true);
    try {
      const response = await fetch(`/api/clips/rank-session/${clipId}`);
      if (!response.ok) {
        if (response.status === 404) {
          window.showToast("Ranking session not found or expired", "error");
          window.location.href = "/leaderboard";
          return;
        }
        throw new Error("Failed to load ranking session");
      }
      const data = await response.json();
      rankingClip = data.clipToRank;
      updateRankingModeUI(data);
      displayRankingComparison(data.clipToRank, data.compareWith, data.progress);
      showLoading(false);
    } catch (error) {
      console.error("Failed to initialize ranking mode:", error);
      window.showToast("Failed to load ranking session", "error");
      showLoading(false);
    }
  }
  function updateRankingModeUI(data) {
    const skipBtn = document.querySelector(".btn-vote--skip");
    if (skipBtn) {
      const parentElement = skipBtn.parentElement;
      if (parentElement) {
        parentElement.style.display = "none";
      }
    }
    const progressEl = document.getElementById("ranking-progress");
    if (progressEl && data.progress) {
      progressEl.textContent = `Step ${data.progress.step} of ${data.progress.totalSteps}`;
      progressEl.classList.remove("hidden");
    }
    const shortcuts = document.querySelector(".shortcuts");
    if (shortcuts) {
      const clipLabel = isRerankMode ? "This clip" : "New clip";
      shortcuts.innerHTML = `
      <span class="key">1</span> ${clipLabel} is better
      <span class="key">2</span> Other clip is better
      <span class="key">T</span> Tie
    `;
    }
  }
  function displayRankingComparison(clipToRank, compareWith, progress) {
    clipA = clipToRank;
    clipB = compareWith;
    startTime = Date.now();
    const titleA = document.getElementById("title-a");
    const titleB = document.getElementById("title-b");
    const label = isRerankMode ? "(RERANKING)" : "(NEW)";
    if (titleA) titleA.textContent = (clipToRank?.title || clipToRank?.twitchSlug) + " " + label;
    if (titleB) titleB.textContent = compareWith?.title || compareWith?.twitchSlug;
    const clippedByA = document.getElementById("clipped-by-a");
    const clippedByB = document.getElementById("clipped-by-b");
    if (clippedByA) clippedByA.textContent = "";
    if (clippedByB) clippedByB.textContent = "";
    const clippedAtA = document.getElementById("clipped-at-a");
    const clippedAtB = document.getElementById("clipped-at-b");
    if (clippedAtA) clippedAtA.textContent = "";
    if (clippedAtB) clippedAtB.textContent = "";
    const linkA = document.getElementById("link-a");
    const linkB = document.getElementById("link-b");
    if (linkA && clipToRank)
      linkA.href = clipToRank.twitchUrl || `https://clips.twitch.tv/${clipToRank.twitchSlug}`;
    if (linkB && compareWith)
      linkB.href = compareWith.twitchUrl || `https://clips.twitch.tv/${compareWith.twitchSlug}`;
    if (clipToRank) showEmbed(clipToRank.twitchSlug, "video-wrapper-a", "preload-a", "current-a");
    if (compareWith) showEmbed(compareWith.twitchSlug, "video-wrapper-b", "preload-b", "current-b");
    const progressEl = document.getElementById("ranking-progress");
    if (progressEl && progress) {
      progressEl.textContent = `Step ${progress.step} of ${progress.totalSteps}`;
    }
  }
  async function submitRankingVote(result) {
    if (isLoading) return;
    isLoading = true;
    showLoading(true);
    let rankingResult;
    if (result === "clip_a" || result === "super_a") {
      rankingResult = "submitted";
    } else if (result === "clip_b" || result === "super_b") {
      rankingResult = "existing";
    } else {
      rankingResult = "tie";
    }
    try {
      const response = await fetch(`/api/clips/rank-session/${rankingClipId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: rankingResult })
      });
      if (!response.ok) {
        throw new Error("Failed to submit ranking vote");
      }
      const data = await response.json();
      if (data.done) {
        const action = isRerankMode ? "reranked" : "ranked";
        window.showToast(`Clip ${action} at position #${data.finalPosition}!`, "success");
        setTimeout(() => {
          window.location.href = "/leaderboard?tab=personal";
        }, 1500);
      } else {
        if (rankingClip && data.compareWith && data.progress) {
          displayRankingComparison(rankingClip, data.compareWith, data.progress);
        }
        showLoading(false);
      }
    } catch (error) {
      console.error("Failed to submit ranking vote:", error);
      window.showToast("Failed to submit vote", "error");
      showLoading(false);
    } finally {
      isLoading = false;
    }
  }
  function setupEventListeners() {
    document.getElementById("save-a")?.addEventListener("click", () => toggleSave("a"));
    document.getElementById("save-b")?.addEventListener("click", () => toggleSave("b"));
    document.getElementById("vote-super-a")?.addEventListener("click", () => vote("super_a"));
    document.getElementById("vote-clip-a")?.addEventListener("click", () => vote("clip_a"));
    document.getElementById("vote-tie")?.addEventListener("click", () => vote("tie"));
    document.getElementById("vote-clip-b")?.addEventListener("click", () => vote("clip_b"));
    document.getElementById("vote-super-b")?.addEventListener("click", () => vote("super_b"));
    document.getElementById("vote-skip")?.addEventListener("click", () => vote("skip"));
  }
  async function initComparePage() {
    setupEventListeners();
    const user = await window.checkAuth();
    const authRequired = document.getElementById("auth-required");
    const compareUi = document.getElementById("compare-ui");
    if (!user) {
      if (authRequired) authRequired.classList.remove("hidden");
      if (compareUi) compareUi.classList.add("hidden");
      return;
    }
    if (authRequired) authRequired.classList.add("hidden");
    if (compareUi) compareUi.classList.remove("hidden");
    await loadStats();
    const params = new URLSearchParams(window.location.search);
    const rankClipId = params.get("rank");
    const rerankClipId = params.get("rerank");
    if (rankClipId) {
      await initRankingMode(rankClipId, false);
      document.addEventListener("keydown", handleKeyboard);
      return;
    }
    if (rerankClipId) {
      await initRankingMode(rerankClipId, true);
      document.addEventListener("keydown", handleKeyboard);
      return;
    }
    const clipAId = params.get("a");
    const clipBId = params.get("b");
    if (clipAId && clipBId) {
      await loadSpecificPair(clipAId, clipBId);
    } else {
      await loadNextPair();
    }
    prefetchUpcomingPairs();
    document.addEventListener("keydown", handleKeyboard);
    window.addEventListener("popstate", (event) => {
      const state = event.state;
      if (state?.clipA && state?.clipB) {
        displayClips(state.clipA, state.clipB);
      }
    });
  }
  function handleKeyboard(event) {
    const target = event.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return;
    }
    switch (event.key) {
      case "1":
        vote(event.shiftKey ? "super_a" : "clip_a");
        break;
      case "2":
        vote(event.shiftKey ? "super_b" : "clip_b");
        break;
      case "t":
      case "T":
        vote("tie");
        break;
      case "s":
      case "S":
        vote("skip");
        break;
    }
  }
  document.addEventListener("DOMContentLoaded", initComparePage);
})();
//# sourceMappingURL=compare.js.map

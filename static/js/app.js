// Global app state
let currentUser = null;

// Check authentication status
async function checkAuth() {
  try {
    const response = await fetch('/api/auth/me');
    const data = await response.json();

    currentUser = data.user;
    updateNavUser();

    return currentUser;
  } catch (error) {
    console.error('Auth check failed:', error);
    return null;
  }
}

// Update navigation user display
function updateNavUser() {
  const navUser = document.getElementById('nav-user');
  if (!navUser) return;

  if (currentUser) {
    navUser.innerHTML = `
      <img src="${currentUser.profileImage || '/static/default-avatar.png'}" alt="${currentUser.displayName}">
      <span>${currentUser.displayName || currentUser.twitchUsername}</span>
      <button class="btn btn-secondary" onclick="logout()">Logout</button>
    `;
  } else {
    navUser.innerHTML = `
      <a href="/api/auth/login" class="btn btn-twitch">Sign in</a>
    `;
  }

  // Update auth section on homepage if it exists
  const authSection = document.getElementById('auth-section');
  if (authSection) {
    if (currentUser) {
      authSection.innerHTML = `
        <a href="/compare" class="btn btn-primary">Start Ranking</a>
      `;
    }
  }
}

// Logout
async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    currentUser = null;
    updateNavUser();
    window.location.href = '/';
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

// Show toast notification
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Format number with commas
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Get parent domain for Twitch embed
function getParentDomain() {
  return window.location.hostname;
}

// Create Twitch clip embed URL
function getTwitchEmbedUrl(clipSlug) {
  const parent = getParentDomain();
  return `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${parent}&autoplay=false`;
}

// Create Twitch clip embed HTML
function createTwitchEmbed(clipSlug, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const embedUrl = getTwitchEmbedUrl(clipSlug);
  container.innerHTML = `<iframe src="${embedUrl}" allowfullscreen></iframe>`;
}

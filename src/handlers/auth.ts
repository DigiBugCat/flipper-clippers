import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Env, TwitchTokenResponse, TwitchUser, User, Session } from '../types';
import {
  getUserByTwitchId,
  createUser,
  updateUserLogin,
  getSession,
  deleteSession,
  getUserById,
  updateUserPrivacy,
} from '../db/queries';

const auth = new Hono<{ Bindings: Env }>();

// Session cache TTL: 5 minutes (reduces D1 reads by ~80%)
const SESSION_CACHE_TTL = 5 * 60;

// Cached session data structure
interface CachedSessionData {
  session: Session;
  user: User;
}

/**
 * Get session with KV caching
 * Reduces D1 reads for authenticated requests
 */
export async function getCachedSession(
  db: D1Database,
  sessionCache: KVNamespace,
  sessionId: string
): Promise<CachedSessionData | null> {
  const cacheKey = `session:${sessionId}`;

  // Try KV cache first
  const cached = await sessionCache.get<CachedSessionData>(cacheKey, 'json');
  if (cached) {
    // Check if session is still valid
    if (new Date(cached.session.expires_at) > new Date()) {
      return cached;
    }
    // Expired, delete from cache
    await sessionCache.delete(cacheKey);
  }

  // Cache miss - query D1
  const session = await getSession(db, sessionId);
  if (!session) {
    return null;
  }

  const user = await getUserById(db, session.user_id);
  if (!user) {
    return null;
  }

  const data: CachedSessionData = { session, user };
  await sessionCache.put(cacheKey, JSON.stringify(data), { expirationTtl: SESSION_CACHE_TTL });

  return data;
}

/**
 * Invalidate cached session (call on logout or session update)
 */
export async function invalidateCachedSession(
  sessionCache: KVNamespace,
  sessionId: string
): Promise<void> {
  await sessionCache.delete(`session:${sessionId}`);
}

// Generate a random session ID
function generateSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Generate OAuth state for CSRF protection
function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Get the redirect URI based on the request
function getRedirectUri(c: any): string {
  const url = new URL(c.req.url);
  return `${url.origin}/api/auth/callback`;
}

// Dev mode login (bypasses Twitch OAuth) - ONLY available in local development
auth.get('/dev-login', async (c) => {
  // Security: Check if running in local dev mode via CF-Connecting-IP header
  // In production, CF sets this header. In local dev (Miniflare), it's not set or is localhost
  const cfConnectingIp = c.req.header('cf-connecting-ip');
  const isLocalDev = !cfConnectingIp || cfConnectingIp === '127.0.0.1' || cfConnectingIp === '::1';

  if (!isLocalDev) {
    return c.json({ error: 'Dev login is only available in local development' }, 403);
  }

  // Create or get dev user
  const devTwitchId = 'dev-user-123';
  let user = await getUserByTwitchId(c.env.DB, devTwitchId);

  if (!user) {
    user = await createUser(
      c.env.DB,
      devTwitchId,
      'dev_user',
      'Dev User',
      null
    );
  } else {
    await updateUserLogin(c.env.DB, user.id);
  }

  // Create session
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, user.id, expiresAt)
    .run();

  // Set session cookie (secure: false for local dev)
  const reqUrl = new URL(c.req.url);
  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: reqUrl.protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return c.redirect('/compare');
});

// Redirect to Twitch OAuth
auth.get('/login', async (c) => {
  const state = generateState();
  const redirectUri = getRedirectUri(c);

  // Store state in cookie for verification
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: c.env.TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:email',
    state: state,
    force_verify: 'true',
  });

  return c.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
});

// Handle Twitch OAuth callback
auth.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const storedState = getCookie(c, 'oauth_state');

  // Clear the state cookie
  deleteCookie(c, 'oauth_state', { path: '/' });

  // Check for errors
  if (error) {
    return c.redirect('/?error=auth_denied');
  }

  if (!code || !state) {
    return c.redirect('/?error=missing_params');
  }

  // Verify state
  if (state !== storedState) {
    return c.redirect('/?error=invalid_state');
  }

  try {
    const redirectUri = getRedirectUri(c);

    // Exchange code for access token
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.env.TWITCH_CLIENT_ID,
        client_secret: c.env.TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', await tokenResponse.text());
      return c.redirect('/?error=token_exchange_failed');
    }

    const tokens: TwitchTokenResponse = await tokenResponse.json();

    // Get user info from Twitch
    const userResponse = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Client-Id': c.env.TWITCH_CLIENT_ID,
      },
    });

    if (!userResponse.ok) {
      console.error('User info failed:', await userResponse.text());
      return c.redirect('/?error=user_info_failed');
    }

    const userData = await userResponse.json() as { data: TwitchUser[] };
    const twitchUser: TwitchUser = userData.data[0];

    // Find or create user in database
    let user = await getUserByTwitchId(c.env.DB, twitchUser.id);

    if (!user) {
      user = await createUser(
        c.env.DB,
        twitchUser.id,
        twitchUser.login,
        twitchUser.display_name,
        twitchUser.profile_image_url
      );
    } else {
      await updateUserLogin(c.env.DB, user.id);
    }

    // Create session
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    await c.env.DB
      .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(sessionId, user.id, expiresAt)
      .run();

    // Set session cookie
    setCookie(c, 'session', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: '/',
    });

    console.log(`[ACTIVITY] user=${user.id} action=login username=${twitchUser.login}`);
    return c.redirect('/compare');
  } catch (error) {
    console.error('Auth callback error:', error);
    return c.redirect('/?error=auth_failed');
  }
});

// Get current user
auth.get('/me', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ user: null }, 200);
  }

  // Use KV-cached session lookup for auth
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ user: null }, 200);
  }

  // Fetch fresh user stats (not from cache) so comparison count is always current
  const user = await getUserById(c.env.DB, cached.session.user_id);
  if (!user) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ user: null }, 200);
  }

  return c.json({
    user: {
      id: user.id,
      twitchUsername: user.twitch_username,
      displayName: user.twitch_display_name,
      profileImage: user.twitch_profile_image,
      totalComparisons: user.total_comparisons,
      totalSuperLikes: user.total_super_likes,
      isProfilePublic: user.is_profile_public === 1,
    },
  });
});

// Get privacy settings
auth.get('/privacy', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  return c.json({
    isProfilePublic: cached.user.is_profile_public === 1,
  });
});

// Update privacy settings
auth.put('/privacy', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  const body = await c.req.json<{ isProfilePublic: boolean }>();
  if (typeof body.isProfilePublic !== 'boolean') {
    return c.json({ error: 'isProfilePublic must be a boolean' }, 400);
  }

  await updateUserPrivacy(c.env.DB, cached.user.id, body.isProfilePublic);

  // Invalidate session cache so the new privacy setting is reflected
  await invalidateCachedSession(c.env.SESSION_CACHE, sessionId);

  console.log(`[ACTIVITY] user=${cached.user.id} action=update_privacy is_public=${body.isProfilePublic}`);

  return c.json({
    success: true,
    isProfilePublic: body.isProfilePublic,
  });
});

// Secret admin login page (for digibugcat production debugging)
auth.get('/dev', async (c) => {
  const error = c.req.query('error');
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Dev Login</title>
      <style>
        body { font-family: system-ui; background: #1a1a2e; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .container { background: #16213e; padding: 2rem; border-radius: 8px; width: 300px; }
        h1 { margin: 0 0 1rem; font-size: 1.25rem; }
        input { width: 100%; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #333; border-radius: 4px; background: #0f0f23; color: #fff; box-sizing: border-box; }
        button { width: 100%; padding: 0.75rem; background: #9147ff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        button:hover { background: #772ce8; }
        .error { color: #ff6b6b; font-size: 0.875rem; margin-top: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔐 Dev Login</h1>
        <form method="POST" action="/api/auth/dev">
          <input type="password" name="key" placeholder="Enter secret key" required autofocus />
          <button type="submit">Login</button>
          ${error ? '<p class="error">Invalid key</p>' : ''}
        </form>
      </div>
    </body>
    </html>
  `);
});

auth.post('/dev', async (c) => {
  const formData = await c.req.formData();
  const key = formData.get('key');

  // Validate secret key
  if (!key || key !== c.env.ADMIN_LOGIN_KEY) {
    return c.redirect('/api/auth/dev?error=1');
  }

  // Find digibugcat user
  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE twitch_username = ?')
    .bind('digibugcat')
    .first<User>();

  if (!user) {
    return c.html('<h1>Admin user not found</h1><p>digibugcat must login via Twitch first.</p>', 404);
  }

  // Create session
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, user.id, expiresAt)
    .run();

  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  console.log(`[ACTIVITY] user=${user.id} action=admin_login`);
  return c.redirect('/compare');
});

// Logout
auth.post('/logout', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (sessionId) {
    // Get user before invalidating session for logging
    const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
    if (cached) {
      console.log(`[ACTIVITY] user=${cached.user.id} action=logout`);
    }
    // Invalidate KV cache and D1 session
    await invalidateCachedSession(c.env.SESSION_CACHE, sessionId);
    await deleteSession(c.env.DB, sessionId);
    deleteCookie(c, 'session', { path: '/' });
  }

  return c.json({ success: true });
});

// Reset all votes for the current user
auth.post('/reset-votes', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  const userId = cached.user.id;

  // Delete all vote-related data for this user
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM comparisons WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM user_clip_ratings WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM pairing_history WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM taste_compatibility_cache WHERE user_a_id = ? OR user_b_id = ?').bind(userId, userId),
    c.env.DB.prepare(`
      UPDATE users SET
        total_comparisons = 0,
        total_super_likes = 0,
        total_skips = 0,
        total_ties = 0,
        total_clips_seen = 0,
        current_streak = 0,
        longest_streak = 0,
        last_vote_date = NULL
      WHERE id = ?
    `).bind(userId),
  ]);

  // Invalidate session cache to reflect new stats
  await invalidateCachedSession(c.env.SESSION_CACHE, sessionId);

  console.log(`[ACTIVITY] user=${userId} action=reset_votes`);

  return c.json({ success: true });
});

// Delete account completely
auth.post('/delete-account', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  const userId = cached.user.id;

  // Delete all user data
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM comparisons WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM user_clip_ratings WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM pairing_history WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM saved_clips WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM clip_comments WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM activity_feed WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM taste_compatibility_cache WHERE user_a_id = ? OR user_b_id = ?').bind(userId, userId),
    c.env.DB.prepare('DELETE FROM share_tokens WHERE user_id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);

  // Clear session
  await invalidateCachedSession(c.env.SESSION_CACHE, sessionId);
  deleteCookie(c, 'session', { path: '/' });

  console.log(`[ACTIVITY] user=${userId} action=delete_account`);

  return c.json({ success: true });
});

export default auth;

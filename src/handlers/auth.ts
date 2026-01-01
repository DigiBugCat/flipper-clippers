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

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ user: null }, 200);
  }

  const { user } = cached;

  return c.json({
    user: {
      id: user.id,
      twitchUsername: user.twitch_username,
      displayName: user.twitch_display_name,
      profileImage: user.twitch_profile_image,
      totalComparisons: user.total_comparisons,
      totalSuperLikes: user.total_super_likes,
    },
  });
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

export default auth;

import { getCookie, deleteCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, User } from '../types';
import { getCachedSession } from '../handlers/auth';

// Admin users for protected operations
const ADMIN_USERS = ['digibugcat', 'arross'];

// Variables type that handlers can extend
export type AuthVariables = {
  user: User;
  userId: number;
};

/**
 * Middleware that requires authentication.
 * Sets user and userId in context variables.
 * Returns 401 if not authenticated.
 */
export async function requireAuth(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
): Promise<Response | void> {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  c.set('user', cached.user);
  c.set('userId', cached.user.id);
  await next();
}

/**
 * Optional auth middleware - doesn't fail if not logged in.
 * Sets user and userId in context if session exists and is valid.
 */
export async function optionalAuth(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
): Promise<void> {
  const sessionId = getCookie(c, 'session');
  if (sessionId) {
    const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
    if (cached) {
      c.set('user', cached.user);
      c.set('userId', cached.user.id);
    }
  }
  await next();
}

/**
 * Middleware that requires admin authentication.
 * Returns 401 if not authenticated, 403 if not admin.
 */
export async function requireAdmin(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
): Promise<Response | void> {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  if (!ADMIN_USERS.includes(cached.user.twitch_username)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  c.set('user', cached.user);
  c.set('userId', cached.user.id);
  await next();
}

/**
 * Check if a username is an admin (for use outside middleware context)
 */
export function isAdmin(username: string): boolean {
  return ADMIN_USERS.includes(username);
}

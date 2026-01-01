import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, User } from '../types';
import {
  getClipById,
  getSavedClips,
  isClipSaved,
  saveClip,
  unsaveClip,
  reorderSavedClip,
} from '../db/queries';
import { getCachedSession } from './auth';

// Extended context type with user variables
type Variables = {
  user: User;
  userId: number;
};

const saved = new Hono<{ Bindings: Env; Variables: Variables }>();

// Middleware to require authentication with KV session caching
async function requireAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  c.set('user', cached.user);
  c.set('userId', cached.user.id);
  await next();
}

// Get all saved clips for the user
saved.get('/', requireAuth, async (c) => {
  const userId = c.get('userId');

  const clips = await getSavedClips(c.env.DB, userId);

  // Browser-only cache (private because user-specific data)
  c.header('Cache-Control', 'private, max-age=60');

  return c.json({
    clips: clips.map((clip) => ({
      id: clip.id,
      twitchSlug: clip.twitch_slug,
      title: clip.title,
      twitchUrl: clip.twitch_url,
      clippedBy: clip.clipped_by,
      position: clip.position,
      savedAt: clip.saved_at,
    })),
  });
});

// Check if a clip is saved
saved.get('/check/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const isSaved = await isClipSaved(c.env.DB, userId, clipId);

  return c.json({ saved: isSaved });
});

// Check multiple clips at once (for compare page)
saved.post('/check-multiple', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ clipIds: number[] }>();

  if (!body.clipIds || !Array.isArray(body.clipIds)) {
    return c.json({ error: 'Invalid clip IDs' }, 400);
  }

  const results: Record<number, boolean> = {};
  for (const clipId of body.clipIds) {
    results[clipId] = await isClipSaved(c.env.DB, userId, clipId);
  }

  return c.json({ saved: results });
});

// Save a clip
saved.post('/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  // Verify clip exists
  const clip = await getClipById(c.env.DB, clipId);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  await saveClip(c.env.DB, userId, clipId);

  console.log(`[ACTIVITY] user=${userId} action=save clipId=${clipId}`);
  return c.json({ success: true });
});

// Unsave a clip
saved.delete('/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  await unsaveClip(c.env.DB, userId, clipId);

  console.log(`[ACTIVITY] user=${userId} action=unsave clipId=${clipId}`);
  return c.json({ success: true });
});

// Reorder a saved clip
saved.put('/reorder', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ clipId: number; newPosition: number }>();

  if (!body.clipId || !body.newPosition) {
    return c.json({ error: 'Missing clipId or newPosition' }, 400);
  }

  await reorderSavedClip(c.env.DB, userId, body.clipId, body.newPosition);

  return c.json({ success: true });
});

export default saved;

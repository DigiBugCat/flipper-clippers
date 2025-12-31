import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, User } from '../types';
import {
  getSession,
  getUserById,
  getClipById,
  getSavedClips,
  isClipSaved,
  saveClip,
  unsaveClip,
  reorderSavedClip,
} from '../db/queries';

// Extended context type with user variables
type Variables = {
  user: User;
  userId: number;
};

const saved = new Hono<{ Bindings: Env; Variables: Variables }>();

// Middleware to require authentication
async function requireAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const user = await getUserById(c.env.DB, session.user_id);
  if (!user) {
    return c.json({ error: 'User not found' }, 401);
  }

  c.set('user', user);
  c.set('userId', user.id);
  await next();
}

// Get all saved clips for the user
saved.get('/', requireAuth, async (c) => {
  const userId = c.get('userId');

  const clips = await getSavedClips(c.env.DB, userId);

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

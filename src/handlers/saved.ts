import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getClipById,
  getSavedClips,
  isClipSaved,
  areClipsSaved,
  saveClip,
  unsaveClip,
  reorderSavedClip,
} from '../db/queries';
import { requireAuth, type AuthVariables } from '../middleware/auth';
import { recordActivity } from '../services/feed';

// Extended context type with user variables
type Variables = AuthVariables;

const saved = new Hono<{ Bindings: Env; Variables: Variables }>();

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

// Check multiple clips at once (for compare page) - single query instead of N queries
saved.post('/check-multiple', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ clipIds: number[] }>();

  if (!body.clipIds || !Array.isArray(body.clipIds)) {
    return c.json({ error: 'Invalid clip IDs' }, 400);
  }

  // Single batch query instead of N individual queries
  const results = await areClipsSaved(c.env.DB, userId, body.clipIds);

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

  // Record activity to feed
  const user = c.get('user');
  await recordActivity(
    c.env.DB,
    userId,
    'save',
    clipId,
    clip.title,
    null,
    user.is_profile_public === 1
  );

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

import { Hono } from 'hono';
import type { Env, User, ClipComment, ReactionEmoji } from '../types';
import { requireAuth, optionalAuth, type AuthVariables } from '../middleware/auth';
import { recordActivity, isUserProfilePublic } from '../services/feed';
import { getClipById } from '../db/queries';

// Valid emoji reactions
const VALID_EMOJIS: ReactionEmoji[] = ['fire', 'skull', 'crying', 'poggers', 'pepehands', 'lul'];

type Variables = AuthVariables;

const comments = new Hono<{ Bindings: Env; Variables: Variables }>();

// Get all public comments for a clip
comments.get('/:clipId', optionalAuth, async (c) => {
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const result = await c.env.DB
    .prepare(
      `SELECT cc.*, u.twitch_display_name, u.twitch_profile_image
       FROM clip_comments cc
       JOIN users u ON cc.user_id = u.id
       WHERE cc.clip_id = ? AND cc.is_public = 1
       ORDER BY cc.created_at DESC
       LIMIT 100`
    )
    .bind(clipId)
    .all<ClipComment & { twitch_display_name: string | null; twitch_profile_image: string | null }>();

  return c.json({
    comments: result.results.map((cc) => ({
      id: cc.id,
      comment: cc.comment,
      emoji: cc.emoji,
      createdAt: cc.created_at,
      user: {
        displayName: cc.twitch_display_name,
        profileImage: cc.twitch_profile_image,
      },
    })),
  });
});

// Get user's own comment for a clip
comments.get('/my/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const comment = await c.env.DB
    .prepare('SELECT * FROM clip_comments WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<ClipComment>();

  if (!comment) {
    return c.json({ comment: null });
  }

  return c.json({
    comment: {
      id: comment.id,
      comment: comment.comment,
      emoji: comment.emoji,
      isPublic: comment.is_public === 1,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    },
  });
});

// Create or update a comment
comments.post('/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  // Verify clip exists
  const clip = await getClipById(c.env.DB, clipId);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  const body = await c.req.json<{ comment?: string; emoji?: string; isPublic?: boolean }>();

  // Validate emoji if provided
  if (body.emoji && !VALID_EMOJIS.includes(body.emoji as ReactionEmoji)) {
    return c.json({ error: `Invalid emoji. Valid options: ${VALID_EMOJIS.join(', ')}` }, 400);
  }

  // Validate comment length
  const comment = body.comment?.trim() || '';
  if (comment.length > 500) {
    return c.json({ error: 'Comment must be 500 characters or less' }, 400);
  }

  // Must have either comment or emoji
  if (!comment && !body.emoji) {
    return c.json({ error: 'Must provide comment or emoji' }, 400);
  }

  const isPublic = body.isPublic !== false ? 1 : 0; // Default to public

  // Upsert comment
  await c.env.DB
    .prepare(
      `INSERT INTO clip_comments (user_id, clip_id, comment, emoji, is_public)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, clip_id) DO UPDATE SET
       comment = excluded.comment,
       emoji = excluded.emoji,
       is_public = excluded.is_public,
       updated_at = datetime('now')`
    )
    .bind(userId, clipId, comment, body.emoji || null, isPublic)
    .run();

  // Record activity if public
  if (isPublic) {
    await recordActivity(
      c.env.DB,
      userId,
      'comment',
      clipId,
      clip.title,
      { emoji: body.emoji || null },
      user.is_profile_public === 1
    );
  }

  console.log(`[ACTIVITY] user=${userId} action=comment clipId=${clipId} emoji=${body.emoji || 'none'}`);

  return c.json({ success: true });
});

// Delete a comment
comments.delete('/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  await c.env.DB
    .prepare('DELETE FROM clip_comments WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .run();

  return c.json({ success: true });
});

// Get reaction counts for a clip
comments.get('/reactions/:clipId', async (c) => {
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (!clipId) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const result = await c.env.DB
    .prepare(
      `SELECT emoji, COUNT(*) as count
       FROM clip_comments
       WHERE clip_id = ? AND is_public = 1 AND emoji IS NOT NULL
       GROUP BY emoji`
    )
    .bind(clipId)
    .all<{ emoji: string; count: number }>();

  // Convert to object
  const reactions: Record<string, number> = {};
  for (const row of result.results) {
    reactions[row.emoji] = row.count;
  }

  return c.json({ reactions });
});

export default comments;

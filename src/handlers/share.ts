import { Hono } from 'hono';
import type { Env, ShareType, ShareToken } from '../types';
import { requireAuth, type AuthVariables } from '../middleware/auth';
import { getUserTopClips, getPublicProfile } from '../services/social';

type Variables = AuthVariables;

const share = new Hono<{ Bindings: Env; Variables: Variables }>();

// Generate a secure random token
function generateShareToken(): string {
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

// Create a shareable link
share.post('/create', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ type?: ShareType }>();
  const shareType: ShareType = body.type || 'profile';

  // Validate share type
  if (!['profile', 'top5', 'leaderboard'].includes(shareType)) {
    return c.json({ error: 'Invalid share type' }, 400);
  }

  // Check if user already has too many tokens (limit 10)
  const countResult = await c.env.DB
    .prepare('SELECT COUNT(*) as count FROM share_tokens WHERE user_id = ?')
    .bind(userId)
    .first<{ count: number }>();

  if ((countResult?.count || 0) >= 10) {
    return c.json({ error: 'Maximum share links reached (10). Delete some to create new ones.' }, 400);
  }

  // Generate token
  const token = generateShareToken();

  // Insert token
  await c.env.DB
    .prepare(
      `INSERT INTO share_tokens (user_id, token, share_type)
       VALUES (?, ?, ?)`
    )
    .bind(userId, token, shareType)
    .run();

  const shareUrl = `/share/${token}`;

  console.log(`[ACTIVITY] user=${userId} action=create_share_link token=${token} type=${shareType}`);

  return c.json({
    success: true,
    token,
    shareUrl,
    type: shareType,
  });
});

// List user's active share tokens
// NOTE: Must be defined BEFORE /:token to avoid matching "my-links" as a token
share.get('/my-links', requireAuth, async (c) => {
  const userId = c.get('userId');

  const tokens = await c.env.DB
    .prepare(
      `SELECT token, share_type, view_count, created_at, expires_at
       FROM share_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
    .bind(userId)
    .all<{ token: string; share_type: ShareType; view_count: number; created_at: string; expires_at: string | null }>();

  return c.json({
    links: tokens.results.map(t => ({
      token: t.token,
      type: t.share_type,
      url: `/share/${t.token}`,
      viewCount: t.view_count,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
    })),
  });
});

// Get shared content (public - no auth required)
share.get('/:token', async (c) => {
  const token = c.req.param('token');

  if (!token) {
    return c.json({ error: 'Invalid token' }, 400);
  }

  // Look up token
  const shareToken = await c.env.DB
    .prepare(
      `SELECT st.*, u.twitch_display_name, u.twitch_profile_image, u.total_comparisons
       FROM share_tokens st
       JOIN users u ON st.user_id = u.id
       WHERE st.token = ?
       AND (st.expires_at IS NULL OR st.expires_at > datetime('now'))`
    )
    .bind(token)
    .first<ShareToken & { twitch_display_name: string | null; twitch_profile_image: string | null; total_comparisons: number }>();

  if (!shareToken) {
    return c.json({ error: 'Share link not found or expired' }, 404);
  }

  // Increment view count
  await c.env.DB
    .prepare('UPDATE share_tokens SET view_count = view_count + 1 WHERE id = ?')
    .bind(shareToken.id)
    .run();

  // Get user's top clips based on share type
  const clipLimit = shareToken.share_type === 'top5' ? 5 : 10;
  const topClips = await getUserTopClips(c.env.DB, shareToken.user_id, clipLimit);

  return c.json({
    type: shareToken.share_type,
    user: {
      displayName: shareToken.twitch_display_name,
      profileImage: shareToken.twitch_profile_image,
      totalComparisons: shareToken.total_comparisons,
    },
    topClips: topClips.map(clip => ({
      id: clip.id,
      twitchSlug: clip.twitchSlug,
      title: clip.title,
      userElo: Math.round(clip.userElo),
    })),
    viewCount: shareToken.view_count + 1, // +1 for current view
    createdAt: shareToken.created_at,
  });
});

// Delete a share token
share.delete('/:token', requireAuth, async (c) => {
  const userId = c.get('userId');
  const token = c.req.param('token');

  if (!token) {
    return c.json({ error: 'Invalid token' }, 400);
  }

  // Verify ownership and delete
  const result = await c.env.DB
    .prepare('DELETE FROM share_tokens WHERE token = ? AND user_id = ?')
    .bind(token, userId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Token not found or not owned by you' }, 404);
  }

  return c.json({ success: true });
});

export default share;

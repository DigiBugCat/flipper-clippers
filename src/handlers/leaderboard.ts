import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import {
  getSession,
  getUserById,
  getGlobalLeaderboard,
  getUserLeaderboard,
  initializeManualPositions,
  reorderPersonalRanking,
} from '../db/queries';
import { calculateConfidence } from '../services/rating';
import { getAggregationStats } from '../services/aggregation';

const leaderboard = new Hono<{ Bindings: Env }>();

// Get global leaderboard
leaderboard.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const clips = await getGlobalLeaderboard(c.env.DB, limit, offset);

  const ranked = clips.map((clip, index) => ({
    rank: offset + index + 1,
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    twitchUrl: clip.twitch_url,
    elo: Math.round(clip.global_elo),
    matches: clip.global_matches,
    wins: clip.global_wins,
    losses: clip.global_losses,
    ties: clip.global_ties,
    superLikes: clip.global_super_likes,
    winRate: clip.global_matches > 0 ? Math.round((clip.global_wins / clip.global_matches) * 100) : 0,
    confidence: Math.round(calculateConfidence(clip.global_matches, clip.rating_deviation)),
  }));

  return c.json({ leaderboard: ranked });
});

// Get user's personal leaderboard
leaderboard.get('/me', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  // Initialize manual positions if not set
  await initializeManualPositions(c.env.DB, session.user_id);

  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const clips = await getUserLeaderboard(c.env.DB, session.user_id, limit);

  const ranked = clips.map((clip, index) => ({
    rank: index + 1,
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    clippedBy: clip.clipped_by,
    twitchUrl: clip.twitch_url,
    elo: Math.round(clip.user_elo),
    globalElo: Math.round(clip.global_elo),
    manualPosition: clip.manual_position,
  }));

  return c.json({ leaderboard: ranked });
});

// Reorder personal leaderboard
leaderboard.put('/me/reorder', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const body = await c.req.json<{ clipId: number; newPosition: number }>();

  if (!body.clipId || !body.newPosition) {
    return c.json({ error: 'Missing clipId or newPosition' }, 400);
  }

  const result = await reorderPersonalRanking(c.env.DB, session.user_id, body.clipId, body.newPosition);

  return c.json({
    success: true,
    clipsBeaten: result.clipsBeaten,
    globalRankingUpdated: result.clipsBeaten > 0,
  });
});

// Get leaderboard stats
leaderboard.get('/stats', async (c) => {
  const stats = await getAggregationStats(c.env.DB);

  // Get total clips
  const clipsResult = await c.env.DB
    .prepare('SELECT COUNT(*) as count FROM clips WHERE is_active = 1')
    .first<{ count: number }>();

  return c.json({
    ...stats,
    totalClips: clipsResult?.count ?? 0,
  });
});

// Get top clips summary (for homepage)
leaderboard.get('/top', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const clips = await getGlobalLeaderboard(c.env.DB, limit, 0);

  return c.json({
    topClips: clips.map((clip, index) => ({
      rank: index + 1,
      id: clip.id,
      twitchSlug: clip.twitch_slug,
      title: clip.title,
      elo: Math.round(clip.global_elo),
      superLikes: clip.global_super_likes,
    })),
  });
});

export default leaderboard;

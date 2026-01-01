import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import {
  getGlobalLeaderboard,
  getUserLeaderboard,
  initializeManualPositions,
  reorderPersonalRanking,
  getUserClipsSortedByElo,
  getUserClipRating,
  upsertUserClipRating,
  getClipById,
  getVoterLeaderboard,
  type SortField,
  type SortOrder,
} from '../db/queries';
import { calculateConfidence } from '../services/rating';
import { getAggregationStats, aggregateGlobalRankings } from '../services/aggregation';
import { setRankingSession } from './clips';
import { getCachedSession } from './auth';

const leaderboard = new Hono<{ Bindings: Env }>();

// Valid sort fields
const VALID_SORT_FIELDS: SortField[] = ['elo', 'matches', 'winrate', 'superlikes'];
const VALID_SORT_ORDERS: SortOrder[] = ['asc', 'desc'];

// Get global leaderboard
leaderboard.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10)));
  const offset = (page - 1) * limit;

  const sortParam = c.req.query('sort') ?? 'elo';
  const orderParam = c.req.query('order') ?? 'desc';

  const sort: SortField = VALID_SORT_FIELDS.includes(sortParam as SortField)
    ? (sortParam as SortField)
    : 'elo';
  const order: SortOrder = VALID_SORT_ORDERS.includes(orderParam as SortOrder)
    ? (orderParam as SortOrder)
    : 'desc';

  console.log(`[LEADERBOARD] GET / page=${page} limit=${limit} sort=${sort} order=${order}`);
  const startTime = Date.now();

  // Lazy aggregation: update global rankings on cache miss
  await aggregateGlobalRankings(c.env.DB);

  const { clips, total } = await getGlobalLeaderboard(c.env.DB, limit, offset, sort, order);
  const totalPages = Math.ceil(total / limit);

  console.log(`[LEADERBOARD] GET / returned ${clips.length} clips in ${Date.now() - startTime}ms`);

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

  // CF CDN cache for 1 minute (lazy aggregation runs on cache miss)
  c.header('Cache-Control', 'public, s-maxage=60');
  return c.json({
    leaderboard: ranked,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  });
});

// Get user's personal leaderboard
leaderboard.get('/me', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  console.log(`[LEADERBOARD] GET /me user=${cached.user.id}`);
  const startTime = Date.now();

  // Initialize manual positions if not set
  await initializeManualPositions(c.env.DB, cached.session.user_id);

  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const clips = await getUserLeaderboard(c.env.DB, cached.session.user_id, limit);
  console.log(`[LEADERBOARD] GET /me returned ${clips.length} clips in ${Date.now() - startTime}ms`);

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

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const body = await c.req.json<{ clipId: number; newPosition: number }>();

  if (!body.clipId || !body.newPosition) {
    return c.json({ error: 'Missing clipId or newPosition' }, 400);
  }

  const result = await reorderPersonalRanking(c.env.DB, cached.session.user_id, body.clipId, body.newPosition);

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

  // CF CDN cache for 5 minutes
  c.header('Cache-Control', 'public, s-maxage=300');
  return c.json({
    ...stats,
    totalClips: clipsResult?.count ?? 0,
  });
});

// Get top clips summary (for homepage)
leaderboard.get('/top', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '10', 10);
  const clips = await getGlobalLeaderboard(c.env.DB, limit, 0);

  // CF CDN cache for 5 minutes
  c.header('Cache-Control', 'public, s-maxage=300');
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

// Add a clip to personal rankings (starts ranking session if needed)
leaderboard.post('/add/:clipId', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const clipId = parseInt(c.req.param('clipId'), 10);
  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const userId = cached.session.user_id;

  // Get the clip
  const clip = await getClipById(c.env.DB, clipId);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  // Check if user already has this clip in their rankings
  const existingRating = await getUserClipRating(c.env.DB, userId, clipId);
  if (existingRating) {
    return c.json({
      success: true,
      alreadyRanked: true,
      message: 'This clip is already in your rankings!',
    });
  }

  // Get user's ranked clips to determine if binary search is needed
  const userClips = await getUserClipsSortedByElo(c.env.DB, userId);

  // If user has fewer than 3 ranked clips, just place at middle ELO
  if (userClips.length < 3) {
    await upsertUserClipRating(
      c.env.DB,
      userId,
      clipId,
      1500, // Middle ELO
      0, // matches
      0, // wins
      0, // losses
      0, // ties
      0, // super liked
      350 // deviation
    );

    return c.json({
      success: true,
      needsRanking: false,
      message: 'Clip added to your rankings!',
    });
  }

  // Start binary search session
  const totalSteps = Math.ceil(Math.log2(userClips.length));
  const sessionKey = `${userId}-${clipId}`;

  await setRankingSession(c.env.SESSION_CACHE, sessionKey, {
    clipId: clipId,
    sortedClips: userClips.map((uc) => ({ id: uc.id, elo: uc.user_elo })),
    low: 0,
    high: userClips.length - 1,
    step: 1,
    totalSteps,
  });

  // Return first comparison
  const mid = Math.floor((0 + userClips.length - 1) / 2);
  const compareClip = await getClipById(c.env.DB, userClips[mid].id);

  return c.json({
    success: true,
    needsRanking: true,
    rankingSession: {
      clipToRank: {
        id: clip.id,
        twitchSlug: clip.twitch_slug,
        title: clip.title,
        twitchUrl: clip.twitch_url,
      },
      compareWith: compareClip
        ? {
            id: compareClip.id,
            twitchSlug: compareClip.twitch_slug,
            title: compareClip.title,
            twitchUrl: compareClip.twitch_url,
          }
        : null,
      progress: {
        step: 1,
        totalSteps,
      },
    },
  });
});

// Start a rerank session for an existing clip
leaderboard.post('/rerank/:clipId', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Use KV-cached session lookup
  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const clipId = parseInt(c.req.param('clipId'), 10);
  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const userId = cached.session.user_id;

  // Get the clip
  const clip = await getClipById(c.env.DB, clipId);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  // Check if user has this clip in their rankings
  const existingRating = await getUserClipRating(c.env.DB, userId, clipId);
  if (!existingRating) {
    return c.json({ error: 'Clip not in your rankings' }, 404);
  }

  // Get user's ranked clips, excluding the one being reranked
  const userClips = await getUserClipsSortedByElo(c.env.DB, userId);
  const otherClips = userClips.filter((uc) => uc.id !== clipId);

  // Need at least 2 other clips to compare against (3 total including the one being reranked)
  if (otherClips.length < 2) {
    return c.json({ error: 'Need at least 3 ranked clips to rerank' }, 400);
  }

  // Start binary search session (excluding the clip being reranked)
  const totalSteps = Math.ceil(Math.log2(otherClips.length));
  const sessionKey = `${userId}-${clipId}`;

  await setRankingSession(c.env.SESSION_CACHE, sessionKey, {
    clipId: clipId,
    sortedClips: otherClips.map((oc) => ({ id: oc.id, elo: oc.user_elo })),
    low: 0,
    high: otherClips.length - 1,
    step: 1,
    totalSteps,
    isRerank: true, // Flag to indicate this is a rerank session
  });

  // Return first comparison
  const mid = Math.floor((0 + otherClips.length - 1) / 2);
  const compareClip = await getClipById(c.env.DB, otherClips[mid].id);

  return c.json({
    success: true,
    rankingSession: {
      clipToRank: {
        id: clip.id,
        twitchSlug: clip.twitch_slug,
        title: clip.title,
        twitchUrl: clip.twitch_url,
      },
      compareWith: compareClip
        ? {
            id: compareClip.id,
            twitchSlug: compareClip.twitch_slug,
            title: compareClip.title,
            twitchUrl: compareClip.twitch_url,
          }
        : null,
      progress: {
        step: 1,
        totalSteps,
      },
    },
  });
});

// Admin-only: Voter leaderboard (who voted the most)
const ADMIN_USERS = ['digibugcat', 'arross'];

leaderboard.get('/admin/voters', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  // Admin check
  if (!ADMIN_USERS.includes(cached.user.twitch_username)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const voters = await getVoterLeaderboard(c.env.DB);

  return c.json({
    voters: voters.map((user, index) => ({
      rank: index + 1,
      userId: user.id,
      username: user.twitch_username,
      displayName: user.twitch_display_name,
      profileImage: user.twitch_profile_image,
      totalVotes: user.total_comparisons,
      superLikes: user.total_super_likes,
      lastLogin: user.last_login,
    })),
    total: voters.length,
  });
});

export default leaderboard;

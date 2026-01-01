import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Clip } from '../types';
import {
  getGlobalLeaderboard,
  getUserLeaderboard,
  getUserLeaderboardSorted,
  initializeManualPositions,
  reorderPersonalRanking,
  getUserClipsSortedByElo,
  getUserClipRating,
  upsertUserClipRating,
  getClipById,
  getVoterLeaderboard,
  deleteUserClipRating,
  getUserVoteHistoryForClip,
  deleteComparison,
  type SortField,
  type SortOrder,
  type PersonalSortField,
} from '../db/queries';
import { calculateConfidence } from '../services/rating';
import { getAggregationStats } from '../services/aggregation';
import { setRankingSession } from './clips';
import { getCachedSession } from './auth';

const leaderboard = new Hono<{ Bindings: Env }>();

// Valid sort fields
const VALID_SORT_FIELDS: SortField[] = ['elo', 'matches', 'winrate', 'superlikes'];
const VALID_SORT_ORDERS: SortOrder[] = ['asc', 'desc'];

// SWR cache settings
const LEADERBOARD_CACHE_TTL = 120; // 2 minutes total cache time
const LEADERBOARD_STALE_AFTER = 60; // Consider stale after 1 minute

interface CachedLeaderboard {
  data: unknown;
  timestamp: number;
}

// Helper to trigger aggregation via Durable Object
async function triggerAggregationViaDoIfAvailable(env: Env): Promise<void> {
  // Use DO for aggregation coordination if available
  if (env.AGGREGATION_COORDINATOR) {
    try {
      const doId = env.AGGREGATION_COORDINATOR.idFromName('global');
      const stub = env.AGGREGATION_COORDINATOR.get(doId);
      const response = await stub.fetch('https://do/trigger');
      const result = await response.json<{ status: string }>();
      console.log(`[LEADERBOARD] DO aggregation result: ${result.status}`);
    } catch (error) {
      console.error('[LEADERBOARD] DO aggregation failed, falling back to direct:', error);
      // Fallback: import and call directly if DO fails
      const { aggregateGlobalRankings } = await import('../services/aggregation');
      await aggregateGlobalRankings(env.DB);
    }
  } else {
    // No DO available (testing) - call aggregation directly
    const { aggregateGlobalRankings } = await import('../services/aggregation');
    await aggregateGlobalRankings(env.DB);
  }
}

// Helper to generate leaderboard response
async function generateLeaderboardResponse(
  env: Env,
  limit: number,
  offset: number,
  sort: SortField,
  order: SortOrder
) {
  // Run aggregation via DO if needed
  await triggerAggregationViaDoIfAvailable(env);

  const { clips, total } = await getGlobalLeaderboard(env.DB, limit, offset, sort, order);
  const totalPages = Math.ceil(total / limit);

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
    globalSuperLikes: clip.global_super_likes,
    winRate: clip.global_matches > 0 ? Math.round((clip.global_wins / clip.global_matches) * 100) : 0,
    confidence: Math.round(calculateConfidence(clip.global_matches, clip.rating_deviation)),
  }));

  return {
    leaderboard: ranked,
    pagination: { page: Math.floor(offset / limit) + 1, limit, total, totalPages },
  };
}

// Get global leaderboard with Stale-While-Revalidate pattern
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

  // Build cache key based on query params
  const cacheKey = `leaderboard:${page}:${limit}:${sort}:${order}`;

  // Try KV cache first
  const cached = await c.env.SESSION_CACHE.get<CachedLeaderboard>(cacheKey, 'json');
  const now = Date.now();

  if (cached) {
    const age = now - cached.timestamp;
    const isStale = age > LEADERBOARD_STALE_AFTER * 1000;

    if (isStale) {
      // Stale-While-Revalidate: return stale data, refresh in background
      console.log(`[LEADERBOARD] SWR: serving stale (${Math.round(age / 1000)}s old), refreshing in background`);
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const fresh = await generateLeaderboardResponse(c.env, limit, offset, sort, order);
            await c.env.SESSION_CACHE.put(
              cacheKey,
              JSON.stringify({ data: fresh, timestamp: Date.now() }),
              { expirationTtl: LEADERBOARD_CACHE_TTL }
            );
            console.log(`[LEADERBOARD] Background refresh completed`);
          } catch (err) {
            console.error(`[LEADERBOARD] Background refresh failed:`, err);
          }
        })()
      );

      // Return stale data immediately
      c.header('X-Cache', 'STALE');
      c.header('Cache-Control', 'public, s-maxage=30');
      console.log(`[LEADERBOARD] GET / served stale in ${Date.now() - startTime}ms`);
      return c.json(cached.data);
    }

    // Fresh cache hit
    console.log(`[LEADERBOARD] Cache HIT (${Math.round(age / 1000)}s old) in ${Date.now() - startTime}ms`);
    c.header('X-Cache', 'HIT');
    c.header('Cache-Control', 'public, s-maxage=60');
    return c.json(cached.data);
  }

  // Cache miss - generate fresh data
  console.log(`[LEADERBOARD] Cache MISS, generating fresh data...`);
  const data = await generateLeaderboardResponse(c.env, limit, offset, sort, order);

  // Store in KV cache
  await c.env.SESSION_CACHE.put(
    cacheKey,
    JSON.stringify({ data, timestamp: now }),
    { expirationTtl: LEADERBOARD_CACHE_TTL }
  );

  console.log(`[LEADERBOARD] GET / generated fresh in ${Date.now() - startTime}ms`);
  c.header('X-Cache', 'MISS');
  c.header('Cache-Control', 'public, s-maxage=60');
  return c.json(data);
});

// Valid personal sort fields
const VALID_PERSONAL_SORT_FIELDS: PersonalSortField[] = ['elo', 'recent', 'matches'];

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

  const sortParam = c.req.query('sort') ?? 'elo';
  const sort: PersonalSortField = VALID_PERSONAL_SORT_FIELDS.includes(sortParam as PersonalSortField)
    ? (sortParam as PersonalSortField)
    : 'elo';

  console.log(`[LEADERBOARD] GET /me user=${cached.user.id} sort=${sort}`);
  const startTime = Date.now();

  // Initialize manual positions if not set (only needed for elo sort)
  if (sort === 'elo') {
    await initializeManualPositions(c.env.DB, cached.session.user_id);
  }

  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const clips = await getUserLeaderboardSorted(c.env.DB, cached.session.user_id, limit, sort);
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
    matchesPlayed: clip.matches_played,
    updatedAt: clip.updated_at,
  }));

  return c.json({ leaderboard: ranked, sort });
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

// Delete a clip from personal rankings
leaderboard.delete('/me/:clipId', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const clipId = parseInt(c.req.param('clipId'), 10);
  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  console.log(`[LEADERBOARD] DELETE /me/${clipId} user=${cached.user.id}`);

  await deleteUserClipRating(c.env.DB, cached.user.id, clipId);

  return c.json({ success: true });
});

// Get vote history for a specific clip
leaderboard.get('/me/history/:clipId', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const clipId = parseInt(c.req.param('clipId'), 10);
  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  console.log(`[LEADERBOARD] GET /me/history/${clipId} user=${cached.user.id}`);

  const votes = await getUserVoteHistoryForClip(c.env.DB, cached.user.id, clipId);

  return c.json({ votes });
});

// Delete a single vote from history
leaderboard.delete('/me/history/:comparisonId', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  const comparisonId = parseInt(c.req.param('comparisonId'), 10);
  if (isNaN(comparisonId)) {
    return c.json({ error: 'Invalid comparison ID' }, 400);
  }

  console.log(`[LEADERBOARD] DELETE /me/history/${comparisonId} user=${cached.user.id}`);

  const deleted = await deleteComparison(c.env.DB, comparisonId, cached.user.id);

  if (!deleted) {
    return c.json({ error: 'Vote not found or not yours' }, 404);
  }

  return c.json({ success: true });
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
  const { clips } = await getGlobalLeaderboard(c.env.DB, limit, 0);

  // CF CDN cache for 5 minutes
  c.header('Cache-Control', 'public, s-maxage=300');
  return c.json({
    topClips: clips.map((clip: Clip, index: number) => ({
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
      lastLogin: user.last_active,
    })),
    total: voters.length,
  });
});

export default leaderboard;

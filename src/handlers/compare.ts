import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, VoteRequest, VoteResult, User } from '../types';
import {
  getSession,
  getUserById,
  getClipById,
  createComparison,
  incrementUserComparisons,
  getUserClipRating,
  upsertUserClipRating,
  getUserComparisons,
  getUserSuperLikedClips,
} from '../db/queries';
import { getNextPair, getPairingStats } from '../services/pairing';
import {
  calculateRatingUpdate,
  isSuperLikeResult,
  getWinnerFromResult,
  updateStats,
} from '../services/rating';
import { aggregateGlobalRankings } from '../services/aggregation';

// Extended context type with user variables
type Variables = {
  user: User;
  userId: number;
};

const compare = new Hono<{ Bindings: Env; Variables: Variables }>();

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

// Get next pair to compare
compare.get('/next', requireAuth, async (c) => {
  const userId = c.get('userId');

  const pair = await getNextPair(c.env.DB, userId);

  if (!pair) {
    return c.json({ error: 'No clips available for comparison' }, 404);
  }

  return c.json({
    clipA: {
      id: pair.clipA.id,
      twitchSlug: pair.clipA.twitch_slug,
      title: pair.clipA.title,
      twitchUrl: pair.clipA.twitch_url,
      clippedBy: pair.clipA.clipped_by,
      clippedAt: pair.clipA.clipped_at,
    },
    clipB: {
      id: pair.clipB.id,
      twitchSlug: pair.clipB.twitch_slug,
      title: pair.clipB.title,
      twitchUrl: pair.clipB.twitch_url,
      clippedBy: pair.clipB.clipped_by,
      clippedAt: pair.clipB.clipped_at,
    },
  });
});

// Get specific pair by IDs (for URL-based navigation)
compare.get('/pair', requireAuth, async (c) => {
  const clipAId = parseInt(c.req.query('a') || '0', 10);
  const clipBId = parseInt(c.req.query('b') || '0', 10);

  if (!clipAId || !clipBId) {
    return c.json({ error: 'Missing clip IDs' }, 400);
  }

  const clipA = await getClipById(c.env.DB, clipAId);
  const clipB = await getClipById(c.env.DB, clipBId);

  if (!clipA || !clipB) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  return c.json({
    clipA: {
      id: clipA.id,
      twitchSlug: clipA.twitch_slug,
      title: clipA.title,
      twitchUrl: clipA.twitch_url,
      clippedBy: clipA.clipped_by,
      clippedAt: clipA.clipped_at,
    },
    clipB: {
      id: clipB.id,
      twitchSlug: clipB.twitch_slug,
      title: clipB.title,
      twitchUrl: clipB.twitch_url,
      clippedBy: clipB.clipped_by,
      clippedAt: clipB.clipped_at,
    },
  });
});

// Submit a vote
compare.post('/vote', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<VoteRequest>();

  // Validate request
  if (!body.clip_a_id || !body.clip_b_id || !body.result) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const validResults: VoteResult[] = ['clip_a', 'clip_b', 'super_a', 'super_b', 'tie', 'skip'];
  if (!validResults.includes(body.result)) {
    return c.json({ error: 'Invalid result value' }, 400);
  }

  // Get clips
  const clipA = await getClipById(c.env.DB, body.clip_a_id);
  const clipB = await getClipById(c.env.DB, body.clip_b_id);

  if (!clipA || !clipB) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  // Get or create user ratings for both clips
  let ratingA = await getUserClipRating(c.env.DB, userId, clipA.id);
  let ratingB = await getUserClipRating(c.env.DB, userId, clipB.id);

  // Default values if no existing rating
  const currentRatingA = ratingA?.elo_rating ?? 1500;
  const currentRatingB = ratingB?.elo_rating ?? 1500;
  const deviationA = ratingA?.rating_deviation ?? 350;
  const deviationB = ratingB?.rating_deviation ?? 350;
  const matchesA = ratingA?.matches_played ?? 0;
  const matchesB = ratingB?.matches_played ?? 0;

  // Calculate new ratings
  const { newRatingA, newRatingB, newDeviationA, newDeviationB } = calculateRatingUpdate(
    currentRatingA,
    currentRatingB,
    deviationA,
    deviationB,
    matchesA,
    matchesB,
    body.result
  );

  // Update stats
  const statsA = updateStats(
    ratingA?.wins ?? 0,
    ratingA?.losses ?? 0,
    ratingA?.ties ?? 0,
    body.result,
    true
  );
  const statsB = updateStats(
    ratingB?.wins ?? 0,
    ratingB?.losses ?? 0,
    ratingB?.ties ?? 0,
    body.result,
    false
  );

  // Determine if super liked
  const superLikedA = body.result === 'super_a' ? 1 : (ratingA?.super_liked ?? 0);
  const superLikedB = body.result === 'super_b' ? 1 : (ratingB?.super_liked ?? 0);

  // Update user clip ratings (skip doesn't count as a match)
  if (body.result !== 'skip') {
    await upsertUserClipRating(
      c.env.DB,
      userId,
      clipA.id,
      newRatingA,
      matchesA + 1,
      statsA.wins,
      statsA.losses,
      statsA.ties,
      superLikedA,
      newDeviationA
    );

    await upsertUserClipRating(
      c.env.DB,
      userId,
      clipB.id,
      newRatingB,
      matchesB + 1,
      statsB.wins,
      statsB.losses,
      statsB.ties,
      superLikedB,
      newDeviationB
    );
  }

  // Record the comparison
  const winnerId = getWinnerFromResult(body.result, clipA.id, clipB.id);
  await createComparison(
    c.env.DB,
    userId,
    clipA.id,
    clipB.id,
    winnerId,
    body.result,
    body.time_spent_ms ?? null
  );

  // Increment user comparison count
  const isSuperLike = isSuperLikeResult(body.result);
  await incrementUserComparisons(c.env.DB, userId, isSuperLike);

  // Global aggregation now runs via Cron Trigger (see wrangler.toml)
  // No longer triggered by user votes to prevent timeouts

  return c.json({
    success: true,
    newRatings: {
      clipA: { id: clipA.id, elo: newRatingA },
      clipB: { id: clipB.id, elo: newRatingB },
    },
  });
});

// Get user's comparison stats
compare.get('/stats', requireAuth, async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  const pairingStats = await getPairingStats(c.env.DB, userId);

  return c.json({
    totalComparisons: user.total_comparisons,
    totalSuperLikes: user.total_super_likes,
    ...pairingStats,
  });
});

// Get user's comparison history
compare.get('/history', requireAuth, async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);

  const comparisons = await getUserComparisons(c.env.DB, userId, limit);

  // Enrich with clip data
  const enriched = await Promise.all(
    comparisons.map(async (comp) => {
      const clipA = await getClipById(c.env.DB, comp.clip_a_id);
      const clipB = await getClipById(c.env.DB, comp.clip_b_id);
      return {
        id: comp.id,
        clipA: clipA ? { id: clipA.id, title: clipA.title, slug: clipA.twitch_slug } : null,
        clipB: clipB ? { id: clipB.id, title: clipB.title, slug: clipB.twitch_slug } : null,
        result: comp.result,
        createdAt: comp.created_at,
      };
    })
  );

  return c.json({ comparisons: enriched });
});

// Get user's super liked clips
compare.get('/super-likes', requireAuth, async (c) => {
  const userId = c.get('userId');

  const clips = await getUserSuperLikedClips(c.env.DB, userId);

  return c.json({
    clips: clips.map((clip) => ({
      id: clip.id,
      twitchSlug: clip.twitch_slug,
      title: clip.title,
      twitchUrl: clip.twitch_url,
    })),
  });
});

export default compare;

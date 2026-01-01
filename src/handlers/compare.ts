import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, VoteRequest, VoteResult, User } from '../types';
import {
  getClipById,
  createComparison,
  incrementUserComparisons,
  getUserClipRating,
  upsertUserClipRating,
  getUserComparisonsWithClips,
  getUserSuperLikedClips,
} from '../db/queries';
import { calculateNextPairs, getPairingStats, type PairIds } from '../services/pairing';
import {
  calculateRatingUpdate,
  isSuperLikeResult,
  getWinnerFromResult,
  updateStats,
} from '../services/rating';
import { updateRollupForVote } from '../services/aggregation';
import { getCachedSession } from './auth';
import { recordActivity, isUserProfilePublic } from '../services/feed';

// Cookie name for pre-calculated pairs
const PENDING_PAIRS_COOKIE = 'pending_pairs';
const PAIRS_PER_BATCH = 10;

/**
 * Sign pair data with HMAC for tamper protection
 */
async function signPairs(pairs: PairIds[], secret: string): Promise<string> {
  const data = JSON.stringify(pairs);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${sigHex}.${btoa(data)}`;
}

/**
 * Verify and parse signed pair data
 */
async function verifyPairs(signed: string, secret: string): Promise<PairIds[] | null> {
  try {
    const [sigHex, dataB64] = signed.split('.');
    if (!sigHex || !dataB64) return null;

    const data = atob(dataB64);
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));

    if (!valid) return null;
    return JSON.parse(data) as PairIds[];
  } catch {
    return null;
  }
}

// Extended context type with user variables
type Variables = {
  user: User;
  userId: number;
};

const compare = new Hono<{ Bindings: Env; Variables: Variables }>();

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

// Get next pair to compare (uses cookie-cached pairs for efficiency)
compare.get('/next', requireAuth, async (c) => {
  const userId = c.get('userId');
  console.log(`[COMPARE] GET /next user=${userId}`);
  const startTime = Date.now();

  // Try to get pairs from cookie first
  const pairsCookie = getCookie(c, PENDING_PAIRS_COOKIE);
  let pairs: PairIds[] | null = null;

  if (pairsCookie) {
    pairs = await verifyPairs(pairsCookie, c.env.SESSION_SECRET);
    console.log(`[COMPARE] Cookie had ${pairs?.length ?? 0} pairs`);
  }

  // If no valid pairs in cookie, calculate new batch
  if (!pairs || pairs.length === 0) {
    console.log(`[COMPARE] Calculating new batch...`);
    pairs = await calculateNextPairs(c.env.DB, userId, PAIRS_PER_BATCH);

    if (pairs.length === 0) {
      return c.json({ error: 'No clips available for comparison' }, 404);
    }
  }

  // Pop first pair
  const [clipAId, clipBId] = pairs.shift()!;

  // Update cookie with remaining pairs
  if (pairs.length > 0) {
    const signed = await signPairs(pairs, c.env.SESSION_SECRET);
    setCookie(c, PENDING_PAIRS_COOKIE, signed, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 3600, // 1 hour
      path: '/',
    });
  } else {
    // Clear cookie if no pairs left
    setCookie(c, PENDING_PAIRS_COOKIE, '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
      path: '/',
    });
  }

  // Get clip metadata (will hit CF CDN cache)
  const clipA = await getClipById(c.env.DB, clipAId);
  const clipB = await getClipById(c.env.DB, clipBId);

  if (!clipA || !clipB) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  console.log(`[COMPARE] GET /next completed in ${Date.now() - startTime}ms`);
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
  console.log(`[COMPARE] POST /vote user=${userId} clipA=${body.clip_a_id} clipB=${body.clip_b_id} result=${body.result}`);
  const startTime = Date.now();

  // Validate request
  if (!body.clip_a_id || !body.clip_b_id || !body.result) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const validResults: VoteResult[] = ['clip_a', 'clip_b', 'super_a', 'super_b', 'tie', 'skip'];
  if (!validResults.includes(body.result)) {
    return c.json({ error: 'Invalid result value' }, 400);
  }

  // Deduplication: check for recent duplicate comparison
  const clipAId = body.clip_a_id;
  const clipBId = body.clip_b_id;
  const existingComparison = await c.env.DB
    .prepare(
      `SELECT id FROM comparisons
       WHERE user_id = ? AND clip_a_id = ? AND clip_b_id = ?
       AND created_at > datetime('now', '-10 seconds')`
    )
    .bind(userId, clipAId, clipBId)
    .first<{ id: number }>();

  if (existingComparison) {
    console.log(`[COMPARE] Deduplicated vote user=${userId} clipA=${clipAId} clipB=${clipBId}`);
    return c.json({ success: true, deduplicated: true });
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

  // Vote processing with error handling
  try {
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

      // Incrementally update rollup for both clips (2 reads, 2 writes)
      // Use current comparison count for weight (not +1) to avoid double-weighting if increment fails
      const user = c.get('user');
      const userWeight = Math.min(Math.max(user.total_comparisons, 1), 100);

      await updateRollupForVote(
        c.env.DB,
        clipA.id,
        currentRatingA,
        newRatingA,
        deviationA,
        newDeviationA,
        userWeight,
        !ratingA,
        { matches: 1, wins: statsA.wins - (ratingA?.wins ?? 0), losses: statsA.losses - (ratingA?.losses ?? 0), ties: statsA.ties - (ratingA?.ties ?? 0), superLike: body.result === 'super_a' ? 1 : 0 }
      );

      await updateRollupForVote(
        c.env.DB,
        clipB.id,
        currentRatingB,
        newRatingB,
        deviationB,
        newDeviationB,
        userWeight,
        !ratingB,
        { matches: 1, wins: statsB.wins - (ratingB?.wins ?? 0), losses: statsB.losses - (ratingB?.losses ?? 0), ties: statsB.ties - (ratingB?.ties ?? 0), superLike: body.result === 'super_b' ? 1 : 0 }
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

    // Record activity to feed (respects user privacy setting)
    if (body.result !== 'skip') {
      const user = c.get('user');
      const activityType = isSuperLike ? 'super_like' : 'vote';
      const winnerClip = body.result.includes('a') ? clipA : clipB;
      await recordActivity(
        c.env.DB,
        userId,
        activityType,
        winnerClip.id,
        winnerClip.title,
        { result: body.result, clipA: clipA.id, clipB: clipB.id },
        user.is_profile_public === 1
      );
    }
  } catch (error) {
    console.error(`[COMPARE] Vote processing failed for user=${userId}:`, error);
    return c.json({ error: 'Vote processing failed' }, 500);
  }

  // Global aggregation runs lazily when leaderboard cache misses
  // No longer triggered by user votes or cron

  console.log(`[COMPARE] POST /vote completed in ${Date.now() - startTime}ms`);
  console.log(`[ACTIVITY] user=${userId} action=vote clipA=${clipA.id} clipB=${clipB.id} result=${body.result}`);
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

// Get user's comparison history (optimized with single JOIN query)
compare.get('/history', requireAuth, async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);

  // Single JOIN query instead of N+1 individual queries
  const comparisons = await getUserComparisonsWithClips(c.env.DB, userId, limit);

  return c.json({
    comparisons: comparisons.map((comp) => ({
      id: comp.id,
      clipA: { id: comp.clipA_id, title: comp.clipA_title, slug: comp.clipA_slug },
      clipB: { id: comp.clipB_id, title: comp.clipB_title, slug: comp.clipB_slug },
      result: comp.result,
      createdAt: comp.created_at,
    })),
  });
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

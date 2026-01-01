import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Context, Next } from 'hono';
import type { Env, User } from '../types';
import {
  getAllClips,
  getClipById,
  getClipBySlug,
  createClipWithMetadata,
  getUserClipsSortedByElo,
  upsertUserClipRating,
  getUserClipRating,
} from '../db/queries';
import { validateAndFetchClip, extractClipSlug } from '../services/twitch';
import { getCachedSession } from './auth';

// Extended context type with user variables
type Variables = {
  user: User;
  userId: number;
};

const clips = new Hono<{ Bindings: Env; Variables: Variables }>();

// Ranking session type (persisted to KV)
export type RankingSession = {
  clipId: number;
  sortedClips: { id: number; elo: number }[];
  low: number;
  high: number;
  step: number;
  totalSteps: number;
  isRerank?: boolean;
};

// Ranking session TTL: 1 hour
const RANKING_SESSION_TTL = 60 * 60;

/**
 * Get ranking session from KV
 */
export async function getRankingSession(
  kv: KVNamespace,
  sessionKey: string
): Promise<RankingSession | null> {
  return await kv.get<RankingSession>(`ranking:${sessionKey}`, 'json');
}

/**
 * Save ranking session to KV
 */
export async function setRankingSession(
  kv: KVNamespace,
  sessionKey: string,
  session: RankingSession
): Promise<void> {
  await kv.put(`ranking:${sessionKey}`, JSON.stringify(session), {
    expirationTtl: RANKING_SESSION_TTL,
  });
}

/**
 * Delete ranking session from KV
 */
export async function deleteRankingSession(
  kv: KVNamespace,
  sessionKey: string
): Promise<void> {
  await kv.delete(`ranking:${sessionKey}`);
}

// Auth middleware with KV session caching
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

// Get all clips
clips.get('/', async (c) => {
  const allClips = await getAllClips(c.env.DB);

  // CF CDN cache for 5 minutes
  c.header('Cache-Control', 'public, s-maxage=300');
  return c.json({
    clips: allClips.map((clip) => ({
      id: clip.id,
      twitchSlug: clip.twitch_slug,
      title: clip.title,
      twitchUrl: clip.twitch_url,
      globalElo: clip.global_elo,
      globalMatches: clip.global_matches,
      globalSuperLikes: clip.global_super_likes,
    })),
    total: allClips.length,
  });
});

// Get single clip
clips.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const clip = await getClipById(c.env.DB, id);
  if (!clip) {
    return c.json({ error: 'Clip not found' }, 404);
  }

  // CF CDN cache for 30 minutes (clip metadata rarely changes)
  c.header('Cache-Control', 'public, s-maxage=1800');
  return c.json({
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    twitchUrl: clip.twitch_url,
    globalElo: clip.global_elo,
    globalMatches: clip.global_matches,
    globalWins: clip.global_wins,
    globalLosses: clip.global_losses,
    globalTies: clip.global_ties,
    globalSuperLikes: clip.global_super_likes,
    ratingDeviation: clip.rating_deviation,
  });
});

// Get clip count
clips.get('/stats/count', async (c) => {
  const result = await c.env.DB.prepare('SELECT COUNT(*) as count FROM clips WHERE is_active = 1').first<{
    count: number;
  }>();

  // CF CDN cache for 5 minutes
  c.header('Cache-Control', 'public, s-maxage=300');
  return c.json({ count: result?.count ?? 0 });
});

// Submit a new clip
clips.post('/submit', requireAuth, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ url: string }>();

  if (!body.url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  // Validate and fetch clip from Twitch
  const result = await validateAndFetchClip(
    body.url,
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET
  );

  if (!result.valid) {
    return c.json({ error: result.error }, 400);
  }

  const twitchClip = result.clip!;
  const slug = result.slug!;

  // Check if clip already exists
  let clip = await getClipBySlug(c.env.DB, slug);
  const isNew = !clip;

  if (!clip) {
    // Create new clip
    clip = await createClipWithMetadata(
      c.env.DB,
      slug,
      twitchClip.title,
      twitchClip.url,
      twitchClip.creator_name,
      userId
    );
    console.log(`[ACTIVITY] user=${userId} action=submit clipId=${clip.id} slug=${slug}`);
  }

  // Give a small global ELO bump for being submitted (someone thought it was worth sharing)
  const SUBMISSION_BOOST = 5;
  await c.env.DB.prepare(
    'UPDATE clips SET global_elo = global_elo + ? WHERE id = ?'
  ).bind(SUBMISSION_BOOST, clip.id).run();

  // Check if user has already ranked this clip
  const existingRating = await getUserClipRating(c.env.DB, userId, clip.id);
  if (existingRating && existingRating.matches_played > 0) {
    return c.json({
      success: true,
      clip: {
        id: clip.id,
        twitchSlug: clip.twitch_slug,
        title: clip.title,
        twitchUrl: clip.twitch_url,
      },
      isNew: false,
      alreadyRanked: true,
      currentElo: Math.round(existingRating.elo_rating),
      message: 'You\'ve already ranked this clip! (+5 global ELO for the submission)',
    });
  }

  // Get user's ranked clips to determine if binary search is needed
  const userClips = await getUserClipsSortedByElo(c.env.DB, userId);

  // If user has fewer than 3 ranked clips, just place at middle ELO
  if (userClips.length < 3) {
    // Set initial ELO rating for this user
    await upsertUserClipRating(
      c.env.DB,
      userId,
      clip.id,
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
      clip: {
        id: clip.id,
        twitchSlug: clip.twitch_slug,
        title: clip.title,
        twitchUrl: clip.twitch_url,
      },
      isNew,
      needsRanking: false,
      message: 'Saved! Start comparing clips to build your rankings, then submit more clips to rank them precisely.',
    });
  }

  // Start binary search session
  const totalSteps = Math.ceil(Math.log2(userClips.length));
  const sessionKey = `${userId}-${clip.id}`;

  await setRankingSession(c.env.SESSION_CACHE, sessionKey, {
    clipId: clip.id,
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
    clip: {
      id: clip.id,
      twitchSlug: clip.twitch_slug,
      title: clip.title,
      twitchUrl: clip.twitch_url,
    },
    isNew,
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

// Get current ranking session state
clips.get('/rank-session/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const sessionKey = `${userId}-${clipId}`;
  const session = await getRankingSession(c.env.SESSION_CACHE, sessionKey);

  if (!session) {
    return c.json({ error: 'No active ranking session' }, 404);
  }

  const clip = await getClipById(c.env.DB, clipId);
  const mid = Math.floor((session.low + session.high) / 2);
  const compareClip = await getClipById(c.env.DB, session.sortedClips[mid].id);

  return c.json({
    clipToRank: clip
      ? {
          id: clip.id,
          twitchSlug: clip.twitch_slug,
          title: clip.title,
          twitchUrl: clip.twitch_url,
        }
      : null,
    compareWith: compareClip
      ? {
          id: compareClip.id,
          twitchSlug: compareClip.twitch_slug,
          title: compareClip.title,
          twitchUrl: compareClip.twitch_url,
        }
      : null,
    progress: {
      step: session.step,
      totalSteps: session.totalSteps,
    },
  });
});

// Submit vote for ranking session
clips.post('/rank-session/:clipId/vote', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const body = await c.req.json<{ result: 'submitted' | 'existing' | 'tie' }>();
  if (!body.result || !['submitted', 'existing', 'tie'].includes(body.result)) {
    return c.json({ error: 'Invalid result. Must be "submitted", "existing", or "tie"' }, 400);
  }

  const sessionKey = `${userId}-${clipId}`;
  const session = await getRankingSession(c.env.SESSION_CACHE, sessionKey);

  if (!session) {
    return c.json({ error: 'No active ranking session' }, 404);
  }

  const mid = Math.floor((session.low + session.high) / 2);

  // Update binary search bounds based on vote
  if (body.result === 'submitted') {
    // Submitted clip is better -> search upper half (lower indices = higher ELO)
    session.high = mid;
  } else if (body.result === 'existing') {
    // Existing clip is better -> search lower half
    session.low = mid + 1;
  } else {
    // Tie - place roughly at this position
    session.low = mid;
    session.high = mid;
  }

  session.step++;

  // Check if done
  if (session.low >= session.high) {
    // Calculate final ELO based on position
    const finalPosition = session.low;
    let finalElo: number;

    if (finalPosition === 0) {
      // Better than the best - give ELO slightly above top
      finalElo = session.sortedClips[0].elo + 50;
    } else if (finalPosition >= session.sortedClips.length) {
      // Worse than the worst - give ELO slightly below bottom
      finalElo = session.sortedClips[session.sortedClips.length - 1].elo - 50;
    } else {
      // Interpolate between adjacent clips
      const above = session.sortedClips[finalPosition - 1].elo;
      const below = session.sortedClips[finalPosition].elo;
      finalElo = (above + below) / 2;
    }

    // Save the rating
    await upsertUserClipRating(
      c.env.DB,
      userId,
      clipId,
      finalElo,
      session.step - 1, // matches played = number of comparisons
      0,
      0,
      0,
      0,
      200 // Lower deviation since we've ranked it
    );

    // Clean up session
    await deleteRankingSession(c.env.SESSION_CACHE, sessionKey);

    return c.json({
      done: true,
      finalPosition: finalPosition + 1, // 1-indexed for display
      finalElo: Math.round(finalElo),
      message: `Clip ranked at position #${finalPosition + 1}!`,
    });
  }

  // Save updated session state
  await setRankingSession(c.env.SESSION_CACHE, sessionKey, session);

  // Continue with next comparison
  const newMid = Math.floor((session.low + session.high) / 2);
  const nextCompareClip = await getClipById(c.env.DB, session.sortedClips[newMid].id);

  return c.json({
    done: false,
    compareWith: nextCompareClip
      ? {
          id: nextCompareClip.id,
          twitchSlug: nextCompareClip.twitch_slug,
          title: nextCompareClip.title,
          twitchUrl: nextCompareClip.twitch_url,
        }
      : null,
    progress: {
      step: session.step,
      totalSteps: session.totalSteps,
    },
  });
});

// Cancel a ranking session
clips.delete('/rank-session/:clipId', requireAuth, async (c) => {
  const userId = c.get('userId');
  const clipId = parseInt(c.req.param('clipId'), 10);

  if (isNaN(clipId)) {
    return c.json({ error: 'Invalid clip ID' }, 400);
  }

  const sessionKey = `${userId}-${clipId}`;
  await deleteRankingSession(c.env.SESSION_CACHE, sessionKey);

  return c.json({ success: true });
});

export default clips;

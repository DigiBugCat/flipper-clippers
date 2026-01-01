import type { SimilarUser, TasteCompatibility, User } from '../types';

/**
 * Calculate Spearman rank correlation coefficient between two users' clip rankings
 * Returns a value between -1 (opposite tastes) and 1 (identical tastes)
 */
function calculateSpearmanCorrelation(
  ratingsA: Map<number, number>, // clipId -> elo
  ratingsB: Map<number, number>
): { correlation: number; sharedClips: number } {
  // Find shared clips
  const sharedClipIds = [...ratingsA.keys()].filter(id => ratingsB.has(id));
  const n = sharedClipIds.length;

  if (n < 3) {
    return { correlation: 0, sharedClips: n };
  }

  // Sort shared clips by each user's ELO to get ranks
  const sortedByA = [...sharedClipIds].sort((a, b) => (ratingsA.get(b) || 0) - (ratingsA.get(a) || 0));
  const sortedByB = [...sharedClipIds].sort((a, b) => (ratingsB.get(b) || 0) - (ratingsB.get(a) || 0));

  // Create rank maps
  const rankA = new Map<number, number>();
  const rankB = new Map<number, number>();

  sortedByA.forEach((id, idx) => rankA.set(id, idx + 1));
  sortedByB.forEach((id, idx) => rankB.set(id, idx + 1));

  // Calculate sum of squared rank differences
  let sumD2 = 0;
  for (const clipId of sharedClipIds) {
    const d = (rankA.get(clipId) || 0) - (rankB.get(clipId) || 0);
    sumD2 += d * d;
  }

  // Spearman's formula: ρ = 1 - (6 * Σd²) / (n * (n² - 1))
  const correlation = 1 - (6 * sumD2) / (n * (n * n - 1));

  return { correlation, sharedClips: n };
}

/**
 * Convert Spearman correlation to 0-100 compatibility score
 * -1 (opposite) -> 0%
 *  0 (random)   -> 50%
 *  1 (same)     -> 100%
 */
function correlationToScore(correlation: number): number {
  return Math.round((correlation + 1) * 50);
}

/**
 * Get a user's clip ratings as a Map
 */
async function getUserRatingsMap(db: D1Database, userId: number): Promise<Map<number, number>> {
  const result = await db
    .prepare('SELECT clip_id, elo_rating FROM user_clip_ratings WHERE user_id = ? AND matches_played > 0')
    .bind(userId)
    .all<{ clip_id: number; elo_rating: number }>();

  const map = new Map<number, number>();
  for (const row of result.results) {
    map.set(row.clip_id, row.elo_rating);
  }
  return map;
}

/**
 * Calculate taste compatibility between two users
 */
export async function calculateTasteCompatibility(
  db: D1Database,
  userAId: number,
  userBId: number
): Promise<{ score: number; sharedClips: number }> {
  const [ratingsA, ratingsB] = await Promise.all([
    getUserRatingsMap(db, userAId),
    getUserRatingsMap(db, userBId),
  ]);

  const { correlation, sharedClips } = calculateSpearmanCorrelation(ratingsA, ratingsB);
  const score = correlationToScore(correlation);

  return { score, sharedClips };
}

/**
 * Get compatibility from cache or calculate fresh
 */
export async function getTasteCompatibility(
  db: D1Database,
  userAId: number,
  userBId: number,
  maxAgeMinutes = 15
): Promise<{ score: number; sharedClips: number; cached: boolean }> {
  // Normalize order for cache key
  const [minId, maxId] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];

  // Check cache
  const cached = await db
    .prepare(
      `SELECT compatibility_score, shared_clips, calculated_at
       FROM taste_compatibility_cache
       WHERE user_a_id = ? AND user_b_id = ?
       AND calculated_at > datetime('now', '-' || ? || ' minutes')`
    )
    .bind(minId, maxId, maxAgeMinutes)
    .first<{ compatibility_score: number; shared_clips: number; calculated_at: string }>();

  if (cached) {
    return {
      score: cached.compatibility_score,
      sharedClips: cached.shared_clips,
      cached: true,
    };
  }

  // Calculate fresh
  const result = await calculateTasteCompatibility(db, userAId, userBId);

  // Store in cache
  await db
    .prepare(
      `INSERT INTO taste_compatibility_cache (user_a_id, user_b_id, compatibility_score, shared_clips)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET
       compatibility_score = excluded.compatibility_score,
       shared_clips = excluded.shared_clips,
       calculated_at = datetime('now')`
    )
    .bind(minId, maxId, result.score, result.sharedClips)
    .run();

  return { ...result, cached: false };
}

/**
 * Find users with similar taste to a given user
 */
export async function findSimilarUsers(
  db: D1Database,
  userId: number,
  limit = 10
): Promise<SimilarUser[]> {
  // Get all public users who have rated clips
  const publicUsers = await db
    .prepare(
      `SELECT DISTINCT u.id, u.twitch_display_name, u.twitch_profile_image
       FROM users u
       JOIN user_clip_ratings ucr ON u.id = ucr.user_id
       WHERE u.id != ? AND u.is_profile_public = 1 AND ucr.matches_played > 0
       GROUP BY u.id
       HAVING COUNT(ucr.clip_id) >= 5`  // Require at least 5 rated clips
    )
    .bind(userId)
    .all<{ id: number; twitch_display_name: string | null; twitch_profile_image: string | null }>();

  if (publicUsers.results.length === 0) {
    return [];
  }

  // Get user's ratings once
  const userRatings = await getUserRatingsMap(db, userId);

  // Calculate compatibility with each user
  const compatibilities: SimilarUser[] = [];

  for (const otherUser of publicUsers.results) {
    const otherRatings = await getUserRatingsMap(db, otherUser.id);
    const { correlation, sharedClips } = calculateSpearmanCorrelation(userRatings, otherRatings);

    // Only include if they share at least 3 clips
    if (sharedClips >= 3) {
      compatibilities.push({
        user_id: otherUser.id,
        display_name: otherUser.twitch_display_name,
        profile_image: otherUser.twitch_profile_image,
        compatibility_score: correlationToScore(correlation),
        shared_clips: sharedClips,
      });
    }
  }

  // Sort by compatibility (highest first) and return top N
  return compatibilities
    .sort((a, b) => b.compatibility_score - a.compatibility_score)
    .slice(0, limit);
}

/**
 * Get a user's public profile info
 */
export async function getPublicProfile(
  db: D1Database,
  userId: number
): Promise<{
  user: { id: number; displayName: string | null; profileImage: string | null; totalComparisons: number } | null;
  isPublic: boolean;
}> {
  const user = await db
    .prepare(
      `SELECT id, twitch_display_name, twitch_profile_image, total_comparisons, is_profile_public
       FROM users WHERE id = ?`
    )
    .bind(userId)
    .first<{
      id: number;
      twitch_display_name: string | null;
      twitch_profile_image: string | null;
      total_comparisons: number;
      is_profile_public: number;
    }>();

  if (!user) {
    return { user: null, isPublic: false };
  }

  if (user.is_profile_public !== 1) {
    return { user: null, isPublic: false };
  }

  return {
    user: {
      id: user.id,
      displayName: user.twitch_display_name,
      profileImage: user.twitch_profile_image,
      totalComparisons: user.total_comparisons,
    },
    isPublic: true,
  };
}

/**
 * Get a user's top clips (for public profile)
 */
export async function getUserTopClips(
  db: D1Database,
  userId: number,
  limit = 10
): Promise<{ id: number; twitchSlug: string; title: string | null; userElo: number }[]> {
  const result = await db
    .prepare(
      `SELECT c.id, c.twitch_slug, c.title, ucr.elo_rating
       FROM clips c
       JOIN user_clip_ratings ucr ON c.id = ucr.clip_id
       WHERE ucr.user_id = ? AND ucr.matches_played > 0 AND c.is_active = 1
       ORDER BY ucr.elo_rating DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<{ id: number; twitch_slug: string; title: string | null; elo_rating: number }>();

  return result.results.map(r => ({
    id: r.id,
    twitchSlug: r.twitch_slug,
    title: r.title,
    userElo: r.elo_rating,
  }));
}

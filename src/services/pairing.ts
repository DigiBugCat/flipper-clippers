import type { Clip, UserClipRating } from '../types';
import { getRecentPairings, recordPairing, getUserClipRatings, getAllClips } from '../db/queries';

interface ClipWithRating {
  clip: Clip;
  userRating: UserClipRating | null;
}

/**
 * Get the next pair of clips for a user to compare
 *
 * Strategy:
 * 1. Prioritize clips with high rating deviation (uncertain)
 * 2. Avoid recently shown pairs
 * 3. Match clips with similar ratings for informative comparisons
 * 4. Ensure variety (don't repeat same clips too often)
 */
export async function getNextPair(
  db: D1Database,
  userId: number
): Promise<{ clipA: Clip; clipB: Clip } | null> {
  // Get all active clips
  const clips = await getAllClips(db);
  if (clips.length < 2) {
    return null;
  }

  // Get user's ratings for personalized pairing
  const userRatings = await getUserClipRatings(db, userId);
  const ratingMap = new Map<number, UserClipRating>();
  for (const rating of userRatings) {
    ratingMap.set(rating.clip_id, rating);
  }

  // Get recently shown pairs to avoid
  const recentPairs = await getRecentPairings(db, userId, 24);

  // Build clip list with ratings
  const clipsWithRatings: ClipWithRating[] = clips.map((clip) => ({
    clip,
    userRating: ratingMap.get(clip.id) || null,
  }));

  // Score all possible pairs and find the best one
  let bestPair: { clipA: Clip; clipB: Clip } | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < clipsWithRatings.length; i++) {
    for (let j = i + 1; j < clipsWithRatings.length; j++) {
      const a = clipsWithRatings[i];
      const b = clipsWithRatings[j];

      // Create pair key for lookup
      const pairKey = [Math.min(a.clip.id, b.clip.id), Math.max(a.clip.id, b.clip.id)].join('-');

      // Skip if recently shown
      if (recentPairs.has(pairKey)) {
        continue;
      }

      // Calculate pair score
      const score = calculatePairScore(a, b);

      if (score > bestScore) {
        bestScore = score;
        bestPair = { clipA: a.clip, clipB: b.clip };
      }
    }
  }

  // If all pairs have been shown recently, pick the least recently shown
  if (!bestPair) {
    bestPair = getLeastShownPair(clipsWithRatings);
  }

  if (bestPair) {
    // Randomize order 50% of the time
    if (Math.random() > 0.5) {
      bestPair = { clipA: bestPair.clipB, clipB: bestPair.clipA };
    }

    // Record this pairing
    await recordPairing(db, userId, bestPair.clipA.id, bestPair.clipB.id);
  }

  return bestPair;
}

/**
 * Calculate a score for a potential pair
 * Higher score = more valuable comparison
 */
function calculatePairScore(a: ClipWithRating, b: ClipWithRating): number {
  let score = 0;

  // Get ratings (use defaults if no user rating exists)
  const ratingA = a.userRating?.elo_rating ?? a.clip.global_elo;
  const ratingB = b.userRating?.elo_rating ?? b.clip.global_elo;
  const deviationA = a.userRating?.rating_deviation ?? a.clip.rating_deviation;
  const deviationB = b.userRating?.rating_deviation ?? b.clip.rating_deviation;
  const matchesA = a.userRating?.matches_played ?? 0;
  const matchesB = b.userRating?.matches_played ?? 0;

  // 1. Uncertainty bonus (prioritize clips needing more data)
  // Higher deviation = more uncertain = more valuable to compare
  const avgDeviation = (deviationA + deviationB) / 2;
  score += avgDeviation * 0.5; // Max ~175 points

  // 2. Rating similarity bonus (more informative when close)
  // Comparing clips with similar ratings gives more information
  const ratingDiff = Math.abs(ratingA - ratingB);
  if (ratingDiff < 200) {
    score += 100 - ratingDiff / 2; // Max 100 points
  }

  // 3. Low match count bonus (prioritize under-compared clips)
  const minMatches = Math.min(matchesA, matchesB);
  if (minMatches < 5) {
    score += (5 - minMatches) * 20; // Max 100 points
  }

  // 4. Small random factor for variety
  score += Math.random() * 20;

  return score;
}

/**
 * Fallback: get the pair with fewest comparisons
 */
function getLeastShownPair(clips: ClipWithRating[]): { clipA: Clip; clipB: Clip } | null {
  if (clips.length < 2) return null;

  // Sort by least matches played
  const sorted = [...clips].sort((a, b) => {
    const matchesA = a.userRating?.matches_played ?? 0;
    const matchesB = b.userRating?.matches_played ?? 0;
    return matchesA - matchesB;
  });

  // Pick two clips with fewest matches, add some randomness
  const pool = sorted.slice(0, Math.min(10, sorted.length));
  const shuffled = pool.sort(() => Math.random() - 0.5);

  return {
    clipA: shuffled[0].clip,
    clipB: shuffled[1].clip,
  };
}

/**
 * Get statistics about pairing coverage
 */
export async function getPairingStats(db: D1Database, userId: number): Promise<{
  totalClips: number;
  totalPossiblePairs: number;
  userComparisons: number;
  coveragePercent: number;
}> {
  const clips = await getAllClips(db);
  const totalClips = clips.length;
  const totalPossiblePairs = (totalClips * (totalClips - 1)) / 2;

  // Count user's unique comparisons
  const result = await db
    .prepare(
      `SELECT COUNT(DISTINCT CASE
         WHEN clip_a_id < clip_b_id THEN clip_a_id || '-' || clip_b_id
         ELSE clip_b_id || '-' || clip_a_id
       END) as count
       FROM comparisons WHERE user_id = ?`
    )
    .bind(userId)
    .first<{ count: number }>();

  const userComparisons = result?.count ?? 0;
  const coveragePercent = totalPossiblePairs > 0 ? (userComparisons / totalPossiblePairs) * 100 : 0;

  return {
    totalClips,
    totalPossiblePairs,
    userComparisons,
    coveragePercent,
  };
}

import type { Clip } from '../types';
import { getAllClips, updateClipGlobalRating } from '../db/queries';

interface UserRatingRow {
  clip_id: number;
  elo_rating: number;
  matches_played: number;
  wins: number;
  losses: number;
  ties: number;
  super_liked: number;
  rating_deviation: number;
  user_comparisons: number;
}

/**
 * Aggregate rankings from all users into global rankings
 * Uses weighted average based on user comparison count
 */
export async function aggregateGlobalRankings(db: D1Database): Promise<void> {
  const clips = await getAllClips(db);

  for (const clip of clips) {
    // Get all user ratings for this clip with user's total comparison count
    const result = await db
      .prepare(
        `SELECT
           ucr.clip_id,
           ucr.elo_rating,
           ucr.matches_played,
           ucr.wins,
           ucr.losses,
           ucr.ties,
           ucr.super_liked,
           ucr.rating_deviation,
           u.total_comparisons as user_comparisons
         FROM user_clip_ratings ucr
         JOIN users u ON ucr.user_id = u.id
         WHERE ucr.clip_id = ?`
      )
      .bind(clip.id)
      .all<UserRatingRow>();

    const userRatings = result.results;

    if (userRatings.length === 0) {
      continue;
    }

    // Calculate weighted average rating
    let totalWeight = 0;
    let weightedRating = 0;
    let totalMatches = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalTies = 0;
    let totalSuperLikes = 0;
    let weightedDeviation = 0;

    for (const rating of userRatings) {
      // Weight by number of comparisons (more active users have more influence)
      // Cap influence at 100 comparisons to prevent one super-active user from dominating
      const weight = Math.min(rating.user_comparisons, 100);

      weightedRating += rating.elo_rating * weight;
      weightedDeviation += rating.rating_deviation * weight;
      totalWeight += weight;

      // Sum up stats
      totalMatches += rating.matches_played;
      totalWins += rating.wins;
      totalLosses += rating.losses;
      totalTies += rating.ties;
      totalSuperLikes += rating.super_liked;
    }

    if (totalWeight > 0) {
      const globalElo = weightedRating / totalWeight;
      const globalDeviation = weightedDeviation / totalWeight;

      await updateClipGlobalRating(
        db,
        clip.id,
        globalElo,
        totalMatches,
        totalWins,
        totalLosses,
        totalTies,
        totalSuperLikes,
        globalDeviation
      );
    }
  }
}

/**
 * Get aggregation statistics
 */
export async function getAggregationStats(db: D1Database): Promise<{
  totalUsers: number;
  totalComparisons: number;
  totalClipsRated: number;
  avgComparisonsPerUser: number;
}> {
  const users = await db
    .prepare('SELECT COUNT(*) as count, SUM(total_comparisons) as total FROM users')
    .first<{ count: number; total: number }>();

  const clipsRated = await db
    .prepare('SELECT COUNT(*) as count FROM clips WHERE global_matches > 0')
    .first<{ count: number }>();

  const totalUsers = users?.count ?? 0;
  const totalComparisons = users?.total ?? 0;
  const totalClipsRated = clipsRated?.count ?? 0;
  const avgComparisonsPerUser = totalUsers > 0 ? totalComparisons / totalUsers : 0;

  return {
    totalUsers,
    totalComparisons,
    totalClipsRated,
    avgComparisonsPerUser,
  };
}

/**
 * Compare rankings between users to see agreement/disagreement
 */
export async function compareUserRankings(
  db: D1Database,
  userIdA: number,
  userIdB: number
): Promise<{
  agreementScore: number;
  sharedClips: number;
  topDisagreements: Array<{ clip: Clip; rankA: number; rankB: number }>;
}> {
  // Get both users' rankings
  const ratingsA = await db
    .prepare(
      `SELECT clip_id, elo_rating,
       ROW_NUMBER() OVER (ORDER BY elo_rating DESC) as rank
       FROM user_clip_ratings
       WHERE user_id = ? AND matches_played > 0`
    )
    .bind(userIdA)
    .all<{ clip_id: number; elo_rating: number; rank: number }>();

  const ratingsB = await db
    .prepare(
      `SELECT clip_id, elo_rating,
       ROW_NUMBER() OVER (ORDER BY elo_rating DESC) as rank
       FROM user_clip_ratings
       WHERE user_id = ? AND matches_played > 0`
    )
    .bind(userIdB)
    .all<{ clip_id: number; elo_rating: number; rank: number }>();

  // Build lookup maps
  const rankMapA = new Map<number, number>();
  const rankMapB = new Map<number, number>();

  for (const r of ratingsA.results) {
    rankMapA.set(r.clip_id, r.rank);
  }
  for (const r of ratingsB.results) {
    rankMapB.set(r.clip_id, r.rank);
  }

  // Find shared clips
  const sharedClipIds = [...rankMapA.keys()].filter((id) => rankMapB.has(id));
  const sharedClips = sharedClipIds.length;

  if (sharedClips === 0) {
    return { agreementScore: 0, sharedClips: 0, topDisagreements: [] };
  }

  // Calculate rank correlation (Spearman's rho simplified)
  let sumDiffSquared = 0;
  const disagreements: Array<{ clipId: number; rankA: number; rankB: number; diff: number }> = [];

  for (const clipId of sharedClipIds) {
    const rankA = rankMapA.get(clipId)!;
    const rankB = rankMapB.get(clipId)!;
    const diff = rankA - rankB;
    sumDiffSquared += diff * diff;
    disagreements.push({ clipId, rankA, rankB, diff: Math.abs(diff) });
  }

  // Spearman correlation coefficient
  const n = sharedClips;
  const rho = 1 - (6 * sumDiffSquared) / (n * (n * n - 1));
  const agreementScore = Math.max(0, Math.min(100, ((rho + 1) / 2) * 100));

  // Get top disagreements
  disagreements.sort((a, b) => b.diff - a.diff);
  const topDisagreementIds = disagreements.slice(0, 5);

  const topDisagreements: Array<{ clip: Clip; rankA: number; rankB: number }> = [];
  for (const d of topDisagreementIds) {
    const clip = await db.prepare('SELECT * FROM clips WHERE id = ?').bind(d.clipId).first<Clip>();
    if (clip) {
      topDisagreements.push({ clip, rankA: d.rankA, rankB: d.rankB });
    }
  }

  return { agreementScore, sharedClips, topDisagreements };
}

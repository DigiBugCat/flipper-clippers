import type { Clip } from '../types';

// Rollup staleness threshold (5 minutes)
const ROLLUP_STALE_MINUTES = 5;

// Recency weighting configuration
const RATING_HALF_LIFE_DAYS = 14; // Rating influence halves every 14 days
const MIN_RECENCY_FACTOR = 0.1; // Minimum 10% weight for old ratings

interface AggregatedClipRow {
  clip_id: number;
  weighted_elo: number | null;
  weighted_deviation: number | null;
  total_matches: number;
  total_wins: number;
  total_losses: number;
  total_ties: number;
  total_super_likes: number;
}

interface RollupRow {
  clip_id: number;
  weighted_elo: number;
  weighted_deviation: number;
  weighted_elo_sum: number;
  weighted_deviation_sum: number;
  weight_sum: number;
  total_matches: number;
  total_wins: number;
  total_losses: number;
  total_ties: number;
  total_super_likes: number;
  last_updated_at: string;
}

/**
 * Aggregate rankings from all users into global rankings
 * Uses rollup table with lazy update (recalculates if stale > 5 min)
 */
export async function aggregateGlobalRankings(db: D1Database): Promise<void> {
  console.log('[AGGREGATION] Starting global rankings aggregation...');
  const startTime = Date.now();

  // Check rollup freshness (single query instead of two)
  const rollupStatus = await db
    .prepare('SELECT COUNT(*) as count, MIN(last_updated_at) as oldest FROM clip_rating_rollups')
    .first<{ count: number; oldest: string | null }>();

  const hasRollups = (rollupStatus?.count ?? 0) > 0;
  let isStale = true;

  if (hasRollups && rollupStatus?.oldest) {
    const oldestTime = new Date(rollupStatus.oldest).getTime();
    const now = Date.now();
    const ageMinutes = (now - oldestTime) / 1000 / 60;
    isStale = ageMinutes > ROLLUP_STALE_MINUTES;
    console.log(`[AGGREGATION] Rollup age: ${ageMinutes.toFixed(1)} min, stale=${isStale}`);
  } else {
    console.log('[AGGREGATION] No rollups found, will calculate');
  }

  if (!isStale && hasRollups) {
    // Fast path: rollup is fresh, clips table already in sync - skip entirely
    console.log(`[AGGREGATION] Rollup fresh, skipping sync (${Date.now() - startTime}ms)`);
    return;
  }

  // Recalculate from ratings (slow path - ~962 rows)
  const aggregatedResults = await recalculateAggregates(db, startTime);

  // Update clips table from aggregated data
  const updateStatements = aggregatedResults.map((row) =>
    db
      .prepare(
        `UPDATE clips SET
         global_elo = ?, global_matches = ?, global_wins = ?, global_losses = ?,
         global_ties = ?, global_super_likes = ?, rating_deviation = ?, last_rated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        row.weighted_elo,
        row.total_matches,
        row.total_wins,
        row.total_losses,
        row.total_ties,
        row.total_super_likes,
        row.weighted_deviation ?? 350,
        row.clip_id
      )
  );

  if (updateStatements.length > 0) {
    await db.batch(updateStatements);
  }

  console.log(`[AGGREGATION] Batch updated ${updateStatements.length} clips in ${Date.now() - startTime}ms total`);
}

/**
 * Recalculate aggregates from user_clip_ratings and update rollup table
 */
async function recalculateAggregates(db: D1Database, startTime: number): Promise<AggregatedClipRow[]> {
  // Query 1: Get all active clip IDs
  const clipsResult = await db
    .prepare('SELECT id FROM clips WHERE is_active = 1')
    .all<{ id: number }>();
  const clipIds = new Set(clipsResult.results.map((r) => r.id));
  console.log(`[AGGREGATION] Query 1: ${clipIds.size} clips, rows_read=${clipsResult.meta?.rows_read}`);

  // Query 2: Get all user clip ratings (including updated_at for recency weighting)
  const ratingsResult = await db
    .prepare('SELECT user_id, clip_id, elo_rating, rating_deviation, matches_played, wins, losses, ties, super_liked, updated_at FROM user_clip_ratings')
    .all<{
      user_id: number;
      clip_id: number;
      elo_rating: number;
      rating_deviation: number;
      matches_played: number;
      wins: number;
      losses: number;
      ties: number;
      super_liked: number;
      updated_at: string;
    }>();
  console.log(`[AGGREGATION] Query 2: ${ratingsResult.results.length} ratings, rows_read=${ratingsResult.meta?.rows_read}`);

  // Query 3: Get all users with their comparison counts
  const usersResult = await db
    .prepare('SELECT id, total_comparisons FROM users')
    .all<{ id: number; total_comparisons: number }>();
  const usersMap = new Map(usersResult.results.map((u) => [u.id, Math.min(u.total_comparisons, 100)]));
  console.log(`[AGGREGATION] Query 3: ${usersResult.results.length} users, rows_read=${usersResult.meta?.rows_read}`);

  // In-memory aggregation
  const clipAggregates = new Map<number, {
    weightedEloSum: number;
    weightedDeviationSum: number;
    weightSum: number;
    totalMatches: number;
    totalWins: number;
    totalLosses: number;
    totalTies: number;
    totalSuperLikes: number;
  }>();

  const now = Date.now();

  for (const rating of ratingsResult.results) {
    if (!clipIds.has(rating.clip_id)) continue;

    const userWeight = usersMap.get(rating.user_id) ?? 0;
    if (userWeight === 0) continue;

    // Calculate recency factor based on when rating was last updated
    const updatedAt = rating.updated_at ? new Date(rating.updated_at).getTime() : now;
    const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.max(
      MIN_RECENCY_FACTOR,
      Math.pow(0.5, daysSinceUpdate / RATING_HALF_LIFE_DAYS)
    );
    const effectiveWeight = userWeight * recencyFactor;

    let agg = clipAggregates.get(rating.clip_id);
    if (!agg) {
      agg = {
        weightedEloSum: 0,
        weightedDeviationSum: 0,
        weightSum: 0,
        totalMatches: 0,
        totalWins: 0,
        totalLosses: 0,
        totalTies: 0,
        totalSuperLikes: 0,
      };
      clipAggregates.set(rating.clip_id, agg);
    }

    agg.weightedEloSum += rating.elo_rating * effectiveWeight;
    agg.weightedDeviationSum += rating.rating_deviation * effectiveWeight;
    agg.weightSum += effectiveWeight;
    agg.totalMatches += rating.matches_played;
    agg.totalWins += rating.wins;
    agg.totalLosses += rating.losses;
    agg.totalTies += rating.ties;
    agg.totalSuperLikes += rating.super_liked;
  }

  // Build aggregated results
  const aggregatedResults: AggregatedClipRow[] = [];
  for (const [clipId, agg] of clipAggregates) {
    if (agg.weightSum > 0) {
      aggregatedResults.push({
        clip_id: clipId,
        weighted_elo: agg.weightedEloSum / agg.weightSum,
        weighted_deviation: agg.weightedDeviationSum / agg.weightSum,
        total_matches: agg.totalMatches,
        total_wins: agg.totalWins,
        total_losses: agg.totalLosses,
        total_ties: agg.totalTies,
        total_super_likes: agg.totalSuperLikes,
      });
    }
  }

  const totalRowsRead = (clipsResult.meta?.rows_read ?? 0) + (ratingsResult.meta?.rows_read ?? 0) + (usersResult.meta?.rows_read ?? 0);
  console.log(`[AGGREGATION] Recalculated ${aggregatedResults.length} clips, total_rows_read=${totalRowsRead} in ${Date.now() - startTime}ms`);

  // Update rollup table with sum columns for incremental updates
  const rollupStatements = aggregatedResults.map((row) => {
    const agg = clipAggregates.get(row.clip_id)!;
    return db
      .prepare(
        `INSERT OR REPLACE INTO clip_rating_rollups
         (clip_id, weighted_elo, weighted_deviation, weighted_elo_sum, weighted_deviation_sum, weight_sum,
          total_matches, total_wins, total_losses, total_ties, total_super_likes, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .bind(
        row.clip_id,
        row.weighted_elo,
        row.weighted_deviation,
        agg.weightedEloSum,
        agg.weightedDeviationSum,
        agg.weightSum,
        row.total_matches,
        row.total_wins,
        row.total_losses,
        row.total_ties,
        row.total_super_likes
      );
  });

  if (rollupStatements.length > 0) {
    await db.batch(rollupStatements);
    console.log(`[AGGREGATION] Updated ${rollupStatements.length} rollups`);
  }

  return aggregatedResults;
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

/**
 * Incrementally update rollup for a single clip after a vote
 * Called from vote handler to keep rollup fresh without full recalculation
 *
 * Note: Recency weighting is applied during full recalculation (recalculateAggregates).
 * Incremental updates use full weight since votes are always "now" (recency = 1.0).
 * This creates minor drift over time, corrected by periodic full recalculation.
 */
export async function updateRollupForVote(
  db: D1Database,
  clipId: number,
  oldElo: number,
  newElo: number,
  oldDeviation: number,
  newDeviation: number,
  userWeight: number,
  isNewRating: boolean,
  statsDelta: { matches: number; wins: number; losses: number; ties: number; superLike: number }
): Promise<void> {
  console.log(`[ROLLUP] Updating clip=${clipId} isNew=${isNewRating} weight=${userWeight}`);

  // Read current rollup for this clip
  const rollup = await db
    .prepare('SELECT * FROM clip_rating_rollups WHERE clip_id = ?')
    .bind(clipId)
    .first<RollupRow>();

  console.log(`[ROLLUP] clip=${clipId} hasRollup=${!!rollup}`);

  if (!rollup) {
    // No rollup exists yet - create initial entry
    const weightedEloSum = newElo * userWeight;
    const weightedDeviationSum = newDeviation * userWeight;

    // Atomic batch update: rollup + clips together
    await db.batch([
      db
        .prepare(
          `INSERT INTO clip_rating_rollups
           (clip_id, weighted_elo, weighted_deviation, weighted_elo_sum, weighted_deviation_sum, weight_sum,
            total_matches, total_wins, total_losses, total_ties, total_super_likes, last_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(
          clipId,
          newElo,
          newDeviation,
          weightedEloSum,
          weightedDeviationSum,
          userWeight,
          statsDelta.matches,
          statsDelta.wins,
          statsDelta.losses,
          statsDelta.ties,
          statsDelta.superLike
        ),
      db
        .prepare(
          `UPDATE clips SET
           global_elo = ?, global_matches = ?, global_wins = ?, global_losses = ?,
           global_ties = ?, global_super_likes = ?, rating_deviation = ?, last_rated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(
          newElo,
          statsDelta.matches,
          statsDelta.wins,
          statsDelta.losses,
          statsDelta.ties,
          statsDelta.superLike,
          newDeviation,
          clipId
        ),
    ]);

    console.log(`[ROLLUP] Created new rollup for clip=${clipId}`);
    return;
  }

  // Calculate delta for weighted sums
  let newEloSum = rollup.weighted_elo_sum ?? 0;
  let newDeviationSum = rollup.weighted_deviation_sum ?? 0;
  let newWeightSum = rollup.weight_sum ?? 0;

  if (isNewRating) {
    // New rating: just add contribution
    newEloSum += newElo * userWeight;
    newDeviationSum += newDeviation * userWeight;
    newWeightSum += userWeight;
  } else {
    // Updated rating: subtract old, add new
    newEloSum = newEloSum - oldElo * userWeight + newElo * userWeight;
    newDeviationSum = newDeviationSum - oldDeviation * userWeight + newDeviation * userWeight;
    // Weight sum unchanged for updates
  }

  // Calculate new averages
  const newWeightedElo = newWeightSum > 0 ? newEloSum / newWeightSum : newElo;
  const newWeightedDeviation = newWeightSum > 0 ? newDeviationSum / newWeightSum : newDeviation;

  // Calculate new totals for clips table
  const newMatches = rollup.total_matches + statsDelta.matches;
  const newWins = rollup.total_wins + statsDelta.wins;
  const newLosses = rollup.total_losses + statsDelta.losses;
  const newTies = rollup.total_ties + statsDelta.ties;
  const newSuperLikes = rollup.total_super_likes + statsDelta.superLike;

  // Atomic batch update: rollup + clips together
  await db.batch([
    db
      .prepare(
        `UPDATE clip_rating_rollups SET
         weighted_elo = ?, weighted_deviation = ?,
         weighted_elo_sum = ?, weighted_deviation_sum = ?, weight_sum = ?,
         total_matches = total_matches + ?, total_wins = total_wins + ?,
         total_losses = total_losses + ?, total_ties = total_ties + ?,
         total_super_likes = total_super_likes + ?, last_updated_at = datetime('now')
         WHERE clip_id = ?`
      )
      .bind(
        newWeightedElo,
        newWeightedDeviation,
        newEloSum,
        newDeviationSum,
        newWeightSum,
        statsDelta.matches,
        statsDelta.wins,
        statsDelta.losses,
        statsDelta.ties,
        statsDelta.superLike,
        clipId
      ),
    db
      .prepare(
        `UPDATE clips SET
         global_elo = ?, global_matches = ?, global_wins = ?, global_losses = ?,
         global_ties = ?, global_super_likes = ?, rating_deviation = ?, last_rated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        newWeightedElo,
        newMatches,
        newWins,
        newLosses,
        newTies,
        newSuperLikes,
        newWeightedDeviation,
        clipId
      ),
  ]);

  console.log(`[ROLLUP] Updated clip=${clipId} newElo=${newWeightedElo.toFixed(1)}`);
}

import type { Clip } from '../types';
import { getClipById } from '../db/queries';

// Simple pair type for cookie storage
export type PairIds = [number, number];

// Pairing configuration constants
const COOLDOWN_HOURS = 24; // Deprioritize pairs where both clips were rated within this window

/**
 * Calculate next N pairs for a user using minimal D1 queries
 * Pairs are stored in cookie and popped one at a time
 */
export async function calculateNextPairs(
  db: D1Database,
  userId: number,
  count: number = 10
): Promise<PairIds[]> {
  console.log(`[PAIRING] calculateNextPairs user=${userId} count=${count}`);
  const startTime = Date.now();

  // Query 1: Get all active clip IDs (small query, just IDs)
  const clipsResult = await db
    .prepare('SELECT id FROM clips WHERE is_active = 1')
    .all<{ id: number }>();
  const allClipIds = clipsResult.results.map((r) => r.id);
  console.log(`[PAIRING] Query 1: ${allClipIds.length} clips, rows_read=${clipsResult.meta?.rows_read}`);

  if (allClipIds.length < 2) {
    return [];
  }

  // Query 2: Get user's rated clips with updated_at (for recency-based deprioritization)
  const ratedResult = await db
    .prepare('SELECT clip_id, updated_at FROM user_clip_ratings WHERE user_id = ?')
    .bind(userId)
    .all<{ clip_id: number; updated_at: string }>();

  const ratedClipIds = new Set(ratedResult.results.map((r) => r.clip_id));
  const clipLastRated = new Map<number, number>(); // clip_id -> timestamp
  const now = Date.now();
  const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;

  for (const r of ratedResult.results) {
    clipLastRated.set(r.clip_id, new Date(r.updated_at).getTime());
  }
  console.log(`[PAIRING] Query 2: ${ratedClipIds.size} rated, rows_read=${ratedResult.meta?.rows_read}`);

  // Calculate pairs in Worker memory
  const pairs: PairIds[] = [];
  const usedInBatch = new Set<string>();

  // Prioritize unrated clips
  const unratedClipIds = allClipIds.filter((id) => !ratedClipIds.has(id));
  const ratedClipIdsList = allClipIds.filter((id) => ratedClipIds.has(id));

  // Strategy: pair unrated with rated, then unrated with unrated, then rated with rated
  const candidates: PairIds[] = [];

  // Unrated vs rated (highest priority)
  for (const unrated of unratedClipIds) {
    for (const rated of ratedClipIdsList) {
      candidates.push([unrated, rated]);
    }
  }

  // Unrated vs unrated
  for (let i = 0; i < unratedClipIds.length; i++) {
    for (let j = i + 1; j < unratedClipIds.length; j++) {
      candidates.push([unratedClipIds[i], unratedClipIds[j]]);
    }
  }

  // Rated vs rated (lowest priority, for when user has seen most clips)
  for (let i = 0; i < ratedClipIdsList.length; i++) {
    for (let j = i + 1; j < ratedClipIdsList.length; j++) {
      candidates.push([ratedClipIdsList[i], ratedClipIdsList[j]]);
    }
  }

  // Shuffle candidates for variety within priority groups
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Separate candidates into fresh pairs and recently-rated pairs
  // A pair is "recently rated" if BOTH clips were rated within the cooldown period
  const freshCandidates: PairIds[] = [];
  const recentCandidates: PairIds[] = [];

  for (const [a, b] of candidates) {
    const lastRatedA = clipLastRated.get(a) ?? 0;
    const lastRatedB = clipLastRated.get(b) ?? 0;

    // If BOTH clips were rated recently, this pair was likely just compared
    const bothRecent = (now - lastRatedA < cooldownMs) && (now - lastRatedB < cooldownMs);

    if (bothRecent) {
      recentCandidates.push([a, b]);
    } else {
      freshCandidates.push([a, b]);
    }
  }

  // Select pairs: prefer fresh, fall back to recently-rated
  const selectFrom = (pool: PairIds[]) => {
    for (const [a, b] of pool) {
      if (pairs.length >= count) break;

      const pairKey = [Math.min(a, b), Math.max(a, b)].join('-');
      if (usedInBatch.has(pairKey)) continue;

      // Randomize order 50% of the time
      const pair: PairIds = Math.random() > 0.5 ? [a, b] : [b, a];
      pairs.push(pair);
      usedInBatch.add(pairKey);
    }
  };

  selectFrom(freshCandidates);
  if (pairs.length < count) {
    selectFrom(recentCandidates);
  }

  console.log(`[PAIRING] Generated ${pairs.length} pairs in ${Date.now() - startTime}ms`);
  return pairs;
}

/**
 * Get the next pair from cookie or calculate new batch
 * Returns clip objects for the response
 */
export async function getNextPair(
  db: D1Database,
  userId: number
): Promise<{ clipA: Clip; clipB: Clip } | null> {
  // This function now just calculates one pair for backwards compatibility
  // The compare handler should use calculateNextPairs + cookie instead
  const pairs = await calculateNextPairs(db, userId, 1);

  if (pairs.length === 0) {
    return null;
  }

  const [clipAId, clipBId] = pairs[0];
  const clipA = await getClipById(db, clipAId);
  const clipB = await getClipById(db, clipBId);

  if (!clipA || !clipB) {
    return null;
  }

  return { clipA, clipB };
}

/**
 * Get statistics about pairing coverage
 * Uses denormalized unique_pairs_voted column for performance (avoids full table scan)
 */
export async function getPairingStats(db: D1Database, userId: number): Promise<{
  totalClips: number;
  totalPossiblePairs: number;
  userComparisons: number;
  coveragePercent: number;
}> {
  // Parallel queries for clip count and user's unique pairs count
  const [clipsResult, userResult] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM clips WHERE is_active = 1').first<{ count: number }>(),
    db.prepare('SELECT unique_pairs_voted FROM users WHERE id = ?').bind(userId).first<{ unique_pairs_voted: number }>(),
  ]);

  const totalClips = clipsResult?.count ?? 0;
  const totalPossiblePairs = Math.max(0, (totalClips * (totalClips - 1)) / 2);
  const userComparisons = userResult?.unique_pairs_voted ?? 0;
  const coveragePercent = totalPossiblePairs > 0 ? (userComparisons / totalPossiblePairs) * 100 : 0;

  return {
    totalClips,
    totalPossiblePairs,
    userComparisons,
    coveragePercent,
  };
}

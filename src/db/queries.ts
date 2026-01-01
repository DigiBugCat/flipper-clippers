import type { User, Clip, Comparison, UserClipRating, Session, VoteResult } from '../types';

// User queries
export async function getUserByTwitchId(db: D1Database, twitchId: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE twitch_id = ?').bind(twitchId).first<User>();
}

export async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
}

export async function createUser(
  db: D1Database,
  twitchId: string,
  username: string,
  displayName: string | null,
  profileImage: string | null
): Promise<User> {
  await db
    .prepare(
      `INSERT INTO users (twitch_id, twitch_username, twitch_display_name, twitch_profile_image)
       VALUES (?, ?, ?, ?)`
    )
    .bind(twitchId, username, displayName, profileImage)
    .run();

  const user = await getUserByTwitchId(db, twitchId);
  if (!user) throw new Error('Failed to create user');
  return user;
}

export async function updateUserLogin(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?")
    .bind(userId)
    .run();
}

export async function incrementUserComparisons(db: D1Database, userId: number, isSuperLike: boolean): Promise<void> {
  if (isSuperLike) {
    await db
      .prepare("UPDATE users SET total_comparisons = total_comparisons + 1, total_super_likes = total_super_likes + 1, last_login = datetime('now') WHERE id = ?")
      .bind(userId)
      .run();
  } else {
    await db
      .prepare("UPDATE users SET total_comparisons = total_comparisons + 1, last_login = datetime('now') WHERE id = ?")
      .bind(userId)
      .run();
  }
}

export async function updateUserPrivacy(db: D1Database, userId: number, isPublic: boolean): Promise<void> {
  await db
    .prepare('UPDATE users SET is_profile_public = ? WHERE id = ?')
    .bind(isPublic ? 1 : 0, userId)
    .run();
}

// Session queries
export async function createSession(db: D1Database, sessionId: string, userId: number, expiresAt: string): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, userId, expiresAt)
    .run();
}

export async function getSession(db: D1Database, sessionId: string): Promise<Session | null> {
  return db
    .prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')")
    .bind(sessionId)
    .first<Session>();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function cleanExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// Clip queries
export async function getAllClips(db: D1Database): Promise<Clip[]> {
  const result = await db.prepare('SELECT * FROM clips WHERE is_active = 1').all<Clip>();
  return result.results;
}

export async function getClipById(db: D1Database, id: number): Promise<Clip | null> {
  return db.prepare('SELECT * FROM clips WHERE id = ?').bind(id).first<Clip>();
}

/**
 * Batch fetch multiple clips by IDs (1 query instead of N)
 */
export async function getClipsByIds(db: D1Database, ids: number[]): Promise<Map<number, Clip>> {
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(',');
  const result = await db
    .prepare(`SELECT * FROM clips WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<Clip>();

  return new Map(result.results.map(clip => [clip.id, clip]));
}

export async function getClipBySlug(db: D1Database, slug: string): Promise<Clip | null> {
  return db.prepare('SELECT * FROM clips WHERE twitch_slug = ?').bind(slug).first<Clip>();
}

export async function createClip(db: D1Database, slug: string, title: string | null, url: string): Promise<Clip> {
  await db
    .prepare('INSERT OR IGNORE INTO clips (twitch_slug, title, twitch_url) VALUES (?, ?, ?)')
    .bind(slug, title, url)
    .run();

  const clip = await getClipBySlug(db, slug);
  if (!clip) throw new Error('Failed to create clip');
  return clip;
}

export async function updateClipGlobalRating(
  db: D1Database,
  clipId: number,
  elo: number,
  matches: number,
  wins: number,
  losses: number,
  ties: number,
  superLikes: number,
  ratingDeviation: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE clips SET
       global_elo = ?, global_matches = ?, global_wins = ?, global_losses = ?,
       global_ties = ?, global_super_likes = ?, rating_deviation = ?, last_rated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(elo, matches, wins, losses, ties, superLikes, ratingDeviation, clipId)
    .run();
}

// Comparison queries
export async function createComparison(
  db: D1Database,
  userId: number,
  clipAId: number,
  clipBId: number,
  winnerClipId: number | null,
  result: VoteResult,
  timeSpentMs: number | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO comparisons (user_id, clip_a_id, clip_b_id, winner_clip_id, result, time_spent_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, clipAId, clipBId, winnerClipId, result, timeSpentMs)
    .run();
}

export async function getUserComparisons(db: D1Database, userId: number, limit = 50): Promise<Comparison[]> {
  const result = await db
    .prepare('SELECT * FROM comparisons WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(userId, limit)
    .all<Comparison>();
  return result.results;
}

// Enriched comparison with clip data (single JOIN query instead of N+1)
export interface EnrichedComparison {
  id: number;
  result: string;
  created_at: string;
  clipA_id: number;
  clipA_title: string | null;
  clipA_slug: string;
  clipB_id: number;
  clipB_title: string | null;
  clipB_slug: string;
}

export async function getUserComparisonsWithClips(
  db: D1Database,
  userId: number,
  limit = 50
): Promise<EnrichedComparison[]> {
  const result = await db
    .prepare(
      `SELECT
         c.id,
         c.result,
         c.created_at,
         ca.id as clipA_id,
         ca.title as clipA_title,
         ca.twitch_slug as clipA_slug,
         cb.id as clipB_id,
         cb.title as clipB_title,
         cb.twitch_slug as clipB_slug
       FROM comparisons c
       JOIN clips ca ON c.clip_a_id = ca.id
       JOIN clips cb ON c.clip_b_id = cb.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<EnrichedComparison>();
  return result.results;
}

// User clip rating queries
export async function getUserClipRating(db: D1Database, userId: number, clipId: number): Promise<UserClipRating | null> {
  return db
    .prepare('SELECT * FROM user_clip_ratings WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<UserClipRating>();
}

/**
 * Batch fetch user ratings for multiple clips (1 query instead of N)
 */
export async function getUserClipRatingsForClips(
  db: D1Database,
  userId: number,
  clipIds: number[]
): Promise<Map<number, UserClipRating>> {
  if (clipIds.length === 0) return new Map();

  const placeholders = clipIds.map(() => '?').join(',');
  const result = await db
    .prepare(`SELECT * FROM user_clip_ratings WHERE user_id = ? AND clip_id IN (${placeholders})`)
    .bind(userId, ...clipIds)
    .all<UserClipRating>();

  return new Map(result.results.map(rating => [rating.clip_id, rating]));
}

export async function upsertUserClipRating(
  db: D1Database,
  userId: number,
  clipId: number,
  eloRating: number,
  matchesPlayed: number,
  wins: number,
  losses: number,
  ties: number,
  superLiked: number,
  ratingDeviation: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_clip_ratings (user_id, clip_id, elo_rating, matches_played, wins, losses, ties, super_liked, rating_deviation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, clip_id) DO UPDATE SET
       elo_rating = excluded.elo_rating,
       matches_played = excluded.matches_played,
       wins = excluded.wins,
       losses = excluded.losses,
       ties = excluded.ties,
       super_liked = excluded.super_liked,
       rating_deviation = excluded.rating_deviation,
       updated_at = datetime('now')`
    )
    .bind(userId, clipId, eloRating, matchesPlayed, wins, losses, ties, superLiked, ratingDeviation)
    .run();
}

export interface RatingUpsertData {
  clipId: number;
  eloRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  superLiked: number;
  ratingDeviation: number;
}

/**
 * Batch upsert multiple user clip ratings (1 batch instead of N writes)
 */
export async function batchUpsertUserClipRatings(
  db: D1Database,
  userId: number,
  ratings: RatingUpsertData[]
): Promise<void> {
  if (ratings.length === 0) return;

  const statements = ratings.map(r =>
    db
      .prepare(
        `INSERT INTO user_clip_ratings (user_id, clip_id, elo_rating, matches_played, wins, losses, ties, super_liked, rating_deviation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, clip_id) DO UPDATE SET
         elo_rating = excluded.elo_rating,
         matches_played = excluded.matches_played,
         wins = excluded.wins,
         losses = excluded.losses,
         ties = excluded.ties,
         super_liked = excluded.super_liked,
         rating_deviation = excluded.rating_deviation,
         updated_at = datetime('now')`
      )
      .bind(userId, r.clipId, r.eloRating, r.matchesPlayed, r.wins, r.losses, r.ties, r.superLiked, r.ratingDeviation)
  );

  await db.batch(statements);
}

export async function getUserClipRatings(db: D1Database, userId: number): Promise<UserClipRating[]> {
  const result = await db
    .prepare('SELECT * FROM user_clip_ratings WHERE user_id = ?')
    .bind(userId)
    .all<UserClipRating>();
  return result.results;
}

export async function getUserSuperLikedClips(db: D1Database, userId: number): Promise<Clip[]> {
  const result = await db
    .prepare(
      `SELECT c.* FROM clips c
       JOIN user_clip_ratings ucr ON c.id = ucr.clip_id
       WHERE ucr.user_id = ? AND ucr.super_liked = 1
       ORDER BY ucr.elo_rating DESC`
    )
    .bind(userId)
    .all<Clip>();
  return result.results;
}

// Pairing history queries
export async function getRecentPairings(db: D1Database, userId: number, hoursAgo = 24): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT clip_a_id, clip_b_id FROM pairing_history
       WHERE user_id = ? AND last_shown_at > datetime('now', '-' || ? || ' hours')`
    )
    .bind(userId, hoursAgo)
    .all<{ clip_a_id: number; clip_b_id: number }>();

  const pairSet = new Set<string>();
  for (const row of result.results) {
    const key = [Math.min(row.clip_a_id, row.clip_b_id), Math.max(row.clip_a_id, row.clip_b_id)].join('-');
    pairSet.add(key);
  }
  return pairSet;
}

export async function recordPairing(db: D1Database, userId: number, clipAId: number, clipBId: number): Promise<void> {
  // Normalize order
  const [minId, maxId] = clipAId < clipBId ? [clipAId, clipBId] : [clipBId, clipAId];

  await db
    .prepare(
      `INSERT INTO pairing_history (user_id, clip_a_id, clip_b_id)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, clip_a_id, clip_b_id) DO UPDATE SET
       times_shown = times_shown + 1,
       last_shown_at = datetime('now')`
    )
    .bind(userId, minId, maxId)
    .run();
}

// Leaderboard queries
export type SortField = 'elo' | 'matches' | 'winrate' | 'superlikes';
export type SortOrder = 'asc' | 'desc';

const SORT_COLUMNS: Record<SortField, string> = {
  elo: 'global_elo',
  matches: 'global_matches',
  winrate: 'CASE WHEN global_matches > 0 THEN CAST(global_wins AS REAL) / global_matches ELSE 0 END',
  superlikes: 'global_super_likes',
};

export async function getGlobalLeaderboard(
  db: D1Database,
  limit = 50,
  offset = 0,
  sort: SortField = 'elo',
  order: SortOrder = 'desc'
): Promise<{ clips: Clip[]; total: number }> {
  const orderColumn = SORT_COLUMNS[sort] || SORT_COLUMNS.elo;
  const orderDir = order === 'asc' ? 'ASC' : 'DESC';

  // Get total count for pagination
  const countResult = await db
    .prepare('SELECT COUNT(*) as count FROM clips WHERE is_active = 1 AND global_matches > 0')
    .first<{ count: number }>();
  const total = countResult?.count ?? 0;

  const result = await db
    .prepare(
      `SELECT * FROM clips
       WHERE is_active = 1 AND global_matches > 0
       ORDER BY ${orderColumn} ${orderDir}
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<Clip>();

  return { clips: result.results, total };
}

export async function getUserLeaderboard(db: D1Database, userId: number, limit = 50): Promise<(Clip & { user_elo: number; manual_position: number | null })[]> {
  const result = await db
    .prepare(
      `SELECT c.*, ucr.elo_rating as user_elo, ucr.manual_position FROM clips c
       JOIN user_clip_ratings ucr ON c.id = ucr.clip_id
       WHERE ucr.user_id = ? AND ucr.matches_played > 0
       ORDER BY
         CASE WHEN ucr.manual_position IS NOT NULL THEN 0 ELSE 1 END,
         ucr.manual_position ASC,
         ucr.elo_rating DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<Clip & { user_elo: number; manual_position: number | null }>();
  return result.results;
}

// Initialize manual positions for a user based on current ELO order
export async function initializeManualPositions(db: D1Database, userId: number): Promise<void> {
  // Get all clips ordered by ELO
  const clips = await db
    .prepare(
      `SELECT clip_id FROM user_clip_ratings
       WHERE user_id = ? AND matches_played > 0 AND manual_position IS NULL
       ORDER BY elo_rating DESC`
    )
    .bind(userId)
    .all<{ clip_id: number }>();

  // Get current max position
  const maxPos = await db
    .prepare('SELECT COALESCE(MAX(manual_position), 0) as max_pos FROM user_clip_ratings WHERE user_id = ?')
    .bind(userId)
    .first<{ max_pos: number }>();

  let position = (maxPos?.max_pos ?? 0) + 1;

  // Assign positions
  for (const clip of clips.results) {
    await db
      .prepare('UPDATE user_clip_ratings SET manual_position = ? WHERE user_id = ? AND clip_id = ?')
      .bind(position, userId, clip.clip_id)
      .run();
    position++;
  }
}

// Reorder personal ranking - also updates global ELO when moving clips up
export async function reorderPersonalRanking(db: D1Database, userId: number, clipId: number, newPosition: number): Promise<{ clipsBeaten: number }> {
  // Get current position
  const current = await db
    .prepare('SELECT manual_position FROM user_clip_ratings WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<{ manual_position: number | null }>();

  if (!current) return { clipsBeaten: 0 };

  const oldPosition = current.manual_position;
  if (oldPosition === null || oldPosition === newPosition) return { clipsBeaten: 0 };

  // Get count of clips with positions
  const countResult = await db
    .prepare('SELECT COUNT(*) as count FROM user_clip_ratings WHERE user_id = ? AND manual_position IS NOT NULL')
    .bind(userId)
    .first<{ count: number }>();

  const count = countResult?.count ?? 0;
  const boundedNewPosition = Math.max(1, Math.min(newPosition, count));

  let clipsBeaten = 0;

  // If moving UP (to a lower position number), this clip "beats" all clips it jumped over
  if (boundedNewPosition < oldPosition) {
    // Get clips that will be jumped over
    const beatenClips = await db
      .prepare(
        `SELECT clip_id FROM user_clip_ratings
         WHERE user_id = ? AND manual_position >= ? AND manual_position < ?`
      )
      .bind(userId, boundedNewPosition, oldPosition)
      .all<{ clip_id: number }>();

    clipsBeaten = beatenClips.results.length;

    // Give the moved clip a global ELO boost based on how many clips it beat
    // Each "win" gives ~16-32 ELO points depending on K-factor
    // We'll give a smaller boost per clip since this is implicit
    const eloBoostPerClip = 8; // Smaller than a real win
    const totalBoost = clipsBeaten * eloBoostPerClip;

    if (totalBoost > 0) {
      await db
        .prepare(
          `UPDATE clips SET
           global_elo = global_elo + ?,
           global_matches = global_matches + ?,
           global_wins = global_wins + ?
           WHERE id = ?`
        )
        .bind(totalBoost, clipsBeaten, clipsBeaten, clipId)
        .run();

      // Also give small ELO loss to clips that were jumped over
      const eloLossPerClip = 4; // Smaller loss since it's implicit
      for (const beaten of beatenClips.results) {
        await db
          .prepare(
            `UPDATE clips SET
             global_elo = global_elo - ?,
             global_matches = global_matches + 1,
             global_losses = global_losses + 1
             WHERE id = ?`
          )
          .bind(eloLossPerClip, beaten.clip_id)
          .run();
      }
    }

    // Shift items between new and old-1 down by 1
    await db
      .prepare('UPDATE user_clip_ratings SET manual_position = manual_position + 1 WHERE user_id = ? AND manual_position >= ? AND manual_position < ?')
      .bind(userId, boundedNewPosition, oldPosition)
      .run();
  } else {
    // Moving down: just shift positions, no ELO changes (demoting doesn't penalize)
    await db
      .prepare('UPDATE user_clip_ratings SET manual_position = manual_position - 1 WHERE user_id = ? AND manual_position > ? AND manual_position <= ?')
      .bind(userId, oldPosition, boundedNewPosition)
      .run();
  }

  // Set the new position
  await db
    .prepare('UPDATE user_clip_ratings SET manual_position = ? WHERE user_id = ? AND clip_id = ?')
    .bind(boundedNewPosition, userId, clipId)
    .run();

  return { clipsBeaten };
}

// Saved clips queries
export interface SavedClip {
  id: number;
  user_id: number;
  clip_id: number;
  position: number;
  saved_at: string;
}

export async function getSavedClips(db: D1Database, userId: number): Promise<(Clip & { position: number; saved_at: string })[]> {
  const result = await db
    .prepare(
      `SELECT c.*, sc.position, sc.saved_at FROM clips c
       JOIN saved_clips sc ON c.id = sc.clip_id
       WHERE sc.user_id = ?
       ORDER BY sc.position ASC`
    )
    .bind(userId)
    .all<Clip & { position: number; saved_at: string }>();
  return result.results;
}

export async function isClipSaved(db: D1Database, userId: number, clipId: number): Promise<boolean> {
  const result = await db
    .prepare('SELECT 1 FROM saved_clips WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first();
  return result !== null;
}

// Batch check multiple clips at once (single query instead of N queries)
export async function areClipsSaved(
  db: D1Database,
  userId: number,
  clipIds: number[]
): Promise<Record<number, boolean>> {
  if (clipIds.length === 0) return {};

  // Build parameterized IN clause
  const placeholders = clipIds.map(() => '?').join(',');
  const result = await db
    .prepare(`SELECT clip_id FROM saved_clips WHERE user_id = ? AND clip_id IN (${placeholders})`)
    .bind(userId, ...clipIds)
    .all<{ clip_id: number }>();

  const savedSet = new Set(result.results.map((r) => r.clip_id));
  const results: Record<number, boolean> = {};
  for (const clipId of clipIds) {
    results[clipId] = savedSet.has(clipId);
  }
  return results;
}

export async function saveClip(db: D1Database, userId: number, clipId: number): Promise<void> {
  // Get the next position (max + 1)
  const maxPos = await db
    .prepare('SELECT COALESCE(MAX(position), 0) as max_pos FROM saved_clips WHERE user_id = ?')
    .bind(userId)
    .first<{ max_pos: number }>();

  const newPosition = (maxPos?.max_pos ?? 0) + 1;

  await db
    .prepare('INSERT OR IGNORE INTO saved_clips (user_id, clip_id, position) VALUES (?, ?, ?)')
    .bind(userId, clipId, newPosition)
    .run();
}

export async function unsaveClip(db: D1Database, userId: number, clipId: number): Promise<void> {
  // Get the position of the clip being removed
  const saved = await db
    .prepare('SELECT position FROM saved_clips WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<{ position: number }>();

  if (!saved) return;

  // Delete the clip
  await db
    .prepare('DELETE FROM saved_clips WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .run();

  // Shift all clips after it up by 1
  await db
    .prepare('UPDATE saved_clips SET position = position - 1 WHERE user_id = ? AND position > ?')
    .bind(userId, saved.position)
    .run();
}

// Get user's clips sorted by ELO for binary search ranking
export async function getUserClipsSortedByElo(db: D1Database, userId: number): Promise<(Clip & { user_elo: number })[]> {
  const result = await db
    .prepare(
      `SELECT c.*, ucr.elo_rating as user_elo FROM clips c
       JOIN user_clip_ratings ucr ON c.id = ucr.clip_id
       WHERE ucr.user_id = ? AND ucr.matches_played > 0 AND c.is_active = 1
       ORDER BY ucr.elo_rating DESC`
    )
    .bind(userId)
    .all<Clip & { user_elo: number }>();
  return result.results;
}

// Create clip with additional metadata
export async function createClipWithMetadata(
  db: D1Database,
  slug: string,
  title: string | null,
  url: string,
  clippedBy: string | null,
  submittedBy: number | null
): Promise<Clip> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO clips (twitch_slug, title, twitch_url, clipped_by)
       VALUES (?, ?, ?, ?)`
    )
    .bind(slug, title, url, clippedBy)
    .run();

  const clip = await getClipBySlug(db, slug);
  if (!clip) throw new Error('Failed to create clip');
  return clip;
}

export async function reorderSavedClip(db: D1Database, userId: number, clipId: number, newPosition: number): Promise<void> {
  // Get current position
  const saved = await db
    .prepare('SELECT position FROM saved_clips WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<{ position: number }>();

  if (!saved) return;

  const oldPosition = saved.position;
  if (oldPosition === newPosition) return;

  // Ensure newPosition is within bounds
  const countResult = await db
    .prepare('SELECT COUNT(*) as count FROM saved_clips WHERE user_id = ?')
    .bind(userId)
    .first<{ count: number }>();

  const count = countResult?.count ?? 0;
  const boundedNewPosition = Math.max(1, Math.min(newPosition, count));

  if (oldPosition < boundedNewPosition) {
    // Moving down: shift items between old+1 and new up by 1
    await db
      .prepare('UPDATE saved_clips SET position = position - 1 WHERE user_id = ? AND position > ? AND position <= ?')
      .bind(userId, oldPosition, boundedNewPosition)
      .run();
  } else {
    // Moving up: shift items between new and old-1 down by 1
    await db
      .prepare('UPDATE saved_clips SET position = position + 1 WHERE user_id = ? AND position >= ? AND position < ?')
      .bind(userId, boundedNewPosition, oldPosition)
      .run();
  }

  // Set the new position
  await db
    .prepare('UPDATE saved_clips SET position = ? WHERE user_id = ? AND clip_id = ?')
    .bind(boundedNewPosition, userId, clipId)
    .run();
}

// Admin: Get voter leaderboard (users sorted by vote count)
export interface VoterStats {
  id: number;
  twitch_username: string;
  twitch_display_name: string | null;
  twitch_profile_image: string | null;
  total_comparisons: number;
  total_super_likes: number;
  last_active: string;
}

export async function getVoterLeaderboard(db: D1Database): Promise<VoterStats[]> {
  const result = await db
    .prepare(
      `SELECT id, twitch_username, twitch_display_name, twitch_profile_image,
              total_comparisons, total_super_likes, last_active
       FROM users
       WHERE total_comparisons > 0
       ORDER BY total_comparisons DESC`
    )
    .all<VoterStats>();
  return result.results;
}

// Personal leaderboard sort options
export type PersonalSortField = 'elo' | 'recent' | 'matches';

export async function getUserLeaderboardSorted(
  db: D1Database,
  userId: number,
  limit = 50,
  sort: PersonalSortField = 'elo'
): Promise<(Clip & { user_elo: number; manual_position: number | null; matches_played: number; updated_at: string })[]> {
  let orderClause: string;

  switch (sort) {
    case 'recent':
      orderClause = 'ucr.updated_at DESC';
      break;
    case 'matches':
      orderClause = 'ucr.matches_played DESC, ucr.elo_rating DESC';
      break;
    case 'elo':
    default:
      orderClause = `
        CASE WHEN ucr.manual_position IS NOT NULL THEN 0 ELSE 1 END,
        ucr.manual_position ASC,
        ucr.elo_rating DESC`;
      break;
  }

  const result = await db
    .prepare(
      `SELECT c.*, ucr.elo_rating as user_elo, ucr.manual_position, ucr.matches_played, ucr.updated_at
       FROM clips c
       JOIN user_clip_ratings ucr ON c.id = ucr.clip_id
       WHERE ucr.user_id = ? AND ucr.matches_played > 0
       ORDER BY ${orderClause}
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<Clip & { user_elo: number; manual_position: number | null; matches_played: number; updated_at: string }>();
  return result.results;
}

// Remove clip from user's rankings
export async function deleteUserClipRating(db: D1Database, userId: number, clipId: number): Promise<void> {
  // Get the current position of the clip being removed
  const rating = await db
    .prepare('SELECT manual_position FROM user_clip_ratings WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .first<{ manual_position: number | null }>();

  if (!rating) return;

  // Delete the clip rating
  await db
    .prepare('DELETE FROM user_clip_ratings WHERE user_id = ? AND clip_id = ?')
    .bind(userId, clipId)
    .run();

  // If it had a manual position, shift all clips after it up by 1
  if (rating.manual_position !== null) {
    await db
      .prepare('UPDATE user_clip_ratings SET manual_position = manual_position - 1 WHERE user_id = ? AND manual_position > ?')
      .bind(userId, rating.manual_position)
      .run();
  }
}

// Vote history entry for a clip
export interface VoteHistoryEntry {
  id: number;
  opponent_id: number;
  opponent_title: string | null;
  opponent_slug: string;
  result: string;
  is_super_like: boolean;
  created_at: string;
}

// Get vote history for a specific clip
export async function getUserVoteHistoryForClip(
  db: D1Database,
  userId: number,
  clipId: number
): Promise<VoteHistoryEntry[]> {
  const result = await db
    .prepare(
      `SELECT
         c.id,
         CASE WHEN c.clip_a_id = ? THEN cb.id ELSE ca.id END as opponent_id,
         CASE WHEN c.clip_a_id = ? THEN cb.title ELSE ca.title END as opponent_title,
         CASE WHEN c.clip_a_id = ? THEN cb.twitch_slug ELSE ca.twitch_slug END as opponent_slug,
         c.result,
         CASE WHEN c.result = 'super_like' THEN 1 ELSE 0 END as is_super_like,
         c.created_at
       FROM comparisons c
       JOIN clips ca ON c.clip_a_id = ca.id
       JOIN clips cb ON c.clip_b_id = cb.id
       WHERE c.user_id = ? AND (c.clip_a_id = ? OR c.clip_b_id = ?)
       ORDER BY c.created_at DESC`
    )
    .bind(clipId, clipId, clipId, userId, clipId, clipId)
    .all<VoteHistoryEntry>();
  return result.results;
}

// Delete a single comparison and return whether it was deleted
export async function deleteComparison(db: D1Database, comparisonId: number, userId: number): Promise<boolean> {
  // Verify the comparison belongs to this user and get clip IDs
  const comparison = await db
    .prepare('SELECT clip_a_id, clip_b_id FROM comparisons WHERE id = ? AND user_id = ?')
    .bind(comparisonId, userId)
    .first<{ clip_a_id: number; clip_b_id: number }>();

  if (!comparison) return false;

  // Delete the comparison
  await db
    .prepare('DELETE FROM comparisons WHERE id = ?')
    .bind(comparisonId)
    .run();

  return true;
}

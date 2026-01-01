import type { ActivityType, ActivityEntry, Clip, User } from '../types';

export interface ActivityWithUser extends ActivityEntry {
  user_display_name: string | null;
  user_profile_image: string | null;
  clip_slug: string | null;
}

export interface TrendingClipResult {
  clip_id: number;
  twitch_slug: string;
  title: string | null;
  global_elo: number;
  vote_count: number;
  super_like_count: number;
}

/**
 * Record an activity to the feed
 */
export async function recordActivity(
  db: D1Database,
  userId: number,
  activityType: ActivityType,
  clipId: number,
  clipTitle: string | null,
  extraData: object | null,
  isPublic: boolean
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_feed (user_id, activity_type, clip_id, clip_title, extra_data, is_public)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      userId,
      activityType,
      clipId,
      clipTitle,
      extraData ? JSON.stringify(extraData) : null,
      isPublic ? 1 : 0
    )
    .run();
}

/**
 * Get global activity feed (public activities only)
 */
export async function getGlobalFeed(
  db: D1Database,
  limit = 50,
  offset = 0
): Promise<ActivityWithUser[]> {
  const result = await db
    .prepare(
      `SELECT af.*, u.twitch_display_name as user_display_name,
              u.twitch_profile_image as user_profile_image,
              c.twitch_slug as clip_slug
       FROM activity_feed af
       JOIN users u ON af.user_id = u.id
       LEFT JOIN clips c ON af.clip_id = c.id
       WHERE af.is_public = 1
       ORDER BY af.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<ActivityWithUser>();
  return result.results;
}

/**
 * Get user's own activity history
 */
export async function getUserActivityHistory(
  db: D1Database,
  userId: number,
  limit = 50,
  offset = 0
): Promise<ActivityWithUser[]> {
  const result = await db
    .prepare(
      `SELECT af.*, u.twitch_display_name as user_display_name,
              u.twitch_profile_image as user_profile_image,
              c.twitch_slug as clip_slug
       FROM activity_feed af
       JOIN users u ON af.user_id = u.id
       LEFT JOIN clips c ON af.clip_id = c.id
       WHERE af.user_id = ?
       ORDER BY af.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(userId, limit, offset)
    .all<ActivityWithUser>();
  return result.results;
}

/**
 * Get trending clips based on recent activity
 */
export async function getTrendingClips(
  db: D1Database,
  period: '24h' | '7d' | '30d' = '24h',
  limit = 10
): Promise<TrendingClipResult[]> {
  const periodHours = period === '24h' ? 24 : period === '7d' ? 168 : 720;

  const result = await db
    .prepare(
      `SELECT
         c.id as clip_id,
         c.twitch_slug,
         c.title,
         c.global_elo,
         COUNT(CASE WHEN af.activity_type IN ('vote', 'super_like') THEN 1 END) as vote_count,
         COUNT(CASE WHEN af.activity_type = 'super_like' THEN 1 END) as super_like_count
       FROM clips c
       JOIN activity_feed af ON c.id = af.clip_id
       WHERE af.created_at > datetime('now', '-' || ? || ' hours')
         AND af.activity_type IN ('vote', 'super_like')
         AND c.is_active = 1
       GROUP BY c.id
       ORDER BY vote_count DESC, super_like_count DESC
       LIMIT ?`
    )
    .bind(periodHours, limit)
    .all<TrendingClipResult>();
  return result.results;
}

/**
 * Check if user's profile is public
 */
export async function isUserProfilePublic(db: D1Database, userId: number): Promise<boolean> {
  const result = await db
    .prepare('SELECT is_profile_public FROM users WHERE id = ?')
    .bind(userId)
    .first<{ is_profile_public: number }>();
  return result?.is_profile_public === 1;
}

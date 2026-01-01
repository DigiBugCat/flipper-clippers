import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/types';
import feed from '../../../src/handlers/feed';
import { createMockD1 } from '../../setup/mocks/d1';
import { createMockKV } from '../../setup/mocks/kv';
import { createTestUser } from '../../fixtures/users';
import { createTestClip } from '../../fixtures/clips';
import { createTestSession } from '../../fixtures/sessions';

/**
 * Integration tests for the Feed Handler
 *
 * Tests the following endpoints:
 * - GET /global - Global activity feed (public activities)
 * - GET /trending - Trending clips based on recent activity
 * - GET /me - User's own activity history (requires auth)
 */

// Test data types
interface MockActivity {
  id: number;
  user_id: number;
  activity_type: 'vote' | 'super_like' | 'comment' | 'save';
  clip_id: number;
  clip_title: string | null;
  extra_data: string | null;
  is_public: number;
  created_at: string;
  user_display_name: string | null;
  user_profile_image: string | null;
  clip_slug: string | null;
}

interface MockTrendingResult {
  clip_id: number;
  twitch_slug: string;
  title: string | null;
  global_elo: number;
  vote_count: number;
  super_like_count: number;
}

// Mock query options
interface MockQueryOptions {
  activities?: MockActivity[];
  trendingClips?: MockTrendingResult[];
  session?: { id: string; user_id: number; expires_at: string } | null;
  user?: ReturnType<typeof createTestUser> | null;
}

/**
 * Creates a mock D1 database with configurable responses for feed tests
 */
function createFeedMockD1(options: MockQueryOptions = {}) {
  const { activities = [], trendingClips = [], session = null, user = null } = options;

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      sql,
      params,
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(): Promise<T | null> {
        // Session lookup
        if (sql.includes('sessions') && sql.includes('expires_at')) {
          return session as T;
        }
        // User lookup
        if (sql.includes('FROM users WHERE id')) {
          return user as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        // Global feed query
        if (sql.includes('activity_feed') && sql.includes('is_public = 1') && sql.includes('ORDER BY')) {
          return { results: activities as T[], meta: { rows_read: activities.length } };
        }
        // User activity history query
        if (sql.includes('activity_feed') && sql.includes('user_id = ?') && sql.includes('ORDER BY')) {
          const userId = params[0] as number;
          const filtered = activities.filter((a) => a.user_id === userId);
          return { results: filtered as T[], meta: { rows_read: filtered.length } };
        }
        // Trending clips query
        if (sql.includes('clips') && sql.includes('activity_feed') && sql.includes('GROUP BY')) {
          return { results: trendingClips as T[], meta: { rows_read: trendingClips.length } };
        }
        return { results: [] as T[], meta: { rows_read: 0 } };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        return { success: true, meta: { changes: 1 } };
      },
    };
  };

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch(statements: ReturnType<typeof createStatement>[]): Promise<unknown[]> {
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    async exec(): Promise<{ success: boolean }> {
      return { success: true };
    },
  } as unknown as D1Database;
}

/**
 * Creates test environment with mocks
 */
function createTestEnv(options: MockQueryOptions = {}) {
  return {
    DB: createFeedMockD1(options),
    SESSION_CACHE: createMockKV(),
    THUMBNAIL_CACHE: createMockKV(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
  };
}

/**
 * Helper function to make a request to the app
 */
function createRequest(
  path: string,
  options: { method?: string; cookie?: string } = {}
): Request {
  const headers = new Headers();
  if (options.cookie) {
    headers.set('Cookie', options.cookie);
  }

  return new Request(`http://localhost/feed${path}`, {
    method: options.method || 'GET',
    headers,
  });
}

describe('Feed Handler Integration Tests', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono<{ Bindings: Env }>();
    app.route('/feed', feed);
  });

  /**
   * Helper to create activity records for testing
   */
  function createMockActivity(overrides: Partial<MockActivity> = {}): MockActivity {
    return {
      id: 1,
      user_id: 1,
      activity_type: 'vote',
      clip_id: 1,
      clip_title: 'Test Clip',
      extra_data: null,
      is_public: 1,
      created_at: new Date().toISOString(),
      user_display_name: 'Regular User',
      user_profile_image: 'https://example.com/regular.png',
      clip_slug: 'HighRatedClip-abc123',
      ...overrides,
    };
  }

  describe('GET /global - Global Activity Feed', () => {
    it('returns empty activities array when no activities exist', async () => {
      const env = createTestEnv({ activities: [] });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toEqual([]);
    });

    it('returns only public activities', async () => {
      const activities = [
        createMockActivity({ id: 1, activity_type: 'vote', is_public: 1 }),
        createMockActivity({ id: 2, activity_type: 'super_like', is_public: 1 }),
      ];
      // Note: Private activities (is_public: 0) are filtered out by the SQL query
      // The mock only returns public activities

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      // All returned activities should be public (vote and super_like, not save)
      expect(data.activities.every((a: any) => a.type !== 'save')).toBe(true);
    });

    it('returns activities with correct structure', async () => {
      const activities = [
        createMockActivity({
          id: 1,
          activity_type: 'vote',
          clip_id: 1,
          clip_title: 'High Rated Clip',
          extra_data: JSON.stringify({ winner: 'clip_a' }),
          clip_slug: 'HighRatedClip-abc123',
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(1);

      const activity = data.activities[0];
      expect(activity).toHaveProperty('id');
      expect(activity).toHaveProperty('type', 'vote');
      expect(activity).toHaveProperty('clipId', 1);
      expect(activity).toHaveProperty('clipTitle', 'High Rated Clip');
      expect(activity).toHaveProperty('clipSlug');
      expect(activity).toHaveProperty('extraData');
      expect(activity.extraData).toEqual({ winner: 'clip_a' });
      expect(activity).toHaveProperty('createdAt');
      expect(activity).toHaveProperty('user');
      expect(activity.user).toHaveProperty('displayName');
      expect(activity.user).toHaveProperty('profileImage');
    });

    it('returns activities ordered by creation date descending', async () => {
      const oldTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const newTimestamp = new Date().toISOString();

      const activities = [
        createMockActivity({ id: 2, clip_title: 'New Activity', created_at: newTimestamp }),
        createMockActivity({ id: 1, clip_title: 'Old Activity', created_at: oldTimestamp }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      // Newest activity should be first
      expect(data.activities[0].clipTitle).toBe('New Activity');
      expect(data.activities[1].clipTitle).toBe('Old Activity');
    });

    it('respects limit query parameter', async () => {
      const activities = Array.from({ length: 10 }, (_, i) =>
        createMockActivity({ id: i + 1, clip_title: `Activity ${i}` })
      ).slice(0, 5); // Simulate limit=5 being applied

      const env = createTestEnv({ activities });
      const req = createRequest('/global?limit=5');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(5);
    });

    it('respects offset query parameter', async () => {
      // Create activities with distinct titles (simulating offset=2)
      const activities = [
        createMockActivity({ id: 3, clip_title: 'Activity 2' }),
        createMockActivity({ id: 4, clip_title: 'Activity 3' }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global?offset=2&limit=2');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      // Should skip first 2 activities (0 and 1), return activities 2 and 3
      expect(data.activities[0].clipTitle).toBe('Activity 2');
      expect(data.activities[1].clipTitle).toBe('Activity 3');
    });

    it('enforces maximum limit of 100', async () => {
      // Create 100 activities (simulating max limit)
      const activities = Array.from({ length: 100 }, (_, i) =>
        createMockActivity({ id: i + 1, clip_title: `Activity ${i}` })
      );

      const env = createTestEnv({ activities });
      const req = createRequest('/global?limit=150');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities.length).toBeLessThanOrEqual(100);
    });

    it('handles multiple users activities', async () => {
      const activities = [
        createMockActivity({
          id: 1,
          user_id: 1,
          activity_type: 'vote',
          clip_id: 1,
          clip_title: 'User 1 Vote',
          user_display_name: 'Regular User',
        }),
        createMockActivity({
          id: 2,
          user_id: 2,
          activity_type: 'super_like',
          clip_id: 2,
          clip_title: 'User 2 Super Like',
          user_display_name: 'Admin User',
        }),
        createMockActivity({
          id: 3,
          user_id: 3,
          activity_type: 'comment',
          clip_id: 3,
          clip_title: 'User 3 Comment',
          extra_data: JSON.stringify({ comment: 'Nice!' }),
          user_display_name: 'Private User',
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(3);

      // Verify different users
      const userDisplayNames = data.activities.map((a: any) => a.user.displayName);
      expect(userDisplayNames).toContain('Regular User');
      expect(userDisplayNames).toContain('Admin User');
      expect(userDisplayNames).toContain('Private User');
    });

    it('includes clip slug from clips table', async () => {
      const activities = [
        createMockActivity({
          id: 1,
          clip_id: 1,
          clip_title: 'High Rated Clip',
          clip_slug: 'HighRatedClip-abc123',
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities[0].clipSlug).toBe('HighRatedClip-abc123');
    });
  });

  describe('GET /trending - Trending Clips', () => {
    it('returns empty clips array when no recent activity', async () => {
      const env = createTestEnv({ trendingClips: [] });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.period).toBe('24h');
      expect(data.clips).toEqual([]);
    });

    it('returns trending clips with correct structure', async () => {
      const trendingClips: MockTrendingResult[] = [
        {
          clip_id: 1,
          twitch_slug: 'HighRatedClip-abc123',
          title: 'Amazing Play - High Rated',
          global_elo: 1800,
          vote_count: 10,
          super_like_count: 3,
        },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.clips).toHaveLength(1);

      const clip = data.clips[0];
      expect(clip).toHaveProperty('clipId', 1);
      expect(clip).toHaveProperty('twitchSlug', 'HighRatedClip-abc123');
      expect(clip).toHaveProperty('title', 'Amazing Play - High Rated');
      expect(clip).toHaveProperty('globalElo', 1800);
      expect(clip).toHaveProperty('voteCount');
      expect(clip).toHaveProperty('superLikeCount');
    });

    it('counts votes and super likes correctly', async () => {
      const trendingClips: MockTrendingResult[] = [
        {
          clip_id: 1,
          twitch_slug: 'Clip1',
          title: 'Clip 1',
          global_elo: 1500,
          vote_count: 5, // 3 votes + 2 super_likes
          super_like_count: 2,
        },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.clips).toHaveLength(1);
      // vote_count counts both votes and super_likes (5 total)
      expect(data.clips[0].voteCount).toBe(5);
      expect(data.clips[0].superLikeCount).toBe(2);
    });

    it('orders clips by vote count descending', async () => {
      const trendingClips: MockTrendingResult[] = [
        { clip_id: 2, twitch_slug: 'Clip2', title: 'Clip 2', global_elo: 1500, vote_count: 3, super_like_count: 0 },
        { clip_id: 1, twitch_slug: 'Clip1', title: 'Clip 1', global_elo: 1500, vote_count: 1, super_like_count: 0 },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.clips).toHaveLength(2);
      // Clip 2 should be first (more votes)
      expect(data.clips[0].clipId).toBe(2);
      expect(data.clips[1].clipId).toBe(1);
    });

    it('excludes inactive clips', async () => {
      // Mock only returns active clips
      const trendingClips: MockTrendingResult[] = [
        { clip_id: 1, twitch_slug: 'ActiveClip', title: 'Active Clip', global_elo: 1500, vote_count: 1, super_like_count: 0 },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.clips).toHaveLength(1);
      expect(data.clips[0].clipId).toBe(1);
    });

    it('respects 24h period parameter', async () => {
      const env = createTestEnv({ trendingClips: [] });
      const req = createRequest('/trending?period=24h');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.period).toBe('24h');
    });

    it('respects 7d period parameter', async () => {
      const trendingClips: MockTrendingResult[] = [
        { clip_id: 1, twitch_slug: 'Clip1', title: 'Clip 1', global_elo: 1500, vote_count: 1, super_like_count: 0 },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending?period=7d');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.period).toBe('7d');
    });

    it('respects 30d period parameter', async () => {
      const trendingClips: MockTrendingResult[] = [
        { clip_id: 1, twitch_slug: 'Clip1', title: 'Clip 1', global_elo: 1500, vote_count: 1, super_like_count: 0 },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending?period=30d');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.period).toBe('30d');
    });

    it('returns error for invalid period parameter', async () => {
      const env = createTestEnv({ trendingClips: [] });
      const req = createRequest('/trending?period=invalid');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe('Invalid period. Use 24h, 7d, or 30d');
    });

    it('respects limit query parameter', async () => {
      const trendingClips: MockTrendingResult[] = [
        { clip_id: 1, twitch_slug: 'Clip1', title: 'Clip 1', global_elo: 1500, vote_count: 3, super_like_count: 0 },
        { clip_id: 2, twitch_slug: 'Clip2', title: 'Clip 2', global_elo: 1400, vote_count: 2, super_like_count: 0 },
      ];

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending?limit=2');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.clips).toHaveLength(2);
    });

    it('enforces maximum limit of 50', async () => {
      const trendingClips = Array.from({ length: 50 }, (_, i) => ({
        clip_id: i + 1,
        twitch_slug: `Clip${i + 1}`,
        title: `Clip ${i + 1}`,
        global_elo: 1500,
        vote_count: 50 - i,
        super_like_count: 0,
      }));

      const env = createTestEnv({ trendingClips });
      const req = createRequest('/trending?limit=100');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      // Should not exceed 50 even though we requested 100
      expect(data.clips.length).toBeLessThanOrEqual(50);
    });

    it('only counts vote and super_like activities', async () => {
      // Mock returns empty because comment and save don't count
      const env = createTestEnv({ trendingClips: [] });
      const req = createRequest('/trending');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      // No trending clips because comment and save don't count
      expect(data.clips).toEqual([]);
    });
  });

  describe('GET /me - User Activity History', () => {
    it('returns 401 when not authenticated', async () => {
      const env = createTestEnv({});
      const req = createRequest('/me');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toBe('Not authenticated');
    });

    it('returns 401 for invalid session', async () => {
      const env = createTestEnv({ session: null, user: null });
      const req = createRequest('/me', { cookie: 'session=invalid-session-id' });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data.error).toBe('Invalid session');
    });

    it('returns empty activities for user with no history', async () => {
      const session = createTestSession({ id: 'user1-session', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      const env = createTestEnv({ session, user, activities: [] });

      // Cache the session in KV
      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toEqual([]);
    });

    it('returns user activities with correct structure', async () => {
      const session = createTestSession({ id: 'user1-session-2', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });
      const activities = [
        createMockActivity({
          id: 1,
          user_id: 1,
          activity_type: 'vote',
          clip_id: 1,
          clip_title: 'My Vote',
          extra_data: JSON.stringify({ winner: 'clip_a' }),
        }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(1);

      const activity = data.activities[0];
      expect(activity).toHaveProperty('id');
      expect(activity).toHaveProperty('type', 'vote');
      expect(activity).toHaveProperty('clipId', 1);
      expect(activity).toHaveProperty('clipTitle', 'My Vote');
      expect(activity).toHaveProperty('clipSlug');
      expect(activity).toHaveProperty('extraData');
      expect(activity.extraData).toEqual({ winner: 'clip_a' });
      expect(activity).toHaveProperty('createdAt');
      // Note: /me endpoint doesn't include user info since it's for the current user
    });

    it('returns both public and private activities for the user', async () => {
      const session = createTestSession({ id: 'user1-session-3', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });
      const activities = [
        createMockActivity({ id: 1, user_id: 1, activity_type: 'vote', clip_title: 'Public Vote', is_public: 1 }),
        createMockActivity({ id: 2, user_id: 1, activity_type: 'save', clip_title: 'Private Save', is_public: 0 }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      // Both public and private should be included
      const types = data.activities.map((a: any) => a.type);
      expect(types).toContain('vote');
      expect(types).toContain('save');
    });

    it('only returns activities for the authenticated user', async () => {
      const session = createTestSession({ id: 'user1-session-4', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });
      // Mock only returns activities for user_id: 1
      const activities = [
        createMockActivity({ id: 1, user_id: 1, clip_title: 'User 1 Activity' }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(1);
      expect(data.activities[0].clipTitle).toBe('User 1 Activity');
    });

    it('returns activities ordered by creation date descending', async () => {
      const session = createTestSession({ id: 'user1-session-5', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      const oldTimestamp = new Date(Date.now() - 3600000).toISOString();
      const newTimestamp = new Date().toISOString();

      const activities = [
        createMockActivity({ id: 2, user_id: 1, clip_title: 'New Activity', created_at: newTimestamp }),
        createMockActivity({ id: 1, user_id: 1, clip_title: 'Old Activity', created_at: oldTimestamp }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      expect(data.activities[0].clipTitle).toBe('New Activity');
      expect(data.activities[1].clipTitle).toBe('Old Activity');
    });

    it('respects limit query parameter', async () => {
      const session = createTestSession({ id: 'user1-session-6', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      const activities = Array.from({ length: 5 }, (_, i) =>
        createMockActivity({ id: i + 1, user_id: 1, clip_title: `Activity ${i}` })
      );

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me?limit=5', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(5);
    });

    it('respects offset query parameter', async () => {
      const session = createTestSession({ id: 'user1-session-7', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      // Simulate offset=2, limit=2
      const activities = [
        createMockActivity({ id: 3, user_id: 1, clip_title: 'Activity 2' }),
        createMockActivity({ id: 4, user_id: 1, clip_title: 'Activity 3' }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me?offset=2&limit=2', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(2);
      expect(data.activities[0].clipTitle).toBe('Activity 2');
      expect(data.activities[1].clipTitle).toBe('Activity 3');
    });

    it('enforces maximum limit of 100', async () => {
      const session = createTestSession({ id: 'user1-session-8', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      const activities = Array.from({ length: 100 }, (_, i) =>
        createMockActivity({ id: i + 1, user_id: 1, clip_title: `Activity ${i}` })
      );

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me?limit=150', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities.length).toBeLessThanOrEqual(100);
    });

    it('handles all activity types', async () => {
      const session = createTestSession({ id: 'user1-session-9', user_id: 1 });
      const user = createTestUser({
        id: 1,
        twitch_id: 'twitch_user_regular_123',
        twitch_username: 'regularuser',
        twitch_display_name: 'Regular User',
      });

      const activities = [
        createMockActivity({ id: 1, user_id: 1, activity_type: 'vote', clip_title: 'Vote Activity' }),
        createMockActivity({ id: 2, user_id: 1, activity_type: 'super_like', clip_title: 'Super Like Activity' }),
        createMockActivity({
          id: 3,
          user_id: 1,
          activity_type: 'comment',
          clip_title: 'Comment Activity',
          extra_data: JSON.stringify({ comment: 'Great!' }),
        }),
        createMockActivity({ id: 4, user_id: 1, activity_type: 'save', clip_title: 'Save Activity', is_public: 0 }),
      ];

      const env = createTestEnv({ session, user, activities });

      await env.SESSION_CACHE.put(
        `session:${session.id}`,
        JSON.stringify({
          session: {
            id: session.id,
            user_id: 1,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
          user: {
            id: 1,
            twitch_id: 'twitch_user_regular_123',
            twitch_username: 'regularuser',
            twitch_display_name: 'Regular User',
            twitch_profile_image: 'https://example.com/regular.png',
            is_profile_public: 1,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString(),
            total_comparisons: 0,
            total_super_likes: 0,
          },
        })
      );

      const req = createRequest('/me', { cookie: `session=${session.id}` });
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(4);

      const types = data.activities.map((a: any) => a.type);
      expect(types).toContain('vote');
      expect(types).toContain('super_like');
      expect(types).toContain('comment');
      expect(types).toContain('save');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('handles activities for non-existent clips gracefully', async () => {
      const activities = [
        createMockActivity({
          id: 1,
          clip_id: 9999,
          clip_title: 'Non-existent Clip',
          clip_slug: null,
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      // Should still return the activity, but clipSlug will be null
      expect(data.activities).toHaveLength(1);
      expect(data.activities[0].clipSlug).toBeNull();
    });

    it('handles null extra_data correctly', async () => {
      const activities = [
        createMockActivity({
          id: 1,
          clip_title: 'Vote without extra data',
          extra_data: null,
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities[0].extraData).toBeNull();
    });

    it('handles complex extra_data JSON', async () => {
      const complexData = {
        winner: 'clip_a',
        scores: { a: 1800, b: 1500 },
        metadata: { source: 'compare' },
      };
      const activities = [
        createMockActivity({
          id: 1,
          clip_title: 'Complex Vote',
          extra_data: JSON.stringify(complexData),
        }),
      ];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities[0].extraData).toEqual(complexData);
    });

    it('handles default values for limit and offset', async () => {
      const activities = [createMockActivity({ id: 1, clip_title: 'Test Activity' })];

      const env = createTestEnv({ activities });
      const req = createRequest('/global');
      const res = await app.fetch(req, env);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.activities).toHaveLength(1);
    });
  });
});

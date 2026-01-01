import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import clips, {
  getRankingSession,
  setRankingSession,
  deleteRankingSession,
  type RankingSession,
} from '../../../src/handlers/clips';
import type { Env, Clip, User, Session } from '../../../src/types';
import { createTestClip } from '../../fixtures/clips';
import { createTestUser } from '../../fixtures/users';
import { createTestSession } from '../../fixtures/sessions';
import { setupTwitchMocks, resetTwitchMocks, createMockClip } from '../../setup/mocks/fetch';

/**
 * Integration tests for src/handlers/clips.ts
 *
 * Tests cover:
 * - Getting all clips
 * - Getting single clip by ID
 * - Clip count stats
 * - Submitting new clips
 * - Ranking session management (KV functions)
 * - Binary search ranking algorithm
 */

// Mock DB response types
interface MockQueryOptions {
  clips?: Clip[];
  totalCount?: number;
  session?: Session | null;
  user?: User | null;
  userClipRatings?: Array<{
    user_id: number;
    clip_id: number;
    elo_rating: number;
    matches_played: number;
    manual_position: number | null;
  }>;
  sortedUserClips?: Array<{ id: number; elo: number }>;
}

/**
 * Creates a mock D1 database with configurable responses
 */
function createMockD1(options: MockQueryOptions = {}) {
  const {
    clips = [],
    totalCount = 0,
    session = null,
    user = null,
    userClipRatings = [],
    sortedUserClips = [],
  } = options;

  // Track inserted clips for the test
  const insertedClips: Clip[] = [];
  const insertedRatings: Array<{
    user_id: number;
    clip_id: number;
    elo_rating: number;
    matches_played: number;
    manual_position: number | null;
  }> = [];

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
        // Total count for clips
        if (sql.includes('COUNT(*)') && sql.includes('clips')) {
          return { count: totalCount } as T;
        }
        // Clip by ID
        if (sql.includes('FROM clips WHERE id')) {
          const clipId = params[0] as number;
          // Check inserted clips first
          const insertedClip = insertedClips.find((c) => c.id === clipId);
          if (insertedClip) return insertedClip as T;
          const clip = clips.find((c) => c.id === clipId);
          return (clip as T) ?? null;
        }
        // Clip by twitch_slug
        if (sql.includes('FROM clips WHERE twitch_slug')) {
          const slug = params[0] as string;
          // Check inserted clips first (for newly created clips)
          const insertedClip = insertedClips.find((c) => c.twitch_slug === slug);
          if (insertedClip) return insertedClip as T;
          const clip = clips.find((c) => c.twitch_slug === slug);
          return (clip as T) ?? null;
        }
        // User clip rating lookup
        if (sql.includes('FROM user_clip_ratings WHERE user_id') && sql.includes('clip_id')) {
          const userId = params[0] as number;
          const clipId = params[1] as number;
          // Check inserted ratings first
          const insertedRating = insertedRatings.find(
            (r) => r.user_id === userId && r.clip_id === clipId
          );
          if (insertedRating) return insertedRating as T;
          const rating = userClipRatings.find(
            (r) => r.user_id === userId && r.clip_id === clipId
          );
          return (rating as T) ?? null;
        }
        // Count user clip ratings
        if (sql.includes('COUNT(*)') && sql.includes('user_clip_ratings')) {
          const allRatings = [...userClipRatings, ...insertedRatings];
          return { count: allRatings.length } as T;
        }
        // Max manual position
        if (sql.includes('MAX(manual_position)')) {
          const allRatings = [...userClipRatings, ...insertedRatings];
          const maxPos = Math.max(
            0,
            ...allRatings.filter((r) => r.manual_position !== null).map((r) => r.manual_position!)
          );
          return { max_pos: maxPos } as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        // Get all active clips
        if (
          sql.includes('FROM clips') &&
          sql.includes('is_active = 1') &&
          !sql.includes('user_clip_ratings')
        ) {
          const activeClips = clips.filter((c) => c.is_active === 1);
          return { results: activeClips as T[], meta: { rows_read: activeClips.length } };
        }
        // User clips sorted by ELO for binary search
        if (sql.includes('user_clip_ratings') && sql.includes('ORDER BY')) {
          // Return sortedUserClips if provided, otherwise derive from userClipRatings
          if (sortedUserClips.length > 0) {
            const clipsWithElo = sortedUserClips.map((uc) => {
              const clip = clips.find((c) => c.id === uc.id);
              return clip
                ? { ...clip, user_elo: uc.elo, manual_position: null }
                : null;
            }).filter(Boolean);
            return { results: clipsWithElo as T[], meta: { rows_read: clipsWithElo.length } };
          }
          const allRatings = [...userClipRatings, ...insertedRatings];
          const userClipsData = allRatings
            .sort((a, b) => b.elo_rating - a.elo_rating)
            .map((r) => {
              const clip = clips.find((c) => c.id === r.clip_id);
              return clip
                ? { ...clip, user_elo: r.elo_rating, manual_position: r.manual_position }
                : null;
            })
            .filter(Boolean);
          return { results: userClipsData as T[], meta: { rows_read: userClipsData.length } };
        }
        return { results: [] as T[], meta: { rows_read: 0 } };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
        // Handle INSERT for clips (INSERT OR IGNORE INTO clips (twitch_slug, title, twitch_url, clipped_by))
        if (sql.includes('INSERT') && sql.includes('INTO clips')) {
          // Determine the next ID (max of existing + inserted + 1)
          const maxExistingId = clips.length > 0 ? Math.max(...clips.map((c) => c.id)) : 0;
          const maxInsertedId = insertedClips.length > 0 ? Math.max(...insertedClips.map((c) => c.id)) : 0;
          const nextId = Math.max(maxExistingId, maxInsertedId) + 1;

          const newClip = createTestClip({
            id: nextId,
            twitch_slug: params[0] as string,
            title: params[1] as string || 'Test Clip',
            twitch_url: params[2] as string,
            clipped_by: params[3] as string || null,
          });
          insertedClips.push(newClip);
          return { success: true, meta: { changes: 1, last_row_id: newClip.id } };
        }
        // Handle INSERT for user_clip_ratings
        if (sql.includes('INSERT INTO user_clip_ratings')) {
          insertedRatings.push({
            user_id: params[0] as number,
            clip_id: params[1] as number,
            elo_rating: params[2] as number,
            matches_played: params[3] as number,
            manual_position: params[4] as number | null ?? null,
          });
          return { success: true, meta: { changes: 1, last_row_id: 1 } };
        }
        return { success: true, meta: { changes: 1, last_row_id: 1 } };
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
    // Helper for tests to access inserted data
    _insertedClips: insertedClips,
    _insertedRatings: insertedRatings,
  } as unknown as D1Database;
}

/**
 * Creates a mock KV namespace
 */
function createMockKV() {
  const storage = new Map<string, string>();

  return {
    async get(key: string, options?: { type?: string } | string): Promise<string | object | null> {
      const value = storage.get(key);
      if (!value) return null;
      const type = typeof options === 'string' ? options : options?.type;
      if (type === 'json') {
        return JSON.parse(value);
      }
      return value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      storage.set(key, value);
    },
    async delete(key: string): Promise<void> {
      storage.delete(key);
    },
    async list(): Promise<{ keys: { name: string }[] }> {
      return { keys: Array.from(storage.keys()).map((name) => ({ name })) };
    },
    // Helper methods for testing
    _storage: storage,
    _reset() {
      storage.clear();
    },
  } as unknown as KVNamespace;
}

/**
 * Creates test environment with mocks
 */
function createTestEnv(options: MockQueryOptions = {}) {
  return {
    DB: createMockD1(options),
    SESSION_CACHE: createMockKV(),
    THUMBNAIL_CACHE: createMockKV(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
  };
}

/**
 * Helper to create request with cookie
 */
function createRequest(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {}
) {
  const headers = new Headers();
  if (options.cookie) {
    headers.set('Cookie', options.cookie);
  }
  if (options.body) {
    headers.set('Content-Type', 'application/json');
  }

  return new Request(`http://localhost${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

/**
 * Helper to cache session in KV with correct structure
 */
async function cacheSession(
  kv: KVNamespace,
  sessionId: string,
  session: Session,
  user: User
): Promise<void> {
  const cacheKey = `session:${sessionId}`;
  const data = { session, user };
  await kv.put(cacheKey, JSON.stringify(data));
}

// Test app with clips router
function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/clips', clips);
  return app;
}

describe('Clips Handler Integration Tests', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    resetTwitchMocks();
  });

  describe('GET /api/clips - Get all clips', () => {
    it('should return all active clips', async () => {
      const clips = [
        createTestClip({ id: 1, global_elo: 1800, is_active: 1 }),
        createTestClip({ id: 2, global_elo: 1500, is_active: 1 }),
        createTestClip({ id: 3, global_elo: 1200, is_active: 1 }),
      ];
      const env = createTestEnv({ clips, totalCount: 3 });

      const req = createRequest('/api/clips');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.clips).toBeDefined();
      expect(Array.isArray(data.clips)).toBe(true);
      expect(data.clips.length).toBe(3);
      expect(data.total).toBe(3);
    });

    it('should return clips with correct shape', async () => {
      const clips = [
        createTestClip({
          id: 1,
          twitch_slug: 'TestSlug',
          title: 'Test Title',
          twitch_url: 'https://clips.twitch.tv/TestSlug',
          global_elo: 1800,
          global_matches: 50,
          global_super_likes: 10,
        }),
      ];
      const env = createTestEnv({ clips, totalCount: 1 });

      const req = createRequest('/api/clips');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      const data = await res.json();
      const clip = data.clips[0];

      expect(clip).toHaveProperty('id');
      expect(clip).toHaveProperty('twitchSlug');
      expect(clip).toHaveProperty('title');
      expect(clip).toHaveProperty('twitchUrl');
      expect(clip).toHaveProperty('globalElo');
      expect(clip).toHaveProperty('globalMatches');
      expect(clip).toHaveProperty('globalSuperLikes');
    });

    it('should set cache-control header', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });

      const req = createRequest('/api/clips');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300');
    });
  });

  describe('GET /api/clips/:id - Get single clip', () => {
    it('should return a single clip by ID', async () => {
      const clips = [
        createTestClip({
          id: 1,
          twitch_slug: 'HighRatedClip-abc123',
          title: 'Amazing Play - High Rated',
          global_elo: 1800,
        }),
      ];
      const env = createTestEnv({ clips, totalCount: 1 });

      const req = createRequest('/api/clips/1');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.id).toBe(1);
      expect(data.twitchSlug).toBe('HighRatedClip-abc123');
      expect(data.title).toBe('Amazing Play - High Rated');
      expect(data.globalElo).toBe(1800);
    });

    it('should return clip with full details', async () => {
      const clips = [
        createTestClip({
          id: 1,
          global_elo: 1800,
          global_matches: 50,
          global_wins: 30,
          global_losses: 15,
          global_ties: 5,
          global_super_likes: 10,
          rating_deviation: 100,
        }),
      ];
      const env = createTestEnv({ clips, totalCount: 1 });

      const req = createRequest('/api/clips/1');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      const data = await res.json();

      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('twitchSlug');
      expect(data).toHaveProperty('title');
      expect(data).toHaveProperty('twitchUrl');
      expect(data).toHaveProperty('globalElo');
      expect(data).toHaveProperty('globalMatches');
      expect(data).toHaveProperty('globalWins');
      expect(data).toHaveProperty('globalLosses');
      expect(data).toHaveProperty('globalTies');
      expect(data).toHaveProperty('globalSuperLikes');
      expect(data).toHaveProperty('ratingDeviation');
    });

    it('should return 404 for non-existent clip', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });

      const req = createRequest('/api/clips/99999');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Clip not found');
    });

    it('should return 400 for invalid clip ID', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });

      const req = createRequest('/api/clips/invalid');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid clip ID');
    });

    it('should set cache-control header for 30 minutes', async () => {
      const clips = [createTestClip({ id: 1 })];
      const env = createTestEnv({ clips, totalCount: 1 });

      const req = createRequest('/api/clips/1');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=1800');
    });
  });

  describe('GET /api/clips/stats/count - Get clip count', () => {
    it('should return count of active clips', async () => {
      const env = createTestEnv({ clips: [], totalCount: 3 });

      const req = createRequest('/api/clips/stats/count');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(3);
    });

    it('should set cache-control header', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });

      const req = createRequest('/api/clips/stats/count');
      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300');
    });
  });

  describe('POST /api/clips/submit - Submit a new clip', () => {
    beforeEach(() => {
      // Setup Twitch API mocks with Arross as broadcaster
      setupTwitchMocks({
        clipsResponse: createMockClip({
          id: 'NewSubmittedClip123',
          broadcaster_id: '76024422', // Arross's broadcaster ID
          broadcaster_name: 'arross',
          title: 'New Submitted Clip',
          url: 'https://clips.twitch.tv/NewSubmittedClip123',
          creator_name: 'TestClipper',
        }),
      });
    });

    it('should require authentication', async () => {
      const env = createTestEnv({});

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://clips.twitch.tv/TestClip' },
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Authentication required');
    });

    it('should require URL in request body', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      // Cache the session
      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: {},
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('URL is required');
    });

    it('should reject invalid Twitch URL', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://example.com/not-a-clip' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid Twitch clip URL format');
    });

    it('should reject clips not from Arross channel', async () => {
      // Mock a clip from a different broadcaster
      setupTwitchMocks({
        clipsResponse: createMockClip({
          id: 'OtherChannelClip',
          broadcaster_id: '99999999',
          broadcaster_name: 'otherstreamer',
          title: 'Other Channel Clip',
        }),
      });

      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://clips.twitch.tv/OtherChannelClip' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("arross's channel");
    });

    it('should create new clip successfully for user with few ranked clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user, userClipRatings: [] });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://clips.twitch.tv/NewSubmittedClip123' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.clip).toBeDefined();
      expect(data.clip.twitchSlug).toBe('NewSubmittedClip123');
      expect(data.clip.title).toBe('New Submitted Clip');
      expect(data.isNew).toBe(true);
      expect(data.needsRanking).toBe(false); // User has < 3 ranked clips
    });

    it('should return alreadyRanked for duplicate clip submission', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, twitch_slug: 'HighRatedClip-abc123', title: 'Amazing Play - High Rated' }),
      ];
      const userClipRatings = [{ user_id: 1, clip_id: 1, elo_rating: 1600, matches_played: 5, manual_position: 1 }];
      const env = createTestEnv({ session, user, clips, userClipRatings });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Mock the clip to return as the existing clip
      setupTwitchMocks({
        clipsResponse: createMockClip({
          id: 'HighRatedClip-abc123',
          broadcaster_id: '76024422',
          broadcaster_name: 'arross',
          title: 'Amazing Play - High Rated',
          url: 'https://clips.twitch.tv/HighRatedClip-abc123',
        }),
      });

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://clips.twitch.tv/HighRatedClip-abc123' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.alreadyRanked).toBe(true);
      expect(data.currentElo).toBeDefined();
    });

    it('should start binary search ranking for user with many ranked clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, global_elo: 1800 }),
        createTestClip({ id: 2, global_elo: 1500 }),
        createTestClip({ id: 3, global_elo: 1200 }),
      ];
      const userClipRatings = [
        { user_id: 1, clip_id: 1, elo_rating: 1800, matches_played: 10, manual_position: 1 },
        { user_id: 1, clip_id: 2, elo_rating: 1500, matches_played: 10, manual_position: 2 },
        { user_id: 1, clip_id: 3, elo_rating: 1200, matches_played: 10, manual_position: 3 },
      ];
      const sortedUserClips = [
        { id: 1, elo: 1800 },
        { id: 2, elo: 1500 },
        { id: 3, elo: 1200 },
      ];
      const env = createTestEnv({ session, user, clips, userClipRatings, sortedUserClips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/submit', {
        method: 'POST',
        body: { url: 'https://clips.twitch.tv/NewSubmittedClip123' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.needsRanking).toBe(true);
      expect(data.rankingSession).toBeDefined();
      expect(data.rankingSession.clipToRank).toBeDefined();
      expect(data.rankingSession.compareWith).toBeDefined();
      expect(data.rankingSession.progress).toBeDefined();
      expect(data.rankingSession.progress.step).toBe(1);
    });
  });

  describe('Ranking Session KV Functions', () => {
    it('should set and get ranking session from KV', async () => {
      const env = createTestEnv({});
      const sessionKey = 'test-session-key';
      const session: RankingSession = {
        clipId: 1,
        sortedClips: [
          { id: 1, elo: 1800 },
          { id: 2, elo: 1500 },
          { id: 3, elo: 1200 },
        ],
        low: 0,
        high: 2,
        step: 1,
        totalSteps: 2,
      };

      await setRankingSession(env.SESSION_CACHE, sessionKey, session);
      const retrieved = await getRankingSession(env.SESSION_CACHE, sessionKey);

      expect(retrieved).toEqual(session);
    });

    it('should return null for non-existent session', async () => {
      const env = createTestEnv({});
      const retrieved = await getRankingSession(env.SESSION_CACHE, 'non-existent-key');
      expect(retrieved).toBeNull();
    });

    it('should delete ranking session from KV', async () => {
      const env = createTestEnv({});
      const sessionKey = 'delete-test-session';
      const session: RankingSession = {
        clipId: 1,
        sortedClips: [{ id: 1, elo: 1500 }],
        low: 0,
        high: 0,
        step: 1,
        totalSteps: 1,
      };

      await setRankingSession(env.SESSION_CACHE, sessionKey, session);
      await deleteRankingSession(env.SESSION_CACHE, sessionKey);
      const retrieved = await getRankingSession(env.SESSION_CACHE, sessionKey);

      expect(retrieved).toBeNull();
    });
  });

  describe('GET /api/clips/rank-session/:clipId - Get ranking session', () => {
    it('should require authentication', async () => {
      const env = createTestEnv({});

      const req = createRequest('/api/clips/rank-session/1');

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(401);
    });

    it('should return 404 for no active session', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/999', {
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('No active ranking session');
    });

    it('should return 400 for invalid clip ID', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/invalid', {
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid clip ID');
    });

    it('should return active ranking session', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1 }),
        createTestClip({ id: 2 }),
        createTestClip({ id: 3 }),
      ];
      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Create a ranking session
      const rankingSession: RankingSession = {
        clipId: 1,
        sortedClips: [
          { id: 2, elo: 1500 },
          { id: 3, elo: 1200 },
        ],
        low: 0,
        high: 1,
        step: 1,
        totalSteps: 1,
      };
      await setRankingSession(env.SESSION_CACHE, '1-1', rankingSession);

      const req = createRequest('/api/clips/rank-session/1', {
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.clipToRank).toBeDefined();
      expect(data.compareWith).toBeDefined();
      expect(data.progress).toBeDefined();
      expect(data.progress.step).toBe(1);
      expect(data.progress.totalSteps).toBe(1);
    });
  });

  describe('POST /api/clips/rank-session/:clipId/vote - Submit ranking vote', () => {
    it('should require authentication', async () => {
      const env = createTestEnv({});

      const req = createRequest('/api/clips/rank-session/1/vote', {
        method: 'POST',
        body: { result: 'submitted' },
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(401);
    });

    it('should return 400 for invalid vote result', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/1/vote', {
        method: 'POST',
        body: { result: 'invalid' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid result');
    });

    it('should return 404 for no active session', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/999/vote', {
        method: 'POST',
        body: { result: 'submitted' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(404);
    });

    it('should continue binary search on vote for "submitted" wins', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, global_elo: 1800 }),
        createTestClip({ id: 2, global_elo: 1500 }),
        createTestClip({ id: 3, global_elo: 1200 }),
        createTestClip({ id: 5 }),
      ];
      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Create a ranking session with enough clips
      const rankingSession: RankingSession = {
        clipId: 5, // New clip being ranked
        sortedClips: [
          { id: 1, elo: 1800 },
          { id: 2, elo: 1500 },
          { id: 3, elo: 1200 },
        ],
        low: 0,
        high: 2,
        step: 1,
        totalSteps: 2,
      };
      await setRankingSession(env.SESSION_CACHE, '1-5', rankingSession);

      const req = createRequest('/api/clips/rank-session/5/vote', {
        method: 'POST',
        body: { result: 'submitted' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      // Session should continue (not done yet)
      expect(data.done).toBe(false);
      expect(data.compareWith).toBeDefined();
      expect(data.progress.step).toBe(2);
    });

    it('should continue binary search on vote for "existing" wins', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      // Need more clips for the binary search to continue when voting "existing"
      // With low=0, high=4, mid=2. "existing" sets low=3, which is < high=4, so it continues
      const clips = [
        createTestClip({ id: 1, global_elo: 2000 }),
        createTestClip({ id: 2, global_elo: 1800 }),
        createTestClip({ id: 3, global_elo: 1600 }),
        createTestClip({ id: 4, global_elo: 1400 }),
        createTestClip({ id: 6, global_elo: 1200 }),
        createTestClip({ id: 5 }),
      ];
      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const rankingSession: RankingSession = {
        clipId: 5,
        sortedClips: [
          { id: 1, elo: 2000 },
          { id: 2, elo: 1800 },
          { id: 3, elo: 1600 },
          { id: 4, elo: 1400 },
          { id: 6, elo: 1200 },
        ],
        low: 0,
        high: 4,
        step: 1,
        totalSteps: 3,
      };
      await setRankingSession(env.SESSION_CACHE, '1-5', rankingSession);

      const req = createRequest('/api/clips/rank-session/5/vote', {
        method: 'POST',
        body: { result: 'existing' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.done).toBe(false);
      expect(data.progress.step).toBe(2);
    });

    it('should complete ranking session and save rating', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, global_elo: 1800 }),
        createTestClip({ id: 2, global_elo: 1500 }),
        createTestClip({ id: 5, twitch_slug: 'NewClipSlug', title: 'New Clip' }),
      ];
      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Create a simple session that will complete immediately
      const rankingSession: RankingSession = {
        clipId: 5,
        sortedClips: [
          { id: 1, elo: 1800 },
          { id: 2, elo: 1500 },
        ],
        low: 0,
        high: 1,
        step: 1,
        totalSteps: 1,
      };
      await setRankingSession(env.SESSION_CACHE, '1-5', rankingSession);

      const req = createRequest('/api/clips/rank-session/5/vote', {
        method: 'POST',
        body: { result: 'tie' }, // Tie will complete immediately
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.done).toBe(true);
      expect(data.finalPosition).toBeDefined();
      expect(data.finalElo).toBeDefined();
      expect(data.message).toContain('Clip ranked');

      // Session should be deleted
      const deletedSession = await getRankingSession(env.SESSION_CACHE, '1-5');
      expect(deletedSession).toBeNull();
    });

    it('should place clip above best when submitted beats all', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, global_elo: 1800 }),
        createTestClip({ id: 5, twitch_slug: 'TopClipSlug', title: 'Top Clip' }),
      ];
      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Session at the boundary - low=0, high=0 will end
      const rankingSession: RankingSession = {
        clipId: 5,
        sortedClips: [{ id: 1, elo: 1800 }],
        low: 0,
        high: 0,
        step: 1,
        totalSteps: 1,
      };
      await setRankingSession(env.SESSION_CACHE, '1-5', rankingSession);

      const req = createRequest('/api/clips/rank-session/5/vote', {
        method: 'POST',
        body: { result: 'submitted' },
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.done).toBe(true);
      expect(data.finalPosition).toBe(1); // Position 0 + 1 for 1-indexed
      expect(data.finalElo).toBeGreaterThan(1800); // Above the best clip
    });
  });

  describe('DELETE /api/clips/rank-session/:clipId - Cancel ranking session', () => {
    it('should require authentication', async () => {
      const env = createTestEnv({});

      const req = createRequest('/api/clips/rank-session/1', {
        method: 'DELETE',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(401);
    });

    it('should return 400 for invalid clip ID', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/invalid', {
        method: 'DELETE',
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(400);
    });

    it('should delete ranking session successfully', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      // Create a ranking session
      const rankingSession: RankingSession = {
        clipId: 5,
        sortedClips: [{ id: 1, elo: 1500 }],
        low: 0,
        high: 0,
        step: 1,
        totalSteps: 1,
      };
      await setRankingSession(env.SESSION_CACHE, '1-5', rankingSession);

      const req = createRequest('/api/clips/rank-session/5', {
        method: 'DELETE',
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Session should be deleted
      const deletedSession = await getRankingSession(env.SESSION_CACHE, '1-5');
      expect(deletedSession).toBeNull();
    });

    it('should succeed even if session does not exist', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const req = createRequest('/api/clips/rank-session/999', {
        method: 'DELETE',
        cookie: 'session=valid-session',
      });

      const res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  describe('Binary Search Ranking Algorithm', () => {
    it('should correctly narrow search on multiple votes', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });

      // Create 8 clips for more binary search steps
      const clips = [
        createTestClip({ id: 10, global_elo: 2000 }),
        createTestClip({ id: 11, global_elo: 1900 }),
        createTestClip({ id: 12, global_elo: 1800 }),
        createTestClip({ id: 13, global_elo: 1700 }),
        createTestClip({ id: 14, global_elo: 1600 }),
        createTestClip({ id: 15, global_elo: 1500 }),
        createTestClip({ id: 16, global_elo: 1400 }),
        createTestClip({ id: 17, global_elo: 1300 }),
        createTestClip({ id: 20, twitch_slug: 'RankingClip', title: 'Ranking Clip' }),
      ];

      const sortedClips = [
        { id: 10, elo: 2000 },
        { id: 11, elo: 1900 },
        { id: 12, elo: 1800 },
        { id: 13, elo: 1700 },
        { id: 14, elo: 1600 },
        { id: 15, elo: 1500 },
        { id: 16, elo: 1400 },
        { id: 17, elo: 1300 },
      ];

      const env = createTestEnv({ session, user, clips });

      await cacheSession(env.SESSION_CACHE, 'valid-session', session, user);

      const rankingSession: RankingSession = {
        clipId: 20,
        sortedClips,
        low: 0,
        high: 7,
        step: 1,
        totalSteps: 3,
      };
      await setRankingSession(env.SESSION_CACHE, '1-20', rankingSession);

      // First vote: submitted clip is better (narrow to upper half)
      let req = createRequest('/api/clips/rank-session/20/vote', {
        method: 'POST',
        body: { result: 'submitted' },
        cookie: 'session=valid-session',
      });

      let res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      let data = await res.json();
      expect(data.done).toBe(false);
      expect(data.progress.step).toBe(2);

      // Second vote: existing clip is better
      req = createRequest('/api/clips/rank-session/20/vote', {
        method: 'POST',
        body: { result: 'existing' },
        cookie: 'session=valid-session',
      });

      res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      data = await res.json();
      expect(data.progress.step).toBe(3);

      // Third vote: tie to finalize
      req = createRequest('/api/clips/rank-session/20/vote', {
        method: 'POST',
        body: { result: 'tie' },
        cookie: 'session=valid-session',
      });

      res = await app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });

      data = await res.json();
      expect(data.done).toBe(true);
      expect(data.finalPosition).toBeGreaterThanOrEqual(1);
      expect(data.finalPosition).toBeLessThanOrEqual(8);
    });
  });
});

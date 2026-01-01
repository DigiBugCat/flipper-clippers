import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import leaderboard from '../../../src/handlers/leaderboard';
import type { Env, Clip, User, Session } from '../../../src/types';
import { testClips, createTestClip } from '../../fixtures/clips';
import { testUsers, createTestUser } from '../../fixtures/users';
import { testSessions, createTestSession } from '../../fixtures/sessions';

/**
 * Integration tests for src/handlers/leaderboard.ts
 *
 * Tests cover:
 * - Global rankings with sorting and pagination
 * - Personal rankings (/me endpoint)
 * - SWR caching behavior
 * - Pagination edge cases
 * - Admin-only voter leaderboard
 */

// Mock DB response types
interface MockQueryOptions {
  clips?: Clip[];
  totalCount?: number;
  userClips?: (Clip & { user_elo: number; manual_position: number | null })[];
  session?: Session | null;
  user?: User | null;
  clipRatings?: Array<{
    clip_id: number;
    elo_rating: number;
    matches_played: number;
    manual_position: number | null;
  }>;
  voters?: User[];
  aggregationStats?: { lastUpdated: string; totalRatings: number };
  rollupStatus?: { count: number; oldest: string | null };
}

/**
 * Creates a mock D1 database with configurable responses
 */
function createMockD1(options: MockQueryOptions = {}) {
  const {
    clips = [],
    totalCount = 0,
    userClips = [],
    session = null,
    user = null,
    clipRatings = [],
    voters = [],
    aggregationStats = { lastUpdated: new Date().toISOString(), totalRatings: 100 },
    rollupStatus = { count: 10, oldest: new Date().toISOString() },
  } = options;

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
        // Total count for leaderboard (active clips with matches)
        if (sql.includes('COUNT(*)') && sql.includes('clips') && sql.includes('global_matches > 0')) {
          return { count: totalCount } as T;
        }
        // Total count for stats (just active clips)
        if (sql.includes('COUNT(*)') && sql.includes('clips') && sql.includes('is_active')) {
          return { count: totalCount } as T;
        }
        // Clip by ID
        if (sql.includes('FROM clips WHERE id')) {
          const clipId = params[0] as number;
          const clip = clips.find((c) => c.id === clipId);
          return clip as T ?? null;
        }
        // User clip rating (for checking if clip exists in rankings)
        if (sql.includes('FROM user_clip_ratings WHERE user_id') && sql.includes('clip_id')) {
          const clipId = params[1] as number;
          const rating = clipRatings.find((r) => r.clip_id === clipId);
          return rating as T ?? null;
        }
        // Manual position max
        if (sql.includes('MAX(manual_position)') || sql.includes('COALESCE(MAX(manual_position)')) {
          const maxPos = Math.max(0, ...clipRatings.filter(r => r.manual_position !== null).map(r => r.manual_position!));
          return { max_pos: maxPos } as T;
        }
        // Aggregation stats - rollup status check
        if (sql.includes('clip_rating_rollups') && sql.includes('COUNT(*)')) {
          return rollupStatus as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        // Global leaderboard query
        if (sql.includes('FROM clips') && sql.includes('is_active = 1') && sql.includes('global_matches > 0') && sql.includes('LIMIT')) {
          return { results: clips as T[], meta: { rows_read: clips.length } };
        }
        // User leaderboard with JOIN
        if (sql.includes('user_clip_ratings') && sql.includes('JOIN clips') && sql.includes('ORDER BY')) {
          return { results: userClips as T[], meta: { rows_read: userClips.length } };
        }
        // Voter leaderboard
        if (sql.includes('FROM users') && sql.includes('ORDER BY total_comparisons')) {
          return { results: voters as T[], meta: { rows_read: voters.length } };
        }
        // User clips sorted by ELO for binary search
        if (sql.includes('user_clip_ratings') && sql.includes('elo_rating DESC')) {
          return { results: userClips as T[], meta: { rows_read: userClips.length } };
        }
        // Clips without positions
        if (sql.includes('manual_position IS NULL')) {
          return { results: [] as T[], meta: { rows_read: 0 } };
        }
        // Active clips list (used in aggregation)
        if (sql.includes('FROM clips WHERE is_active')) {
          return { results: clips.map(c => ({ id: c.id })) as T[], meta: { rows_read: clips.length } };
        }
        // User ratings (for aggregation)
        if (sql.includes('FROM user_clip_ratings')) {
          return { results: [] as T[], meta: { rows_read: 0 } };
        }
        // Users list (for aggregation)
        if (sql.includes('FROM users')) {
          return { results: [] as T[], meta: { rows_read: 0 } };
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
 * Creates a mock KV namespace
 */
function createMockKV(cache: Map<string, { data: unknown; timestamp: number }> = new Map()) {
  return {
    async get<T = unknown>(key: string, type?: string): Promise<T | null> {
      const cached = cache.get(key);
      if (!cached) return null;
      if (type === 'json') return cached as T;
      return JSON.stringify(cached) as T;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      cache.set(key, JSON.parse(value));
    },
    async delete(key: string): Promise<void> {
      cache.delete(key);
    },
    async list(): Promise<{ keys: { name: string }[] }> {
      return { keys: Array.from(cache.keys()).map((name) => ({ name })) };
    },
    _cache: cache,
  } as unknown as KVNamespace;
}

/**
 * Creates test environment with mocks
 */
function createTestEnv(options: MockQueryOptions = {}) {
  const kvCache = new Map<string, { data: unknown; timestamp: number }>();

  return {
    DB: createMockD1(options),
    SESSION_CACHE: createMockKV(kvCache),
    THUMBNAIL_CACHE: createMockKV(new Map()),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
    _kvCache: kvCache,
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

describe('leaderboard handler integration tests', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono<{ Bindings: Env }>();
    // Mount leaderboard routes directly at root for simpler testing
    app.route('/', leaderboard);
  });

  describe('GET / - Global Leaderboard', () => {
    it('returns global leaderboard sorted by ELO descending by default', async () => {
      const clips = [
        createTestClip({ id: 1, global_elo: 1800, global_matches: 50 }),
        createTestClip({ id: 2, global_elo: 1500, global_matches: 30 }),
        createTestClip({ id: 3, global_elo: 1200, global_matches: 20 }),
      ];

      const env = createTestEnv({ clips, totalCount: 3 });
      const req = createRequest('/');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.leaderboard).toBeDefined();
      expect(data.leaderboard.length).toBe(3);

      // Should be sorted by ELO descending
      expect(data.leaderboard[0].elo).toBe(1800);
      expect(data.leaderboard[1].elo).toBe(1500);
      expect(data.leaderboard[2].elo).toBe(1200);
    });

    it('includes rank, elo, matches, wins, losses, ties, globalSuperLikes, winRate, confidence', async () => {
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
      const req = createRequest('/');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      const entry = data.leaderboard[0];
      expect(entry).toHaveProperty('rank', 1);
      expect(entry).toHaveProperty('id', 1);
      expect(entry).toHaveProperty('twitchSlug');
      expect(entry).toHaveProperty('title');
      expect(entry).toHaveProperty('elo', 1800);
      expect(entry).toHaveProperty('matches', 50);
      expect(entry).toHaveProperty('wins', 30);
      expect(entry).toHaveProperty('losses', 15);
      expect(entry).toHaveProperty('ties', 5);
      expect(entry).toHaveProperty('globalSuperLikes', 10);
      expect(entry).toHaveProperty('winRate', 60); // 30/50 * 100
      expect(entry).toHaveProperty('confidence');
    });

    it('calculates correct winRate', async () => {
      const clips = [
        createTestClip({ id: 1, global_matches: 100, global_wins: 75, global_elo: 1800 }),
      ];

      const env = createTestEnv({ clips, totalCount: 1 });
      const req = createRequest('/');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      expect(data.leaderboard[0].winRate).toBe(75);
    });

    it('returns 0 winRate for clips with 0 matches', async () => {
      const clips = [
        createTestClip({ id: 1, global_matches: 0, global_wins: 0, global_elo: 1500 }),
      ];

      const env = createTestEnv({ clips, totalCount: 1 });
      const req = createRequest('/');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      expect(data.leaderboard[0].winRate).toBe(0);
    });

    describe('pagination', () => {
      it('returns pagination metadata', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 100 });
        const req = createRequest('/');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        expect(data.pagination).toBeDefined();
        expect(data.pagination.page).toBe(1);
        expect(data.pagination.limit).toBe(50);
        expect(data.pagination.total).toBe(100);
        expect(data.pagination.totalPages).toBe(2);
      });

      it('respects limit parameter', async () => {
        const clips = [
          createTestClip({ id: 1, global_elo: 1800, global_matches: 10 }),
          createTestClip({ id: 2, global_elo: 1700, global_matches: 10 }),
        ];
        const env = createTestEnv({ clips, totalCount: 10 });
        const req = createRequest('/?limit=5');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        expect(data.pagination.limit).toBe(5);
      });

      it('enforces maximum limit of 100', async () => {
        const env = createTestEnv({ clips: [], totalCount: 0 });
        const req = createRequest('/?limit=200');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        expect(data.pagination.limit).toBe(100);
      });

      it('enforces minimum limit of 1', async () => {
        const env = createTestEnv({ clips: [], totalCount: 0 });
        const req = createRequest('/?limit=0');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        expect(data.pagination.limit).toBe(1);
      });

      it('enforces minimum page of 1', async () => {
        const env = createTestEnv({ clips: [], totalCount: 0 });
        const req = createRequest('/?page=0');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        expect(data.pagination.page).toBe(1);
      });

      it('calculates correct ranks for page 2', async () => {
        const clips = [
          createTestClip({ id: 4, global_elo: 1400, global_matches: 10 }),
          createTestClip({ id: 5, global_elo: 1300, global_matches: 10 }),
        ];
        const env = createTestEnv({ clips, totalCount: 100 });
        const req = createRequest('/?page=2&limit=3');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
        const data = await res.json();

        // Page 2 with limit 3 should have ranks starting at 4
        expect(data.leaderboard[0].rank).toBe(4);
        expect(data.leaderboard[1].rank).toBe(5);
      });
    });

    describe('sorting', () => {
      it('falls back to elo sort for invalid sort field', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });
        const req = createRequest('/?sort=invalid&order=desc');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.leaderboard).toBeDefined();
      });

      it('falls back to desc order for invalid order value', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });
        const req = createRequest('/?sort=elo&order=invalid');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.leaderboard).toBeDefined();
      });
    });

    describe('SWR caching behavior', () => {
      it('sets X-Cache header to MISS on first request', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });
        const req = createRequest('/');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        expect(res.headers.get('X-Cache')).toBe('MISS');
      });

      it('sets X-Cache header to HIT on cached request', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });

        // First request - cache miss
        const req1 = createRequest('/');
        await app.fetch(req1, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        // Second request - should hit cache
        const req2 = createRequest('/');
        const res = await app.fetch(req2, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        expect(res.headers.get('X-Cache')).toBe('HIT');
      });

      it('returns stale data and triggers background refresh for stale cache', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });

        // Manually set stale cache entry (>60 seconds old)
        const staleTimestamp = Date.now() - 90 * 1000; // 90 seconds ago
        env._kvCache.set('leaderboard:1:50:elo:desc', {
          data: { leaderboard: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } },
          timestamp: staleTimestamp,
        });

        const waitUntilCalls: Promise<unknown>[] = [];
        const req = createRequest('/');
        const res = await app.fetch(req, env, {
          waitUntil: (promise: Promise<unknown>) => { waitUntilCalls.push(promise); },
          passThroughOnException: () => {},
        });

        expect(res.headers.get('X-Cache')).toBe('STALE');
        expect(waitUntilCalls.length).toBeGreaterThan(0); // Background refresh triggered
      });

      it('sets appropriate Cache-Control headers', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });
        const req = createRequest('/');
        const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        const cacheControl = res.headers.get('Cache-Control');
        expect(cacheControl).toContain('public');
        expect(cacheControl).toContain('s-maxage');
      });

      it('uses different cache keys for different query params', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800, global_matches: 10 })];
        const env = createTestEnv({ clips, totalCount: 1 });

        // Cache default params
        const req1 = createRequest('/');
        await app.fetch(req1, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        // Different params should miss cache
        const req2 = createRequest('/?sort=matches');
        const res = await app.fetch(req2, env, { waitUntil: () => {}, passThroughOnException: () => {} });

        expect(res.headers.get('X-Cache')).toBe('MISS');
      });
    });
  });

  describe('GET /me - Personal Leaderboard', () => {
    it('returns 401 without session cookie', async () => {
      const env = createTestEnv({});
      const req = createRequest('/me');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Authentication required');
    });

    it('returns 401 with invalid session', async () => {
      const env = createTestEnv({ session: null, user: null });
      const req = createRequest('/me', { cookie: 'session=invalid-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Invalid session');
    });

    it('returns user personal leaderboard with valid session', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const userClips = [
        { ...createTestClip({ id: 1 }), user_elo: 1700, manual_position: 1 },
        { ...createTestClip({ id: 2 }), user_elo: 1500, manual_position: 2 },
      ];

      const env = createTestEnv({ session, user, userClips });
      const req = createRequest('/me', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.leaderboard).toBeDefined();
      expect(data.leaderboard.length).toBe(2);
    });

    it('includes user-specific ELO, global ELO, and manual position', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const userClips = [
        { ...createTestClip({ id: 1, global_elo: 1800 }), user_elo: 1700, manual_position: 1 },
      ];

      const env = createTestEnv({ session, user, userClips });
      const req = createRequest('/me', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      const entry = data.leaderboard[0];
      expect(entry).toHaveProperty('elo', 1700);
      expect(entry).toHaveProperty('globalElo', 1800);
      expect(entry).toHaveProperty('manualPosition', 1);
    });

    it('assigns correct ranks starting from 1', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const userClips = [
        { ...createTestClip({ id: 1 }), user_elo: 1700, manual_position: 1 },
        { ...createTestClip({ id: 2 }), user_elo: 1500, manual_position: 2 },
        { ...createTestClip({ id: 3 }), user_elo: 1300, manual_position: 3 },
      ];

      const env = createTestEnv({ session, user, userClips });
      const req = createRequest('/me', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      expect(data.leaderboard[0].rank).toBe(1);
      expect(data.leaderboard[1].rank).toBe(2);
      expect(data.leaderboard[2].rank).toBe(3);
    });
  });

  describe('PUT /me/reorder - Reorder Personal Ranking', () => {
    it('returns 401 without session', async () => {
      const env = createTestEnv({});
      const req = createRequest('/me/reorder', {
        method: 'PUT',
        body: { clipId: 3, newPosition: 1 },
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
    });

    it('returns 400 for missing clipId', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });
      const req = createRequest('/me/reorder', {
        method: 'PUT',
        body: { newPosition: 1 },
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Missing');
    });

    it('returns 400 for missing newPosition', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });
      const req = createRequest('/me/reorder', {
        method: 'PUT',
        body: { clipId: 3 },
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Missing');
    });

    it('successfully processes reorder request', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clipRatings = [
        { clip_id: 1, elo_rating: 1700, matches_played: 10, manual_position: 1 },
        { clip_id: 2, elo_rating: 1500, matches_played: 10, manual_position: 2 },
        { clip_id: 3, elo_rating: 1300, matches_played: 10, manual_position: 3 },
      ];
      const env = createTestEnv({ session, user, clipRatings });
      const req = createRequest('/me/reorder', {
        method: 'PUT',
        body: { clipId: 3, newPosition: 1 },
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  describe('GET /stats - Leaderboard Stats', () => {
    it('returns aggregation stats and total clips count', async () => {
      const clips = [createTestClip({ id: 1 })];
      const env = createTestEnv({ clips, totalCount: 50 });
      const req = createRequest('/stats');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('totalClips');
    });

    it('sets Cache-Control header for CDN caching', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });
      const req = createRequest('/stats');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('s-maxage=300');
    });
  });

  describe('GET /top - Top Clips Summary', () => {
    it('returns top clips for homepage', async () => {
      const clips = [
        createTestClip({ id: 1, global_elo: 1800, global_matches: 50 }),
        createTestClip({ id: 2, global_elo: 1600, global_matches: 30 }),
      ];
      const env = createTestEnv({ clips, totalCount: 2 });
      const req = createRequest('/top');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.topClips).toBeDefined();
      expect(Array.isArray(data.topClips)).toBe(true);
    });

    it('includes rank, id, twitchSlug, title, elo, superLikes', async () => {
      const clips = [
        createTestClip({ id: 1, global_elo: 1800, global_super_likes: 15, global_matches: 50 }),
      ];
      const env = createTestEnv({ clips, totalCount: 1 });
      const req = createRequest('/top');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      if (data.topClips.length > 0) {
        const entry = data.topClips[0];
        expect(entry).toHaveProperty('rank', 1);
        expect(entry).toHaveProperty('id', 1);
        expect(entry).toHaveProperty('twitchSlug');
        expect(entry).toHaveProperty('title');
        expect(entry).toHaveProperty('elo', 1800);
        expect(entry).toHaveProperty('superLikes', 15);
      }
    });

    it('sets Cache-Control header for CDN caching', async () => {
      const env = createTestEnv({ clips: [], totalCount: 0 });
      const req = createRequest('/top');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('s-maxage=300');
    });
  });

  describe('POST /add/:clipId - Add Clip to Personal Rankings', () => {
    it('returns 401 without session', async () => {
      const env = createTestEnv({});
      const req = createRequest('/add/1', { method: 'POST' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid clip ID', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });
      const req = createRequest('/add/invalid', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid clip ID');
    });

    it('returns 404 for non-existent clip', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user, clips: [] });
      const req = createRequest('/add/99999', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Clip not found');
    });

    it('returns alreadyRanked if clip is already in user rankings', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [createTestClip({ id: 1 })];
      const clipRatings = [{ clip_id: 1, elo_rating: 1500, matches_played: 5, manual_position: 1 }];
      const env = createTestEnv({ session, user, clips, clipRatings });
      const req = createRequest('/add/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.alreadyRanked).toBe(true);
    });

    it('adds clip without ranking when user has fewer than 3 clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [createTestClip({ id: 1 })];
      const userClips: (Clip & { user_elo: number; manual_position: number | null })[] = [
        { ...createTestClip({ id: 2 }), user_elo: 1500, manual_position: 1 },
      ];
      const env = createTestEnv({ session, user, clips, userClips, clipRatings: [] });
      const req = createRequest('/add/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.needsRanking).toBe(false);
    });

    it('starts ranking session when user has 3+ clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1 }),
        createTestClip({ id: 2 }),
        createTestClip({ id: 3 }),
        createTestClip({ id: 4 }),
      ];
      const userClips = [
        { ...clips[1], user_elo: 1700, manual_position: 1 },
        { ...clips[2], user_elo: 1500, manual_position: 2 },
        { ...clips[3], user_elo: 1300, manual_position: 3 },
      ];
      const env = createTestEnv({ session, user, clips, userClips, clipRatings: [] });
      const req = createRequest('/add/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

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

  describe('POST /rerank/:clipId - Rerank Existing Clip', () => {
    it('returns 401 without session', async () => {
      const env = createTestEnv({});
      const req = createRequest('/rerank/1', { method: 'POST' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid clip ID', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });
      const req = createRequest('/rerank/invalid', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Invalid clip ID');
    });

    it('returns 404 for non-existent clip', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user, clips: [] });
      const req = createRequest('/rerank/99999', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Clip not found');
    });

    it('returns 404 for clip not in user rankings', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [createTestClip({ id: 1 })];
      const env = createTestEnv({ session, user, clips, clipRatings: [] });
      const req = createRequest('/rerank/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Clip not in your rankings');
    });

    it('returns 400 when user has fewer than 3 ranked clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [createTestClip({ id: 1 }), createTestClip({ id: 2 })];
      const clipRatings = [{ clip_id: 1, elo_rating: 1500, matches_played: 5, manual_position: 1 }];
      const userClips = [
        { ...clips[0], user_elo: 1500, manual_position: 1 },
        { ...clips[1], user_elo: 1400, manual_position: 2 },
      ];
      const env = createTestEnv({ session, user, clips, clipRatings, userClips });
      const req = createRequest('/rerank/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Need at least 3 ranked clips to rerank');
    });

    it('starts rerank session for valid request', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1 }),
        createTestClip({ id: 2 }),
        createTestClip({ id: 3 }),
        createTestClip({ id: 4 }),
      ];
      const clipRatings = [{ clip_id: 1, elo_rating: 1500, matches_played: 5, manual_position: 1 }];
      const userClips = clips.map((c, i) => ({ ...c, user_elo: 1700 - i * 100, manual_position: i + 1 }));
      const env = createTestEnv({ session, user, clips, clipRatings, userClips });
      const req = createRequest('/rerank/1', {
        method: 'POST',
        cookie: 'session=valid-session',
      });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.rankingSession).toBeDefined();
      expect(data.rankingSession.clipToRank.id).toBe(1);
      expect(data.rankingSession.progress.step).toBe(1);
    });
  });

  describe('GET /admin/voters - Admin Voter Leaderboard', () => {
    it('returns 401 without session', async () => {
      const env = createTestEnv({});
      const req = createRequest('/admin/voters');
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Authentication required');
    });

    it('returns 401 with invalid session', async () => {
      const env = createTestEnv({ session: null, user: null });
      const req = createRequest('/admin/voters', { cookie: 'session=invalid' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Invalid session');
    });

    it('returns 403 for non-admin user', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1, twitch_username: 'regularuser' });
      const env = createTestEnv({ session, user });
      const req = createRequest('/admin/voters', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Admin access required');
    });

    it('returns voter leaderboard for admin user (arross)', async () => {
      const session = createTestSession({ id: 'admin-session', user_id: 2 });
      const user = createTestUser({ id: 2, twitch_username: 'arross' });
      const voters = [
        createTestUser({ id: 1, twitch_username: 'voter1', total_comparisons: 100, total_super_likes: 10 }),
        createTestUser({ id: 3, twitch_username: 'voter2', total_comparisons: 50, total_super_likes: 5 }),
      ];
      const env = createTestEnv({ session, user, voters });
      const req = createRequest('/admin/voters', { cookie: 'session=admin-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.voters).toBeDefined();
      expect(Array.isArray(data.voters)).toBe(true);
      expect(data.total).toBeDefined();
    });

    it('returns voter leaderboard for admin user (digibugcat)', async () => {
      const session = createTestSession({ id: 'admin-session', user_id: 2 });
      const user = createTestUser({ id: 2, twitch_username: 'digibugcat' });
      const voters = [
        createTestUser({ id: 1, total_comparisons: 100 }),
      ];
      const env = createTestEnv({ session, user, voters });
      const req = createRequest('/admin/voters', { cookie: 'session=admin-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.voters).toBeDefined();
    });

    it('includes voter stats in response', async () => {
      const session = createTestSession({ id: 'admin-session', user_id: 2 });
      const user = createTestUser({ id: 2, twitch_username: 'arross' });
      const voters = [
        createTestUser({
          id: 1,
          twitch_username: 'voter1',
          twitch_display_name: 'Voter One',
          twitch_profile_image: 'https://example.com/voter1.png',
          total_comparisons: 100,
          total_super_likes: 10,
          last_login: '2024-01-15T12:00:00Z',
        }),
      ];
      const env = createTestEnv({ session, user, voters });
      const req = createRequest('/admin/voters', { cookie: 'session=admin-session' });
      const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const data = await res.json();

      const voter = data.voters[0];
      expect(voter).toHaveProperty('rank', 1);
      expect(voter).toHaveProperty('userId', 1);
      expect(voter).toHaveProperty('username', 'voter1');
      expect(voter).toHaveProperty('displayName', 'Voter One');
      expect(voter).toHaveProperty('profileImage', 'https://example.com/voter1.png');
      expect(voter).toHaveProperty('totalVotes', 100);
      expect(voter).toHaveProperty('superLikes', 10);
      expect(voter).toHaveProperty('lastLogin');
    });
  });
});

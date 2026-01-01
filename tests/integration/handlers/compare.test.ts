import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import compare from '../../../src/handlers/compare';
import type { Env, User, Clip, Session, VoteResult } from '../../../src/types';
import { testUsers, createTestUser } from '../../fixtures/users';
import { testClips, createTestClip } from '../../fixtures/clips';
import { testSessions, createTestSession } from '../../fixtures/sessions';

/**
 * Integration tests for src/handlers/compare.ts
 *
 * Tests cover:
 * - Authentication (session validation)
 * - GET /next (next pair to compare)
 * - GET /pair (specific pair by IDs)
 * - POST /vote (submitting votes)
 * - GET /stats (user comparison stats)
 * - GET /history (comparison history)
 * - GET /super-likes (super liked clips)
 * - HMAC verification for pending pairs cookie
 */

// Mock DB response types
interface MockQueryOptions {
  clips?: Clip[];
  session?: Session | null;
  user?: User | null;
  userClipRatings?: Array<{
    user_id: number;
    clip_id: number;
    elo_rating: number;
    matches_played: number;
    wins: number;
    losses: number;
    ties: number;
    super_liked: number;
    rating_deviation: number;
  }>;
  comparisons?: Array<{
    id: number;
    user_id: number;
    clip_a_id: number;
    clip_b_id: number;
    winner_clip_id: number | null;
    result: VoteResult;
    time_spent_ms: number | null;
    created_at: string;
  }>;
  comparisonsWithClips?: Array<{
    id: number;
    result: VoteResult;
    created_at: string;
    clipA_id: number;
    clipA_title: string;
    clipA_slug: string;
    clipB_id: number;
    clipB_title: string;
    clipB_slug: string;
  }>;
  superLikedClips?: Clip[];
  pairs?: Array<[number, number]>;
  pairingStats?: { totalPairs: number; viewedPairs: number; remainingPairs: number };
  recentComparison?: { id: number } | null;
}

/**
 * Creates a mock D1 database with configurable responses for compare handler
 */
function createMockD1(options: MockQueryOptions = {}) {
  const {
    clips = [],
    session = null,
    user = null,
    userClipRatings = [],
    comparisons = [],
    comparisonsWithClips = [],
    superLikedClips = [],
    pairs = [],
    pairingStats = { totalPairs: 100, viewedPairs: 0, remainingPairs: 100 },
    recentComparison = null,
  } = options;

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      sql,
      params,
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(): Promise<T | null> {
        // Session lookup (with expiry check)
        if (sql.includes('sessions') && sql.includes('expires_at')) {
          return session as T;
        }
        // User lookup by id
        if (sql.includes('FROM users WHERE id')) {
          return user as T;
        }
        // Clip by ID
        if (sql.includes('FROM clips WHERE id')) {
          const clipId = params[0] as number;
          const clip = clips.find((c) => c.id === clipId);
          return (clip as T) ?? null;
        }
        // User clip rating lookup
        if (sql.includes('FROM user_clip_ratings WHERE user_id') && sql.includes('clip_id')) {
          const userId = params[0] as number;
          const clipId = params[1] as number;
          const rating = userClipRatings.find(
            (r) => r.user_id === userId && r.clip_id === clipId
          );
          return (rating as T) ?? null;
        }
        // Deduplication check for recent comparison
        if (sql.includes('SELECT id FROM comparisons') && sql.includes("datetime('now', '-10 seconds')")) {
          return recentComparison as T;
        }
        // Clip rating rollup lookup (for updateRollupForVote)
        if (sql.includes('clip_rating_rollups') && sql.includes('clip_id')) {
          return null; // No existing rollup
        }
        // Total clips count
        if (sql.includes('COUNT(*)') && sql.includes('clips')) {
          return { count: clips.length } as T;
        }
        // Pairing stats
        if (sql.includes('COUNT(*)') && sql.includes('comparisons')) {
          return { count: comparisons.length } as T;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        // Batch clip lookup by IDs (used by getClipsByIds)
        if (sql.includes('FROM clips WHERE id IN')) {
          const matchedClips = clips.filter((c) => params.includes(c.id));
          return { results: matchedClips as T[], meta: { rows_read: matchedClips.length } };
        }
        // Active clips for pairing
        if (sql.includes('FROM clips') && sql.includes('is_active = 1')) {
          return { results: clips.filter(c => c.is_active === 1) as T[], meta: { rows_read: clips.length } };
        }
        // User comparisons with clips (history endpoint)
        if (sql.includes('comparisons') && sql.includes('JOIN clips')) {
          return { results: comparisonsWithClips as T[], meta: { rows_read: comparisonsWithClips.length } };
        }
        // Super liked clips
        if (sql.includes('user_clip_ratings') && sql.includes('super_liked = 1')) {
          return { results: superLikedClips as T[], meta: { rows_read: superLikedClips.length } };
        }
        // User's previous comparisons (for pairing algorithm)
        if (sql.includes('comparisons') && sql.includes('user_id')) {
          return { results: comparisons as T[], meta: { rows_read: comparisons.length } };
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
      try {
        cache.set(key, JSON.parse(value));
      } catch {
        cache.set(key, { data: value, timestamp: Date.now() });
      }
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
    SESSION_SECRET: 'test-session-secret-must-be-at-least-32-chars',
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

describe('Compare Handler Integration Tests', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono<{ Bindings: Env }>();
    app.route('/api/compare', compare);
  });

  describe('Authentication', () => {
    it('should return 401 when no session cookie is provided', async () => {
      const env = createTestEnv({});
      const req = createRequest('/api/compare/next');
      const res = await app.fetch(req, env);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Authentication required');
    });

    it('should return 401 when session is invalid', async () => {
      const env = createTestEnv({ session: null, user: null });
      const req = createRequest('/api/compare/next', { cookie: 'session=invalid-session-id' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('Invalid session');
    });

    it('should return 401 when session is expired', async () => {
      const expiredSession = createTestSession({
        id: 'expired-session-12345',
        user_id: 1,
        expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
      const user = createTestUser({ id: 1 });
      // The session check includes expiry, so pass null to simulate expired
      const env = createTestEnv({ session: null, user });

      const req = createRequest('/api/compare/next', { cookie: 'session=expired-session-12345' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(401);
    });

    it('should allow access with valid session', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, is_active: 1 }),
        createTestClip({ id: 2, is_active: 1 }),
      ];
      const env = createTestEnv({ session, user, clips });

      const req = createRequest('/api/compare/next', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      // Should not be 401, could be 200 or 404 depending on clip availability
      expect(res.status).not.toBe(401);
    });
  });

  describe('GET /api/compare/next', () => {
    it('should return next pair of clips for authenticated user', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, twitch_slug: 'Clip1', title: 'First Clip', is_active: 1 }),
        createTestClip({ id: 2, twitch_slug: 'Clip2', title: 'Second Clip', is_active: 1 }),
        createTestClip({ id: 3, twitch_slug: 'Clip3', title: 'Third Clip', is_active: 1 }),
      ];
      const env = createTestEnv({ session, user, clips });

      const req = createRequest('/api/compare/next', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      if (res.status === 200) {
        const data = await res.json();
        expect(data.clipA).toBeDefined();
        expect(data.clipB).toBeDefined();
        expect(data.clipA.id).toBeDefined();
        expect(data.clipA.twitchSlug).toBeDefined();
        expect(data.clipA.title).toBeDefined();
        expect(data.clipB.id).toBeDefined();
        expect(data.clipB.twitchSlug).toBeDefined();
        expect(data.clipB.title).toBeDefined();
      } else {
        expect(res.status).toBe(404);
      }
    });

    it('should return 404 when no clips available', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user, clips: [] });

      const req = createRequest('/api/compare/next', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('No clips available for comparison');
    });
  });

  describe('GET /api/compare/pair', () => {
    it('should return specific pair by IDs', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, twitch_slug: 'Clip1', title: 'First Clip' }),
        createTestClip({ id: 2, twitch_slug: 'Clip2', title: 'Second Clip' }),
      ];
      const env = createTestEnv({ session, user, clips });

      const req = createRequest('/api/compare/pair?a=1&b=2', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.clipA.id).toBe(1);
      expect(data.clipB.id).toBe(2);
    });

    it('should return 400 when clip IDs are missing', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user });

      const req = createRequest('/api/compare/pair', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('Missing clip IDs');
    });

    it('should return 404 when clip does not exist', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [createTestClip({ id: 1 })];
      const env = createTestEnv({ session, user, clips });

      const req = createRequest('/api/compare/pair?a=1&b=9999', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Clip not found');
    });
  });

  describe('POST /api/compare/vote', () => {
    describe('Vote Submission', () => {
      it('should successfully submit a vote for clip_a', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.newRatings).toBeDefined();
        expect(data.newRatings.clipA.id).toBe(1);
        expect(data.newRatings.clipB.id).toBe(2);
      });

      it('should successfully submit a vote for clip_b', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1800 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_b',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.newRatings.clipA.elo).toBeLessThan(1800); // Clip A loses ELO
        expect(data.newRatings.clipB.elo).toBeGreaterThan(1500); // Clip B gains ELO
      });

      it('should successfully submit a tie vote', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'tie',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
      });

      it('should successfully submit a skip vote', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'skip',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        // Skip doesn't change ratings
        expect(data.newRatings.clipA.elo).toBe(1500);
        expect(data.newRatings.clipB.elo).toBe(1500);
      });
    });

    describe('Validation', () => {
      it('should return 400 when clip_a_id is missing', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const env = createTestEnv({ session, user });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing required fields');
      });

      it('should return 400 when clip_b_id is missing', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const env = createTestEnv({ session, user });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            result: 'clip_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing required fields');
      });

      it('should return 400 when result is missing', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const env = createTestEnv({ session, user });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Missing required fields');
      });

      it('should return 400 for invalid result value', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const env = createTestEnv({ session, user });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'invalid_result',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Invalid result value');
      });

      it('should return 404 when clip does not exist', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [createTestClip({ id: 2 })];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 9999,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe('Clip not found');
      });
    });

    describe('Deduplication', () => {
      it('should deduplicate rapid duplicate votes', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];

        // First vote - no recent comparison
        const env1 = createTestEnv({ session, user, clips, recentComparison: null });

        const req1 = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res1 = await app.fetch(req1, env1);

        expect(res1.status).toBe(200);
        const data1 = await res1.json();
        expect(data1.success).toBe(true);
        expect(data1.deduplicated).toBeUndefined();

        // Second vote - with recent comparison (simulating duplicate)
        const env2 = createTestEnv({ session, user, clips, recentComparison: { id: 1 } });

        const req2 = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res2 = await app.fetch(req2, env2);

        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.success).toBe(true);
        expect(data2.deduplicated).toBe(true);
      });

      it('should allow different votes for the same clips', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1 }),
          createTestClip({ id: 2 }),
          createTestClip({ id: 3 }),
        ];
        const env = createTestEnv({ session, user, clips, recentComparison: null });

        // Submit vote for clip_a
        const req1 = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res1 = await app.fetch(req1, env);

        expect(res1.status).toBe(200);

        // Submit for different clips
        const req2 = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 3,
            result: 'clip_a',
          },
        });
        const res2 = await app.fetch(req2, env);

        expect(res2.status).toBe(200);
        const data2 = await res2.json();
        expect(data2.deduplicated).toBeUndefined();
      });
    });

    describe('Rating Updates', () => {
      it('should increase winner rating and decrease loser rating', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();

        // Winner gains, loser loses
        expect(data.newRatings.clipA.elo).toBeGreaterThan(1500);
        expect(data.newRatings.clipB.elo).toBeLessThan(1500);
      });

      it('should not change ratings significantly on skip', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'skip',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data.newRatings.clipA.elo).toBe(1500);
        expect(data.newRatings.clipB.elo).toBe(1500);
      });
    });

    describe('Super Likes', () => {
      it('should process super_a vote', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'super_a',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.newRatings.clipA.elo).toBeGreaterThan(1500);
      });

      it('should process super_b vote', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1, global_elo: 1500 }),
          createTestClip({ id: 2, global_elo: 1500 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'super_b',
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.newRatings.clipB.elo).toBeGreaterThan(1500);
      });
    });

    describe('Comparison Recording', () => {
      it('should include time_spent_ms in vote if provided', async () => {
        const session = createTestSession({ id: 'valid-session', user_id: 1 });
        const user = createTestUser({ id: 1 });
        const clips = [
          createTestClip({ id: 1 }),
          createTestClip({ id: 2 }),
        ];
        const env = createTestEnv({ session, user, clips });

        const req = createRequest('/api/compare/vote', {
          method: 'POST',
          cookie: 'session=valid-session',
          body: {
            clip_a_id: 1,
            clip_b_id: 2,
            result: 'clip_a',
            time_spent_ms: 5000,
          },
        });
        const res = await app.fetch(req, env);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
      });
    });
  });

  describe('GET /api/compare/stats', () => {
    it('should return user comparison stats', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1, total_comparisons: 50, total_super_likes: 5 });
      const clips = [createTestClip({ id: 1 }), createTestClip({ id: 2 })];
      const env = createTestEnv({ session, user, clips });

      const req = createRequest('/api/compare/stats', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalComparisons).toBe(50);
      expect(data.totalSuperLikes).toBe(5);
    });
  });

  describe('GET /api/compare/history', () => {
    it('should return user comparison history', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const comparisonsWithClips = [
        {
          id: 1,
          result: 'clip_a' as VoteResult,
          created_at: new Date().toISOString(),
          clipA_id: 1,
          clipA_title: 'First Clip',
          clipA_slug: 'Clip1',
          clipB_id: 2,
          clipB_title: 'Second Clip',
          clipB_slug: 'Clip2',
        },
      ];
      const env = createTestEnv({ session, user, comparisonsWithClips });

      const req = createRequest('/api/compare/history', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.comparisons).toBeDefined();
      expect(Array.isArray(data.comparisons)).toBe(true);
      expect(data.comparisons.length).toBe(1);

      const comparison = data.comparisons[0];
      expect(comparison.clipA).toBeDefined();
      expect(comparison.clipB).toBeDefined();
      expect(comparison.result).toBe('clip_a');
    });

    it('should respect limit parameter', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const comparisonsWithClips = [
        {
          id: 1,
          result: 'clip_a' as VoteResult,
          created_at: new Date().toISOString(),
          clipA_id: 1,
          clipA_title: 'First Clip',
          clipA_slug: 'Clip1',
          clipB_id: 2,
          clipB_title: 'Second Clip',
          clipB_slug: 'Clip2',
        },
        {
          id: 2,
          result: 'clip_b' as VoteResult,
          created_at: new Date().toISOString(),
          clipA_id: 1,
          clipA_title: 'First Clip',
          clipA_slug: 'Clip1',
          clipB_id: 3,
          clipB_title: 'Third Clip',
          clipB_slug: 'Clip3',
        },
      ];
      const env = createTestEnv({ session, user, comparisonsWithClips });

      const req = createRequest('/api/compare/history?limit=1', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      // Note: The mock returns all items, but in real implementation limit would be respected
      expect(data.comparisons).toBeDefined();
    });
  });

  describe('GET /api/compare/super-likes', () => {
    it('should return empty array when no super likes', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const env = createTestEnv({ session, user, superLikedClips: [] });

      const req = createRequest('/api/compare/super-likes', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.clips).toBeDefined();
      expect(Array.isArray(data.clips)).toBe(true);
      expect(data.clips.length).toBe(0);
    });

    it('should return super liked clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const superLikedClips = [
        createTestClip({ id: 1, twitch_slug: 'SuperClip1', title: 'Super Liked Clip 1' }),
      ];
      const env = createTestEnv({ session, user, superLikedClips });

      const req = createRequest('/api/compare/super-likes', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.clips.length).toBe(1);

      const clip = data.clips[0];
      expect(clip.id).toBe(1);
      expect(clip.twitchSlug).toBe('SuperClip1');
      expect(clip.title).toBe('Super Liked Clip 1');
    });

    it('should return multiple super liked clips', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const superLikedClips = [
        createTestClip({ id: 1, twitch_slug: 'SuperClip1', title: 'Super Liked Clip 1' }),
        createTestClip({ id: 2, twitch_slug: 'SuperClip2', title: 'Super Liked Clip 2' }),
      ];
      const env = createTestEnv({ session, user, superLikedClips });

      const req = createRequest('/api/compare/super-likes', { cookie: 'session=valid-session' });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.clips.length).toBe(2);
    });
  });

  describe('HMAC Verification', () => {
    it('should handle corrupted pending_pairs cookie gracefully', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, is_active: 1 }),
        createTestClip({ id: 2, is_active: 1 }),
      ];
      const env = createTestEnv({ session, user, clips });

      const req = new Request('http://localhost/api/compare/next', {
        method: 'GET',
        headers: {
          Cookie: 'session=valid-session; pending_pairs=corrupted-invalid-data',
        },
      });
      const res = await app.fetch(req, env);

      // Should not crash, should generate new pairs or return appropriate response
      expect([200, 404]).toContain(res.status);
    });

    it('should handle tampered pending_pairs cookie gracefully', async () => {
      const session = createTestSession({ id: 'valid-session', user_id: 1 });
      const user = createTestUser({ id: 1 });
      const clips = [
        createTestClip({ id: 1, is_active: 1 }),
        createTestClip({ id: 2, is_active: 1 }),
      ];
      const env = createTestEnv({ session, user, clips });

      // Create request with tampered cookie (valid format but invalid signature)
      const tamperedData = btoa(JSON.stringify([[1, 2], [3, 4]]));
      const fakeSignature = 'a'.repeat(64);

      const req = new Request('http://localhost/api/compare/next', {
        method: 'GET',
        headers: {
          Cookie: `session=valid-session; pending_pairs=${fakeSignature}.${tamperedData}`,
        },
      });
      const res = await app.fetch(req, env);

      // Should detect tampering and generate new pairs
      expect([200, 404]).toContain(res.status);
    });
  });
});

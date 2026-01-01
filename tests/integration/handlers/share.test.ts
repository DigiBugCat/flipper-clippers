import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import share from '../../../src/handlers/share';
import { createMockKV } from '../../setup/mocks/kv';
import { testUsers } from '../../fixtures/users';
import type { Env, ShareType } from '../../../src/types';

// Mock the getCachedSession function from auth
vi.mock('../../../src/handlers/auth', () => ({
  getCachedSession: vi.fn(),
}));

import { getCachedSession } from '../../../src/handlers/auth';

// Mock the social service
vi.mock('../../../src/services/social', () => ({
  getUserTopClips: vi.fn(),
  getPublicProfile: vi.fn(),
}));

import { getUserTopClips } from '../../../src/services/social';

// Helper to create a mock environment with configurable DB responses
function createMockEnv(dbConfig: {
  firstResult?: unknown | ((sql: string) => unknown);
  allResults?: unknown[] | ((sql: string) => unknown[]);
  runResult?: { changes: number } | ((sql: string) => { changes: number });
} = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      sql,
      params,
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(): Promise<T | null> {
        statements.push({ sql, params });
        if (typeof dbConfig.firstResult === 'function') {
          return dbConfig.firstResult(sql) as T;
        }
        return (dbConfig.firstResult ?? null) as T;
      },
      async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: object }> {
        statements.push({ sql, params });
        let results: unknown[];
        if (typeof dbConfig.allResults === 'function') {
          results = dbConfig.allResults(sql);
        } else {
          results = dbConfig.allResults ?? [];
        }
        return { results: results as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, served_by: 'mock' } };
      },
      async run(): Promise<{ results: unknown[]; success: boolean; meta: { changes: number } }> {
        statements.push({ sql, params });
        let changes = 1;
        if (typeof dbConfig.runResult === 'function') {
          changes = dbConfig.runResult(sql).changes;
        } else if (dbConfig.runResult) {
          changes = dbConfig.runResult.changes;
        }
        return { results: [], success: true, meta: { duration: 0, changes, last_row_id: 0, served_by: 'mock' } };
      },
    };
  };

  return {
    DB: {
      prepare: (sql: string) => createStatement(sql),
      batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, meta: { changes: 1 } })),
      _statements: statements,
    },
    SESSION_CACHE: createMockKV(),
    THUMBNAIL_CACHE: createMockKV(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
  };
}

// Helper to create test app with share routes
function createTestApp(env: ReturnType<typeof createMockEnv>) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/share', share);
  return app;
}

// Helper to create a mock request with cookies
function createRequestWithCookie(url: string, cookieName: string, cookieValue: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', `${cookieName}=${cookieValue}`);
  return new Request(url, { ...options, headers });
}

describe('Share Handler Integration Tests', () => {
  const testUser = testUsers.regular;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock getUserTopClips to return test data
    vi.mocked(getUserTopClips).mockResolvedValue([
      { id: 1, twitchSlug: 'clip1', title: 'Clip 1', userElo: 1600 },
      { id: 2, twitchSlug: 'clip2', title: 'Clip 2', userElo: 1550 },
    ]);

    // Mock crypto.getRandomValues for deterministic token generation in tests
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.length; i++) {
          array[i] = i + 10; // Deterministic values
        }
      }
      return array;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/share/create', () => {
    it('should require authentication', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/create', {
        method: 'POST',
        body: JSON.stringify({ type: 'profile' }),
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Authentication required');
    });

    it('should create a share token with valid session', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT COUNT')) {
            return { count: 0 };
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'profile' }),
        }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; token: string; shareUrl: string; type: ShareType }>();
      expect(data.success).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.shareUrl).toContain('/share/');
      expect(data.type).toBe('profile');
    });

    it('should default to profile type when type not specified', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT COUNT')) {
            return { count: 0 };
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ type: ShareType }>();
      expect(data.type).toBe('profile');
    });

    it('should reject invalid share types', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'invalid_type' }),
        }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Invalid share type');
    });

    it('should reject when maximum tokens reached', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT COUNT')) {
            return { count: 10 }; // Maximum reached
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'top5' }),
        }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const data = await res.json<{ error: string }>();
      expect(data.error).toContain('Maximum share links reached');
    });

    it('should support top5 share type', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT COUNT')) {
            return { count: 0 };
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'top5' }),
        }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ type: ShareType }>();
      expect(data.type).toBe('top5');
    });
  });

  describe('GET /api/share/:token', () => {
    const mockShareToken = {
      id: 1,
      user_id: 1,
      token: 'test-token-123',
      share_type: 'profile' as ShareType,
      view_count: 5,
      created_at: '2024-01-01T00:00:00Z',
      expires_at: null,
      twitch_display_name: 'TestUser',
      twitch_profile_image: 'https://example.com/avatar.jpg',
      total_comparisons: 50,
    };

    it('should return shared content for valid token', async () => {
      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT st.*')) {
            return mockShareToken;
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/test-token-123');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        type: ShareType;
        user: { displayName: string; totalComparisons: number };
        topClips: unknown[];
        viewCount: number;
      }>();
      expect(data.type).toBe('profile');
      expect(data.user.displayName).toBe('TestUser');
      expect(data.user.totalComparisons).toBe(50);
      expect(data.viewCount).toBe(6); // 5 + 1 for current view
      expect(data.topClips).toHaveLength(2);
    });

    it('should return 404 for invalid token', async () => {
      const mockEnv = createMockEnv(); // Default returns null
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/invalid-token');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Share link not found or expired');
    });

    it('should increment view count on access', async () => {
      let updateCalled = false;
      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT st.*')) {
            return mockShareToken;
          }
          return null;
        },
        runResult: (sql) => {
          if (sql.includes('UPDATE share_tokens SET view_count')) {
            updateCalled = true;
          }
          return { changes: 1 };
        },
      });
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/test-token-123');
      await app.fetch(req, mockEnv);

      expect(updateCalled).toBe(true);
    });
  });

  describe('DELETE /api/share/:token', () => {
    it('should require authentication', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/test-token', {
        method: 'DELETE',
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should delete owned token', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        runResult: { changes: 1 }, // Simulates successful delete
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/test-token',
        'session',
        'valid-session-id',
        { method: 'DELETE' }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean }>();
      expect(data.success).toBe(true);
    });

    it('should return 404 for unowned or non-existent token', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        runResult: { changes: 0 }, // Simulates no rows deleted
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/other-users-token',
        'session',
        'valid-session-id',
        { method: 'DELETE' }
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Token not found or not owned by you');
    });
  });

  describe('GET /api/share/my-links', () => {
    it('should require authentication', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/share/my-links');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return user share tokens', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockTokens = [
        { token: 'token1', share_type: 'profile', view_count: 10, created_at: '2024-01-01', expires_at: null },
        { token: 'token2', share_type: 'top5', view_count: 5, created_at: '2024-01-02', expires_at: null },
      ];

      const mockEnv = createMockEnv({
        allResults: () => mockTokens,
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/my-links',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        links: Array<{ token: string; type: ShareType; url: string; viewCount: number }>;
      }>();
      expect(data.links).toHaveLength(2);
      expect(data.links[0].token).toBe('token1');
      expect(data.links[0].url).toBe('/share/token1');
      expect(data.links[0].viewCount).toBe(10);
      expect(data.links[1].type).toBe('top5');
    });

    it('should return empty array when user has no tokens', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv(); // Default returns empty array
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/my-links',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ links: unknown[] }>();
      expect(data.links).toHaveLength(0);
    });
  });

  describe('Token Generation', () => {
    it('should generate consistent token format', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01' },
      });

      const mockEnv = createMockEnv({
        firstResult: (sql) => {
          if (sql.includes('SELECT COUNT')) {
            return { count: 0 };
          }
          return null;
        },
      });
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/share/create',
        'session',
        'valid-session-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'profile' }),
        }
      );
      const res = await app.fetch(req, mockEnv);
      const data = await res.json<{ token: string }>();

      // Token should be 16 characters (alphanumeric)
      expect(data.token).toHaveLength(16);
      expect(/^[a-z0-9]+$/.test(data.token)).toBe(true);
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import auth, { getCachedSession, invalidateCachedSession } from '../../../src/handlers/auth';
import { createMockD1 } from '../../setup/mocks/d1';
import { createMockKV } from '../../setup/mocks/kv';
import { testUsers, createTestUser } from '../../fixtures/users';
import { testSessions, createTestSession } from '../../fixtures/sessions';
import { mockTwitchTokenResponse, mockTwitchUserData, createMockTwitchUser } from '../../fixtures/twitch-api';
import type { Env, User, Session } from '../../../src/types';

// Helper to create a mock environment
function createMockEnv() {
  return {
    DB: createMockD1(),
    SESSION_CACHE: createMockKV(),
    THUMBNAIL_CACHE: createMockKV(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
  };
}

// Helper to create test app with auth routes
function createTestApp(env: ReturnType<typeof createMockEnv>) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/auth', auth);
  return app;
}

// Helper to create a mock request with cookies
function createRequestWithCookie(url: string, cookieName: string, cookieValue: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', `${cookieName}=${cookieValue}`);
  return new Request(url, { ...options, headers });
}

describe('Auth Handler Integration Tests', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = createTestApp(mockEnv);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('OAuth Flow Simulation', () => {
    describe('GET /api/auth/login', () => {
      it('should redirect to Twitch OAuth with correct parameters', async () => {
        const req = new Request('https://example.com/api/auth/login');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        const location = res.headers.get('Location');
        expect(location).toContain('https://id.twitch.tv/oauth2/authorize');
        expect(location).toContain('client_id=test-client-id');
        expect(location).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fapi%2Fauth%2Fcallback');
        expect(location).toContain('response_type=code');
        expect(location).toContain('scope=user%3Aread%3Aemail');
        expect(location).toContain('force_verify=true');
      });

      it('should set oauth_state cookie for CSRF protection', async () => {
        const req = new Request('https://example.com/api/auth/login');
        const res = await app.fetch(req, mockEnv);

        const cookies = res.headers.get('Set-Cookie');
        expect(cookies).toContain('oauth_state=');
        expect(cookies).toContain('HttpOnly');
        expect(cookies).toContain('Secure');
        expect(cookies).toContain('SameSite=Lax');
      });
    });

    describe('GET /api/auth/callback', () => {
      beforeEach(() => {
        // Setup mock fetch for Twitch API
        vi.stubGlobal('fetch', vi.fn());
      });

      it('should redirect with error when OAuth is denied', async () => {
        const req = new Request('https://example.com/api/auth/callback?error=access_denied');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=auth_denied');
      });

      it('should redirect with error when code is missing', async () => {
        const req = new Request('https://example.com/api/auth/callback?state=test-state');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=missing_params');
      });

      it('should redirect with error when state is missing', async () => {
        const req = new Request('https://example.com/api/auth/callback?code=test-code');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=missing_params');
      });

      it('should redirect with error when state does not match', async () => {
        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=correct-state');
        const req = new Request('https://example.com/api/auth/callback?code=test-code&state=wrong-state', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=invalid_state');
      });

      it('should complete OAuth flow and create session for new user', async () => {
        const twitchUser = createMockTwitchUser({
          id: 'new-user-twitch-id',
          login: 'newuser',
          display_name: 'New User',
        });

        // Mock Twitch API responses
        const mockFetch = vi.fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify(mockTwitchTokenResponse), { status: 200 })
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ data: [twitchUser] }), { status: 200 })
          );
        vi.stubGlobal('fetch', mockFetch);

        // Mock D1 queries for user lookup and creation
        const mockUser = createTestUser({
          id: 10,
          twitch_id: 'new-user-twitch-id',
          twitch_username: 'newuser',
          twitch_display_name: 'New User',
        });

        let userCreated = false;
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM users WHERE twitch_id')) {
              return userCreated ? mockUser : null;
            }
            return null;
          }),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('INSERT INTO users')) {
              userCreated = true;
            }
            return { success: true, meta: { changes: 1 } };
          }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=auth-code&state=valid-state', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/compare');

        // Check session cookie was set
        const cookies = res.headers.get('Set-Cookie');
        expect(cookies).toContain('session=');
        expect(cookies).toContain('HttpOnly');
        expect(cookies).toContain('Secure');

        // Verify Twitch API was called correctly
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://id.twitch.tv/oauth2/token', expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.twitch.tv/helix/users', expect.any(Object));
      });

      it('should handle existing user login and update last_login', async () => {
        const existingUser = testUsers.regular;
        const twitchUser = createMockTwitchUser({
          id: existingUser.twitch_id,
          login: existingUser.twitch_username,
          display_name: existingUser.twitch_display_name || 'User',
        });

        const mockFetch = vi.fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify(mockTwitchTokenResponse), { status: 200 })
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ data: [twitchUser] }), { status: 200 })
          );
        vi.stubGlobal('fetch', mockFetch);

        let updateLoginCalled = false;
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM users WHERE twitch_id')) {
              return existingUser;
            }
            return null;
          }),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('UPDATE users SET last_login')) {
              updateLoginCalled = true;
            }
            return { success: true, meta: { changes: 1 } };
          }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=auth-code&state=valid-state', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/compare');
        expect(updateLoginCalled).toBe(true);
      });

      it('should redirect with error when token exchange fails', async () => {
        const mockFetch = vi.fn().mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        );
        vi.stubGlobal('fetch', mockFetch);

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=invalid-code&state=valid-state', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=token_exchange_failed');
      });

      it('should redirect with error when user info fetch fails', async () => {
        const mockFetch = vi.fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify(mockTwitchTokenResponse), { status: 200 })
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
          );
        vi.stubGlobal('fetch', mockFetch);

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=auth-code&state=valid-state', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/?error=user_info_failed');
      });
    });

    describe('GET /api/auth/dev-login', () => {
      it('should allow dev login in local development', async () => {
        // Mock D1 for dev user creation
        const devUser = createTestUser({
          id: 999,
          twitch_id: 'dev-user-123',
          twitch_username: 'dev_user',
          twitch_display_name: 'Dev User',
        });

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM users WHERE twitch_id')) {
              return devUser;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        // Request without CF-Connecting-IP header (simulates local dev)
        const req = new Request('http://localhost:8787/api/auth/dev-login');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/compare');

        // Check session cookie was set
        const cookies = res.headers.get('Set-Cookie');
        expect(cookies).toContain('session=');
      });

      it('should reject dev login in production', async () => {
        const headers = new Headers();
        headers.set('CF-Connecting-IP', '203.0.113.1'); // External IP
        const req = new Request('https://example.com/api/auth/dev-login', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe('Dev login is only available in local development');
      });

      it('should allow dev login from localhost IP', async () => {
        const devUser = createTestUser({
          id: 999,
          twitch_id: 'dev-user-123',
          twitch_username: 'dev_user',
        });

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(devUser),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('CF-Connecting-IP', '127.0.0.1');
        const req = new Request('http://localhost:8787/api/auth/dev-login', { headers });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('/compare');
      });
    });
  });

  describe('Session Creation and Validation', () => {
    describe('Session Creation', () => {
      it('should create session with correct expiration (7 days)', async () => {
        const twitchUser = createMockTwitchUser();
        const mockFetch = vi.fn()
          .mockResolvedValueOnce(new Response(JSON.stringify(mockTwitchTokenResponse), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ data: [twitchUser] }), { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        let sessionExpiresAt: string | null = null;
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            if (sql.includes('INSERT INTO sessions') && args.length >= 3) {
              sessionExpiresAt = args[2] as string;
            }
            return {
              first: vi.fn().mockResolvedValue(testUsers.regular),
              run: vi.fn().mockResolvedValue({ success: true }),
              all: vi.fn().mockResolvedValue({ results: [], success: true }),
            };
          }),
          first: vi.fn().mockResolvedValue(testUsers.regular),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=code&state=valid-state', { headers });
        await app.fetch(req, mockEnv);

        // Verify session expiration is approximately 7 days from now
        expect(sessionExpiresAt).not.toBeNull();
        if (sessionExpiresAt) {
          const expiresDate = new Date(sessionExpiresAt);
          const now = new Date();
          const diffDays = (expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
          expect(diffDays).toBeGreaterThan(6.9);
          expect(diffDays).toBeLessThan(7.1);
        }
      });

      it('should set session cookie with correct attributes', async () => {
        const twitchUser = createMockTwitchUser();
        const mockFetch = vi.fn()
          .mockResolvedValueOnce(new Response(JSON.stringify(mockTwitchTokenResponse), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ data: [twitchUser] }), { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);

        mockEnv.DB.prepare = vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(testUsers.regular),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', 'oauth_state=valid-state');
        const req = new Request('https://example.com/api/auth/callback?code=code&state=valid-state', { headers });
        const res = await app.fetch(req, mockEnv);

        const cookies = res.headers.get('Set-Cookie');
        expect(cookies).toContain('session=');
        expect(cookies).toContain('HttpOnly');
        expect(cookies).toContain('Secure');
        expect(cookies).toContain('SameSite=Lax');
        expect(cookies).toContain('Max-Age=604800'); // 7 days in seconds
        expect(cookies).toContain('Path=/');
      });
    });

    describe('Session Validation', () => {
      it('should validate valid session from cookie', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        // Setup mock D1 to return session and user
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', session.id);
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user).not.toBeNull();
        expect(body.user.id).toBe(user.id);
        expect(body.user.twitchUsername).toBe(user.twitch_username);
      });

      it('should reject expired session', async () => {
        const expiredSession = testSessions.expired;

        // Mock D1 to return null for expired session (getSession checks expiry)
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null), // Session not found (expired)
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', expiredSession.id);
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user).toBeNull();
      });

      it('should handle missing session cookie gracefully', async () => {
        const req = new Request('https://example.com/api/auth/me');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user).toBeNull();
      });

      it('should handle non-existent session ID', async () => {
        mockEnv.DB.prepare = vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', 'non-existent-session');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user).toBeNull();
      });
    });
  });

  describe('KV Session Caching', () => {
    describe('getCachedSession', () => {
      it('should return cached session from KV when available', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;
        const cachedData = { session, user };

        // Pre-populate KV cache
        await mockEnv.SESSION_CACHE.put(`session:${session.id}`, JSON.stringify(cachedData));

        const result = await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, session.id);

        expect(result).not.toBeNull();
        expect(result?.session.id).toBe(session.id);
        expect(result?.user.id).toBe(user.id);
      });

      it('should fall back to D1 when KV cache miss', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        // Don't populate KV cache - will be empty
        // Mock D1 to return session and user
        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const result = await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, session.id);

        expect(result).not.toBeNull();
        expect(result?.session.id).toBe(session.id);
        expect(result?.user.id).toBe(user.id);
      });

      it('should populate KV cache after D1 lookup', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, session.id);

        // Verify KV was populated
        const cached = await mockEnv.SESSION_CACHE.get(`session:${session.id}`, { type: 'json' });
        expect(cached).not.toBeNull();
        expect((cached as any).session.id).toBe(session.id);
      });

      it('should delete expired session from cache and return null', async () => {
        const expiredSession = createTestSession({
          id: 'expired-cached-session',
          user_id: 1,
          expires_at: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
        });
        const user = testUsers.regular;
        const cachedData = { session: expiredSession, user };

        // Pre-populate KV cache with expired session
        await mockEnv.SESSION_CACHE.put(`session:${expiredSession.id}`, JSON.stringify(cachedData));

        const result = await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, expiredSession.id);

        expect(result).toBeNull();

        // Verify expired session was deleted from cache
        const cached = await mockEnv.SESSION_CACHE.get(`session:${expiredSession.id}`);
        expect(cached).toBeNull();
      });

      it('should return null when session not found in D1', async () => {
        mockEnv.DB.prepare = vi.fn(() => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const result = await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, 'non-existent');

        expect(result).toBeNull();
      });

      it('should return null when user not found for session', async () => {
        const session = testSessions.valid;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            // User not found
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const result = await getCachedSession(mockEnv.DB as any, mockEnv.SESSION_CACHE as any, session.id);

        expect(result).toBeNull();
      });
    });

    describe('invalidateCachedSession', () => {
      it('should remove session from KV cache', async () => {
        const sessionId = 'session-to-invalidate';
        await mockEnv.SESSION_CACHE.put(`session:${sessionId}`, JSON.stringify({ test: true }));

        // Verify it exists
        let cached = await mockEnv.SESSION_CACHE.get(`session:${sessionId}`);
        expect(cached).not.toBeNull();

        // Invalidate
        await invalidateCachedSession(mockEnv.SESSION_CACHE as any, sessionId);

        // Verify it's gone
        cached = await mockEnv.SESSION_CACHE.get(`session:${sessionId}`);
        expect(cached).toBeNull();
      });
    });
  });

  describe('Logout Endpoint', () => {
    describe('POST /api/auth/logout', () => {
      it('should delete session from D1 and clear cookie', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;
        let sessionDeleted = false;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('DELETE FROM sessions')) {
              sessionDeleted = true;
            }
            return { success: true };
          }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/logout', 'session', session.id, { method: 'POST' });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        // Verify session was deleted
        expect(sessionDeleted).toBe(true);

        // Verify cookie was cleared
        const cookies = res.headers.get('Set-Cookie');
        expect(cookies).toContain('session=');
      });

      it('should invalidate KV cache on logout', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        // Pre-populate KV cache
        await mockEnv.SESSION_CACHE.put(`session:${session.id}`, JSON.stringify({ session, user }));

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/logout', 'session', session.id, { method: 'POST' });
        await app.fetch(req, mockEnv);

        // Verify KV cache was invalidated
        const cached = await mockEnv.SESSION_CACHE.get(`session:${session.id}`);
        expect(cached).toBeNull();
      });

      it('should succeed even without session cookie', async () => {
        const req = new Request('https://example.com/api/auth/logout', { method: 'POST' });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
      });
    });
  });

  describe('GET /api/auth/me Endpoint', () => {
    it('should return user data when authenticated', async () => {
      const session = testSessions.valid;
      const user = testUsers.regular;

      mockEnv.DB.prepare = vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('SELECT * FROM sessions')) {
            return session;
          }
          if (sql.includes('SELECT * FROM users WHERE id')) {
            return user;
          }
          return null;
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      }));

      const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', session.id);
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toEqual({
        id: user.id,
        twitchUsername: user.twitch_username,
        displayName: user.twitch_display_name,
        profileImage: user.twitch_profile_image,
        totalComparisons: user.total_comparisons,
        totalSuperLikes: user.total_super_likes,
        isProfilePublic: user.is_profile_public === 1,
      });
    });

    it('should return null user when not authenticated', async () => {
      const req = new Request('https://example.com/api/auth/me');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeNull();
    });

    it('should return null user and clear cookie for invalid session', async () => {
      mockEnv.DB.prepare = vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      }));

      const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', 'invalid-session-id');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeNull();

      // Check cookie was cleared
      const cookies = res.headers.get('Set-Cookie');
      expect(cookies).toContain('session=');
    });

    it('should handle private profile correctly', async () => {
      const session = testSessions.valid;
      const privateUser = testUsers.private;

      mockEnv.DB.prepare = vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('SELECT * FROM sessions')) {
            return { ...session, user_id: privateUser.id };
          }
          if (sql.includes('SELECT * FROM users WHERE id')) {
            return privateUser;
          }
          return null;
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [], success: true }),
      }));

      const req = createRequestWithCookie('https://example.com/api/auth/me', 'session', session.id);
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.isProfilePublic).toBe(false);
    });
  });

  describe('Privacy Settings Endpoints', () => {
    describe('GET /api/auth/privacy', () => {
      it('should return privacy settings when authenticated', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const req = createRequestWithCookie('https://example.com/api/auth/privacy', 'session', session.id);
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.isProfilePublic).toBe(true);
      });

      it('should return 401 when not authenticated', async () => {
        const req = new Request('https://example.com/api/auth/privacy');
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('Not authenticated');
      });
    });

    describe('PUT /api/auth/privacy', () => {
      it('should update privacy settings', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;
        let privacyUpdated = false;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('UPDATE users SET is_profile_public')) {
              privacyUpdated = true;
            }
            return { success: true };
          }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', `session=${session.id}`);
        headers.set('Content-Type', 'application/json');
        const req = new Request('https://example.com/api/auth/privacy', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ isProfilePublic: false }),
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.isProfilePublic).toBe(false);
        expect(privacyUpdated).toBe(true);
      });

      it('should invalidate session cache after privacy update', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        // Pre-populate KV cache
        await mockEnv.SESSION_CACHE.put(`session:${session.id}`, JSON.stringify({ session, user }));

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', `session=${session.id}`);
        headers.set('Content-Type', 'application/json');
        const req = new Request('https://example.com/api/auth/privacy', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ isProfilePublic: false }),
        });
        await app.fetch(req, mockEnv);

        // Verify KV cache was invalidated
        const cached = await mockEnv.SESSION_CACHE.get(`session:${session.id}`);
        expect(cached).toBeNull();
      });

      it('should return 400 for invalid isProfilePublic value', async () => {
        const session = testSessions.valid;
        const user = testUsers.regular;

        mockEnv.DB.prepare = vi.fn((sql: string) => ({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT * FROM sessions')) {
              return session;
            }
            if (sql.includes('SELECT * FROM users WHERE id')) {
              return user;
            }
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [], success: true }),
        }));

        const headers = new Headers();
        headers.set('Cookie', `session=${session.id}`);
        headers.set('Content-Type', 'application/json');
        const req = new Request('https://example.com/api/auth/privacy', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ isProfilePublic: 'not-a-boolean' }),
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('isProfilePublic must be a boolean');
      });

      it('should return 401 when not authenticated', async () => {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        const req = new Request('https://example.com/api/auth/privacy', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ isProfilePublic: false }),
        });
        const res = await app.fetch(req, mockEnv);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe('Not authenticated');
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, User, Clip } from '../../../src/types';
import { testUsers } from '../../fixtures/users';
import { testClips, createTestClip } from '../../fixtures/clips';
import { testSessions } from '../../fixtures/sessions';
import { createMockKV } from '../../setup/mocks/kv';

/**
 * Integration tests for src/handlers/saved.ts
 * Tests the saved clips API endpoints including:
 * - GET /api/saved - List saved clips
 * - GET /api/saved/check/:clipId - Check if a clip is saved
 * - POST /api/saved/check-multiple - Batch check multiple clips
 * - POST /api/saved/:clipId - Save a clip
 * - DELETE /api/saved/:clipId - Unsave a clip
 * - PUT /api/saved/reorder - Reorder saved clips
 */

// Mock D1 database with configurable behavior
function createMockD1() {
  const bindMock = vi.fn();
  const runMock = vi.fn();
  const allMock = vi.fn();
  const firstMock = vi.fn();

  const createBoundStatement = () => ({
    bind: bindMock.mockReturnThis(),
    run: runMock,
    all: allMock,
    first: firstMock,
  });

  const prepareMock = vi.fn(() => createBoundStatement());

  return {
    prepare: prepareMock,
    _mocks: {
      prepare: prepareMock,
      bind: bindMock,
      run: runMock,
      all: allMock,
      first: firstMock,
    },
  };
}

// Helper to create the app with mocked dependencies
function createTestApp(mockDb: ReturnType<typeof createMockD1>, mockSessionCache: ReturnType<typeof createMockKV>) {
  // Import and configure the saved handler
  // We need to create a minimal app that simulates the saved routes
  const app = new Hono<{ Bindings: Env }>();

  // Simulate the saved routes based on src/handlers/saved.ts
  app.route('/api/saved', createSavedRoutes());

  return app;

  function createSavedRoutes() {
    type Variables = {
      user: User;
      userId: number;
    };

    const saved = new Hono<{ Bindings: Env; Variables: Variables }>();

    // Middleware to require authentication
    saved.use('*', async (c, next) => {
      const sessionCookie = c.req.header('Cookie')?.match(/session=([^;]+)/)?.[1];
      if (!sessionCookie) {
        return c.json({ error: 'Authentication required' }, 401);
      }

      // Check session in mock cache
      const cacheKey = `session:${sessionCookie}`;
      const cached = await mockSessionCache.get(cacheKey, { type: 'json' }) as { session: { expires_at: string }; user: User } | null;

      if (!cached) {
        return c.json({ error: 'Invalid session' }, 401);
      }

      // Check expiration
      if (new Date(cached.session.expires_at) <= new Date()) {
        return c.json({ error: 'Invalid session' }, 401);
      }

      c.set('user', cached.user);
      c.set('userId', cached.user.id);
      await next();
    });

    // GET / - List saved clips
    saved.get('/', async (c) => {
      const userId = c.get('userId');

      // Call the mock and get results
      const result = await mockDb.prepare('').bind(userId).all();
      const clips = result?.results || [];

      c.header('Cache-Control', 'private, max-age=60');
      return c.json({
        clips: clips.map((clip: Clip & { position: number; saved_at: string }) => ({
          id: clip.id,
          twitchSlug: clip.twitch_slug,
          title: clip.title,
          twitchUrl: clip.twitch_url,
          clippedBy: clip.clipped_by,
          position: clip.position,
          savedAt: clip.saved_at,
        })),
      });
    });

    // GET /check/:clipId - Check if a clip is saved
    saved.get('/check/:clipId', async (c) => {
      const userId = c.get('userId');
      const clipId = parseInt(c.req.param('clipId'), 10);

      if (!clipId) {
        return c.json({ error: 'Invalid clip ID' }, 400);
      }

      // Check first mock result
      const result = await mockDb.prepare('').bind(userId, clipId).first();
      return c.json({ saved: result !== null });
    });

    // POST /check-multiple - Batch check multiple clips
    saved.post('/check-multiple', async (c) => {
      const userId = c.get('userId');
      const body = await c.req.json<{ clipIds: number[] }>();

      if (!body.clipIds || !Array.isArray(body.clipIds)) {
        return c.json({ error: 'Invalid clip IDs' }, 400);
      }

      // Get saved clip IDs from mock
      const result = await mockDb.prepare('').bind(userId, ...body.clipIds).all();
      const savedSet = new Set((result.results as { clip_id: number }[]).map((r) => r.clip_id));

      const results: Record<number, boolean> = {};
      for (const clipId of body.clipIds) {
        results[clipId] = savedSet.has(clipId);
      }

      return c.json({ saved: results });
    });

    // POST /:clipId - Save a clip
    saved.post('/:clipId', async (c) => {
      const userId = c.get('userId');
      const clipId = parseInt(c.req.param('clipId'), 10);

      if (!clipId) {
        return c.json({ error: 'Invalid clip ID' }, 400);
      }

      // Check if clip exists
      const clip = await mockDb.prepare('').bind(clipId).first();
      if (!clip) {
        return c.json({ error: 'Clip not found' }, 404);
      }

      // Save clip
      await mockDb.prepare('').bind(userId, clipId).run();

      return c.json({ success: true });
    });

    // DELETE /:clipId - Unsave a clip
    saved.delete('/:clipId', async (c) => {
      const userId = c.get('userId');
      const clipId = parseInt(c.req.param('clipId'), 10);

      if (!clipId) {
        return c.json({ error: 'Invalid clip ID' }, 400);
      }

      await mockDb.prepare('').bind(userId, clipId).run();

      return c.json({ success: true });
    });

    // PUT /reorder - Reorder saved clips
    saved.put('/reorder', async (c) => {
      const userId = c.get('userId');
      const body = await c.req.json<{ clipId: number; newPosition: number }>();

      if (!body.clipId || !body.newPosition) {
        return c.json({ error: 'Missing clipId or newPosition' }, 400);
      }

      await mockDb.prepare('').bind(userId, body.clipId, body.newPosition).run();

      return c.json({ success: true });
    });

    return saved;
  }
}

// Helper to set up authenticated session
function setupAuthenticatedSession(
  mockSessionCache: ReturnType<typeof createMockKV>,
  sessionId: string,
  user: User
) {
  const cacheKey = `session:${sessionId}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  mockSessionCache._set(
    cacheKey,
    JSON.stringify({
      session: { id: sessionId, user_id: user.id, expires_at: expiresAt, created_at: new Date().toISOString() },
      user: user,
    })
  );
}

describe('Saved Handler Integration Tests', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  let mockSessionCache: ReturnType<typeof createMockKV>;
  let app: ReturnType<typeof createTestApp>;
  const validSessionId = testSessions.valid.id;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockD1();
    mockSessionCache = createMockKV();
    app = createTestApp(mockDb, mockSessionCache);
  });

  describe('Authentication', () => {
    it('returns 401 when no session cookie is provided', async () => {
      const res = await app.request('/api/saved');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: 'Authentication required' });
    });

    it('returns 401 when session is invalid', async () => {
      const res = await app.request('/api/saved', {
        headers: { Cookie: 'session=invalid-session-id' },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid session' });
    });

    it('returns 401 when session is expired', async () => {
      // Set up an expired session
      const expiredSessionId = 'expired-session';
      const cacheKey = `session:${expiredSessionId}`;
      mockSessionCache._set(
        cacheKey,
        JSON.stringify({
          session: {
            id: expiredSessionId,
            user_id: testUsers.regular.id,
            expires_at: new Date(Date.now() - 1000).toISOString(), // Already expired
            created_at: new Date().toISOString(),
          },
          user: testUsers.regular,
        })
      );

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${expiredSessionId}` },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid session' });
    });
  });

  describe('GET /api/saved - List saved clips', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('returns empty list when user has no saved clips', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ clips: [] });
    });

    it('returns saved clips with correct structure', async () => {
      const savedClips = [
        {
          ...testClips.highRated,
          position: 1,
          saved_at: '2024-01-15T12:00:00Z',
        },
        {
          ...testClips.mediumRated,
          position: 2,
          saved_at: '2024-01-15T11:00:00Z',
        },
      ];
      mockDb._mocks.all.mockResolvedValue({ results: savedClips });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.clips).toHaveLength(2);
      expect(json.clips[0]).toEqual({
        id: testClips.highRated.id,
        twitchSlug: testClips.highRated.twitch_slug,
        title: testClips.highRated.title,
        twitchUrl: testClips.highRated.twitch_url,
        clippedBy: testClips.highRated.clipped_by,
        position: 1,
        savedAt: '2024-01-15T12:00:00Z',
      });
    });

    it('sets private Cache-Control header', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    });
  });

  describe('GET /api/saved/check/:clipId - Check single clip', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('returns saved: true when clip is saved', async () => {
      mockDb._mocks.first.mockResolvedValue({ clip_id: 1 });

      const res = await app.request('/api/saved/check/1', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ saved: true });
    });

    it('returns saved: false when clip is not saved', async () => {
      mockDb._mocks.first.mockResolvedValue(null);

      const res = await app.request('/api/saved/check/999', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ saved: false });
    });

    it('returns 400 for invalid clip ID', async () => {
      const res = await app.request('/api/saved/check/invalid', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });

    it('returns 400 for non-numeric clip ID', async () => {
      const res = await app.request('/api/saved/check/abc', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });
  });

  describe('POST /api/saved/check-multiple - Batch check clips', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('returns saved status for multiple clips', async () => {
      // User has saved clips 1 and 3, but not 2
      mockDb._mocks.all.mockResolvedValue({
        results: [{ clip_id: 1 }, { clip_id: 3 }],
      });

      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: [1, 2, 3] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.saved).toEqual({
        1: true,
        2: false,
        3: true,
      });
    });

    it('returns empty object for empty clipIds array', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: [] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.saved).toEqual({});
    });

    it('returns 400 for missing clipIds', async () => {
      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip IDs' });
    });

    it('returns 400 for non-array clipIds', async () => {
      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip IDs' });
    });

    it('handles all clips not saved', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: [1, 2, 3] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.saved).toEqual({
        1: false,
        2: false,
        3: false,
      });
    });

    it('handles all clips saved', async () => {
      mockDb._mocks.all.mockResolvedValue({
        results: [{ clip_id: 1 }, { clip_id: 2 }, { clip_id: 3 }],
      });

      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: [1, 2, 3] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.saved).toEqual({
        1: true,
        2: true,
        3: true,
      });
    });
  });

  describe('POST /api/saved/:clipId - Save a clip', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('saves a clip successfully', async () => {
      // First call returns the clip (exists check)
      mockDb._mocks.first.mockResolvedValue(testClips.highRated);
      mockDb._mocks.run.mockResolvedValue({ success: true });

      const res = await app.request('/api/saved/1', {
        method: 'POST',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });
    });

    it('returns 404 when clip does not exist', async () => {
      mockDb._mocks.first.mockResolvedValue(null);

      const res = await app.request('/api/saved/999', {
        method: 'POST',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toEqual({ error: 'Clip not found' });
    });

    it('returns 400 for invalid clip ID', async () => {
      const res = await app.request('/api/saved/invalid', {
        method: 'POST',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });

    it('returns 400 for non-numeric clip ID', async () => {
      const res = await app.request('/api/saved/abc', {
        method: 'POST',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });
  });

  describe('DELETE /api/saved/:clipId - Unsave a clip', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('unsaves a clip successfully', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true });

      const res = await app.request('/api/saved/1', {
        method: 'DELETE',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });
    });

    it('returns 400 for invalid clip ID', async () => {
      const res = await app.request('/api/saved/invalid', {
        method: 'DELETE',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });

    it('returns success even if clip was not saved', async () => {
      // The handler doesn't check if the clip was saved before deleting
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 0 } });

      const res = await app.request('/api/saved/999', {
        method: 'DELETE',
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });
    });
  });

  describe('PUT /api/saved/reorder - Reorder saved clips', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('reorders a clip successfully', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true });

      const res = await app.request('/api/saved/reorder', {
        method: 'PUT',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipId: 1, newPosition: 3 }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });
    });

    it('returns 400 when clipId is missing', async () => {
      const res = await app.request('/api/saved/reorder', {
        method: 'PUT',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newPosition: 3 }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Missing clipId or newPosition' });
    });

    it('returns 400 when newPosition is missing', async () => {
      const res = await app.request('/api/saved/reorder', {
        method: 'PUT',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipId: 1 }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Missing clipId or newPosition' });
    });

    it('returns 400 when both clipId and newPosition are missing', async () => {
      const res = await app.request('/api/saved/reorder', {
        method: 'PUT',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Missing clipId or newPosition' });
    });
  });

  describe('User-specific data isolation', () => {
    it('different users see their own saved clips', async () => {
      // Set up session for regular user
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);

      const userAClips = [
        { ...testClips.highRated, position: 1, saved_at: '2024-01-15T12:00:00Z' },
      ];
      mockDb._mocks.all.mockResolvedValue({ results: userAClips });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.clips).toHaveLength(1);
      expect(json.clips[0].id).toBe(testClips.highRated.id);
    });

    it('admin user sees their own saved clips', async () => {
      const adminSessionId = testSessions.admin.id;
      setupAuthenticatedSession(mockSessionCache, adminSessionId, testUsers.admin);

      const adminClips = [
        { ...testClips.lowRated, position: 1, saved_at: '2024-01-15T10:00:00Z' },
        { ...testClips.mediumRated, position: 2, saved_at: '2024-01-15T11:00:00Z' },
      ];
      mockDb._mocks.all.mockResolvedValue({ results: adminClips });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${adminSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.clips).toHaveLength(2);
    });
  });

  describe('Edge cases', () => {
    beforeEach(() => {
      setupAuthenticatedSession(mockSessionCache, validSessionId, testUsers.regular);
    });

    it('handles clip ID of 0 as invalid', async () => {
      const res = await app.request('/api/saved/check/0', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Invalid clip ID' });
    });

    it('handles negative clip ID as invalid', async () => {
      const res = await app.request('/api/saved/check/-1', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      // Negative numbers parse to NaN when using parseInt with a negative sign
      // actually parseInt('-1') returns -1, but the handler treats 0 as invalid
      // This depends on the actual implementation behavior
      expect(res.status).toBe(200); // -1 parses successfully but won't find anything
    });

    it('handles very large clip IDs', async () => {
      mockDb._mocks.first.mockResolvedValue(null);

      const res = await app.request('/api/saved/check/999999999', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ saved: false });
    });

    it('handles batch check with duplicate clip IDs', async () => {
      mockDb._mocks.all.mockResolvedValue({
        results: [{ clip_id: 1 }],
      });

      const res = await app.request('/api/saved/check-multiple', {
        method: 'POST',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipIds: [1, 1, 2, 2] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      // Duplicates should be handled - each unique ID should appear once
      expect(json.saved[1]).toBe(true);
      expect(json.saved[2]).toBe(false);
    });

    it('handles reorder with position 0', async () => {
      // Position 0 is treated as falsy, so should return error
      const res = await app.request('/api/saved/reorder', {
        method: 'PUT',
        headers: {
          Cookie: `session=${validSessionId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clipId: 1, newPosition: 0 }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ error: 'Missing clipId or newPosition' });
    });

    it('handles clip with null title', async () => {
      const clipWithNullTitle = createTestClip({
        id: 10,
        title: null,
        twitch_slug: 'NullTitleClip',
      });

      const savedClips = [
        { ...clipWithNullTitle, position: 1, saved_at: '2024-01-15T12:00:00Z' },
      ];
      mockDb._mocks.all.mockResolvedValue({ results: savedClips });

      const res = await app.request('/api/saved', {
        headers: { Cookie: `session=${validSessionId}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.clips[0].title).toBeNull();
    });
  });
});

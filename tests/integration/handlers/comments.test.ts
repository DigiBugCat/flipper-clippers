import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import comments from '../../../src/handlers/comments';
import { testUsers, createTestUser } from '../../fixtures/users';
import { testClips, createTestClip } from '../../fixtures/clips';
import { testSessions, createTestSession } from '../../fixtures/sessions';
import type { Env, ClipComment, User, Session, Clip } from '../../../src/types';

/**
 * Create a mock D1 database with configurable behavior for comments handler tests
 */
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

/**
 * Create a mock KV namespace for session caching
 */
function createMockKV() {
  const storage = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = storage.get(key);
      if (!value) return null;
      if (type === 'json') return JSON.parse(value);
      return value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
    _storage: storage,
    _set(key: string, value: unknown) {
      storage.set(key, JSON.stringify(value));
    },
    _reset() {
      storage.clear();
    },
  };
}

/**
 * Create test app with comments routes mounted
 */
function createTestApp(db: ReturnType<typeof createMockD1>, sessionCache: ReturnType<typeof createMockKV>) {
  const app = new Hono<{ Bindings: Env }>();

  // Mount comments routes
  app.route('/api/comments', comments);

  return {
    app,
    fetch: (path: string, options: RequestInit = {}) => {
      const env = {
        DB: db as unknown as D1Database,
        SESSION_CACHE: sessionCache as unknown as KVNamespace,
        TWITCH_CLIENT_ID: 'test-client-id',
        TWITCH_CLIENT_SECRET: 'test-client-secret',
        SESSION_SECRET: 'test-session-secret',
        THUMBNAIL_CACHE: {} as KVNamespace,
      };

      const url = `http://localhost${path}`;
      const request = new Request(url, options);

      return app.fetch(request, env);
    },
  };
}

/**
 * Setup authenticated session in mocks
 */
function setupAuthenticatedSession(
  db: ReturnType<typeof createMockD1>,
  sessionCache: ReturnType<typeof createMockKV>,
  user: User,
  session: Session
) {
  // Cache session in KV
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  sessionCache._set(`session:${session.id}`, {
    session: { ...session, expires_at: expiresAt },
    user,
  });
}

describe('Comments Handler Integration Tests', () => {
  let mockDb: ReturnType<typeof createMockD1>;
  let mockSessionCache: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockD1();
    mockSessionCache = createMockKV();
  });

  describe('GET /api/comments/:clipId - Get public comments', () => {
    it('returns empty array when no comments exist', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const response = await fetch('/api/comments/1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comments).toEqual([]);
    });

    it('returns public comments with user information', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const mockComments = [
        {
          id: 1,
          user_id: 1,
          clip_id: 1,
          comment: 'Great clip!',
          emoji: 'fire',
          is_public: 1,
          created_at: '2024-01-15T12:00:00Z',
          updated_at: '2024-01-15T12:00:00Z',
          twitch_display_name: 'TestUser',
          twitch_profile_image: 'https://example.com/avatar.png',
        },
        {
          id: 2,
          user_id: 2,
          clip_id: 1,
          comment: 'So funny!',
          emoji: 'lul',
          is_public: 1,
          created_at: '2024-01-15T11:00:00Z',
          updated_at: '2024-01-15T11:00:00Z',
          twitch_display_name: 'AnotherUser',
          twitch_profile_image: 'https://example.com/avatar2.png',
        },
      ];

      mockDb._mocks.all.mockResolvedValue({ results: mockComments });

      const response = await fetch('/api/comments/1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comments).toHaveLength(2);
      expect(data.comments[0]).toEqual({
        id: 1,
        comment: 'Great clip!',
        emoji: 'fire',
        createdAt: '2024-01-15T12:00:00Z',
        user: {
          displayName: 'TestUser',
          profileImage: 'https://example.com/avatar.png',
        },
      });
    });

    it('returns 400 for invalid clip ID', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const response = await fetch('/api/comments/invalid');
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid clip ID');
    });

    it('queries only public comments', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await fetch('/api/comments/42');

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('is_public = 1')
      );
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(42);
    });
  });

  describe('GET /api/comments/my/:clipId - Get user own comment', () => {
    it('returns 401 when not authenticated', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const response = await fetch('/api/comments/my/1');
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Authentication required');
    });

    it('returns null when user has no comment for clip', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(null);

      const response = await fetch('/api/comments/my/1', {
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comment).toBeNull();
    });

    it('returns user comment with all fields', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);

      const mockComment: ClipComment = {
        id: 1,
        user_id: user.id,
        clip_id: 1,
        comment: 'My comment',
        emoji: 'poggers',
        is_public: 1,
        created_at: '2024-01-15T12:00:00Z',
        updated_at: '2024-01-15T12:30:00Z',
      };

      mockDb._mocks.first.mockResolvedValue(mockComment);

      const response = await fetch('/api/comments/my/1', {
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comment).toEqual({
        id: 1,
        comment: 'My comment',
        emoji: 'poggers',
        isPublic: true,
        createdAt: '2024-01-15T12:00:00Z',
        updatedAt: '2024-01-15T12:30:00Z',
      });
    });

    it('returns isPublic as false when comment is private', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);

      const mockComment: ClipComment = {
        id: 1,
        user_id: user.id,
        clip_id: 1,
        comment: 'Private comment',
        emoji: null,
        is_public: 0,
        created_at: '2024-01-15T12:00:00Z',
        updated_at: '2024-01-15T12:00:00Z',
      };

      mockDb._mocks.first.mockResolvedValue(mockComment);

      const response = await fetch('/api/comments/my/1', {
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comment.isPublic).toBe(false);
    });

    it('returns 400 for invalid clip ID', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);

      const response = await fetch('/api/comments/my/invalid', {
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid clip ID');
    });
  });

  describe('POST /api/comments/:clipId - Create/update comment', () => {
    it('returns 401 when not authenticated', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: 'Test comment' }),
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Authentication required');
    });

    it('returns 404 when clip does not exist', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(null); // getClipById returns null

      const response = await fetch('/api/comments/999', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Test comment' }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Clip not found');
    });

    it('creates comment with valid data', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip); // getClipById returns clip
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Great clip!', emoji: 'fire' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('creates comment with emoji only (no text comment)', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ emoji: 'skull' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('creates comment with text only (no emoji)', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Nice clip!' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('returns 400 for invalid emoji', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ emoji: 'invalid_emoji' }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid emoji');
      expect(data.error).toContain('fire, skull, crying, poggers, pepehands, lul');
    });

    it('returns 400 when comment exceeds 500 characters', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);

      const longComment = 'a'.repeat(501);

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: longComment }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Comment must be 500 characters or less');
    });

    it('returns 400 when neither comment nor emoji is provided', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);

      const response = await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({}),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Must provide comment or emoji');
    });

    it('accepts all valid emoji types', async () => {
      const validEmojis = ['fire', 'skull', 'crying', 'poggers', 'pepehands', 'lul'];

      for (const emoji of validEmojis) {
        const localMockDb = createMockD1();
        const localMockSessionCache = createMockKV();
        const { fetch } = createTestApp(localMockDb, localMockSessionCache);
        const user = testUsers.regular;
        const session = testSessions.valid;
        const clip = testClips.highRated;

        setupAuthenticatedSession(localMockDb, localMockSessionCache, user, session);
        localMockDb._mocks.first.mockResolvedValue(clip);
        localMockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

        const response = await fetch('/api/comments/1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `session=${session.id}`,
          },
          body: JSON.stringify({ emoji }),
        });

        expect(response.status).toBe(200);
      }
    });

    it('returns 400 for invalid clip ID', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);

      const response = await fetch('/api/comments/invalid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Test' }),
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid clip ID');
    });
  });

  describe('DELETE /api/comments/:clipId - Delete comment', () => {
    it('returns 401 when not authenticated', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const response = await fetch('/api/comments/1', {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Authentication required');
    });

    it('deletes comment successfully', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const response = await fetch('/api/comments/1', {
        method: 'DELETE',
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('deletes only the authenticated users comment', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/42', {
        method: 'DELETE',
        headers: { Cookie: `session=${session.id}` },
      });

      // Verify the delete query uses both user_id and clip_id
      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM clip_comments WHERE user_id = ? AND clip_id = ?')
      );
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(user.id, 42);
    });

    it('returns 400 for invalid clip ID', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);

      const response = await fetch('/api/comments/invalid', {
        method: 'DELETE',
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid clip ID');
    });

    it('succeeds even when no comment exists (idempotent)', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 0 } }); // No rows affected

      const response = await fetch('/api/comments/999', {
        method: 'DELETE',
        headers: { Cookie: `session=${session.id}` },
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('GET /api/comments/reactions/:clipId - Get reaction counts', () => {
    it('returns empty reactions when no reactions exist', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const response = await fetch('/api/comments/reactions/1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.reactions).toEqual({});
    });

    it('returns reaction counts grouped by emoji', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const mockReactions = [
        { emoji: 'fire', count: 5 },
        { emoji: 'skull', count: 3 },
        { emoji: 'lul', count: 10 },
      ];

      mockDb._mocks.all.mockResolvedValue({ results: mockReactions });

      const response = await fetch('/api/comments/reactions/1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.reactions).toEqual({
        fire: 5,
        skull: 3,
        lul: 10,
      });
    });

    it('only counts public reactions', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await fetch('/api/comments/reactions/42');

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('is_public = 1')
      );
    });

    it('only counts reactions with non-null emoji', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await fetch('/api/comments/reactions/42');

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('emoji IS NOT NULL')
      );
    });

    it('returns 400 for invalid clip ID', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      const response = await fetch('/api/comments/reactions/invalid');
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid clip ID');
    });
  });

  describe('Privacy Settings', () => {
    it('creates public comment by default', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Test comment' }),
      });

      // Verify is_public defaults to 1 (true)
      const bindCalls = mockDb._mocks.bind.mock.calls;
      // Find the upsert call (has 5 parameters for INSERT)
      const upsertCall = bindCalls.find((call: unknown[]) => call.length === 5);
      expect(upsertCall).toBeDefined();
      expect(upsertCall![4]).toBe(1); // is_public = 1
    });

    it('creates private comment when isPublic is false', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Private comment', isPublic: false }),
      });

      // Verify is_public is 0 (false)
      const bindCalls = mockDb._mocks.bind.mock.calls;
      const upsertCall = bindCalls.find((call: unknown[]) => call.length === 5);
      expect(upsertCall).toBeDefined();
      expect(upsertCall![4]).toBe(0); // is_public = 0
    });

    it('creates public comment when isPublic is explicitly true', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Public comment', isPublic: true }),
      });

      const bindCalls = mockDb._mocks.bind.mock.calls;
      const upsertCall = bindCalls.find((call: unknown[]) => call.length === 5);
      expect(upsertCall).toBeDefined();
      expect(upsertCall![4]).toBe(1); // is_public = 1
    });

    it('private comments are not returned in public comments list', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      // Simulate DB only returning public comments
      const publicComments = [
        {
          id: 1,
          user_id: 1,
          clip_id: 1,
          comment: 'Public comment',
          emoji: null,
          is_public: 1,
          created_at: '2024-01-15T12:00:00Z',
          updated_at: '2024-01-15T12:00:00Z',
          twitch_display_name: 'User1',
          twitch_profile_image: null,
        },
      ];

      mockDb._mocks.all.mockResolvedValue({ results: publicComments });

      const response = await fetch('/api/comments/1');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.comments).toHaveLength(1);
      // Verify the SQL query filters by is_public
      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('is_public = 1')
      );
    });
  });

  describe('Session Handling', () => {
    it('returns 401 with invalid session', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      // Don't set up a valid session in cache
      const response = await fetch('/api/comments/my/1', {
        headers: { Cookie: 'session=invalid-session-id' },
      });
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Invalid session');
    });

    it('allows unauthenticated access to public endpoints', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);

      mockDb._mocks.all.mockResolvedValue({ results: [] });

      // GET public comments - should work without auth
      const response1 = await fetch('/api/comments/1');
      expect(response1.status).toBe(200);

      // GET reactions - should work without auth
      const response2 = await fetch('/api/comments/reactions/1');
      expect(response2.status).toBe(200);
    });

    it('uses user ID from authenticated session for operations', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = createTestUser({ id: 42, twitch_username: 'specificuser' });
      const session = createTestSession({ id: 'specific-session', user_id: 42 });

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(null);

      await fetch('/api/comments/my/1', {
        headers: { Cookie: `session=${session.id}` },
      });

      // Verify user_id from session is used
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(42, 1);
    });
  });

  describe('Comment Upsert Behavior', () => {
    it('uses upsert query to handle create and update', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Test', emoji: 'fire' }),
      });

      // Verify upsert SQL pattern is used
      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO clip_comments')
      );
      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT')
      );
    });

    it('trims whitespace from comments', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: '  Trimmed comment  ' }),
      });

      const bindCalls = mockDb._mocks.bind.mock.calls;
      const upsertCall = bindCalls.find((call: unknown[]) => call.length === 5);
      expect(upsertCall).toBeDefined();
      expect(upsertCall![2]).toBe('Trimmed comment'); // comment is trimmed
    });

    it('stores null emoji when not provided', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Comment without emoji' }),
      });

      const bindCalls = mockDb._mocks.bind.mock.calls;
      const upsertCall = bindCalls.find((call: unknown[]) => call.length === 5);
      expect(upsertCall).toBeDefined();
      expect(upsertCall![3]).toBeNull(); // emoji is null
    });
  });

  describe('Activity Recording', () => {
    it('records activity for public comments', async () => {
      const { fetch } = createTestApp(mockDb, mockSessionCache);
      const user = testUsers.regular;
      const session = testSessions.valid;
      const clip = testClips.highRated;

      setupAuthenticatedSession(mockDb, mockSessionCache, user, session);
      mockDb._mocks.first.mockResolvedValue(clip);
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await fetch('/api/comments/1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${session.id}`,
        },
        body: JSON.stringify({ comment: 'Public comment', isPublic: true }),
      });

      // Verify activity recording was called (INSERT INTO activity_feed)
      const prepareCalls = mockDb._mocks.prepare.mock.calls;
      const hasActivityInsert = prepareCalls.some(
        (call: string[]) => call[0].includes('INSERT INTO activity_feed')
      );
      expect(hasActivityInsert).toBe(true);
    });
  });
});

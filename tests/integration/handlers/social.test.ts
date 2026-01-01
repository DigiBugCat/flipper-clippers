import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import social from '../../../src/handlers/social';
import { createMockKV } from '../../setup/mocks/kv';
import { testUsers } from '../../fixtures/users';
import type { Env } from '../../../src/types';

// Mock the getCachedSession function from auth
vi.mock('../../../src/handlers/auth', () => ({
  getCachedSession: vi.fn(),
}));

import { getCachedSession } from '../../../src/handlers/auth';

// Mock the social service
vi.mock('../../../src/services/social', () => ({
  getTasteCompatibility: vi.fn(),
  findSimilarUsers: vi.fn(),
  getPublicProfile: vi.fn(),
  getUserTopClips: vi.fn(),
}));

import {
  getTasteCompatibility,
  findSimilarUsers,
  getPublicProfile,
  getUserTopClips,
} from '../../../src/services/social';

// Helper to create a mock environment
function createMockEnv() {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: vi.fn(),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn(),
        }),
      }),
      batch: vi.fn(),
    },
    SESSION_CACHE: createMockKV(),
    THUMBNAIL_CACHE: createMockKV(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
  };
}

// Helper to create test app with social routes
function createTestApp(env: ReturnType<typeof createMockEnv>) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/social', social);
  return app;
}

// Helper to create a mock request with cookies
function createRequestWithCookie(url: string, cookieName: string, cookieValue: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', `${cookieName}=${cookieValue}`);
  return new Request(url, { ...options, headers });
}

describe('Social Handler Integration Tests', () => {
  const testUser = testUsers.regular;
  const otherUser = { ...testUsers.regular, id: 2, twitch_username: 'otheruser' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/social/compatibility/:userId', () => {
    it('should require authentication', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/compatibility/2');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Authentication required');
    });

    it('should reject invalid user ID', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/compatibility/invalid',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Invalid user ID');
    });

    it('should reject comparing with self', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        `https://example.com/api/social/compatibility/${testUser.id}`,
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Invalid user ID');
    });

    it('should reject when target user profile is private', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(getPublicProfile).mockResolvedValue({
        user: null,
        isPublic: false,
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/compatibility/2',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(403);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('User profile is private');
    });

    it('should return compatibility score for valid public user', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(getPublicProfile).mockResolvedValue({
        user: {
          id: 2,
          displayName: 'OtherUser',
          profileImage: 'https://example.com/avatar.jpg',
          totalComparisons: 100,
        },
        isPublic: true,
      });

      vi.mocked(getTasteCompatibility).mockResolvedValue({
        score: 75,
        sharedClips: 15,
        cached: false,
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/compatibility/2',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        userId: number;
        compatibilityScore: number;
        sharedClips: number;
        cached: boolean;
      }>();
      expect(data.userId).toBe(2);
      expect(data.compatibilityScore).toBe(75);
      expect(data.sharedClips).toBe(15);
      expect(data.cached).toBe(false);
    });
  });

  describe('GET /api/social/similar', () => {
    it('should require authentication', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/similar');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return similar users with default limit', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(findSimilarUsers).mockResolvedValue([
        { user_id: 2, display_name: 'User2', profile_image: 'https://example.com/2.jpg', compatibility_score: 85, shared_clips: 20 },
        { user_id: 3, display_name: 'User3', profile_image: 'https://example.com/3.jpg', compatibility_score: 72, shared_clips: 15 },
      ]);

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/similar',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        users: Array<{
          userId: number;
          displayName: string;
          profileImage: string;
          compatibilityScore: number;
          sharedClips: number;
        }>;
      }>();
      expect(data.users).toHaveLength(2);
      expect(data.users[0].userId).toBe(2);
      expect(data.users[0].compatibilityScore).toBe(85);
      expect(data.users[1].displayName).toBe('User3');
    });

    it('should respect limit parameter', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(findSimilarUsers).mockResolvedValue([]);

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/similar?limit=5',
        'session',
        'valid-session-id'
      );
      await app.fetch(req, mockEnv);

      expect(findSimilarUsers).toHaveBeenCalledWith(expect.anything(), testUser.id, 5);
    });

    it('should cap limit at 50', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(findSimilarUsers).mockResolvedValue([]);

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/similar?limit=100',
        'session',
        'valid-session-id'
      );
      await app.fetch(req, mockEnv);

      expect(findSimilarUsers).toHaveBeenCalledWith(expect.anything(), testUser.id, 50);
    });
  });

  describe('GET /api/social/profile/:userId', () => {
    it('should allow unauthenticated access to public profiles', async () => {
      vi.mocked(getPublicProfile).mockResolvedValue({
        user: {
          id: 2,
          displayName: 'PublicUser',
          profileImage: 'https://example.com/avatar.jpg',
          totalComparisons: 100,
        },
        isPublic: true,
      });

      vi.mocked(getUserTopClips).mockResolvedValue([
        { id: 1, twitchSlug: 'clip1', title: 'Cool Clip', userElo: 1600 },
      ]);

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/profile/2');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        profile: { id: number; displayName: string; totalComparisons: number };
        topClips: Array<{ id: number; title: string; userElo: number }>;
        compatibility: null;
      }>();
      expect(data.profile.displayName).toBe('PublicUser');
      expect(data.topClips).toHaveLength(1);
      expect(data.compatibility).toBeNull();
    });

    it('should return 404 for private profiles', async () => {
      vi.mocked(getPublicProfile).mockResolvedValue({
        user: null,
        isPublic: false,
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/profile/2');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('User profile is private');
    });

    it('should return 404 for non-existent users with public profile setting', async () => {
      vi.mocked(getPublicProfile).mockResolvedValue({
        user: null,
        isPublic: true,
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/profile/999');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('User not found');
    });

    it('should include compatibility when authenticated and viewing another user', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(getPublicProfile).mockResolvedValue({
        user: {
          id: 2,
          displayName: 'OtherUser',
          profileImage: 'https://example.com/avatar.jpg',
          totalComparisons: 100,
        },
        isPublic: true,
      });

      vi.mocked(getUserTopClips).mockResolvedValue([]);

      vi.mocked(getTasteCompatibility).mockResolvedValue({
        score: 68,
        sharedClips: 12,
        cached: true,
      });

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        'https://example.com/api/social/profile/2',
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{
        compatibility: { score: number; sharedClips: number } | null;
      }>();
      expect(data.compatibility).not.toBeNull();
      expect(data.compatibility?.score).toBe(68);
      expect(data.compatibility?.sharedClips).toBe(12);
    });

    it('should not include compatibility when viewing own profile', async () => {
      vi.mocked(getCachedSession).mockResolvedValue({
        user: testUser,
        session: { id: 'session-id', user_id: testUser.id, expires_at: '2099-01-01', created_at: '2024-01-01' },
      });

      vi.mocked(getPublicProfile).mockResolvedValue({
        user: {
          id: testUser.id,
          displayName: testUser.twitch_display_name || testUser.twitch_username,
          profileImage: testUser.twitch_profile_image || '',
          totalComparisons: testUser.total_comparisons,
        },
        isPublic: true,
      });

      vi.mocked(getUserTopClips).mockResolvedValue([]);

      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = createRequestWithCookie(
        `https://example.com/api/social/profile/${testUser.id}`,
        'session',
        'valid-session-id'
      );
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json<{ compatibility: null }>();
      expect(data.compatibility).toBeNull();
      expect(getTasteCompatibility).not.toHaveBeenCalled();
    });

    it('should reject invalid user ID', async () => {
      const mockEnv = createMockEnv();
      const app = createTestApp(mockEnv);

      const req = new Request('https://example.com/api/social/profile/invalid');
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe('Invalid user ID');
    });
  });
});

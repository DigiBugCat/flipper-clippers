import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordActivity,
  getGlobalFeed,
  getUserActivityHistory,
  getTrendingClips,
  isUserProfilePublic,
  type ActivityWithUser,
  type TrendingClipResult,
} from '../../../src/services/feed';
import type { ActivityType } from '../../../src/types';

/**
 * Create a mock D1 database with configurable behavior
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

describe('Feed Service', () => {
  let mockDb: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockD1();
  });

  describe('recordActivity', () => {
    it('inserts activity with correct fields', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'vote' as ActivityType,
        42,
        'Test Clip Title',
        { winner: 'clip_a' },
        true
      );

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO activity_feed')
      );
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(
        1, // user_id
        'vote', // activity_type
        42, // clip_id
        'Test Clip Title', // clip_title
        '{"winner":"clip_a"}', // extra_data (JSON stringified)
        1 // is_public (true = 1)
      );
      expect(mockDb._mocks.run).toHaveBeenCalled();
    });

    it('handles null extra_data correctly', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'super_like' as ActivityType,
        42,
        'Test Clip',
        null,
        true
      );

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(
        1,
        'super_like',
        42,
        'Test Clip',
        null, // extra_data should be null, not "null"
        1
      );
    });

    it('handles null clip_title correctly', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'comment' as ActivityType,
        42,
        null,
        { comment: 'Great clip!' },
        true
      );

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(
        1,
        'comment',
        42,
        null,
        '{"comment":"Great clip!"}',
        1
      );
    });

    it('respects isPublic flag when true', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'vote' as ActivityType,
        42,
        'Test Clip',
        null,
        true
      );

      // Verify is_public is set to 1
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(
        1, // user_id
        'vote', // activity_type
        42, // clip_id
        'Test Clip', // clip_title
        null, // extra_data
        1 // is_public = true = 1
      );
    });

    it('respects isPublic flag when false', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'save' as ActivityType,
        42,
        'Test Clip',
        null,
        false
      );

      // Verify is_public is set to 0
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(
        1, // user_id
        'save', // activity_type
        42, // clip_id
        'Test Clip', // clip_title
        null, // extra_data
        0 // is_public = false = 0
      );
    });

    it('handles all activity types', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

      const activityTypes: ActivityType[] = ['vote', 'super_like', 'comment', 'save'];

      for (const activityType of activityTypes) {
        await recordActivity(
          mockDb as unknown as D1Database,
          1,
          activityType,
          42,
          'Test Clip',
          null,
          true
        );

        expect(mockDb._mocks.bind).toHaveBeenLastCalledWith(
          1,
          activityType,
          42,
          'Test Clip',
          null,
          1
        );
      }
    });
  });

  describe('getGlobalFeed', () => {
    const mockActivities: ActivityWithUser[] = [
      {
        id: 1,
        user_id: 1,
        activity_type: 'vote',
        clip_id: 42,
        clip_title: 'Test Clip 1',
        extra_data: null,
        is_public: 1,
        created_at: '2024-01-15T12:00:00Z',
        user_display_name: 'TestUser1',
        user_profile_image: 'https://example.com/avatar1.png',
        clip_slug: 'TestClipSlug1',
      },
      {
        id: 2,
        user_id: 2,
        activity_type: 'super_like',
        clip_id: 43,
        clip_title: 'Test Clip 2',
        extra_data: null,
        is_public: 1,
        created_at: '2024-01-15T11:00:00Z',
        user_display_name: 'TestUser2',
        user_profile_image: 'https://example.com/avatar2.png',
        clip_slug: 'TestClipSlug2',
      },
    ];

    it('returns only public activities', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockActivities });

      const result = await getGlobalFeed(mockDb as unknown as D1Database);

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE af.is_public = 1')
      );
      expect(result).toEqual(mockActivities);
    });

    it('orders by created_at DESC', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockActivities });

      await getGlobalFeed(mockDb as unknown as D1Database);

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY af.created_at DESC')
      );
    });

    it('respects default limit of 50', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getGlobalFeed(mockDb as unknown as D1Database);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(50, 0);
    });

    it('respects custom limit parameter', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getGlobalFeed(mockDb as unknown as D1Database, 25);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(25, 0);
    });

    it('respects custom offset parameter', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getGlobalFeed(mockDb as unknown as D1Database, 50, 100);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(50, 100);
    });

    it('respects both limit and offset parameters', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getGlobalFeed(mockDb as unknown as D1Database, 10, 20);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(10, 20);
    });

    it('joins with users and clips tables', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockActivities });

      await getGlobalFeed(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('JOIN users u ON af.user_id = u.id');
      expect(query).toContain('LEFT JOIN clips c ON af.clip_id = c.id');
    });

    it('selects user display name and profile image', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockActivities });

      await getGlobalFeed(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('u.twitch_display_name as user_display_name');
      expect(query).toContain('u.twitch_profile_image as user_profile_image');
    });

    it('returns empty array when no activities', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const result = await getGlobalFeed(mockDb as unknown as D1Database);

      expect(result).toEqual([]);
    });
  });

  describe('getUserActivityHistory', () => {
    const mockUserActivities: ActivityWithUser[] = [
      {
        id: 1,
        user_id: 5,
        activity_type: 'vote',
        clip_id: 42,
        clip_title: 'User Clip 1',
        extra_data: null,
        is_public: 1,
        created_at: '2024-01-15T12:00:00Z',
        user_display_name: 'TestUser',
        user_profile_image: 'https://example.com/avatar.png',
        clip_slug: 'UserClipSlug1',
      },
      {
        id: 2,
        user_id: 5,
        activity_type: 'save',
        clip_id: 43,
        clip_title: 'User Clip 2',
        extra_data: null,
        is_public: 0, // Private activity
        created_at: '2024-01-15T11:00:00Z',
        user_display_name: 'TestUser',
        user_profile_image: 'https://example.com/avatar.png',
        clip_slug: 'UserClipSlug2',
      },
    ];

    it('returns all user activities including private', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockUserActivities });

      const result = await getUserActivityHistory(mockDb as unknown as D1Database, 5);

      // Should not filter by is_public
      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE af.user_id = ?')
      );
      expect(result).toEqual(mockUserActivities);
      expect(result.length).toBe(2);
    });

    it('filters by user_id', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(5, 50, 0);
    });

    it('orders by created_at DESC', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5);

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY af.created_at DESC')
      );
    });

    it('respects default limit of 50', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(5, 50, 0);
    });

    it('respects custom limit parameter', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5, 25);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(5, 25, 0);
    });

    it('respects custom offset parameter', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5, 50, 100);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(5, 50, 100);
    });

    it('returns empty array when user has no activities', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const result = await getUserActivityHistory(mockDb as unknown as D1Database, 999);

      expect(result).toEqual([]);
    });
  });

  describe('getTrendingClips', () => {
    const mockTrendingClips: TrendingClipResult[] = [
      {
        clip_id: 1,
        twitch_slug: 'TrendingClip1',
        title: 'Hot Trending Clip',
        global_elo: 1800,
        vote_count: 50,
        super_like_count: 10,
      },
      {
        clip_id: 2,
        twitch_slug: 'TrendingClip2',
        title: 'Another Trending Clip',
        global_elo: 1700,
        vote_count: 40,
        super_like_count: 8,
      },
    ];

    it('calculates 24h period correctly', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database, '24h');

      // 24 hours
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(24, 10);
    });

    it('calculates 7d period correctly', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database, '7d');

      // 7 days = 168 hours
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(168, 10);
    });

    it('calculates 30d period correctly', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database, '30d');

      // 30 days = 720 hours
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(720, 10);
    });

    it('defaults to 24h period when not specified', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(24, 10);
    });

    it('respects default limit of 10', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getTrendingClips(mockDb as unknown as D1Database);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(24, 10);
    });

    it('respects custom limit parameter', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getTrendingClips(mockDb as unknown as D1Database, '24h', 5);

      expect(mockDb._mocks.bind).toHaveBeenCalledWith(24, 5);
    });

    it('filters by vote and super_like activity types', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain("af.activity_type IN ('vote', 'super_like')");
    });

    it('only includes active clips', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('c.is_active = 1');
    });

    it('orders by vote_count DESC, then super_like_count DESC', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('ORDER BY vote_count DESC, super_like_count DESC');
    });

    it('groups by clip id', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      await getTrendingClips(mockDb as unknown as D1Database);

      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('GROUP BY c.id');
    });

    it('returns trending clips with correct structure', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: mockTrendingClips });

      const result = await getTrendingClips(mockDb as unknown as D1Database, '24h', 10);

      expect(result).toEqual(mockTrendingClips);
      expect(result[0]).toHaveProperty('clip_id');
      expect(result[0]).toHaveProperty('twitch_slug');
      expect(result[0]).toHaveProperty('title');
      expect(result[0]).toHaveProperty('global_elo');
      expect(result[0]).toHaveProperty('vote_count');
      expect(result[0]).toHaveProperty('super_like_count');
    });

    it('returns empty array when no trending clips', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      const result = await getTrendingClips(mockDb as unknown as D1Database);

      expect(result).toEqual([]);
    });
  });

  describe('isUserProfilePublic', () => {
    it('returns true when user profile is public', async () => {
      mockDb._mocks.first.mockResolvedValue({ is_profile_public: 1 });

      const result = await isUserProfilePublic(mockDb as unknown as D1Database, 1);

      expect(result).toBe(true);
    });

    it('returns false when user profile is private', async () => {
      mockDb._mocks.first.mockResolvedValue({ is_profile_public: 0 });

      const result = await isUserProfilePublic(mockDb as unknown as D1Database, 1);

      expect(result).toBe(false);
    });

    it('returns false when user is not found', async () => {
      mockDb._mocks.first.mockResolvedValue(null);

      const result = await isUserProfilePublic(mockDb as unknown as D1Database, 999);

      expect(result).toBe(false);
    });

    it('queries the correct user by id', async () => {
      mockDb._mocks.first.mockResolvedValue({ is_profile_public: 1 });

      await isUserProfilePublic(mockDb as unknown as D1Database, 42);

      expect(mockDb._mocks.prepare).toHaveBeenCalledWith(
        'SELECT is_profile_public FROM users WHERE id = ?'
      );
      expect(mockDb._mocks.bind).toHaveBeenCalledWith(42);
    });
  });

  describe('Privacy checks', () => {
    it('getGlobalFeed does not expose private activities', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getGlobalFeed(mockDb as unknown as D1Database);

      // The SQL query should filter by is_public = 1
      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).toContain('WHERE af.is_public = 1');
    });

    it('getUserActivityHistory includes private activities for the user', async () => {
      mockDb._mocks.all.mockResolvedValue({ results: [] });

      await getUserActivityHistory(mockDb as unknown as D1Database, 5);

      // The SQL query should NOT filter by is_public
      const query = mockDb._mocks.prepare.mock.calls[0][0];
      expect(query).not.toContain('is_public = 1');
      expect(query).toContain('WHERE af.user_id = ?');
    });

    it('recordActivity correctly stores public activity', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'vote' as ActivityType,
        42,
        'Test Clip',
        null,
        true
      );

      // Last parameter should be 1 for public
      const bindArgs = mockDb._mocks.bind.mock.calls[0];
      expect(bindArgs[bindArgs.length - 1]).toBe(1);
    });

    it('recordActivity correctly stores private activity', async () => {
      mockDb._mocks.run.mockResolvedValue({ success: true });

      await recordActivity(
        mockDb as unknown as D1Database,
        1,
        'save' as ActivityType,
        42,
        'Test Clip',
        null,
        false
      );

      // Last parameter should be 0 for private
      const bindArgs = mockDb._mocks.bind.mock.calls[0];
      expect(bindArgs[bindArgs.length - 1]).toBe(0);
    });
  });
});

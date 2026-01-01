import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncRecentClips } from '../../../src/services/clipSync';

// Mock the db queries
vi.mock('../../../src/db/queries', () => ({
  getClipBySlug: vi.fn(),
  createClipWithMetadata: vi.fn(),
}));

import { getClipBySlug, createClipWithMetadata } from '../../../src/db/queries';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to create mock D1 database
function createMockD1() {
  return {} as D1Database;
}

// Sample Twitch clip data
const mockClipData = {
  id: 'TestClipSlug123',
  url: 'https://clips.twitch.tv/TestClipSlug123',
  embed_url: 'https://clips.twitch.tv/embed?clip=TestClipSlug123',
  broadcaster_id: '76024422',
  broadcaster_name: 'arross',
  creator_id: '12345',
  creator_name: 'testcreator',
  title: 'Amazing Clip Title',
  created_at: '2024-01-01T12:00:00Z',
  thumbnail_url: 'https://clips-media.twitch.tv/thumb.jpg',
  duration: 30,
};

describe('clipSync service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('syncRecentClips', () => {
    it('should fetch and add new clips from Twitch', async () => {
      // Mock token response
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'test-token',
              expires_in: 3600,
              token_type: 'bearer',
            }),
          };
        }
        if (url.includes('helix/clips')) {
          return {
            ok: true,
            json: async () => ({
              data: [mockClipData],
              pagination: {},
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // Mock clip doesn't exist
      vi.mocked(getClipBySlug).mockResolvedValue(null);
      vi.mocked(createClipWithMetadata).mockResolvedValue(undefined);

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify createClipWithMetadata was called
      expect(createClipWithMetadata).toHaveBeenCalledWith(
        db,
        'TestClipSlug123',
        'Amazing Clip Title',
        'https://clips.twitch.tv/TestClipSlug123',
        'testcreator',
        null
      );
    });

    it('should skip existing clips', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          return {
            ok: true,
            json: async () => ({
              data: [mockClipData],
              pagination: {},
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // Mock clip already exists
      vi.mocked(getClipBySlug).mockResolvedValue({ id: 1, twitch_slug: 'TestClipSlug123' } as any);

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);

      // createClipWithMetadata should not be called
      expect(createClipWithMetadata).not.toHaveBeenCalled();
    });

    it('should handle token fetch failure', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return { ok: false, status: 401 };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const db = createMockD1();
      const result = await syncRecentClips(db, 'invalid-id', 'invalid-secret');

      expect(result.added).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Token error');
    });

    it('should handle Twitch API failure', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          return { ok: false, status: 500 };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Twitch API error');
    });

    it('should handle pagination', async () => {
      let pageCount = 0;
      const clip1 = { ...mockClipData, id: 'Clip1' };
      const clip2 = { ...mockClipData, id: 'Clip2' };

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          pageCount++;
          if (pageCount === 1) {
            return {
              ok: true,
              json: async () => ({
                data: [clip1],
                pagination: { cursor: 'next-page' },
              }),
            };
          }
          // Second page
          return {
            ok: true,
            json: async () => ({
              data: [clip2],
              pagination: {}, // No more pages
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      vi.mocked(getClipBySlug).mockResolvedValue(null);
      vi.mocked(createClipWithMetadata).mockResolvedValue(undefined);

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(2);
      expect(pageCount).toBe(2);
    });

    it('should handle individual clip errors gracefully', async () => {
      const clip1 = { ...mockClipData, id: 'Clip1' };
      const clip2 = { ...mockClipData, id: 'Clip2' };

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          return {
            ok: true,
            json: async () => ({
              data: [clip1, clip2],
              pagination: {},
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      // First clip fails, second succeeds
      vi.mocked(getClipBySlug)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.mocked(createClipWithMetadata)
        .mockRejectedValueOnce(new Error('DB constraint error'))
        .mockResolvedValueOnce(undefined);

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Clip1');
    });

    it('should handle empty clip response', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          return {
            ok: true,
            json: async () => ({
              data: [],
              pagination: {},
            }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const db = createMockD1();
      const result = await syncRecentClips(db, 'client-id', 'client-secret');

      expect(result.added).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass correct date range to Twitch API', async () => {
      let capturedUrl: string | null = null;

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          capturedUrl = url;
          return {
            ok: true,
            json: async () => ({ data: [], pagination: {} }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const db = createMockD1();
      await syncRecentClips(db, 'client-id', 'client-secret');

      expect(capturedUrl).not.toBeNull();
      expect(capturedUrl).toContain('broadcaster_id=76024422');
      expect(capturedUrl).toContain('started_at=');
      expect(capturedUrl).toContain('ended_at=');
      expect(capturedUrl).toContain('first=100');
    });

    it('should use correct auth headers for Twitch API', async () => {
      let capturedHeaders: Headers | null = null;

      mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
        if (url.includes('oauth2/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'my-access-token', expires_in: 3600, token_type: 'bearer' }),
          };
        }
        if (url.includes('helix/clips')) {
          capturedHeaders = new Headers(options?.headers);
          return {
            ok: true,
            json: async () => ({ data: [], pagination: {} }),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const db = createMockD1();
      await syncRecentClips(db, 'my-client-id', 'client-secret');

      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders?.get('Authorization')).toBe('Bearer my-access-token');
      expect(capturedHeaders?.get('Client-Id')).toBe('my-client-id');
    });
  });
});

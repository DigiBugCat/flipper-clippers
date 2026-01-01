/**
 * Mock fetch for Twitch API testing
 */
import { vi } from 'vitest';

// Mock response fixtures
export const mockTwitchTokenResponse = {
  access_token: 'mock-access-token-12345',
  expires_in: 3600,
  token_type: 'bearer',
};

export const mockTwitchClip = {
  id: 'MockClipId123',
  url: 'https://clips.twitch.tv/MockClipId123',
  embed_url: 'https://clips.twitch.tv/embed?clip=MockClipId123',
  broadcaster_id: '12345',
  broadcaster_name: 'MockStreamer',
  creator_id: '67890',
  creator_name: 'MockCreator',
  video_id: 'v987654321',
  game_id: '33214',
  language: 'en',
  title: 'Amazing Mock Clip',
  view_count: 1000,
  created_at: '2024-01-15T12:00:00Z',
  thumbnail_url: 'https://clips-media-assets2.twitch.tv/mock-thumb.jpg',
  duration: 30,
  vod_offset: 3600,
};

export const mockTwitchUser = {
  id: '12345',
  login: 'mockstreamer',
  display_name: 'MockStreamer',
  type: '',
  broadcaster_type: 'partner',
  description: 'Mock streamer for testing',
  profile_image_url: 'https://static-cdn.jtvnw.net/mock-profile.png',
  offline_image_url: 'https://static-cdn.jtvnw.net/mock-offline.png',
  view_count: 100000,
  created_at: '2020-01-01T00:00:00Z',
};

// Additional mock clips for batch testing
export const mockTwitchClips = [
  mockTwitchClip,
  {
    ...mockTwitchClip,
    id: 'MockClipId456',
    title: 'Second Mock Clip',
    view_count: 500,
  },
  {
    ...mockTwitchClip,
    id: 'MockClipId789',
    title: 'Third Mock Clip',
    view_count: 2000,
  },
];

// Additional mock users for batch testing
export const mockTwitchUsers = [
  mockTwitchUser,
  {
    ...mockTwitchUser,
    id: '67890',
    login: 'anothermock',
    display_name: 'AnotherMock',
  },
];

interface FetchMockConfig {
  tokenResponse?: typeof mockTwitchTokenResponse;
  clipsResponse?: typeof mockTwitchClip | typeof mockTwitchClips;
  usersResponse?: typeof mockTwitchUser | typeof mockTwitchUsers;
  shouldFail?: boolean;
  failureStatus?: number;
  failureMessage?: string;
}

export function setupTwitchMocks(config: FetchMockConfig = {}) {
  const {
    tokenResponse = mockTwitchTokenResponse,
    clipsResponse = mockTwitchClip,
    usersResponse = mockTwitchUser,
    shouldFail = false,
    failureStatus = 500,
    failureMessage = 'Internal Server Error',
  } = config;

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (shouldFail) {
      return new Response(JSON.stringify({ error: failureMessage }), {
        status: failureStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Twitch OAuth token endpoint
    if (url.includes('id.twitch.tv/oauth2/token')) {
      return new Response(JSON.stringify(tokenResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Twitch clips API
    if (url.includes('api.twitch.tv/helix/clips')) {
      const clips = Array.isArray(clipsResponse) ? clipsResponse : [clipsResponse];
      return new Response(JSON.stringify({ data: clips }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Twitch users API
    if (url.includes('api.twitch.tv/helix/users')) {
      const users = Array.isArray(usersResponse) ? usersResponse : [usersResponse];
      return new Response(JSON.stringify({ data: users }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default: return 404 for unhandled URLs
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', mockFetch);

  return mockFetch;
}

export function resetTwitchMocks() {
  vi.unstubAllGlobals();
}

// Helper to create custom mock responses
export function createMockClip(overrides: Partial<typeof mockTwitchClip> = {}) {
  return { ...mockTwitchClip, ...overrides };
}

export function createMockUser(overrides: Partial<typeof mockTwitchUser> = {}) {
  return { ...mockTwitchUser, ...overrides };
}

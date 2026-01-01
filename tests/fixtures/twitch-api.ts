import type { TwitchTokenResponse, TwitchUser } from '../../src/types';

/**
 * Mock Twitch API token response
 */
export const mockTwitchTokenResponse: TwitchTokenResponse = {
  access_token: 'mock_access_token_abc123',
  refresh_token: 'mock_refresh_token_xyz789',
  expires_in: 14400, // 4 hours
  scope: ['user:read:email'],
  token_type: 'bearer',
};

/**
 * Mock Twitch API clip data (raw API response format)
 */
export const mockTwitchClipData = {
  id: 'MockClipSlug123',
  url: 'https://clips.twitch.tv/MockClipSlug123',
  embed_url: 'https://clips.twitch.tv/embed?clip=MockClipSlug123',
  broadcaster_id: '12345',
  broadcaster_name: 'MockBroadcaster',
  creator_id: '67890',
  creator_name: 'MockCreator',
  video_id: 'v123456789',
  game_id: '12345',
  language: 'en',
  title: 'Mock Clip Title',
  view_count: 1000,
  created_at: '2024-01-15T12:00:00Z',
  thumbnail_url: 'https://clips-media-assets2.twitch.tv/mock-thumbnail.jpg',
  duration: 30,
  vod_offset: 3600,
};

/**
 * Mock Twitch API user data
 */
export const mockTwitchUserData: TwitchUser = {
  id: '12345678',
  login: 'mockuser',
  display_name: 'MockUser',
  profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/mock-profile.png',
};

/**
 * Mock Twitch API clips list response (paginated)
 */
export const mockTwitchClipsListResponse = {
  data: [
    {
      id: 'ClipSlug001',
      url: 'https://clips.twitch.tv/ClipSlug001',
      embed_url: 'https://clips.twitch.tv/embed?clip=ClipSlug001',
      broadcaster_id: '12345',
      broadcaster_name: 'TestBroadcaster',
      creator_id: '11111',
      creator_name: 'Clipper1',
      video_id: 'v111111111',
      game_id: '12345',
      language: 'en',
      title: 'First Clip',
      view_count: 500,
      created_at: '2024-01-10T10:00:00Z',
      thumbnail_url: 'https://clips-media-assets2.twitch.tv/clip001-thumbnail.jpg',
      duration: 25,
      vod_offset: 1800,
    },
    {
      id: 'ClipSlug002',
      url: 'https://clips.twitch.tv/ClipSlug002',
      embed_url: 'https://clips.twitch.tv/embed?clip=ClipSlug002',
      broadcaster_id: '12345',
      broadcaster_name: 'TestBroadcaster',
      creator_id: '22222',
      creator_name: 'Clipper2',
      video_id: 'v222222222',
      game_id: '12345',
      language: 'en',
      title: 'Second Clip',
      view_count: 1500,
      created_at: '2024-01-11T14:30:00Z',
      thumbnail_url: 'https://clips-media-assets2.twitch.tv/clip002-thumbnail.jpg',
      duration: 30,
      vod_offset: 3600,
    },
    {
      id: 'ClipSlug003',
      url: 'https://clips.twitch.tv/ClipSlug003',
      embed_url: 'https://clips.twitch.tv/embed?clip=ClipSlug003',
      broadcaster_id: '12345',
      broadcaster_name: 'TestBroadcaster',
      creator_id: '33333',
      creator_name: 'Clipper3',
      video_id: 'v333333333',
      game_id: '12345',
      language: 'en',
      title: 'Third Clip',
      view_count: 2500,
      created_at: '2024-01-12T18:45:00Z',
      thumbnail_url: 'https://clips-media-assets2.twitch.tv/clip003-thumbnail.jpg',
      duration: 20,
      vod_offset: 7200,
    },
  ],
  pagination: {
    cursor: 'eyJiIjpudWxsLCJhIjp7IkN1cnNvciI6Ik1UQXdNREF3TURBd01EQXdNREF3TURBd01ERT0ifX0',
  },
};

/**
 * Helper to create a mock Twitch user with overrides
 */
export function createMockTwitchUser(overrides: Partial<TwitchUser> = {}): TwitchUser {
  return {
    ...mockTwitchUserData,
    ...overrides,
  };
}

/**
 * Helper to create a mock Twitch clip with overrides
 */
export function createMockTwitchClip(overrides: Partial<typeof mockTwitchClipData> = {}) {
  return {
    ...mockTwitchClipData,
    ...overrides,
  };
}

/**
 * Helper to create a mock Twitch token response with overrides
 */
export function createMockTwitchTokenResponse(overrides: Partial<TwitchTokenResponse> = {}): TwitchTokenResponse {
  return {
    ...mockTwitchTokenResponse,
    ...overrides,
  };
}

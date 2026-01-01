import type { Clip } from '../../src/types';

/**
 * Factory function to create test clips with optional overrides
 */
export function createTestClip(overrides: Partial<Clip> = {}): Clip {
  const now = new Date().toISOString();
  return {
    id: 1,
    twitch_slug: 'TestClipSlug123',
    title: 'Test Clip Title',
    clipped_by: 'clipper_username',
    twitch_url: 'https://clips.twitch.tv/TestClipSlug123',
    clipped_at: now,
    created_at: now,
    is_active: 1,
    global_elo: 1500,
    global_matches: 0,
    global_wins: 0,
    global_losses: 0,
    global_ties: 0,
    global_super_likes: 0,
    rating_deviation: 350,
    last_rated_at: null,
    ...overrides,
  };
}

/**
 * Pre-defined test clips for common test scenarios
 */
export const testClips = {
  /** High rated clip (ELO 1800) */
  highRated: createTestClip({
    id: 1,
    twitch_slug: 'HighRatedClipSlug',
    title: 'Amazing High Rated Clip',
    clipped_by: 'pro_clipper',
    twitch_url: 'https://clips.twitch.tv/HighRatedClipSlug',
    global_elo: 1800,
    global_matches: 100,
    global_wins: 75,
    global_losses: 20,
    global_ties: 5,
    global_super_likes: 25,
    rating_deviation: 50,
    last_rated_at: new Date().toISOString(),
  }),

  /** Medium rated clip (ELO 1500) */
  mediumRated: createTestClip({
    id: 2,
    twitch_slug: 'MediumRatedClipSlug',
    title: 'Average Medium Rated Clip',
    clipped_by: 'average_clipper',
    twitch_url: 'https://clips.twitch.tv/MediumRatedClipSlug',
    global_elo: 1500,
    global_matches: 50,
    global_wins: 25,
    global_losses: 20,
    global_ties: 5,
    global_super_likes: 10,
    rating_deviation: 100,
    last_rated_at: new Date().toISOString(),
  }),

  /** Low rated clip (ELO 1200) */
  lowRated: createTestClip({
    id: 3,
    twitch_slug: 'LowRatedClipSlug',
    title: 'Low Rated Clip',
    clipped_by: 'casual_clipper',
    twitch_url: 'https://clips.twitch.tv/LowRatedClipSlug',
    global_elo: 1200,
    global_matches: 80,
    global_wins: 20,
    global_losses: 55,
    global_ties: 5,
    global_super_likes: 2,
    rating_deviation: 75,
    last_rated_at: new Date().toISOString(),
  }),

  /** New clip with 0 matches */
  newClip: createTestClip({
    id: 4,
    twitch_slug: 'NewClipSlug',
    title: 'Brand New Clip',
    clipped_by: 'new_clipper',
    twitch_url: 'https://clips.twitch.tv/NewClipSlug',
    global_elo: 1500,
    global_matches: 0,
    global_wins: 0,
    global_losses: 0,
    global_ties: 0,
    global_super_likes: 0,
    rating_deviation: 350,
    last_rated_at: null,
  }),

  /** Inactive clip */
  inactive: createTestClip({
    id: 5,
    twitch_slug: 'InactiveClipSlug',
    title: 'Inactive Clip',
    clipped_by: 'old_clipper',
    twitch_url: 'https://clips.twitch.tv/InactiveClipSlug',
    is_active: 0,
    global_elo: 1400,
    global_matches: 30,
    global_wins: 10,
    global_losses: 18,
    global_ties: 2,
    global_super_likes: 1,
    rating_deviation: 150,
    last_rated_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
  }),
};

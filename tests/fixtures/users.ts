import type { User } from '../../src/types';

/**
 * Factory function to create test users with optional overrides
 */
export function createTestUser(overrides: Partial<User> = {}): User {
  const now = new Date().toISOString();
  return {
    id: 1,
    twitch_id: '12345678',
    twitch_username: 'testuser',
    twitch_display_name: 'TestUser',
    twitch_profile_image: 'https://static-cdn.jtvnw.net/user-default-pictures-uv/12345.png',
    created_at: now,
    last_login: now,
    total_comparisons: 0,
    total_super_likes: 0,
    is_profile_public: 1,
    ...overrides,
  };
}

/**
 * Pre-defined test users for common test scenarios
 */
export const testUsers = {
  /** Regular user with default settings */
  regular: createTestUser({
    id: 1,
    twitch_id: '11111111',
    twitch_username: 'regularuser',
    twitch_display_name: 'RegularUser',
    total_comparisons: 50,
    total_super_likes: 5,
    is_profile_public: 1,
  }),

  /** Admin user (username 'arross') */
  admin: createTestUser({
    id: 2,
    twitch_id: '22222222',
    twitch_username: 'arross',
    twitch_display_name: 'Arross',
    total_comparisons: 500,
    total_super_likes: 50,
    is_profile_public: 1,
  }),

  /** User with private profile */
  private: createTestUser({
    id: 3,
    twitch_id: '33333333',
    twitch_username: 'privateuser',
    twitch_display_name: 'PrivateUser',
    total_comparisons: 100,
    total_super_likes: 10,
    is_profile_public: 0,
  }),

  /** New user with no activity */
  newUser: createTestUser({
    id: 4,
    twitch_id: '44444444',
    twitch_username: 'newuser',
    twitch_display_name: 'NewUser',
    total_comparisons: 0,
    total_super_likes: 0,
    is_profile_public: 1,
  }),

  /** Power user with high activity */
  powerUser: createTestUser({
    id: 5,
    twitch_id: '55555555',
    twitch_username: 'poweruser',
    twitch_display_name: 'PowerUser',
    total_comparisons: 1000,
    total_super_likes: 100,
    is_profile_public: 1,
  }),
};

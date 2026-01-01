import type { Session } from '../../src/types';

/**
 * Factory function to create test sessions with optional overrides
 */
export function createTestSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now

  return {
    id: 'test-session-id-00000000-0000-0000-0000-000000000001',
    user_id: 1,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ...overrides,
  };
}

/**
 * Pre-defined test sessions for common test scenarios
 */
export const testSessions = {
  /** Valid session that has not expired */
  valid: createTestSession({
    id: 'valid-session-00000000-0000-0000-0000-000000000001',
    user_id: 1,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
  }),

  /** Expired session */
  expired: createTestSession({
    id: 'expired-session-00000000-0000-0000-0000-000000000002',
    user_id: 1,
    created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48 hours ago
    expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24 hours ago (expired)
  }),

  /** Admin user session (user_id matches admin user) */
  admin: createTestSession({
    id: 'admin-session-00000000-0000-0000-0000-000000000003',
    user_id: 2, // Matches testUsers.admin.id
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
  }),
};

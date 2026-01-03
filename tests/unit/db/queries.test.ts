import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getUserByTwitchId,
  getUserById,
  createUser,
  updateUserLogin,
  incrementUserComparisons,
  updateUserPrivacy,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  getAllClips,
  getClipById,
  getClipBySlug,
  createClip,
  updateClipGlobalRating,
  createComparison,
  getUserComparisons,
  getUserComparisonsWithClips,
  getUserClipRating,
  upsertUserClipRating,
  getUserClipRatings,
  getUserSuperLikedClips,
  getRecentPairings,
  recordPairing,
  getGlobalLeaderboard,
  getUserLeaderboard,
  getSavedClips,
  isClipSaved,
  areClipsSaved,
  saveClip,
  unsaveClip,
  reorderSavedClip,
  getVoterLeaderboard,
  deleteUserClipRating,
} from '../../../src/db/queries';

/**
 * Creates a mock D1 database with configurable responses
 */
function createMockD1(config: {
  firstResult?: unknown | ((sql: string) => unknown);
  allResults?: unknown[];
  runResult?: { success: boolean; meta: { changes: number } };
  throwError?: boolean;
} = {}) {
  const { firstResult = null, allResults = [], runResult = { success: true, meta: { changes: 1 } }, throwError = false } = config;
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      sql,
      params,
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(): Promise<T | null> {
        statements.push({ sql, params });
        if (throwError) throw new Error('DB error');
        // Support function-based firstResult for dynamic responses
        if (typeof firstResult === 'function') {
          return (firstResult as (sql: string) => unknown)(sql) as T;
        }
        return firstResult as T;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        statements.push({ sql, params });
        if (throwError) throw new Error('DB error');
        return { results: allResults as T[], meta: { rows_read: allResults.length } };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        statements.push({ sql, params });
        if (throwError) throw new Error('DB error');
        return runResult;
      },
    };
  };

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch(stmts: ReturnType<typeof createStatement>[]): Promise<unknown[]> {
      for (const stmt of stmts) {
        statements.push({ sql: stmt.sql, params: stmt.params });
      }
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    _statements: statements,
  };
}

// Test data factories
function createTestUser(overrides = {}) {
  return {
    id: 1,
    twitch_id: '12345',
    twitch_username: 'testuser',
    twitch_display_name: 'Test User',
    twitch_profile_image: 'https://example.com/image.jpg',
    created_at: '2024-01-01T00:00:00Z',
    last_login: '2024-01-01T00:00:00Z',
    total_comparisons: 0,
    total_super_likes: 0,
    is_profile_public: 1,
    ...overrides,
  };
}

function createTestClip(overrides = {}) {
  return {
    id: 1,
    twitch_slug: 'TestSlug123',
    title: 'Test Clip',
    clipped_by: 'testuser',
    twitch_url: 'https://clips.twitch.tv/TestSlug123',
    clipped_at: null,
    created_at: '2024-01-01T00:00:00Z',
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

describe('db/queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('User Operations', () => {
    describe('getUserByTwitchId', () => {
      it('returns user when found', async () => {
        const user = createTestUser();
        const db = createMockD1({ firstResult: user });

        const result = await getUserByTwitchId(db as unknown as D1Database, '12345');

        expect(result).toEqual(user);
        expect(db._statements[0].sql).toContain('SELECT * FROM users WHERE twitch_id');
        expect(db._statements[0].params).toContain('12345');
      });

      it('returns null when user not found', async () => {
        const db = createMockD1({ firstResult: null });

        const result = await getUserByTwitchId(db as unknown as D1Database, 'nonexistent');

        expect(result).toBeNull();
      });
    });

    describe('getUserById', () => {
      it('returns user when found', async () => {
        const user = createTestUser();
        const db = createMockD1({ firstResult: user });

        const result = await getUserById(db as unknown as D1Database, 1);

        expect(result).toEqual(user);
        expect(db._statements[0].params).toContain(1);
      });
    });

    describe('createUser', () => {
      it('creates user and returns it', async () => {
        const user = createTestUser();
        // After INSERT, the SELECT returns the user
        const db = createMockD1({ firstResult: user });

        const result = await createUser(db as unknown as D1Database, '12345', 'testuser', 'Test User', 'https://image.url');

        expect(result).toEqual(user);
        // Verify INSERT was called
        const insertStmt = db._statements.find((s) => s.sql.includes('INSERT'));
        expect(insertStmt).toBeDefined();
        expect(insertStmt?.params).toContain('12345');
      });

      it('throws error if user creation fails', async () => {
        const db = createMockD1({ firstResult: null }); // SELECT returns null

        await expect(createUser(db as unknown as D1Database, '12345', 'testuser', null, null))
          .rejects.toThrow('Failed to create user');
      });
    });

    describe('updateUserLogin', () => {
      it('updates last_login timestamp', async () => {
        const db = createMockD1({});

        await updateUserLogin(db as unknown as D1Database, 1);

        expect(db._statements[0].sql).toContain("last_login = datetime('now')");
        expect(db._statements[0].params).toContain(1);
      });
    });

    describe('incrementUserComparisons', () => {
      it('increments comparisons without super like', async () => {
        const db = createMockD1({});

        await incrementUserComparisons(db as unknown as D1Database, 1, false);

        expect(db._statements[0].sql).toContain('total_comparisons = total_comparisons + 1');
        expect(db._statements[0].sql).not.toContain('total_super_likes = total_super_likes + 1');
      });

      it('increments both comparisons and super likes', async () => {
        const db = createMockD1({});

        await incrementUserComparisons(db as unknown as D1Database, 1, true);

        expect(db._statements[0].sql).toContain('total_comparisons = total_comparisons + 1');
        expect(db._statements[0].sql).toContain('total_super_likes = total_super_likes + 1');
      });
    });

    describe('updateUserPrivacy', () => {
      it('sets privacy to public (1)', async () => {
        const db = createMockD1({});

        await updateUserPrivacy(db as unknown as D1Database, 1, true);

        expect(db._statements[0].params[0]).toBe(1); // is_profile_public = 1
      });

      it('sets privacy to private (0)', async () => {
        const db = createMockD1({});

        await updateUserPrivacy(db as unknown as D1Database, 1, false);

        expect(db._statements[0].params[0]).toBe(0); // is_profile_public = 0
      });
    });
  });

  describe('Session Operations', () => {
    describe('createSession', () => {
      it('creates session with expiry', async () => {
        const db = createMockD1({});
        const expiresAt = '2024-01-02T00:00:00Z';

        await createSession(db as unknown as D1Database, 'session-123', 1, expiresAt);

        expect(db._statements[0].sql).toContain('INSERT INTO sessions');
        expect(db._statements[0].params).toContain('session-123');
        expect(db._statements[0].params).toContain(1);
        expect(db._statements[0].params).toContain(expiresAt);
      });
    });

    describe('getSession', () => {
      it('returns valid session', async () => {
        const session = { id: 'session-123', user_id: 1, created_at: '2024-01-01', expires_at: '2024-01-02' };
        const db = createMockD1({ firstResult: session });

        const result = await getSession(db as unknown as D1Database, 'session-123');

        expect(result).toEqual(session);
        expect(db._statements[0].sql).toContain("expires_at > datetime('now')");
      });

      it('returns null for expired session', async () => {
        const db = createMockD1({ firstResult: null });

        const result = await getSession(db as unknown as D1Database, 'expired-session');

        expect(result).toBeNull();
      });
    });

    describe('deleteSession', () => {
      it('deletes session by id', async () => {
        const db = createMockD1({});

        await deleteSession(db as unknown as D1Database, 'session-123');

        expect(db._statements[0].sql).toContain('DELETE FROM sessions');
        expect(db._statements[0].params).toContain('session-123');
      });
    });

    describe('cleanExpiredSessions', () => {
      it('removes expired sessions', async () => {
        const db = createMockD1({});

        await cleanExpiredSessions(db as unknown as D1Database);

        expect(db._statements[0].sql).toContain("expires_at <= datetime('now')");
      });
    });
  });

  describe('Clip Operations', () => {
    describe('getAllClips', () => {
      it('returns only active clips', async () => {
        const clips = [createTestClip({ id: 1 }), createTestClip({ id: 2 })];
        const db = createMockD1({ allResults: clips });

        const result = await getAllClips(db as unknown as D1Database);

        expect(result).toHaveLength(2);
        expect(db._statements[0].sql).toContain('is_active = 1');
      });
    });

    describe('getClipById', () => {
      it('returns clip by id', async () => {
        const clip = createTestClip();
        const db = createMockD1({ firstResult: clip });

        const result = await getClipById(db as unknown as D1Database, 1);

        expect(result).toEqual(clip);
        expect(db._statements[0].params).toContain(1);
      });
    });

    describe('getClipBySlug', () => {
      it('returns clip by slug', async () => {
        const clip = createTestClip();
        const db = createMockD1({ firstResult: clip });

        const result = await getClipBySlug(db as unknown as D1Database, 'TestSlug123');

        expect(result).toEqual(clip);
        expect(db._statements[0].params).toContain('TestSlug123');
      });
    });

    describe('createClip', () => {
      it('creates clip and returns it', async () => {
        const clip = createTestClip({ twitch_slug: 'NewSlug' });
        // After INSERT, the SELECT returns the clip
        const db = createMockD1({ firstResult: clip });

        const result = await createClip(db as unknown as D1Database, 'NewSlug', 'New Clip', 'https://url');

        expect(result).toEqual(clip);
        // Verify INSERT was called
        const insertStmt = db._statements.find((s) => s.sql.includes('INSERT'));
        expect(insertStmt).toBeDefined();
        expect(insertStmt?.params).toContain('NewSlug');
      });

      it('uses INSERT OR IGNORE for idempotency', async () => {
        const clip = createTestClip({ twitch_slug: 'NewSlug' });
        // After INSERT, the SELECT returns the clip
        const db = createMockD1({ firstResult: clip });

        await createClip(db as unknown as D1Database, 'NewSlug', 'New Clip', 'https://url');

        const insertStmt = db._statements.find((s) => s.sql.includes('INSERT'));
        expect(insertStmt?.sql).toContain('INSERT OR IGNORE');
      });
    });

    describe('updateClipGlobalRating', () => {
      it('updates all rating fields', async () => {
        const db = createMockD1({});

        await updateClipGlobalRating(db as unknown as D1Database, 1, 1600, 10, 6, 3, 1, 2, 200);

        const sql = db._statements[0].sql;
        expect(sql).toContain('global_elo = ?');
        expect(sql).toContain('global_matches = ?');
        expect(sql).toContain('global_wins = ?');
        expect(sql).toContain('global_losses = ?');
        expect(sql).toContain('global_ties = ?');
        expect(sql).toContain('global_super_likes = ?');
        expect(sql).toContain('rating_deviation = ?');
        expect(sql).toContain("last_rated_at = datetime('now')");
      });
    });
  });

  describe('Comparison Operations', () => {
    describe('createComparison', () => {
      it('creates comparison record and checks for new pair', async () => {
        const db = createMockD1({});

        const result = await createComparison(db as unknown as D1Database, 1, 1, 2, 1, 'clip_a', 5000);

        // First query checks for existing pair
        expect(db._statements[0].sql).toContain('SELECT 1 FROM comparisons');
        // Second query inserts the comparison
        expect(db._statements[1].sql).toContain('INSERT INTO comparisons');
        const params = db._statements[1].params;
        expect(params).toContain(1); // user_id
        expect(params).toContain(1); // clip_a_id
        expect(params).toContain(2); // clip_b_id
        expect(params).toContain('clip_a'); // result
        expect(params).toContain(5000); // time_spent_ms
        // Returns isNewPair status
        expect(result).toHaveProperty('isNewPair');
      });

      it('handles null winner for ties/skips', async () => {
        const db = createMockD1({});

        await createComparison(db as unknown as D1Database, 1, 1, 2, null, 'tie', null);

        // Second query is the INSERT
        expect(db._statements[1].params).toContain(null); // winner_clip_id
        expect(db._statements[1].params).toContain('tie');
      });

      it('increments unique_pairs_voted for new pairs', async () => {
        const db = createMockD1({});

        const result = await createComparison(db as unknown as D1Database, 1, 1, 2, 1, 'clip_a', 5000);

        // Third query updates user counter for new pair
        expect(db._statements[2].sql).toContain('UPDATE users SET unique_pairs_voted');
        expect(result.isNewPair).toBe(true);
      });
    });

    describe('getUserComparisons', () => {
      it('returns user comparisons ordered by date', async () => {
        const comparisons = [
          { id: 1, user_id: 1, clip_a_id: 1, clip_b_id: 2, result: 'clip_a', created_at: '2024-01-02' },
          { id: 2, user_id: 1, clip_a_id: 3, clip_b_id: 4, result: 'tie', created_at: '2024-01-01' },
        ];
        const db = createMockD1({ allResults: comparisons });

        const result = await getUserComparisons(db as unknown as D1Database, 1, 50);

        expect(result).toHaveLength(2);
        expect(db._statements[0].sql).toContain('ORDER BY created_at DESC');
        expect(db._statements[0].sql).toContain('LIMIT ?');
      });
    });

    describe('getUserComparisonsWithClips', () => {
      it('returns enriched comparisons with clip data', async () => {
        const enriched = [
          {
            id: 1,
            result: 'clip_a',
            created_at: '2024-01-01',
            clipA_id: 1,
            clipA_title: 'Clip A',
            clipA_slug: 'SlugA',
            clipB_id: 2,
            clipB_title: 'Clip B',
            clipB_slug: 'SlugB',
          },
        ];
        const db = createMockD1({ allResults: enriched });

        const result = await getUserComparisonsWithClips(db as unknown as D1Database, 1);

        expect(result).toHaveLength(1);
        expect(db._statements[0].sql).toContain('JOIN clips ca ON c.clip_a_id = ca.id');
        expect(db._statements[0].sql).toContain('JOIN clips cb ON c.clip_b_id = cb.id');
      });
    });
  });

  describe('Rating Operations', () => {
    describe('getUserClipRating', () => {
      it('returns rating for user-clip pair', async () => {
        const rating = { id: 1, user_id: 1, clip_id: 1, elo_rating: 1600, matches_played: 10 };
        const db = createMockD1({ firstResult: rating });

        const result = await getUserClipRating(db as unknown as D1Database, 1, 1);

        expect(result).toEqual(rating);
        expect(db._statements[0].params).toContain(1); // user_id
        expect(db._statements[0].params).toContain(1); // clip_id
      });
    });

    describe('upsertUserClipRating', () => {
      it('inserts new rating with ON CONFLICT clause', async () => {
        const db = createMockD1({});

        await upsertUserClipRating(db as unknown as D1Database, 1, 1, 1600, 10, 6, 3, 1, 0, 200);

        expect(db._statements[0].sql).toContain('INSERT INTO user_clip_ratings');
        expect(db._statements[0].sql).toContain('ON CONFLICT(user_id, clip_id) DO UPDATE');
      });
    });

    describe('getUserClipRatings', () => {
      it('returns all ratings for user', async () => {
        const ratings = [
          { id: 1, user_id: 1, clip_id: 1, elo_rating: 1600 },
          { id: 2, user_id: 1, clip_id: 2, elo_rating: 1400 },
        ];
        const db = createMockD1({ allResults: ratings });

        const result = await getUserClipRatings(db as unknown as D1Database, 1);

        expect(result).toHaveLength(2);
      });
    });

    describe('getUserSuperLikedClips', () => {
      it('returns super liked clips ordered by ELO', async () => {
        const clips = [createTestClip({ id: 1 }), createTestClip({ id: 2 })];
        const db = createMockD1({ allResults: clips });

        const result = await getUserSuperLikedClips(db as unknown as D1Database, 1);

        expect(result).toHaveLength(2);
        expect(db._statements[0].sql).toContain('super_liked = 1');
        expect(db._statements[0].sql).toContain('ORDER BY ucr.elo_rating DESC');
      });
    });
  });

  describe('Pairing Operations', () => {
    describe('getRecentPairings', () => {
      it('returns normalized pair keys', async () => {
        const pairings = [
          { clip_a_id: 1, clip_b_id: 2 },
          { clip_a_id: 3, clip_b_id: 5 },
        ];
        const db = createMockD1({ allResults: pairings });

        const result = await getRecentPairings(db as unknown as D1Database, 1, 24);

        expect(result.has('1-2')).toBe(true);
        expect(result.has('3-5')).toBe(true);
      });
    });

    describe('recordPairing', () => {
      it('normalizes clip order', async () => {
        const db = createMockD1({});

        // Passing clipB first (id=5) and clipA second (id=3)
        await recordPairing(db as unknown as D1Database, 1, 5, 3);

        // Should store as (3, 5) - normalized order
        expect(db._statements[0].params[1]).toBe(3); // clip_a_id
        expect(db._statements[0].params[2]).toBe(5); // clip_b_id
      });

      it('uses ON CONFLICT for upsert', async () => {
        const db = createMockD1({});

        await recordPairing(db as unknown as D1Database, 1, 1, 2);

        expect(db._statements[0].sql).toContain('ON CONFLICT(user_id, clip_a_id, clip_b_id)');
        expect(db._statements[0].sql).toContain('times_shown = times_shown + 1');
      });
    });
  });

  describe('Leaderboard Operations', () => {
    describe('getGlobalLeaderboard', () => {
      it('returns clips with total count', async () => {
        const clips = [createTestClip({ id: 1, global_elo: 1800 })];
        const db = createMockD1({ allResults: clips, firstResult: { count: 10 } });

        const result = await getGlobalLeaderboard(db as unknown as D1Database, 50, 0, 'elo', 'desc');

        expect(result.clips).toHaveLength(1);
        expect(result.total).toBe(10);
      });

      it('supports different sort fields', async () => {
        const db = createMockD1({ allResults: [], firstResult: { count: 0 } });

        await getGlobalLeaderboard(db as unknown as D1Database, 50, 0, 'winrate', 'asc');

        expect(db._statements[1].sql).toContain('CAST(global_wins AS REAL) / global_matches');
        expect(db._statements[1].sql).toContain('ASC');
      });
    });

    describe('getUserLeaderboard', () => {
      it('returns user clips with manual positions', async () => {
        const clips = [{ ...createTestClip(), user_elo: 1600, manual_position: 1 }];
        const db = createMockD1({ allResults: clips });

        const result = await getUserLeaderboard(db as unknown as D1Database, 1, 50);

        expect(result).toHaveLength(1);
        expect(db._statements[0].sql).toContain('manual_position');
      });
    });
  });

  describe('Saved Clips Operations', () => {
    describe('getSavedClips', () => {
      it('returns saved clips with position', async () => {
        const saved = [{ ...createTestClip(), position: 1, saved_at: '2024-01-01' }];
        const db = createMockD1({ allResults: saved });

        const result = await getSavedClips(db as unknown as D1Database, 1);

        expect(result).toHaveLength(1);
        expect(db._statements[0].sql).toContain('ORDER BY sc.position ASC');
      });
    });

    describe('isClipSaved', () => {
      it('returns true if clip is saved', async () => {
        const db = createMockD1({ firstResult: { '1': 1 } });

        const result = await isClipSaved(db as unknown as D1Database, 1, 1);

        expect(result).toBe(true);
      });

      it('returns false if clip is not saved', async () => {
        const db = createMockD1({ firstResult: null });

        const result = await isClipSaved(db as unknown as D1Database, 1, 1);

        expect(result).toBe(false);
      });
    });

    describe('areClipsSaved', () => {
      it('returns map of clip ids to saved status', async () => {
        const db = createMockD1({ allResults: [{ clip_id: 1 }, { clip_id: 3 }] });

        const result = await areClipsSaved(db as unknown as D1Database, 1, [1, 2, 3]);

        expect(result[1]).toBe(true);
        expect(result[2]).toBe(false);
        expect(result[3]).toBe(true);
      });

      it('returns empty object for empty input', async () => {
        const db = createMockD1({});

        const result = await areClipsSaved(db as unknown as D1Database, 1, []);

        expect(result).toEqual({});
      });

      it('uses IN clause for efficiency', async () => {
        const db = createMockD1({ allResults: [] });

        await areClipsSaved(db as unknown as D1Database, 1, [1, 2, 3]);

        expect(db._statements[0].sql).toContain('IN (?,?,?)');
      });
    });

    describe('saveClip', () => {
      it('assigns next position', async () => {
        const db = createMockD1({ firstResult: { max_pos: 5 } });

        await saveClip(db as unknown as D1Database, 1, 10);

        // Second statement should be INSERT with position = 6
        expect(db._statements[1].params).toContain(6); // new position
      });

      it('uses INSERT OR IGNORE for idempotency', async () => {
        const db = createMockD1({ firstResult: { max_pos: 0 } });

        await saveClip(db as unknown as D1Database, 1, 1);

        expect(db._statements[1].sql).toContain('INSERT OR IGNORE');
      });
    });

    describe('unsaveClip', () => {
      it('deletes and shifts positions', async () => {
        const db = createMockD1({ firstResult: { position: 3 } });

        await unsaveClip(db as unknown as D1Database, 1, 5);

        // Should have: SELECT position, DELETE, UPDATE positions
        expect(db._statements.length).toBe(3);
        expect(db._statements[1].sql).toContain('DELETE FROM saved_clips');
        expect(db._statements[2].sql).toContain('position = position - 1');
      });

      it('does nothing if clip not saved', async () => {
        const db = createMockD1({ firstResult: null });

        await unsaveClip(db as unknown as D1Database, 1, 5);

        // Only SELECT should be called
        expect(db._statements.length).toBe(1);
      });
    });

    describe('reorderSavedClip', () => {
      it('shifts positions when moving up', async () => {
        // Mock: clip is at position 5, moving to position 2
        const db = createMockD1({
          firstResult: (sql: string) => {
            if (sql.includes('SELECT position FROM saved_clips')) {
              return { position: 5 };
            } else if (sql.includes('SELECT COUNT')) {
              return { count: 10 };
            }
            return null;
          },
        });

        await reorderSavedClip(db as unknown as D1Database, 1, 5, 2);

        // Should have UPDATE statements for shifting
        const updateStatements = db._statements.filter((s) => s.sql.includes('UPDATE saved_clips'));
        expect(updateStatements.length).toBeGreaterThan(0);
      });

      it('does nothing if clip not saved', async () => {
        const db = createMockD1({ firstResult: null });

        await reorderSavedClip(db as unknown as D1Database, 1, 99, 1);

        // Only the SELECT should be recorded, no UPDATEs
        expect(db._statements.length).toBe(1);
        expect(db._statements[0].sql).toContain('SELECT position');
      });

      it('does nothing if position unchanged', async () => {
        const db = createMockD1({
          firstResult: (sql: string) => {
            if (sql.includes('SELECT position FROM saved_clips')) {
              return { position: 3 };
            } else if (sql.includes('SELECT COUNT')) {
              return { count: 10 };
            }
            return null;
          },
        });

        await reorderSavedClip(db as unknown as D1Database, 1, 5, 3);

        // Only the SELECT should be recorded, no UPDATEs (position already 3)
        expect(db._statements.length).toBe(1);
      });
    });
  });

  describe('Voter Leaderboard', () => {
    describe('getVoterLeaderboard', () => {
      it('returns users with vote counts', async () => {
        const voters = [
          { id: 1, twitch_username: 'user1', total_comparisons: 100 },
          { id: 2, twitch_username: 'user2', total_comparisons: 50 },
        ];
        const db = createMockD1({ allResults: voters });

        const result = await getVoterLeaderboard(db as unknown as D1Database);

        expect(result).toHaveLength(2);
        expect(db._statements[0].sql).toContain('ORDER BY total_comparisons DESC');
        expect(db._statements[0].sql).toContain('total_comparisons > 0');
      });
    });
  });

  describe('deleteUserClipRating', () => {
    it('deletes rating, comparisons, and decrements total_comparisons correctly', async () => {
      let comparisonsDeleted = 2; // Simulate deleting 2 comparisons
      const db = createMockD1({
        firstResult: (sql: string) => {
          if (sql.includes('SELECT manual_position')) {
            return { manual_position: null, matches_played: 5 };
          }
          return null;
        },
        runResult: { success: true, meta: { changes: comparisonsDeleted } },
      });

      await deleteUserClipRating(db as unknown as D1Database, 1, 10);

      // Should have: SELECT rating, DELETE rating, DELETE comparisons, UPDATE user, UPDATE rollup
      const deleteRatingStmt = db._statements.find(s =>
        s.sql.includes('DELETE FROM user_clip_ratings')
      );
      const deleteComparisonsStmt = db._statements.find(s =>
        s.sql.includes('DELETE FROM comparisons')
      );
      const updateUserStmt = db._statements.find(s =>
        s.sql.includes('UPDATE users SET total_comparisons')
      );
      const updateRollupStmt = db._statements.find(s =>
        s.sql.includes('UPDATE clip_rating_rollups')
      );

      expect(deleteRatingStmt).toBeDefined();
      expect(deleteComparisonsStmt).toBeDefined();
      expect(updateUserStmt).toBeDefined();
      expect(updateRollupStmt).toBeDefined();

      // Verify comparison delete uses correct WHERE clause
      expect(deleteComparisonsStmt?.sql).toContain('clip_a_id = ? OR clip_b_id = ?');
      expect(deleteComparisonsStmt?.params).toContain(10); // clipId
    });

    it('does nothing if rating does not exist', async () => {
      const db = createMockD1({ firstResult: null });

      await deleteUserClipRating(db as unknown as D1Database, 1, 999);

      // Only SELECT should be recorded
      expect(db._statements.length).toBe(1);
      expect(db._statements[0].sql).toContain('SELECT manual_position');
    });

    it('shifts manual positions when rating had a manual position', async () => {
      const db = createMockD1({
        firstResult: (sql: string) => {
          if (sql.includes('SELECT manual_position')) {
            return { manual_position: 3, matches_played: 2 };
          }
          return null;
        },
        runResult: { success: true, meta: { changes: 1 } },
      });

      await deleteUserClipRating(db as unknown as D1Database, 1, 10);

      // Should have UPDATE for shifting positions
      const shiftStmt = db._statements.find(s =>
        s.sql.includes('manual_position = manual_position - 1')
      );
      expect(shiftStmt).toBeDefined();
      expect(shiftStmt?.params).toContain(3); // the old position
    });

    it('does not update user counter when no comparisons deleted', async () => {
      const db = createMockD1({
        firstResult: (sql: string) => {
          if (sql.includes('SELECT manual_position')) {
            return { manual_position: null, matches_played: 0 };
          }
          return null;
        },
        runResult: { success: true, meta: { changes: 0 } }, // No comparisons deleted
      });

      await deleteUserClipRating(db as unknown as D1Database, 1, 10);

      // Should NOT have UPDATE users statement
      const updateUserStmt = db._statements.find(s =>
        s.sql.includes('UPDATE users SET total_comparisons')
      );
      expect(updateUserStmt).toBeUndefined();
    });

    it('uses actual delete count instead of matches_played to avoid double-counting', async () => {
      // This is the key test: if clip A was in comparisons [A-B, A-C] and B was in [A-B, B-C]
      // When we delete A first, we delete [A-B, A-C] (count=2)
      // When we delete B next, [A-B] is already deleted, so we only delete [B-C] (count=1)
      // The delete statement returns the actual count, not matches_played

      // First deletion (clip A)
      const dbFirst = createMockD1({
        firstResult: (sql: string) => {
          if (sql.includes('SELECT manual_position')) {
            return { manual_position: null, matches_played: 2 }; // A was in 2 comparisons
          }
          return null;
        },
        runResult: { success: true, meta: { changes: 2 } }, // Actually deleted 2
      });

      await deleteUserClipRating(dbFirst as unknown as D1Database, 1, 1);

      const updateA = dbFirst._statements.find(s =>
        s.sql.includes('UPDATE users SET total_comparisons')
      );
      expect(updateA?.params?.[0]).toBe(2); // Decremented by actual delete count

      // Second deletion (clip B) - simulating that [A-B] was already deleted
      const dbSecond = createMockD1({
        firstResult: (sql: string) => {
          if (sql.includes('SELECT manual_position')) {
            return { manual_position: null, matches_played: 2 }; // B was also in 2 comparisons originally
          }
          return null;
        },
        runResult: { success: true, meta: { changes: 1 } }, // Only 1 left to delete (B-C)
      });

      await deleteUserClipRating(dbSecond as unknown as D1Database, 1, 2);

      const updateB = dbSecond._statements.find(s =>
        s.sql.includes('UPDATE users SET total_comparisons')
      );
      // Key assertion: decremented by 1 (actual delete count), NOT 2 (matches_played)
      expect(updateB?.params?.[0]).toBe(1);
    });
  });
});

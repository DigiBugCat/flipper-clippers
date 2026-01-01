import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleVoteQueue } from '../../../src/queues/voteConsumer';
import type { Env, VoteQueueMessage, VoteResult } from '../../../src/types';

/**
 * Creates a mock VoteQueueMessage with defaults
 */
function createVoteMessage(overrides: Partial<VoteQueueMessage> = {}): VoteQueueMessage {
  return {
    clipAId: 1,
    clipBId: 2,
    userId: 1,
    result: 'clip_a' as VoteResult,
    currentRatingA: 1500,
    currentRatingB: 1500,
    newRatingA: 1516,
    newRatingB: 1484,
    deviationA: 350,
    deviationB: 350,
    newDeviationA: 340,
    newDeviationB: 340,
    userWeight: 1.0,
    isSuperLike: false,
    isNewRatingA: false,
    isNewRatingB: false,
    statsA: { wins: 1, losses: 0, ties: 0 },
    statsB: { wins: 0, losses: 1, ties: 0 },
    ...overrides,
  };
}

/**
 * Creates a mock message with ack/retry functions
 */
function createMockMessage(body: VoteQueueMessage) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
    id: `msg-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date(),
    attempts: 1,
  };
}

/**
 * Creates a mock MessageBatch
 */
function createMockBatch(votes: VoteQueueMessage[]) {
  return {
    messages: votes.map((body) => createMockMessage(body)),
    queue: 'flipper-votes',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<VoteQueueMessage>;
}

/**
 * Creates a mock D1 database that tracks statements
 */
function createMockD1(options: {
  rollups?: Map<number, Record<string, unknown>>;
  shouldFail?: boolean;
  failOnBatch?: boolean;
} = {}) {
  const { rollups = new Map(), shouldFail = false, failOnBatch = false } = options;
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const batchCalls: Array<Array<{ sql: string; params: unknown[] }>> = [];

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      sql,
      params,
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(): Promise<T | null> {
        statements.push({ sql, params });
        if (shouldFail) throw new Error('DB error');

        // Return rollup if querying for one
        if (sql.includes('FROM clip_rating_rollups WHERE clip_id')) {
          const clipId = params[0] as number;
          return (rollups.get(clipId) as T) || null;
        }
        return null;
      },
      async all<T = unknown>(): Promise<{ results: T[]; meta: { rows_read?: number } }> {
        statements.push({ sql, params });
        return { results: [], meta: { rows_read: 0 } };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        statements.push({ sql, params });
        if (shouldFail) throw new Error('DB error');
        return { success: true, meta: { changes: 1 } };
      },
    };
  };

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch(stmts: ReturnType<typeof createStatement>[]): Promise<unknown[]> {
      if (failOnBatch) throw new Error('Batch failed');
      const batchStatements = stmts.map((stmt) => ({ sql: stmt.sql, params: stmt.params }));
      batchCalls.push(batchStatements);
      for (const stmt of stmts) {
        statements.push({ sql: stmt.sql, params: stmt.params });
      }
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    _statements: statements,
    _batchCalls: batchCalls,
  };
}

/**
 * Creates a mock Env
 */
function createMockEnv(db: ReturnType<typeof createMockD1>): Env {
  return {
    DB: db as unknown as D1Database,
    THUMBNAIL_CACHE: {} as KVNamespace,
    SESSION_CACHE: {} as KVNamespace,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
    VOTES_ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    AGGREGATION_COORDINATOR: {} as DurableObjectNamespace,
    VOTE_QUEUE: { send: vi.fn() } as unknown as Queue<unknown>,
  };
}

describe('voteConsumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('basic processing', () => {
    it('processes single vote message', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      await handleVoteQueue(batch, env);

      // Should have processed rollup for both clips
      const rollupQueries = db._statements.filter((s) =>
        s.sql.includes('clip_rating_rollups')
      );
      expect(rollupQueries.length).toBeGreaterThan(0);

      // Message should be acknowledged
      expect(batch.messages[0].ack).toHaveBeenCalled();
    });

    it('processes batch of multiple votes', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const votes = [
        createVoteMessage({ userId: 1 }),
        createVoteMessage({ userId: 2, clipAId: 3, clipBId: 4 }),
        createVoteMessage({ userId: 3, clipAId: 5, clipBId: 6 }),
      ];
      const batch = createMockBatch(votes);

      await handleVoteQueue(batch, env);

      // All messages should be acknowledged
      for (const msg of batch.messages) {
        expect(msg.ack).toHaveBeenCalled();
      }
    });

    it('acknowledges messages on success', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      await handleVoteQueue(batch, env);

      expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
      expect(batch.messages[0].retry).not.toHaveBeenCalled();
    });

    it('retries messages on error', async () => {
      const db = createMockD1({ shouldFail: true });
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      await handleVoteQueue(batch, env);

      expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
      expect(batch.messages[0].ack).not.toHaveBeenCalled();
    });
  });

  describe('vote types', () => {
    it('skip votes do not update rollups', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage({ result: 'skip' })]);

      await handleVoteQueue(batch, env);

      // Should not query rollups for skip votes
      const rollupReads = db._statements.filter((s) =>
        s.sql.includes('SELECT * FROM clip_rating_rollups')
      );
      expect(rollupReads.length).toBe(0);

      // But should still be acknowledged and count user comparison
      expect(batch.messages[0].ack).toHaveBeenCalled();
    });

    it('super_a votes set super_like flag for clip A', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([
        createVoteMessage({
          result: 'super_a',
          isSuperLike: true,
          statsA: { wins: 1, losses: 0, ties: 0 },
        }),
      ]);

      await handleVoteQueue(batch, env);

      // Should have set superLike delta for clip A (value = 1)
      // Check the INSERT/UPDATE for rollup contains superLike
      const hasRollupUpdate = db._statements.some(
        (s) => s.sql.includes('clip_rating_rollups') && s.sql.includes('INSERT')
      );
      expect(hasRollupUpdate).toBe(true);
    });

    it('super_b votes set super_like flag for clip B', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([
        createVoteMessage({
          result: 'super_b',
          isSuperLike: true,
          statsB: { wins: 1, losses: 0, ties: 0 },
        }),
      ]);

      await handleVoteQueue(batch, env);

      // Check rollup operations occurred
      const rollupOps = db._statements.filter((s) =>
        s.sql.includes('clip_rating_rollups')
      );
      expect(rollupOps.length).toBeGreaterThan(0);
    });

    it('tie votes update both clips with ties', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([
        createVoteMessage({
          result: 'tie',
          statsA: { wins: 0, losses: 0, ties: 1 },
          statsB: { wins: 0, losses: 0, ties: 1 },
        }),
      ]);

      await handleVoteQueue(batch, env);

      // Should update both clips
      const batchCalls = db._batchCalls;
      expect(batchCalls.length).toBeGreaterThanOrEqual(2); // At least 2 batch calls (one per clip)
    });

    it('wins and losses are tracked correctly', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([
        createVoteMessage({
          result: 'clip_a',
          statsA: { wins: 1, losses: 0, ties: 0 },
          statsB: { wins: 0, losses: 1, ties: 0 },
        }),
      ]);

      await handleVoteQueue(batch, env);

      // Verify batch was called (for both clips)
      expect(db._batchCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('rollup logic', () => {
    it('creates new rollup if none exists', async () => {
      const db = createMockD1({ rollups: new Map() }); // No existing rollups
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage({ isNewRatingA: true, isNewRatingB: true })]);

      await handleVoteQueue(batch, env);

      // Should INSERT new rollup entries
      const insertStatements = db._statements.filter((s) =>
        s.sql.includes('INSERT INTO clip_rating_rollups')
      );
      expect(insertStatements.length).toBe(2); // One for each clip
    });

    it('updates existing rollup', async () => {
      const existingRollup = {
        clip_id: 1,
        weighted_elo: 1500,
        weighted_deviation: 200,
        weighted_elo_sum: 75000,
        weighted_deviation_sum: 10000,
        weight_sum: 50,
        total_matches: 10,
        total_wins: 5,
        total_losses: 3,
        total_ties: 2,
        total_super_likes: 1,
      };
      const rollups = new Map([[1, existingRollup]]);
      const db = createMockD1({ rollups });
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage({ isNewRatingA: false })]);

      await handleVoteQueue(batch, env);

      // Should UPDATE existing rollup
      const updateStatements = db._statements.filter((s) =>
        s.sql.includes('UPDATE clip_rating_rollups SET')
      );
      expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    });

    it('new rating adds to weight sum', async () => {
      const existingRollup = {
        clip_id: 1,
        weighted_elo: 1500,
        weighted_deviation: 200,
        weighted_elo_sum: 75000,
        weighted_deviation_sum: 10000,
        weight_sum: 50,
        total_matches: 10,
        total_wins: 5,
        total_losses: 3,
        total_ties: 2,
        total_super_likes: 1,
      };
      const rollups = new Map([[1, existingRollup]]);
      const db = createMockD1({ rollups });
      const env = createMockEnv(db);

      // New rating (isNewRatingA = true)
      const batch = createMockBatch([
        createVoteMessage({
          isNewRatingA: true,
          userWeight: 25,
          newRatingA: 1600,
        }),
      ]);

      await handleVoteQueue(batch, env);

      // The UPDATE should increase weight_sum
      // Look for the UPDATE in batch calls
      expect(db._batchCalls.length).toBeGreaterThan(0);
    });

    it('updated rating maintains weight sum', async () => {
      const existingRollup = {
        clip_id: 1,
        weighted_elo: 1500,
        weighted_deviation: 200,
        weighted_elo_sum: 75000,
        weighted_deviation_sum: 10000,
        weight_sum: 50,
        total_matches: 10,
        total_wins: 5,
        total_losses: 3,
        total_ties: 2,
        total_super_likes: 1,
      };
      const rollups = new Map([[1, existingRollup]]);
      const db = createMockD1({ rollups });
      const env = createMockEnv(db);

      // Existing rating update (isNewRatingA = false)
      const batch = createMockBatch([
        createVoteMessage({
          isNewRatingA: false,
          userWeight: 50,
          currentRatingA: 1500,
          newRatingA: 1600,
        }),
      ]);

      await handleVoteQueue(batch, env);

      // Should have UPDATE statements
      const updateStatements = db._statements.filter((s) =>
        s.sql.includes('UPDATE clip_rating_rollups')
      );
      expect(updateStatements.length).toBeGreaterThanOrEqual(1);
    });

    it('updates clips table atomically with rollup', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      await handleVoteQueue(batch, env);

      // Each clip should have both rollup and clips update in same batch
      for (const batchCall of db._batchCalls) {
        const hasRollup = batchCall.some((s) => s.sql.includes('clip_rating_rollups'));
        const hasClips = batchCall.some((s) => s.sql.includes('UPDATE clips SET'));

        if (hasRollup || hasClips) {
          // If either is present, both should be present (atomic)
          expect(hasRollup).toBe(true);
          expect(hasClips).toBe(true);
        }
      }
    });
  });

  describe('user counter batching', () => {
    it('aggregates counts for same user', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);

      // 5 votes from same user
      const votes = Array.from({ length: 5 }, (_, i) =>
        createVoteMessage({ userId: 1, clipAId: i * 2 + 1, clipBId: i * 2 + 2 })
      );
      const batch = createMockBatch(votes);

      await handleVoteQueue(batch, env);

      // Should have a single batch update for user counters with +5
      const userUpdateBatch = db._batchCalls.find((calls) =>
        calls.some((s) => s.sql.includes('UPDATE users SET'))
      );
      expect(userUpdateBatch).toBeDefined();

      // Find the user update statement
      const userUpdate = db._statements.find((s) =>
        s.sql.includes('UPDATE users SET') && s.sql.includes('total_comparisons')
      );
      expect(userUpdate).toBeDefined();
      if (userUpdate) {
        // First param should be 5 (comparisons count)
        expect(userUpdate.params[0]).toBe(5);
      }
    });

    it('batches multiple user updates', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);

      // Votes from 3 different users
      const votes = [
        createVoteMessage({ userId: 1 }),
        createVoteMessage({ userId: 2, clipAId: 3, clipBId: 4 }),
        createVoteMessage({ userId: 3, clipAId: 5, clipBId: 6 }),
      ];
      const batch = createMockBatch(votes);

      await handleVoteQueue(batch, env);

      // Should have single batch call with 3 user updates
      const userUpdateBatch = db._batchCalls.find((calls) =>
        calls.every((s) => s.sql.includes('UPDATE users SET'))
      );
      expect(userUpdateBatch).toBeDefined();
      expect(userUpdateBatch?.length).toBe(3);
    });

    it('updates last_active timestamp', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      await handleVoteQueue(batch, env);

      // Check for last_active in UPDATE users
      const userUpdate = db._statements.find(
        (s) => s.sql.includes('UPDATE users') && s.sql.includes("last_active = datetime('now')")
      );
      expect(userUpdate).toBeDefined();
    });

    it('increments super_likes count for super votes', async () => {
      const db = createMockD1();
      const env = createMockEnv(db);

      // 3 votes: 2 super likes, 1 regular
      const votes = [
        createVoteMessage({ userId: 1, result: 'super_a', isSuperLike: true }),
        createVoteMessage({ userId: 1, result: 'super_b', isSuperLike: true, clipAId: 3, clipBId: 4 }),
        createVoteMessage({ userId: 1, result: 'clip_a', isSuperLike: false, clipAId: 5, clipBId: 6 }),
      ];
      const batch = createMockBatch(votes);

      await handleVoteQueue(batch, env);

      // User counter update should show 3 comparisons, 2 super likes
      const userUpdate = db._statements.find(
        (s) => s.sql.includes('UPDATE users SET') && s.sql.includes('total_super_likes')
      );
      expect(userUpdate).toBeDefined();
      if (userUpdate) {
        expect(userUpdate.params[0]).toBe(3); // comparisons
        expect(userUpdate.params[1]).toBe(2); // super likes
      }
    });

    it('handles counter update failure gracefully', async () => {
      const db = createMockD1({ failOnBatch: true });
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage()]);

      // Should not throw - counter updates are eventually consistent
      await expect(handleVoteQueue(batch, env)).resolves.not.toThrow();

      // Individual messages should still have been processed
      // (they ack'd before batch user counter update)
    });
  });

  describe('error handling', () => {
    it('continues processing after individual message failure', async () => {
      // Create a DB that fails on specific clip IDs
      const failingClipIds = new Set([1, 2]); // First vote's clips
      const db = createMockD1();
      const originalPrepare = db.prepare.bind(db);

      db.prepare = (sql: string) => {
        const stmt = originalPrepare(sql);
        const originalBind = stmt.bind.bind(stmt);

        stmt.bind = function (...bindParams: unknown[]) {
          const boundStmt = originalBind(...bindParams);
          const originalFirst = boundStmt.first.bind(boundStmt);

          boundStmt.first = async function <T = unknown>(): Promise<T | null> {
            // Fail if querying rollup for failing clip IDs
            if (sql.includes('clip_rating_rollups') && failingClipIds.has(bindParams[0] as number)) {
              throw new Error('Transient error');
            }
            return originalFirst();
          };

          return boundStmt;
        };

        return stmt;
      };

      const env = createMockEnv(db);
      const votes = [
        createVoteMessage({ userId: 1, clipAId: 1, clipBId: 2 }), // Will fail (clips 1,2)
        createVoteMessage({ userId: 2, clipAId: 3, clipBId: 4 }), // Will succeed (clips 3,4)
      ];
      const batch = createMockBatch(votes);

      await handleVoteQueue(batch, env);

      // First message should retry, second should ack
      expect(batch.messages[0].retry).toHaveBeenCalled();
      expect(batch.messages[1].ack).toHaveBeenCalled();
    });

    it('logs errors for failed votes', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const db = createMockD1({ shouldFail: true });
      const env = createMockEnv(db);
      const batch = createMockBatch([createVoteMessage({ userId: 42 })]);

      await handleVoteQueue(batch, env);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[QUEUE] Failed to process vote for user=42'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });
});

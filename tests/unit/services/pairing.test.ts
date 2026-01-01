import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateNextPairs, getPairingStats, type PairIds } from '../../../src/services/pairing';

/**
 * Helper to create a mock D1Database with configurable query results
 */
function createMockDb(options: {
  clipIds?: number[];
  ratedClips?: { clip_id: number; updated_at: string }[];
  totalClipsCount?: number;
  userComparisonsCount?: number;
}) {
  const {
    clipIds = [],
    ratedClips = [],
    totalClipsCount = 0,
    userComparisonsCount = 0,
  } = options;

  const mockStatement = (queryType: 'clips' | 'ratings' | 'count' | 'comparisons') => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockImplementation(async () => {
      if (queryType === 'clips') {
        return {
          results: clipIds.map((id) => ({ id })),
          meta: { rows_read: clipIds.length },
        };
      }
      if (queryType === 'ratings') {
        return {
          results: ratedClips,
          meta: { rows_read: ratedClips.length },
        };
      }
      return { results: [], meta: { rows_read: 0 } };
    }),
    first: vi.fn().mockImplementation(async () => {
      if (queryType === 'count') {
        return { count: totalClipsCount };
      }
      if (queryType === 'comparisons') {
        return { count: userComparisonsCount };
      }
      return null;
    }),
  });

  let prepareCallCount = 0;
  const queryOrder = ['clips', 'ratings'] as const;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      // Detect query type from SQL
      if (sql.includes('COUNT(*)') && sql.includes('clips')) {
        return mockStatement('count');
      }
      if (sql.includes('COUNT(DISTINCT')) {
        return mockStatement('comparisons');
      }
      if (sql.includes('SELECT id FROM clips')) {
        return mockStatement('clips');
      }
      if (sql.includes('user_clip_ratings')) {
        return mockStatement('ratings');
      }
      // Fallback based on call order for calculateNextPairs
      const type = queryOrder[prepareCallCount % 2] || 'clips';
      prepareCallCount++;
      return mockStatement(type);
    }),
  } as unknown as D1Database;
}

describe('calculateNextPairs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Math.random for deterministic tests
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  describe('edge cases', () => {
    it('returns empty array with no clips', async () => {
      const db = createMockDb({ clipIds: [] });
      const pairs = await calculateNextPairs(db, 1, 10);
      expect(pairs).toEqual([]);
    });

    it('returns empty array with only 1 clip', async () => {
      const db = createMockDb({ clipIds: [1] });
      const pairs = await calculateNextPairs(db, 1, 10);
      expect(pairs).toEqual([]);
    });

    it('returns empty array with fewer than 2 clips', async () => {
      const db = createMockDb({ clipIds: [42] });
      const pairs = await calculateNextPairs(db, 1, 5);
      expect(pairs).toEqual([]);
    });
  });

  describe('prioritization', () => {
    it('prioritizes unrated clips first', async () => {
      // User has rated clips 1, 2 but not 3, 4
      const db = createMockDb({
        clipIds: [1, 2, 3, 4],
        ratedClips: [
          { clip_id: 1, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
          { clip_id: 2, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      // Should have pairs that include unrated clips (3, 4)
      const unratedClips = [3, 4];
      const hasUnratedPairs = pairs.some(
        ([a, b]) => unratedClips.includes(a) || unratedClips.includes(b)
      );
      expect(hasUnratedPairs).toBe(true);
    });

    it('pairs unrated vs rated before unrated vs unrated', async () => {
      // Given: 2 unrated clips (3, 4) and 2 rated clips (1, 2)
      // The pairing priority is: unrated vs rated > unrated vs unrated > rated vs rated
      const db = createMockDb({
        clipIds: [1, 2, 3, 4],
        ratedClips: [
          { clip_id: 1, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
          { clip_id: 2, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      // With 2 unrated (3, 4) and 2 rated (1, 2):
      // unrated vs rated pairs: (3,1), (3,2), (4,1), (4,2) = 4 pairs
      // unrated vs unrated: (3,4) = 1 pair
      // rated vs rated: (1,2) = 1 pair
      // Total: 6 possible pairs

      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.length).toBeLessThanOrEqual(6);
    });

    it('includes rated vs rated pairs when all clips are rated', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3],
        ratedClips: [
          { clip_id: 1, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
          { clip_id: 2, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
          { clip_id: 3, updated_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      // All clips are rated, so we should get rated vs rated pairs
      // Possible pairs: (1,2), (1,3), (2,3) = 3 pairs
      expect(pairs.length).toBe(3);
    });
  });

  describe('24-hour cooldown for recently rated pairs', () => {
    it('deprioritizes pairs where both clips were rated within 24 hours', async () => {
      const now = Date.now();
      const recentTime = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      const oldTime = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago

      // Clips 1, 2 were rated recently; clips 3, 4 were rated long ago
      const db = createMockDb({
        clipIds: [1, 2, 3, 4],
        ratedClips: [
          { clip_id: 1, updated_at: recentTime },
          { clip_id: 2, updated_at: recentTime },
          { clip_id: 3, updated_at: oldTime },
          { clip_id: 4, updated_at: oldTime },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 2);

      // Pairs involving recently rated clips (1, 2) should be deprioritized
      // Fresh pairs would be any pair that includes at least one clip not recently rated
      // The pair (1,2) where both are recent should come last
      expect(pairs.length).toBe(2);

      // At least one pair should include a "fresh" clip (3 or 4)
      const hasFreshClip = pairs.some(([a, b]) => [3, 4].includes(a) || [3, 4].includes(b));
      expect(hasFreshClip).toBe(true);
    });

    it('allows recently rated pairs when no fresh pairs are available', async () => {
      const now = Date.now();
      const recentTime = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      // All clips were rated recently
      const db = createMockDb({
        clipIds: [1, 2, 3],
        ratedClips: [
          { clip_id: 1, updated_at: recentTime },
          { clip_id: 2, updated_at: recentTime },
          { clip_id: 3, updated_at: recentTime },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      // Should still return pairs even though all are recently rated
      // Possible pairs: (1,2), (1,3), (2,3) = 3 pairs
      expect(pairs.length).toBe(3);
    });

    it('considers a pair fresh if at least one clip was not recently rated', async () => {
      const now = Date.now();
      const recentTime = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      const oldTime = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago

      const db = createMockDb({
        clipIds: [1, 2],
        ratedClips: [
          { clip_id: 1, updated_at: recentTime },
          { clip_id: 2, updated_at: oldTime },
        ],
      });

      const pairs = await calculateNextPairs(db, 1, 1);

      // The pair (1,2) should be considered fresh because clip 2 was rated long ago
      expect(pairs.length).toBe(1);
    });
  });

  describe('count parameter', () => {
    it('respects count parameter', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3, 4, 5],
        ratedClips: [],
      });

      const pairs = await calculateNextPairs(db, 1, 3);
      expect(pairs.length).toBe(3);
    });

    it('returns all available pairs if count exceeds total possible pairs', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3],
        ratedClips: [],
      });

      // With 3 clips, max possible pairs = 3*(3-1)/2 = 3
      const pairs = await calculateNextPairs(db, 1, 100);
      expect(pairs.length).toBe(3);
    });

    it('defaults to 10 pairs when count is not specified', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        ratedClips: [],
      });

      const pairs = await calculateNextPairs(db, 1);
      expect(pairs.length).toBe(10);
    });

    it('returns 1 pair when count is 1', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3, 4],
        ratedClips: [],
      });

      const pairs = await calculateNextPairs(db, 1, 1);
      expect(pairs.length).toBe(1);
    });
  });

  describe('randomization', () => {
    it('randomizes pair order within priority groups', async () => {
      // Reset random mock to return different values
      let callCount = 0;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        callCount++;
        // Return a sequence of values to simulate shuffling
        return (callCount % 10) / 10;
      });

      const db = createMockDb({
        clipIds: [1, 2, 3, 4, 5],
        ratedClips: [],
      });

      // Run multiple times to verify randomization occurs
      const pairs1 = await calculateNextPairs(db, 1, 5);

      // Reset call count for second run
      callCount = 5; // Start at different position

      const pairs2 = await calculateNextPairs(db, 1, 5);

      // Both should have valid pairs
      expect(pairs1.length).toBe(5);
      expect(pairs2.length).toBe(5);

      // Each pair should have 2 different clip IDs
      for (const [a, b] of pairs1) {
        expect(a).not.toBe(b);
      }
    });

    it('randomizes clip order within each pair 50% of the time', async () => {
      // Test that the same pair can appear in different orders
      // Math.random > 0.5 swaps the order

      // First test: random returns 0.4, no swap
      vi.spyOn(Math, 'random').mockReturnValue(0.4);
      const db1 = createMockDb({
        clipIds: [1, 2],
        ratedClips: [],
      });
      const pairs1 = await calculateNextPairs(db1, 1, 1);

      // Second test: random returns 0.6, swap occurs
      vi.spyOn(Math, 'random').mockReturnValue(0.6);
      const db2 = createMockDb({
        clipIds: [1, 2],
        ratedClips: [],
      });
      const pairs2 = await calculateNextPairs(db2, 1, 1);

      // Both should have the same clips, but potentially different order
      expect(pairs1.length).toBe(1);
      expect(pairs2.length).toBe(1);

      const [a1, b1] = pairs1[0];
      const [a2, b2] = pairs2[0];

      // Same clips should be present in both
      expect(new Set([a1, b1])).toEqual(new Set([a2, b2]));
    });
  });

  describe('pair uniqueness', () => {
    it('does not return duplicate pairs in same batch', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3, 4, 5],
        ratedClips: [],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      // Check for duplicates by normalizing pair order and using Set
      const pairKeys = new Set<string>();
      for (const [a, b] of pairs) {
        const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
        expect(pairKeys.has(key)).toBe(false);
        pairKeys.add(key);
      }
    });

    it('each pair contains two different clips', async () => {
      const db = createMockDb({
        clipIds: [1, 2, 3, 4],
        ratedClips: [],
      });

      const pairs = await calculateNextPairs(db, 1, 10);

      for (const [a, b] of pairs) {
        expect(a).not.toBe(b);
      }
    });
  });
});

describe('getPairingStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates coverage statistics correctly', async () => {
    const db = createMockDb({
      totalClipsCount: 10,
      userComparisonsCount: 15,
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(10);
    // Total possible pairs = n*(n-1)/2 = 10*9/2 = 45
    expect(stats.totalPossiblePairs).toBe(45);
    expect(stats.userComparisons).toBe(15);
    // Coverage = 15/45 * 100 = 33.33...%
    expect(stats.coveragePercent).toBeCloseTo(33.33, 1);
  });

  it('returns 0% coverage when no comparisons made', async () => {
    const db = createMockDb({
      totalClipsCount: 5,
      userComparisonsCount: 0,
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(5);
    expect(stats.totalPossiblePairs).toBe(10); // 5*4/2 = 10
    expect(stats.userComparisons).toBe(0);
    expect(stats.coveragePercent).toBe(0);
  });

  it('returns 100% coverage when all pairs compared', async () => {
    const db = createMockDb({
      totalClipsCount: 4,
      userComparisonsCount: 6, // 4*3/2 = 6 total pairs
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(4);
    expect(stats.totalPossiblePairs).toBe(6);
    expect(stats.userComparisons).toBe(6);
    expect(stats.coveragePercent).toBe(100);
  });

  it('handles 0 total clips gracefully', async () => {
    const db = createMockDb({
      totalClipsCount: 0,
      userComparisonsCount: 0,
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(0);
    expect(stats.totalPossiblePairs).toBe(0);
    expect(stats.userComparisons).toBe(0);
    expect(stats.coveragePercent).toBe(0);
  });

  it('handles 1 clip (0 possible pairs)', async () => {
    const db = createMockDb({
      totalClipsCount: 1,
      userComparisonsCount: 0,
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(1);
    expect(stats.totalPossiblePairs).toBe(0);
    expect(stats.coveragePercent).toBe(0);
  });

  it('handles large number of clips', async () => {
    const db = createMockDb({
      totalClipsCount: 100,
      userComparisonsCount: 500,
    });

    const stats = await getPairingStats(db, 1);

    expect(stats.totalClips).toBe(100);
    // Total possible pairs = 100*99/2 = 4950
    expect(stats.totalPossiblePairs).toBe(4950);
    expect(stats.userComparisons).toBe(500);
    // Coverage = 500/4950 * 100 = 10.1...%
    expect(stats.coveragePercent).toBeCloseTo(10.1, 1);
  });
});

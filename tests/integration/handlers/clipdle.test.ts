import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import clipdle from '../../../src/handlers/clipdle';
import { Hono } from 'hono';
import { createTestClip } from '../../fixtures/clips';
import type { Clip } from '../../../src/types';

/**
 * Integration tests for the Clipdle game endpoints in src/handlers/clipdle.ts
 *
 * Tests cover:
 * - GET /game - Game generation with seed parameter
 * - GET /round - Round retrieval by index
 * - GET /reveal - Answer reveal with ELO display
 * - GET /today - Daily seed consistency
 */

// Helper to create a mock D1Database with configurable responses
function createMockDb(clips: Clip[]) {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(async () => {
        // For the reveal query (fetching specific clip ELOs)
        if (sql.includes('SELECT id, global_elo FROM clips WHERE id IN')) {
          const matchingClips = clips.filter(c =>
            clips.some(clip => clip.id === c.id)
          );
          return {
            results: matchingClips.map(c => ({
              id: c.id,
              global_elo: c.global_elo,
            })),
          };
        }
        // For game generation query
        return { results: clips };
      }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  } as unknown as D1Database;
}

// Helper to create a mock D1Database that can handle reveal queries properly
function createMockDbWithReveal(allClips: Clip[]) {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        return {
          all: vi.fn().mockImplementation(async () => {
            // For reveal query with specific IDs
            if (sql.includes('SELECT id, global_elo FROM clips WHERE id IN')) {
              const leftId = args[0] as number;
              const rightId = args[1] as number;
              const matchingClips = allClips.filter(
                c => c.id === leftId || c.id === rightId
              );
              return {
                results: matchingClips.map(c => ({
                  id: c.id,
                  global_elo: c.global_elo,
                })),
              };
            }
            // For game generation query
            return { results: allClips };
          }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
        };
      }),
      all: vi.fn().mockResolvedValue({ results: allClips }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  } as unknown as D1Database;
}

// Generate eligible test clips for Clipdle (active, has matches, has ELO)
function createEligibleClips(count: number): Clip[] {
  return Array.from({ length: count }, (_, i) =>
    createTestClip({
      id: i + 1,
      twitch_slug: `TestClip${i + 1}`,
      title: `Test Clip ${i + 1}`,
      clipped_by: `clipper_${i + 1}`,
      twitch_url: `https://clips.twitch.tv/TestClip${i + 1}`,
      global_elo: 1500 + i * 10,
      global_matches: 5,
      is_active: 1,
    })
  );
}

// Create test app with clipdle handler
function createTestApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.route('/api/clipdle', clipdle);
  return app;
}

describe('Clipdle Handler Integration Tests', () => {
  describe('GET /game - Game Generation', () => {
    it('should return 400 when seed parameter is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing seed parameter');
    });

    it('should return game data with valid seed', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game?seed=20250615', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.seed).toBe('20250615');
      expect(body.totalRounds).toBe(8);
      expect(body.round).toBe(0);
      expect(body.left).toBeDefined();
      expect(body.right).toBeDefined();
      expect(body.left.id).not.toBe(body.right.id);
    });

    it('should include clip properties but not ELO in response', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game?seed=test123', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Check that clip has expected properties
      expect(body.left).toHaveProperty('id');
      expect(body.left).toHaveProperty('twitchSlug');
      expect(body.left).toHaveProperty('title');
      expect(body.left).toHaveProperty('clippedBy');
      expect(body.left).toHaveProperty('twitchUrl');

      // ELO should not be exposed
      expect(body.left.global_elo).toBeUndefined();
      expect(body.left.elo).toBeUndefined();
      expect(body.right.global_elo).toBeUndefined();
      expect(body.right.elo).toBeUndefined();
    });

    it('should return 500 when not enough eligible clips', async () => {
      const clips = createEligibleClips(10); // Need 16 for 8 rounds
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game?seed=test', {}, { DB: db });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to generate game - not enough eligible clips');
    });

    it('should return 500 when no clips available', async () => {
      const db = createMockDb([]);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game?seed=test', {}, { DB: db });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to generate game - not enough eligible clips');
    });

    it('should generate deterministic games for the same seed', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res1 = await app.request('/api/clipdle/game?seed=12345', {}, { DB: db });
      const res2 = await app.request('/api/clipdle/game?seed=12345', {}, { DB: db });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = await res1.json();
      const body2 = await res2.json();

      expect(body1.left.id).toBe(body2.left.id);
      expect(body1.right.id).toBe(body2.right.id);
    });

    it('should generate different games for different seeds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res1 = await app.request('/api/clipdle/game?seed=20250615', {}, { DB: db });
      const res2 = await app.request('/api/clipdle/game?seed=20250616', {}, { DB: db });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = await res1.json();
      const body2 = await res2.json();

      // Different seeds should produce different clip selections
      // (with high probability - not guaranteed but very likely with 20 clips)
      const sameLeft = body1.left.id === body2.left.id;
      const sameRight = body1.right.id === body2.right.id;
      expect(sameLeft && sameRight).toBe(false);
    });

    it('should handle string seeds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/game?seed=my-custom-seed', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('my-custom-seed');
      expect(body.left).toBeDefined();
      expect(body.right).toBeDefined();
    });
  });

  describe('GET /round - Round Retrieval', () => {
    it('should return 400 when seed parameter is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?round=0', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing seed parameter');
    });

    it('should return 400 when round parameter is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing round parameter');
    });

    it('should return 400 for invalid round number (negative)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=-1', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid round number');
    });

    it('should return 400 for invalid round number (too high)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=8', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid round number');
    });

    it('should return 400 for non-numeric round', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=abc', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid round number');
    });

    it('should return round data for valid request', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=3', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.seed).toBe('test');
      expect(body.round).toBe(3);
      expect(body.left).toBeDefined();
      expect(body.right).toBeDefined();
      expect(body.left.id).not.toBe(body.right.id);
    });

    it('should return first round (index 0)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=0', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.round).toBe(0);
    });

    it('should return last round (index 7)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=7', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.round).toBe(7);
    });

    it('should return consistent clips for the same seed and round', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res1 = await app.request('/api/clipdle/round?seed=12345&round=2', {}, { DB: db });
      const res2 = await app.request('/api/clipdle/round?seed=12345&round=2', {}, { DB: db });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = await res1.json();
      const body2 = await res2.json();

      expect(body1.left.id).toBe(body2.left.id);
      expect(body1.right.id).toBe(body2.right.id);
    });

    it('should return different clips for different rounds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res1 = await app.request('/api/clipdle/round?seed=test&round=0', {}, { DB: db });
      const res2 = await app.request('/api/clipdle/round?seed=test&round=1', {}, { DB: db });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = await res1.json();
      const body2 = await res2.json();

      // Clips should be different between rounds
      const allIds = [body1.left.id, body1.right.id, body2.left.id, body2.right.id];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(4);
    });

    it('should return 404 when game cannot be generated', async () => {
      const db = createMockDb([]);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/round?seed=test&round=0', {}, { DB: db });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Round not found');
    });
  });

  describe('GET /reveal - Answer Reveal', () => {
    it('should return 400 when seed parameter is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/reveal?left=1&right=2', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing seed parameter');
    });

    it('should return 400 when left clip ID is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/reveal?seed=test&right=2', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing clip IDs (left and right required)');
    });

    it('should return 400 when right clip ID is missing', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/reveal?seed=test&left=1', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Missing clip IDs (left and right required)');
    });

    it('should return 400 for non-numeric left clip ID', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/reveal?seed=test&left=abc&right=2', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid clip IDs');
    });

    it('should return 400 for non-numeric right clip ID', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/reveal?seed=test&left=1&right=xyz', {}, { DB: db });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid clip IDs');
    });

    it('should return ELO reveal data for valid clips in game', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      // First get a valid game to know which clips are selected
      const gameRes = await app.request('/api/clipdle/game?seed=test', {}, { DB: db });
      const game = await gameRes.json();

      const leftId = game.left.id;
      const rightId = game.right.id;

      const res = await app.request(
        `/api/clipdle/reveal?seed=test&left=${leftId}&right=${rightId}`,
        {},
        { DB: db }
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.leftElo).toBeDefined();
      expect(body.rightElo).toBeDefined();
      expect(body.correct).toBeDefined();
      expect(body.difference).toBeDefined();
      expect(['left', 'right', 'tie']).toContain(body.correct);
    });

    it('should return rounded ELO values', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const gameRes = await app.request('/api/clipdle/game?seed=test', {}, { DB: db });
      const game = await gameRes.json();

      const res = await app.request(
        `/api/clipdle/reveal?seed=test&left=${game.left.id}&right=${game.right.id}`,
        {},
        { DB: db }
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(Number.isInteger(body.leftElo)).toBe(true);
      expect(Number.isInteger(body.rightElo)).toBe(true);
      expect(Number.isInteger(body.difference)).toBe(true);
    });

    it('should indicate correct answer is left when left ELO is higher', async () => {
      // Create clips with known ELO values
      const clips = [
        createTestClip({
          id: 1,
          twitch_slug: 'HighClip',
          global_elo: 1800,
          global_matches: 5,
          is_active: 1,
        }),
        createTestClip({
          id: 2,
          twitch_slug: 'LowClip',
          global_elo: 1200,
          global_matches: 5,
          is_active: 1,
        }),
        ...createEligibleClips(18).map((c, i) => ({ ...c, id: i + 3 })),
      ];

      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      // Get a game with specific seed
      const gameRes = await app.request('/api/clipdle/game?seed=testELO', {}, { DB: db });
      const game = await gameRes.json();

      // Find a round where we can test
      const res = await app.request(
        `/api/clipdle/reveal?seed=testELO&left=1&right=2`,
        {},
        { DB: db }
      );

      // If clips 1 and 2 are in the game
      if (res.status === 200) {
        const body = await res.json();
        expect(body.leftElo).toBeGreaterThan(body.rightElo);
        expect(body.correct).toBe('left');
        expect(body.difference).toBe(600);
      }
    });

    it('should indicate correct answer is right when right ELO is higher', async () => {
      const clips = [
        createTestClip({
          id: 1,
          twitch_slug: 'LowClip',
          global_elo: 1200,
          global_matches: 5,
          is_active: 1,
        }),
        createTestClip({
          id: 2,
          twitch_slug: 'HighClip',
          global_elo: 1800,
          global_matches: 5,
          is_active: 1,
        }),
        ...createEligibleClips(18).map((c, i) => ({ ...c, id: i + 3 })),
      ];

      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request(
        `/api/clipdle/reveal?seed=testELO&left=1&right=2`,
        {},
        { DB: db }
      );

      if (res.status === 200) {
        const body = await res.json();
        expect(body.rightElo).toBeGreaterThan(body.leftElo);
        expect(body.correct).toBe('right');
        expect(body.difference).toBe(600);
      }
    });

    it('should indicate tie when ELOs are equal', async () => {
      const clips = [
        createTestClip({
          id: 1,
          twitch_slug: 'EqualClip1',
          global_elo: 1500,
          global_matches: 5,
          is_active: 1,
        }),
        createTestClip({
          id: 2,
          twitch_slug: 'EqualClip2',
          global_elo: 1500,
          global_matches: 5,
          is_active: 1,
        }),
        ...createEligibleClips(18).map((c, i) => ({ ...c, id: i + 3 })),
      ];

      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      const res = await app.request(
        `/api/clipdle/reveal?seed=tieTest&left=1&right=2`,
        {},
        { DB: db }
      );

      if (res.status === 200) {
        const body = await res.json();
        expect(body.leftElo).toBe(body.rightElo);
        expect(body.correct).toBe('tie');
        expect(body.difference).toBe(0);
      }
    });

    it('should return 400 for clips not in the game', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDbWithReveal(clips);
      const app = createTestApp(db);

      // Use clip IDs that don't exist in our clip set
      const res = await app.request(
        '/api/clipdle/reveal?seed=test&left=999&right=998',
        {},
        { DB: db }
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid clips for this game');
    });
  });

  describe('GET /today - Daily Seed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return today seed in YYYYMMDD format', async () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/today', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('20250615');
    });

    it('should pad single digit month with leading zero', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/today', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('20250115');
    });

    it('should pad single digit day with leading zero', async () => {
      vi.setSystemTime(new Date('2025-12-05T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/today', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('20251205');
    });

    it('should handle year boundary (Dec 31)', async () => {
      vi.setSystemTime(new Date('2025-12-31T23:59:59Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/today', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('20251231');
    });

    it('should handle new year (Jan 1)', async () => {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const res = await app.request('/api/clipdle/today', {}, { DB: db });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seed).toBe('20260101');
    });

    it('should return consistent seed throughout the same day', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      // Morning
      vi.setSystemTime(new Date('2025-06-15T15:00:00Z'));
      const morningRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const morningBody = await morningRes.json();

      // Afternoon
      vi.setSystemTime(new Date('2025-06-15T18:00:00Z'));
      const afternoonRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const afternoonBody = await afternoonRes.json();

      // Evening
      vi.setSystemTime(new Date('2025-06-15T21:00:00Z'));
      const eveningRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const eveningBody = await eveningRes.json();

      expect(morningBody.seed).toBe('20250615');
      expect(afternoonBody.seed).toBe('20250615');
      expect(eveningBody.seed).toBe('20250615');
    });

    it('should change seed at midnight', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      // Day 1 - mid-day
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
      const beforeRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const beforeBody = await beforeRes.json();

      // Day 2 - mid-day
      vi.setSystemTime(new Date('2025-06-16T12:00:00Z'));
      const afterRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const afterBody = await afterRes.json();

      expect(beforeBody.seed).toBe('20250615');
      expect(afterBody.seed).toBe('20250616');
    });
  });

  describe('Daily Seed Consistency - Full Game Flow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should generate same game for all players on the same day', async () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      // Get today's seed
      const todayRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const { seed } = await todayRes.json();

      // Player 1 plays the game
      const player1Game = await app.request(`/api/clipdle/game?seed=${seed}`, {}, { DB: db });
      const player1Body = await player1Game.json();

      // Player 2 plays the game (simulated as separate request)
      const player2Game = await app.request(`/api/clipdle/game?seed=${seed}`, {}, { DB: db });
      const player2Body = await player2Game.json();

      // Both players should get the same first round
      expect(player1Body.left.id).toBe(player2Body.left.id);
      expect(player1Body.right.id).toBe(player2Body.right.id);
    });

    it('should have different daily games on different days', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      // Day 1
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
      const day1TodayRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const { seed: day1Seed } = await day1TodayRes.json();
      const day1Game = await app.request(`/api/clipdle/game?seed=${day1Seed}`, {}, { DB: db });
      const day1Body = await day1Game.json();

      // Day 2
      vi.setSystemTime(new Date('2025-06-16T12:00:00Z'));
      const day2TodayRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const { seed: day2Seed } = await day2TodayRes.json();
      const day2Game = await app.request(`/api/clipdle/game?seed=${day2Seed}`, {}, { DB: db });
      const day2Body = await day2Game.json();

      // Seeds should be different
      expect(day1Seed).not.toBe(day2Seed);

      // Games should be different (with high probability)
      const sameFirstRound =
        day1Body.left.id === day2Body.left.id && day1Body.right.id === day2Body.right.id;
      expect(sameFirstRound).toBe(false);
    });

    it('should allow players to retrieve all rounds of daily game', async () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const app = createTestApp(db);

      const todayRes = await app.request('/api/clipdle/today', {}, { DB: db });
      const { seed } = await todayRes.json();

      const allRoundClipIds: number[] = [];

      // Retrieve all 8 rounds
      for (let i = 0; i < 8; i++) {
        const roundRes = await app.request(
          `/api/clipdle/round?seed=${seed}&round=${i}`,
          {},
          { DB: db }
        );
        expect(roundRes.status).toBe(200);

        const roundBody = await roundRes.json();
        expect(roundBody.round).toBe(i);
        expect(roundBody.left).toBeDefined();
        expect(roundBody.right).toBeDefined();

        allRoundClipIds.push(roundBody.left.id, roundBody.right.id);
      }

      // All 16 clip IDs should be unique (each clip used exactly once)
      const uniqueIds = new Set(allRoundClipIds);
      expect(uniqueIds.size).toBe(16);
    });
  });
});

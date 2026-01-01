import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseSeed,
  getTodaySeed,
  getClipdleGame,
  getClipdleRound,
  type ClipdleGame,
  type ClipdleRound,
} from '../../../src/services/clipdleSeed';
import { createTestClip } from '../../fixtures/clips';
import type { Clip } from '../../../src/types';

/**
 * Helper to create a mock D1Database
 */
function createMockDb(clips: Clip[]) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: clips }),
      }),
    }),
  } as unknown as D1Database;
}

/**
 * Generate a list of eligible test clips for Clipdle
 */
function createEligibleClips(count: number): Clip[] {
  return Array.from({ length: count }, (_, i) =>
    createTestClip({
      id: i + 1,
      twitch_slug: `TestClip${i + 1}`,
      title: `Test Clip ${i + 1}`,
      clipped_by: `clipper_${i + 1}`,
      twitch_url: `https://clips.twitch.tv/TestClip${i + 1}`,
      global_elo: 1500 + i * 10,
      global_matches: 5, // Meets MIN_MATCHES requirement
      is_active: 1,
    })
  );
}

describe('clipdleSeed service', () => {
  describe('parseSeed', () => {
    describe('numeric string seeds', () => {
      it('should parse a simple numeric string', () => {
        expect(parseSeed('12345')).toBe(12345);
      });

      it('should parse zero as a seed', () => {
        expect(parseSeed('0')).toBe(0);
      });

      it('should parse large numeric strings', () => {
        expect(parseSeed('20250101')).toBe(20250101);
      });

      it('should parse negative numeric strings', () => {
        // parseInt will parse -123 as -123
        expect(parseSeed('-123')).toBe(-123);
      });
    });

    describe('string seed hashing (deterministic)', () => {
      it('should hash non-numeric strings', () => {
        const result = parseSeed('hello');
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
      });

      it('should return the same hash for the same string', () => {
        const hash1 = parseSeed('my-custom-seed');
        const hash2 = parseSeed('my-custom-seed');
        expect(hash1).toBe(hash2);
      });

      it('should return different hashes for different strings', () => {
        const hash1 = parseSeed('seed-a');
        const hash2 = parseSeed('seed-b');
        expect(hash1).not.toBe(hash2);
      });

      it('should handle empty string', () => {
        const result = parseSeed('');
        expect(typeof result).toBe('number');
        expect(result).toBe(0); // Empty string produces hash of 0
      });

      it('should handle special characters', () => {
        const result = parseSeed('!@#$%^&*()');
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
      });

      it('should handle unicode characters', () => {
        const result = parseSeed('\u{1F600}\u{1F601}\u{1F602}');
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('getTodaySeed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should return YYYYMMDD format', () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
      expect(getTodaySeed()).toBe('20250615');
    });

    it('should pad single digit months with leading zero', () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      expect(getTodaySeed()).toBe('20250115');
    });

    it('should pad single digit days with leading zero', () => {
      vi.setSystemTime(new Date('2025-12-05T12:00:00Z'));
      expect(getTodaySeed()).toBe('20251205');
    });

    it('should handle year boundaries correctly', () => {
      vi.setSystemTime(new Date('2025-12-31T23:59:59Z'));
      expect(getTodaySeed()).toBe('20251231');
    });

    it('should handle new year correctly', () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      expect(getTodaySeed()).toBe('20260101');
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });

  describe('deterministic game generation', () => {
    it('should generate the same game for the same seed', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = '20250615';

      const game1 = await getClipdleGame(db, seed, 8);
      const game2 = await getClipdleGame(db, seed, 8);

      expect(game1).not.toBeNull();
      expect(game2).not.toBeNull();
      expect(game1!.rounds).toEqual(game2!.rounds);
      expect(game1!.clipIds).toEqual(game2!.clipIds);
    });

    it('should generate different games for different seeds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game1 = await getClipdleGame(db, '20250615', 8);
      const game2 = await getClipdleGame(db, '20250616', 8);

      expect(game1).not.toBeNull();
      expect(game2).not.toBeNull();
      // Different seeds should produce different clip orders
      expect(game1!.clipIds).not.toEqual(game2!.clipIds);
    });

    it('should maintain determinism with string seeds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = 'custom-game-seed';

      const game1 = await getClipdleGame(db, seed, 8);
      const game2 = await getClipdleGame(db, seed, 8);

      expect(game1).not.toBeNull();
      expect(game2).not.toBeNull();
      expect(game1!.rounds).toEqual(game2!.rounds);
    });
  });

  describe('seeded shuffle using Fisher-Yates', () => {
    it('should shuffle clips deterministically', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game1 = await getClipdleGame(db, '12345', 8);
      const game2 = await getClipdleGame(db, '12345', 8);

      expect(game1).not.toBeNull();
      expect(game2).not.toBeNull();
      expect(game1!.clipIds).toEqual(game2!.clipIds);
    });

    it('should produce a different order than the original', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const originalOrder = clips.slice(0, 16).map((c) => c.id);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      // With high probability, the shuffled order differs from original
      expect(game!.clipIds).not.toEqual(originalOrder);
    });

    it('should include only the required number of clips', async () => {
      const clips = createEligibleClips(30);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      expect(game!.clipIds.length).toBe(16); // 8 rounds * 2 clips per round
    });
  });

  describe('game generation with correct round count', () => {
    it('should generate the default 8 rounds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345');

      expect(game).not.toBeNull();
      expect(game!.totalRounds).toBe(8);
      expect(game!.rounds.length).toBe(8);
    });

    it('should generate custom round counts', async () => {
      const clips = createEligibleClips(30);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 10);

      expect(game).not.toBeNull();
      expect(game!.totalRounds).toBe(10);
      expect(game!.rounds.length).toBe(10);
    });

    it('should generate 5 rounds when requested', async () => {
      const clips = createEligibleClips(15);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 5);

      expect(game).not.toBeNull();
      expect(game!.totalRounds).toBe(5);
      expect(game!.rounds.length).toBe(5);
      expect(game!.clipIds.length).toBe(10); // 5 * 2
    });

    it('should return null when not enough eligible clips', async () => {
      const clips = createEligibleClips(10); // Not enough for 8 rounds (need 16)
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).toBeNull();
    });

    it('should return null when no clips available', async () => {
      const db = createMockDb([]);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).toBeNull();
    });
  });

  describe('clip pairing logic', () => {
    it('should create pairs with left and right clips', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      game!.rounds.forEach((round) => {
        expect(round.left).toBeDefined();
        expect(round.right).toBeDefined();
        expect(round.left.id).not.toBe(round.right.id);
      });
    });

    it('should sanitize clips (hide ELO)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      game!.rounds.forEach((round) => {
        // Sanitized clips should not have ELO
        expect((round.left as any).global_elo).toBeUndefined();
        expect((round.right as any).global_elo).toBeUndefined();
        // But should have required fields
        expect(round.left.id).toBeDefined();
        expect(round.left.twitchSlug).toBeDefined();
        expect(round.left.twitchUrl).toBeDefined();
      });
    });

    it('should use all selected clips exactly once', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      const usedIds = new Set<number>();
      game!.rounds.forEach((round) => {
        usedIds.add(round.left.id);
        usedIds.add(round.right.id);
      });
      expect(usedIds.size).toBe(16); // All 16 clips used exactly once
    });

    it('should deterministically assign left/right positions', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game1 = await getClipdleGame(db, '12345', 8);
      const game2 = await getClipdleGame(db, '12345', 8);

      expect(game1).not.toBeNull();
      expect(game2).not.toBeNull();
      game1!.rounds.forEach((round, i) => {
        expect(round.left.id).toBe(game2!.rounds[i].left.id);
        expect(round.right.id).toBe(game2!.rounds[i].right.id);
      });
    });
  });

  describe('round retrieval by index', () => {
    it('should retrieve a specific round by index', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = '12345';

      const game = await getClipdleGame(db, seed, 8);
      const round = await getClipdleRound(db, seed, 3, 8);

      expect(round).not.toBeNull();
      expect(round).toEqual(game!.rounds[3]);
    });

    it('should retrieve the first round (index 0)', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = '12345';

      const game = await getClipdleGame(db, seed, 8);
      const round = await getClipdleRound(db, seed, 0, 8);

      expect(round).not.toBeNull();
      expect(round).toEqual(game!.rounds[0]);
    });

    it('should retrieve the last round', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = '12345';

      const game = await getClipdleGame(db, seed, 8);
      const round = await getClipdleRound(db, seed, 7, 8);

      expect(round).not.toBeNull();
      expect(round).toEqual(game!.rounds[7]);
    });

    it('should return the same round for the same seed and index', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = '12345';

      const round1 = await getClipdleRound(db, seed, 2, 8);
      const round2 = await getClipdleRound(db, seed, 2, 8);

      expect(round1).not.toBeNull();
      expect(round2).not.toBeNull();
      expect(round1).toEqual(round2);
    });
  });

  describe('invalid round index handling', () => {
    it('should return null for negative round index', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const round = await getClipdleRound(db, '12345', -1, 8);

      expect(round).toBeNull();
    });

    it('should return null for round index equal to total rounds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const round = await getClipdleRound(db, '12345', 8, 8);

      expect(round).toBeNull();
    });

    it('should return null for round index exceeding total rounds', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const round = await getClipdleRound(db, '12345', 100, 8);

      expect(round).toBeNull();
    });

    it('should return null when game cannot be generated', async () => {
      const db = createMockDb([]);

      const round = await getClipdleRound(db, '12345', 0, 8);

      expect(round).toBeNull();
    });
  });

  describe('game structure', () => {
    it('should include seed in the game object', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);
      const seed = 'my-test-seed';

      const game = await getClipdleGame(db, seed, 8);

      expect(game).not.toBeNull();
      expect(game!.seed).toBe(seed);
    });

    it('should include clipIds for validation', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      expect(game!.clipIds).toBeDefined();
      expect(Array.isArray(game!.clipIds)).toBe(true);
      expect(game!.clipIds.length).toBe(16);
    });

    it('should have ClipdleClip structure with required fields', async () => {
      const clips = createEligibleClips(20);
      const db = createMockDb(clips);

      const game = await getClipdleGame(db, '12345', 8);

      expect(game).not.toBeNull();
      const firstRound = game!.rounds[0];

      // Check left clip structure
      expect(firstRound.left).toHaveProperty('id');
      expect(firstRound.left).toHaveProperty('twitchSlug');
      expect(firstRound.left).toHaveProperty('title');
      expect(firstRound.left).toHaveProperty('clippedBy');
      expect(firstRound.left).toHaveProperty('twitchUrl');

      // Check right clip structure
      expect(firstRound.right).toHaveProperty('id');
      expect(firstRound.right).toHaveProperty('twitchSlug');
      expect(firstRound.right).toHaveProperty('title');
      expect(firstRound.right).toHaveProperty('clippedBy');
      expect(firstRound.right).toHaveProperty('twitchUrl');
    });
  });
});

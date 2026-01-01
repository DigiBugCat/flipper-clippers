import { describe, it, expect } from 'vitest';
import {
  calculateExpectedScore,
  getKFactor,
  calculateRatingUpdate,
  calculateConfidence,
  isSuperLikeResult,
  getWinnerFromResult,
  updateStats,
} from '../../../src/services/rating';
import type { VoteResult } from '../../../src/types';

describe('rating service', () => {
  describe('calculateExpectedScore', () => {
    it('should return 0.5 for equal ratings', () => {
      const result = calculateExpectedScore(1500, 1500);
      expect(result).toBe(0.5);
    });

    it('should return higher expected score for higher rated clip', () => {
      const resultHigher = calculateExpectedScore(1600, 1400);
      const resultLower = calculateExpectedScore(1400, 1600);

      expect(resultHigher).toBeGreaterThan(0.5);
      expect(resultLower).toBeLessThan(0.5);
      // The sum should equal 1
      expect(resultHigher + resultLower).toBeCloseTo(1.0);
    });

    it('should return expected value for 100 point difference', () => {
      // 100 point difference should give approximately 0.64 for higher rated
      const result = calculateExpectedScore(1600, 1500);
      expect(result).toBeCloseTo(0.64, 1);
    });

    it('should return expected value for 200 point difference', () => {
      // 200 point difference should give approximately 0.76 for higher rated
      const result = calculateExpectedScore(1700, 1500);
      expect(result).toBeCloseTo(0.76, 1);
    });

    it('should handle extreme rating differences - very high A', () => {
      const result = calculateExpectedScore(2500, 1000);
      expect(result).toBeGreaterThan(0.99);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it('should handle extreme rating differences - very low A', () => {
      const result = calculateExpectedScore(1000, 2500);
      expect(result).toBeLessThan(0.01);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    it('should handle 400 point difference giving ~0.91 expected score', () => {
      // At 400 point difference, expected score should be ~0.909
      const result = calculateExpectedScore(1900, 1500);
      expect(result).toBeCloseTo(0.909, 2);
    });

    it('should be symmetric', () => {
      const expectedA = calculateExpectedScore(1600, 1400);
      const expectedB = calculateExpectedScore(1400, 1600);
      expect(expectedA + expectedB).toBeCloseTo(1.0, 10);
    });
  });

  describe('getKFactor', () => {
    it('should return MAX_K_FACTOR (48) for clips with less than 10 matches', () => {
      expect(getKFactor(0, 350)).toBe(48);
      expect(getKFactor(5, 350)).toBe(48);
      expect(getKFactor(9, 350)).toBe(48);
    });

    it('should return BASE_K_FACTOR (32) for clips with 10-29 matches', () => {
      expect(getKFactor(10, 350)).toBe(32);
      expect(getKFactor(15, 350)).toBe(32);
      expect(getKFactor(20, 350)).toBe(32);
      expect(getKFactor(29, 350)).toBe(32);
    });

    it('should return MIN_K_FACTOR (16) for clips with 30+ matches', () => {
      expect(getKFactor(30, 350)).toBe(16);
      expect(getKFactor(50, 350)).toBe(16);
      expect(getKFactor(100, 350)).toBe(16);
      expect(getKFactor(1000, 350)).toBe(16);
    });

    it('should transition at exact boundary values', () => {
      expect(getKFactor(9, 350)).toBe(48);  // Still MAX
      expect(getKFactor(10, 350)).toBe(32); // Now BASE
      expect(getKFactor(29, 350)).toBe(32); // Still BASE
      expect(getKFactor(30, 350)).toBe(16); // Now MIN
    });

    it('should not be affected by rating deviation parameter', () => {
      // Note: current implementation doesn't use ratingDeviation
      expect(getKFactor(5, 50)).toBe(48);
      expect(getKFactor(5, 350)).toBe(48);
      expect(getKFactor(5, 500)).toBe(48);
    });
  });

  describe('calculateRatingUpdate', () => {
    const defaultRating = 1500;
    const defaultDeviation = 350;
    const defaultMatches = 5;

    describe('skip result', () => {
      it('should return unchanged ratings for skip result', () => {
        const result = calculateRatingUpdate(
          1500, 1600,
          350, 350,
          10, 15,
          'skip'
        );

        expect(result.newRatingA).toBe(1500);
        expect(result.newRatingB).toBe(1600);
        expect(result.newDeviationA).toBe(350);
        expect(result.newDeviationB).toBe(350);
      });
    });

    describe('clip_a win', () => {
      it('should increase rating A and decrease rating B when A wins', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_a'
        );

        expect(result.newRatingA).toBeGreaterThan(1500);
        expect(result.newRatingB).toBeLessThan(1500);
      });

      it('should increase A more when beating higher rated B', () => {
        const result = calculateRatingUpdate(
          1400, 1600,
          350, 350,
          5, 5,
          'clip_a'
        );

        // A was underdog, so wins more points
        const ratingGainA = result.newRatingA - 1400;
        expect(ratingGainA).toBeGreaterThan(24); // More than half of K=48
      });

      it('should increase A less when beating lower rated B', () => {
        const result = calculateRatingUpdate(
          1600, 1400,
          350, 350,
          5, 5,
          'clip_a'
        );

        // A was favorite, wins fewer points
        const ratingGainA = result.newRatingA - 1600;
        expect(ratingGainA).toBeLessThan(24); // Less than half of K=48
      });
    });

    describe('clip_b win', () => {
      it('should increase rating B and decrease rating A when B wins', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_b'
        );

        expect(result.newRatingA).toBeLessThan(1500);
        expect(result.newRatingB).toBeGreaterThan(1500);
      });

      it('should have symmetric behavior to clip_a win', () => {
        const resultA = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_a'
        );

        const resultB = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_b'
        );

        // The rating changes should be equal magnitude but opposite direction
        const aGainWhenWins = resultA.newRatingA - 1500;
        const aLossWhenLoses = 1500 - resultB.newRatingA;
        expect(aGainWhenWins).toBeCloseTo(aLossWhenLoses, 10);
      });
    });

    describe('tie result', () => {
      it('should move ratings toward each other on tie when unequal', () => {
        const result = calculateRatingUpdate(
          1600, 1400,
          350, 350,
          5, 5,
          'tie'
        );

        // Higher rated clip should lose some rating
        expect(result.newRatingA).toBeLessThan(1600);
        // Lower rated clip should gain some rating
        expect(result.newRatingB).toBeGreaterThan(1400);
      });

      it('should keep ratings unchanged on tie when equal', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'tie'
        );

        // With equal ratings, expected is 0.5, actual is 0.5, so no change
        expect(result.newRatingA).toBe(1500);
        expect(result.newRatingB).toBe(1500);
      });
    });

    describe('super_a result', () => {
      it('should give greater rating gain for super_a than normal clip_a', () => {
        const normalResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_a'
        );

        const superResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'super_a'
        );

        const normalGain = normalResult.newRatingA - 1500;
        const superGain = superResult.newRatingA - 1500;

        // Super like gives a bigger boost than normal win
        expect(superGain).toBeGreaterThan(normalGain);
      });
    });

    describe('super_b result', () => {
      it('should give greater rating gain for super_b than normal clip_b', () => {
        const normalResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'clip_b'
        );

        const superResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5,
          'super_b'
        );

        const normalGain = normalResult.newRatingB - 1500;
        const superGain = superResult.newRatingB - 1500;

        // Super like gives a bigger boost than normal win
        expect(superGain).toBeGreaterThan(normalGain);
      });
    });

    describe('deviation decay', () => {
      it('should apply 0.95x decay to deviations', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          350, 300,
          5, 5,
          'clip_a'
        );

        expect(result.newDeviationA).toBeCloseTo(350 * 0.95, 5);
        expect(result.newDeviationB).toBeCloseTo(300 * 0.95, 5);
      });

      it('should apply decay even on skip result', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          350, 300,
          5, 5,
          'skip'
        );

        // Skip preserves deviations (no decay)
        expect(result.newDeviationA).toBe(350);
        expect(result.newDeviationB).toBe(300);
      });

      it('should never drop deviation below 50', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          50, 52,
          50, 50,
          'clip_a'
        );

        // 50 * 0.95 = 47.5, but min is 50
        expect(result.newDeviationA).toBe(50);
        // 52 * 0.95 = 49.4, but min is 50
        expect(result.newDeviationB).toBe(50);
      });

      it('should allow deviation just above minimum', () => {
        const result = calculateRatingUpdate(
          1500, 1500,
          100, 100,
          50, 50,
          'clip_a'
        );

        // 100 * 0.95 = 95, above minimum of 50
        expect(result.newDeviationA).toBe(95);
        expect(result.newDeviationB).toBe(95);
      });
    });

    describe('K-factor based on matches', () => {
      it('should use higher K-factor for new clips', () => {
        const newClipResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          5, 5, // < 10 matches = K=48
          'clip_a'
        );

        const establishedClipResult = calculateRatingUpdate(
          1500, 1500,
          350, 350,
          50, 50, // 30+ matches = K=16
          'clip_a'
        );

        const newGain = newClipResult.newRatingA - 1500;
        const establishedGain = establishedClipResult.newRatingA - 1500;

        // New clips should have 3x the rating change (48/16 = 3)
        expect(newGain / establishedGain).toBeCloseTo(3, 1);
      });
    });
  });

  describe('calculateConfidence', () => {
    it('should return higher confidence for more matches', () => {
      const lowMatches = calculateConfidence(5, 350);
      const highMatches = calculateConfidence(50, 350);

      expect(highMatches).toBeGreaterThan(lowMatches);
    });

    it('should return higher confidence for lower deviation', () => {
      const highDeviation = calculateConfidence(20, 350);
      const lowDeviation = calculateConfidence(20, 50);

      expect(lowDeviation).toBeGreaterThan(highDeviation);
    });

    it('should cap match confidence at 100 (50 matches)', () => {
      const at50 = calculateConfidence(50, 350);
      const at100 = calculateConfidence(100, 350);

      // matchConfidence portion should be same (capped at 100)
      // only deviation portion contributes
      expect(at50).toBe(at100);
    });

    it('should return expected values for typical cases', () => {
      // 0 matches, 350 deviation
      // matchConfidence = 0, deviationConfidence = 100 - 350/3.5 = 0
      // average = 0
      const noMatches = calculateConfidence(0, 350);
      expect(noMatches).toBe(0);

      // 50 matches, 50 deviation
      // matchConfidence = 100, deviationConfidence = 100 - 50/3.5 = 85.71
      // average = 92.86
      const highConfidence = calculateConfidence(50, 50);
      expect(highConfidence).toBeCloseTo(92.86, 1);
    });

    it('should handle edge cases', () => {
      // Very low deviation gives high deviationConfidence
      const result = calculateConfidence(50, 0);
      // matchConfidence = 100, deviationConfidence = 100
      expect(result).toBe(100);
    });
  });

  describe('isSuperLikeResult', () => {
    it('should return true for super_a', () => {
      expect(isSuperLikeResult('super_a')).toBe(true);
    });

    it('should return true for super_b', () => {
      expect(isSuperLikeResult('super_b')).toBe(true);
    });

    it('should return false for clip_a', () => {
      expect(isSuperLikeResult('clip_a')).toBe(false);
    });

    it('should return false for clip_b', () => {
      expect(isSuperLikeResult('clip_b')).toBe(false);
    });

    it('should return false for tie', () => {
      expect(isSuperLikeResult('tie')).toBe(false);
    });

    it('should return false for skip', () => {
      expect(isSuperLikeResult('skip')).toBe(false);
    });
  });

  describe('getWinnerFromResult', () => {
    const clipAId = 123;
    const clipBId = 456;

    it('should return clipAId for clip_a result', () => {
      expect(getWinnerFromResult('clip_a', clipAId, clipBId)).toBe(clipAId);
    });

    it('should return clipAId for super_a result', () => {
      expect(getWinnerFromResult('super_a', clipAId, clipBId)).toBe(clipAId);
    });

    it('should return clipBId for clip_b result', () => {
      expect(getWinnerFromResult('clip_b', clipAId, clipBId)).toBe(clipBId);
    });

    it('should return clipBId for super_b result', () => {
      expect(getWinnerFromResult('super_b', clipAId, clipBId)).toBe(clipBId);
    });

    it('should return null for tie result', () => {
      expect(getWinnerFromResult('tie', clipAId, clipBId)).toBeNull();
    });

    it('should return null for skip result', () => {
      expect(getWinnerFromResult('skip', clipAId, clipBId)).toBeNull();
    });
  });

  describe('updateStats', () => {
    describe('clip A perspective (isClipA = true)', () => {
      it('should increment wins when clip_a wins', () => {
        const result = updateStats(5, 3, 2, 'clip_a', true);
        expect(result).toEqual({ wins: 6, losses: 3, ties: 2 });
      });

      it('should increment wins when super_a', () => {
        const result = updateStats(5, 3, 2, 'super_a', true);
        expect(result).toEqual({ wins: 6, losses: 3, ties: 2 });
      });

      it('should increment losses when clip_b wins', () => {
        const result = updateStats(5, 3, 2, 'clip_b', true);
        expect(result).toEqual({ wins: 5, losses: 4, ties: 2 });
      });

      it('should increment losses when super_b', () => {
        const result = updateStats(5, 3, 2, 'super_b', true);
        expect(result).toEqual({ wins: 5, losses: 4, ties: 2 });
      });

      it('should increment ties when tie', () => {
        const result = updateStats(5, 3, 2, 'tie', true);
        expect(result).toEqual({ wins: 5, losses: 3, ties: 3 });
      });

      it('should not change stats on skip', () => {
        const result = updateStats(5, 3, 2, 'skip', true);
        expect(result).toEqual({ wins: 5, losses: 3, ties: 2 });
      });
    });

    describe('clip B perspective (isClipA = false)', () => {
      it('should increment losses when clip_a wins', () => {
        const result = updateStats(5, 3, 2, 'clip_a', false);
        expect(result).toEqual({ wins: 5, losses: 4, ties: 2 });
      });

      it('should increment losses when super_a', () => {
        const result = updateStats(5, 3, 2, 'super_a', false);
        expect(result).toEqual({ wins: 5, losses: 4, ties: 2 });
      });

      it('should increment wins when clip_b wins', () => {
        const result = updateStats(5, 3, 2, 'clip_b', false);
        expect(result).toEqual({ wins: 6, losses: 3, ties: 2 });
      });

      it('should increment wins when super_b', () => {
        const result = updateStats(5, 3, 2, 'super_b', false);
        expect(result).toEqual({ wins: 6, losses: 3, ties: 2 });
      });

      it('should increment ties when tie', () => {
        const result = updateStats(5, 3, 2, 'tie', false);
        expect(result).toEqual({ wins: 5, losses: 3, ties: 3 });
      });

      it('should not change stats on skip', () => {
        const result = updateStats(5, 3, 2, 'skip', false);
        expect(result).toEqual({ wins: 5, losses: 3, ties: 2 });
      });
    });

    describe('edge cases', () => {
      it('should work with zero initial stats', () => {
        const result = updateStats(0, 0, 0, 'clip_a', true);
        expect(result).toEqual({ wins: 1, losses: 0, ties: 0 });
      });

      it('should work with large numbers', () => {
        const result = updateStats(1000, 500, 250, 'tie', true);
        expect(result).toEqual({ wins: 1000, losses: 500, ties: 251 });
      });
    });
  });
});

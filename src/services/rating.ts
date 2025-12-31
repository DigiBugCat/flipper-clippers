import type { UserClipRating, VoteResult } from '../types';

// ELO Configuration
const BASE_K_FACTOR = 32;
const MIN_K_FACTOR = 16;
const MAX_K_FACTOR = 48;
const SUPER_LIKE_MULTIPLIER = 1.5;
const MIN_RATING_DEVIATION = 50;
const DEVIATION_DECAY = 0.95;

interface RatingUpdate {
  newRatingA: number;
  newRatingB: number;
  newDeviationA: number;
  newDeviationB: number;
}

/**
 * Calculate expected score for clip A against clip B
 */
export function calculateExpectedScore(ratingA: number, ratingB: number): number {
  return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Get dynamic K-factor based on match history and uncertainty
 */
export function getKFactor(matchesPlayed: number, ratingDeviation: number): number {
  // Higher K-factor for new clips (more volatile ratings)
  if (matchesPlayed < 10) {
    return MAX_K_FACTOR;
  } else if (matchesPlayed < 30) {
    return BASE_K_FACTOR;
  } else {
    return MIN_K_FACTOR;
  }
}

/**
 * Calculate new ratings after a comparison
 */
export function calculateRatingUpdate(
  ratingA: number,
  ratingB: number,
  deviationA: number,
  deviationB: number,
  matchesA: number,
  matchesB: number,
  result: VoteResult
): RatingUpdate {
  // Skip doesn't change ratings
  if (result === 'skip') {
    return {
      newRatingA: ratingA,
      newRatingB: ratingB,
      newDeviationA: deviationA,
      newDeviationB: deviationB,
    };
  }

  const expectedA = calculateExpectedScore(ratingA, ratingB);
  const expectedB = 1.0 - expectedA;

  // Determine actual scores based on result
  let actualA: number;
  let actualB: number;
  let isSuperLike = false;

  switch (result) {
    case 'clip_a':
      actualA = 1.0;
      actualB = 0.0;
      break;
    case 'clip_b':
      actualA = 0.0;
      actualB = 1.0;
      break;
    case 'super_a':
      actualA = SUPER_LIKE_MULTIPLIER;
      actualB = 0.0;
      isSuperLike = true;
      break;
    case 'super_b':
      actualA = 0.0;
      actualB = SUPER_LIKE_MULTIPLIER;
      isSuperLike = true;
      break;
    case 'tie':
      actualA = 0.5;
      actualB = 0.5;
      break;
    default:
      actualA = 0;
      actualB = 0;
  }

  // Get K-factors
  const kA = getKFactor(matchesA, deviationA);
  const kB = getKFactor(matchesB, deviationB);

  // Calculate new ratings
  const newRatingA = ratingA + kA * (actualA - expectedA);
  const newRatingB = ratingB + kB * (actualB - expectedB);

  // Update rating deviations (decrease with more matches)
  const newDeviationA = Math.max(MIN_RATING_DEVIATION, deviationA * DEVIATION_DECAY);
  const newDeviationB = Math.max(MIN_RATING_DEVIATION, deviationB * DEVIATION_DECAY);

  return {
    newRatingA,
    newRatingB,
    newDeviationA,
    newDeviationB,
  };
}

/**
 * Calculate confidence score for a clip's rating (0-100%)
 */
export function calculateConfidence(matches: number, ratingDeviation: number): number {
  // More matches = higher confidence
  const matchConfidence = Math.min(100, matches * 2);
  // Lower deviation = higher confidence
  const deviationConfidence = Math.max(0, 100 - ratingDeviation / 3.5);
  return (matchConfidence + deviationConfidence) / 2;
}

/**
 * Check if a result is a super like
 */
export function isSuperLikeResult(result: VoteResult): boolean {
  return result === 'super_a' || result === 'super_b';
}

/**
 * Get the winner clip ID from a result
 */
export function getWinnerFromResult(result: VoteResult, clipAId: number, clipBId: number): number | null {
  switch (result) {
    case 'clip_a':
    case 'super_a':
      return clipAId;
    case 'clip_b':
    case 'super_b':
      return clipBId;
    default:
      return null;
  }
}

/**
 * Update rating stats (wins, losses, ties) based on result
 */
export function updateStats(
  currentWins: number,
  currentLosses: number,
  currentTies: number,
  result: VoteResult,
  isClipA: boolean
): { wins: number; losses: number; ties: number } {
  let wins = currentWins;
  let losses = currentLosses;
  let ties = currentTies;

  switch (result) {
    case 'clip_a':
    case 'super_a':
      if (isClipA) wins++;
      else losses++;
      break;
    case 'clip_b':
    case 'super_b':
      if (isClipA) losses++;
      else wins++;
      break;
    case 'tie':
      ties++;
      break;
  }

  return { wins, losses, ties };
}

import type { Clip } from '../types';
import { calculateConfidence } from '../services/rating';

/**
 * Basic clip response - used for ranking sessions, compare pairs, etc.
 */
export interface ClipBasic {
  id: number;
  twitchSlug: string;
  title: string | null;
  twitchUrl: string;
}

/**
 * Clip with global stats - used for clips list and leaderboard
 */
export interface ClipWithStats extends ClipBasic {
  globalElo: number;
  globalMatches: number;
  globalWins: number;
  globalLosses: number;
  globalTies: number;
  globalSuperLikes: number;
  ratingDeviation: number;
}

/**
 * Ranked clip for leaderboard - includes rank and derived stats
 */
export interface RankedClip extends ClipBasic {
  rank: number;
  elo: number;
  matches: number;
  wins: number;
  losses: number;
  ties: number;
  globalSuperLikes: number;
  winRate: number;
  confidence: number;
}

/**
 * Format a clip with just basic info (id, slug, title, url)
 */
export function formatClipBasic(clip: Clip): ClipBasic {
  return {
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    twitchUrl: clip.twitch_url,
  };
}

/**
 * Format a clip with global stats
 */
export function formatClipWithStats(clip: Clip): ClipWithStats {
  return {
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    twitchUrl: clip.twitch_url,
    globalElo: clip.global_elo,
    globalMatches: clip.global_matches,
    globalWins: clip.global_wins,
    globalLosses: clip.global_losses,
    globalTies: clip.global_ties,
    globalSuperLikes: clip.global_super_likes,
    ratingDeviation: clip.rating_deviation,
  };
}

/**
 * Format a clip for leaderboard display with rank and derived stats
 */
export function formatRankedClip(clip: Clip, rank: number): RankedClip {
  return {
    rank,
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    twitchUrl: clip.twitch_url,
    elo: Math.round(clip.global_elo),
    matches: clip.global_matches,
    wins: clip.global_wins,
    losses: clip.global_losses,
    ties: clip.global_ties,
    globalSuperLikes: clip.global_super_likes,
    winRate: clip.global_matches > 0
      ? Math.round((clip.global_wins / clip.global_matches) * 100)
      : 0,
    confidence: Math.round(calculateConfidence(clip.global_matches, clip.rating_deviation)),
  };
}

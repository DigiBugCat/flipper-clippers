/**
 * Frontend TypeScript types for API responses and shared data structures
 */

// User from /api/auth/me response
export interface User {
  id: number;
  twitchUsername: string;
  displayName: string;
  profileImage: string;
  totalComparisons: number;
  totalSuperLikes: number;
  isProfilePublic: boolean;
}

// Clip from API responses
export interface Clip {
  id: number;
  twitchSlug: string;
  title: string;
  twitchUrl: string;
  clippedBy?: string;
  clippedAt?: string;
  globalElo?: number;
  globalMatches?: number;
  globalWins?: number;
  globalLosses?: number;
  globalTies?: number;
  globalSuperLikes?: number;
}

// Vote result options
export type VoteResult = 'clip_a' | 'clip_b' | 'super_a' | 'super_b' | 'tie' | 'skip';

// Clip pair for comparison
export interface ClipPair {
  clipA: Clip;
  clipB: Clip;
}

// Leaderboard entry extends Clip with ranking info
export interface LeaderboardEntry extends Clip {
  rank: number;
  elo: number;
  matches: number;
  winRate: number;
  confidence?: number;
}

// Activity feed entry
export interface ActivityEntry {
  id: number;
  type: 'vote' | 'super_like' | 'comment' | 'save';
  clipId: number;
  clipTitle: string;
  clipSlug: string;
  createdAt: string;
  user?: {
    displayName: string;
    profileImage: string;
  };
}

// Comment on a clip
export interface Comment {
  id: number;
  comment?: string;
  emoji?: string;
  isPublic: boolean;
  createdAt: string;
  user?: {
    displayName: string;
    profileImage: string;
  };
}

// Available reaction emojis
export type ReactionEmoji = 'fire' | 'skull' | 'crying' | 'poggers' | 'pepehands' | 'lul';

// Saved clip with position
export interface SavedClip extends Clip {
  position: number;
}

// API response for saved clips
export interface SavedClipsResponse {
  clips: SavedClip[];
}

// Personal ranking entry (extends LeaderboardEntry with superLikes)
export interface PersonalRankingEntry extends LeaderboardEntry {
  superLikes: number;
}

// Pagination info from API responses
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Global leaderboard API response
export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  pagination?: Pagination;
}

// Personal leaderboard API response
export interface PersonalLeaderboardResponse {
  leaderboard: PersonalRankingEntry[];
}

// Add clip to personal rankings response
export interface AddClipResponse {
  success: boolean;
  alreadyRanked?: boolean;
  needsRanking?: boolean;
}

// Reorder personal ranking response
export interface ReorderResponse {
  success: boolean;
  globalRankingUpdated?: boolean;
  clipsBeaten?: number;
}

// Voter stats entry for admin leaderboard
export interface VoterEntry {
  rank: number;
  username: string;
  displayName?: string;
  profileImage?: string;
  totalVotes: number;
  superLikes: number;
  lastLogin?: string;
}

// Voter stats API response
export interface VoterStatsResponse {
  voters: VoterEntry[];
}

// Leaderboard tab types
export type LeaderboardTab = 'global' | 'me' | 'voters';

// Leaderboard sort options
export type LeaderboardSort = 'elo' | 'matches' | 'winrate' | 'superlikes';

// Sort order options
export type SortOrder = 'asc' | 'desc';

// Environment bindings
export interface Env {
  DB: D1Database;
  THUMBNAIL_CACHE: KVNamespace;
  SESSION_CACHE: KVNamespace;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ADMIN_LOGIN_KEY?: string;
  // Advanced CF features
  VOTES_ANALYTICS: AnalyticsEngineDataset;
  AGGREGATION_COORDINATOR: DurableObjectNamespace;
  VOTE_QUEUE: Queue<VoteQueueMessage>;
}

// Database models
export interface User {
  id: number;
  twitch_id: string;
  twitch_username: string;
  twitch_display_name: string | null;
  twitch_profile_image: string | null;
  created_at: string;
  last_login: string;
  last_active: string | null;
  total_comparisons: number;
  total_super_likes: number;
  total_skips: number;
  total_ties: number;
  total_clips_seen: number;
  current_streak: number;
  longest_streak: number;
  last_vote_date: string | null;
  is_profile_public: number;
}

export interface Clip {
  id: number;
  twitch_slug: string;
  title: string | null;
  clipped_by: string | null;
  twitch_url: string;
  clipped_at: string | null;
  created_at: string;
  is_active: number;
  global_elo: number;
  global_matches: number;
  global_wins: number;
  global_losses: number;
  global_ties: number;
  global_super_likes: number;
  rating_deviation: number;
  last_rated_at: string | null;
}

export interface Comparison {
  id: number;
  user_id: number;
  clip_a_id: number;
  clip_b_id: number;
  winner_clip_id: number | null;
  result: VoteResult;
  created_at: string;
  time_spent_ms: number | null;
}

export interface UserClipRating {
  id: number;
  user_id: number;
  clip_id: number;
  elo_rating: number;
  matches_played: number;
  wins: number;
  losses: number;
  ties: number;
  super_liked: number;
  rating_deviation: number;
  updated_at: string;
}

export interface PairingHistory {
  id: number;
  user_id: number;
  clip_a_id: number;
  clip_b_id: number;
  times_shown: number;
  last_shown_at: string;
}

export interface Session {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

// Vote types
export type VoteResult = 'clip_a' | 'clip_b' | 'super_a' | 'super_b' | 'tie' | 'skip';

// API request/response types
export interface VoteRequest {
  clip_a_id: number;
  clip_b_id: number;
  result: VoteResult;
  time_spent_ms?: number;
}

export interface ClipPair {
  clip_a: Clip;
  clip_b: Clip;
}

export interface LeaderboardEntry {
  rank: number;
  clip: Clip;
  confidence: number;
}

// Twitch OAuth types
export interface TwitchTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

// Social feature types
export type ReactionEmoji = 'fire' | 'skull' | 'crying' | 'poggers' | 'pepehands' | 'lul';

export interface ClipComment {
  id: number;
  user_id: number;
  clip_id: number;
  comment: string;
  is_public: number;
  emoji: ReactionEmoji | null;
  created_at: string;
  updated_at: string;
}

export type ActivityType = 'vote' | 'super_like' | 'comment' | 'save';

export interface ActivityEntry {
  id: number;
  user_id: number;
  activity_type: ActivityType;
  clip_id: number;
  clip_title: string | null;
  extra_data: string | null;
  is_public: number;
  created_at: string;
}

export interface TasteCompatibility {
  user_a_id: number;
  user_b_id: number;
  compatibility_score: number;
  shared_clips: number;
  calculated_at: string;
}

export interface SimilarUser {
  user_id: number;
  display_name: string | null;
  profile_image: string | null;
  compatibility_score: number;
  shared_clips: number;
}

export type ShareType = 'profile' | 'top5' | 'leaderboard';

export interface ShareToken {
  id: number;
  user_id: number;
  token: string;
  share_type: ShareType;
  expires_at: string | null;
  view_count: number;
  created_at: string;
}

export interface TrendingClip {
  clip: Clip;
  vote_count: number;
  super_like_count: number;
}

// Queue message types for async vote processing
export interface VoteQueueMessage {
  clipAId: number;
  clipBId: number;
  userId: number;
  result: VoteResult;
  newRatingA: number;
  newRatingB: number;
  currentRatingA: number;
  currentRatingB: number;
  deviationA: number;
  deviationB: number;
  newDeviationA: number;
  newDeviationB: number;
  userWeight: number;
  isSuperLike: boolean;
  isNewRatingA: boolean;
  isNewRatingB: boolean;
  statsA: { wins: number; losses: number; ties: number };
  statsB: { wins: number; losses: number; ties: number };
}

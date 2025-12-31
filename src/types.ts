// Environment bindings
export interface Env {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
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
  total_comparisons: number;
  total_super_likes: number;
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

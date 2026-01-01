-- Migration: Add social features (profile visibility, activity feed, compatibility, etc.)
-- Run with: wrangler d1 execute clip-ranker-db --remote --file=src/db/migrations/004_add_social_features.sql

-- Add profile visibility column to users table
ALTER TABLE users ADD COLUMN is_profile_public INTEGER DEFAULT 1;

-- Clip rating rollups table (for aggregation service)
CREATE TABLE IF NOT EXISTS clip_rating_rollups (
    clip_id INTEGER PRIMARY KEY,
    weighted_elo REAL,
    weighted_deviation REAL,
    weighted_elo_sum REAL,
    weighted_deviation_sum REAL,
    weight_sum REAL,
    total_matches INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_losses INTEGER DEFAULT 0,
    total_ties INTEGER DEFAULT 0,
    total_super_likes INTEGER DEFAULT 0,
    last_updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (clip_id) REFERENCES clips(id)
);

-- Activity feed table (denormalized for speed)
CREATE TABLE IF NOT EXISTS activity_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('vote', 'super_like', 'comment', 'save')),
    clip_id INTEGER NOT NULL,
    clip_title TEXT,
    extra_data TEXT,
    is_public INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_id) REFERENCES clips(id)
);

CREATE INDEX IF NOT EXISTS idx_activity_feed_created ON activity_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_feed_user ON activity_feed(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_feed_public ON activity_feed(is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_feed_clip ON activity_feed(clip_id, created_at DESC);

-- Taste compatibility cache
CREATE TABLE IF NOT EXISTS taste_compatibility_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL,
    compatibility_score REAL NOT NULL,
    shared_clips INTEGER NOT NULL,
    calculated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_a_id) REFERENCES users(id),
    FOREIGN KEY (user_b_id) REFERENCES users(id),
    UNIQUE(user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_taste_compat_user_a ON taste_compatibility_cache(user_a_id);
CREATE INDEX IF NOT EXISTS idx_taste_compat_user_b ON taste_compatibility_cache(user_b_id);

-- Clip comments/reactions
CREATE TABLE IF NOT EXISTS clip_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    clip_id INTEGER NOT NULL,
    comment TEXT NOT NULL,
    is_public INTEGER DEFAULT 0,
    emoji TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_id) REFERENCES clips(id),
    UNIQUE(user_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_clip_comments_user ON clip_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_clip_comments_clip ON clip_comments(clip_id);
CREATE INDEX IF NOT EXISTS idx_clip_comments_public ON clip_comments(is_public, created_at);

-- Share tokens for public profile links
CREATE TABLE IF NOT EXISTS share_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    share_type TEXT NOT NULL CHECK (share_type IN ('profile', 'top5', 'leaderboard')),
    expires_at TEXT,
    view_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON share_tokens(token);
CREATE INDEX IF NOT EXISTS idx_share_tokens_user ON share_tokens(user_id);

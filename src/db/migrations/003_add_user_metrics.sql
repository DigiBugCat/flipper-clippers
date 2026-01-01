-- Migration: Add user activity metrics columns
-- Run with: wrangler d1 execute clip-ranker-db --remote --file=src/db/migrations/003_add_user_metrics.sql

-- Add last_active column (tracks any activity, not just login)
-- Note: SQLite doesn't allow non-constant defaults, so we use NULL and backfill
ALTER TABLE users ADD COLUMN last_active TEXT;

-- Add skip counter
ALTER TABLE users ADD COLUMN total_skips INTEGER DEFAULT 0;

-- Add tie counter
ALTER TABLE users ADD COLUMN total_ties INTEGER DEFAULT 0;

-- Add clips seen counter (2 per comparison)
ALTER TABLE users ADD COLUMN total_clips_seen INTEGER DEFAULT 0;

-- Add streak tracking
ALTER TABLE users ADD COLUMN current_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN longest_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_vote_date TEXT;

-- Initialize total_clips_seen based on existing comparisons (2 clips per comparison)
UPDATE users SET total_clips_seen = total_comparisons * 2 WHERE total_clips_seen = 0;

-- Set last_active to last_login for existing users
UPDATE users SET last_active = last_login WHERE last_active IS NULL;

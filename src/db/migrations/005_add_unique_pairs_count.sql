-- Migration 005: Add unique_pairs_voted column for performance optimization
-- This denormalizes the count of unique pairs a user has voted on,
-- avoiding expensive COUNT(DISTINCT) queries on the comparisons table.

-- Add column to track unique pairs voted
ALTER TABLE users ADD COLUMN unique_pairs_voted INTEGER DEFAULT 0;

-- Drop duplicate index (idx_user_clip_ratings_user and idx_user_clip_ratings_user_id are identical)
DROP INDEX IF EXISTS idx_user_clip_ratings_user;

-- Backfill existing counts from comparisons table
-- This counts unique pairs (A,B) and (B,A) as the same pair
UPDATE users SET unique_pairs_voted = (
  SELECT COUNT(*) FROM (
    SELECT DISTINCT
      CASE WHEN clip_a_id < clip_b_id THEN clip_a_id ELSE clip_b_id END as min_id,
      CASE WHEN clip_a_id < clip_b_id THEN clip_b_id ELSE clip_a_id END as max_id
    FROM comparisons
    WHERE comparisons.user_id = users.id
  )
);

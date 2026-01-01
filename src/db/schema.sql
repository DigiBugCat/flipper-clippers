-- Users table (Twitch authenticated users)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_id TEXT UNIQUE NOT NULL,
    twitch_username TEXT NOT NULL,
    twitch_display_name TEXT,
    twitch_profile_image TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT DEFAULT (datetime('now')),
    total_comparisons INTEGER DEFAULT 0,
    total_super_likes INTEGER DEFAULT 0,
    is_profile_public INTEGER DEFAULT 1
);

-- Clips table (Twitch clips metadata)
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_slug TEXT UNIQUE NOT NULL,
    title TEXT,
    clipped_by TEXT,
    twitch_url TEXT NOT NULL,
    clipped_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1,
    -- Global ELO rating (aggregated from all users)
    global_elo REAL DEFAULT 1500.0,
    global_matches INTEGER DEFAULT 0,
    global_wins INTEGER DEFAULT 0,
    global_losses INTEGER DEFAULT 0,
    global_ties INTEGER DEFAULT 0,
    global_super_likes INTEGER DEFAULT 0,
    -- Rating deviation for uncertainty tracking
    rating_deviation REAL DEFAULT 350.0,
    last_rated_at TEXT
);

-- Comparisons table (vote records)
CREATE TABLE IF NOT EXISTS comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    clip_a_id INTEGER NOT NULL,
    clip_b_id INTEGER NOT NULL,
    winner_clip_id INTEGER,
    result TEXT NOT NULL CHECK (result IN ('clip_a', 'clip_b', 'super_a', 'super_b', 'tie', 'skip')),
    created_at TEXT DEFAULT (datetime('now')),
    time_spent_ms INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_a_id) REFERENCES clips(id),
    FOREIGN KEY (clip_b_id) REFERENCES clips(id),
    FOREIGN KEY (winner_clip_id) REFERENCES clips(id)
);

-- Index for faster comparison lookups
CREATE INDEX IF NOT EXISTS idx_comparisons_user ON comparisons(user_id);
CREATE INDEX IF NOT EXISTS idx_comparisons_clips ON comparisons(clip_a_id, clip_b_id);

-- Per-user clip ratings
CREATE TABLE IF NOT EXISTS user_clip_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    clip_id INTEGER NOT NULL,
    elo_rating REAL DEFAULT 1500.0,
    matches_played INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    ties INTEGER DEFAULT 0,
    super_liked INTEGER DEFAULT 0,
    rating_deviation REAL DEFAULT 350.0,
    manual_position INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_id) REFERENCES clips(id),
    UNIQUE(user_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_user_clip_ratings_user ON user_clip_ratings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clip_ratings_clip ON user_clip_ratings(clip_id);

-- Pairing history to avoid showing same pairs repeatedly
CREATE TABLE IF NOT EXISTS pairing_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    clip_a_id INTEGER NOT NULL,
    clip_b_id INTEGER NOT NULL,
    times_shown INTEGER DEFAULT 1,
    last_shown_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_a_id) REFERENCES clips(id),
    FOREIGN KEY (clip_b_id) REFERENCES clips(id),
    UNIQUE(user_id, clip_a_id, clip_b_id)
);

CREATE INDEX IF NOT EXISTS idx_pairing_history_user ON pairing_history(user_id);

-- User sessions for authentication
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Saved clips (user's personal favorites with manual ordering)
CREATE TABLE IF NOT EXISTS saved_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    clip_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    saved_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (clip_id) REFERENCES clips(id),
    UNIQUE(user_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_clips_user ON saved_clips(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_clips_position ON saved_clips(user_id, position);

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

-- Activity feed (denormalized for speed)
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

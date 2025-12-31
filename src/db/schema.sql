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
    total_super_likes INTEGER DEFAULT 0
);

-- Clips table (Twitch clips metadata)
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_slug TEXT UNIQUE NOT NULL,
    title TEXT,
    clipped_by TEXT,
    twitch_url TEXT NOT NULL,
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

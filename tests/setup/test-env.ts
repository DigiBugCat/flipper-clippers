import { Miniflare } from 'miniflare';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Environment bindings type matching src/types.ts
export interface TestEnv {
  DB: D1Database;
  THUMBNAIL_CACHE: KVNamespace;
  SESSION_CACHE: KVNamespace;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  // Advanced CF features - optional for testing (not all supported by Miniflare)
  VOTES_ANALYTICS?: {
    writeDataPoint: (point: {
      indexes?: string[];
      blobs?: string[];
      doubles?: number[];
    }) => void;
  };
  AGGREGATION_COORDINATOR?: DurableObjectNamespace;
  VOTE_QUEUE?: Queue<unknown>;
}

// Test user types
export interface TestUser {
  id: number;
  twitch_id: string;
  twitch_username: string;
  twitch_display_name: string | null;
  twitch_profile_image: string | null;
  is_profile_public: number;
}

// Test clip types
export interface TestClip {
  id: number;
  twitch_slug: string;
  title: string;
  twitch_url: string;
  is_active: number;
  global_elo: number;
  global_matches: number;
}

// Miniflare instance holder for cleanup
let miniflareInstance: Miniflare | null = null;

/**
 * Creates a Miniflare test environment with D1 and KV namespaces.
 * Loads and executes the schema.sql file to initialize the database.
 *
 * @returns The environment bindings object with DB, KV namespaces, and env vars
 */
export async function createTestEnv(): Promise<TestEnv> {
  // Resolve path to schema.sql
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(__dirname, '../../src/db/schema.sql');

  // Read the schema SQL file
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Create Miniflare instance with D1 and KV
  const mf = new Miniflare({
    modules: true,
    script: `export default { fetch() { return new Response('ok'); } }`,
    d1Databases: {
      DB: 'test-db',
    },
    kvNamespaces: {
      THUMBNAIL_CACHE: 'thumbnail-cache-ns',
      SESSION_CACHE: 'session-cache-ns',
    },
    bindings: {
      TWITCH_CLIENT_ID: 'test-twitch-client-id',
      TWITCH_CLIENT_SECRET: 'test-twitch-client-secret',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
    },
  });

  miniflareInstance = mf;

  // Get bindings
  const db = await mf.getD1Database('DB');
  const thumbnailCache = await mf.getKVNamespace('THUMBNAIL_CACHE');
  const sessionCache = await mf.getKVNamespace('SESSION_CACHE');

  // Execute schema SQL to create tables
  // Split by semicolons and execute each statement
  const statements = schemaSql
    .split(';')
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0);

  for (const statement of statements) {
    await db.exec(statement);
  }

  return {
    DB: db,
    THUMBNAIL_CACHE: thumbnailCache,
    SESSION_CACHE: sessionCache,
    TWITCH_CLIENT_ID: 'test-twitch-client-id',
    TWITCH_CLIENT_SECRET: 'test-twitch-client-secret',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
    // Mock Analytics Engine (not supported by Miniflare)
    VOTES_ANALYTICS: {
      writeDataPoint: () => {},
    },
  };
}

/**
 * Seeds the test database with sample data.
 * Creates 3 test users and 4 test clips.
 *
 * @param db - The D1Database instance to seed
 * @returns Object containing the seeded users and clips
 */
export async function seedTestDatabase(db: D1Database): Promise<{
  users: TestUser[];
  clips: TestClip[];
}> {
  // Insert 3 test users: regular, admin, private
  const users: TestUser[] = [
    {
      id: 1,
      twitch_id: 'twitch_user_regular_123',
      twitch_username: 'regularuser',
      twitch_display_name: 'Regular User',
      twitch_profile_image: 'https://example.com/regular.png',
      is_profile_public: 1,
    },
    {
      id: 2,
      twitch_id: 'twitch_user_admin_456',
      twitch_username: 'adminuser',
      twitch_display_name: 'Admin User',
      twitch_profile_image: 'https://example.com/admin.png',
      is_profile_public: 1,
    },
    {
      id: 3,
      twitch_id: 'twitch_user_private_789',
      twitch_username: 'privateuser',
      twitch_display_name: 'Private User',
      twitch_profile_image: 'https://example.com/private.png',
      is_profile_public: 0,
    },
  ];

  for (const user of users) {
    await db.prepare(`
      INSERT INTO users (twitch_id, twitch_username, twitch_display_name, twitch_profile_image, is_profile_public)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      user.twitch_id,
      user.twitch_username,
      user.twitch_display_name,
      user.twitch_profile_image,
      user.is_profile_public
    ).run();
  }

  // Insert 4 test clips: high-rated, medium, low, inactive
  const clips: TestClip[] = [
    {
      id: 1,
      twitch_slug: 'HighRatedClip-abc123',
      title: 'Amazing Play - High Rated',
      twitch_url: 'https://clips.twitch.tv/HighRatedClip-abc123',
      is_active: 1,
      global_elo: 1800.0,
      global_matches: 50,
    },
    {
      id: 2,
      twitch_slug: 'MediumClip-def456',
      title: 'Good Play - Medium Rated',
      twitch_url: 'https://clips.twitch.tv/MediumClip-def456',
      is_active: 1,
      global_elo: 1500.0,
      global_matches: 30,
    },
    {
      id: 3,
      twitch_slug: 'LowRatedClip-ghi789',
      title: 'Okay Play - Low Rated',
      twitch_url: 'https://clips.twitch.tv/LowRatedClip-ghi789',
      is_active: 1,
      global_elo: 1200.0,
      global_matches: 20,
    },
    {
      id: 4,
      twitch_slug: 'InactiveClip-jkl012',
      title: 'Old Play - Inactive',
      twitch_url: 'https://clips.twitch.tv/InactiveClip-jkl012',
      is_active: 0,
      global_elo: 1400.0,
      global_matches: 10,
    },
  ];

  for (const clip of clips) {
    await db.prepare(`
      INSERT INTO clips (twitch_slug, title, twitch_url, is_active, global_elo, global_matches)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      clip.twitch_slug,
      clip.title,
      clip.twitch_url,
      clip.is_active,
      clip.global_elo,
      clip.global_matches
    ).run();
  }

  return { users, clips };
}

/**
 * Cleans all data from the database tables.
 * Useful for resetting state between tests.
 *
 * @param db - The D1Database instance to clean
 */
export async function cleanDatabase(db: D1Database): Promise<void> {
  // Delete in order to respect foreign key constraints
  // (although SQLite doesn't enforce FK by default, good practice)
  const tables = [
    'activity_feed',
    'taste_compatibility_cache',
    'share_tokens',
    'clip_comments',
    'saved_clips',
    'sessions',
    'pairing_history',
    'user_clip_ratings',
    'comparisons',
    'clips',
    'users',
  ];

  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }

  // Reset autoincrement counters
  await db.exec(`DELETE FROM sqlite_sequence`);
}

/**
 * Disposes of the Miniflare instance.
 * Should be called after all tests complete.
 */
export async function disposeTestEnv(): Promise<void> {
  if (miniflareInstance) {
    await miniflareInstance.dispose();
    miniflareInstance = null;
  }
}

/**
 * Creates a test session for a user.
 *
 * @param db - The D1Database instance
 * @param userId - The user ID to create session for
 * @param sessionId - Optional custom session ID
 * @returns The session ID
 */
export async function createTestSession(
  db: D1Database,
  userId: number,
  sessionId: string = 'test-session-id-12345'
): Promise<string> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(sessionId, userId, expiresAt).run();

  return sessionId;
}

/**
 * Creates a test comparison record.
 *
 * @param db - The D1Database instance
 * @param userId - The user who made the comparison
 * @param clipAId - First clip ID
 * @param clipBId - Second clip ID
 * @param result - The vote result
 * @returns The comparison ID
 */
export async function createTestComparison(
  db: D1Database,
  userId: number,
  clipAId: number,
  clipBId: number,
  result: 'clip_a' | 'clip_b' | 'super_a' | 'super_b' | 'tie' | 'skip'
): Promise<number> {
  const winnerClipId = result === 'clip_a' || result === 'super_a'
    ? clipAId
    : result === 'clip_b' || result === 'super_b'
      ? clipBId
      : null;

  const res = await db.prepare(`
    INSERT INTO comparisons (user_id, clip_a_id, clip_b_id, winner_clip_id, result)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, clipAId, clipBId, winnerClipId, result).run();

  return res.meta.last_row_id as number;
}

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie } from 'hono/cookie';
import type { Env } from './types';

import auth, { getCachedSession } from './handlers/auth';
import clips from './handlers/clips';
import compare from './handlers/compare';
import leaderboard from './handlers/leaderboard';
import saved from './handlers/saved';
import thumbnails from './handlers/thumbnails';
import feed from './handlers/feed';
import comments from './handlers/comments';
import social from './handlers/social';
import share from './handlers/share';
import clipdle from './handlers/clipdle';
import { aggregateGlobalRankings } from './services/aggregation';
import { syncRecentClips } from './services/clipSync';

// Admin users - consider moving to env var in future
const ADMIN_USERS = ['digibugcat', 'arross'];

// Export Durable Object classes
export { AggregationCoordinator } from './durable-objects/AggregationCoordinator';

// Import queue consumer
import { handleVoteQueue } from './queues/voteConsumer';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware for API routes
// Note: Same-origin requests don't need CORS, but we support localhost for dev
app.use('/api/*', cors({
  origin: (origin) => {
    // Allow same-origin (no origin header) and localhost for dev
    if (!origin) return origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return origin;
    // Secure domain matching - prevent subdomain spoofing like malicious-arross.tv.attacker.com
    if (origin.endsWith('.arross.tv') || origin === 'https://arross.tv') return origin;
    return null;
  },
  credentials: true,
}));

// API routes
app.route('/api/auth', auth);
app.route('/api/clips', clips);
app.route('/api/compare', compare);
app.route('/api/leaderboard', leaderboard);
app.route('/api/saved', saved);
app.route('/api/thumbnails', thumbnails);
app.route('/api/feed', feed);
app.route('/api/comments', comments);
app.route('/api/social', social);
app.route('/api/share', share);
app.route('/api/clipdle', clipdle);

// Serve share.html for /share/:token routes (SPA-style routing)
app.get('/share/:token', async (c) => {
  // Return the share.html file with proper content type
  const response = await fetch(new URL('/share.html', c.req.url));
  return new Response(response.body, {
    headers: { 'Content-Type': 'text/html' },
  });
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Manual aggregation trigger
app.post('/api/aggregate', async (c) => {
  await aggregateGlobalRankings(c.env.DB);
  return c.json({ success: true, message: 'Global rankings aggregated' });
});

// Manual clip sync trigger (admin only)
app.post('/api/admin/sync-clips', async (c) => {
  // Require admin authentication
  const sessionId = getCookie(c, 'session');
  if (!sessionId) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return c.json({ error: 'Invalid session' }, 401);
  }

  if (!ADMIN_USERS.includes(cached.user.twitch_username)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const result = await syncRecentClips(
    c.env.DB,
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET
  );
  return c.json(result);
});

// Static files are handled by Wrangler's [assets] configuration
// See wrangler.toml: [assets] directory = "public"

// Export handlers for fetch, scheduled (cron), and queue triggers
export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    console.log(`[CRON] Triggered at ${new Date().toISOString()}`);

    try {
      const result = await syncRecentClips(
        env.DB,
        env.TWITCH_CLIENT_ID,
        env.TWITCH_CLIENT_SECRET
      );

      console.log(`[CRON] Sync complete: added=${result.added}, skipped=${result.skipped}`);

      if (result.errors.length > 0) {
        console.error(`[CRON] Errors: ${result.errors.join(', ')}`);
      }
    } catch (error) {
      console.error(`[CRON] Failed:`, error);
    }
  },
  queue: handleVoteQueue,
};

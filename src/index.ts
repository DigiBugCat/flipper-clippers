import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

import auth from './handlers/auth';
import clips from './handlers/clips';
import compare from './handlers/compare';
import leaderboard from './handlers/leaderboard';
import saved from './handlers/saved';
import thumbnails from './handlers/thumbnails';
import clipdle from './handlers/clipdle';
import { aggregateGlobalRankings } from './services/aggregation';
import { syncRecentClips } from './services/clipSync';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware for API routes
// Note: Same-origin requests don't need CORS, but we support localhost for dev
app.use('/api/*', cors({
  origin: (origin) => {
    // Allow same-origin (no origin header) and localhost for dev
    if (!origin) return origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return origin;
    if (origin.includes('arross.tv')) return origin;
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

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Manual aggregation trigger
app.post('/api/aggregate', async (c) => {
  await aggregateGlobalRankings(c.env.DB);
  return c.json({ success: true, message: 'Global rankings aggregated' });
});

// Manual clip sync trigger (for testing/admin)
app.post('/api/admin/sync-clips', async (c) => {
  const result = await syncRecentClips(
    c.env.DB,
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET
  );
  return c.json(result);
});

// Static files are handled by Wrangler's [assets] configuration
// See wrangler.toml: [assets] directory = "public"

// Clipdle API routes (for clipdle subdomain - same worker handles both)
app.route('/api/clipdle', clipdle);

// Export handlers for fetch and scheduled (cron) triggers
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
};

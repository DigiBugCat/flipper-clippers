import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

import auth from './handlers/auth';
import clips from './handlers/clips';
import compare from './handlers/compare';
import leaderboard from './handlers/leaderboard';
import saved from './handlers/saved';
import { aggregateGlobalRankings } from './services/aggregation';

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

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Manual aggregation trigger
app.post('/api/aggregate', async (c) => {
  await aggregateGlobalRankings(c.env.DB);
  return c.json({ success: true, message: 'Global rankings aggregated' });
});

// Static files are handled by Wrangler's [assets] configuration
// See wrangler.toml: [assets] directory = "public"

// Export with scheduled handler for cron triggers
export default {
  fetch: app.fetch,

  // Cron trigger - runs every 5 minutes (see wrangler.toml)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('Cron triggered: aggregating global rankings...');
    ctx.waitUntil(aggregateGlobalRankings(env.DB));
  },
};

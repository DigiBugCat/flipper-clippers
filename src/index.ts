import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

import auth from './handlers/auth';
import clips from './handlers/clips';
import compare from './handlers/compare';
import leaderboard from './handlers/leaderboard';
import saved from './handlers/saved';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware for API routes
app.use('/api/*', cors({
  origin: '*',
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

// Static files are handled by Wrangler's [assets] configuration
// See wrangler.toml: [assets] directory = "public"

export default app;

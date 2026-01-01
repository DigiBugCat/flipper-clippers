import { Hono } from 'hono';
import { cors } from 'hono/cors';
import clipdle from './handlers/clipdle';

// Clipdle worker - minimal entry point for clipdle.arross.tv
// Shares D1 database with main worker (read-only access)

interface Env {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware - allow all origins for Clipdle API
app.use('/api/*', cors({
  origin: '*',
}));

// Clipdle API routes
app.route('/api/clipdle', clipdle);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'clipdle' }));

export default app;

import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import type { Env } from '../types';
import { getCachedSession } from './auth';
import {
  getGlobalFeed,
  getUserActivityHistory,
  getTrendingClips,
} from '../services/feed';

const feed = new Hono<{ Bindings: Env }>();

// Get global activity feed (public activities)
feed.get('/global', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const activities = await getGlobalFeed(c.env.DB, limit, offset);

  return c.json({
    activities: activities.map((a) => ({
      id: a.id,
      type: a.activity_type,
      clipId: a.clip_id,
      clipTitle: a.clip_title,
      clipSlug: a.clip_slug,
      extraData: a.extra_data ? JSON.parse(a.extra_data) : null,
      createdAt: a.created_at,
      user: {
        displayName: a.user_display_name,
        profileImage: a.user_profile_image,
      },
    })),
  });
});

// Get trending clips
feed.get('/trending', async (c) => {
  const period = (c.req.query('period') || '24h') as '24h' | '7d' | '30d';
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);

  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400);
  }

  const trending = await getTrendingClips(c.env.DB, period, limit);

  return c.json({
    period,
    clips: trending.map((t) => ({
      clipId: t.clip_id,
      twitchSlug: t.twitch_slug,
      title: t.title,
      globalElo: t.global_elo,
      voteCount: t.vote_count,
      superLikeCount: t.super_like_count,
    })),
  });
});

// Get user's own activity history (requires auth)
feed.get('/me', async (c) => {
  const sessionId = getCookie(c, 'session');

  if (!sessionId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Invalid session' }, 401);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const activities = await getUserActivityHistory(c.env.DB, cached.user.id, limit, offset);

  return c.json({
    activities: activities.map((a) => ({
      id: a.id,
      type: a.activity_type,
      clipId: a.clip_id,
      clipTitle: a.clip_title,
      clipSlug: a.clip_slug,
      extraData: a.extra_data ? JSON.parse(a.extra_data) : null,
      createdAt: a.created_at,
    })),
  });
});

export default feed;

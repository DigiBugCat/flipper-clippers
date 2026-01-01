import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth, optionalAuth, type AuthVariables } from '../middleware/auth';
import {
  getTasteCompatibility,
  findSimilarUsers,
  getPublicProfile,
  getUserTopClips,
} from '../services/social';

type Variables = AuthVariables;

const social = new Hono<{ Bindings: Env; Variables: Variables }>();

// Get compatibility score with a specific user
social.get('/compatibility/:userId', requireAuth, async (c) => {
  const currentUserId = c.get('userId');
  const targetUserId = parseInt(c.req.param('userId'), 10);

  if (!targetUserId || targetUserId === currentUserId) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }

  // Check if target user is public
  const { isPublic } = await getPublicProfile(c.env.DB, targetUserId);
  if (!isPublic) {
    return c.json({ error: 'User profile is private' }, 403);
  }

  const result = await getTasteCompatibility(c.env.DB, currentUserId, targetUserId);

  return c.json({
    userId: targetUserId,
    compatibilityScore: result.score,
    sharedClips: result.sharedClips,
    cached: result.cached,
  });
});

// Get list of most similar users
social.get('/similar', requireAuth, async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 50);

  const similarUsers = await findSimilarUsers(c.env.DB, userId, limit);

  return c.json({
    users: similarUsers.map(u => ({
      userId: u.user_id,
      displayName: u.display_name,
      profileImage: u.profile_image,
      compatibilityScore: u.compatibility_score,
      sharedClips: u.shared_clips,
    })),
  });
});

// Get a user's public profile
social.get('/profile/:userId', optionalAuth, async (c) => {
  const targetUserId = parseInt(c.req.param('userId'), 10);
  const currentUserId = c.get('userId');

  if (!targetUserId) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }

  const { user, isPublic } = await getPublicProfile(c.env.DB, targetUserId);

  if (!user) {
    return c.json({ error: isPublic ? 'User not found' : 'User profile is private' }, 404);
  }

  // Get user's top clips
  const topClips = await getUserTopClips(c.env.DB, targetUserId, 10);

  // Calculate compatibility if viewer is logged in
  let compatibility = null;
  if (currentUserId && currentUserId !== targetUserId) {
    const result = await getTasteCompatibility(c.env.DB, currentUserId, targetUserId);
    compatibility = {
      score: result.score,
      sharedClips: result.sharedClips,
    };
  }

  return c.json({
    profile: {
      id: user.id,
      displayName: user.displayName,
      profileImage: user.profileImage,
      totalComparisons: user.totalComparisons,
    },
    topClips: topClips.map(clip => ({
      id: clip.id,
      twitchSlug: clip.twitchSlug,
      title: clip.title,
      userElo: Math.round(clip.userElo),
    })),
    compatibility,
  });
});

export default social;

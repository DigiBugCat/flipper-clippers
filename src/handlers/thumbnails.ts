import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from '../types';
import { getCachedSession } from './auth';

const thumbnails = new Hono<{ Bindings: Env }>();

// Admin users for protected operations
const ADMIN_USERS = ['digibugcat', 'arross'];

// Helper to check admin access
async function requireAdmin(c: { env: Env; req: { header: (name: string) => string | undefined }; json: (data: unknown, status?: number) => Response }): Promise<{ authorized: true } | { authorized: false; response: Response }> {
  const cookies = c.req.header('cookie') || '';
  const sessionMatch = cookies.match(/session=([^;]+)/);
  const sessionId = sessionMatch?.[1];

  if (!sessionId) {
    return { authorized: false, response: c.json({ error: 'Authentication required' }, 401) };
  }

  const cached = await getCachedSession(c.env.DB, c.env.SESSION_CACHE, sessionId);
  if (!cached) {
    return { authorized: false, response: c.json({ error: 'Invalid session' }, 401) };
  }

  if (!ADMIN_USERS.includes(cached.user.twitch_username)) {
    return { authorized: false, response: c.json({ error: 'Admin access required' }, 403) };
  }

  return { authorized: true };
}

// Cache TTL: 30 days in seconds
const CACHE_TTL = 30 * 24 * 60 * 60;

// Browser cache: 7 days
const BROWSER_CACHE_MAX_AGE = 7 * 24 * 60 * 60;

// Twitch token cache: 25 minutes (tokens last ~30 min)
const TWITCH_TOKEN_CACHE_TTL = 25 * 60;
const TWITCH_TOKEN_CACHE_KEY = 'twitch:client_token';

// Placeholder SVG for failed thumbnails
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="272" viewBox="0 0 480 272">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#5c4d9a"/>
      <stop offset="100%" style="stop-color:#4a3d7a"/>
    </linearGradient>
  </defs>
  <rect width="480" height="272" fill="url(#bg)"/>
  <path d="M220 106v60l52-30z" fill="rgba(255,255,255,0.8)"/>
</svg>`;

/**
 * Get Twitch OAuth token using client credentials
 * Caches in KV to avoid repeated OAuth requests
 */
async function getTwitchToken(env: Env): Promise<string | null> {
  // Try KV cache first
  const cached = await env.SESSION_CACHE.get(TWITCH_TOKEN_CACHE_KEY);
  if (cached) {
    return cached;
  }

  // Cache miss - fetch new token
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Twitch token error:', response.status, errorBody);
      return null;
    }
    const data = await response.json() as { access_token: string; expires_in?: number };
    const token = data.access_token;

    // Cache with TTL (use expires_in if available, otherwise default)
    const ttl = data.expires_in
      ? Math.max(60, data.expires_in - 300) // 5 min before expiry, min 60s
      : TWITCH_TOKEN_CACHE_TTL;

    await env.SESSION_CACHE.put(TWITCH_TOKEN_CACHE_KEY, token, {
      expirationTtl: ttl,
    });

    return token;
  } catch (e) {
    console.error('Twitch token exception:', e);
    return null;
  }
}

/**
 * Get clip info from Twitch Helix API
 */
async function getClipFromTwitch(
  slug: string,
  token: string,
  clientId: string
): Promise<{ thumbnail_url: string } | null> {
  try {
    const response = await fetch(`https://api.twitch.tv/helix/clips?id=${encodeURIComponent(slug)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Client-Id': clientId,
      },
    });

    if (!response.ok) return null;
    const data = await response.json() as { data: Array<{ thumbnail_url: string }> };
    return data.data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Fetch and cache a thumbnail image
 */
async function fetchAndCacheThumbnail(
  slug: string,
  thumbnailUrl: string,
  kv: KVNamespace
): Promise<{ success: boolean; cached: boolean }> {
  const cacheKey = `thumb:${slug}`;

  // Check if already cached
  const existing = await kv.get(cacheKey, 'arrayBuffer');
  if (existing) {
    return { success: true, cached: true };
  }

  try {
    const response = await fetch(thumbnailUrl);
    if (!response.ok) {
      return { success: false, cached: false };
    }

    const imageData = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') || 'image/jpeg';

    await kv.put(cacheKey, imageData, {
      expirationTtl: CACHE_TTL,
      metadata: { contentType, thumbnailUrl, fetchedAt: Date.now() },
    });

    return { success: true, cached: false };
  } catch {
    return { success: false, cached: false };
  }
}

/**
 * Get thumbnail for a clip slug
 * Caches in KV for fast subsequent requests
 */
thumbnails.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  if (!slug || slug.length < 10) {
    return c.text('Invalid slug', 400);
  }

  const cacheKey = `thumb:${slug}`;

  // Try to get from KV cache first
  const cached = await c.env.THUMBNAIL_CACHE.getWithMetadata(cacheKey, 'arrayBuffer');
  if (cached.value) {
    const metadata = cached.metadata as { contentType?: string } | null;
    return new Response(cached.value, {
      headers: {
        'Content-Type': metadata?.contentType || 'image/jpeg',
        'Cache-Control': `public, max-age=${BROWSER_CACHE_MAX_AGE}, immutable`,
        'X-Cache': 'HIT',
      },
    });
  }

  // Not in cache - try Twitch API
  const token = await getTwitchToken(c.env);
  if (token) {
    const clipData = await getClipFromTwitch(slug, token, c.env.TWITCH_CLIENT_ID);
    if (clipData?.thumbnail_url) {
      const result = await fetchAndCacheThumbnail(slug, clipData.thumbnail_url, c.env.THUMBNAIL_CACHE);
      if (result.success) {
        // Fetch the newly cached image
        const newCached = await c.env.THUMBNAIL_CACHE.getWithMetadata(cacheKey, 'arrayBuffer');
        if (newCached.value) {
          const metadata = newCached.metadata as { contentType?: string } | null;
          return new Response(newCached.value, {
            headers: {
              'Content-Type': metadata?.contentType || 'image/jpeg',
              'Cache-Control': `public, max-age=${BROWSER_CACHE_MAX_AGE}, immutable`,
              'X-Cache': 'MISS',
            },
          });
        }
      }
    }
  }

  // Failed to fetch - return placeholder and cache it
  const placeholderBuffer = new TextEncoder().encode(PLACEHOLDER_SVG);

  await c.env.THUMBNAIL_CACHE.put(cacheKey, placeholderBuffer, {
    expirationTtl: CACHE_TTL / 10, // Shorter TTL for placeholder (3 days)
    metadata: { contentType: 'image/svg+xml', isPlaceholder: true },
  });

  return new Response(placeholderBuffer, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${BROWSER_CACHE_MAX_AGE / 7}, immutable`,
      'X-Cache': 'PLACEHOLDER',
    },
  });
});

/**
 * Seed thumbnails for all clips in database (admin only)
 * POST /api/thumbnails/seed
 */
thumbnails.post('/seed', async (c) => {
  // Require admin access
  const authResult = await requireAdmin(c);
  if (!authResult.authorized) {
    return authResult.response;
  }

  // Get all clips from database
  const clips = await c.env.DB
    .prepare('SELECT twitch_slug FROM clips WHERE is_active = 1')
    .all<{ twitch_slug: string }>();

  if (!clips.results || clips.results.length === 0) {
    return c.json({ error: 'No clips found' }, 404);
  }

  // Get Twitch token
  const token = await getTwitchToken(c.env);
  if (!token) {
    return c.json({ error: 'Failed to get Twitch token' }, 500);
  }

  const results = {
    total: clips.results.length,
    success: 0,
    alreadyCached: 0,
    failed: 0,
    errors: [] as string[],
  };

  // Process in batches of 100 (Twitch API limit)
  const batchSize = 100;
  const slugs = clips.results.map((c) => c.twitch_slug);

  for (let i = 0; i < slugs.length; i += batchSize) {
    const batch = slugs.slice(i, i + batchSize);

    // Fetch batch from Twitch API
    const idsParam = batch.map((s) => `id=${encodeURIComponent(s)}`).join('&');
    try {
      const response = await fetch(`https://api.twitch.tv/helix/clips?${idsParam}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Client-Id': c.env.TWITCH_CLIENT_ID,
        },
      });

      if (!response.ok) {
        results.errors.push(`Batch ${i / batchSize + 1} failed: ${response.status}`);
        results.failed += batch.length;
        continue;
      }

      const data = await response.json() as { data: Array<{ id: string; thumbnail_url: string }> };
      const clipMap = new Map(data.data.map((c) => [c.id, c.thumbnail_url]));

      // Cache each thumbnail
      for (const slug of batch) {
        const thumbnailUrl = clipMap.get(slug);
        if (!thumbnailUrl) {
          results.failed++;
          continue;
        }

        const result = await fetchAndCacheThumbnail(slug, thumbnailUrl, c.env.THUMBNAIL_CACHE);
        if (result.success) {
          if (result.cached) {
            results.alreadyCached++;
          } else {
            results.success++;
          }
        } else {
          results.failed++;
        }
      }
    } catch (e) {
      results.errors.push(`Batch ${i / batchSize + 1} error: ${e}`);
      results.failed += batch.length;
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < slugs.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return c.json(results);
});

/**
 * Purge a specific thumbnail from cache (admin only)
 */
thumbnails.delete('/:slug', async (c) => {
  // Require admin access
  const authResult = await requireAdmin(c);
  if (!authResult.authorized) {
    return authResult.response;
  }

  const slug = c.req.param('slug');
  const cacheKey = `thumb:${slug}`;

  await c.env.THUMBNAIL_CACHE.delete(cacheKey);

  return c.json({ success: true, purged: slug });
});

/**
 * Purge all thumbnails (admin only)
 */
thumbnails.delete('/purge/all', async (c) => {
  // Require admin access
  const authResult = await requireAdmin(c);
  if (!authResult.authorized) {
    return authResult.response;
  }

  // List all keys and delete them
  let cursor: string | undefined;
  let deleted = 0;

  do {
    const list = await c.env.THUMBNAIL_CACHE.list({ cursor, prefix: 'thumb:' });
    for (const key of list.keys) {
      await c.env.THUMBNAIL_CACHE.delete(key.name);
      deleted++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return c.json({ success: true, deleted });
});

export default thumbnails;

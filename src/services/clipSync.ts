/**
 * Clip Sync Service
 * Automatically fetches recent clips from Twitch and adds new ones to the database
 */

import { getClipBySlug, createClipWithMetadata } from '../db/queries';

const ARROSS_BROADCASTER_ID = '76024422';
const CLIPS_PER_PAGE = 100;
const DAYS_TO_FETCH = 3;
const MAX_PAGES = 10; // Safety limit

interface TwitchClipData {
  id: string;
  url: string;
  embed_url: string;
  broadcaster_id: string;
  broadcaster_name: string;
  creator_id: string;
  creator_name: string;
  title: string;
  created_at: string;
  thumbnail_url: string;
  duration: number;
}

interface TwitchClipsResponse {
  data: TwitchClipData[];
  pagination?: {
    cursor?: string;
  };
}

interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface ClipSyncResult {
  added: number;
  skipped: number;
  errors: string[];
}

/**
 * Get an app access token using client credentials flow
 */
async function getAppAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get Twitch app token: ${response.status}`);
  }

  const data = (await response.json()) as TwitchTokenResponse;
  return data.access_token;
}

/**
 * Fetch clips from a broadcaster within a date range
 * Handles pagination automatically
 */
async function fetchBroadcasterClips(
  clientId: string,
  accessToken: string,
  startedAt: Date,
  endedAt: Date
): Promise<TwitchClipData[]> {
  const allClips: TwitchClipData[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const params = new URLSearchParams({
      broadcaster_id: ARROSS_BROADCASTER_ID,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      first: String(CLIPS_PER_PAGE),
    });

    if (cursor) {
      params.set('after', cursor);
    }

    const response = await fetch(
      `https://api.twitch.tv/helix/clips?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': clientId,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Twitch API error: ${response.status}`);
    }

    const data = (await response.json()) as TwitchClipsResponse;
    allClips.push(...data.data);

    cursor = data.pagination?.cursor;
    pageCount++;

    console.log(`[SYNC] Fetched page ${pageCount}: ${data.data.length} clips`);
  } while (cursor && pageCount < MAX_PAGES);

  return allClips;
}

/**
 * Sync recent clips from Twitch to the database
 */
export async function syncRecentClips(
  db: D1Database,
  clientId: string,
  clientSecret: string
): Promise<ClipSyncResult> {
  console.log('[SYNC] Starting clip sync...');
  const startTime = Date.now();

  // Calculate date range: last N days
  const endedAt = new Date();
  const startedAt = new Date();
  startedAt.setDate(startedAt.getDate() - DAYS_TO_FETCH);

  console.log(`[SYNC] Date range: ${startedAt.toISOString()} to ${endedAt.toISOString()}`);

  // Get access token
  let accessToken: string;
  try {
    accessToken = await getAppAccessToken(clientId, clientSecret);
  } catch (error) {
    console.error('[SYNC] Failed to get access token:', error);
    return { added: 0, skipped: 0, errors: [`Token error: ${error}`] };
  }

  // Fetch clips from Twitch
  let clips: TwitchClipData[];
  try {
    clips = await fetchBroadcasterClips(clientId, accessToken, startedAt, endedAt);
  } catch (error) {
    console.error('[SYNC] Failed to fetch clips from Twitch:', error);
    return { added: 0, skipped: 0, errors: [`Twitch API error: ${error}`] };
  }

  console.log(`[SYNC] Fetched ${clips.length} clips from Twitch`);

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Process each clip
  for (const clip of clips) {
    try {
      // Check if clip already exists
      const existing = await getClipBySlug(db, clip.id);

      if (existing) {
        skipped++;
        continue;
      }

      // Insert new clip with creator info
      await createClipWithMetadata(db, clip.id, clip.title, clip.url, clip.creator_name, null);

      added++;
      console.log(`[SYNC] Added clip: ${clip.id} - "${clip.title}"`);
    } catch (error) {
      errors.push(`Failed to add clip ${clip.id}: ${error}`);
      console.error(`[SYNC] Error adding clip ${clip.id}:`, error);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[SYNC] Complete in ${elapsed}ms: added=${added}, skipped=${skipped}, errors=${errors.length}`);

  return { added, skipped, errors };
}

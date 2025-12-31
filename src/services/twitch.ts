/**
 * Twitch API Service
 * Handles clip validation and metadata fetching
 */

// Arross's Twitch broadcaster ID
const ARROSS_BROADCASTER_ID = '76024422';
const ARROSS_BROADCASTER_NAME = 'arross';

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
}

interface TwitchAppToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Extract clip slug from various Twitch URL formats
 */
export function extractClipSlug(url: string): string | null {
  // Handle various URL formats:
  // https://clips.twitch.tv/SlugHere
  // https://www.twitch.tv/arross/clip/SlugHere
  // https://twitch.tv/arross/clip/SlugHere

  try {
    const urlObj = new URL(url);

    // clips.twitch.tv format
    if (urlObj.hostname === 'clips.twitch.tv') {
      const slug = urlObj.pathname.slice(1).split('?')[0];
      return slug || null;
    }

    // twitch.tv/channel/clip/slug format
    if (urlObj.hostname === 'www.twitch.tv' || urlObj.hostname === 'twitch.tv') {
      const match = urlObj.pathname.match(/\/[^/]+\/clip\/([^/?]+)/);
      return match ? match[1] : null;
    }

    return null;
  } catch {
    return null;
  }
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

  const data = (await response.json()) as TwitchAppToken;
  return data.access_token;
}

/**
 * Fetch clip data from Twitch API
 */
export async function fetchClipData(
  slug: string,
  clientId: string,
  clientSecret: string
): Promise<TwitchClipData | null> {
  const accessToken = await getAppAccessToken(clientId, clientSecret);

  const response = await fetch(`https://api.twitch.tv/helix/clips?id=${encodeURIComponent(slug)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Twitch API error: ${response.status}`);
  }

  const data = (await response.json()) as TwitchClipsResponse;
  return data.data[0] || null;
}

/**
 * Validate that a clip belongs to Arross's channel
 */
export function isArrossClip(clipData: TwitchClipData): boolean {
  return (
    clipData.broadcaster_id === ARROSS_BROADCASTER_ID ||
    clipData.broadcaster_name.toLowerCase() === ARROSS_BROADCASTER_NAME
  );
}

/**
 * Full validation and fetch for a clip URL
 */
export async function validateAndFetchClip(
  url: string,
  clientId: string,
  clientSecret: string
): Promise<{
  valid: boolean;
  error?: string;
  clip?: TwitchClipData;
  slug?: string;
}> {
  // Extract slug from URL
  const slug = extractClipSlug(url);
  if (!slug) {
    return { valid: false, error: 'Invalid Twitch clip URL format' };
  }

  // Fetch clip data from Twitch
  let clipData: TwitchClipData | null;
  try {
    clipData = await fetchClipData(slug, clientId, clientSecret);
  } catch (err) {
    return { valid: false, error: 'Failed to fetch clip from Twitch API' };
  }

  if (!clipData) {
    return { valid: false, error: 'Clip not found on Twitch' };
  }

  // Validate it's from Arross's channel
  if (!isArrossClip(clipData)) {
    return {
      valid: false,
      error: `Clip must be from ${ARROSS_BROADCASTER_NAME}'s channel`,
    };
  }

  return { valid: true, clip: clipData, slug };
}

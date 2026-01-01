import type { Clip } from '../types';

// Minimum matches required for a clip to be eligible for Clipdle
const MIN_MATCHES = 1;

// Parse seed string to number (handles both numeric and string seeds)
export function parseSeed(seed: string): number {
  const numSeed = parseInt(seed, 10);
  if (!isNaN(numSeed)) return numSeed;

  // Hash string seeds
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Seeded random number generator (mulberry32)
function createSeededRandom(seed: number) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Seeded shuffle using Fisher-Yates
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array];
  const random = createSeededRandom(seed);

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

// Get today's seed in YYYYMMDD format
export function getTodaySeed(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export interface ClipdleClip {
  id: number;
  twitchSlug: string;
  title: string | null;
  clippedBy: string | null;
  twitchUrl: string;
}

export interface ClipdleRound {
  left: ClipdleClip;
  right: ClipdleClip;
}

export interface ClipdleGame {
  seed: string;
  totalRounds: number;
  rounds: ClipdleRound[];
  clipIds: number[]; // For validation
}

// Sanitize clip for game (hide ELO)
function sanitizeClip(clip: Clip): ClipdleClip {
  return {
    id: clip.id,
    twitchSlug: clip.twitch_slug,
    title: clip.title,
    clippedBy: clip.clipped_by,
    twitchUrl: clip.twitch_url,
  };
}

// Generate game pairs - just pair clips in order (already shuffled)
function generatePairs(clips: Clip[], seed: number): ClipdleRound[] {
  const pairs: ClipdleRound[] = [];
  const random = createSeededRandom(seed + 1);

  for (let i = 0; i < clips.length - 1; i += 2) {
    // Randomly assign left/right
    const swap = random() > 0.5;

    pairs.push({
      left: sanitizeClip(swap ? clips[i + 1] : clips[i]),
      right: sanitizeClip(swap ? clips[i] : clips[i + 1]),
    });
  }

  return pairs;
}

// Get clips for a specific seed - deterministic selection
export async function getClipdleGame(
  db: D1Database,
  seed: string,
  roundCount: number = 8
): Promise<ClipdleGame | null> {
  const clipCount = roundCount * 2; // Need 2 clips per round

  // Get all eligible clips
  const result = await db
    .prepare(
      `SELECT * FROM clips
       WHERE is_active = 1 AND global_matches >= ?
       ORDER BY id`
    )
    .bind(MIN_MATCHES)
    .all<Clip>();

  if (result.results.length < clipCount) {
    console.error(`Not enough eligible clips: ${result.results.length} < ${clipCount}`);
    return null;
  }

  // Seeded shuffle to select clips
  const numericSeed = parseSeed(seed);
  const shuffled = seededShuffle(result.results, numericSeed);
  const selectedClips = shuffled.slice(0, clipCount);

  // Generate pairs with interesting matchups
  const rounds = generatePairs(selectedClips, numericSeed);

  return {
    seed,
    totalRounds: rounds.length,
    rounds,
    clipIds: selectedClips.map(c => c.id),
  };
}

// Get a specific round's clips
export async function getClipdleRound(
  db: D1Database,
  seed: string,
  roundIndex: number,
  roundCount: number = 8
): Promise<ClipdleRound | null> {
  const game = await getClipdleGame(db, seed, roundCount);

  if (!game || roundIndex < 0 || roundIndex >= game.rounds.length) {
    return null;
  }

  return game.rounds[roundIndex];
}

// Get actual ELOs for reveal (after player picks)
export async function revealClipdleElos(
  db: D1Database,
  seed: string,
  leftId: number,
  rightId: number,
  roundCount: number = 8
): Promise<{ leftElo: number; rightElo: number; correct: 'left' | 'right' | 'tie' } | null> {
  // Validate these clips belong to this game
  const game = await getClipdleGame(db, seed, roundCount);

  if (!game || !game.clipIds.includes(leftId) || !game.clipIds.includes(rightId)) {
    return null;
  }

  // Fetch actual ELOs
  const result = await db
    .prepare(
      `SELECT id, global_elo FROM clips WHERE id IN (?, ?)`
    )
    .bind(leftId, rightId)
    .all<{ id: number; global_elo: number }>();

  if (result.results.length !== 2) {
    return null;
  }

  const leftClip = result.results.find(c => c.id === leftId)!;
  const rightClip = result.results.find(c => c.id === rightId)!;

  const correct = leftClip.global_elo > rightClip.global_elo ? 'left' :
                  rightClip.global_elo > leftClip.global_elo ? 'right' : 'tie';

  return {
    leftElo: leftClip.global_elo,
    rightElo: rightClip.global_elo,
    correct,
  };
}

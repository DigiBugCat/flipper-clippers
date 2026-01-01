import { Hono } from 'hono';
import type { Env } from '../types';
import { getClipdleGame, getClipdleRound, revealClipdleElos, getTodaySeed } from '../services/clipdleSeed';

const clipdle = new Hono<{ Bindings: Env }>();

const ROUND_COUNT = 8;

// GET /api/clipdle/game?seed=X
// Returns first round + game metadata
clipdle.get('/game', async (c) => {
  const seed = c.req.query('seed');

  if (!seed) {
    return c.json({ error: 'Missing seed parameter' }, 400);
  }

  try {
    const game = await getClipdleGame(c.env.DB, seed, ROUND_COUNT);

    if (!game) {
      return c.json({ error: 'Failed to generate game - not enough eligible clips' }, 500);
    }

    return c.json({
      seed: game.seed,
      totalRounds: game.totalRounds,
      round: 0,
      left: game.rounds[0].left,
      right: game.rounds[0].right,
    });
  } catch (error) {
    console.error('Error getting clipdle game:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/clipdle/round?seed=X&round=N
// Returns a specific round's clips
clipdle.get('/round', async (c) => {
  const seed = c.req.query('seed');
  const roundParam = c.req.query('round');

  if (!seed) {
    return c.json({ error: 'Missing seed parameter' }, 400);
  }

  if (!roundParam) {
    return c.json({ error: 'Missing round parameter' }, 400);
  }

  const roundIndex = parseInt(roundParam, 10);

  if (isNaN(roundIndex) || roundIndex < 0 || roundIndex >= ROUND_COUNT) {
    return c.json({ error: 'Invalid round number' }, 400);
  }

  try {
    const round = await getClipdleRound(c.env.DB, seed, roundIndex, ROUND_COUNT);

    if (!round) {
      return c.json({ error: 'Round not found' }, 404);
    }

    return c.json({
      seed,
      round: roundIndex,
      left: round.left,
      right: round.right,
    });
  } catch (error) {
    console.error('Error getting clipdle round:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/clipdle/reveal?seed=X&left=A&right=B
// Reveals actual ELOs after player picks
clipdle.get('/reveal', async (c) => {
  const seed = c.req.query('seed');
  const leftId = c.req.query('left');
  const rightId = c.req.query('right');

  if (!seed) {
    return c.json({ error: 'Missing seed parameter' }, 400);
  }

  if (!leftId || !rightId) {
    return c.json({ error: 'Missing clip IDs (left and right required)' }, 400);
  }

  const leftIdNum = parseInt(leftId, 10);
  const rightIdNum = parseInt(rightId, 10);

  if (isNaN(leftIdNum) || isNaN(rightIdNum)) {
    return c.json({ error: 'Invalid clip IDs' }, 400);
  }

  try {
    const result = await revealClipdleElos(c.env.DB, seed, leftIdNum, rightIdNum, ROUND_COUNT);

    if (!result) {
      return c.json({ error: 'Invalid clips for this game' }, 400);
    }

    return c.json({
      leftElo: Math.round(result.leftElo),
      rightElo: Math.round(result.rightElo),
      correct: result.correct,
      difference: Math.abs(Math.round(result.leftElo - result.rightElo)),
    });
  } catch (error) {
    console.error('Error revealing clipdle elos:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// GET /api/clipdle/today
// Returns today's seed
clipdle.get('/today', (c) => {
  return c.json({ seed: getTodaySeed() });
});

export default clipdle;

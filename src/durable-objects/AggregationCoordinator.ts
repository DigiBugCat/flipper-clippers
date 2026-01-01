import type { Env } from '../types';
import { aggregateGlobalRankings } from '../services/aggregation';

/**
 * Durable Object that coordinates global ranking aggregation.
 * Prevents duplicate aggregation runs when multiple users hit leaderboard simultaneously.
 *
 * Features:
 * - Request coalescing: Multiple simultaneous requests share one aggregation run
 * - Cooldown period: Minimum 30 seconds between aggregation runs
 * - Single instance: All requests go to the "global" instance
 */
export class AggregationCoordinator {
  private state: DurableObjectState;
  private env: Env;
  private runningAggregation: Promise<void> | null = null;
  private lastAggregation: number = 0;
  private readonly COOLDOWN_MS = 30_000; // 30s between runs

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Restore last aggregation time from storage if available
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>('lastAggregation');
      if (stored) {
        this.lastAggregation = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/trigger') {
      return this.handleTrigger();
    }

    if (url.pathname === '/status') {
      return this.handleStatus();
    }

    return Response.json({ error: 'unknown endpoint' }, { status: 404 });
  }

  private async handleTrigger(): Promise<Response> {
    const now = Date.now();

    // Cooldown check - prevent too-frequent aggregations
    if (now - this.lastAggregation < this.COOLDOWN_MS) {
      const waitMs = this.lastAggregation + this.COOLDOWN_MS - now;
      console.log(`[DO] Aggregation in cooldown, ${waitMs}ms remaining`);
      return Response.json({
        status: 'cooldown',
        nextAllowedIn: waitMs,
        nextAllowedAt: this.lastAggregation + this.COOLDOWN_MS,
      });
    }

    // If aggregation is already running, coalesce into it
    if (this.runningAggregation) {
      console.log('[DO] Coalescing into running aggregation');
      try {
        await this.runningAggregation;
        return Response.json({ status: 'coalesced' });
      } catch (error) {
        console.error('[DO] Coalesced aggregation failed:', error);
        return Response.json({ status: 'error', error: String(error) }, { status: 500 });
      }
    }

    // Start new aggregation
    console.log('[DO] Starting new aggregation');
    this.runningAggregation = this.runAggregation();

    try {
      await this.runningAggregation;
      return Response.json({ status: 'completed', timestamp: this.lastAggregation });
    } catch (error) {
      console.error('[DO] Aggregation failed:', error);
      return Response.json({ status: 'error', error: String(error) }, { status: 500 });
    } finally {
      this.runningAggregation = null;
    }
  }

  private async runAggregation(): Promise<void> {
    const startTime = Date.now();
    console.log('[DO] Running aggregation');

    // Run the actual aggregation using the D1 binding
    await aggregateGlobalRankings(this.env.DB);

    // Update last aggregation time
    this.lastAggregation = Date.now();
    await this.state.storage.put('lastAggregation', this.lastAggregation);

    console.log(`[DO] Aggregation completed in ${Date.now() - startTime}ms`);
  }

  private handleStatus(): Response {
    return Response.json({
      lastAggregation: this.lastAggregation,
      isRunning: this.runningAggregation !== null,
      cooldownMs: this.COOLDOWN_MS,
      nextAllowedAt: this.lastAggregation + this.COOLDOWN_MS,
    });
  }
}

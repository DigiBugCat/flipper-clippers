import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AggregationCoordinator } from '../../../src/durable-objects/AggregationCoordinator';
import type { Env } from '../../../src/types';

// Mock the aggregation service
vi.mock('../../../src/services/aggregation', () => ({
  aggregateGlobalRankings: vi.fn().mockResolvedValue(undefined),
}));

import { aggregateGlobalRankings } from '../../../src/services/aggregation';

/**
 * Creates a mock DurableObjectState
 */
function createMockState(initialStorage: Map<string, unknown> = new Map()) {
  const storage = new Map(initialStorage);

  return {
    storage: {
      get: vi.fn(async <T>(key: string) => storage.get(key) as T | undefined),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      list: vi.fn(async () => storage),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-id' },
    _storage: storage, // Expose for assertions
  } as unknown as DurableObjectState & { _storage: Map<string, unknown> };
}

/**
 * Creates a mock Env with D1 database
 */
function createMockEnv(): Env {
  return {
    DB: {} as D1Database, // Minimal mock since aggregation is mocked
    THUMBNAIL_CACHE: {} as KVNamespace,
    SESSION_CACHE: {} as KVNamespace,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret',
    VOTES_ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    AGGREGATION_COORDINATOR: {} as DurableObjectNamespace,
    VOTE_QUEUE: { send: vi.fn() } as unknown as Queue<unknown>,
  };
}

describe('AggregationCoordinator', () => {
  let coordinator: AggregationCoordinator;
  let mockState: DurableObjectState & { _storage: Map<string, unknown> };
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    mockState = createMockState();
    mockEnv = createMockEnv();
    coordinator = new AggregationCoordinator(mockState, mockEnv);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('/trigger endpoint', () => {
    it('returns completed on successful aggregation', async () => {
      const request = new Request('https://do/trigger');
      const response = await coordinator.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json<{ status: string; timestamp: number }>();
      expect(data.status).toBe('completed');
      expect(data.timestamp).toBeDefined();
      expect(aggregateGlobalRankings).toHaveBeenCalledWith(mockEnv.DB);
    });

    it('returns cooldown when within 30s cooldown period', async () => {
      // First trigger succeeds
      const request1 = new Request('https://do/trigger');
      await coordinator.fetch(request1);

      // Advance time by 10 seconds (within cooldown)
      vi.advanceTimersByTime(10_000);

      // Second trigger should be in cooldown
      const request2 = new Request('https://do/trigger');
      const response = await coordinator.fetch(request2);

      expect(response.status).toBe(200);
      const data = await response.json<{ status: string; nextAllowedIn: number }>();
      expect(data.status).toBe('cooldown');
      expect(data.nextAllowedIn).toBeGreaterThan(0);
      expect(data.nextAllowedIn).toBeLessThanOrEqual(20_000); // ~20s remaining

      // aggregateGlobalRankings should only have been called once
      expect(aggregateGlobalRankings).toHaveBeenCalledTimes(1);
    });

    it('allows trigger after cooldown expires', async () => {
      // First trigger
      const request1 = new Request('https://do/trigger');
      await coordinator.fetch(request1);

      // Advance time past cooldown (35 seconds)
      vi.advanceTimersByTime(35_000);

      // Second trigger should succeed
      const request2 = new Request('https://do/trigger');
      const response = await coordinator.fetch(request2);

      expect(response.status).toBe(200);
      const data = await response.json<{ status: string }>();
      expect(data.status).toBe('completed');
      expect(aggregateGlobalRankings).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent requests into single aggregation', async () => {
      // Simulate slow aggregation
      let resolveAggregation: () => void;
      const slowAggregation = new Promise<void>((resolve) => {
        resolveAggregation = resolve;
      });
      vi.mocked(aggregateGlobalRankings).mockReturnValueOnce(slowAggregation);

      // Start first request (won't complete immediately)
      const request1 = new Request('https://do/trigger');
      const response1Promise = coordinator.fetch(request1);

      // Start second request while first is running
      const request2 = new Request('https://do/trigger');
      const response2Promise = coordinator.fetch(request2);

      // Complete the aggregation
      resolveAggregation!();

      // Wait for both responses
      const [response1, response2] = await Promise.all([response1Promise, response2Promise]);

      // First should complete
      const data1 = await response1.json<{ status: string }>();
      expect(data1.status).toBe('completed');

      // Second should be coalesced
      const data2 = await response2.json<{ status: string }>();
      expect(data2.status).toBe('coalesced');

      // Aggregation should only run once
      expect(aggregateGlobalRankings).toHaveBeenCalledTimes(1);
    });

    it('handles aggregation errors gracefully', async () => {
      vi.mocked(aggregateGlobalRankings).mockRejectedValueOnce(new Error('DB connection failed'));

      const request = new Request('https://do/trigger');
      const response = await coordinator.fetch(request);

      expect(response.status).toBe(500);
      const data = await response.json<{ status: string; error: string }>();
      expect(data.status).toBe('error');
      expect(data.error).toContain('DB connection failed');
    });

    it('propagates error to coalesced requests', async () => {
      // Simulate slow aggregation that will fail
      let rejectAggregation: (err: Error) => void;
      const failingAggregation = new Promise<void>((_, reject) => {
        rejectAggregation = reject;
      });
      vi.mocked(aggregateGlobalRankings).mockReturnValueOnce(failingAggregation);

      // Start first request
      const request1 = new Request('https://do/trigger');
      const response1Promise = coordinator.fetch(request1);

      // Start second request while first is running
      const request2 = new Request('https://do/trigger');
      const response2Promise = coordinator.fetch(request2);

      // Fail the aggregation
      rejectAggregation!(new Error('Aggregation failed'));

      // Wait for both responses
      const [response1, response2] = await Promise.all([response1Promise, response2Promise]);

      // Both should get error status
      const data1 = await response1.json<{ status: string; error: string }>();
      expect(data1.status).toBe('error');
      expect(data1.error).toContain('Aggregation failed');

      const data2 = await response2.json<{ status: string; error: string }>();
      expect(data2.status).toBe('error');
      expect(data2.error).toContain('Aggregation failed');
    });

    it('persists lastAggregation to storage', async () => {
      const request = new Request('https://do/trigger');
      await coordinator.fetch(request);

      expect(mockState.storage.put).toHaveBeenCalledWith(
        'lastAggregation',
        expect.any(Number)
      );
      expect(mockState._storage.get('lastAggregation')).toBeDefined();
    });

    it('restores lastAggregation from storage on init', async () => {
      // Create coordinator with existing storage value (10 seconds ago, within 30s cooldown)
      const tenSecondsAgo = Date.now() - 10_000;
      const stateWithHistory = createMockState(new Map([['lastAggregation', tenSecondsAgo]]));
      const newCoordinator = new AggregationCoordinator(stateWithHistory, mockEnv);

      // Need to wait for blockConcurrencyWhile to complete
      await Promise.resolve();

      // Should be in cooldown (10s ago < 30s cooldown)
      const request = new Request('https://do/trigger');
      const response = await newCoordinator.fetch(request);

      const data = await response.json<{ status: string }>();
      expect(data.status).toBe('cooldown');
    });
  });

  describe('/status endpoint', () => {
    it('returns correct status object', async () => {
      const request = new Request('https://do/status');
      const response = await coordinator.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json<{
        lastAggregation: number;
        isRunning: boolean;
        cooldownMs: number;
        nextAllowedAt: number;
      }>();

      expect(data.lastAggregation).toBe(0); // Never ran
      expect(data.isRunning).toBe(false);
      expect(data.cooldownMs).toBe(30_000);
      expect(data.nextAllowedAt).toBe(30_000);
    });

    it('shows updated status after aggregation', async () => {
      // Run aggregation first
      const triggerRequest = new Request('https://do/trigger');
      await coordinator.fetch(triggerRequest);

      // Check status
      const statusRequest = new Request('https://do/status');
      const response = await coordinator.fetch(statusRequest);

      const data = await response.json<{
        lastAggregation: number;
        isRunning: boolean;
        nextAllowedAt: number;
      }>();

      expect(data.lastAggregation).toBeGreaterThan(0);
      expect(data.isRunning).toBe(false);
      expect(data.nextAllowedAt).toBeGreaterThan(data.lastAggregation);
    });

    it('shows isRunning true during aggregation', async () => {
      // Simulate slow aggregation
      let resolveAggregation: () => void;
      const slowAggregation = new Promise<void>((resolve) => {
        resolveAggregation = resolve;
      });
      vi.mocked(aggregateGlobalRankings).mockReturnValueOnce(slowAggregation);

      // Start aggregation without awaiting
      const triggerRequest = new Request('https://do/trigger');
      const triggerPromise = coordinator.fetch(triggerRequest);

      // Check status while running
      const statusRequest = new Request('https://do/status');
      const response = await coordinator.fetch(statusRequest);

      const data = await response.json<{ isRunning: boolean }>();
      expect(data.isRunning).toBe(true);

      // Clean up
      resolveAggregation!();
      await triggerPromise;
    });
  });

  describe('error handling', () => {
    it('returns 404 for unknown endpoints', async () => {
      const request = new Request('https://do/unknown');
      const response = await coordinator.fetch(request);

      expect(response.status).toBe(404);
      const data = await response.json<{ error: string }>();
      expect(data.error).toBe('unknown endpoint');
    });

    it('returns 404 for root path', async () => {
      const request = new Request('https://do/');
      const response = await coordinator.fetch(request);

      expect(response.status).toBe(404);
    });
  });
});

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock crypto.getRandomValues for deterministic tests
beforeAll(() => {
  vi.stubGlobal('crypto', {
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) {
        array[i] = i % 256;
      }
      return array;
    },
    randomUUID: () => '00000000-0000-0000-0000-000000000000',
    subtle: globalThis.crypto?.subtle,
  });
});

// Clear all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Unstub all globals after all tests complete
afterAll(() => {
  vi.unstubAllGlobals();
});

// Helper function to create a deterministic random number generator
export function createDeterministicRandom(seed: number = 0): () => number {
  let currentSeed = seed;
  return () => {
    currentSeed = (currentSeed * 1103515245 + 12345) & 0x7fffffff;
    return currentSeed / 0x7fffffff;
  };
}

// Helper function to generate deterministic UUIDs
export function createDeterministicUUID(index: number = 0): string {
  const hex = index.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Helper to reset mocks to initial state
export function resetAllMocks(): void {
  vi.clearAllMocks();
  vi.resetAllMocks();
}

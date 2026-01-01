/**
 * Mock KV Namespace for testing
 */

interface KVListResult {
  keys: { name: string; expiration?: number; metadata?: unknown }[];
  list_complete: boolean;
  cursor?: string;
}

interface KVGetWithMetadataResult<T, M> {
  value: T | null;
  metadata: M | null;
}

interface KVPutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

interface StoredValue {
  value: string;
  metadata?: unknown;
  expiration?: number;
}

export function createMockKV() {
  const storage = new Map<string, StoredValue>();

  return {
    async get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' } | 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<string | object | ArrayBuffer | ReadableStream | null> {
      const stored = storage.get(key);
      if (!stored) return null;

      // Check expiration
      if (stored.expiration && stored.expiration < Date.now() / 1000) {
        storage.delete(key);
        return null;
      }

      // Handle both string and object options (Cloudflare KV supports both)
      const type = typeof options === 'string' ? options : (options?.type || 'text');
      switch (type) {
        case 'json':
          return JSON.parse(stored.value);
        case 'arrayBuffer':
          return new TextEncoder().encode(stored.value).buffer;
        case 'text':
        default:
          return stored.value;
      }
    },

    async getWithMetadata<T = string, M = unknown>(
      key: string,
      options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }
    ): Promise<KVGetWithMetadataResult<T, M>> {
      const stored = storage.get(key);
      if (!stored) {
        return { value: null, metadata: null };
      }

      // Check expiration
      if (stored.expiration && stored.expiration < Date.now() / 1000) {
        storage.delete(key);
        return { value: null, metadata: null };
      }

      const type = options?.type || 'text';
      let value: unknown;
      switch (type) {
        case 'json':
          value = JSON.parse(stored.value);
          break;
        case 'text':
        default:
          value = stored.value;
      }

      return {
        value: value as T,
        metadata: (stored.metadata as M) || null,
      };
    },

    async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: KVPutOptions): Promise<void> {
      let stringValue: string;
      if (typeof value === 'string') {
        stringValue = value;
      } else if (value instanceof ArrayBuffer) {
        stringValue = new TextDecoder().decode(value);
      } else {
        // For streams, just store empty string in mock
        stringValue = '';
      }

      const stored: StoredValue = {
        value: stringValue,
        metadata: options?.metadata,
      };

      if (options?.expiration) {
        stored.expiration = options.expiration;
      } else if (options?.expirationTtl) {
        stored.expiration = Math.floor(Date.now() / 1000) + options.expirationTtl;
      }

      storage.set(key, stored);
    },

    async delete(key: string): Promise<void> {
      storage.delete(key);
    },

    async list(options?: KVListOptions): Promise<KVListResult> {
      const prefix = options?.prefix || '';
      const limit = options?.limit || 1000;

      const keys: { name: string; expiration?: number; metadata?: unknown }[] = [];
      const now = Date.now() / 1000;

      for (const [key, stored] of storage.entries()) {
        if (key.startsWith(prefix)) {
          // Skip expired keys
          if (stored.expiration && stored.expiration < now) {
            storage.delete(key);
            continue;
          }

          keys.push({
            name: key,
            expiration: stored.expiration,
            metadata: stored.metadata,
          });

          if (keys.length >= limit) {
            break;
          }
        }
      }

      return {
        keys,
        list_complete: keys.length < limit,
        cursor: keys.length >= limit ? 'mock-cursor' : undefined,
      };
    },

    // Helper methods for test setup
    _storage: storage,
    _reset() {
      storage.clear();
    },
    _set(key: string, value: string, metadata?: unknown) {
      storage.set(key, { value, metadata });
    },
  };
}

export type MockKVNamespace = ReturnType<typeof createMockKV>;

/**
 * Mock D1 Database for testing
 */

interface MockStatement {
  sql: string;
  params: unknown[];
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    served_by: string;
  };
}

export function createMockD1() {
  const storage = new Map<string, Map<string, unknown>>();

  const createStatement = (sql: string, params: unknown[] = []) => {
    return {
      bind(...bindParams: unknown[]) {
        return createStatement(sql, bindParams);
      },
      async first<T = unknown>(columnName?: string): Promise<T | null> {
        const results = await this.all<T>();
        if (results.results.length === 0) return null;
        if (columnName) {
          return (results.results[0] as Record<string, unknown>)[columnName] as T;
        }
        return results.results[0];
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        // Simple mock implementation - returns empty results by default
        // Tests should override this behavior as needed
        return {
          results: [] as T[],
          success: true,
          meta: {
            duration: 0,
            changes: 0,
            last_row_id: 0,
            served_by: 'mock',
          },
        };
      },
      async run(): Promise<D1Result> {
        return {
          results: [],
          success: true,
          meta: {
            duration: 0,
            changes: 1,
            last_row_id: 1,
            served_by: 'mock',
          },
        };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        return [] as T[];
      },
    };
  };

  return {
    prepare(sql: string) {
      return createStatement(sql);
    },
    async batch<T = unknown>(statements: ReturnType<typeof createStatement>[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.all<T>());
      }
      return results;
    },
    async exec(sql: string): Promise<D1Result> {
      return {
        results: [],
        success: true,
        meta: {
          duration: 0,
          changes: 0,
          last_row_id: 0,
          served_by: 'mock',
        },
      };
    },
    // Helper methods for test setup
    _storage: storage,
    _reset() {
      storage.clear();
    },
  };
}

export type MockD1Database = ReturnType<typeof createMockD1>;

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Default configuration for backward compatibility
// When vitest.workspace.ts exists, it takes precedence
export default defineWorkersConfig({
  test: {
    // Only include unit tests in default config (safe for Workers pool)
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],

    // Global setup file
    setupFiles: ["./tests/setup/global-setup.ts"],

    // Use Cloudflare Workers pool
    pool: "@cloudflare/vitest-pool-workers",

    // Pool-specific options for Workers
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.toml",
        },
        miniflare: {
          d1Databases: {
            DB: "clip-ranker-db",
          },
          kvNamespaces: ["THUMBNAIL_CACHE", "SESSION_CACHE"],
        },
      },
    },

    // Coverage configuration (run with --coverage flag)
    // Note: v8 coverage doesn't work with Workers pool due to node:inspector
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts", "src/**/*.spec.ts"],
    },

    reporters: ["default"],
    globals: true,
  },
});

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// All tests now use mocks and can run in the Workers pool
export default [
  defineWorkersConfig({
    test: {
      name: "workers",
      include: [
        "tests/unit/**/*.{test,spec}.{ts,tsx}",
        "tests/integration/**/*.{test,spec}.{ts,tsx}",
      ],
      exclude: ["node_modules"],
      setupFiles: ["./tests/setup/global-setup.ts"],
      pool: "@cloudflare/vitest-pool-workers",
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
      globals: true,
      reporters: ["default"],
    },
  }),
];

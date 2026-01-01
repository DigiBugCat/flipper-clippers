# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Flipper Clippers is a Twitch clip ranking app built on Cloudflare Workers. Users vote on pairs of clips to build personal and global leaderboards using an ELO rating system. Includes Clipdle (daily "guess the higher ELO" game) at a separate subdomain.

**Live:** flipper-clippers.arross.tv | **Clipdle:** clipdle.arross.tv

## Commands

```bash
# Development
npm run dev                    # Build frontend + start wrangler dev server
npm run dev:clipdle            # Run clipdle worker locally
npm run build:frontend         # Build TypeScript frontend → public/js/
npm run build:frontend:watch   # Watch mode for frontend

# Testing
npm test                       # Run all tests (unit + integration)
npm run test:unit              # Unit tests only
npm run test:integration       # Integration tests only
npm run test:watch             # Watch mode
vitest run tests/unit/services/rating.test.ts  # Single test file

# Database
npm run db:migrate:local       # Apply schema to local D1
npm run db:migrate             # Apply schema to remote D1
npm run check:migrations       # Validate migration files

# Deployment
npm run deploy                 # Test → check migrations → build → deploy main worker
npm run deploy:clipdle         # Deploy clipdle worker
npm run deploy:all             # Deploy both workers
npm run deploy:skip-tests      # Deploy without tests (use sparingly)
```

## Architecture

### Request Flow
```
Browser → CDN Cache → Hono Worker → KV Cache → D1 Database
                    ↘ Vote Queue (async) → Rollup updates
                    ↘ Durable Object → Aggregation coordination
                    ↘ Analytics Engine → Vote audit log
```

### Directory Structure

**Backend (`src/`):**
- `index.ts` - Main worker entry, routes all `/api/*` endpoints
- `clipdle.ts` - Separate worker entry for clipdle.arross.tv
- `handlers/` - HTTP route handlers (one file per feature: auth, compare, leaderboard, social, etc.)
- `services/` - Business logic (rating.ts for ELO, pairing.ts for clip selection, aggregation.ts for rollups)
- `db/` - Schema and query helpers
- `durable-objects/` - AggregationCoordinator prevents duplicate aggregation runs
- `queues/` - Vote queue consumer for async rollup updates
- `middleware/` - Auth middleware (requireAuth, optionalAuth)

**Frontend (`src/frontend/` → `public/js/`):**
- TypeScript compiled via esbuild to browser JS
- Separate tsconfig: `tsconfig.frontend.json` (targets DOM)
- Each page has corresponding TS file (compare.ts, leaderboard.ts, feed.ts)

**Tests (`tests/`):**
- All tests run in Cloudflare Workers pool via `@cloudflare/vitest-pool-workers`
- `fixtures/` - Factory functions for test data (createTestUser, createTestClip)
- `setup/global-setup.ts` - Mocks crypto for deterministic tests

### Key Patterns

**Two Workers:** Main app (`wrangler.toml`) and Clipdle (`wrangler.clipdle.toml`) share the same D1 database.

**Vote Processing:** Synchronous path returns fast (~50ms), enqueues to VOTE_QUEUE for async rollup updates.

**Session Caching:** SESSION_CACHE KV checked before D1 lookup. 60s TTL.

**Aggregation:** Durable Object (single global instance) prevents duplicate expensive aggregations. 30s cooldown between runs.

**Pairing Algorithm:** `services/pairing.ts` prioritizes unseen clips, uses HMAC-signed cookies to batch 10 pairs.

### Types

All database models and API types in `src/types.ts`. Key interfaces: `Env` (Cloudflare bindings), `User`, `Clip`, `VoteResult`, `VoteQueueMessage`.

## Testing Notes

- Tests use miniflare with in-memory D1 and KV
- Integration tests in `tests/integration/handlers/` test full request/response cycle
- Use `createTestUser()` and similar factories from `tests/fixtures/`
- Crypto is mocked globally for deterministic UUID/random generation

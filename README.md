# Flipper Clippers

A "This or That" clip ranking app - vote on pairs of Twitch clips to build personal and global leaderboards using an ELO rating system.

**Live at: [flipper-clippers.arross.tv](https://flipper-clippers.arross.tv)**

## Screenshots

### Homepage
![Homepage](screenshots/homepage.png)

### Compare Clips
![Compare](screenshots/compare.png)

### Leaderboard
![Leaderboard](screenshots/leaderboard.png)

## Architecture

```mermaid
flowchart TD
    subgraph Client["① Client Layer"]
        Browser["Browser"]
        BCache["Browser Cache<br/>thumbnails 7d"]
        Cookie["Signed Cookie<br/>pairs 1h"]
    end

    subgraph Edge["② Edge Layer (300+ PoPs)"]
        CDN["CDN Cache<br/>API 1-30min"]
        Worker["Hono Worker"]
        KV["KV Store<br/>sessions 60s, thumbs 30d"]
    end

    subgraph Data["③ Data Layer"]
        Rollups["D1 Rollups<br/>stale after 5min"]
        Tables["D1 Tables<br/>source of truth"]
    end

    Twitch["④ External<br/>Twitch API"]

    Browser --> BCache
    BCache -->|miss| CDN
    CDN -->|miss| Worker
    Cookie -.->|with request| Worker
    Worker <--> KV
    KV -->|miss| Rollups
    Rollups -->|stale| Tables
    Worker <--> Twitch
```

### Serverless-First Design

Optimized for edge computing with multi-layer caching:

| Layer | What's Cached | TTL | Purpose |
|-------|--------------|-----|---------|
| **Browser** | Thumbnails | 7 days | Eliminate repeat image fetches |
| **Cookie** | Next 10 clip pairs | 1 hour | Reduce pairing queries by 10x |
| **CDN** | API responses | 1-30 min | Edge-cached leaderboards & clip data |
| **KV** | Sessions | 60s | Skip auth DB lookups |
| **KV** | Thumbnails | 30 days | Cache Twitch images at edge |
| **D1** | Rollup tables | 5 min staleness | Pre-aggregated global rankings |

**Key optimizations:**
- **Lazy Aggregation**: Global rankings recalculate only on cache miss, not on a schedule
- **Incremental Rollups**: Each vote updates rollup sums immediately (2 queries vs full recalc)
- **Cookie-Based Batching**: Pre-calculates 10 comparison pairs per batch, HMAC-signed to prevent tampering
- **Session Caching**: KV lookup before D1, reducing auth overhead from 2 queries to 0 on cache hit

## Features

- **Pairwise Comparison**: Vote on which clip is better in head-to-head matchups
- **ELO Rating System**: Clips are ranked using a modified Glicko-style rating system
- **Personal & Global Leaderboards**: See your own rankings vs. the community consensus
- **Super Likes**: Mark your absolute favorite clips
- **Save Clips**: Build a personal collection of favorites
- **Twitch OAuth**: Sign in with your Twitch account
- **Smart Pairing**: Algorithm prioritizes showing unseen clips for full coverage

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev/) - Ultrafast web framework
- **Database**: Cloudflare D1 (SQLite)
- **Auth**: Twitch OAuth 2.0
- **Frontend**: Vanilla JS with Twitch embed player

## Development

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account
- Twitch Developer Application

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/DigiBugCat/flipper-clippers.git
   cd flipper-clippers
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a D1 database:
   ```bash
   wrangler d1 create clip-ranker-db
   ```

4. Update `wrangler.toml` with your database ID

5. Create `.dev.vars` for local secrets:
   ```
   TWITCH_CLIENT_SECRET=your_twitch_client_secret
   SESSION_SECRET=your_session_secret
   ```

6. Run database migrations:
   ```bash
   npm run db:migrate:local
   ```

7. Import clips (optional):
   ```bash
   node scripts/generate-import-sql.js path/to/clips.csv
   wrangler d1 execute clip-ranker-db --local --file=scripts/import-clips.sql
   ```

8. Start development server:
   ```bash
   npm run dev
   ```

### Deployment

1. Set production secrets:
   ```bash
   echo "your_secret" | wrangler secret put TWITCH_CLIENT_SECRET
   echo "your_secret" | wrangler secret put SESSION_SECRET
   ```

2. Run production migrations:
   ```bash
   wrangler d1 execute clip-ranker-db --remote --file=src/db/schema.sql
   ```

3. Deploy:
   ```bash
   npm run deploy
   ```

## CSV Format for Clip Import

```csv
Title,Uploader,Date,URL
"Clip Title","ClipperName",20241231,https://www.twitch.tv/channel/clip/ClipSlug
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/compare/next` | Get next pair to compare |
| `POST /api/compare/vote` | Submit a vote |
| `GET /api/leaderboard` | Global leaderboard |
| `GET /api/leaderboard/me` | Personal leaderboard |
| `POST /api/aggregate` | Manual aggregation trigger (runs lazily on leaderboard miss) |

## License

MIT License - see [LICENSE](LICENSE) file for details.

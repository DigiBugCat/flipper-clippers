/**
 * Script to import clips from clips_list.txt into D1 database
 *
 * Usage:
 * 1. First, create the D1 database and run migrations:
 *    wrangler d1 create clip-ranker-db
 *    wrangler d1 execute clip-ranker-db --local --file=src/db/schema.sql
 *
 * 2. Generate the SQL insert statements:
 *    npx ts-node scripts/import-clips.ts > scripts/import-clips.sql
 *
 * 3. Run the generated SQL:
 *    wrangler d1 execute clip-ranker-db --local --file=scripts/import-clips.sql
 *
 * Or for production:
 *    wrangler d1 execute clip-ranker-db --file=scripts/import-clips.sql
 */

import * as fs from 'fs';
import * as path from 'path';

// Path to clips list file
const CLIPS_FILE = path.join(__dirname, '..', 'clips_list.txt');

// Parse a Twitch clip URL to extract the slug
function parseClipUrl(url: string): { slug: string; fullUrl: string } | null {
  const match = url.match(/twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/);
  if (!match) return null;

  return {
    slug: match[1],
    fullUrl: url.trim(),
  };
}

// Generate a title from the slug (best effort)
function generateTitle(slug: string): string {
  // The slug format is like "AdventurousDependableMooseTBCheesePull-9YO5mlqy9X9FzGQn"
  // Split on the hash part and use the readable part
  const parts = slug.split('-');
  if (parts.length > 1) {
    // Take everything except the last part (the hash)
    const readablePart = parts.slice(0, -1).join('-');
    // Add spaces before capital letters
    return readablePart.replace(/([A-Z])/g, ' $1').trim();
  }
  return slug;
}

// Escape single quotes for SQL
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

// Main function
function main() {
  // Read the clips file
  const content = fs.readFileSync(CLIPS_FILE, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  const clips: Array<{ slug: string; title: string; url: string }> = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const parsed = parseClipUrl(line);
    if (!parsed) {
      console.error(`-- Skipping invalid URL: ${line}`);
      continue;
    }

    // Deduplicate by slug
    if (seen.has(parsed.slug)) {
      console.error(`-- Skipping duplicate: ${parsed.slug}`);
      continue;
    }
    seen.add(parsed.slug);

    clips.push({
      slug: parsed.slug,
      title: generateTitle(parsed.slug),
      url: parsed.fullUrl,
    });
  }

  // Output SQL
  console.log('-- Clip import script generated on', new Date().toISOString());
  console.log('-- Total clips:', clips.length);
  console.log('');
  console.log('BEGIN TRANSACTION;');
  console.log('');

  for (const clip of clips) {
    console.log(
      `INSERT OR IGNORE INTO clips (twitch_slug, title, twitch_url) VALUES ('${escapeSql(clip.slug)}', '${escapeSql(clip.title)}', '${escapeSql(clip.url)}');`
    );
  }

  console.log('');
  console.log('COMMIT;');
  console.log('');
  console.log('-- Import complete');
}

main();

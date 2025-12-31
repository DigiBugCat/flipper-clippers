#!/usr/bin/env node
/**
 * Script to generate SQL for importing clips from CSV into D1 database
 *
 * CSV format: Title,Uploader,Date,URL
 *
 * Usage:
 * 1. First, create the D1 database and run migrations:
 *    wrangler d1 execute clip-ranker-db --local --file=src/db/schema.sql
 *
 * 2. Generate the SQL insert statements:
 *    node scripts/generate-import-sql.js /path/to/csvOut.csv
 *
 * 3. Run the generated SQL:
 *    wrangler d1 execute clip-ranker-db --local --file=scripts/import-clips.sql
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to CSV file (from argument or default)
const CSV_FILE = process.argv[2] || path.join(__dirname, '..', 'clips.csv');

// Parse CSV line (handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

// Parse a Twitch clip URL to extract the slug
function parseClipUrl(url) {
  const match = url.match(/twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/);
  if (!match) return null;

  return {
    slug: match[1],
    fullUrl: url.trim(),
  };
}

// Escape single quotes for SQL
function escapeSql(str) {
  return str.replace(/'/g, "''");
}

// Main function
function main() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`CSV file not found: ${CSV_FILE}`);
    console.error('Usage: node scripts/generate-import-sql.js /path/to/clips.csv');
    process.exit(1);
  }

  // Read the CSV file
  const content = fs.readFileSync(CSV_FILE, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  // Skip header row
  const dataLines = lines.slice(1);

  const clips = [];
  const seen = new Set();

  for (const line of dataLines) {
    const [title, uploader, date, url] = parseCSVLine(line);

    if (!url) {
      console.error(`-- Skipping line with no URL: ${line}`);
      continue;
    }

    const parsed = parseClipUrl(url);
    if (!parsed) {
      console.error(`-- Skipping invalid URL: ${url}`);
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
      title: title || parsed.slug,
      clippedBy: uploader || 'Unknown',
      url: parsed.fullUrl,
    });
  }

  // Output SQL
  const output = [];
  output.push(`-- Clip import script generated on ${new Date().toISOString()}`);
  output.push(`-- Total unique clips: ${clips.length}`);
  output.push(`-- Source: ${path.basename(CSV_FILE)}`);
  output.push('');
  output.push('-- Clear existing data for fresh import (order matters for foreign keys)');
  output.push('DELETE FROM pairing_history;');
  output.push('DELETE FROM user_clip_ratings;');
  output.push('DELETE FROM comparisons;');
  output.push('DELETE FROM clips;');
  output.push('');
  output.push('-- Reset user stats');
  output.push('UPDATE users SET total_comparisons = 0, total_super_likes = 0;');
  output.push('');
  output.push('-- Insert clips');

  for (const clip of clips) {
    output.push(
      `INSERT INTO clips (twitch_slug, title, clipped_by, twitch_url) VALUES ('${escapeSql(clip.slug)}', '${escapeSql(clip.title)}', '${escapeSql(clip.clippedBy)}', '${escapeSql(clip.url)}');`
    );
  }

  output.push('');
  output.push('-- Import complete');

  // Write to file
  const outputPath = path.join(__dirname, 'import-clips.sql');
  fs.writeFileSync(outputPath, output.join('\n'));

  console.log(`Generated SQL for ${clips.length} unique clips`);
  console.log(`Output: ${outputPath}`);
}

main();

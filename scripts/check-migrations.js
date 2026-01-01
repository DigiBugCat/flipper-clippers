#!/usr/bin/env node
/**
 * Pre-deployment check: Verify all tables from schema.sql exist in production D1
 *
 * This prevents deploying code that uses tables which haven't been migrated yet.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const SCHEMA_PATH = 'src/db/schema.sql';
const DB_NAME = 'clip-ranker-db';

// Parse table names from schema.sql
function getSchemaTableNames() {
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  const matches = schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g);
  return [...matches].map(m => m[1]);
}

// Query production D1 for existing tables
function getProductionTableNames() {
  try {
    const result = execSync(
      `npx wrangler d1 execute ${DB_NAME} --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'sqlite%';"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const parsed = JSON.parse(result);
    return parsed[0].results.map(r => r.name);
  } catch (error) {
    console.error('Failed to query production database:', error.message);
    process.exit(1);
  }
}

// Main
console.log('Checking database migrations...');

const schemaTables = getSchemaTableNames();
const prodTables = getProductionTableNames();
const missing = schemaTables.filter(t => !prodTables.includes(t));

console.log(`Schema defines ${schemaTables.length} tables`);
console.log(`Production has ${prodTables.length} tables`);

if (missing.length > 0) {
  console.error('\n❌ MIGRATION CHECK FAILED');
  console.error(`Missing tables in production: ${missing.join(', ')}`);
  console.error('\nRun migrations before deploying:');
  console.error(`  npx wrangler d1 execute ${DB_NAME} --remote --file=${SCHEMA_PATH}`);
  process.exit(1);
}

console.log('✅ Migration check passed - all tables exist in production');

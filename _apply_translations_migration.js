// One-off: apply migrations/translations.sql and prove the shape the code uses.
//   railway run node _apply_translations_migration.js
//
// Run this BEFORE deploying the bot that goes with it. Without it the cache
// reads warn and miss on every click, so every reader pays for a fresh
// translation of the same post — and /language cannot remember anything at all.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'translations.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  for (const [table, key] of [['translations', 'source_hash, target_lang'], ['user_locales', 'guild_id, user_id']]) {
    const { rows } = await pool.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY a.attnum`, [table]);
    const got = rows.map(r => r.attname).join(', ');
    console.log(`  ${table.padEnd(13)} PK (${got})`);
    // Both upserts are ON CONFLICT on exactly these columns; a different key
    // means every write raises instead of updating.
    if (got !== key) { console.error(`    expected (${key})`); process.exit(1); }
  }

  const { rows: [n] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM translations) AS cached,
            (SELECT count(DISTINCT target_lang)::int FROM translations) AS langs,
            (SELECT count(*)::int FROM user_locales) AS readers`);
  console.log(`\ncached translations: ${n.cached} across ${n.langs} language(s)`);
  console.log(`readers who chose a language: ${n.readers}`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

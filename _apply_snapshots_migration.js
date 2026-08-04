// One-off: apply migrations/guild_snapshots.sql and prove the shape the code uses.
//   railway run node _apply_snapshots_migration.js
//
// Run this BEFORE deploying the bot that goes with it. Without the table,
// /serverbackup create fails at the INSERT — after it has already read the
// whole guild — and the operator is told "could not save the snapshot" with no
// clue that the table is the reason.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'guild_snapshots.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'guild_snapshots'
      ORDER BY ordinal_position`);
  console.log('\nguild_snapshots:');
  for (const c of cols) console.log(`  ${c.column_name.padEnd(11)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);

  // data and counts are read with `row.data.roles` and `row.counts.roles`
  // straight off the pg driver — that only works if they are jsonb.
  for (const name of ['data', 'counts']) {
    const c = cols.find(x => x.column_name === name);
    if (!c || c.data_type !== 'jsonb') { console.error(`\nFAILED: ${name} is ${c && c.data_type}, expected jsonb`); process.exit(1); }
  }

  // No foreign key to guilds() — on purpose. The case this feature exists for
  // is the guild being gone, and a FK would make a dead server's snapshot the
  // one thing you cannot keep.
  const { rows: fks } = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'guild_snapshots'::regclass AND contype = 'f'`);
  if (fks.length) { console.error(`\nFAILED: unexpected foreign key(s): ${fks.map(f => f.conname).join(', ')}`); process.exit(1); }
  console.log('\nno foreign key to guilds() — a snapshot outlives its server, as intended');

  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS snaps, count(DISTINCT guild_id)::int AS guilds FROM guild_snapshots`);
  console.log(`existing snapshots: ${n.snaps} across ${n.guilds} guild(s)`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

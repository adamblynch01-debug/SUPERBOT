// One-off: apply migrations/mirror_hardening.sql and prove the shape the code uses.
//   railway run node _apply_mirror_hardening.js
//
// Run BEFORE deploying the bot that goes with it. The relay reads
// `include_other_bots` and `rate_per_min` off every route on the hot path, and
// pausing writes `paused_reason`/`paused_at` — deploying first would mean a
// broken UPDATE at exactly the moment the flood breaker is trying to fire.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'mirror_hardening.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  const want = ['include_other_bots', 'paused_reason', 'paused_at', 'rate_per_min'];
  const { rows: cols } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'mirror_routes' AND column_name = ANY($1)`, [want]);
  const have = new Set(cols.map(c => c.column_name));
  const missing = want.filter(c => !have.has(c));
  if (missing.length) { console.error(`\nFAILED: still missing ${missing.join(', ')}`); process.exit(1); }
  console.log('\nmirror_routes, new columns:');
  for (const c of cols) {
    const dflt = c.column_default ? ` = ${c.column_default.replace(/::[a-z ]+$/, '')}` : '';
    console.log(`  ${c.column_name.padEnd(20)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${dflt}`);
  }

  // The whole point of the column: existing routes must NOT suddenly start
  // carrying other bots and webhooks. A default of true would widen four live
  // routes in silence, which is the bug this migration exists to close.
  const iob = cols.find(c => c.column_name === 'include_other_bots');
  if (!/false/.test(iob.column_default || '')) {
    console.error(`\nFAILED: include_other_bots defaults to ${iob.column_default} — it has to be false`);
    process.exit(1);
  }
  console.log('\ninclude_other_bots defaults to false — nothing gets widened by this migration');

  const { rows: [blocks] } = await pool.query(
    `SELECT to_regclass('public.mirror_blocks') IS NOT NULL AS ok`);
  if (!blocks.ok) { console.error('\nFAILED: mirror_blocks was not created'); process.exit(1); }
  const { rows: pk } = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'mirror_blocks'::regclass AND contype = 'p'`);
  if (!pk.length) { console.error('\nFAILED: mirror_blocks has no primary key — a block could be added twice'); process.exit(1); }
  console.log(`mirror_blocks present, primary key: ${pk.map(r => r.conname).join(', ')}`);

  // What the four live routes look like after this. Nothing should have moved.
  const { rows } = await pool.query(
    `SELECT id, src_guild_id, dst_guild_id, bot_only, include_other_bots, allow_pings,
            rate_per_min, enabled, paused_reason
       FROM mirror_routes ORDER BY id`);
  console.log(`\nroutes: ${rows.length}`);
  for (const r of rows) {
    console.log(`  #${r.id} ${r.src_guild_id} → ${r.dst_guild_id}` +
      ` · bot_only=${r.bot_only} other_bots=${r.include_other_bots} pings=${r.allow_pings}` +
      ` · rate=${r.rate_per_min == null ? 'default' : r.rate_per_min}` +
      ` · ${r.enabled ? 'enabled' : `PAUSED (${r.paused_reason || 'no reason recorded'})`}`);
  }

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

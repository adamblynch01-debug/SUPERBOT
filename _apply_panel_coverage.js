// One-off: apply migrations/panel_channel_coverage.sql.
//   railway run node _apply_panel_coverage.js
//
// Run this BEFORE deploying the bot that goes with it. The panel's settings
// save is a single INSERT ... ON CONFLICT naming every allowed column, so a
// deployed panel writing to columns the database does not have fails the whole
// save — including the fields that did exist. The bot's read side is
// `SELECT *`, so it survives a missing column; the write side does not.
//
// Idempotent (ADD COLUMN IF NOT EXISTS), so re-running it is a no-op.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

// Eleven, not twelve: support_channel_id was dropped because /panel posts the
// ticket panel into the channel it is run in, so nothing would ever have read it.
const NEW_COLUMNS = [
  'orders_channel_id', 'restock_channel_id', 'vault_restock_channel_id',
  'manual_delivery_channel_id', 'sms_gen_channel_id', 'gen_log_channel_id',
  'alerts_channel_id', 'rank_boost_log_channel',
  'rank_boost_role_id', 'ticket_staff_role_id', 'customer_role_id',
];

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', 'panel_channel_coverage.sql'), 'utf8'));
  console.log('migration applied');

  const { rows } = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'guild_settings' AND column_name = ANY($1)
      ORDER BY column_name`, [NEW_COLUMNS]);
  console.log(`  ${rows.length}/${NEW_COLUMNS.length} columns present:`);
  for (const r of rows) console.log(`    ${r.column_name} ${r.data_type}`);

  const missing = NEW_COLUMNS.filter(c => !rows.some(r => r.column_name === c));
  if (missing.length) { console.error('MISSING:', missing.join(', ')); process.exit(1); }

  // A snowflake stored as a number comes back wrong and every lookup misses.
  const wrong = rows.filter(r => r.data_type !== 'text');
  if (wrong.length) { console.error('NOT TEXT:', wrong.map(r => r.column_name).join(', ')); process.exit(1); }

  // Nothing is backfilled. Null means "this guild has not configured it" and
  // every consumer falls back to its env var, so the original server keeps its
  // exact current behaviour until somebody fills a field in on purpose.
  const { rows: guilds } = await pool.query(
    `SELECT guild_id FROM guild_settings ORDER BY guild_id`);
  console.log(`  ${guilds.length} guild row(s), all new columns left null by design`);

  await pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

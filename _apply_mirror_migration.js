// One-off: apply migrations/mirror_routes.sql and prove the shape the code uses.
//   railway run node _apply_mirror_migration.js
//
// Run BEFORE deploying the bot that goes with it. Without the tables the
// messageCreate hook throws on every single message in every guild — the
// relay lookup runs on the hot path, so a missing table is not "mirroring is
// broken", it is a log line per message and a permanently noisy process.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'mirror_routes.sql'), 'utf8');
  await pool.query(sql);
  console.log('migration applied');

  for (const table of ['mirror_routes', 'mirror_messages']) {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position`, [table]);
    console.log(`\n${table}:`);
    for (const c of rows) {
      const dflt = c.column_default ? ` = ${c.column_default.replace(/::[a-z ]+$/, '')}` : '';
      console.log(`  ${c.column_name.padEnd(15)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${dflt}`);
    }
  }

  // The two defaults that are safety, not preference: a route carries only bot
  // posts, and it does not ping the server it arrives in.
  const { rows: defs } = await pool.query(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'mirror_routes' AND column_name IN ('bot_only','allow_pings')`);
  const d = Object.fromEntries(defs.map(r => [r.column_name, r.column_default]));
  if (!/true/.test(d.bot_only || '') || !/false/.test(d.allow_pings || '')) {
    console.error(`\nFAILED: unsafe defaults — bot_only=${d.bot_only}, allow_pings=${d.allow_pings}`);
    process.exit(1);
  }
  console.log('\ndefaults: bot_only=true, allow_pings=false — a new route is quiet until told otherwise');

  // A duplicate route is a duplicate post for every message, forever.
  const { rows: uq } = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'mirror_routes'::regclass AND contype = 'u'`);
  if (!uq.length) { console.error('\nFAILED: no UNIQUE on (src_channel_id, dst_channel_id)'); process.exit(1); }
  console.log(`unique constraint present: ${uq.map(r => r.conname).join(', ')}`);

  // No token column. The relay resolves the webhook through the channel, so
  // there is no reason to keep a credential that can post to another server.
  const { rows: tok } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mirror_routes' AND column_name LIKE '%token%'`);
  if (tok.length) { console.error(`\nFAILED: token column(s) present: ${tok.map(t => t.column_name).join(', ')}`); process.exit(1); }
  console.log('no webhook token stored — the id is enough, the credential is not kept');

  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS routes, count(*) FILTER (WHERE enabled)::int AS live FROM mirror_routes`);
  console.log(`\nexisting routes: ${n.routes} (${n.live} enabled)`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

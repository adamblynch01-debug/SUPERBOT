// One-off: apply migrations/invite_log_channel.sql and set the two guilds up.
//   railway run node _apply_invite_log_migration.js
//
// Run this BEFORE deploying the bot that goes with it. Without the columns the
// settings read throws on every getGuildSettings — the row SELECT is `*`, so a
// missing column is not the failure, but the panel's save of one is.
//
// It also writes the IDs the operator gave, for the main guild only. The second
// guild is left to resolve by NAME (#invites / #invite-tracker), because its
// channels have different snowflakes and nobody has read them out yet — the
// name fallback is what makes a second install work before it is configured.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MAIN_GUILD = process.env.GUILD_ID || '1242128831092101201';
const INVITES_PANEL = '1482585544998256781'; // #invites — the three-button post
const INVITE_LOG    = '1400878017667923968'; // #invite-tracker — join/leave lines

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', 'invite_log_channel.sql'), 'utf8'));
  console.log('migration applied');

  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'guild_settings' AND column_name LIKE 'invite%' ORDER BY column_name`);
  console.log('  columns:', cols.map(c => c.column_name).join(', '));

  // Upserted rather than assumed: guild_settings may have no row for this guild
  // at all, in which case the bot has been running entirely on env defaults.
  await pool.query(
    `INSERT INTO guild_settings (guild_id, invites_channel_id, invite_log_channel_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET
       invites_channel_id = $2, invite_log_channel_id = $3, updated_at = now()`,
    [MAIN_GUILD, INVITES_PANEL, INVITE_LOG]
  ).catch(async (e) => {
    // guild_settings.guild_id references guilds(guild_id); a guild that has
    // never been touched by the panel has no parent row.
    if (!/foreign key/i.test(e.message)) throw e;
    await pool.query('INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [MAIN_GUILD]);
    await pool.query(
      `INSERT INTO guild_settings (guild_id, invites_channel_id, invite_log_channel_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id) DO UPDATE SET
         invites_channel_id = $2, invite_log_channel_id = $3, updated_at = now()`,
      [MAIN_GUILD, INVITES_PANEL, INVITE_LOG]);
  });

  const { rows } = await pool.query(
    `SELECT guild_id, invites_channel_id, invite_log_channel_id,
            invites_channel_name, invite_log_channel_name
       FROM guild_settings ORDER BY guild_id`);
  console.log('\nper guild — panel / log:');
  for (const r of rows) {
    console.log(`  ${r.guild_id}  panel=${r.invites_channel_id || `#${r.invites_channel_name || 'invites'} (by name)`}`
      + `  log=${r.invite_log_channel_id || `#${r.invite_log_channel_name || 'invite-tracker'} (by name)`}`);
    if (r.invites_channel_id && r.invites_channel_id === r.invite_log_channel_id) {
      console.error('    BOTH POINT AT THE SAME CHANNEL — that is the bug this migration exists to undo.');
      process.exitCode = 1;
    }
  }

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

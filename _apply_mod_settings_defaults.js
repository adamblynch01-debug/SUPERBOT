// One-off: apply migrations/mod_settings_defaults.sql.
//   railway run node _apply_mod_settings_defaults.js
//
// Run this BEFORE deploying the bot that goes with it. The bot in this commit
// starts reading guild_settings' four moderation numbers, and the column
// defaults disagreed with the env values the bot has actually been enforcing
// (10-minute mutes and a 5-message spam trigger in the table, 30 and 3 in
// Railway). Deploying first would quietly relax moderation on the main server
// for however long it took to notice.
//
// Safe to run twice: the UPDATEs match the old default values, which no longer
// exist once it has run.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  const before = await pool.query(
    `SELECT guild_id, warnings_before_ban, mute_duration_minutes,
            spam_message_limit, spam_time_window
       FROM guild_settings ORDER BY guild_id`);
  console.log('before:');
  for (const r of before.rows) console.log(' ', JSON.stringify(r));

  await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', 'mod_settings_defaults.sql'), 'utf8'));
  console.log('migration applied');

  const after = await pool.query(
    `SELECT guild_id, warnings_before_ban, mute_duration_minutes,
            spam_message_limit, spam_time_window
       FROM guild_settings ORDER BY guild_id`);
  console.log('after:');
  for (const r of after.rows) console.log(' ', JSON.stringify(r));

  // The defaults themselves, so a run that changed no rows still shows it did
  // something — new guilds are the whole reason the defaults matter.
  const { rows: defs } = await pool.query(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'guild_settings'
        AND column_name IN ('warnings_before_ban','mute_duration_minutes',
                            'spam_message_limit','spam_time_window')
      ORDER BY column_name`);
  console.log('defaults now:');
  for (const d of defs) console.log(`  ${d.column_name} = ${d.column_default}`);

  await pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

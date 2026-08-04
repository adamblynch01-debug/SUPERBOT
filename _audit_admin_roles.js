// Read-only. Prints, per guild: who holds ADMINISTRATOR, where OVERSEER is,
// and whether the bot sits high enough in the hierarchy to edit any of them.
//
//   railway run node _audit_admin_roles.js
//
// Nothing here writes. _strip_vip_admin.js is the one that changes anything,
// and it refuses to run without the facts this prints.
'use strict';

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`logged in as ${client.user.tag}\n`);
  for (const [, g] of client.guilds.cache) {
    const guild = await g.fetch();
    await guild.roles.fetch();
    const me = await guild.members.fetchMe();
    const myTop = me.roles.highest;
    console.log(`── ${guild.name} (${guild.id})`);
    console.log(`   owner: ${guild.ownerId}`);
    console.log(`   bot's highest role: ${myTop.name} @ position ${myTop.position}`
      + `   canManageRoles=${me.permissions.has(PermissionFlagsBits.ManageRoles)}`);
    for (const r of [...guild.roles.cache.values()].sort((a, b) => b.position - a.position)) {
      const admin = r.permissions.has(PermissionFlagsBits.Administrator);
      const interesting = admin || /overseer|vip|admin|staff|mod/i.test(r.name);
      if (!interesting || r.id === guild.id) continue;
      // "editable" is the whole question for the strip script: Discord refuses
      // a role edit from anyone whose highest role is not ABOVE the target,
      // and a managed (bot/boost) role cannot be edited at all.
      console.log(`   ${admin ? 'ADMIN ' : '      '}pos ${String(r.position).padStart(3)}  `
        + `${r.name}  (${r.id})  members=${r.members.size}  managed=${r.managed}  editable=${r.editable}`);
    }
    console.log('');
  }
  await client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN || process.env.TOKEN);

// ─── Website tickets → Discord ───────────────────────────────────────────────
'use strict';
//
// A ticket opened at uhservices.xyz used to be invisible here. The backend did
// POST /internal/new_ticket, but internalEvents.js has no route by that name,
// so it fell through to the `/internal/:event` catch-all and came back
// {ok:true, handled:false} — 200, one console line, nobody pinged. The only
// place a web ticket ever surfaced was the admin panel's Tickets tab.
//
// This is the missing half. It posts the ticket into the same ticket-log
// channel Discord tickets already log to, with Reply and Close buttons, so it
// can be worked without leaving Discord. Replies written here are POSTed back
// to the backend and appear in the customer's ticket thread on the website; the
// customer's replies come the other way as `ticket_reply`.
//
// Routing goes through support.js routeFor() rather than reading
// TICKET_LOG_CHANNEL directly, so a web ticket obeys exactly the same rules as
// a Discord one — including Rank Boosting going to its own team's channel and
// the TICKET_STAFF_ROLE_ID / STAFF_ROLE_ID split.

const axios = require('axios');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { routeFor, isStaffFor, resolveLogChannel } = require('./support');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const SITE_URL    = process.env.SITE_URL || 'https://zeropoint.wtf';

// Ticket routing is per-guild now, and a website ticket has no guild — nobody
// pressed a button in a server to open it. There is one store, and it is the
// original guild, so that is the guild a web ticket is routed for. Saying so
// explicitly matters: routeFor() with no guild falls back to the env ids, which
// happens to be the same answer TODAY and stops being the same answer the
// moment the main server's ticket log is set from the panel instead.
const STORE_GUILD_ID = process.env.GUILD_ID || null;

// Same caps as internalEvents.js — one over and Discord rejects the WHOLE
// message, so everything the customer typed is clipped on the way in.
const LIMIT = { name: 256, value: 1024, desc: 4096 };

function clip(text, max) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  const marker = ` … (+${s.length - max} chars)`;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

const PRIORITY_COLOR = {
  urgent: 0xED4245,
  high:   0xE67E22,
  normal: 0x5865F2,
  low:    0x95A5A6,
};

// The category the website sends is free text from a <select>. It is matched
// against the Discord ticket types so routing lines up; anything unrecognised
// falls through routeFor()'s own default rather than being forced to one.
//
// 'HWID Reset' is spelled exactly as TICKET_ROUTES spells it — a near-miss
// like 'hwid_reset' would route to the general channel and look like a bug in
// the router rather than a typo here.
const CATEGORY_ALIASES = {
  hwid: 'HWID Reset',
  'hwid reset': 'HWID Reset',
  'hwid-reset': 'HWID Reset',
  purchase: 'Purchase',
  billing: 'Purchase',
  payment: 'Purchase',
  resell: 'Resell',
  reseller: 'Resell',
  'rank boost': 'Rank Boosting',
  'rank boosting': 'Rank Boosting',
  boosting: 'Rank Boosting',
};

function normalizeCategory(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Support';
  return CATEGORY_ALIASES[s.toLowerCase()] || s;
}

// ─── the embed ───────────────────────────────────────────────────────────────
function ticketEmbed(t) {
  const category = normalizeCategory(t.category);
  const priority = String(t.priority || 'normal').toLowerCase();

  const embed = new EmbedBuilder()
    .setColor(PRIORITY_COLOR[priority] ?? PRIORITY_COLOR.normal)
    .setTitle(`🌐 Website Ticket #${t.ticket_id}`)
    .setDescription(clip(t.body || '_No message body._', LIMIT.desc))
    .addFields(
      { name: 'From',     value: clip(t.username || 'customer', LIMIT.value), inline: true },
      { name: 'Category', value: clip(category, LIMIT.value), inline: true },
      { name: 'Priority', value: clip(priority.toUpperCase(), LIMIT.value), inline: true },
    )
    .setFooter({ text: 'Opened on the website — reply here or in the admin panel' })
    .setTimestamp();

  if (t.subject) embed.addFields({ name: 'Subject', value: clip(t.subject, LIMIT.value), inline: false });
  if (t.email)   embed.addFields({ name: 'Email',   value: clip(t.email, LIMIT.value), inline: true });

  // Only present on the HWID path. The license key is shown because staff
  // cannot action a reset without it and this channel is already staff-only —
  // the same channel Discord HWID tickets log to.
  if (t.hwid) {
    embed.addFields({
      name: '🔑 HWID Reset',
      value: clip(
        [
          `Request: #${t.hwid.request_id}`,
          `Product: ${t.hwid.product || '—'}`,
          `Key: \`${t.hwid.license_key || '—'}\``,
        ].join('\n'),
        LIMIT.value
      ),
      inline: false,
    });
  }
  return embed;
}

function ticketButtons(ticketId, hwidRequestId) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`webticket_reply_${ticketId}`)
        .setLabel('Reply').setEmoji('💬').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`webticket_view_${ticketId}`)
        .setLabel('Transcript').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`webticket_close_${ticketId}`)
        .setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setLabel('Open on site').setStyle(ButtonStyle.Link)
        .setURL(`${SITE_URL}/?ticket=${encodeURIComponent(ticketId)}`),
    ),
  ];
  if (hwidRequestId) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`webhwid_approve_${hwidRequestId}`)
        .setLabel('Approve reset').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`webhwid_deny_${hwidRequestId}`)
        .setLabel('Deny reset').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}

// ─── HTTP routes (backend → bot) ─────────────────────────────────────────────
// requireSecret is passed in from internalEvents rather than reimplemented, so
// there is exactly one copy of the constant-time compare and the "unset
// API_SECRET means refuse" rule.
function registerWebTicketRoutes(app, client, requireSecret) {
  app.post('/internal/new_ticket', requireSecret, async (req, res) => {
    const t = req.body || {};
    try {
      if (!t.ticket_id) return res.status(400).json({ error: 'ticket_id is required' });

      const route = await routeFor(normalizeCategory(t.category), STORE_GUILD_ID);
      if (!route.channel) {
        console.error('[WebTickets] no ticket log channel configured — set it in the panel (Settings → Ticket log channel), or TICKET_LOG_CHANNEL');
        return res.json({ ok: true, posted: false, reason: 'no ticket log channel configured' });
      }

      // resolveLogChannel rather than client.channels.fetch: the bot-wide fetch
      // resolves a channel in ANY server it is in, so a stale id would post a
      // customer's ticket into the wrong server rather than fail.
      let ch;
      try {
        ch = await resolveLogChannel(client, route);
      } catch (err) {
        console.error(`[WebTickets] cannot reach channel ${route.channel}: ${err.message}`);
        return res.json({ ok: true, posted: false, reason: 'ticket log channel unreachable' });
      }
      if (!ch || typeof ch.send !== 'function') {
        return res.json({ ok: true, posted: false, reason: 'ticket log channel not sendable' });
      }

      const msg = await ch.send({
        content: route.role ? `<@&${route.role}>` : undefined,
        embeds: [ticketEmbed(t)],
        components: ticketButtons(t.ticket_id, t.hwid && t.hwid.request_id),
      });

      // The backend stores these on the ticket row. Without them a later
      // customer reply has nothing to reply TO and would post a fresh,
      // contextless embed every time.
      return res.json({ ok: true, posted: true, channel_id: ch.id, message_id: msg.id });
    } catch (err) {
      console.error('[WebTickets] new_ticket failed:', err.message);
      return res.status(500).json({ error: 'failed to post ticket' });
    }
  });

  // The customer answered on the website. Posted as a reply to the original
  // embed so the whole exchange stays in one place in the channel.
  app.post('/internal/ticket_reply', requireSecret, async (req, res) => {
    const { ticket_id, channel_id, message_id, author, body } = req.body || {};
    try {
      if (!channel_id) return res.json({ ok: true, posted: false, reason: 'ticket has no discord post' });

      let ch;
      try { ch = await client.channels.fetch(String(channel_id)); } catch { ch = null; }
      if (!ch || typeof ch.send !== 'function') {
        return res.json({ ok: true, posted: false, reason: 'channel unreachable' });
      }

      const embed = new EmbedBuilder()
        .setColor(0x00B0F4)
        .setAuthor({ name: `${clip(author || 'Customer', 200)} replied — ticket #${ticket_id}` })
        .setDescription(clip(body || '_(empty)_', LIMIT.desc))
        .setTimestamp();

      // reply() rather than send() where possible: a ticket that has been open
      // a while is buried by then, and an unanchored message reads as an
      // unrelated one. A deleted original must not swallow the reply, so the
      // failure falls back to a plain send.
      let sent = null;
      if (message_id) {
        try {
          sent = await ch.send({
            embeds: [embed],
            components: ticketButtons(ticket_id, null),
            reply: { messageReference: String(message_id), failIfNotExists: false },
          });
        } catch (_) { sent = null; }
      }
      if (!sent) {
        sent = await ch.send({ embeds: [embed], components: ticketButtons(ticket_id, null) });
      }
      return res.json({ ok: true, posted: true, message_id: sent.id });
    } catch (err) {
      console.error('[WebTickets] ticket_reply failed:', err.message);
      return res.status(500).json({ error: 'failed to post reply' });
    }
  });

  console.log('🌐 Website ticket routes registered (new_ticket, ticket_reply)');
}

// ─── Discord → backend ───────────────────────────────────────────────────────

// Who may work a website ticket. Deliberately the same predicate Discord
// tickets use, so there is one answer to "is this person staff" rather than two
// that can drift. `null` category → the general staff branch, which is what an
// embed with no type recorded should get.
// Async because isStaffFor is — the route it checks is a per-guild settings
// read now. Every call site must await it: `if (!canWork(...))` on a Promise is
// always false, which is not a smaller bug than the one being fixed, it is
// "everyone in the server can close any ticket".
async function canWork(member, category) {
  return isStaffFor(member, normalizeCategory(category));
}

async function backend(method, path, payload) {
  const secret = process.env.API_SECRET;
  if (!secret) throw new Error('API_SECRET is not set on the bot');
  if (method === 'get') {
    const res = await axios.get(`${BACKEND_URL}${path}`, {
      params: { secret }, timeout: 10000,
    });
    return res.data;
  }
  const res = await axios.post(`${BACKEND_URL}${path}`, { secret, ...payload }, { timeout: 10000 });
  return res.data;
}

function backendError(err) {
  const status = err.response && err.response.status;
  const msg = (err.response && err.response.data && err.response.data.error) || err.message;
  if (status === 404) return '❌ That ticket no longer exists on the website.';
  if (status === 400) return `❌ ${msg}`;
  if (status === 401) return '❌ The bot\'s API_SECRET does not match the backend\'s.';
  if (status === 503) return '❌ The backend has no API_SECRET configured.';
  return `❌ Could not reach the website backend: ${msg}`;
}

// Returns true when the interaction was ours, so index.js can stop looking.
async function handleWebTicketButton(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('webticket_') && !id.startsWith('webhwid_')) return false;

  const [, action, targetId] = id.split('_');

  // The embed does not carry the category, so the permission check uses the
  // general staff branch. That is the safe direction: a rank-booster cannot
  // action a general ticket, and general staff can action everything.
  if (!await canWork(interaction.member, null)) {
    await interaction.reply({ content: '❌ You are not staff.', flags: 64 });
    return true;
  }

  if (id.startsWith('webticket_') && action === 'reply') {
    const modal = new ModalBuilder()
      .setCustomId(`webticket_replymodal_${targetId}`)
      .setTitle(`Reply to ticket #${targetId}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('webticket_body')
            .setLabel('Your reply (the customer sees this)')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(2000)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (id.startsWith('webticket_') && action === 'view') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const data = await backend('get', `/api/tickets/bot/${encodeURIComponent(targetId)}`);
      const msgs = (data && data.messages) || [];
      const transcript = msgs.length
        ? msgs.map(m => `**${m.role === 'staff' ? '🛡 ' : '👤 '}${m.author_name}:** ${m.body}`).join('\n\n')
        : '_No messages._';
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📜 Ticket #${targetId} — ${(data.ticket && data.ticket.status) || 'unknown'}`)
        .setDescription(clip(transcript, LIMIT.desc))
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({ content: backendError(err) });
    }
    return true;
  }

  if (id.startsWith('webticket_') && action === 'close') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await backend('post', `/api/tickets/bot/${encodeURIComponent(targetId)}/status`, {
        status: 'closed',
        actor: interaction.user.username,
      });
      await interaction.editReply({ content: `🔒 Ticket #${targetId} closed. The customer has been told on the site.` });
      // Strike the buttons through on the original post so the next person
      // does not open a modal against a closed ticket.
      try {
        await interaction.message.edit({ components: [] });
      } catch (_) { /* the message may be gone; the close still stands */ }
    } catch (err) {
      await interaction.editReply({ content: backendError(err) });
    }
    return true;
  }

  if (id.startsWith('webhwid_') && (action === 'approve' || action === 'deny')) {
    await interaction.deferReply({ ephemeral: true });
    const status = action === 'approve' ? 'approved' : 'denied';
    try {
      await backend('post', `/api/tickets/bot/hwid/${encodeURIComponent(targetId)}/status`, {
        status,
        actor: interaction.user.username,
      });
      await interaction.editReply({
        content: `${action === 'approve' ? '✅' : '⛔'} HWID request #${targetId} ${status}. The customer has been told in their ticket.`,
      });
    } catch (err) {
      await interaction.editReply({ content: backendError(err) });
    }
    return true;
  }

  return false;
}

async function handleWebTicketModal(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('webticket_replymodal_')) return false;

  const ticketId = id.slice('webticket_replymodal_'.length);
  await interaction.deferReply({ ephemeral: true });

  const body = interaction.fields.getTextInputValue('webticket_body').trim();
  if (!body) {
    await interaction.editReply({ content: '❌ Empty reply — nothing sent.' });
    return true;
  }

  try {
    await backend('post', `/api/tickets/bot/${encodeURIComponent(ticketId)}/reply`, {
      body,
      author_name: interaction.user.username,
      discord_id: String(interaction.user.id),
    });
  } catch (err) {
    await interaction.editReply({ content: backendError(err) });
    return true;
  }

  await interaction.editReply({ content: `✅ Sent to ticket #${ticketId}.` });

  // Echo it into the channel so the rest of the team can see the ticket has
  // been answered — otherwise two people answer the same ticket, because the
  // reply itself only exists on the website.
  try {
    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setAuthor({
        name: `${interaction.user.username} answered ticket #${ticketId}`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setDescription(clip(body, LIMIT.desc))
      .setTimestamp();
    await interaction.channel.send({ embeds: [embed] });
  } catch (_) { /* the reply is already delivered; the echo is a courtesy */ }

  return true;
}

module.exports = {
  registerWebTicketRoutes,
  handleWebTicketButton,
  handleWebTicketModal,
  // exported for the test harness
  normalizeCategory,
  ticketEmbed,
};

// ─── WEB PANEL ────────────────────────────────────────────────────────────────
// Registered onto the SAME express app auth2fa.js already runs (one Railway
// service, one port — no second deploy needed).
//
// This started as a links editor with five read-only tabs bolted on. The
// rewrite fixed four things that were not "polish":
//
//   1. SESSIONS LIVED IN A `new Map()`. This service redeploys on every push,
//      so every deploy logged out everyone mid-edit, and the panel could never
//      run on a second replica. They are in Postgres now (panel_sessions), and
//      the cookie is stored hashed so reading that table does not hand anyone a
//      working session.
//
//   2. EVERY SAVE SAID "Saved". `alert('Saved')` fired on the line after
//      `await fetch(...)` with the response never inspected — a 403, a 500, a
//      dropped connection all looked identical to success. Nothing here claims
//      an outcome it did not read back from the server.
//
//   3. LIST RENDERING INTERPOLATED INTO innerHTML. A useful-link labelled
//      `<img src=x onerror=...>` — addable by anyone with Manage Server, or by
//      the bot's own /addusefullink — executed in the next admin's browser.
//      Everything client-side goes through esc() now.
//
//   4. NO CSRF TOKEN AND NO OAUTH `state`. SameSite=Lax already blocks the
//      cross-site form post, but "already covered by one thing" is how you end
//      up covered by nothing; both are explicit now.
//
// Required env vars:
//   DISCORD_CLIENT_ID      — same application as the bot
//   DISCORD_CLIENT_SECRET  — Developer Portal → OAuth2 → Client Secret
//   PANEL_BASE_URL         — e.g. https://superbot-production-fcd7.up.railway.app
//                            (must exactly match a redirect URI registered in
//                            the portal, with /panel/auth/discord/callback
//                            appended)
// Optional:
//   BACKEND_URL + API_SECRET — enables the Orders tab. Without them that tab
//                            says so rather than rendering an empty list that
//                            looks like "no orders".
'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const db     = require('../db');
const {
  CONTENT_TYPES, CONTENT_KEYS, renderContentBody, paginate,
} = require('./contentRender');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MANAGE_GUILD   = 0x20n;

const BACKEND_URL = process.env.BACKEND_URL || process.env.API_URL || 'http://localhost:3000';
const API_SECRET  = process.env.API_SECRET;

// ── Sessions ────────────────────────────────────────────────────────────────
// The cookie carries the raw id; the table stores its SHA-256. Same reasoning
// as a password hash: the lookup still works, a database read does not.
function hashSession(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

async function createSession(payload) {
  const raw  = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO panel_sessions (session_id, discord_user_id, username, avatar, csrf, guilds, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
    [
      hashSession(raw), payload.discordUserId, payload.username, payload.avatar, csrf,
      JSON.stringify({ manageable: payload.manageableGuilds, installable: payload.installableGuilds }),
      String(SESSION_TTL_MS),
    ]
  );
  return { raw, csrf };
}

async function readSession(req) {
  const sid = parseCookies(req).panel_session;
  if (!sid) return null;
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT * FROM panel_sessions WHERE session_id = $1 AND expires_at > now()`,
      [hashSession(sid)]
    ));
  } catch (e) {
    // A panel that 500s the moment the database hiccups is worse than one that
    // shows the login screen; the user can retry, and nothing is written.
    console.error('[panel] session lookup failed:', e.message);
    return null;
  }
  if (!rows.length) return null;
  const r = rows[0];
  const g = r.guilds || {};
  return {
    sessionId: r.session_id,
    discordUserId: r.discord_user_id,
    username: r.username,
    avatar: r.avatar,
    csrf: r.csrf,
    manageableGuilds:  Array.isArray(g.manageable)  ? g.manageable  : [],
    installableGuilds: Array.isArray(g.installable) ? g.installable : [],
  };
}

async function destroySession(req) {
  const sid = parseCookies(req).panel_session;
  if (!sid) return;
  await db.query('DELETE FROM panel_sessions WHERE session_id = $1', [hashSession(sid)]).catch(() => {});
}

// Expired rows are dead weight, not a security problem (every read filters on
// expires_at), so this is a slow background sweep rather than anything urgent.
async function sweepSessions() {
  try {
    const { rowCount } = await db.query('DELETE FROM panel_sessions WHERE expires_at < now()');
    if (rowCount) console.log(`[panel] swept ${rowCount} expired session(s)`);
  } catch (e) {
    console.warn('[panel] session sweep skipped:', e.message);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Route registration ──────────────────────────────────────────────────────
// `hooks` are the bot's own functions, passed in rather than reimplemented.
// A second definition of "how a key is minted" or "how a stock type is spelled"
// is how the panel and Discord end up disagreeing about the same table.
function registerPanelRoutes(app, discordClient, hooks = {}) {
  const {
    invalidateGuildSettings,
    buildContentEmbeds,   // (guildId, key) → EmbedBuilder[] | null
    chunkEmbeds,          // (embeds) → embeds[][]
    normalizeStockType,   // (raw) → slug
    mintKeys,             // ({guildId, roleId, durationMs, count, createdBy}) → {ok, keys[]}
    revokeKey,            // ({guildId, key}) → {ok, error?, roleRemoved?}
  } = hooks;

  const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const BASE_URL      = process.env.PANEL_BASE_URL;
  const REDIRECT_URI  = BASE_URL ? `${BASE_URL}/panel/auth/discord/callback` : null;

  sweepSessions();
  setInterval(sweepSessions, 60 * 60 * 1000).unref?.();

  // ── Login ─────────────────────────────────────────────────────────────────
  app.get('/panel/auth/discord', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(503).send('Panel login is not configured yet (missing DISCORD_CLIENT_ID / PANEL_BASE_URL).');
    }
    // `state` is the login-CSRF guard: without it, an attacker can feed you
    // THEIR authorization code and land you in THEIR session, where anything
    // you then type is typed into an account they control.
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `panel_oauth_state=${state}; HttpOnly; Secure; Path=/panel; Max-Age=600; SameSite=Lax`);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds',
      state,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/panel/auth/discord/callback', async (req, res) => {
    if (!CLIENT_SECRET) return res.status(503).send('Panel login is not configured yet (missing DISCORD_CLIENT_SECRET).');

    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code.');

    const expected = parseCookies(req).panel_oauth_state;
    if (!expected || req.query.state !== expected) {
      return res.status(400).send('Login state mismatch — start again from /panel.');
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });
      if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
      const tokenData = await tokenRes.json();

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userGuilds = await guildsRes.json();

      const permitted = (Array.isArray(userGuilds) ? userGuilds : [])
        .filter(g => g.owner === true || (BigInt(g.permissions || 0) & MANAGE_GUILD) === MANAGE_GUILD);

      const manageable  = permitted.filter(g =>  discordClient.guilds.cache.has(g.id)).map(g => ({ id: g.id, name: g.name, icon: g.icon }));
      const installable = permitted.filter(g => !discordClient.guilds.cache.has(g.id)).map(g => ({ id: g.id, name: g.name, icon: g.icon }));

      const { raw } = await createSession({
        discordUserId: user.id, username: user.username, avatar: user.avatar,
        manageableGuilds: manageable, installableGuilds: installable,
      });

      res.setHeader('Set-Cookie', [
        `panel_session=${raw}; HttpOnly; Secure; Path=/panel; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`,
        'panel_oauth_state=; HttpOnly; Path=/panel; Max-Age=0',
      ]);
      res.redirect('/panel');
    } catch (e) {
      console.error('[panel] OAuth callback error:', e);
      res.status(500).send('Login failed — check server logs.');
    }
  });

  app.get('/panel/auth/logout', async (req, res) => {
    await destroySession(req);
    res.setHeader('Set-Cookie', 'panel_session=; HttpOnly; Path=/panel; Max-Age=0');
    res.redirect('/panel');
  });

  app.get('/panel/install', (req, res) => {
    if (!CLIENT_ID) return res.status(503).send('Not configured.');
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'bot applications.commands',
      permissions: '8', // Administrator — narrow once every feature's needs are final
    });
    if (req.query.guild_id) {
      params.set('guild_id', req.query.guild_id);
      params.set('disable_guild_select', 'true');
    }
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  // ── Middleware ────────────────────────────────────────────────────────────
  async function requireSession(req, res, next) {
    const session = await readSession(req);
    if (!session) return res.status(401).json({ error: 'Not logged in.' });
    req.panelSession = session;

    // Anything that writes must carry the session's own CSRF token. A GET
    // never does — it changes nothing, and requiring it would break a plain
    // browser refresh.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const sent = req.get('X-Panel-CSRF');
      if (!sent || sent !== session.csrf) {
        return res.status(403).json({ error: 'Stale page — reload the panel and try again.' });
      }
    }
    next();
  }

  function guildOf(req, res) {
    const guildId = req.params.guildId;
    if (!req.panelSession.manageableGuilds.some(g => g.id === guildId)) {
      res.status(403).json({ error: 'You do not have access to manage this server.' });
      return null;
    }
    return guildId;
  }

  // Every handler below is async and talks to Postgres. Without this, one
  // failed query becomes an unhandled rejection and the request hangs until
  // the browser gives up — the panel's most common "it just spins" bug.
  const route = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error(`[panel] ${req.method} ${req.path} failed:`, e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message || 'Server error.' });
    });
  };

  const api = (method, path, fn) => app[method](`/panel/api/guilds/:guildId${path}`, requireSession, route(fn));

  // ── Me ────────────────────────────────────────────────────────────────────
  app.get('/panel/api/me', requireSession, route(async (req, res) => {
    const { discordUserId, username, avatar, manageableGuilds } = req.panelSession;
    res.json({ discordUserId, username, avatar, guilds: manageableGuilds });
  }));

  // ── Overview ──────────────────────────────────────────────────────────────
  api('get', '/overview', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const g = discordClient.guilds.cache.get(guildId);

    const [links, stock, keys, tickets, content] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS n FROM useful_links WHERE guild_id = $1', [guildId]),
      db.query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT type)::int AS types FROM stock WHERE guild_id = $1', [guildId]),
      db.query(`SELECT status, COUNT(*)::int AS n FROM keys WHERE guild_id = $1 GROUP BY status`, [guildId]),
      db.query(`SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open, COUNT(*)::int AS total
                FROM tickets WHERE guild_id = $1`, [guildId]),
      db.query('SELECT content_key, updated_at FROM guild_content WHERE guild_id = $1', [guildId]),
    ]);

    const byStatus = {};
    for (const r of keys.rows) byStatus[r.status] = r.n;

    res.json({
      guild: g ? { name: g.name, members: g.memberCount, channels: g.channels.cache.size, roles: g.roles.cache.size } : null,
      links: links.rows[0].n,
      stock: { total: stock.rows[0].n, types: stock.rows[0].types },
      keys: {
        unredeemed: byStatus.unredeemed || 0, active: byStatus.active || 0,
        expired: byStatus.expired || 0, revoked: byStatus.revoked || 0,
      },
      tickets: { open: tickets.rows[0].open, total: tickets.rows[0].total },
      // Which documents exist at all — the Content tab's four boxes look
      // identical whether a document is set or has never been written.
      content: Object.fromEntries(content.rows.map(r => [r.content_key, r.updated_at])),
      ordersConfigured: Boolean(API_SECRET),
    });
  });

  // ── Discord metadata for the pickers ──────────────────────────────────────
  api('get', '/roles', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const g = discordClient.guilds.cache.get(guildId);
    if (!g) return res.status(404).json({ error: 'The bot is not in that server.' });
    const me = g.members.me;
    const roles = [...g.roles.cache.values()]
      // @everyone cannot be granted, and a role above the bot cannot be
      // assigned by it — offering either produces a key that fails on redeem.
      .filter(r => r.id !== g.id && !r.managed && (!me || r.position < me.roles.highest.position))
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
    res.json({ roles });
  });

  api('get', '/channels', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const g = discordClient.guilds.cache.get(guildId);
    if (!g) return res.status(404).json({ error: 'The bot is not in that server.' });
    const me = g.members.me;
    const channels = [...g.channels.cache.values()]
      .filter(c => (c.type === 0 || c.type === 5) && (!me || c.permissionsFor(me)?.has('SendMessages')))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || null }));
    res.json({ channels });
  });

  // ── Useful links ──────────────────────────────────────────────────────────
  // Same table /addusefullink writes, so an edit here shows up in Discord
  // immediately and vice versa.
  api('get', '/links', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { rows } = await db.query(
      'SELECT id, label, url, sort_order FROM useful_links WHERE guild_id = $1 ORDER BY sort_order ASC, id ASC',
      [guildId]
    );
    res.json({ links: rows });
  });

  api('post', '/links', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { label, url } = req.body || {};
    if (!label || !url) return res.status(400).json({ error: 'label and url are required.' });
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'That is not a valid URL.' }); }
    // A `javascript:` link in a panel that renders links as anchors is a click
    // away from running in the next admin's browser.
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http:// and https:// links are allowed.' });
    }

    await db.ensureGuild(guildId);
    const { rows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM useful_links WHERE guild_id = $1', [guildId]
    );
    await db.query(
      'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
      [guildId, String(label).slice(0, 100), url, rows[0].next]
    );
    res.json({ success: true });
  });

  api('delete', '/links/:linkId', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { rowCount } = await db.query('DELETE FROM useful_links WHERE id = $1 AND guild_id = $2', [req.params.linkId, guildId]);
    if (!rowCount) return res.status(404).json({ error: 'That link no longer exists.' });
    res.json({ success: true });
  });

  // Reordering swaps sort_order with the neighbour rather than renumbering the
  // whole list, so two admins moving different links cannot clobber each other.
  api('post', '/links/:linkId/move', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const dir = req.body && req.body.dir === 'down' ? 'down' : 'up';
    const { rows } = await db.query(
      'SELECT id, sort_order FROM useful_links WHERE guild_id = $1 ORDER BY sort_order ASC, id ASC', [guildId]
    );
    const i = rows.findIndex(r => String(r.id) === String(req.params.linkId));
    if (i === -1) return res.status(404).json({ error: 'That link no longer exists.' });
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return res.json({ success: true, moved: false });

    // sort_order has no UNIQUE constraint, but rows imported from the old JSON
    // can share a value — swapping equal numbers would be a no-op, so rewrite
    // both from their positions instead.
    await db.query('UPDATE useful_links SET sort_order = $1 WHERE id = $2 AND guild_id = $3', [j, rows[i].id, guildId]);
    await db.query('UPDATE useful_links SET sort_order = $1 WHERE id = $2 AND guild_id = $3', [i, rows[j].id, guildId]);
    res.json({ success: true, moved: true });
  });

  // ── Stock ─────────────────────────────────────────────────────────────────
  // Counts only. The account_data column is credentials — /stock does not show
  // them in Discord either, and a browser tab left open in a stream is a worse
  // place for them than a DM. Adding and clearing are safe both ways.
  api('get', '/stock', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { rows } = await db.query(
      `SELECT type, COUNT(*)::int AS count, MAX(created_at) AS newest
       FROM stock WHERE guild_id = $1 GROUP BY type ORDER BY type ASC`, [guildId]
    );
    res.json({ stock: rows });
  });

  api('post', '/stock', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const rawType = (req.body && req.body.type) || '';
    if (!String(rawType).trim()) return res.status(400).json({ error: 'Pick or type a stock type.' });
    const type = normalizeStockType ? normalizeStockType(rawType) : String(rawType).trim().toLowerCase();

    const lines = String((req.body && req.body.accounts) || '')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: 'No accounts given — one per line.' });
    if (lines.length > 2000) return res.status(400).json({ error: 'That is over 2000 lines; split it into smaller batches.' });

    await db.ensureGuild(guildId);
    for (const line of lines) {
      await db.query('INSERT INTO stock (guild_id, type, account_data) VALUES ($1,$2,$3)', [guildId, type, line]);
    }
    console.log(`[panel] ${req.panelSession.username} added ${lines.length} ${type} account(s) to ${guildId}`);
    res.json({ success: true, added: lines.length, type });
  });

  api('delete', '/stock/:type', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { rowCount } = await db.query('DELETE FROM stock WHERE guild_id = $1 AND type = $2', [guildId, req.params.type]);
    console.log(`[panel] ${req.panelSession.username} cleared ${rowCount} ${req.params.type} account(s) from ${guildId}`);
    res.json({ success: true, removed: rowCount });
  });

  // ── Keys ──────────────────────────────────────────────────────────────────
  api('get', '/keys', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const status = req.query.status;
    const params = [guildId];
    let where = 'guild_id = $1';
    if (status && status !== 'all') { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT key, role_name, role_id, status, redeemed_by, redeemed_at, expires_at, created_at, created_by, duration_ms
       FROM keys WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params
    );
    res.json({ keys: rows });
  });

  api('post', '/keys', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!mintKeys) return res.status(503).json({ error: 'Key minting is not wired into this build.' });

    const { role_id: roleId, duration } = req.body || {};
    if (!roleId) return res.status(400).json({ error: 'Pick a role.' });
    const count = Math.max(1, Math.min(25, parseInt((req.body || {}).count, 10) || 1));

    const result = await mintKeys({
      guildId, roleId, duration: duration || 'lifetime', count,
      createdBy: `panel:${req.panelSession.discordUserId}`,
    });
    if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Could not mint those keys.' });

    console.log(`[panel] ${req.panelSession.username} minted ${result.keys.length} key(s) for role ${roleId} in ${guildId}`);
    res.json({ success: true, keys: result.keys, role: result.roleName, duration: result.durationLabel });
  });

  api('post', '/keys/:key/revoke', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!revokeKey) return res.status(503).json({ error: 'Key revocation is not wired into this build.' });

    // Scoped to the guild in the session, so a key id from another server
    // cannot be revoked by pasting it into this URL.
    const { rows } = await db.query('SELECT key FROM keys WHERE key = $1 AND guild_id = $2', [req.params.key, guildId]);
    if (!rows.length) return res.status(404).json({ error: 'No such key in this server.' });

    const result = await revokeKey({ guildId, key: req.params.key });
    if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Could not revoke that key.' });
    console.log(`[panel] ${req.panelSession.username} revoked key ${req.params.key}`);
    res.json({ success: true, roleRemoved: Boolean(result.roleRemoved), note: result.note || null });
  });

  // ── Tickets ───────────────────────────────────────────────────────────────
  // Read-only on purpose: a live ticket is a Discord channel with people in it,
  // and closing one from here would leave the channel open with no transcript.
  // What the panel adds is a jump link, so a row is at least actionable.
  api('get', '/tickets', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const status = req.query.status;
    const params = [guildId];
    let where = 'guild_id = $1';
    if (status && status !== 'all') { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await db.query(
      `SELECT id, user_id, channel_id, category, status, created_at, closed_at
       FROM tickets WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params
    );
    res.json({ tickets: rows, guildId });
  });

  // ── Content (TOS / Rules / Guide / Payment methods) ────────────────────────
  api('get', '/content/:key', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown document.' });
    const { rows } = await db.query(
      'SELECT title, body, updated_at, updated_by FROM guild_content WHERE guild_id = $1 AND content_key = $2',
      [guildId, req.params.key]
    );
    res.json({ content: rows[0] || null, defaultTitle: CONTENT_TYPES[req.params.key].defaultTitle });
  });

  api('post', '/content/:key', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown document.' });
    const { title, body } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'Both a title and a body are required.' });
    // Matches the ceiling /set-tos uses for a file upload. Modals cap at 4000;
    // this path has no such limit and the renderer pages anything longer.
    if (String(body).length > 40000) return res.status(400).json({ error: 'That body is over 40,000 characters.' });

    await db.ensureGuild(guildId);
    await db.query(
      `INSERT INTO guild_content (guild_id, content_key, title, body, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (guild_id, content_key) DO UPDATE SET title = $3, body = $4, updated_by = $5, updated_at = now()`,
      [guildId, req.params.key, String(title).slice(0, 256), body, `panel:${req.panelSession.discordUserId}`]
    );
    const pages = paginate(renderContentBody(body));
    res.json({ success: true, pages: pages.length, chars: String(body).length });
  });

  // The preview runs the SAME renderer /post-tos runs, on the unsaved text in
  // the box. Anything less is a promise about a layout Discord may not produce
  // — which is the bug modules/contentRender.js exists to prevent.
  api('post', '/content/:key/preview', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown document.' });
    const body = String((req.body || {}).body || '');
    const pages = paginate(renderContentBody(body));
    res.json({ pages, chars: body.length, rendered: pages.join('\n\n').length });
  });

  api('post', '/content/:key/post', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!CONTENT_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown document.' });
    if (!buildContentEmbeds || !chunkEmbeds) return res.status(503).json({ error: 'Posting is not wired into this build.' });

    const channelId = (req.body || {}).channel_id;
    if (!channelId) return res.status(400).json({ error: 'Pick a channel.' });

    const guild = discordClient.guilds.cache.get(guildId);
    const channel = guild && guild.channels.cache.get(String(channelId));
    if (!channel) return res.status(404).json({ error: 'That channel no longer exists.' });
    if (!channel.isTextBased?.()) return res.status(400).json({ error: 'That is not a text channel.' });
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me)?.has('SendMessages')) {
      return res.status(403).json({ error: `The bot cannot post in #${channel.name}.` });
    }

    const embeds = await buildContentEmbeds(guildId, req.params.key);
    if (!embeds) return res.status(400).json({ error: 'Save the document first — there is nothing stored to post.' });

    // 6000 characters across all embeds in ONE message is a hard Discord limit
    // and exceeding it rejects the whole message, so a long document posts as
    // several messages rather than as nothing at all.
    const messages = chunkEmbeds(embeds);
    let sent = 0;
    for (const m of messages) { await channel.send({ embeds: m }); sent++; }
    console.log(`[panel] ${req.panelSession.username} posted ${req.params.key} to #${channel.name}`);
    res.json({ success: true, channel: channel.name, pages: embeds.length, messages: sent });
  });

  // ── Orders (via the storefront backend) ───────────────────────────────────
  // The bot has no orders table of its own — it asks the backend, exactly as
  // /manual-order-delivery pending does. Without a secret the tab says so
  // instead of rendering an empty list that reads as "no orders".
  api('get', '/orders/pending', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!API_SECRET) {
      return res.status(503).json({ error: 'This bot has no API_SECRET, so it cannot reach the order backend.' });
    }
    try {
      const r = await axios.get(`${BACKEND_URL}/api/orders/pending`, {
        params: { secret: API_SECRET, limit: 25 }, timeout: 15000,
      });
      res.json({ orders: (r.data && r.data.orders) || [] });
    } catch (err) {
      const msg = (err.response && err.response.data && err.response.data.error) || err.message;
      res.status(502).json({ error: `Could not read pending orders: ${msg}` });
    }
  });

  api('post', '/orders/:orderId/approve', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    if (!API_SECRET) return res.status(503).json({ error: 'This bot has no API_SECRET.' });
    try {
      const r = await axios.post(`${BACKEND_URL}/api/orders/confirm`, {
        secret: API_SECRET, order_id: req.params.orderId, amount_received: 0, method: 'manual',
      }, { timeout: 30000 });
      const d = r.data || {};
      // /confirm answers 200 with a message when the order was already settled
      // or is in a status it refuses to settle from. That is not a success, and
      // reporting it as one is how an order gets "approved" twice.
      if (!d.success) return res.status(409).json({ error: d.message || 'The backend would not confirm that order.' });
      console.log(`[panel] ${req.panelSession.username} approved order ${req.params.orderId}`);
      res.json({ success: true });
    } catch (err) {
      const msg = (err.response && err.response.data && err.response.data.error) || err.message;
      res.status(502).json({ error: msg });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  api('get', '/settings', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;
    const { rows } = await db.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    res.json({ settings: rows[0] || null });
  });

  const SETTINGS_ALLOWED = [
    'verified_role_name', 'verified_role_id', 'welcome_channel_name', 'welcome_channel_id',
    'verify_channel_name', 'verify_channel_id', 'invites_channel_name', 'invites_channel_id',
    'invites_needed', 'log_channel_id', 'staff_role_id',
    'ticket_log_channel', 'gen_role_id', 'overseer_role_id', 'counting_channel_id',
    'leave_vouch_channel_id', 'vouches_channel_id',
    'warnings_before_ban', 'mute_duration_minutes', 'spam_message_limit', 'spam_time_window',
  ];
  const SETTINGS_NUMERIC = new Set([
    'invites_needed', 'warnings_before_ban', 'mute_duration_minutes', 'spam_message_limit', 'spam_time_window',
  ]);

  api('post', '/settings', async (req, res) => {
    const guildId = guildOf(req, res); if (!guildId) return;

    const updates = {};
    for (const key of SETTINGS_ALLOWED) {
      if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, key)) continue;
      let v = req.body[key];
      if (v === '' || v === null || v === undefined) { updates[key] = null; continue; }
      if (SETTINGS_NUMERIC.has(key)) {
        // These columns are INTEGER. A typo used to reach Postgres as a string
        // and 500 the whole save, losing the other twenty fields with it.
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${key} must be a whole number.` });
        updates[key] = n;
        continue;
      }
      if (key.endsWith('_id') || key === 'ticket_log_channel') {
        const s = String(v).trim();
        if (!/^\d{5,25}$/.test(s)) return res.status(400).json({ error: `${key} must be a Discord ID (digits only) — copy it with Developer Mode on.` });
        updates[key] = s;
        continue;
      }
      updates[key] = String(v).trim();
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to save.' });

    await db.ensureGuild(guildId);
    const cols = Object.keys(updates);
    await db.query(
      `INSERT INTO guild_settings (guild_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (guild_id) DO UPDATE SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()`,
      [guildId, ...cols.map(c => updates[c])]
    );
    if (invalidateGuildSettings) invalidateGuildSettings(guildId);
    res.json({ success: true, saved: cols.length });
  });

  // ── The page ──────────────────────────────────────────────────────────────
  app.get('/panel', route(async (req, res) => {
    const session = await readSession(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The panel renders untrusted strings (guild names, link labels). A CSP
    // will not save a page that concatenates HTML, but it does stop an injected
    // <script src> from reaching out, and costs nothing here.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    res.send(renderPanelPage(session, req.query.guild));
  }));
}

// ═══ PAGE ═══════════════════════════════════════════════════════════════════
function renderPanelPage(session, selectedGuildId) {
  if (!session) return renderLogin();
  const guild = selectedGuildId ? session.manageableGuilds.find(g => g.id === selectedGuildId) : null;
  if (!guild) return renderPicker(session);
  return renderDashboard(session, guild);
}

const SHARED_HEAD = `
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg:#08080c; --panel:#0e0e16; --panel2:#111120; --border:#242438; --border-hi:#3d3d63;
      --accent:#8b5cf6; --accent-hi:#a78bfa; --cyan:#38bdf8; --green:#34d399; --red:#f87171; --amber:#fbbf24;
      --text:#e6e6ef; --muted:#8888a3; --dim:#4d4d6b;
    }
    *{box-sizing:border-box}
    body{
      background:var(--bg); color:var(--text); margin:0; min-height:100vh;
      font-family:'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, monospace;
      background-image:
        radial-gradient(circle at 15% 0%, rgba(139,92,246,0.08), transparent 40%),
        radial-gradient(circle at 85% 100%, rgba(56,189,248,0.06), transparent 40%);
      background-attachment:fixed;
    }
    ::selection{background:var(--accent); color:#fff}
    a{color:var(--cyan)}
    .wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
    .chrome{
      border:1px solid var(--border); border-radius:10px 10px 0 0; background:var(--panel2);
      padding:10px 14px; display:flex; align-items:center; gap:8px;
    }
    .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
    .dot.r{background:#f87171} .dot.y{background:#fbbf24} .dot.g{background:#34d399}
    .chrome-path{margin-left:10px;color:var(--muted);font-size:12px;letter-spacing:.02em}
    .chrome-path b{color:var(--accent-hi)}

    .boot-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .boot-box{width:100%;max-width:520px}
    .boot-log{
      border:1px solid var(--border); border-top:none; border-radius:0 0 10px 10px; background:var(--panel);
      padding:20px; font-size:13px; line-height:1.9; min-height:170px;
    }
    .boot-line{color:var(--muted); opacity:0; animation:fadeIn .2s forwards}
    .boot-line .ok{color:var(--green)} .boot-line .tag{color:var(--cyan)}
    .cursor{display:inline-block;width:8px;height:14px;background:var(--accent-hi);vertical-align:middle;animation:blink 1s step-end infinite}
    @keyframes fadeIn{to{opacity:1}}
    @keyframes blink{50%{opacity:0}}
    .login-btn{
      display:inline-flex;align-items:center;gap:10px;margin-top:22px;
      background:var(--accent); color:#fff; text-decoration:none; font-weight:700;
      padding:13px 22px;border-radius:6px;font-size:13px;letter-spacing:.03em;
      box-shadow:0 0 0 1px rgba(139,92,246,.4), 0 8px 24px -8px rgba(139,92,246,.6);
      transition:transform .15s ease, box-shadow .15s ease;
    }
    .login-btn:hover{transform:translateY(-1px)}
    @media (prefers-reduced-motion: reduce){ .boot-line{animation:none;opacity:1} .cursor{animation:none} }

    .topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 4px;font-size:13px;gap:12px}
    .topbar .who b{color:var(--accent-hi)}
    .topbar a.logout{color:var(--dim);text-decoration:none;font-size:12px}
    .topbar a.logout:hover{color:var(--red)}

    .field{margin:14px 0}
    .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
    select,input,textarea{
      width:100%; background:var(--panel); border:1px solid var(--border); color:var(--text);
      padding:10px 12px; border-radius:6px; font-family:inherit; font-size:13px; outline:none;
      transition:border-color .15s ease, box-shadow .15s ease;
    }
    textarea{resize:vertical;line-height:1.6}
    select:focus,input:focus,textarea:focus{border-color:var(--accent); box-shadow:0 0 0 3px rgba(139,92,246,.15)}
    input::placeholder,textarea::placeholder{color:var(--dim)}

    .win{border:1px solid var(--border);border-radius:10px;margin:22px 0;overflow:hidden;background:var(--panel)}
    .win-head{
      background:var(--panel2); padding:10px 14px; display:flex; align-items:center; gap:10px;
      border-bottom:1px solid var(--border); font-size:12.5px;
    }
    .win-head .prompt{color:var(--accent-hi)} .win-head .cmd{color:var(--text)}
    .win-head .note{margin-left:auto;color:var(--dim);font-size:11px;text-align:right}
    .win-body{padding:6px 14px 14px}

    .row{
      display:flex; justify-content:space-between; align-items:center; gap:12px;
      padding:11px 2px; border-bottom:1px solid var(--border); font-size:13px;
    }
    .row:last-child{border-bottom:none}
    .row .left{color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0}
    .row .right{color:var(--muted); font-size:12px; flex-shrink:0; display:flex; align-items:center; gap:6px}
    .row a{color:var(--cyan); text-decoration:none} .row a:hover{text-decoration:underline}
    .sub{color:var(--muted);font-size:11.5px}

    .empty{color:var(--dim); font-style:italic; font-size:12.5px; padding:16px 2px}
    .empty::before{content:'// '}
    .loading{color:var(--dim);font-size:12.5px;padding:16px 2px}
    .loading::before{content:'... '}
    .err{color:var(--red);font-size:12.5px;padding:16px 2px}
    .err::before{content:'!! '}

    button, .btn{
      background:transparent; border:1px solid var(--accent); color:var(--accent-hi);
      padding:9px 16px; border-radius:6px; cursor:pointer; font-family:inherit;
      font-size:12px; letter-spacing:.03em; text-transform:uppercase; font-weight:700;
      transition:background .15s ease, color .15s ease;
    }
    button:hover, .btn:hover{background:var(--accent); color:#fff}
    button:disabled{opacity:.45;cursor:not-allowed}
    button:disabled:hover{background:transparent;color:var(--accent-hi)}
    button.danger{border-color:var(--red); color:var(--red)}
    button.danger:hover{background:var(--red); color:#fff}
    button.ghost{border-color:var(--border-hi);color:var(--muted)}
    button.ghost:hover{background:var(--border-hi);color:var(--text)}
    .del{padding:5px 10px;font-size:10px;border-color:var(--red);color:var(--red)}
    .del:hover{background:var(--red);color:#fff}
    .mini{padding:5px 9px;font-size:10px}

    .add-row{display:flex;gap:10px;align-items:flex-end;margin:14px 2px 6px;flex-wrap:wrap}
    .add-row .field{flex:1;min-width:170px;margin:0}

    .warn{
      margin:10px 2px 4px; padding:12px 14px; border:1px solid rgba(251,191,36,.35);
      background:rgba(251,191,36,.06); border-radius:6px; color:#e2c078; font-size:12px; line-height:1.6;
    }
    .notice{
      margin:14px 2px; padding:12px 14px; border:1px solid var(--border-hi); border-radius:6px;
      color:var(--muted); font-size:12.5px; line-height:1.6;
    }
    .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
    @media (max-width:600px){.settings-grid{grid-template-columns:1fr}}

    .stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:14px 2px}
    .stat{border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--panel2)}
    .stat .n{font-size:22px;font-weight:700;color:var(--accent-hi)}
    .stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:4px}

    .section-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:26px 2px 10px}
    .picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
    .gcard{border:1px solid var(--border);border-radius:10px;padding:16px 12px;text-align:center;background:var(--panel)}
    .gcard img,.gcard .gfallback{width:52px;height:52px;border-radius:50%;margin:0 auto 10px;display:block;object-fit:cover}
    .gcard .gfallback{background:var(--panel2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent-hi);font-size:18px;border:1px solid var(--border)}
    .gcard .gname{font-size:12.5px;margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gcard a.btn{display:block;text-decoration:none}
    .btn-amber{border-color:var(--amber)!important;color:var(--amber)!important}
    .btn-amber:hover{background:var(--amber)!important;color:#1a1300!important}

    .dash{display:flex;align-items:flex-start;margin-top:16px;gap:16px}
    .sidebar{width:176px;flex-shrink:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--panel);position:sticky;top:20px}
    .sidebar a{display:block;padding:11px 14px;color:var(--muted);text-decoration:none;font-size:12.5px;border-bottom:1px solid var(--border)}
    .sidebar a:last-child{border-bottom:none}
    .sidebar a:hover{color:var(--text);background:var(--panel2)}
    .sidebar a.active{color:var(--accent-hi);background:var(--panel2);border-left:2px solid var(--accent);padding-left:12px}
    .content{flex:1;min-width:0}
    .section{display:none}
    .section.active{display:block}
    .backlink{color:var(--dim);text-decoration:none}
    .backlink:hover{color:var(--accent-hi)}
    @media (max-width:700px){
      .dash{flex-direction:column}
      .sidebar{width:100%;position:static;display:flex;overflow-x:auto}
      .sidebar a{white-space:nowrap;border-bottom:none;border-right:1px solid var(--border)}
    }

    /* Discord-ish embed preview */
    .embed{border-left:4px solid #5865F2;background:#2b2d31;border-radius:4px;padding:12px 14px;margin:10px 2px;font-family:'gg sans',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#dbdee1;white-space:pre-wrap;word-wrap:break-word}
    .embed .etitle{color:#f2f3f5;font-weight:700;font-size:15px;margin-bottom:8px}
    .embed .efoot{color:#949ba4;font-size:11.5px;margin-top:10px}
    .embed b{color:#f2f3f5}
    .embed code{background:#1e1f22;border-radius:3px;padding:1px 4px;font-family:Consolas,monospace;font-size:12.5px}

    /* Toasts — the panel's only channel for "what the server actually said" */
    #toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:99;max-width:min(420px,calc(100vw - 36px))}
    .toast{
      border:1px solid var(--border-hi);background:var(--panel2);border-radius:8px;padding:11px 14px;
      font-size:12.5px;line-height:1.5;box-shadow:0 12px 30px -12px rgba(0,0,0,.9);
      animation:slideIn .18s ease; word-wrap:break-word;
    }
    .toast.ok{border-color:rgba(52,211,153,.5);color:var(--green)}
    .toast.bad{border-color:rgba(248,113,113,.5);color:var(--red)}
    .toast.info{color:var(--muted)}
    @keyframes slideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @media (prefers-reduced-motion: reduce){.toast{animation:none}}

    .keyout{background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:12px;margin:12px 2px;font-size:13px;line-height:1.9;user-select:all}
    .keyout .k{color:var(--green)}
  </style>`;

function renderLogin() {
  return `<!DOCTYPE html><html><head><title>SUPERBOT :: panel</title>${SHARED_HEAD}</head>
  <body>
    <div class="boot-screen"><div class="boot-box">
      <div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="chrome-path"><b>superbot</b>@panel:~$</span></div>
      <div class="boot-log" id="bootLog"></div>
    </div></div>
    <script>
      const lines = [
        'booting superbot panel v2.0 ...',
        'session store ... <span class="tag">POSTGRES</span>',
        'checking session ... <span class="tag">NONE</span>',
        '<span class="ok">&gt;</span> awaiting authentication<span class="cursor"></span>'
      ];
      const el = document.getElementById('bootLog');
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      function renderBtn(){
        const a = document.createElement('a');
        a.className = 'login-btn'; a.href = '/panel/auth/discord';
        a.innerHTML = '&gt;&gt; Log in with Discord';
        document.querySelector('.boot-box').appendChild(a);
      }
      if (reduced) {
        el.innerHTML = lines.map(l => '<div class="boot-line" style="opacity:1">' + l + '</div>').join('');
        renderBtn();
      } else {
        lines.forEach((l, i) => {
          const d = document.createElement('div');
          d.className = 'boot-line'; d.style.animationDelay = (i * 0.3) + 's'; d.innerHTML = l;
          el.appendChild(d);
        });
        setTimeout(renderBtn, lines.length * 300 + 200);
      }
    </script>
  </body></html>`;
}

function renderPicker(session) {
  const card = (g, install) => {
    const icon = g.icon
      ? `<img src="https://cdn.discordapp.com/icons/${encodeURIComponent(g.id)}/${encodeURIComponent(g.icon)}.png" alt="">`
      : `<div class="gfallback">${escapeHtml(String(g.name || '?').charAt(0).toUpperCase())}</div>`;
    const href = install ? `/panel/install?guild_id=${encodeURIComponent(g.id)}` : `/panel?guild=${encodeURIComponent(g.id)}`;
    return `<div class="gcard">${icon}<div class="gname">${escapeHtml(g.name)}</div>
      <a class="btn${install ? ' btn-amber' : ''}" href="${href}">${install ? 'Invite' : 'Manage'}</a></div>`;
  };
  const hasAny = session.manageableGuilds.length || session.installableGuilds.length;

  return `<!DOCTYPE html><html><head><title>SUPERBOT :: panel</title>${SHARED_HEAD}</head>
  <body>
    <div class="wrap">
      <div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="chrome-path"><b>${escapeHtml(session.username)}</b>@superbot:~/panel$</span></div>
      <div class="topbar">
        <span class="who">logged in as <b>${escapeHtml(session.username)}</b></span>
        <a class="logout" href="/panel/auth/logout">&gt; log out</a>
      </div>
      ${session.manageableGuilds.length ? `
      <div class="section-label">$ ls servers/ --managed</div>
      <div class="picker-grid">${session.manageableGuilds.map(g => card(g, false)).join('')}</div>` : ''}
      ${session.installableGuilds.length ? `
      <div class="section-label">$ ls servers/ --available</div>
      <div class="picker-grid">${session.installableGuilds.map(g => card(g, true)).join('')}</div>` : ''}
      ${!hasAny ? `<div class="notice">No servers found with Manage Server permission. If SUPERBOT should already be in one of your servers, check that you're logged into the right Discord account. <a href="/panel/install">Add SUPERBOT to a server</a>.</div>` : ''}
    </div>
  </body></html>`;
}

function renderDashboard(session, guild) {
  const contentBox = key => `
    <div class="win" data-doc="${key}">
      <div class="win-head"><span class="prompt">$</span><span class="cmd">vim ${key}.md</span>
        <span class="note" id="meta_${key}">—</span></div>
      <div class="win-body">
        <div class="field"><label>Title</label><input id="content_${key}_title" placeholder="loading..."></div>
        <div class="field"><label>Body — plain text or box art; it is translated to Discord markdown on the way out</label>
          <textarea id="content_${key}_body" rows="8" placeholder="loading..."></textarea></div>
        <div class="add-row">
          <button onclick="saveContent('${key}')">&gt; Save</button>
          <button class="ghost" onclick="previewContent('${key}')">Preview</button>
          <div class="field" style="flex:2"><label>Post to channel</label>
            <select id="postch_${key}"><option value="">— pick a channel —</option></select></div>
          <button class="ghost" onclick="postContent('${key}')">Post to Discord</button>
        </div>
        <div id="preview_${key}"></div>
      </div>
    </div>`;

  return `<!DOCTYPE html><html><head><title>SUPERBOT :: ${escapeHtml(guild.name)}</title>${SHARED_HEAD}</head>
  <body>
    <div class="wrap">
      <div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="chrome-path"><b>${escapeHtml(session.username)}</b>@superbot:~/panel/${escapeHtml(guild.name)}$</span></div>

      <div class="topbar">
        <span class="who"><a class="backlink" href="/panel">&lt; servers</a> / <b>${escapeHtml(guild.name)}</b></span>
        <a class="logout" href="/panel/auth/logout">&gt; log out</a>
      </div>

      <div class="dash">
        <div class="sidebar">
          <a href="#" class="nav-link active" data-section="overview">📊 Overview</a>
          <a href="#" class="nav-link" data-section="orders">🧾 Orders</a>
          <a href="#" class="nav-link" data-section="links">🔗 Links</a>
          <a href="#" class="nav-link" data-section="stock">📦 Stock</a>
          <a href="#" class="nav-link" data-section="keys">🔑 Keys</a>
          <a href="#" class="nav-link" data-section="tickets">🎫 Tickets</a>
          <a href="#" class="nav-link" data-section="content">📄 Content</a>
          <a href="#" class="nav-link" data-section="settings">⚙️ Settings</a>
        </div>

        <div class="content">
          <!-- OVERVIEW -->
          <div class="section active" id="section-overview">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">status --all</span>
                <span class="note"><button class="mini ghost" onclick="load('overview', true)">refresh</button></span></div>
              <div class="win-body"><div id="overview" class="loading">reading</div></div>
            </div>
          </div>

          <!-- ORDERS -->
          <div class="section" id="section-orders">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">orders --pending</span>
                <span class="note">approving delivers for real</span></div>
              <div class="win-body">
                <div class="warn">Approve only once you have <b>confirmed the money arrived</b>. It marks the order paid, claims the keys from stock, DMs the buyer and emails the receipt — exactly as a website checkout would.</div>
                <div id="orders" class="loading">reading</div>
              </div>
            </div>
          </div>

          <!-- LINKS -->
          <div class="section" id="section-links">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">cat useful_links.db</span>
                <span class="note">shared with /addusefullink</span></div>
              <div class="win-body">
                <div id="links" class="loading">reading</div>
                <div class="add-row">
                  <div class="field"><label>Title</label><input id="newLabel" placeholder="Windows 11 Download"></div>
                  <div class="field"><label>URL</label><input id="newUrl" placeholder="https://..."></div>
                  <button onclick="addLink()">+ Add</button>
                </div>
              </div>
            </div>
          </div>

          <!-- STOCK -->
          <div class="section" id="section-stock">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">cat stock.db</span>
                <span class="note">counts only — credentials never leave the DB</span></div>
              <div class="win-body"><div id="stock" class="loading">reading</div></div>
            </div>
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">addstock</span></div>
              <div class="win-body">
                <div class="field"><label>Type</label><input id="stockType" list="stockTypes" placeholder="standard / phone-verified / activision / 5m-bundle">
                  <datalist id="stockTypes"></datalist></div>
                <div class="field"><label>Accounts — one per line</label>
                  <textarea id="stockLines" rows="6" placeholder="user:pass&#10;user2:pass2"></textarea></div>
                <button onclick="addStock()">+ Add to stock</button>
              </div>
            </div>
          </div>

          <!-- KEYS -->
          <div class="section" id="section-keys">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">genkey</span>
                <span class="note">same table as /genkey</span></div>
              <div class="win-body">
                <div class="add-row">
                  <div class="field" style="flex:2"><label>Role</label><select id="keyRole"><option value="">loading...</option></select></div>
                  <!-- Same eight values /genkey offers. A ninth here would mint
                       a key with a duration Discord's own picker cannot produce,
                       and the label would fall back to the raw "45d". -->
                  <div class="field"><label>Duration</label><select id="keyDuration">
                    <option value="lifetime">Lifetime</option>
                    <option value="365d">1 Year</option><option value="90d">3 Months</option>
                    <option value="30d">1 Month</option><option value="14d">2 Weeks</option>
                    <option value="3d">3 Days</option><option value="1d">1 Day</option>
                    <option value="5m">5 Minutes</option>
                  </select></div>
                  <div class="field" style="max-width:110px"><label>How many</label><input id="keyCount" type="number" min="1" max="25" value="1"></div>
                  <button onclick="mintKeys()">Generate</button>
                </div>
                <div id="keyOut"></div>
              </div>
            </div>
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">tail keys.db</span>
                <span class="note"><select id="keyFilter" style="width:auto;padding:4px 8px;font-size:11px" onchange="load('keys', true)">
                  <option value="all">all</option><option value="unredeemed">unredeemed</option>
                  <option value="active">active</option><option value="expired">expired</option>
                  <option value="revoked">revoked</option></select></span></div>
              <div class="win-body"><div id="keys" class="loading">reading</div></div>
            </div>
          </div>

          <!-- TICKETS -->
          <div class="section" id="section-tickets">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">tail tickets.db</span>
                <span class="note"><select id="ticketFilter" style="width:auto;padding:4px 8px;font-size:11px" onchange="load('tickets', true)">
                  <option value="all">all</option><option value="open">open</option><option value="closed">closed</option>
                </select></span></div>
              <div class="win-body">
                <div class="notice">A live ticket is a Discord channel with people in it — it stays managed there, so nothing here closes one. The <b>open</b> link jumps straight to the channel.</div>
                <div id="tickets" class="loading">reading</div>
              </div>
            </div>
          </div>

          <!-- CONTENT -->
          <div class="section" id="section-content">
            <div class="notice">Preview runs the <b>same renderer</b> <code>/post-tos</code> runs, so what you see is what Discord gets. Box-drawing art is translated to markdown — a fenced block inside an embed does not wrap, which is why pasted ASCII banners used to run off the edge of a phone.</div>
            ${CONTENT_KEYS.map(contentBox).join('')}
          </div>

          <!-- SETTINGS -->
          <div class="section" id="section-settings">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">vim guild_settings.conf</span></div>
              <div class="win-body">
                <div class="warn">Most of these apply live within ~30s. Anti-scam thresholds and the log/staff/ticket channel IDs save here but are not re-read live yet — the bot still loads those from Railway env vars at startup.</div>
                <div class="settings-grid" id="settingsForm"><div class="loading">reading</div></div>
                <div style="margin:14px 2px"><button onclick="saveSettings()">&gt; Save Settings</button></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="toasts"></div>

  <script>
    var GUILD_ID = ${JSON.stringify(guild.id)};
    var CSRF = ${JSON.stringify(session.csrf)};
    var DOCS = ${JSON.stringify(CONTENT_KEYS)};
    var DOC_LABELS = ${JSON.stringify(Object.fromEntries(CONTENT_KEYS.map(k => [k, CONTENT_TYPES[k].label])))};

    // Everything that reaches innerHTML goes through this. The panel renders
    // strings it did not author — guild names, link labels, ticket categories,
    // and error text straight from the server.
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      });
    }

    function toast(msg, kind) {
      var el = document.createElement('div');
      el.className = 'toast ' + (kind || 'info');
      el.textContent = msg;
      document.getElementById('toasts').appendChild(el);
      setTimeout(function(){ el.style.transition = 'opacity .3s'; el.style.opacity = '0';
        setTimeout(function(){ el.remove(); }, 320); }, kind === 'bad' ? 9000 : 4500);
    }

    // One door for every request. It reads the response BEFORE deciding
    // anything — the old code fired alert('Saved') on the line after fetch()
    // without ever looking, so a 403 and a success were indistinguishable.
    async function api(path, opts) {
      opts = opts || {};
      var init = { method: opts.method || 'GET', headers: {} };
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      if (init.method !== 'GET') init.headers['X-Panel-CSRF'] = CSRF;

      var res;
      try {
        res = await fetch('/panel/api/guilds/' + GUILD_ID + path, init);
      } catch (e) {
        throw new Error('Could not reach the server — check your connection.');
      }
      if (res.status === 401) {
        throw new Error('Your session expired. Reload the page and log in again.');
      }
      var data = null;
      try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
      if (!res.ok) throw new Error((data && data.error) || ('Server said ' + res.status + '.'));
      return data || {};
    }

    function fail(targetId, e) {
      var el = document.getElementById(targetId);
      if (el) el.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
      toast(e.message, 'bad');
    }

    function row(left, right) {
      return '<div class="row"><span class="left">' + left + '</span><span class="right">' + right + '</span></div>';
    }

    function when(ts) {
      if (!ts) return '';
      var d = new Date(ts);
      if (isNaN(d)) return '';
      return d.toLocaleDateString(undefined, {month:'short', day:'numeric'}) + ' ' +
             d.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'});
    }

    // ── Tab routing. Each tab loads on first view rather than all eight on
    // page load — the old page fired ten requests before you had clicked
    // anything, four of them for documents most visits never open.
    var loaded = {};
    var LOADERS = {
      overview: loadOverview, orders: loadOrders, links: loadLinks, stock: loadStock,
      keys: loadKeys, tickets: loadTickets, content: loadContent, settings: loadSettings
    };
    function load(name, force) {
      if (loaded[name] && !force) return;
      loaded[name] = true;
      LOADERS[name]();
    }
    document.querySelectorAll('.nav-link').forEach(function(a) {
      a.addEventListener('click', function(e) {
        e.preventDefault();
        document.querySelectorAll('.nav-link').forEach(function(x){ x.classList.remove('active'); });
        document.querySelectorAll('.section').forEach(function(x){ x.classList.remove('active'); });
        a.classList.add('active');
        document.getElementById('section-' + a.dataset.section).classList.add('active');
        location.hash = a.dataset.section;
        load(a.dataset.section);
      });
    });

    // ── Overview ────────────────────────────────────────────────────────
    async function loadOverview() {
      try {
        var d = await api('/overview');
        var stat = function(n, l){ return '<div class="stat"><div class="n">' + esc(n) + '</div><div class="l">' + esc(l) + '</div></div>'; };
        var html = '<div class="stat-grid">' +
          (d.guild ? stat(d.guild.members, 'members') : '') +
          stat(d.stock.total, 'accounts in stock') +
          stat(d.keys.unredeemed, 'keys unclaimed') +
          stat(d.keys.active, 'keys active') +
          stat(d.tickets.open, 'tickets open') +
          stat(d.links, 'useful links') +
        '</div>';

        html += '<div class="section-label">documents</div>';
        html += DOCS.map(function(k) {
          var at = d.content[k];
          return row(esc(DOC_LABELS[k]), at
            ? '<span style="color:var(--green)">set</span> <span class="sub">' + esc(when(at)) + '</span>'
            : '<span style="color:var(--dim)">never written</span>');
        }).join('');

        if (!d.ordersConfigured) {
          html += '<div class="notice">The Orders tab is off: this bot has no <code>API_SECRET</code>, so it cannot reach the storefront backend.</div>';
        }
        document.getElementById('overview').innerHTML = html;
      } catch (e) { fail('overview', e); }
    }

    // ── Orders ──────────────────────────────────────────────────────────
    async function loadOrders() {
      try {
        var d = await api('/orders/pending');
        var o = d.orders || [];
        document.getElementById('orders').innerHTML = o.length
          ? o.map(function(x) {
              var ref = x.invoice_no || ('#' + x.order_id);
              // Plain text, not a <@id> mention: a mention only resolves inside
              // Discord, so in a browser it renders as literal punctuation that
              // reads like a bug.
              var who = x.discord_id ? ('user ' + x.discord_id) : (x.email || 'no contact');
              return row(
                '<b>' + esc(ref) + '</b> <span class="sub">' + esc(x.summary) + '</span><br>' +
                '<span class="sub">' + esc(who) + ' · ' + esc(String(x.payment_method || '').toUpperCase()) +
                (x.payment_note ? ' · note ' + esc(x.payment_note) : '') + '</span>',
                '<b style="color:var(--amber)">$' + esc(Number(x.total).toFixed(2)) + '</b>' +
                '<button class="mini" onclick="approveOrder(' + JSON.stringify(String(x.order_id)) + ', ' + JSON.stringify(ref) + ')">approve</button>'
              );
            }).join('')
          : '<div class="empty">nothing is waiting on payment — every order is settled</div>';
      } catch (e) { fail('orders', e); }
    }

    async function approveOrder(id, ref) {
      if (!confirm('Approve ' + ref + '?\\n\\nThis marks it PAID, claims keys from stock, DMs the buyer and emails the receipt. It cannot be undone from here.')) return;
      try {
        await api('/orders/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} });
        toast('Order ' + ref + ' confirmed — delivery triggered.', 'ok');
        load('orders', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    // ── Links ───────────────────────────────────────────────────────────
    async function loadLinks() {
      try {
        var d = await api('/links');
        document.getElementById('links').innerHTML = d.links.length
          ? d.links.map(function(l, i) {
              return row(
                '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label) + '</a>',
                '<button class="mini ghost" ' + (i === 0 ? 'disabled' : '') + ' onclick="moveLink(' + JSON.stringify(String(l.id)) + ',\\'up\\')">↑</button>' +
                '<button class="mini ghost" ' + (i === d.links.length - 1 ? 'disabled' : '') + ' onclick="moveLink(' + JSON.stringify(String(l.id)) + ',\\'down\\')">↓</button>' +
                '<button class="del" onclick="removeLink(' + JSON.stringify(String(l.id)) + ',' + JSON.stringify(l.label) + ')">remove</button>'
              );
            }).join('')
          : '<div class="empty">no links yet</div>';
      } catch (e) { fail('links', e); }
    }

    async function addLink() {
      var label = document.getElementById('newLabel').value.trim();
      var url = document.getElementById('newUrl').value.trim();
      if (!label || !url) return toast('Both a title and a URL are required.', 'bad');
      try {
        await api('/links', { method: 'POST', body: { label: label, url: url } });
        document.getElementById('newLabel').value = '';
        document.getElementById('newUrl').value = '';
        toast('Link added.', 'ok');
        load('links', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function removeLink(id, label) {
      if (!confirm('Remove "' + label + '"?')) return;
      try {
        await api('/links/' + encodeURIComponent(id), { method: 'DELETE' });
        toast('Removed.', 'ok');
        load('links', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function moveLink(id, dir) {
      try {
        await api('/links/' + encodeURIComponent(id) + '/move', { method: 'POST', body: { dir: dir } });
        load('links', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    // ── Stock ───────────────────────────────────────────────────────────
    async function loadStock() {
      try {
        var d = await api('/stock');
        document.getElementById('stock').innerHTML = d.stock.length
          ? d.stock.map(function(s) {
              return row(
                '<b>' + esc(s.type) + '</b>' + (s.newest ? ' <span class="sub">last added ' + esc(when(s.newest)) + '</span>' : ''),
                '<span>' + esc(s.count) + ' available</span>' +
                '<button class="del" onclick="clearStock(' + JSON.stringify(s.type) + ',' + esc(s.count) + ')">clear</button>'
              );
            }).join('')
          : '<div class="empty">no stock added yet</div>';
        var dl = document.getElementById('stockTypes');
        dl.innerHTML = d.stock.map(function(s){ return '<option value="' + esc(s.type) + '">'; }).join('');
      } catch (e) { fail('stock', e); }
    }

    async function addStock() {
      var type = document.getElementById('stockType').value.trim();
      var accounts = document.getElementById('stockLines').value;
      if (!type) return toast('Pick or type a stock type.', 'bad');
      if (!accounts.trim()) return toast('Paste the accounts, one per line.', 'bad');
      try {
        var d = await api('/stock', { method: 'POST', body: { type: type, accounts: accounts } });
        document.getElementById('stockLines').value = '';
        toast('Added ' + d.added + ' account(s) to ' + d.type + '.', 'ok');
        load('stock', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function clearStock(type, count) {
      if (!confirm('Delete all ' + count + ' "' + type + '" account(s)?\\n\\nThis cannot be undone.')) return;
      try {
        var d = await api('/stock/' + encodeURIComponent(type), { method: 'DELETE' });
        toast('Removed ' + d.removed + ' account(s).', 'ok');
        load('stock', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    // ── Keys ────────────────────────────────────────────────────────────
    var rolesLoaded = false;
    async function loadRoles() {
      if (rolesLoaded) return;
      try {
        var d = await api('/roles');
        var sel = document.getElementById('keyRole');
        sel.innerHTML = '<option value="">— pick a role —</option>' + d.roles.map(function(r) {
          return '<option value="' + esc(r.id) + '">' + esc(r.name) + '</option>';
        }).join('');
        rolesLoaded = true;
      } catch (e) {
        document.getElementById('keyRole').innerHTML = '<option value="">' + esc(e.message) + '</option>';
      }
    }

    async function loadKeys() {
      loadRoles();
      try {
        var status = document.getElementById('keyFilter').value;
        var d = await api('/keys?status=' + encodeURIComponent(status));
        document.getElementById('keys').innerHTML = d.keys.length
          ? d.keys.map(function(k) {
              var right;
              if (k.status === 'active') {
                right = '<span style="color:var(--green)">active</span>' +
                  (k.expires_at ? ' <span class="sub">until ' + esc(when(k.expires_at)) + '</span>' : ' <span class="sub">lifetime</span>');
              } else if (k.status === 'unredeemed') {
                right = '<span style="color:var(--cyan)">unclaimed</span>';
              } else {
                right = '<span style="color:var(--dim)">' + esc(k.status) + '</span>';
              }
              if (k.status === 'active' || k.status === 'unredeemed') {
                right += '<button class="del" onclick="revoke(' + JSON.stringify(k.key) + ')">revoke</button>';
              }
              return row(
                '<code style="user-select:all">' + esc(k.key) + '</code> <span class="sub">— ' + esc(k.role_name || 'unknown role') + '</span>' +
                (k.redeemed_by ? '<br><span class="sub">claimed by ' + esc(k.redeemed_by) + ' · ' + esc(when(k.redeemed_at)) + '</span>' : ''),
                right
              );
            }).join('')
          : '<div class="empty">no keys match that filter</div>';
      } catch (e) { fail('keys', e); }
    }

    async function mintKeys() {
      var roleId = document.getElementById('keyRole').value;
      var duration = document.getElementById('keyDuration').value;
      var count = parseInt(document.getElementById('keyCount').value, 10) || 1;
      if (!roleId) return toast('Pick a role first.', 'bad');
      try {
        var d = await api('/keys', { method: 'POST', body: { role_id: roleId, duration: duration, count: count } });
        document.getElementById('keyOut').innerHTML =
          '<div class="keyout"><div class="sub">' + esc(d.keys.length) + ' key(s) for <b>' + esc(d.role) + '</b> · ' + esc(d.duration) + ' — copy them now, this box is not saved anywhere</div>' +
          d.keys.map(function(k){ return '<div class="k">' + esc(k) + '</div>'; }).join('') + '</div>';
        toast('Generated ' + d.keys.length + ' key(s).', 'ok');
        load('keys', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    async function revoke(key) {
      if (!confirm('Revoke ' + key + '?\\n\\nIf it has been redeemed, the role is removed from whoever holds it.')) return;
      try {
        var d = await api('/keys/' + encodeURIComponent(key) + '/revoke', { method: 'POST', body: {} });
        toast('Revoked.' + (d.roleRemoved ? ' Role removed from the holder.' : (d.note ? ' ' + d.note : '')), 'ok');
        load('keys', true);
      } catch (e) { toast(e.message, 'bad'); }
    }

    // ── Tickets ─────────────────────────────────────────────────────────
    async function loadTickets() {
      try {
        var status = document.getElementById('ticketFilter').value;
        var d = await api('/tickets?status=' + encodeURIComponent(status));
        document.getElementById('tickets').innerHTML = d.tickets.length
          ? d.tickets.map(function(t) {
              var jump = t.channel_id && t.status === 'open'
                ? '<a href="https://discord.com/channels/' + esc(GUILD_ID) + '/' + esc(t.channel_id) + '" target="_blank" rel="noopener noreferrer">open ↗</a>'
                : '<span style="color:var(--dim)">' + esc(t.status) + '</span>';
              return row(
                '<b>' + esc(t.category || 'General') + '</b> <span class="sub">— user ' + esc(t.user_id) + '</span>' +
                '<br><span class="sub">opened ' + esc(when(t.created_at)) + (t.closed_at ? ' · closed ' + esc(when(t.closed_at)) : '') + '</span>',
                jump
              );
            }).join('')
          : '<div class="empty">no tickets match that filter</div>';
      } catch (e) { fail('tickets', e); }
    }

    // ── Content ─────────────────────────────────────────────────────────
    async function loadContent() {
      loadChannels();
      for (var i = 0; i < DOCS.length; i++) await loadDoc(DOCS[i]);
    }

    async function loadDoc(key) {
      try {
        var d = await api('/content/' + key);
        var c = d.content;
        var t = document.getElementById('content_' + key + '_title');
        var b = document.getElementById('content_' + key + '_body');
        t.value = c ? c.title : '';
        t.placeholder = d.defaultTitle;
        b.value = c ? c.body : '';
        b.placeholder = 'Nothing saved yet.';
        document.getElementById('meta_' + key).textContent = c
          ? (c.body.length + ' chars · saved ' + when(c.updated_at))
          : 'never written';
      } catch (e) {
        document.getElementById('meta_' + key).textContent = e.message;
      }
    }

    var channelsLoaded = false;
    async function loadChannels() {
      if (channelsLoaded) return;
      try {
        var d = await api('/channels');
        var opts = '<option value="">— pick a channel —</option>' + d.channels.map(function(c) {
          return '<option value="' + esc(c.id) + '">#' + esc(c.name) + (c.parent ? ' (' + esc(c.parent) + ')' : '') + '</option>';
        }).join('');
        DOCS.forEach(function(k) {
          var s = document.getElementById('postch_' + k);
          if (s) s.innerHTML = opts;
        });
        channelsLoaded = true;
      } catch (e) {
        DOCS.forEach(function(k) {
          var s = document.getElementById('postch_' + k);
          if (s) s.innerHTML = '<option value="">' + esc(e.message) + '</option>';
        });
      }
    }

    async function saveContent(key) {
      var title = document.getElementById('content_' + key + '_title').value.trim();
      var body = document.getElementById('content_' + key + '_body').value.trim();
      if (!title || !body) return toast('Both a title and a body are required.', 'bad');
      try {
        var d = await api('/content/' + key, { method: 'POST', body: { title: title, body: body } });
        toast('Saved — ' + d.chars + ' chars over ' + d.pages + ' embed page(s).', 'ok');
        loadDoc(key);
        previewContent(key);
      } catch (e) { toast(e.message, 'bad'); }
    }

    // A deliberately small markdown subset: exactly what renderContentBody
    // emits (bold, bullets, inline code). Rendering more than the renderer
    // produces would make the preview a nicer document than Discord shows.
    function discordish(text) {
      return esc(text)
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    }

    async function previewContent(key) {
      var title = document.getElementById('content_' + key + '_title').value.trim();
      var body = document.getElementById('content_' + key + '_body').value;
      var target = document.getElementById('preview_' + key);
      if (!body.trim()) { target.innerHTML = '<div class="empty">nothing to preview</div>'; return; }
      target.innerHTML = '<div class="loading">rendering</div>';
      try {
        var d = await api('/content/' + key + '/preview', { method: 'POST', body: { body: body } });
        target.innerHTML =
          '<div class="section-label">preview — ' + esc(d.chars) + ' chars in, ' + esc(d.rendered) + ' rendered, ' + esc(d.pages.length) + ' embed(s)</div>' +
          d.pages.map(function(p, i) {
            return '<div class="embed">' +
              (i === 0 && title ? '<div class="etitle">' + esc(title) + '</div>' : '') +
              discordish(p) +
              '<div class="efoot">' + (d.pages.length > 1 ? 'page ' + (i + 1) + '/' + d.pages.length : 'UH SERVICES') + '</div>' +
            '</div>';
          }).join('');
      } catch (e) { fail('preview_' + key, e); }
    }

    async function postContent(key) {
      var ch = document.getElementById('postch_' + key).value;
      if (!ch) return toast('Pick a channel first.', 'bad');
      var name = document.getElementById('postch_' + key).selectedOptions[0].textContent;
      if (!confirm('Post the saved ' + DOC_LABELS[key] + ' to ' + name + '?\\n\\nIt posts the SAVED version — save first if you have unsaved edits.')) return;
      try {
        var d = await api('/content/' + key + '/post', { method: 'POST', body: { channel_id: ch } });
        toast('Posted to #' + d.channel + ' — ' + d.pages + ' page(s) over ' + d.messages + ' message(s).', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    }

    // ── Settings ────────────────────────────────────────────────────────
    var SETTINGS_FIELDS = [
      ['verified_role_id', 'Verified role ID'],
      ['welcome_channel_id', 'Welcome channel ID'],
      ['verify_channel_id', 'Verify channel ID'],
      ['invites_channel_id', 'Invites channel ID'],
      ['invites_needed', 'Invites needed'],
      ['log_channel_id', 'Log channel ID'],
      ['staff_role_id', 'Staff role ID'],
      ['ticket_log_channel', 'Ticket log channel ID'],
      ['gen_role_id', 'Gen Member role ID'],
      ['overseer_role_id', 'OVERSEER role ID'],
      ['counting_channel_id', 'Counting game channel ID'],
      ['leave_vouch_channel_id', 'Leave-a-vouch panel channel ID'],
      ['vouches_channel_id', 'Vouches results channel ID'],
      ['warnings_before_ban', 'Warnings before ban'],
      ['mute_duration_minutes', 'Mute duration (minutes)'],
      ['spam_message_limit', 'Spam message limit'],
      ['spam_time_window', 'Spam time window (seconds)']
    ];

    async function loadSettings() {
      try {
        var d = await api('/settings');
        var s = d.settings || {};
        document.getElementById('settingsForm').innerHTML = SETTINGS_FIELDS.map(function(f) {
          var v = s[f[0]];
          return '<div class="field"><label>' + esc(f[1]) + '</label>' +
            '<input id="setting_' + esc(f[0]) + '" value="' + esc(v == null ? '' : v) + '"></div>';
        }).join('');
      } catch (e) { fail('settingsForm', e); }
    }

    async function saveSettings() {
      var body = {};
      for (var i = 0; i < SETTINGS_FIELDS.length; i++) {
        var el = document.getElementById('setting_' + SETTINGS_FIELDS[i][0]);
        if (!el) continue;
        body[SETTINGS_FIELDS[i][0]] = el.value.trim() === '' ? null : el.value.trim();
      }
      try {
        var d = await api('/settings', { method: 'POST', body: body });
        toast('Saved ' + d.saved + ' field(s) — most apply within ~30 seconds.', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    }

    // Deep-link straight to a tab, so a bookmark or a reload lands where you
    // were rather than always on Overview.
    (function() {
      var want = (location.hash || '').replace('#', '');
      var link = want && document.querySelector('.nav-link[data-section="' + want.replace(/[^a-z]/g, '') + '"]');
      if (link) link.click(); else load('overview');
    })();
  </script>
  </body></html>`;
}

// renderPanelPage is exported for test_panel_render.js, which extracts the
// inline <script> and syntax-checks it. The client JS lives inside a server
// template literal, so a stray backtick or `${` is invisible to `node -c` on
// this file and only shows up as a blank page in the browser.
module.exports = { registerPanelRoutes, renderPanelPage };

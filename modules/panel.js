// ─── Web panel: OAuth login + guild picker + useful-links editor ───────────
// Registered onto the SAME express app auth2fa.js already runs (one Railway
// service, one port — no second deploy needed).
//
// Required env vars:
//   DISCORD_CLIENT_ID      — same application as the bot
//   DISCORD_CLIENT_SECRET  — Discord Developer Portal → OAuth2 → Client Secret
//   PANEL_BASE_URL          — e.g. https://superbot-production.up.railway.app
//                             (must exactly match a redirect URI registered
//                             in the Discord Developer Portal, with
//                             /panel/auth/discord/callback appended)
'use strict';

const crypto = require('crypto');
const db = require('../db');

// sessionId → { discordUserId, username, avatar, manageableGuilds: [{id,name}], expiresAt }
// In-memory is fine for a single Railway instance. If you ever scale to
// multiple instances, this needs to move to Postgres/Redis.
const panelSessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function newSessionId() {
  return crypto.randomBytes(32).toString('hex');
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

function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies.panel_session;
  if (!sid) return null;
  const session = panelSessions.get(sid);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    panelSessions.delete(sid);
    return null;
  }
  return session;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not logged in.' });
  req.panelSession = session;
  next();
}

const MANAGE_GUILD = 0x20n;

function registerPanelRoutes(app, discordClient) {
  const CLIENT_ID     = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const BASE_URL      = process.env.PANEL_BASE_URL;
  const REDIRECT_URI  = BASE_URL ? `${BASE_URL}/panel/auth/discord/callback` : null;

  // ── Login ──────────────────────────────────────────────────────────────
  app.get('/panel/auth/discord', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(503).send('Panel login is not configured yet (missing DISCORD_CLIENT_ID / PANEL_BASE_URL).');
    }
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/panel/auth/discord/callback', async (req, res) => {
    if (!CLIENT_SECRET) return res.status(503).send('Panel login is not configured yet (missing DISCORD_CLIENT_SECRET).');

    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code.');

    try {
      // Exchange code for a token
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

      // Fetch the logged-in user
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();

      // Fetch their guilds, filter to ones they can manage
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userGuilds = await guildsRes.json();

      const manageable = (Array.isArray(userGuilds) ? userGuilds : [])
        .filter(g => g.owner === true || (BigInt(g.permissions || 0) & MANAGE_GUILD) === MANAGE_GUILD)
        // Only show servers the bot is actually installed in — otherwise
        // there's nothing yet for the panel to manage there.
        .filter(g => discordClient.guilds.cache.has(g.id))
        .map(g => ({ id: g.id, name: g.name, icon: g.icon }));

      const sessionId = newSessionId();
      panelSessions.set(sessionId, {
        discordUserId: user.id,
        username: user.username,
        avatar: user.avatar,
        manageableGuilds: manageable,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });

      res.setHeader('Set-Cookie', `panel_session=${sessionId}; HttpOnly; Path=/panel; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
      res.redirect('/panel');
    } catch (e) {
      console.error('[panel] OAuth callback error:', e);
      res.status(500).send('Login failed — check server logs.');
    }
  });

  app.get('/panel/auth/logout', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.panel_session) panelSessions.delete(cookies.panel_session);
    res.setHeader('Set-Cookie', 'panel_session=; HttpOnly; Path=/panel; Max-Age=0');
    res.redirect('/panel');
  });

  // "Add to Server" — public install flow, no login required
  app.get('/panel/install', (req, res) => {
    if (!CLIENT_ID) return res.status(503).send('Not configured.');
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'bot applications.commands',
      permissions: '8', // Administrator — simplest for now; narrow this later once every feature's permission needs are finalized
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  // ── API: guild list ───────────────────────────────────────────────────
  app.get('/panel/api/me', requireSession, (req, res) => {
    const { discordUserId, username, avatar, manageableGuilds } = req.panelSession;
    res.json({ discordUserId, username, avatar, guilds: manageableGuilds });
  });

  function assertGuildAccess(req, res) {
    const guildId = req.params.guildId;
    const allowed = req.panelSession.manageableGuilds.some(g => g.id === guildId);
    if (!allowed) {
      res.status(403).json({ error: 'You do not have access to manage this server.' });
      return null;
    }
    return guildId;
  }

  // ── API: useful links (Phase 1 proof of concept — same table the bot's
  // /addusefullink etc. commands use, so changes here show up in Discord
  // immediately and vice versa) ────────────────────────────────────────────
  app.get('/panel/api/guilds/:guildId/links', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    const { rows } = await db.query(
      'SELECT id, label, url FROM useful_links WHERE guild_id = $1 ORDER BY sort_order ASC, id ASC',
      [guildId]
    );
    res.json({ links: rows });
  });

  app.post('/panel/api/guilds/:guildId/links', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;

    const { label, url } = req.body || {};
    if (!label || !url) return res.status(400).json({ error: 'label and url are required.' });
    try { new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL.' }); }

    await db.ensureGuild(guildId);
    const { rows } = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM useful_links WHERE guild_id = $1',
      [guildId]
    );
    await db.query(
      'INSERT INTO useful_links (guild_id, label, url, sort_order) VALUES ($1,$2,$3,$4)',
      [guildId, label, url, rows[0].next]
    );
    res.json({ success: true });
  });

  app.delete('/panel/api/guilds/:guildId/links/:linkId', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    await db.query('DELETE FROM useful_links WHERE id = $1 AND guild_id = $2', [req.params.linkId, guildId]);
    res.json({ success: true });
  });

  // ── Minimal panel UI — no build step, single static page ────────────────
  app.get('/panel', (req, res) => {
    const session = getSession(req);
    res.setHeader('Content-Type', 'text/html');
    res.send(renderPanelPage(session));
  });
}

function renderPanelPage(session) {
  if (!session) {
    return `<!DOCTYPE html><html><head><title>SUPERBOT Panel</title>
      <style>body{background:#0f0f13;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      a.btn{background:#5865F2;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold}</style>
      </head><body><a class="btn" href="/panel/auth/discord">Log in with Discord</a></body></html>`;
  }

  return `<!DOCTYPE html><html><head><title>SUPERBOT Panel</title>
  <style>
    body{background:#0f0f13;color:#eee;font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
    select,input,button{background:#1e1e24;color:#eee;border:1px solid #333;border-radius:6px;padding:8px;margin:4px 0}
    button{background:#5865F2;border:none;cursor:pointer}
    .link-row{display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid #222}
    .link-row a{color:#7289DA}
    .del{background:#ED4245;padding:4px 10px;font-size:12px}
    h1{font-size:20px} label{display:block;margin-top:12px;font-size:13px;color:#aaa}
  </style></head><body>
    <h1>👋 ${session.username} — <a href="/panel/auth/logout" style="color:#aaa">log out</a></h1>
    <label>Server</label>
    <select id="guildSelect">
      ${session.manageableGuilds.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
    </select>
    ${session.manageableGuilds.length === 0 ? '<p>No manageable servers found — you need Manage Server permission and the bot must already be installed there. <a href="/panel/install" style="color:#7289DA">Add the bot to a server</a>.</p>' : ''}

    <h2>🔗 Useful Links</h2>
    <div id="links"></div>

    <label>Title</label><input id="newLabel" placeholder="Windows 11 Download">
    <label>URL</label><input id="newUrl" placeholder="https://...">
    <br><button onclick="addLink()">Add Link</button>

  <script>
    const guildSelect = document.getElementById('guildSelect');
    async function loadLinks() {
      const guildId = guildSelect.value;
      if (!guildId) return;
      const res = await fetch('/panel/api/guilds/' + guildId + '/links');
      const data = await res.json();
      document.getElementById('links').innerHTML = data.links.map(l =>
        '<div class="link-row"><a href="' + l.url + '" target="_blank">' + l.label + '</a>' +
        '<button class="del" onclick="removeLink(' + l.id + ')">Remove</button></div>'
      ).join('') || '<p style="color:#666">No links yet.</p>';
    }
    async function addLink() {
      const label = document.getElementById('newLabel').value.trim();
      const url = document.getElementById('newUrl').value.trim();
      if (!label || !url) return alert('Both fields required.');
      await fetch('/panel/api/guilds/' + guildSelect.value + '/links', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ label, url })
      });
      document.getElementById('newLabel').value = '';
      document.getElementById('newUrl').value = '';
      loadLinks();
    }
    async function removeLink(id) {
      await fetch('/panel/api/guilds/' + guildSelect.value + '/links/' + id, { method: 'DELETE' });
      loadLinks();
    }
    guildSelect.addEventListener('change', loadLinks);
    if (guildSelect.value) loadLinks();
  </script>
  </body></html>`;
}

module.exports = { registerPanelRoutes };

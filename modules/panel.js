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

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function registerPanelRoutes(app, discordClient, { invalidateGuildSettings } = {}) {
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

      const permittedGuilds = (Array.isArray(userGuilds) ? userGuilds : [])
        .filter(g => g.owner === true || (BigInt(g.permissions || 0) & MANAGE_GUILD) === MANAGE_GUILD);

      const manageable  = permittedGuilds.filter(g => discordClient.guilds.cache.has(g.id))
        .map(g => ({ id: g.id, name: g.name, icon: g.icon }));
      const installable = permittedGuilds.filter(g => !discordClient.guilds.cache.has(g.id))
        .map(g => ({ id: g.id, name: g.name, icon: g.icon }));

      const sessionId = newSessionId();
      panelSessions.set(sessionId, {
        discordUserId: user.id,
        username: user.username,
        avatar: user.avatar,
        manageableGuilds: manageable,
        installableGuilds: installable,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });

      res.setHeader('Set-Cookie', `panel_session=${sessionId}; HttpOnly; Secure; Path=/panel; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
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
    if (req.query.guild_id) {
      params.set('guild_id', req.query.guild_id);
      params.set('disable_guild_select', 'true');
    }
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

  // ── API: stock levels (read-only — account credentials aren't shown in
  // the browser; use /addstock or /clearstock in Discord to manage the
  // actual accounts, same security boundary as /stock today) ─────────────
  app.get('/panel/api/guilds/:guildId/stock', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    const { rows } = await db.query(
      'SELECT type, COUNT(*)::int AS count FROM stock WHERE guild_id = $1 GROUP BY type ORDER BY type ASC',
      [guildId]
    );
    res.json({ stock: rows });
  });

  // ── API: keys (read-only list — generating still requires picking a
  // Discord role, which needs its own picker UI; use /genkey for now) ─────
  app.get('/panel/api/guilds/:guildId/keys', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    const { rows } = await db.query(
      `SELECT key, role_name, status, redeemed_by, expires_at, created_at
       FROM keys WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [guildId]
    );
    res.json({ keys: rows });
  });

  // ── API: ticket history (read-only log — see modules/support.js for why
  // live ticket management stays in Discord) ───────────────────────────────
  app.get('/panel/api/guilds/:guildId/tickets', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    const { rows } = await db.query(
      `SELECT user_id, category, status, created_at, closed_at
       FROM tickets WHERE guild_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [guildId]
    );
    res.json({ tickets: rows });
  });

  // ── API: guild settings ─────────────────────────────────────────────────
  // NOTE: this reads/writes the guild_settings table correctly, but the bot
  // does not yet re-read these values live — index.js/antiscam.js still load
  // most config from Railway env vars once at startup. Wiring the bot to
  // prefer these DB values (with env vars as fallback) is the next step;
  // for now, editing here won't change bot behaviour until that's done.
  app.get('/panel/api/guilds/:guildId/settings', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;
    const { rows } = await db.query('SELECT * FROM guild_settings WHERE guild_id = $1', [guildId]);
    res.json({ settings: rows[0] || null });
  });

  app.post('/panel/api/guilds/:guildId/settings', requireSession, async (req, res) => {
    const guildId = assertGuildAccess(req, res);
    if (!guildId) return;

    const allowed = [
      'verified_role_name', 'welcome_channel_name', 'verify_channel_name',
      'invites_channel_name', 'invites_needed', 'log_channel_id', 'staff_role_id',
      'ticket_log_channel', 'gen_role_id', 'overseer_role_id', 'counting_channel_id',
      'warnings_before_ban', 'mute_duration_minutes', 'spam_message_limit', 'spam_time_window',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No recognized settings fields provided.' });

    await db.ensureGuild(guildId);
    const cols = Object.keys(updates);
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const insertCols = cols.join(', ');
    const insertVals = cols.map((_, i) => `$${i + 2}`).join(', ');
    await db.query(
      `INSERT INTO guild_settings (guild_id, ${insertCols})
       VALUES ($1, ${insertVals})
       ON CONFLICT (guild_id) DO UPDATE SET ${setClause}, updated_at = now()`,
      [guildId, ...cols.map(c => updates[c])]
    );
    if (invalidateGuildSettings) invalidateGuildSettings(guildId);
    res.json({ success: true });
  });

  // ── Minimal panel UI — no build step, single static page ────────────────
  app.get('/panel', (req, res) => {
    const session = getSession(req);
    res.setHeader('Content-Type', 'text/html');
    res.send(renderPanelPage(session, req.query.guild));
  });
}

function renderPanelPage(session, selectedGuildId) {
  const SHARED_HEAD = `
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preconnect" href="https://fonts.googleapis.com">
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
      .wrap{max-width:760px;margin:0 auto;padding:32px 20px 80px}
      .chrome{
        border:1px solid var(--border); border-radius:10px 10px 0 0; background:var(--panel2);
        padding:10px 14px; display:flex; align-items:center; gap:8px;
      }
      .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
      .dot.r{background:#f87171} .dot.y{background:#fbbf24} .dot.g{background:#34d399}
      .chrome-path{margin-left:10px;color:var(--muted);font-size:12px;letter-spacing:.02em}
      .chrome-path b{color:var(--accent-hi)}

      /* ── Logged-out: boot screen ─────────────────────────────────── */
      .boot-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
      .boot-box{width:100%;max-width:520px}
      .boot-log{
        border:1px solid var(--border); border-top:none; border-radius:0 0 10px 10px; background:var(--panel);
        padding:20px; font-size:13px; line-height:1.9; min-height:170px;
      }
      .boot-line{color:var(--muted); opacity:0; animation:fadeIn .2s forwards}
      .boot-line .ok{color:var(--green)}
      .boot-line .tag{color:var(--cyan)}
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
      .login-btn:hover{transform:translateY(-1px); box-shadow:0 0 0 1px rgba(167,139,250,.6), 0 12px 28px -8px rgba(139,92,246,.8)}
      @media (prefers-reduced-motion: reduce){ .boot-line{animation:none;opacity:1} .cursor{animation:none} }

      /* ── Logged-in: dashboard ────────────────────────────────────── */
      .topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 4px;font-size:13px}
      .topbar .who b{color:var(--accent-hi)}
      .topbar a.logout{color:var(--dim);text-decoration:none;font-size:12px}
      .topbar a.logout:hover{color:var(--red)}

      .field{margin:14px 0}
      .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
      select,input{
        width:100%; background:var(--panel); border:1px solid var(--border); color:var(--text);
        padding:10px 12px; border-radius:6px; font-family:inherit; font-size:13px; outline:none;
        transition:border-color .15s ease, box-shadow .15s ease;
      }
      select:focus,input:focus{border-color:var(--accent); box-shadow:0 0 0 3px rgba(139,92,246,.15)}
      input::placeholder{color:var(--dim)}

      .win{border:1px solid var(--border);border-radius:10px;margin:22px 0;overflow:hidden;background:var(--panel)}
      .win-head{
        background:var(--panel2); padding:10px 14px; display:flex; align-items:center; gap:10px;
        border-bottom:1px solid var(--border); font-size:12.5px;
      }
      .win-head .prompt{color:var(--accent-hi)} .win-head .cmd{color:var(--text)}
      .win-head .note{margin-left:auto;color:var(--dim);font-size:11px}
      .win-body{padding:6px 14px}

      .row{
        display:flex; justify-content:space-between; align-items:center; gap:12px;
        padding:11px 2px; border-bottom:1px solid var(--border); font-size:13px;
      }
      .row:last-child{border-bottom:none}
      .row .left{color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
      .row .right{color:var(--muted); font-size:12px; flex-shrink:0}
      .row a{color:var(--cyan); text-decoration:none} .row a:hover{text-decoration:underline}

      .empty{color:var(--dim); font-style:italic; font-size:12.5px; padding:16px 2px}
      .empty::before{content:'// '}

      button, .btn{
        background:transparent; border:1px solid var(--accent); color:var(--accent-hi);
        padding:9px 16px; border-radius:6px; cursor:pointer; font-family:inherit;
        font-size:12px; letter-spacing:.03em; text-transform:uppercase; font-weight:700;
        transition:background .15s ease, color .15s ease;
      }
      button:hover, .btn:hover{background:var(--accent); color:#fff}
      button.danger{border-color:var(--red); color:var(--red)}
      button.danger:hover{background:var(--red); color:#fff}
      .del{padding:5px 10px;font-size:10px;border-color:var(--red);color:var(--red)}
      .del:hover{background:var(--red);color:#fff}

      .add-row{display:flex;gap:10px;align-items:flex-end;margin:14px 2px 6px;flex-wrap:wrap}
      .add-row .field{flex:1;min-width:180px;margin:0}

      .warn{
        margin:10px 2px 4px; padding:12px 14px; border:1px solid rgba(251,191,36,.35);
        background:rgba(251,191,36,.06); border-radius:6px; color:#e2c078; font-size:12px; line-height:1.6;
      }
      .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
      @media (max-width:600px){.settings-grid{grid-template-columns:1fr}}
      .notice{
        margin:14px 2px; padding:12px 14px; border:1px solid var(--border-hi); border-radius:6px;
        color:var(--muted); font-size:12.5px; line-height:1.6;
      }
      .notice a{color:var(--cyan)}

      /* ── Server picker ────────────────────────────────────────────── */
      .section-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:26px 2px 10px}
      .picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
      .gcard{border:1px solid var(--border);border-radius:10px;padding:16px 12px;text-align:center;background:var(--panel)}
      .gcard img,.gcard .gfallback{width:52px;height:52px;border-radius:50%;margin:0 auto 10px;display:block;object-fit:cover}
      .gcard .gfallback{background:var(--panel2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent-hi);font-size:18px;border:1px solid var(--border)}
      .gcard .gname{font-size:12.5px;margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gcard a.btn{display:block;text-decoration:none}
      .btn-amber{border-color:var(--amber)!important;color:var(--amber)!important}
      .btn-amber:hover{background:var(--amber)!important;color:#1a1300!important}

      /* ── Sidebar dashboard ────────────────────────────────────────── */
      .dash{display:flex;align-items:flex-start;margin-top:16px;gap:16px}
      .sidebar{width:172px;flex-shrink:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--panel);position:sticky;top:20px}
      .sidebar a{display:block;padding:11px 14px;color:var(--muted);text-decoration:none;font-size:12.5px;border-bottom:1px solid var(--border)}
      .sidebar a:last-child{border-bottom:none}
      .sidebar a:hover{color:var(--text);background:var(--panel2)}
      .sidebar a.active{color:var(--accent-hi);background:var(--panel2);border-left:2px solid var(--accent);padding-left:12px}
      .content{flex:1;min-width:0}
      .section{display:none}
      .section.active{display:block}
      .backlink{color:var(--dim);text-decoration:none}
      .backlink:hover{color:var(--accent-hi)}
      @media (max-width:640px){
        .dash{flex-direction:column}
        .sidebar{width:100%;position:static;display:flex;overflow-x:auto}
        .sidebar a{white-space:nowrap;border-bottom:none;border-right:1px solid var(--border)}
      }
    </style>`;

  if (!session) {
    return `<!DOCTYPE html><html><head><title>SUPERBOT :: panel</title>${SHARED_HEAD}</head>
    <body>
      <div class="boot-screen"><div class="boot-box">
        <div class="chrome"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
          <span class="chrome-path"><b>superbot</b>@panel:~$</span></div>
        <div class="boot-log" id="bootLog"></div>
      </div></div>
      <script>
        const lines = [
          'booting superbot panel v1.0 ...',
          'checking session ... <span class="tag">NONE</span>',
          'discord oauth required',
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
            d.className = 'boot-line'; d.style.animationDelay = (i * 0.35) + 's'; d.innerHTML = l;
            el.appendChild(d);
          });
          setTimeout(renderBtn, lines.length * 350 + 200);
        }
      </script>
    </body></html>`;
  }

  const guild = selectedGuildId ? session.manageableGuilds.find(g => g.id === selectedGuildId) : null;

  // ── No server selected (or an invalid one) — show the picker ──────────
  if (!guild) {
    const gcard = g => {
      const icon = g.icon
        ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">`
        : `<div class="gfallback">${escapeHtml(g.name || '?').charAt(0).toUpperCase()}</div>`;
      return `<div class="gcard">${icon}<div class="gname">${escapeHtml(g.name)}</div>
        <a class="btn" href="/panel?guild=${g.id}">Manage</a></div>`;
    };
    const icard = g => {
      const icon = g.icon
        ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png" alt="">`
        : `<div class="gfallback">${escapeHtml(g.name || '?').charAt(0).toUpperCase()}</div>`;
      return `<div class="gcard">${icon}<div class="gname">${escapeHtml(g.name)}</div>
        <a class="btn btn-amber" href="/panel/install?guild_id=${g.id}">Invite</a></div>`;
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
        <div class="picker-grid">${session.manageableGuilds.map(gcard).join('')}</div>` : ''}

        ${session.installableGuilds.length ? `
        <div class="section-label">$ ls servers/ --available</div>
        <div class="picker-grid">${session.installableGuilds.map(icard).join('')}</div>` : ''}

        ${!hasAny ? `<div class="notice">No servers found with Manage Server permission. If SUPERBOT should already be in one of your servers, check that you're logged into the right Discord account. <a href="/panel/install">Add SUPERBOT to a server</a>.</div>` : ''}
      </div>
    </body></html>`;
  }

  // ── Server selected — sidebar dashboard ────────────────────────────────
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
          <a href="#" class="nav-link active" data-section="links">🔗 Links</a>
          <a href="#" class="nav-link" data-section="stock">📦 Stock</a>
          <a href="#" class="nav-link" data-section="keys">🔑 Keys</a>
          <a href="#" class="nav-link" data-section="tickets">🎫 Tickets</a>
          <a href="#" class="nav-link" data-section="settings">⚙️ Settings</a>
        </div>

        <div class="content">
          <div class="section active" id="section-links">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">cat useful_links.db</span></div>
              <div class="win-body">
                <div id="links"></div>
                <div class="add-row">
                  <div class="field"><label>Title</label><input id="newLabel" placeholder="Windows 11 Download"></div>
                  <div class="field"><label>URL</label><input id="newUrl" placeholder="https://..."></div>
                  <button onclick="addLink()">+ Add</button>
                </div>
              </div>
            </div>
          </div>

          <div class="section" id="section-stock">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">cat stock.db</span><span class="note">read-only · /addstock</span></div>
              <div class="win-body"><div id="stock"></div></div>
            </div>
          </div>

          <div class="section" id="section-keys">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">tail keys.db -n 50</span><span class="note">read-only · /genkey</span></div>
              <div class="win-body"><div id="keys"></div></div>
            </div>
          </div>

          <div class="section" id="section-tickets">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">tail tickets.db -n 50</span><span class="note">read-only history</span></div>
              <div class="win-body"><div id="tickets"></div></div>
            </div>
          </div>

          <div class="section" id="section-settings">
            <div class="win">
              <div class="win-head"><span class="prompt">$</span><span class="cmd">vim guild_settings.conf</span></div>
              <div class="win-body">
                <div class="warn">✅ Most of these apply live within ~30s. Anti-scam thresholds and log/staff/ticket channel IDs save here but aren't read dynamically yet.</div>
                <div class="settings-grid" id="settingsForm"></div>
                <div style="margin:14px 2px"><button onclick="saveSettings()">&gt; Save Settings</button></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

  <script>
    const GUILD_ID = ${JSON.stringify(guild.id)};

    document.querySelectorAll('.nav-link').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.nav-link').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.section').forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        document.getElementById('section-' + a.dataset.section).classList.add('active');
      });
    });

    const SETTINGS_FIELDS = [
      ['verified_role_name', 'Verified role name'],
      ['welcome_channel_name', 'Welcome channel name'],
      ['verify_channel_name', 'Verify channel name'],
      ['invites_channel_name', 'Invites channel name'],
      ['invites_needed', 'Invites needed'],
      ['log_channel_id', 'Log channel ID'],
      ['staff_role_id', 'Staff role ID'],
      ['ticket_log_channel', 'Ticket log channel ID'],
      ['gen_role_id', 'Gen Member role ID'],
      ['overseer_role_id', 'OVERSEER role ID'],
      ['counting_channel_id', 'Counting game channel ID'],
      ['warnings_before_ban', 'Warnings before ban'],
      ['mute_duration_minutes', 'Mute duration (minutes)'],
      ['spam_message_limit', 'Spam message limit'],
      ['spam_time_window', 'Spam time window (seconds)'],
    ];

    function row(left, right) {
      return '<div class="row"><span class="left">' + left + '</span><span class="right">' + right + '</span></div>';
    }

    async function loadLinks() {
      const res = await fetch('/panel/api/guilds/' + GUILD_ID + '/links');
      const data = await res.json();
      document.getElementById('links').innerHTML = data.links.length
        ? data.links.map(l => row('<a href="' + l.url + '" target="_blank">' + l.label + '</a>', '<button class="del" onclick="removeLink(' + l.id + ')">remove</button>')).join('')
        : '<div class="empty">no links yet</div>';
    }

    async function loadStock() {
      const res = await fetch('/panel/api/guilds/' + GUILD_ID + '/stock');
      const data = await res.json();
      document.getElementById('stock').innerHTML = data.stock.length
        ? data.stock.map(s => row(s.type, s.count + ' available')).join('')
        : '<div class="empty">no stock added yet</div>';
    }

    async function loadKeys() {
      const res = await fetch('/panel/api/guilds/' + GUILD_ID + '/keys');
      const data = await res.json();
      document.getElementById('keys').innerHTML = data.keys.length
        ? data.keys.map(k => {
            const status = k.status === 'active' ? ('active — <@' + k.redeemed_by + '>') : k.status;
            return row(k.key + ' <span style="color:var(--muted)">— ' + k.role_name + '</span>', status);
          }).join('')
        : '<div class="empty">no keys yet</div>';
    }

    async function loadTickets() {
      const res = await fetch('/panel/api/guilds/' + GUILD_ID + '/tickets');
      const data = await res.json();
      document.getElementById('tickets').innerHTML = data.tickets.length
        ? data.tickets.map(t => row((t.category || 'General') + ' <span style="color:var(--muted)">— &lt;@' + t.user_id + '&gt;</span>', t.status)).join('')
        : '<div class="empty">no tickets logged yet</div>';
    }

    async function loadSettings() {
      const res = await fetch('/panel/api/guilds/' + GUILD_ID + '/settings');
      const data = await res.json();
      const settings = data.settings || {};
      document.getElementById('settingsForm').innerHTML = SETTINGS_FIELDS.map(([key, label]) =>
        '<div class="field"><label>' + label + '</label><input id="setting_' + key + '" value="' + (settings[key] ?? '') + '"></div>'
      ).join('');
    }

    async function saveSettings() {
      const body = {};
      for (const [key] of SETTINGS_FIELDS) {
        const val = document.getElementById('setting_' + key).value;
        body[key] = val === '' ? null : val;
      }
      await fetch('/panel/api/guilds/' + GUILD_ID + '/settings', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      alert('Saved — most settings apply within ~30 seconds.');
    }

    async function addLink() {
      const label = document.getElementById('newLabel').value.trim();
      const url = document.getElementById('newUrl').value.trim();
      if (!label || !url) return alert('Both fields required.');
      await fetch('/panel/api/guilds/' + GUILD_ID + '/links', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ label, url })
      });
      document.getElementById('newLabel').value = '';
      document.getElementById('newUrl').value = '';
      loadLinks();
    }
    async function removeLink(id) {
      await fetch('/panel/api/guilds/' + GUILD_ID + '/links/' + id, { method: 'DELETE' });
      loadLinks();
    }

    loadLinks(); loadStock(); loadKeys(); loadTickets(); loadSettings();
  </script>
  </body></html>`;
}

module.exports = { registerPanelRoutes };

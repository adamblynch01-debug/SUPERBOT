# 🤖 UH Services — Super Bot

All 5 Discord bots unified into one single Node.js process.

---

## ✅ What's included

| Original Bot | Features |
|---|---|
| **RESTOREDBOT** | Verification system, welcome cards with canvas, invite tracking & reward system |
| **UPDATES-BOT** | Product updates, announcements, downloads panel, reseller panel, website pin, status updates |
| **SCAM-BOT** | Anti-scam detection, profanity filter, banned links, warning system, spam flood ban |
| **DM-SUPPORT-BOT** | DM ticket system, staff quick-reply, ticket log channel, game select |
| **discord-2fa-bot** | REST API server for Discord-based 2FA (for your website) |

---

## 🚀 Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Required `.env` values

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your bot token from Discord Developer Portal |
| `CLIENT_ID` | Your application/client ID |
| `GUILD_ID` | *(Optional)* Your guild ID — commands register faster when set |

### 4. Module-specific variables

**Verify / Welcome module**
| Variable | Default | Description |
|---|---|---|
| `VERIFIED_ROLE_NAME` | `Verified` | Name of the role given after verification |
| `VERIFY_CHANNEL_NAME` | `get-verify` | Channel name for the verify panel |
| `WELCOME_CHANNEL_NAME` | `welcome` | Channel name for welcome cards |
| `INVITES_CHANNEL_NAME` | `invites` | Channel name for invite rewards |
| `INVITES_NEEDED` | `10` | Invites required to redeem a key |

**Updates module**
| Variable | Default | Description |
|---|---|---|
| `BOT_NAME` | `UH Services` | Shown in embed footers |
| `SITE_URL` | *(empty)* | Shown in embed footers |

**Anti-Scam module**
| Variable | Default | Description |
|---|---|---|
| `LOG_CHANNEL_ID` | *(none)* | Channel ID for scam/ban logs |
| `WARNINGS_BEFORE_BAN` | `3` | Warnings before auto-ban |
| `MUTE_DURATION_MINUTES` | `30` | Timeout on first offense |
| `SPAM_MESSAGE_LIMIT` | `3` | Messages in window before spam ban |
| `SPAM_TIME_WINDOW` | `10` | Window in seconds |

**DM Support module**
| Variable | Description |
|---|---|
| `SUPPORT_CHANNEL` | Channel ID where support panel is posted |
| `TICKET_LOG_CHANNEL` | Channel ID where ticket logs appear |
| `STAFF_ROLE_ID` | Role ID that can use Quick Reply / Close Ticket |

**2FA Auth Server module**
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the REST API server |

---

## 5. Run the bot
```bash
npm start
```

---

## 📋 All Commands

### Slash Commands

| Command | Who | Description |
|---|---|---|
| `/setup-verify` | Admin | Set up verification channel + lock all other channels |
| `/setup-invites` | Admin | Set up invite reward channel |
| `/panel` | Admin | Post the DM support panel |
| `/clearlogs` | Admin | Clear the ticket log channel |
| `/reply` | Staff | Reply to a user's support ticket by ID |
| `/postupdate` | Staff | Post a product update embed |
| `/statusupdate` | Staff | Post a status update to #status-updates |
| `/announce` | Staff | Send a custom announcement to any channel |
| `/downloads` | Everyone | Browse & download products (ephemeral) |
| `/setupdownloads` | Staff | Post the download panel to #downloads |
| `/setdownload` | Staff | Set or update a product download link |
| `/setwebsite` | Staff | Post/update the website URL in #website |
| `/setupreseller` | Staff | Post the reseller program panel |
| `/setresellerlinks` | Staff | Update Apply & Preview Panel button links |
| `/postimage` | Staff | Post an image directly to any channel |
| `/commands` | Everyone | Show all available bot commands |

### Prefix Commands (Anti-Scam)

| Command | Who | Description |
|---|---|---|
| `!bothelp` | Everyone | Show anti-scam command list |
| `!manage` | Manage Messages | Show management panel + current settings |
| `!scamcheck <text>` | Manage Messages | Test if a message would be flagged |
| `!warnings @user` | Manage Messages | Check a user's warning count |
| `!clearwarnings @user` | Kick Members | Reset a user's warnings |
| `!addlink domain.com` | Manage Messages | Add a banned domain |
| `!removelink domain.com` | Manage Messages | Remove a banned domain |
| `!listlinks` | Manage Messages | List all banned domains |
| `!addword word` | Manage Messages | Add word to profanity filter |
| `!removeword word` | Manage Messages | Remove word from profanity filter |
| `!nuke` | Manage Channels | Wipe all messages in channel |

### DM Commands

| Command | Description |
|---|---|
| `!close` | Close your active support ticket (type this in your DM with the bot) |

---

## 🔐 2FA REST API

The bot starts an HTTP server (default port `3000`) for website integration.

### `POST /api/auth/initiate-2fa`
Send a 2FA DM to a Discord user.
```json
{ "email": "user@example.com", "discordId": "123456789012345678" }
```
Response:
```json
{ "userId": "<session-uuid>", "message": "Verification DM sent." }
```

### `POST /api/auth/verify-token`
Poll this to check if the user clicked Authenticate.
```json
{ "userId": "<session-uuid>" }
```
Response:
```json
{ "verified": true }
```

### `GET /health`
Health check — returns bot status.

---

## 🗂️ Project Structure

```
superbot/
├── index.js              ← Main entry point (all logic unified here)
├── modules/
│   ├── antiscam.js       ← Anti-scam, profanity, spam detection (ported from Python)
│   ├── support.js        ← DM ticket system (ported from Python)
│   ├── auth2fa.js        ← 2FA REST API server
│   └── downloads.js      ← Product download store
├── package.json
├── .env.example
├── tickets.json          ← Auto-created: persists open tickets
└── download_urls.json    ← Auto-created: persists download URLs
```

---

## 🔑 Required Bot Permissions

- Read Messages / View Channels
- Send Messages
- Manage Messages
- Manage Roles
- Manage Channels
- Ban Members
- Kick Members
- Moderate Members (Timeout)
- Create Instant Invite
- Embed Links
- Attach Files

**Privileged Intents** (enable in Discord Developer Portal):
- Server Members Intent
- Message Content Intent

---

## ☁️ Deployment (Railway / Render / fly.io)

Set all environment variables in your platform's dashboard and deploy. The bot includes a built-in HTTP health check server — your platform's health check should point to `GET /health`.

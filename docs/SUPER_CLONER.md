# SUPER CLONER — design, on hold

**Status: ON HOLD.** User said *"PUT THAT ON HOLD SAVE TO MEM AND AS A SEPERATE FILE TO COMEBACK
TO IT LATER"* (2026-08-04). Nothing was built. Resume from this file.

The ask: *"FOR THE WHOLE CLONING SERVER LETS MAKE SOMETHING LIKE THIS... WHAT IF WE COMBINE
`https://github.com/Copycord/Copycord` + CASA CLONER (`C:\Users\VENOM-NODE\Documents\images`)
INTO ONE SUPER CLONER INTO OUR BOT?"* Screenshots: `Documents/images/CASACLONER.webp`,
`CASACLONER2.webp`, `CASACLONER3.webp` (a marketing page, feature cards only).

Also settled in that same message: **the storefront HTML was pushed**, closing the 3-file
upload debt. The Unsplash picker has NOT yet been verified end-to-end against the live site.

## What already exists, so it does not get rebuilt

`/serverbackup` → `modules/serverBackup.js` (370 lines) + the Discord calls in `index.js`
(~line 2498 for the command, ~4400 for the handlers), table `guild_snapshots`. Shipped
round 30, commit `b394100`.

Captured today: roles (permissions, colour, hoist, position, role icon), channels and
categories of every type (position, topic, nsfw, slowmode, bitrate, user limit) with
**permission overwrites remapped by NAME** and unmappable ones dropped, guild settings (icon,
banner, splash, verification level, AFK channel + timeout, system channel), emojis, stickers.
Subcommands `create / list / view / restore / export / delete`. Restore **never deletes**, and
cross-guild restore is behind `allow_other_server:true`.

## CASA CLONER vs us — the actual delta

Its whole advertised feature list is ~80% a subset of `/serverbackup`. Genuinely missing:

- **Soundboard sounds** — not captured at all (`grep soundboard` finds nothing).
- **Forum/media specifics** — `availableTags`, default reaction emoji, default sort/layout.
  Also nothing.
- **Selective cloning, toggle each component** — restore is all-or-nothing; the only boolean
  on `/serverbackup restore` is `allow_other_server`.
- **Exact 1:1 position sync** — positions are captured, but a merge into a live server does
  not force-reorder channels that already exist. Needs verifying, not assuming.
- **Saved presets for repeat clones** — snapshots are nearly this, but cannot be parameterised.
- **Clone queue for batch processing** — absent.
- **Rate-limit protection** — discord.js already queues per-bucket and handles 429s for free.
  What still needs deliberate pacing is a large restore against the 10k-invalid-requests /
  10 min ban and the per-guild channel-create limits.

Unknown and it does not matter: whether CASA CLONER itself uses a user token. Our constraint
is that the bot must be in both servers, which the user controls.

## Copycord — splits cleanly in two

Architecture, for reference: three Docker containers off one image (`admin` web UI on 8080,
`server`, `client`) sharing a `./data` volume; Python; AGPL-3.0; **requires a bot token AND a
user token**.

**Would build (bot token, within ToS):**
- **Live structure sync** — watch the source for channel create/rename/delete and role edits
  and apply them to the clone continuously. The one genuinely new capability: it turns a
  snapshot into a live mirror of the *shape*, and pairs with the existing `modules/mirror.js`
  message relay.
- **Channel include/exclude, keyword filters, custom webhook branding** — direct extensions of
  `/mirror`, which already has `bot_only`, `allow_pings` and per-route webhooks.
- **Message history backfill** — a bot may legitimately read history in channels it can see,
  so this is fine API-wise *if the bot is in the source server*. Build it as a **transcript
  export** (JSON or rendered HTML). Re-posting other people's messages through a webhook
  wearing their name and avatar into a server they never joined is a forgery — which is
  exactly the reason `modules/serverBackup.js` excludes messages in the first place. Do not
  ship the re-post variant unless the user asks for it explicitly.
- Telegram / Pushover forwarding — trivial, low value here.

**Declined:** "send as real users", the **member list scraper** (user IDs, usernames, avatars,
bios), and DM history export. All three need a user token; Copycord's own README warns the
project "uses self-bot functionality, which is against Discord's Terms of Service and could
lead to account suspension or termination" and tells you to use a throwaway account. Nearest
safe substitute offered: a roster export of **our own guild only**, via the normal bot member
API (ids, join dates, roles), for staff bookkeeping.

## Proposed command surface

One `/clone`, with `/serverbackup` kept as an alias so saved snapshots keep working:

- `/clone snapshot` — as today, plus soundboard, forum tags/default reaction, and per-component
  flags (`roles:`, `channels:`, `emojis:`, `settings:`)
- `/clone apply <id>` — merge-never-delete restore, paced, with a **dry-run preview**, a live
  progress edit, and resumable if it dies part-way
- `/clone sync add <source-guild> <target-guild>` — target's shape follows the source from then on
- `/clone preset` — a snapshot + component toggles, re-fireable at any new server
- `/clone queue` — batch several targets from one snapshot
- `/clone export <id>` — JSON today, plus an HTML transcript if backfill happens

## The three questions the user has NOT answered yet

1. **Real use case** — disaster recovery for the two existing servers, or standing up new
   partner/customer servers from a template? Decides whether presets+queue or live-sync leads.
2. **Message history** — wanted at all? Export-only archive, or actually re-posted into the
   clone wearing each author's name? Archive gets built either way; the re-post version needs
   an explicit yes.
3. **Live shape-sync direction** — one-way source→clone only (strongly recommended), or
   two-way? Two-way sync on a channel *delete* loses the channel in both servers at once.

A copy of this plan is also in the assistant memory index, as
`ghost-store-super-cloner-onhold`.

Related: `ghost-store-bot-fixes-batch-0730` (round 30 built `/serverbackup` and `/mirror`),
`ghost-store-status-snapshot` (deploy shape).

// Internal-event endpoint tests.
//
// These routes are the bot half of the backend's notifyBot() calls. Three of
// them worked; ops_alert had no route, so every backend alert 404'd. The rest
// of this file pins down the defects the old paymentBridge implementation
// carried alongside that gap — an auth check that opened up when API_SECRET was
// unset, unclipped key lists that made Discord reject the whole delivery DM,
// and failure markers being handed to the buyer as though they were products.
//
// Mounts the real router on a real express app against a fake discord client
// and a stubbed db, so what is asserted is the shipped routing and auth.

const express = require('express');
const http = require('http');

process.env.API_SECRET = 'test-secret-value-0123456789';
process.env.GUILD_ID = 'g1';
process.env.OWNER_DISCORD_ID = '900000000000000001';
delete process.env.ORDERS_CHANNEL_ID;
delete process.env.ALERTS_CHANNEL_ID;
delete process.env.VOUCHES_CHANNEL_ID;
delete process.env.LOG_CHANNEL_ID;

// ─── db stub ─────────────────────────────────────────────
// internalEvents reads the order log channel from the `config` table and the
// vouches channel from guild_settings. Stub the module before it is required so
// no real connection is attempted.
let LOG_CHANNEL_ROW = null;   // value returned for ORDER_LOG_CHANNEL_ID
let VOUCH_CHANNEL_ROW = null; // guild_settings.vouches_channel_id
let DB_THROWS = false;

const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: {
    pool: {},
    ensureGuild: async () => {},
    query: async (sql) => {
      if (DB_THROWS) throw new Error('connection refused');
      if (/ORDER_LOG_CHANNEL_ID/.test(sql)) {
        return { rows: LOG_CHANNEL_ROW ? [{ value: LOG_CHANNEL_ROW }] : [] };
      }
      if (/vouches_channel_id/.test(sql)) {
        return { rows: VOUCH_CHANNEL_ROW ? [{ vouches_channel_id: VOUCH_CHANNEL_ROW }] : [] };
      }
      return { rows: [] };
    },
  },
};

const { registerInternalRoutes } = require('./modules/internalEvents');

// ─── fakes ───────────────────────────────────────────────
const ORDERS_CH = '1400773021274341396'; // 19-digit snowflake
const VOUCH_CH = '1242134878263447552';

let SENT = [];       // { channelId, embed }
let DMS = [];        // { userId, embed }
let REACTIONS = [];
let DM_ERROR = null;
let KNOWN_CHANNELS = new Set();
let KNOWN_USERS = new Set();

const plain = (e) => (e && e.data) ? e.data : e;

const client = {
  channels: {
    fetch: async (id) => {
      if (!KNOWN_CHANNELS.has(String(id))) throw new Error('Unknown Channel');
      return {
        id: String(id),
        send: async ({ embeds }) => {
          SENT.push({ channelId: String(id), embed: plain(embeds[0]) });
          return { react: async (e) => { REACTIONS.push(e); } };
        },
      };
    },
  },
  users: {
    fetch: async (id) => {
      if (!KNOWN_USERS.has(String(id))) throw new Error('Unknown User');
      return {
        id: String(id),
        send: async ({ embeds }) => {
          if (DM_ERROR) throw DM_ERROR;
          DMS.push({ userId: String(id), embed: plain(embeds[0]) });
        },
      };
    },
  },
};

const app = express();
app.use(express.json());
registerInternalRoutes(app, client);
const server = http.createServer(app);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// ─── harness ─────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}
function reset() {
  SENT = []; DMS = []; REACTIONS = []; DM_ERROR = null; DB_THROWS = false;
  LOG_CHANNEL_ROW = ORDERS_CH; VOUCH_CHANNEL_ROW = VOUCH_CH;
  KNOWN_CHANNELS = new Set([ORDERS_CH, VOUCH_CH]);
  KNOWN_USERS = new Set(['900000000000000001', '111111111111111111']);
  process.env.API_SECRET = SECRET;
  delete process.env.ORDERS_CHANNEL_ID;
  delete process.env.ALERTS_CHANNEL_ID;
}
const SECRET = 'test-secret-value-0123456789';
const field = (embed, name) => (embed.fields || []).find(f => f.name === name);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  console.log('\n── auth ──');

  reset();
  {
    const r = await post('/internal/ops_alert', { kind: 'x', message: 'y' });
    ok(r.status === 401, 'a call with no secret is rejected');
    ok(SENT.length === 0, 'and nothing is posted to Discord');
  }
  {
    const r = await post('/internal/ops_alert', { secret: 'wrong', kind: 'x', message: 'y' });
    ok(r.status === 401, 'a wrong secret is rejected');
  }
  {
    // Same length as the real secret — proves the compare is not a length check,
    // which is the shape a timing-safe implementation can get wrong.
    const r = await post('/internal/ops_alert', { secret: 'X'.repeat(SECRET.length), kind: 'x', message: 'y' });
    ok(r.status === 401, 'a same-length wrong secret is rejected');
  }
  {
    const r = await post('/internal/ops_alert', { secret: SECRET, kind: 'x', message: 'y' });
    ok(r.status === 200, 'the shared secret is accepted');
  }
  reset();
  {
    // The regression that matters: the old bridge compared body.secret against
    // process.env.API_SECRET with !==. Unset on both sides is undefined !==
    // undefined, which is false, so the request sailed through unauthenticated.
    delete process.env.API_SECRET;
    const r = await post('/internal/new_order', { order: { id: '1' }, payment_info: {} });
    ok(r.status === 503, 'an unset API_SECRET refuses everything rather than opening the door');
    ok(SENT.length === 0, 'and posts nothing');
    process.env.API_SECRET = SECRET;
  }

  console.log('\n── new_order ──');

  reset();
  {
    const r = await post('/internal/new_order', {
      secret: SECRET,
      order: { id: '501', payment_method: 'btc', email: 'a@b.c', total_cents: 2599 },
      payment_info: { address: 'bc1qtest', amount: 25.99 },
    });
    ok(r.status === 200 && r.body.posted === true, 'a new order posts to the order log channel');
    ok(SENT.length === 1 && SENT[0].channelId === ORDERS_CH, 'resolved from the config table');
    ok(field(SENT[0].embed, 'Total').value === '$25.99', 'total_cents renders as dollars, not raw cents');
    ok(field(SENT[0].embed, 'Pay to').value === 'bc1qtest', 'the pay-to address is included');
  }

  reset();
  {
    // The bridge did total_cents/100 unguarded, printing "$NaN" to staff.
    const r = await post('/internal/new_order', {
      secret: SECRET, order: { id: '502', payment_method: 'paypal' }, payment_info: { amount: 7.5 },
    });
    ok(field(SENT[0].embed, 'Total').value === '$7.50', 'payment_info.amount is treated as dollars');
    const r2 = await post('/internal/new_order', { secret: SECRET, order: { id: '503' }, payment_info: {} });
    ok(r2.status === 200 && field(SENT[1].embed, 'Total').value === 'unknown',
      'a missing amount reads "unknown", never "$NaN"');
  }

  reset();
  LOG_CHANNEL_ROW = null;
  {
    const r = await post('/internal/new_order', { secret: SECRET, order: { id: '504' }, payment_info: {} });
    // 503, not 200. This assertion still expected the old 200 answer after the
    // route was deliberately changed: "no channel to post to" is an outage the
    // backend must be able to see, and answering 200 was exactly how every
    // order notification vanished silently.
    ok(r.status === 503 && r.body.posted === false && r.body.handled === false,
      'no configured channel is reported as 503, not thrown — the backend must see it');
  }

  reset();
  LOG_CHANNEL_ROW = null;
  process.env.ORDERS_CHANNEL_ID = ORDERS_CH;
  {
    const r = await post('/internal/new_order', { secret: SECRET, order: { id: '505' }, payment_info: {} });
    ok(r.status === 200 && r.body.posted === true, 'an env var backs up an unset config row');
  }

  reset();
  DB_THROWS = true;
  process.env.ORDERS_CHANNEL_ID = ORDERS_CH;
  {
    const r = await post('/internal/new_order', { secret: SECRET, order: { id: '506' }, payment_info: {} });
    ok(r.status === 200 && r.body.posted === true, 'a database outage falls back to the env var');
  }

  // A single order (id 4) once produced three identical embeds in #order-log
  // while the database held one row and one debit. The backend sent one
  // notify, so the duplication happened at or below this route — most likely
  // discord.js retrying a failing send that had in fact landed. These pin the
  // suppression that makes the cause moot.
  reset();
  DB_THROWS = false;
  LOG_CHANNEL_ROW = null;
  process.env.ORDERS_CHANNEL_ID = ORDERS_CH;
  {
    const a = await post('/internal/new_order', { secret: SECRET, order: { id: '777' }, payment_info: {} });
    const b = await post('/internal/new_order', { secret: SECRET, order: { id: '777' }, payment_info: {} });
    const c = await post('/internal/new_order', { secret: SECRET, order: { id: '777' }, payment_info: {} });
    ok(a.status === 200 && a.body.posted === true, 'the first notify for an order posts');
    ok(SENT.length === 1, 'three notifies for one order produce exactly one embed');
    ok(b.body.duplicate === true && c.body.duplicate === true, 'the repeats report themselves as duplicates');
    // posted:false is botNotify's "there was no channel" signal and would make
    // the backend log a bogus ORDER_LOG_CHANNEL_ID error for a healthy skip.
    ok(b.body.posted === undefined, 'a suppressed duplicate does not claim the channel was missing');
    ok(b.status === 200, 'and it is not an error the backend has to handle');
  }

  reset();
  {
    const r = await post('/internal/new_order', { secret: SECRET, order: { id: '778' }, payment_info: {} });
    ok(r.body.posted === true, 'a different order still posts');
    ok(SENT.length === 1, 'suppression is per order id, not global');
  }

  // The status field was the hardcoded string '⏳ Pending Payment', so a
  // balance order that was paid and delivered before the embed was even built
  // still announced itself as awaiting payment.
  reset();
  {
    await post('/internal/new_order', { secret: SECRET, order: { id: '779', status: 'paid' }, payment_info: {} });
    ok(field(SENT[0].embed, 'Status').value === '💰 Paid', 'a paid order does not read "Pending Payment"');

    await post('/internal/new_order', { secret: SECRET, order: { id: '780', status: 'delivered' }, payment_info: {} });
    ok(field(SENT[1].embed, 'Status').value === '✅ Delivered', 'a delivered order reads delivered');

    await post('/internal/new_order', { secret: SECRET, order: { id: '781' }, payment_info: {} });
    ok(field(SENT[2].embed, 'Status').value === '⏳ Pending Payment',
      'an order with no status still defaults to pending payment');

    await post('/internal/new_order', { secret: SECRET, order: { id: '782', status: 'wat' }, payment_info: {} });
    ok(/wat/.test(field(SENT[3].embed, 'Status').value),
      'an unrecognised status is shown rather than silently mislabelled');
  }

  console.log('\n── deliver_goods ──');

  reset();
  {
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '601', email: 'a@b.c', discord_id: '111111111111111111',
      goods: [{ product: 'Fortnite Cheat', items: ['KEY-AAA-111', 'KEY-BBB-222'] }],
    });
    ok(r.status === 200 && r.body.dm === true, 'the buyer is DM\'d their goods');
    ok(DMS.length === 1 && /KEY-AAA-111/.test(JSON.stringify(DMS[0].embed)), 'and the keys are in the DM');
    ok(SENT.length === 1, 'staff get a copy');
    ok(!/KEY-AAA-111/.test(JSON.stringify(SENT[0].embed)), 'but the staff copy never contains the key values');
    ok(/2 delivered/.test(SENT[0].embed.description), 'the staff copy summarises counts');
  }

  reset();
  {
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '602', discord_id: '111111111111111111',
      goods: [{ product: 'Apex Cheat', items: ['OUT_OF_STOCK'] }],
      needs_attention: true,
    });
    ok(r.status === 200 && r.body.dm === false, 'a failed order does not DM the buyer');
    ok(DMS.length === 0, 'no DM is sent at all');
    ok(/Needs Attention/i.test(SENT[0].embed.title), 'staff are told it needs attention');
  }

  reset();
  {
    // Even without needs_attention, a marker is not a product. The bridge sent
    // the buyer a code block reading OUT_OF_STOCK.
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '603', discord_id: '111111111111111111',
      goods: [{ product: 'Bundle', items: ['REAL-KEY-1', 'OUT_OF_STOCK'] }],
    });
    const dm = JSON.stringify(DMS[0].embed);
    ok(r.body.dm === true && /REAL-KEY-1/.test(dm), 'the real key is DM\'d');
    ok(!/OUT_OF_STOCK/.test(dm), 'the failure marker is not shown to the buyer');
    ok(/⚠️ OUT_OF_STOCK/.test(SENT[0].embed.description), 'but staff still see the marker');
  }

  reset();
  {
    // Only markers: nothing real to hand over, so there is nothing to DM.
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '604', discord_id: '111111111111111111',
      goods: [{ product: 'Thing', items: ['PRODUCT_NOT_FOUND'] }],
    });
    ok(r.body.dm === false && DMS.length === 0, 'an all-markers order sends no DM');
    ok(SENT.length === 1, 'and staff are still notified');
  }

  reset();
  {
    // 300 keys × 20 chars blows past the 1024-char field cap. Discord rejects
    // the whole message, so unclipped meant the buyer received NOTHING.
    const many = Array.from({ length: 300 }, (_, i) => `KEY-${String(i).padStart(15, '0')}`);
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '605', discord_id: '111111111111111111',
      goods: [{ product: 'Bulk', items: many }],
    });
    ok(r.body.dm === true, 'a huge delivery still reaches the buyer');
    const f = DMS[0].embed.fields[0];
    ok(f.value.length <= 1024, 'the field is clipped under Discord\'s cap');
    ok(/\(\+\d+ chars\)/.test(f.value), 'and the clip is marked, never silent');
  }

  reset();
  DM_ERROR = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
  {
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '606', email: 'a@b.c', discord_id: '111111111111111111',
      goods: [{ product: 'Thing', items: ['KEY-X'] }],
    });
    ok(r.status === 200 && r.body.dm === false && r.body.dm_error === 'dms_closed',
      'a buyer with DMs closed is reported, not silently dropped');
    ok(/dms_closed/.test(field(SENT[0].embed, 'Buyer DM').value),
      'and staff can see the hand-off is pending');
  }

  reset();
  {
    const r = await post('/internal/deliver_goods', {
      secret: SECRET, order_id: '607', email: 'a@b.c',
      goods: [{ product: 'Thing', items: ['KEY-X'] }],
    });
    ok(r.body.dm === false && SENT.length === 1, 'an order with no discord id skips the DM and still notifies staff');
  }

  console.log('\n── web_review ──');

  reset();
  {
    const r = await post('/internal/web_review', {
      secret: SECRET, guild_id: 'g1',
      review: { id: 12, rating: 5, body: 'great service', display_name: 'Sam' },
    });
    ok(r.status === 200 && r.body.posted === true, 'a website review posts as a vouch');
    ok(SENT[0].channelId === VOUCH_CH, 'to the vouches channel from guild_settings');
    ok(SENT[0].embed.title === 'New Vouch Received 🎉', 'the vouch embed format is preserved');
    ok(field(SENT[0].embed, 'Rating').value === '⭐⭐⭐⭐⭐', 'the rating renders as stars');
    ok(REACTIONS.join('') === '💯🔥', 'and the vouch reactions are preserved');
  }

  console.log('\n── ops_alert ──');

  reset();
  {
    const r = await post('/internal/ops_alert', {
      secret: SECRET, kind: 'topup_credit_lost', severity: 'error',
      message: 'Order 7 could not be credited', order_id: '7', context: { credit_cents: 2500 },
    });
    ok(r.status === 200 && r.body.posted === true, 'an alert reaches the channel');
    ok(SENT[0].embed.color === 0xED4245, 'error severity is red');
    ok(/topup_credit_lost/.test(SENT[0].embed.title), 'the kind is the title');
    ok(/credit_cents/.test(field(SENT[0].embed, 'Context').value), 'the context is included');
  }

  reset();
  LOG_CHANNEL_ROW = null;
  {
    // Nowhere to post is exactly when an alert must not vanish.
    const r = await post('/internal/ops_alert', { secret: SECRET, kind: 'delivery_failed', message: 'boom' });
    ok(r.status === 200 && r.body.dmed === true, 'with no channel, the alert falls back to the owner DM');
    ok(DMS.length === 1 && DMS[0].userId === '900000000000000001', 'and it goes to OWNER_DISCORD_ID');
  }

  reset();
  KNOWN_CHANNELS = new Set(); // configured id is stale/deleted
  {
    const r = await post('/internal/ops_alert', { secret: SECRET, kind: 'x', message: 'y' });
    ok(r.status === 200 && r.body.dmed === true,
      'a stale channel id degrades to the owner DM instead of throwing');
  }

  reset();
  {
    const huge = 'A'.repeat(9000);
    const r = await post('/internal/ops_alert', { secret: SECRET, kind: 'big', message: huge });
    ok(r.status === 200, 'an oversized alert still posts');
    ok(SENT[0].embed.description.length <= 4096, 'the description is clipped to Discord\'s limit');
    ok(/\(\+\d+ chars\)/.test(SENT[0].embed.description), 'and the clip is marked');
  }

  console.log('\n── unknown events ──');

  reset();
  {
    const r = await post('/internal/some_future_event', { secret: SECRET, whatever: 1 });
    ok(r.status === 200 && r.body.handled === false,
      'an unknown event answers 200 so it is not mistaken for an outage');
  }
  {
    const r = await post('/internal/some_future_event', { whatever: 1 });
    ok(r.status === 401, 'but an unknown event still requires the secret');
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();

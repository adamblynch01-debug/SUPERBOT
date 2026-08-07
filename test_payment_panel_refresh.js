// The #payment-methods panel keeps itself true.
//
// It lists the methods the store accepts, straight out of cfg.payment_methods.
// So the moment somebody closes Cash App, that posted message is wrong in the
// worst possible direction — "send your money here" is an instruction, and
// buyers follow instructions. It used to stay wrong until an admin remembered
// to re-run a command, which is the least likely moment for anyone to remember
// a chore.
//
// Driven against a fake Discord client and a stubbed backend, because what is
// worth pinning here is not how an embed renders — that is covered next door —
// but WHEN this thing writes and, more importantly, when it refuses to.
//
//   node test_payment_panel_refresh.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;

// Serialised, not merely awaited. Every check here drives one shared fake world
// — the edit log, the stubbed backend, the injected fetch error — so letting
// two run at once means each is asserting against the other's leftovers. The
// first draft of this file collected promises and awaited them together, and
// six checks failed for that reason alone rather than for anything wrong in the
// code under test.
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) {
      failed++; console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1;
    }
  });
}
function section(title) { chain = chain.then(() => console.log('\n' + title)); }

process.env.API_SECRET = 'test-secret';
process.env.BACKEND_URL = 'http://backend.test';

// ── the backend, as an object ────────────────────────────────────────────────
const backend = {
  config: {
    store_name: 'UH Services',
    payment_methods: { cashapp: true, paypal: true, btc: true, ltc: true },
    cashapp_cashtag: '$uhservices', paypal_email: 'shop@uhservices.xyz',
    cashapp_fee: 5, paypal_fee: 5, crypto_fee: 0,
    expiry_minutes: { cash: 60, crypto: 180 },
  },
  panels: {},
  configFails: false,
};
const posted = [];   // every write to /api/status/panel, so a test can assert a forget

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    async get(url, opts) {
      if (/\/api\/config$/.test(url)) {
        if (backend.configFails) throw new Error('ECONNREFUSED');
        return { data: JSON.parse(JSON.stringify(backend.config)) };
      }
      if (/\/api\/status\/panel$/.test(url)) return { data: { panels: backend.panels } };
      throw new Error('unexpected GET ' + url);
    },
    async post(url, body) {
      if (/\/api\/status\/panel$/.test(url)) {
        posted.push(body);
        if (!body.channel_id) delete backend.panels[body.kind];
        else backend.panels[body.kind] = { channel_id: body.channel_id, message_ids: body.message_ids };
        return { data: { ok: true } };
      }
      throw new Error('unexpected POST ' + url);
    },
  },
};

const SP = require('./modules/storefrontPanels');

// ── Discord, as an object ────────────────────────────────────────────────────
let edits = [];
let fetchMessageErr = null;

function makeMessage(id) {
  return { id, async edit(payload) { edits.push({ id, payload }); } };
}
function makeWorld() {
  edits = []; posted.length = 0; fetchMessageErr = null;
  const message = makeMessage('msg-1');
  const guild = {
    id: 'g1', name: 'UH', iconURL: () => null,
    client: { user: { id: 'bot' } },
  };
  const channel = {
    id: 'c1', guild,
    isTextBased: () => true,
    messages: {
      async fetch(arg) {
        if (fetchMessageErr) throw fetchMessageErr;
        if (typeof arg === 'object') return { find: () => null };
        return message;
      },
    },
  };
  const client = {
    guilds: { cache: new Map([['g1', guild]]), fetch: async (id) => (id === 'g1' ? guild : null) },
    channels: { fetch: async (id) => (id === 'c1' ? channel : null) },
    user: { id: 'bot' },
  };
  backend.panels = { 'paypanel:g1': { channel_id: 'c1', message_ids: ['msg-1'] } };
  backend.configFails = false;
  // Reset to all-open too. Without this a test that "changes" a method to the
  // value a previous test already left it at asserts nothing — which is exactly
  // how the unforced-write check below first passed for the wrong reason.
  backend.config.payment_methods = { cashapp: true, paypal: true, btc: true, ltc: true };
  return { client, message, channel, guild };
}

const descOf = (e) => {
  const j = e.payload.embeds[0].toJSON();
  return (j.fields || []).map(f => f.name).join(' | ');
};

console.log('\nit repaints the panel when the accepted methods change');

check('a forced pass edits the posted message in place', async () => {
  const { client } = makeWorld();
  await SP.refreshPaymentPanels(client, { force: true });
  assert.strictEqual(edits.length, 1, 'the panel was not edited');
  assert.strictEqual(edits[0].id, 'msg-1', 'it edited the wrong message');
});

check('the repaint lists only the methods still open', async () => {
  const { client } = makeWorld();
  backend.config.payment_methods = { cashapp: false, paypal: false, btc: true, ltc: true };
  await SP.refreshPaymentPanels(client, { force: true });
  const names = descOf(edits[0]);
  assert.ok(/Bitcoin/.test(names) && /Litecoin/.test(names), 'crypto vanished: ' + names);
  assert.ok(!/Cash App/.test(names), 'a closed method is still on the panel: ' + names);
  assert.ok(!/PayPal/.test(names), 'a closed method is still on the panel: ' + names);
});

// The address is the part that actually costs money if it is stale.
check('a closed method takes its address off the public panel', async () => {
  const { client } = makeWorld();
  backend.config.payment_methods = { cashapp: false, paypal: true, btc: true, ltc: true };
  await SP.refreshPaymentPanels(client, { force: true });
  const body = JSON.stringify(edits[0].payload.embeds[0].toJSON());
  assert.ok(!/uhservices\b(?!\.xyz)/.test(body.replace(/shop@uhservices\.xyz/g, '')),
    'the cashtag of a switched-off method is still printed');
});

check('the language dropdown survives the edit', async () => {
  const { client } = makeWorld();
  await SP.refreshPaymentPanels(client, { force: true });
  const rows = edits[0].payload.components || [];
  assert.ok(rows.length >= 2, 'the edit dropped a component row');
  const json = JSON.stringify(rows.map(r => r.toJSON ? r.toJSON() : r));
  assert.ok(/string_select|"type":3/.test(json), 'the translate dropdown was stripped by the refresh');
});

console.log('\nand stays its hand when it should');

// The trap the status panel already fell into: the embed carries a timestamp
// that moves on every build, so a signature taken from the RENDERED panel makes
// every tick look like a change and edits the message forever.
check('an unchanged config does not rewrite the message', async () => {
  const { client } = makeWorld();
  await SP.refreshPaymentPanels(client, { force: true });
  assert.strictEqual(edits.length, 1);
  await SP.refreshPaymentPanels(client, {});
  await SP.refreshPaymentPanels(client, {});
  assert.strictEqual(edits.length, 1, 'it repaints on every tick — the signature is unstable');
});

check('an unforced pass DOES write once a method moves', async () => {
  const { client } = makeWorld();
  await SP.refreshPaymentPanels(client, { force: true });
  backend.config.payment_methods = { cashapp: false, paypal: true, btc: true, ltc: true };
  await SP.refreshPaymentPanels(client, {});
  assert.strictEqual(edits.length, 2, 'a real change was skipped as unchanged');
});

// A blip on /api/config is not "the store accepts nothing". Repainting an empty
// method list over a hiccup would invent an outage in a public channel.
check('a backend that does not answer leaves the panel alone', async () => {
  const { client } = makeWorld();
  backend.configFails = true;
  await SP.refreshPaymentPanels(client, { force: true });
  assert.strictEqual(edits.length, 0, 'it repainted from a failed read');
});

check('no stored panel means nothing to do, not a crash', async () => {
  const { client } = makeWorld();
  backend.panels = {};
  await SP.refreshPaymentPanels(client, { force: true });
  assert.strictEqual(edits.length, 0);
});

// Without this it fails on a timer forever, every five minutes, for good.
check('a deleted panel is forgotten rather than retried forever', async () => {
  const { client } = makeWorld();
  const err = new Error('Unknown Message'); err.code = 10008;
  fetchMessageErr = err;
  await SP.refreshPaymentPanels(client, { force: true });
  const forget = posted.find(p => p.kind === 'paypanel:g1' && !p.channel_id);
  assert.ok(forget, 'the dead reference was kept');
  assert.strictEqual(backend.panels['paypanel:g1'], undefined);
});

console.log('\nthe wiring that makes a toggle reach the channel');

const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

check('a toggle forces a refresh immediately', () => {
  const P = require('./modules/paymentSwitches');
  let called = 0;
  P.setPanelRefresher(async () => { called++; });
  assert.ok(/setPanelRefresher\(\(\) => refreshPaymentPanels\(client, \{ force: true/.test(idx),
    'index.js never hands paymentSwitches a refresher, so a toggle changes nothing in the channel');
});

check('a timer covers the toggles made from the WEBSITE admin panel', () => {
  // Those never touch Discord, so the forced pass above cannot see them.
  assert.ok(/setInterval\(\(\) => \{\s*refreshPaymentPanels\(client/.test(idx),
    'nothing polls, so a method closed from the website leaves the panel stale forever');
});

check('the first pass after a restart is forced', () => {
  // No remembered signature exists after a boot, and the state may have moved
  // while the bot was down.
  assert.ok(/refreshPaymentPanels\(client, \{ force: true, \.\.\.payPanelOpts \}\)/.test(idx));
});

check('the refresher is given the channel resolver, so it can adopt an old panel', () => {
  assert.ok(/findChannel: findChannelByName/.test(idx),
    'a panel posted before this shipped would never be picked up');
});

console.log('\nthe footer no longer sends anyone to the wrong command');

const S = require('./modules/paymentSwitches');
const states = {
  cashapp: { available: true,  state: 'on',           reason: null },
  paypal:  { available: false, state: 'off',          reason: 'Switched off by staff' },
  btc:     { available: false, state: 'unconfigured', reason: 'BTC_XPUB is not set' },
  ltc:     { available: true,  state: 'on',           reason: null },
};

// This is the check that was wrong before. It asserted the named command
// EXISTED — it did — rather than that it did the job. /post-payment-method
// posts the free-text document from /set-payment-method and has nothing to do
// with the live availability panel, so following the footer fixed nothing.
check('it never names /post-payment-method, which posts a different thing', () => {
  assert.ok(!/post-payment-method/.test(S.buildEmbed(states).toJSON().footer.text));
});
check('it says the panel looks after itself', () => {
  assert.match(S.buildEmbed(states).toJSON().footer.text, /updates itself|nothing to re-run/i);
});
// The one case still worth shouting about survives.
check('every method closed still overrides the footer with the alarm', () => {
  const dead = Object.fromEntries(Object.keys(states).map(k =>
    [k, { available: false, state: 'off', reason: 'Switched off by staff' }]));
  assert.match(S.buildEmbed(dead).toJSON().footer.text, /NOTHING IS BEING ACCEPTED/);
});

chain.then(() => console.log(`\n${passed} passed, ${failed} failed\n`));

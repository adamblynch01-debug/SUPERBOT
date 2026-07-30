// ─── test_sms_gate.js ────────────────────────────────────────────────────────
// The SMS gen gate stands between a Discord button and REAL provider credit.
// Every "we couldn't tell" answer here has to mean no, and the day's allowance
// has to be reserved before the buy (or two fast clicks both spend) yet handed
// back when the buy fails (or an outage costs the member their number).
//
//   node test_sms_gate.js
'use strict';

const sms = require('./modules/sms-gen');
const { checkSmsAccess, releaseSmsQuota, SMS_COOLDOWN_HOURS, SMS_QUOTA_KEY } = sms._internals;

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

const HOUR = 60 * 60 * 1000;

// A fake gate whose behaviour each test dictates, plus a call log so we can
// assert on what it was ASKED to do, not just what it answered.
function makeGate(opts = {}) {
  const calls = { set: [], clear: [], get: [] };
  return {
    calls,
    canAccess:     async () => { if (opts.throws) throw new Error('db down'); return opts.allowed !== false; },
    hasUnlimited:  async () => !!opts.unlimited,
    getCooldown:   async (g, u, t) => { calls.get.push([g, u, t]); return opts.lastClaim || null; },
    setCooldown:   async (g, u, t) => { calls.set.push([g, u, t]); },
    clearCooldown: async (g, u, t) => { calls.clear.push([g, u, t]); },
  };
}
const interaction = { guild: { id: 'G1' }, member: {}, user: { id: 'U1' } };

// Wrapped in a function: this file is CommonJS, and a top-level await would
// make Node reparse it as an ES module and choke on the require above.
async function main() {
  section('fails closed');
  sms.setAccessGate(null);
  ok('no gate installed → refused', !!(await checkSmsAccess(interaction)));

  sms.setAccessGate(makeGate());
  ok('a DM (no guild) → refused', !!(await checkSmsAccess({ user: { id: 'U1' } })));
  ok('a member-less interaction → refused', !!(await checkSmsAccess({ guild: { id: 'G1' }, user: { id: 'U1' } })));

  sms.setAccessGate(makeGate({ throws: true }));
  ok('a THROWING gate → refused, not allowed', !!(await checkSmsAccess(interaction)));

  section('role check');
  sms.setAccessGate(makeGate({ allowed: false }));
  const noRole = await checkSmsAccess(interaction);
  ok('without the role → refused', !!noRole);
  ok('and the message names the role', /Gen Member/.test(noRole.content));
  ok('the refusal is ephemeral', noRole.flags === 64);

  sms.setAccessGate(makeGate({ allowed: true }));
  ok('with the role and no prior claim → allowed', (await checkSmsAccess(interaction)) === null);

  section('one per day');
  let gate = makeGate({ allowed: true, lastClaim: new Date(Date.now() - 1 * HOUR) });
  sms.setAccessGate(gate);
  const tooSoon = await checkSmsAccess(interaction);
  ok('a claim 1h ago → refused', !!tooSoon);
  ok('and it says when they can retry', /<t:\d+:R>/.test(tooSoon.content));
  ok('a refused check does NOT burn the allowance', gate.calls.set.length === 0);

  gate = makeGate({ allowed: true, lastClaim: new Date(Date.now() - (SMS_COOLDOWN_HOURS + 1) * HOUR) });
  sms.setAccessGate(gate);
  ok(`a claim ${SMS_COOLDOWN_HOURS + 1}h ago → allowed again`, (await checkSmsAccess(interaction)) === null);

  section('staff are unlimited');
  gate = makeGate({ allowed: true, unlimited: true, lastClaim: new Date() });
  sms.setAccessGate(gate);
  ok('a claim seconds ago still passes', (await checkSmsAccess(interaction)) === null);
  ok('and staff are not even looked up', gate.calls.get.length === 0);
  ok('nor stamped, even with consume',
    (await checkSmsAccess(interaction, { consume: true })) === null && gate.calls.set.length === 0);

  section('the allowance is reserved, then released');
  gate = makeGate({ allowed: true });
  sms.setAccessGate(gate);
  ok('a plain check does not stamp',
    (await checkSmsAccess(interaction)) === null && gate.calls.set.length === 0);
  ok('consume:true stamps exactly once',
    (await checkSmsAccess(interaction, { consume: true })) === null && gate.calls.set.length === 1);
  ok('and stamps under the SMS key, not a stock type', gate.calls.set[0][2] === SMS_QUOTA_KEY);
  ok('and against the right guild + user', gate.calls.set[0][0] === 'G1' && gate.calls.set[0][1] === 'U1');

  await releaseSmsQuota(interaction);
  ok('a failed purchase releases it', gate.calls.clear.length === 1);
  ok('releasing the same key it reserved', gate.calls.clear[0][2] === SMS_QUOTA_KEY);

  const badGate = makeGate({ allowed: true });
  badGate.clearCooldown = async () => { throw new Error('db down'); };
  sms.setAccessGate(badGate);
  let threw = false;
  try { await releaseSmsQuota(interaction); } catch { threw = true; }
  ok('a failing release does not throw over the error being reported', threw === false);
}

main().then(() => {
  sms.setAccessGate(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

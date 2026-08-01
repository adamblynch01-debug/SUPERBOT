// A website ticket has to end up in the same channel a Discord ticket of the
// same type would, and the buttons on it have to survive the customId round
// trip. Both are silent failures otherwise: the wrong channel looks like the
// bridge works, and a mangled id opens a modal against the wrong ticket.
'use strict';

process.env.TICKET_LOG_CHANNEL = '111111111111111111';
process.env.STAFF_ROLE_ID      = '222222222222222222';

const { routeFor, RANK_BOOST_LOG_CHANNEL } = require('./modules/support');
const { normalizeCategory, ticketEmbed } = require('./modules/webTickets');

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name); process.exitCode = 1; }
}

console.log('\nweb ticket → discord bridge');

// ── The website's free-text category has to land on a real ticket type ────
// The <select> on the site does not use the bot's exact wording, so an
// unmapped value would route to the general channel and look like a router
// bug rather than a vocabulary mismatch.
check('hwid maps to the HWID Reset type', normalizeCategory('hwid') === 'HWID Reset');
check('hwid_reset spelling variants map too', normalizeCategory('HWID-Reset') === 'HWID Reset');
check('billing maps to Purchase', normalizeCategory('billing') === 'Purchase');
check('rank boost maps to Rank Boosting', normalizeCategory('Rank Boost') === 'Rank Boosting');
check('an empty category becomes Support', normalizeCategory('') === 'Support');
check('an empty category is not undefined', normalizeCategory(null) === 'Support');
// An unknown value is passed through untouched so routeFor's own default
// applies — silently rewriting it to 'Support' would hide a new category.
check('an unknown category passes through', normalizeCategory('Chargeback') === 'Chargeback');

// ── …and then route exactly like a Discord ticket of that type ───────────
check('a web HWID ticket logs to the general channel',
  routeFor(normalizeCategory('hwid')).channel === process.env.TICKET_LOG_CHANNEL);
check('a web rank-boost ticket logs to the booster channel',
  routeFor(normalizeCategory('rank boosting')).channel === RANK_BOOST_LOG_CHANNEL);
check('a web rank-boost ticket does NOT hit the general channel',
  routeFor(normalizeCategory('boosting')).channel !== process.env.TICKET_LOG_CHANNEL);
check('a plain support ticket logs to the general channel',
  routeFor(normalizeCategory('Support')).channel === process.env.TICKET_LOG_CHANNEL);
check('an unknown category still gets a channel',
  !!routeFor(normalizeCategory('Chargeback')).channel);

// ── customId round trip ──────────────────────────────────────────────────
// The button handler does id.split('_') and takes [1] and [2]. A ticket id is
// a bigint from Postgres, so it is digits only — but assert it anyway, because
// an id containing '_' would truncate and reply to the wrong ticket.
console.log('\nbutton customIds');
for (const [id, action, target] of [
  ['webticket_reply_42', 'reply', '42'],
  ['webticket_close_9007199254740993', 'close', '9007199254740993'],
  ['webticket_view_1', 'view', '1'],
  ['webhwid_approve_7', 'approve', '7'],
  ['webhwid_deny_7', 'deny', '7'],
]) {
  const [, a, t] = id.split('_');
  check(`${id} → ${action}/${target}`, a === action && t === target);
  check(`${id} is within Discord's 100-char customId limit`, id.length <= 100);
}

// The reply modal uses a different prefix and is parsed by slice(), not split,
// precisely so 'replymodal' cannot be confused with 'reply'.
const modalId = 'webticket_replymodal_42';
check('the reply modal id is not mistaken for a reply BUTTON',
  modalId.split('_')[1] === 'replymodal');
check('the modal id yields the ticket id',
  modalId.slice('webticket_replymodal_'.length) === '42');

// ── The embed must survive hostile input ─────────────────────────────────
// One field over Discord's cap rejects the WHOLE message, so a customer who
// pastes a crash log would silently stop the ticket from ever being posted.
console.log('\nembed limits');
const huge = 'x'.repeat(9000);
const e = ticketEmbed({
  ticket_id: '42', username: huge, email: huge, category: huge,
  priority: 'urgent', subject: huge, body: huge,
  hwid: { request_id: '7', product: huge, license_key: huge },
}).toJSON();
check('description is clipped to 4096', e.description.length <= 4096);
check('every field value is clipped to 1024', e.fields.every(f => f.value.length <= 1024));
check('every field name is within 256', e.fields.every(f => f.name.length <= 256));
check('title survives', /Website Ticket #42/.test(e.title));
check('a clipped body says so rather than truncating silently', /\+\d+ chars/.test(e.description));

// The HWID block only exists on the HWID path — a plain ticket must not show
// an empty key field.
const plain = ticketEmbed({ ticket_id: '1', username: 'bob', category: 'Support', body: 'hi' }).toJSON();
check('a plain ticket has no HWID block', !plain.fields.some(f => /HWID Reset/.test(f.name)));
check('a HWID ticket has one', e.fields.some(f => /HWID Reset/.test(f.name)));
check('a ticket with no email omits the field rather than showing blank',
  !plain.fields.some(f => f.name === 'Email'));

// Priority drives the colour; an unknown one must not produce an invalid embed.
check('an unknown priority still yields a colour',
  Number.isInteger(ticketEmbed({ ticket_id: '1', priority: 'whatever' }).toJSON().color));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

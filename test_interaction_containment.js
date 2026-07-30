// Proves the interactionCreate fix: a rejecting async call that a branch
// `return`s must reach the enclosing catch, not escape as an unhandled
// rejection. Models the before/after shape exactly.
'use strict';
const assert = require('assert');

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name); process.exitCode = 1; }
}

async function rejects() { throw new Error('Unknown interaction'); }

// BEFORE: bare `return p` inside the try — the rejection becomes the handler's
// own rejection and the catch never runs.
async function oldShape() {
  let caught = false;
  try {
    if (true) return rejects();   // eslint-disable-line no-constant-condition
  } catch (e) { caught = true; }
  return caught;
}

// AFTER: body in an awaited IIFE — a `return` still exits the branch, but the
// rejection now propagates into the try.
async function newShape() {
  let caught = false;
  try {
    await (async () => {
      if (true) return rejects();  // eslint-disable-line no-constant-condition
    })();
  } catch (e) { caught = true; }
  return caught;
}

(async () => {
  console.log('\ninteractionCreate rejection containment');

  // The old shape leaks: the returned promise rejects outside the try.
  let leaked = false;
  const p = oldShape();
  const caughtOld = await p.catch(() => { leaked = true; return 'rejected-outside'; });
  check('old shape did NOT catch the rejection (this was the bug)',
    leaked === true || caughtOld === false);

  const caughtNew = await newShape();
  check('new shape routes the rejection into the catch', caughtNew === true);

  // A plain early return must still work — the wrap must not change control flow.
  const flow = await (async () => {
    const seen = [];
    await (async () => { seen.push('a'); if (true) return; seen.push('b'); })();  // eslint-disable-line no-constant-condition
    seen.push('after');
    return seen.join(',');
  })();
  check('early return inside the IIFE still ends only that branch', flow === 'a,after');

  // And a value returned by a branch is discarded either way (the handler
  // ignores return values), so nothing downstream changes.
  const val = await (async () => { return await (async () => 42)(); })();
  check('awaited value still resolves normally', val === 42);

  console.log(`\n${passed} passed, ${failed} failed\n`);
})();

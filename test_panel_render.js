// ─── Panel render test ───────────────────────────────────────────────────────
// The panel's client-side JavaScript lives inside a server-side template
// literal. `node -c modules/panel.js` therefore proves nothing about it: a
// stray backtick, an unescaped ${, or a broken regex is perfectly valid inside
// a string and only shows up as a page that renders blank in the browser.
//
// This renders all three page states, pulls the inline <script> bodies out, and
// compiles each one. It also asserts the two properties the rewrite exists to
// guarantee — that the CSRF token reaches the page, and that no untrusted value
// is concatenated into HTML without esc().
//
//   node test_panel_render.js
'use strict';

const vm = require('vm');
const assert = require('assert');
const { renderPanelPage } = require('./modules/panel');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

function scriptsOf(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const SESSION = {
  sessionId: 'hash', discordUserId: '123', username: 'tester', avatar: null,
  csrf: 'csrf-token-value',
  manageableGuilds: [{ id: '999', name: 'Test Guild', icon: null }],
  installableGuilds: [{ id: '888', name: 'Other Guild', icon: null }],
};

console.log('\nPANEL RENDER');

const pages = {
  'logged out': renderPanelPage(null, undefined),
  'server picker': renderPanelPage(SESSION, undefined),
  'dashboard': renderPanelPage(SESSION, '999'),
};

for (const [name, html] of Object.entries(pages)) {
  check(`${name} — renders`, () => {
    assert(html.startsWith('<!DOCTYPE html>'), 'not an HTML document');
    assert(html.includes('</html>'), 'document is truncated');
  });
  check(`${name} — inline script compiles`, () => {
    const scripts = scriptsOf(html);
    // The picker is deliberately static — it has no client JS at all, which is
    // a property worth keeping rather than a missing file.
    if (name === 'server picker') { assert(scripts.length === 0, 'the picker grew client JS'); return; }
    assert(scripts.length > 0, 'no inline <script> found');
    // Wrapped in an async IIFE: the panel's client code uses top-level `await`
    // inside functions and `return` inside the hash router.
    for (const s of scripts) new vm.Script(`(async function(){ ${s} \n})`);
  });
}

console.log('\nSECURITY');

check('dashboard embeds the session CSRF token', () => {
  assert(pages.dashboard.includes('csrf-token-value'), 'CSRF token missing from the page');
  assert(pages.dashboard.includes("X-Panel-CSRF"), 'client never sends the CSRF header');
});

check('an XSS-shaped guild name is escaped, not rendered', () => {
  const evil = { ...SESSION, username: '<img src=x onerror=alert(1)>', manageableGuilds: [{ id: '999', name: '</b><script>alert(1)</script>', icon: null }] };
  const picker = renderPanelPage(evil, undefined);
  assert(!picker.includes('<img src=x onerror'), 'username rendered raw');
  assert(!picker.includes('<script>alert(1)</script>'), 'guild name rendered raw');
  assert(picker.includes('&lt;img src=x onerror'), 'username was not escaped at all');
  const dash = renderPanelPage(evil, '999');
  assert(!dash.includes('<img src=x onerror'), 'username rendered raw on the dashboard');
});

check('a guild id not in the session falls back to the picker', () => {
  const html = renderPanelPage(SESSION, '000000');
  assert(html.includes('ls servers/'), 'an unknown guild id did not fall back to the picker');
  assert(!html.includes('genkey'), 'an unknown guild id rendered the dashboard anyway');
});

check('every value concatenated into HTML goes through esc()', () => {
  const script = scriptsOf(pages.dashboard).join('\n');
  // The specific bug this replaces: `'...' + l.label + '...'` straight into
  // innerHTML. Scoped to lines that actually build markup — the same
  // concatenation inside a toast() is safe, because toast writes textContent.
  const offenders = [];
  script.split('\n').forEach((line, i) => {
    if (!/'</.test(line) && !/>'/.test(line)) return;
    const bare = line.match(/\+\s*[a-z]\.[a-z_]+\s*\+/gi) || [];
    for (const b of bare) offenders.push(`line ${i + 1}: ${b.trim()}`);
  });
  assert(!offenders.length, `unescaped interpolation into HTML:\n       ${offenders.join('\n       ')}`);
});

check('lazy tab loading — nothing loads eight tabs up front', () => {
  const script = scriptsOf(pages.dashboard).join('\n');
  assert(script.includes('if (loaded[name] && !force) return;'), 'tab loads are not memoised');
});

console.log(failures ? `\n${failures} FAILED\n` : '\nAll panel render checks passed.\n');
process.exit(failures ? 1 : 0);

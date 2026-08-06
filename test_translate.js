// Round 29 item 1 — the language dropdown under every post.
//
// What is actually worth pinning here is not "does it translate" — that is the
// provider's job and it is stubbed. It is everything AROUND the translation,
// because every one of these was a way to ship a feature that looks like it
// works and quietly breaks the post it is attached to:
//
//   • /getrole must come back as /getrole. A translated command name is an
//     instruction that fails, and the customer opens the ticket the post exists
//     to prevent.
//   • a license key inside ``` must come back byte for byte.
//   • if ANY protected token goes missing, the whole translation is discarded.
//     Half a Terms of Service is worse than none of it.
//   • the cache is keyed on the SOURCE, so editing a document with /set-tos
//     cannot serve the previous version's translation forever.
//   • the dropdown answers ephemerally — it sits on a message the whole server
//     reads, and editing it in place would rewrite the post for everyone.
//
//   node test_translate.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.GUILD_ID = 'test-guild';
delete process.env.DEEPL_API_KEY;
delete process.env.GOOGLE_TRANSLATE_API_KEY;

// ─── stub the DB (an in-memory stand-in for both cache tables) ───
const store = { translations: new Map(), locales: new Map() };
const dbPath = require.resolve('./db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {},
    ensureGuild: async () => {},
    query: async (text, params) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      const p = params || [];
      if (/SELECT translated FROM translations/.test(t)) {
        const v = store.translations.get(`${p[0]}:${p[1]}`);
        return { rows: v === undefined ? [] : [{ translated: v }] };
      }
      if (/INSERT INTO translations/.test(t)) {
        store.translations.set(`${p[0]}:${p[1]}`, p[3]);
        return { rows: [] };
      }
      // Matched on the TABLE, not on the select list. Pinning the list is what
      // broke this stub the moment the read grew a guild_id column and a
      // fallback scope: the regex stopped matching, every lookup fell through
      // to `{ rows: [] }`, and three tests failed reading "a saved choice is
      // not remembered" — which is a real bug's symptom, produced by a stale
      // stub. It answers the scopes the query actually asks for instead.
      if (/FROM user_locales/.test(t)) {
        const [scope, userId, alt] = p;
        const scopes = alt === undefined ? [scope] : [scope, alt];
        const rows = [];
        for (const g of scopes) {
          const v = store.locales.get(`${g}:${userId}`);
          if (v !== undefined) rows.push({ guild_id: g, lang: v });
        }
        return { rows };
      }
      if (/INSERT INTO user_locales/.test(t)) {
        store.locales.set(`${p[0]}:${p[1]}`, p[2]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
};

// ─── stub axios ───
// The fake provider is deliberately HOSTILE in the ways a real one is: it
// uppercases words, reorders the sentence, and pads the mask brackets with
// spaces. A module that only survives a polite stub survives nothing.
let calls = [];
let mangleMasks = false;   // drop a mask, as a real translator sometimes does
let providerThrows = false;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    get: async (url) => {
      if (providerThrows) throw new Error('429 Too Many Requests');
      const q = new URL(url).searchParams;
      calls.push({ provider: 'free', lang: q.get('tl'), text: q.get('q') });
      let out = String(q.get('q'))
        .replace(/⟦(\d+)⟧/g, '⟦ $1 ⟧')   // spaced brackets
        .replace(/\b([a-z]{4,})\b/g, (m) => m.toUpperCase()); // "translated"
      if (mangleMasks) out = out.replace(/⟦ \d+ ⟧/, 'ELIMINADO');
      return { data: [[[out, q.get('q'), null, null]]] };
    },
    post: async (url, body) => {
      if (providerThrows) throw new Error('403 Forbidden');
      if (/deepl/.test(url)) {
        const p = new URLSearchParams(body);
        calls.push({ provider: 'deepl', lang: String(p.get('target_lang')).toLowerCase(), text: p.get('text') });
        return { data: { translations: [{ text: '[deepl] ' + p.get('text') }] } };
      }
      if (/translation\.googleapis\.com/.test(url)) {
        calls.push({ provider: 'google-cloud', lang: body.target, text: body.q });
        return { data: { data: { translations: [{ translatedText: '[cloud] ' + body.q }] } } };
      }
      return { data: {} };
    },
  },
};

const T = require('./modules/translate');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  console.log('\npost translation');

  // ── masking: the things that are keys, not sentences ───────────────────────
  await check('a bare /command is protected', async () => {
    const { masked, kept } = T.mask('Run /getrole to get your customer role.');
    assert.ok(!masked.includes('/getrole'), 'the command was sent to the translator');
    assert.ok(kept.includes('/getrole'));
    assert.strictEqual(T.unmask(masked, kept).text, 'Run /getrole to get your customer role.');
  });

  await check('a fenced block comes back byte for byte', async () => {
    const src = 'Here are your goods:\n```ABCD-1234-EFGH\nIJKL-5678-MNOP```\nEnjoy.';
    const out = await T.translateText(src, 'es');
    assert.ok(out.includes('ABCD-1234-EFGH'), 'a license key was mangled: ' + out);
    assert.ok(out.includes('IJKL-5678-MNOP'), 'a license key was mangled: ' + out);
    assert.ok(!/GOODS/.test(out) === false, 'nothing was translated at all — the stub did not run');
  });

  await check('mentions, emoji, links and prices survive', async () => {
    const src = 'Ask <@123456789> in <#987654321> or visit https://uhservices.xyz for $12.99 <:cool:555>';
    const out = await T.translateText(src, 'fr');
    for (const frag of ['<@123456789>', '<#987654321>', 'https://uhservices.xyz', '$12.99', '<:cool:555>']) {
      assert.ok(out.includes(frag), `${frag} did not survive: ${out}`);
    }
  });

  // ── the caller's own list: what is a name rather than a sentence ───────────
  //
  // The report: "user receives order in spanish?" — a delivery DM offering
  // "H8ED Privado Externo — Día". The keys inside the ``` fence were fine, so
  // the mask worked; the FIELD NAME was the product, and no pattern above can
  // tell a product name from prose. Only the caller knows, so only the caller
  // can say.
  await check('a product name the caller names is not translated', async () => {
    const name = '📦 Call of Duty: Warzone — H8ED Private External — Month';
    const out = await T.translateText(name, 'es', ['Call of Duty: Warzone — H8ED Private External — Month']);
    assert.ok(out.includes('H8ED Private External'), out);
    assert.ok(!/PRIVATE/.test(out), 'the stub translated it anyway: ' + out);
  });

  await check('naming it costs no call at all when it is the whole line', async () => {
    // Nothing but a masked token is left, so there is nothing to send. Worth
    // pinning: the delivery DM is the one path that must not get slower.
    calls = [];
    await T.translateText('H8ED Private External — Month', 'es', ['H8ED Private External — Month']);
    assert.strictEqual(calls.length, 0, JSON.stringify(calls));
  });

  await check('the prose around a protected name is still translated', async () => {
    // The point is not to switch translation off. A Spanish buyer should read
    // Spanish; they should just read it about the product they actually bought.
    const out = await T.translateText('Thank you for your purchase of Punisher Phone External.', 'es',
      ['Punisher Phone External']);
    assert.ok(out.includes('Punisher Phone External'), out);
    assert.ok(/PURCHASE|THANK/.test(out), 'the sentence was not translated: ' + out);
  });

  await check('a longer name is masked before a shorter one inside it', async () => {
    // 'Month' is also a tier label in its own right. Masking it first would
    // split the product name around it and leave the halves to be translated.
    const { kept } = T.mask('H8ED Private External — Month', ['Month', 'H8ED Private External — Month']);
    assert.ok(kept.includes('H8ED Private External — Month'), JSON.stringify(kept));
  });

  await check('a two-letter product name is ignored rather than shredding the text', async () => {
    const { masked } = T.mask('Go to the store and pick a plan.', ['Go']);
    assert.ok(masked.startsWith('Go to the store'), masked);
  });

  await check('null and empty entries in the list are survivable', async () => {
    // The caller passes data.tier_label straight through, and a one-off order
    // has no tier.
    const out = await T.translateText('Your order is ready.', 'es', [null, '', undefined, 'Warzone']);
    assert.ok(typeof out === 'string' && out.length > 0, String(out));
  });

  await check('a protected name is cached separately from the same text without one', async () => {
    // The hazard in the fix rather than in the bug: every delivery DM sent
    // before today is already in the translations table, translated product
    // name and all. Keyed on the source alone, the fix would serve exactly the
    // output it was written to stop.
    calls = [];
    const src = 'Your Ghost TV Elite order is ready.';
    await T.translateText(src, 'pt');
    await T.translateText(src, 'pt', ['Ghost TV Elite']);
    assert.strictEqual(calls.length, 2, "the second call was served from the first one's cache");
    // And the difference is the whole point: the first went out naked, the
    // second went out with the product name held back.
    assert.ok(calls[0].text.includes('Ghost TV Elite'), calls[0].text);
    assert.ok(!calls[1].text.includes('Ghost TV Elite'), calls[1].text);
  });

  await check('the words around them ARE translated', async () => {
    calls = [];
    const out = await T.translateText('Perform an HWID reset for your license.', 'de');
    assert.notStrictEqual(out, 'Perform an HWID reset for your license.');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].lang, 'de');
  });

  await check('a translator that eats a mask gets its whole answer thrown away', async () => {
    // The failure mode this exists for: a post that says "Run to get your
    // role", with the command silently gone. English is the safe answer.
    mangleMasks = true;
    const src = 'Run /resethwid once every 3 days, and read <#111> first.';
    const out = await T.translateText(src, 'it');
    mangleMasks = false;
    assert.strictEqual(out, src, 'a translation with a missing token was served anyway');
  });

  await check('a provider that fails leaves the post in English', async () => {
    providerThrows = true;
    const src = 'The store is open for business today.';
    const out = await T.translateText(src, 'pl');
    providerThrows = false;
    assert.strictEqual(out, src);
  });

  // ── cache ──────────────────────────────────────────────────────────────────
  await check('the same text is translated once, not once per reader', async () => {
    const src = 'Tickets requesting actions available through these commands will be closed.';
    calls = [];
    const a = await T.translateText(src, 'ru');
    const n = calls.length;
    assert.ok(n > 0, 'nothing was translated');
    const b = await T.translateText(src, 'ru');
    assert.strictEqual(b, a);
    assert.strictEqual(calls.length, n, 'the second reader paid for a second call');
  });

  await check('editing the document invalidates it by not matching', async () => {
    // Keyed on the hash of the source: /set-tos changes the text, the hash
    // changes with it, and there is no stale row anyone has to remember to
    // purge. This is the bug a cache keyed on the post id would have.
    const v1 = 'Refunds are not available.';
    const v2 = 'Refunds are not available on digital goods.';
    const a = await T.translateText(v1, 'es');
    const b = await T.translateText(v2, 'es');
    assert.notStrictEqual(a, b);
    assert.strictEqual(T.hashOf(v1) === T.hashOf(v2), false);
  });

  await check('a failed translation is not cached as if it were one', async () => {
    providerThrows = true;
    const src = 'This sentence never reached a translator.';
    await T.translateText(src, 'tr');
    providerThrows = false;
    calls = [];
    const out = await T.translateText(src, 'tr');
    assert.ok(calls.length > 0, 'the failure was cached — this post is stuck in English forever');
    assert.notStrictEqual(out, src);
  });

  await check('English asks nobody anything', async () => {
    calls = [];
    const src = 'Nothing to do here.';
    assert.strictEqual(await T.translateText(src, 'en'), src);
    assert.strictEqual(calls.length, 0, 'called a translation API to turn English into English');
  });

  await check('a divider with no words costs no call', async () => {
    calls = [];
    const out = await T.translateText('https://uhservices.xyz', 'fr');
    assert.strictEqual(out, 'https://uhservices.xyz');
    assert.strictEqual(calls.length, 0);
  });

  // ── locale handling ────────────────────────────────────────────────────────
  await check("Discord's regional locales resolve to a language", async () => {
    assert.strictEqual(T.normalizeLang('pt-BR'), 'pt');
    assert.strictEqual(T.normalizeLang('en-GB'), 'en');
    assert.strictEqual(T.normalizeLang('es-419'), 'es');
    assert.strictEqual(T.normalizeLang('sv-SE'), null, 'a language with no translation must not be faked');
    assert.strictEqual(T.normalizeLang(''), null);
    assert.strictEqual(T.normalizeLang(undefined), null);
  });

  await check('a choice is remembered, an unknown one is refused', async () => {
    assert.strictEqual(await T.setUserLang('g1', 'u1', 'pt-BR'), true);
    assert.strictEqual(await T.getUserLang('g1', 'u1'), 'pt');
    assert.strictEqual(await T.setUserLang('g1', 'u2', 'klingon'), false);
    assert.strictEqual(await T.getUserLang('g1', 'u2'), null);
  });

  // The bug the user reported as "users still receive their order in Spanish":
  // a language is a property of the PERSON, and the table was keyed by guild.
  // A choice made under a post in one server was invisible to the delivery DM
  // that looked it up by another — so the preference existed, applied
  // somewhere, and could not be reached from where it hurt.
  await check('a language chosen in one place is read in every other', async () => {
    assert.strictEqual(await T.setUserLang('g1', 'traveller', 'de'), true);
    assert.strictEqual(await T.getUserLang('g2', 'traveller'), 'de', 'another guild must see it');
    assert.strictEqual(await T.getUserLang('dm', 'traveller'), 'de', 'a DM must see it');
  });

  await check('the guild a choice was made in still wins where it was made', async () => {
    await T.setUserLang('g1', 'local', 'de');
    await T.setUserLang('g2', 'local', 'fr');
    assert.strictEqual(await T.getUserLang('g1', 'local'), 'de', 'the older scoped row stands');
    assert.strictEqual(await T.getUserLang('g3', 'local'), 'fr', 'elsewhere, the newest choice');
  });

  await check('someone who has never chosen gets their Discord client language', async () => {
    const stored = await T.preferredLang({ guildId: 'g1', user: { id: 'u1' }, locale: 'fr' });
    assert.strictEqual(stored, 'pt', 'a stored choice must beat the client locale');
    const fresh = await T.preferredLang({ guildId: 'g1', user: { id: 'u9' }, locale: 'fr-CA' });
    assert.strictEqual(fresh, 'fr');
    const unknown = await T.preferredLang({ guildId: 'g1', user: { id: 'u8' }, locale: 'sv-SE' });
    assert.strictEqual(unknown, 'en', 'an unsupported client locale must fall back, not blank out');
  });

  // ── the dropdown ───────────────────────────────────────────────────────────
  await check('the row is one select with every language and a flag', async () => {
    const row = T.languageRow().toJSON();
    const menu = row.components[0];
    assert.strictEqual(menu.custom_id, 'xlate_lang');
    assert.strictEqual(menu.options.length, T.LANGS.length);
    assert.ok(menu.options.length <= 25, 'Discord rejects a select with more than 25 options');
    for (const o of menu.options) {
      assert.ok(o.emoji, `${o.value} has no flag`);
      assert.ok(o.label && o.description, `${o.value} is missing a label or description`);
    }
    assert.deepStrictEqual(
      menu.options.map(o => o.value).sort(),
      T.LANGS.map(l => l.code).sort());
  });

  await check('the option list is the native name, with English underneath', async () => {
    // Straight off the reference screenshot: "Espanol / Spanish". Someone who
    // cannot read the post cannot read an English-only language list either.
    const menu = T.languageRow().toJSON().components[0];
    const es = menu.options.find(o => o.value === 'es');
    assert.strictEqual(es.label, 'Español');
    assert.strictEqual(es.description, 'Spanish');
  });

  // ── the handler ────────────────────────────────────────────────────────────
  function fakeInteraction(values, embeds, content) {
    const it = {
      values, guildId: 'g1', locale: 'en',
      user: { id: 'clicker' },
      message: { embeds: embeds || [], content: content || '' },
      replies: [], deferred: null,
      deferReply: async (o) => { it.deferred = o; },
      editReply: async (o) => { it.replies.push({ kind: 'edit', ...o }); },
      followUp: async (o) => { it.replies.push({ kind: 'followUp', ...o }); },
    };
    return it;
  }
  const chunkEmbedsIntoMessages = require('./modules/contentRender').chunkEmbedsIntoMessages;

  await check('the answer is ephemeral — the post is not rewritten for everyone', async () => {
    const it = fakeInteraction(['es'], [{ toJSON: () => ({ title: 'Server Commands', description: 'Run /getrole to obtain your role.' }) }]);
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    assert.strictEqual(it.deferred && it.deferred.flags, 64, 'a shared post would have been edited for every reader');
    for (const r of it.replies) {
      if (r.kind === 'followUp') assert.strictEqual(r.flags, 64, 'a follow-up leaked into the channel');
    }
  });

  await check('it translates the embeds of the message it was clicked from', async () => {
    const it = fakeInteraction(['de'], [{ toJSON: () => ({ title: 'Available Commands', description: 'Perform an HWID reset for your license.' }) }]);
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    const first = it.replies.find(r => r.kind === 'edit');
    assert.ok(first && first.embeds && first.embeds[0], 'nothing was replied');
    const d = first.embeds[0].toJSON();
    assert.notStrictEqual(d.description, 'Perform an HWID reset for your license.');
    assert.ok(d.title, 'the title was dropped');
  });

  await check('the click is remembered so the next post is one step shorter', async () => {
    const it = fakeInteraction(['it'], [{ toJSON: () => ({ description: 'Hello there.' }) }]);
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    assert.strictEqual(await T.getUserLang('g1', 'clicker'), 'it');
  });

  await check('a machine translation says so, on the translation itself', async () => {
    // Under a Terms of Service especially. Nobody should be held to a sentence
    // a machine wrote — so the disclaimer stays. What it must NOT be is a
    // second message: an ephemeral follow-up has no expiry, so one was left
    // sitting in the channel after every translation until the reader dismissed
    // it by hand. It goes on the reply that carries the embeds or nowhere.
    const it = fakeInteraction(['fr'], [{ toJSON: () => ({ description: 'All sales are final.' }) }]);
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    const note = it.replies.find(r => /Translated to/i.test(r.content || ''));
    assert.ok(note, 'no disclaimer was shown');
    assert.strictEqual(note.kind, 'edit', 'the disclaimer is a separate message again');
    assert.ok(note.embeds && note.embeds.length, 'the disclaimer is not on the translation');
    assert.strictEqual(it.replies.length, 1, `${it.replies.length} messages for a one-page translation`);
  });

  await check('choosing English shows the post back with no disclaimer', async () => {
    const it = fakeInteraction(['en'], [{ toJSON: () => ({ description: 'All sales are final.' }) }]);
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    assert.ok(!it.replies.some(r => /Translated to/i.test(r.content || '')));
    assert.strictEqual(it.replies.length, 1);
  });

  await check('a post with no embed says so instead of replying with nothing', async () => {
    const it = fakeInteraction(['es'], [], '');
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    const r = it.replies.find(x => x.kind === 'edit');
    assert.ok(r && /nothing/i.test(r.content || ''), 'a dead-looking dropdown');
  });

  await check('a plain-content post is translated too', async () => {
    const it = fakeInteraction(['es'], [], 'The store is closed for maintenance.');
    await T.handleLanguageSelect(it, { chunkEmbedsIntoMessages });
    const r = it.replies.find(x => x.kind === 'edit');
    assert.ok(r && r.content && r.content.length, 'nothing came back');
    assert.ok(!/closed for maintenance\.$/.test(r.content), 'it was not translated');
  });

  await check('an over-long translation is trimmed, not rejected by Discord', async () => {
    // Every language this offers is longer than English somewhere; German and
    // Russian routinely by a third. A 4096-char document translated is a
    // rejected message, which reads as "translation is broken".
    const long = 'Refunds are not available on digital goods. '.repeat(120);
    const e = await T.translateEmbed({ description: long, title: 'x'.repeat(300) }, 'de');
    const d = e.toJSON();
    assert.ok(d.description.length <= 4096, 'description over the embed limit');
    assert.ok(d.title.length <= 256, 'title over the embed limit');
  });

  // ── providers ──────────────────────────────────────────────────────────────
  await check('a DeepL key takes precedence over the keyless endpoint', async () => {
    process.env.DEEPL_API_KEY = 'key-123:fx';
    calls = [];
    await T.translateText('A brand new sentence for DeepL.', 'es');
    delete process.env.DEEPL_API_KEY;
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].provider, 'deepl', 'the paid provider was configured and ignored');
  });

  await check('a Google Cloud key is used when DeepL is absent', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'gt-key';
    calls = [];
    await T.translateText('Another brand new sentence entirely.', 'es');
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
    assert.strictEqual(calls[0].provider, 'google-cloud');
  });

  await check('with no key at all it still works', async () => {
    calls = [];
    await T.translateText('One more sentence with no key set.', 'es');
    assert.strictEqual(calls[0].provider, 'free', 'the feature would be dead until a key is bought');
  });

  // ── wiring, read out of the real source ────────────────────────────────────
  const src = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '');
  const indexSrc = strip(src('index.js'));

  await check('the select is routed before every other dropdown', async () => {
    const block = indexSrc.slice(indexSrc.indexOf('interaction.isStringSelectMenu()'));
    const mine = block.indexOf("'xlate_lang'");
    const other = block.indexOf("'gensteam_select_type'");
    assert.ok(mine > -1, 'the dropdown is never handled — every click would say "interaction failed"');
    assert.ok(other === -1 || mine < other, 'another handler could claim it first');
  });

  await check('the posts that carry the dropdown actually carry it', async () => {
    assert.ok(/function withLanguageRow/.test(indexSrc), 'no helper');
    // The four staff documents, the announcement, the status update and the
    // product update — every message a customer is expected to READ.
    const wired = (indexSrc.match(/withLanguageRow\(/g) || []).length;
    assert.ok(wired >= 5, `only ${wired} post sites carry the dropdown`);
  });

  await check('the panels a customer reads before pressing anything carry it too', async () => {
    // "THEY WORKING BUT YOU FORGOT /POSTGENSTEAM." The generator panel states
    // the role you need and the cooldown you get and is read by every member of
    // the server — the same audience as the documents that already had it. The
    // download panel and the useful-links post were missed with it.
    for (const [cmd, next] of [['postgensteam', 'clearstock'], ['postusefullinks', 'addusefullink']]) {
      const block = indexSrc.slice(indexSrc.indexOf(`cmd === '${cmd}'`), indexSrc.indexOf(`cmd === '${next}'`));
      assert.ok(/withLanguageRow\(/.test(block), `/${cmd} posts without the dropdown`);
    }
  });

  await check('a giveaway carries the dropdown from start to results', async () => {
    // "/GIVEAWAY DOESNT HAVE TRANSLATION." It pings @everyone, so it is read by
    // more people who do not read English than almost anything else the bot
    // writes — and it is three separate posts: the entry card, the [ENDED] edit
    // and the [RESULTS] announcement. Missing one leaves the winner unable to
    // read that they won.
    const block = indexSrc.slice(indexSrc.indexOf("cmd === 'giveaway'"), indexSrc.indexOf("cmd === 'endgiveaway'") + 1 || undefined);
    assert.ok(/targetCh\.send\(withLanguageRow\(\{ content: '@everyone'/.test(block),
      'the entry card posts without the dropdown');

    // Round 38 folded the three copies of the end-of-giveaway code (timer,
    // restart, reschedule) into one endGiveaway(). Both of its posts are
    // checked here rather than in the /giveaway block, which is where they
    // used to live.
    const ending = indexSrc.slice(indexSrc.indexOf('async function endGiveaway'),
      indexSrc.indexOf('async function clearOldGiveaway'));
    for (const [what, re] of [
      ['the ENDED edit', /gwMsg\.edit\(withLanguageRow\(/],
      ['the RESULTS post', /gwCh\.send\(withLanguageRow\(/],
    ]) assert.ok(re.test(ending), `${what} posts without the dropdown`);

    // Every edit REPLACES the component list, so each one has to send the row
    // again. The count button is the easy one to miss: the first person to
    // enter would take the translator away from everyone after them.
    const at = indexSrc.indexOf("customId === 'giveaway_enter'");
    assert.ok(at > 0, 'the enter handler moved — re-point this check');
    const enter = indexSrc.slice(at, indexSrc.indexOf("customId === 'leave_vouch'"));
    assert.ok(/interaction\.update\(withLanguageRow\(/.test(enter),
      'entering a giveaway strips the dropdown off it for everyone else');

    // The restart path used to be a third copy of the same code, and a third
    // place to forget the dropdown. It now calls endGiveaway like everything
    // else — which is what is pinned, because a re-inlined copy is exactly how
    // this regresses.
    const restart = indexSrc.slice(indexSrc.indexOf('client.once'), indexSrc.indexOf("cmd === 'giveaway'"));
    assert.ok(/endGiveaway\(msgId, 'restart'\)/.test(restart) && /endGiveaway\(msgId, 'rescheduled'\)/.test(restart),
      'the restart path ends a giveaway its own way again — it will drift');
    assert.strictEqual((ending.match(/withLanguageRow\(/g) || []).length, 2,
      'one of endGiveaway\'s two posts lost the dropdown');
  });

  await check('a post already using five action rows keeps its buttons', async () => {
    const fn = indexSrc.slice(indexSrc.indexOf('function withLanguageRow'));
    assert.ok(/components\.length >= 5/.test(fn),
      'a sixth row rejects the WHOLE message — the post would not send at all');
  });

  // The rule this pinned last round was the opposite one: translate the DM for
  // anyone with a stored preference. That was wrong twice — it reached for a
  // choice made in another server, and it broke the assumption the whole module
  // rests on, that a message this bot sends is English. On a pre-translated DM
  // the dropdown's own English option handed the Spanish straight back, which
  // is what "if i translate to english it translates to spanish" was.
  await check('the delivery DM goes out in English, with the dropdown to change it', async () => {
    for (const f of ['modules/internalEvents.js', 'modules/manualDelivery.js']) {
      const s = strip(src(f));
      assert.ok(!/translateEmbeds\(/.test(s), `${f} still pre-translates the buyer's DM`);
      assert.ok(!/getUserLang\(/.test(s), `${f} still picks a language on the buyer's behalf`);
      assert.ok(/languageRow\(/.test(s), `${f} sends a DM the buyer cannot translate`);
    }
  });

  await check('the dropdown is told which words in a delivery DM are catalogue keys', async () => {
    // Nothing in this module can tell "H8ED Private External" from a sentence,
    // and the translation now happens after the DM was sent — so the list has
    // to be recovered from the message. Without this the buyer is offered a
    // product that does not exist, which is the bug the protect list was added
    // for in the first place.
    assert.ok(/protectFor/.test(strip(src('modules/translate.js'))), 'the handler cannot be given one');
    assert.ok(/protectFromEmbed/.test(indexSrc), 'index.js never passes one');
    const D = require('./modules/deliveryEmbed');
    const { embed, protect } = D.buildDeliveryEmbed({
      items: [{ game: 'Rust', product: 'H8ED Private External', tier: 'Month', qty: 1, values: ['K-1'] }],
      invoiceNo: 'AAAA-BBBB',
    });
    const back = D.protectFromEmbed(embed.toJSON());
    for (const s of protect.filter(x => x !== 'AAAA-BBBB')) {
      assert.ok(back.includes(s), `${s} would be translated`);
    }
  });

  await check('the migration creates both tables with the keys the code uses', async () => {
    const sql = src('migrations/translations.sql');
    assert.ok(/CREATE TABLE IF NOT EXISTS translations/.test(sql));
    assert.ok(/PRIMARY KEY \(source_hash, target_lang\)/.test(sql),
      'the cache upsert is ON CONFLICT (source_hash, target_lang)');
    assert.ok(/CREATE TABLE IF NOT EXISTS user_locales/.test(sql));
    assert.ok(/PRIMARY KEY \(guild_id, user_id\)/.test(sql),
      'the locale upsert is ON CONFLICT (guild_id, user_id)');
  });

  await check('/language is open to customers, not gated to staff', async () => {
    const def = indexSrc.slice(indexSrc.indexOf("setName('language')"), indexSrc.indexOf("setName('listguilds')"));
    assert.ok(/addChoices/.test(def), 'no language choices');
    const handler = indexSrc.slice(indexSrc.indexOf("cmd === 'language'"));
    const end = handler.indexOf("cmd === 'listguilds'");
    assert.ok(!/hasAccess\(|isBotOwner\(/.test(handler.slice(0, end)),
      'the one command every non-English customer needs is staff-only');
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();

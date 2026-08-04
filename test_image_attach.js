// Round 30 — "upload a picture and I'll put it on that post", shared.
//
// What is worth pinning here is not "does it edit a message" — it is the
// handful of behaviours that make this safe to fire from four different
// commands, each of which has already told the user their post succeeded:
//
//   • the picture is RE-UPLOADED onto the post. Discord attachment URLs are
//     signed and expire, and the uploader's message is deleted seconds later,
//     so a linked image is a broken image by tomorrow.
//   • the post's components survive. `edit` overwrites only the fields it is
//     given, and the round-29 language dropdown lives in `components`.
//   • an embed that already has an image is never asked about.
//   • it NEVER throws. It runs after the post is live; an exception here must
//     not turn a posted announcement into "❌ An error occurred".
//   • the collector only accepts the person who ran the command.
//
//   node test_image_attach.js
'use strict';

const assert = require('assert');
const { offerImageUpload, isImage, embedHasImage } = require('./modules/imageAttach');
const { EmbedBuilder } = require('discord.js');

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

// ─── Fakes ───────────────────────────────────────────────────────────────────
function makeCollector() {
  const handlers = {};
  return {
    on(ev, fn) { handlers[ev] = fn; },
    async fire(ev, arg) { if (handlers[ev]) await handlers[ev](arg); },
    filter: null,
  };
}

function makeWorld({ embed, attachments } = {}) {
  const collector = makeCollector();
  const w = {
    edits: [],          // what the post was edited with
    followUps: [],      // ephemeral prompts sent
    webhookEdits: [],   // ephemeral prompts edited
    deleted: [],        // uploader messages deleted
    collector,
  };
  w.message = {
    id: '999',
    embeds: [{ image: { url: 'https://cdn.discordapp.com/final.png' } }],
    async edit(payload) { w.edits.push(payload); },
  };
  w.interaction = {
    user: { id: 'AUTHOR' },
    webhook: { async editMessage(id, payload) { w.webhookEdits.push({ id, ...payload }); } },
    async followUp(payload) { w.followUps.push(payload); return { id: 'PROMPT' }; },
    channel: {
      createMessageCollector(opts) { collector.filter = opts.filter; collector.opts = opts; return collector; },
    },
  };
  w.embed = embed || new EmbedBuilder().setTitle('Announcement').setDescription('body');
  w.upload = {
    author: { id: 'AUTHOR' },
    deletable: true,
    attachments: new Map(Object.entries(attachments || { a: { name: 'shot.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/tmp.png?ex=deadbeef' } })),
    async delete() { w.deleted.push(this); },
  };
  // discord.js Collections expose .first(); Map does not.
  w.upload.attachments.first = function () { return [...this.values()][0]; };
  return w;
}

const flush = () => new Promise(r => setImmediate(r));

// ─── Pure helpers ────────────────────────────────────────────────────────────
check('isImage trusts contentType', () => {
  assert.strictEqual(isImage({ contentType: 'image/webp', name: 'blob' }), true);
  assert.strictEqual(isImage({ contentType: 'application/zip', name: 'cheat.zip' }), false);
});

check('isImage falls back to the extension when Discord sends no contentType', () => {
  // Uploads from some clients arrive with contentType null; refusing those
  // would make the feature look broken for whoever uses that client.
  assert.strictEqual(isImage({ name: 'proof.JPEG' }), true);
  assert.strictEqual(isImage({ name: 'notes.txt' }), false);
  assert.strictEqual(isImage(null), false);
});

check('embedHasImage reads both a builder and a raw embed', () => {
  assert.strictEqual(embedHasImage(new EmbedBuilder().setImage('https://x/y.png')), true);
  assert.strictEqual(embedHasImage(new EmbedBuilder().setTitle('t')), false);
  assert.strictEqual(embedHasImage({ image: { url: 'https://x/y.png' } }), true);
  // A thumbnail is not an image — /postupdate sets one and must still be asked.
  assert.strictEqual(embedHasImage(new EmbedBuilder().setThumbnail('https://x/t.png')), false);
});

// ─── The flow ────────────────────────────────────────────────────────────────
(async () => {
  {
    const w = makeWorld();
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed, fileBase: 'announce-999' });

    check('the offer is ephemeral', () => {
      assert.strictEqual(w.followUps.length, 1);
      assert.strictEqual(w.followUps[0].flags, 64);
    });

    check('the collector only accepts the author, and only with a file', () => {
      const f = w.collector.filter;
      assert.strictEqual(f({ author: { id: 'AUTHOR' }, attachments: { size: 1 } }), true);
      assert.strictEqual(f({ author: { id: 'SOMEONE_ELSE' }, attachments: { size: 1 } }), false);
      assert.strictEqual(f({ author: { id: 'AUTHOR' }, attachments: { size: 0 } }), false);
    });

    let attachedWith = null;
    w.onAttached = u => { attachedWith = u; };
    await w.collector.fire('collect', w.upload);
    await flush();

    check('the bytes are re-uploaded, not linked to the expiring CDN url', () => {
      assert.strictEqual(w.edits.length, 1);
      const { embeds, files } = w.edits[0];
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].name, 'announce-999.png');
      assert.strictEqual(embeds[0].data.image.url, 'attachment://announce-999.png');
      assert.ok(!JSON.stringify(embeds[0].data).includes('ex=deadbeef'), 'embed still points at the temporary url');
    });

    check('the post keeps its components (the language dropdown lives there)', () => {
      assert.ok(!('components' in w.edits[0]), 'edit passed components and would wipe the dropdown');
    });

    check('the uploaded message is cleaned up', () => {
      assert.strictEqual(w.deleted.length, 1);
    });

    check('the ephemeral prompt is edited, never interaction.editReply', () => {
      // editReply would rewrite the "✅ posted" confirmation instead.
      assert.strictEqual(w.webhookEdits.length, 1);
      assert.strictEqual(w.webhookEdits[0].id, 'PROMPT');
      assert.ok(w.webhookEdits[0].content.startsWith('✅'));
    });
  }

  {
    const w = makeWorld();
    let got = null;
    await offerImageUpload({
      interaction: w.interaction, message: w.message, embed: w.embed,
      fileBase: 'vouch-7', onAttached: (url, msg) => { got = { url, msg }; },
    });
    await w.collector.fire('collect', w.upload);
    await flush();
    check('onAttached gets the PERSISTED url off the edited post', () => {
      // The vouch flow saves this to disk and ships it to the website; saving
      // the uploader's temporary url there is the bug this guards.
      assert.strictEqual(got.url, 'https://cdn.discordapp.com/final.png');
      assert.strictEqual(got.msg, w.message);
    });
  }

  {
    const w = makeWorld();
    await offerImageUpload({
      interaction: w.interaction, message: w.message, embed: w.embed,
      onAttached: () => { throw new Error('caller blew up'); },
    });
    await w.collector.fire('collect', w.upload);
    await flush();
    check('a throwing onAttached still leaves the post edited and the upload deleted', () => {
      assert.strictEqual(w.edits.length, 1);
      assert.strictEqual(w.deleted.length, 1);
    });
  }

  {
    const w = makeWorld({ attachments: { a: { name: 'loader.exe', contentType: 'application/octet-stream', url: 'https://x/l.exe' } } });
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    await w.collector.fire('collect', w.upload);
    await flush();
    check('a non-image is refused, and NOT deleted', () => {
      assert.strictEqual(w.edits.length, 0);
      assert.ok(w.webhookEdits[0].content.startsWith('❌'));
      // The collector fires on any file. A zip posted by someone who never ran
      // the command must not be destroyed by a feature they never invoked.
      assert.strictEqual(w.deleted.length, 0);
    });
  }

  {
    const w = makeWorld({ embed: new EmbedBuilder().setImage('https://i.imgur.com/already.png') });
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    check('a post that already has a picture is never asked about', () => {
      assert.strictEqual(w.followUps.length, 0);
    });
  }

  {
    const w = makeWorld();
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    await w.collector.fire('end');
    await flush();
    check('timing out says so instead of leaving the prompt hanging', () => {
      assert.strictEqual(w.webhookEdits.length, 1);
      assert.ok(w.webhookEdits[0].content.startsWith('⏱️'));
    });
  }

  {
    const w = makeWorld();
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    await w.collector.fire('collect', w.upload);
    await w.collector.fire('end');   // max:1 fires 'end' straight after 'collect'
    await flush();
    check('the success message is not overwritten by the timeout message', () => {
      assert.strictEqual(w.webhookEdits.length, 1);
      assert.ok(w.webhookEdits[0].content.startsWith('✅'));
    });
  }

  {
    const w = makeWorld();
    w.message.edit = async () => { throw new Error('Request entity too large'); };
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    await w.collector.fire('collect', w.upload);
    await flush();
    check('an oversized file reports why instead of failing silently', () => {
      assert.ok(w.webhookEdits[0].content.includes('too large'));
    });
  }

  {
    // Every guard, one at a time — this is fire-and-forget from four commands
    // that have ALREADY told the user their post went out.
    const w = makeWorld();
    for (const bad of [
      {},
      { interaction: w.interaction },
      { interaction: w.interaction, message: w.message },
      { interaction: {}, message: w.message, embed: w.embed },              // no channel
      { interaction: { channel: {} }, message: w.message, embed: w.embed },  // channel can't collect
      { interaction: w.interaction, message: null, embed: w.embed },         // post never sent
    ]) {
      await offerImageUpload(bad);
    }
    await offerImageUpload();
    check('every missing-piece case returns quietly instead of throwing', () => {
      assert.strictEqual(w.followUps.length, 0);
    });
  }

  {
    const w = makeWorld();
    w.interaction.followUp = async () => { throw new Error('Unknown Webhook'); };
    await offerImageUpload({ interaction: w.interaction, message: w.message, embed: w.embed });
    check('a dead interaction token stops the flow rather than collecting forever', () => {
      assert.strictEqual(w.collector.filter, null, 'collector started with nowhere to report back to');
    });
  }

  console.log(`\n${passed} checks passed`);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });

// node --test src/uploader.repeat.test.js    (or: npm test)
//
// Two things a real afternoon on a real channel exposed:
//
//   1. Two shorts went up titled "KaiCenat Has Chat in Tears in GTA 6" hours
//      apart. `avoid` steers the wording but does not promise the result
//      differs, and when every option is taken the generator returns its
//      first one anyway.
//   2. YouTube refused the day's eighth upload and the uploader correctly
//      stood down until midnight Pacific — then a restart forgot, tried
//      again, and spent an attempt rediscovering the same refusal.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from './store.js';
import { Uploader, postWithoutRepeating, uploadConfig } from './uploader.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-19T19:00:00Z');
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-repeat-'));
  dirs.push(dir);
  return dir;
};

// --- the repeated title ---------------------------------------------------

/**
 * An adapter that does NOT honour `avoid` on its own — which is the real
 * behaviour being guarded against, since the generator falls back to its
 * first option when every option is taken. It simply hands out the next
 * title each time it is asked, and repeats the last one forever.
 */
const ignoresAvoid = (titles) => ({
  calls: [],
  post(_candidate, { avoid = [] } = {}) {
    const i = Math.min(this.calls.length, titles.length - 1);
    this.calls.push([...avoid]);
    return { title: `${titles[i]} #Shorts` };
  },
});

test('a title already used is asked for again rather than posted twice', () => {
  const adapter = ignoresAvoid(['KaiCenat Has Chat in Tears in GTA 6', "KaiCenat's Chat Spiked at This Moment"]);
  const post = postWithoutRepeating(adapter, {}, ['KaiCenat Has Chat in Tears in GTA 6']);
  assert.equal(post.title, "KaiCenat's Chat Spiked at This Moment #Shorts");
  assert.equal(adapter.calls.length, 2, 'it asked a second time');
  assert.ok(adapter.calls[1].includes('KaiCenat Has Chat in Tears in GTA 6'));
});

test('the comparison ignores hashtags, case and punctuation', () => {
  const adapter = ignoresAvoid(['KaiCenat Has Chat in Tears in GTA 6', 'Something Else Entirely']);
  // Stored titles carry their tags; the clash is in the words before them.
  const post = postWithoutRepeating(adapter, {}, ['kaicenat has chat in tears in gta 6 #Shorts #GTA6']);
  assert.equal(post.title, 'Something Else Entirely #Shorts');
});

test('a title nobody has used is posted on the first ask', () => {
  const adapter = ignoresAvoid(['A Fresh Line']);
  const post = postWithoutRepeating(adapter, {}, ['Something Older']);
  assert.equal(post.title, 'A Fresh Line #Shorts');
  assert.equal(adapter.calls.length, 1, 'no second ask was needed');
});

test('it gives up and posts rather than withholding the short', () => {
  // Five channels will genuinely run out of ways to say the same thing. A
  // duplicate title beats a short that never goes out.
  const adapter = ignoresAvoid(['Only One Way to Say It']);
  const post = postWithoutRepeating(adapter, {}, ['Only One Way to Say It'], 3);
  assert.equal(post.title, 'Only One Way to Say It #Shorts');
  assert.equal(adapter.calls.length, 4, 'it tried, then posted anyway');
});

// --- the backoff a restart used to forget ---------------------------------

const uploaderOn = async (dir, settingsPath) =>
  new Uploader({
    store: new Store(':memory:'),
    dir,
    log: () => {},
    now: () => T0,
    settingsPath,
    dryRunLog: join(dir, 'dry.jsonl'),
    cfg: uploadConfig({}),
  });

test('a wait with an end to it is written down and comes back', async () => {
  const dir = await temp();
  const settingsPath = join(dir, 'uploads.json');

  const first = await uploaderOn(dir, settingsPath);
  first.state.youtube.blockedUntil = T0 + 3600_000;
  first.state.youtube.blockedReason = "YouTube's daily quota is spent";
  first.rememberBlock('youtube');
  await first.saveSettings();

  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(saved.youtube.blockedUntil, T0 + 3600_000);

  const second = await uploaderOn(dir, settingsPath);
  await second.load();
  assert.equal(second.state.youtube.blockedUntil, T0 + 3600_000);
  assert.match(second.state.youtube.blockedReason, /quota/);
});

test('a wait that has already passed is not restored', async () => {
  const dir = await temp();
  const settingsPath = join(dir, 'uploads.json');
  await writeFile(
    settingsPath,
    JSON.stringify({ youtube: { mode: 'off', blockedUntil: T0 - 1000, blockedReason: 'yesterday' } }),
    'utf8',
  );
  const u = await uploaderOn(dir, settingsPath);
  await u.load();
  assert.equal(u.state.youtube.blockedUntil, 0);
  assert.equal(u.state.youtube.blockedReason, null);
});

test('a block with no end is NOT restored, so a file cannot wedge the tool', async () => {
  // Infinity does not survive JSON anyway, but the rule is deliberate: a
  // refused account and an expired sign-in are re-established by trying and
  // by isConnected(), not by a number read off disk.
  const dir = await temp();
  const settingsPath = join(dir, 'uploads.json');
  await writeFile(
    settingsPath,
    JSON.stringify({ youtube: { mode: 'off', blockedUntil: null, blockedReason: 'refusing this account' } }),
    'utf8',
  );
  const u = await uploaderOn(dir, settingsPath);
  await u.load();
  assert.equal(u.state.youtube.blockedUntil, 0);
});

test('reconnecting clears a remembered wait', async () => {
  const dir = await temp();
  const settingsPath = join(dir, 'uploads.json');
  const u = await uploaderOn(dir, settingsPath);
  u.state.youtube.blockedUntil = T0 + 3600_000;
  u.state.youtube.blockedReason = 'spent';
  u.rememberBlock('youtube');
  assert.equal(u.settings.youtube.blockedUntil, T0 + 3600_000);

  u.state.youtube.blockedUntil = 0;
  u.state.youtube.blockedReason = null;
  u.rememberBlock('youtube');
  assert.equal(u.settings.youtube.blockedUntil, 0);
  assert.equal(u.settings.youtube.blockedReason, null);
});

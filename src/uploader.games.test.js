// node --test src/uploader.games.test.js    (or: npm test)
//
// A channel is about something. The feed watches several games at once, so
// without a filter every channel gets every game's clips — a Tarkov channel
// fed GTA shorts. These cover the filter that stops that, and the tags a
// Tarkov short carries.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { GAME_HASHTAGS, GAME_TAGS, config } from './config.js';
import { gameLabel } from './shortform.js';
import { Store } from './store.js';
import { Uploader, candidates, uploadConfig } from './uploader.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-19T18:00:00Z');

/** A ready folder and a store holding these shorts. */
async function setup(shorts) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-games-'));
  dirs.push(dir);
  const store = new Store(':memory:');
  for (const [i, s] of shorts.entries()) {
    const file = `${s.name}-1-t00000${i}-x.mp4`;
    store.recordAutoclip({ momentId: `m${i}`, vodId: `v${i}`, offsetSeconds: i * 1000, broadcaster: s.name, caption: 'x', at: new Date(T0 - 3600_000 + i) });
    store.finishAutoclip(`m${i}`, { status: 'done', path: join(dir, file), review: { score: s.score, weak: false }, at: new Date(T0 - 3600_000 + i) });
    await writeFile(join(dir, file), 'VIDEO');
    await writeFile(
      join(dir, file.replace('.mp4', '.json')),
      JSON.stringify({ caption: `"${s.name} line"`, game: s.game, broadcaster: s.name, link: 'https://twitch.tv/videos/1' }),
    );
  }
  return { dir, store };
}

const MIXED = [
  { name: 'gtaone', score: 90, game: 'Grand Theft Auto VI' },
  { name: 'tarkovone', score: 80, game: 'Escape from Tarkov' },
  { name: 'fortone', score: 70, game: 'Fortnite' },
  { name: 'tarkovtwo', score: 60, game: 'Escape from Tarkov' },
];

// --- the env list ---------------------------------------------------------

test('an unset list means every watched game, not none', () => {
  assert.equal(uploadConfig({}).youtube.games, null);
  assert.equal(uploadConfig({ YOUTUBE_GAMES: '' }).youtube.games, null);
  assert.equal(uploadConfig({ YOUTUBE_GAMES: '  ,  ' }).youtube.games, null);
});

test('the list is split, trimmed and kept per platform', () => {
  const cfg = uploadConfig({
    YOUTUBE_GAMES: 'Escape from Tarkov',
    TIKTOK_GAMES: ' Fortnite , Grand Theft Auto VI ',
  });
  assert.deepEqual(cfg.youtube.games, ['Escape from Tarkov']);
  assert.deepEqual(cfg.tiktok.games, ['Fortnite', 'Grand Theft Auto VI']);
  // Not set for Instagram, so Instagram still gets everything.
  assert.equal(cfg.instagram.games, null);
});

// --- what reaches the queue ----------------------------------------------

test('a one-game channel queues only that game', async () => {
  const { dir, store } = await setup(MIXED);
  const picks = await candidates({ store, dir, platform: 'youtube', games: ['Escape from Tarkov'] });
  assert.deepEqual(
    picks.map((c) => c.saved.broadcaster),
    ['tarkovone', 'tarkovtwo'],
  );
});

test('the game is matched however it is cased', async () => {
  const { dir, store } = await setup(MIXED);
  const picks = await candidates({ store, dir, platform: 'youtube', games: ['ESCAPE FROM tarkov'] });
  assert.equal(picks.length, 2);
});

test("the filter is the uploader's, so the panel and the schedule both see it", async () => {
  const { dir, store } = await setup(MIXED);
  const u = new Uploader({
    store,
    dir,
    log: () => {},
    now: () => T0,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
    cfg: uploadConfig({ YOUTUBE_GAMES: 'Escape from Tarkov' }),
  });
  const queue = await u.queueFor('youtube');
  assert.deepEqual(
    queue.map((c) => c.saved.game),
    ['Escape from Tarkov', 'Escape from Tarkov'],
  );
  // TikTok has no list of its own, so it falls back to the games the feed is
  // watching — whatever GAMES currently says, not a wider set.
  const all = await u.queueFor('tiktok');
  assert.deepEqual(all.map((c) => c.file), (await candidates({ store, dir, platform: 'tiktok', games: config.games })).map((c) => c.file));
});

// The trap this pair exists to document: the per-channel list NARROWS what the
// feed already watches, it cannot widen it. A Tarkov short reaches no queue at
// all until GAMES itself includes Tarkov, however the channel is configured.
test('a per-channel list cannot queue a game the feed is not watching', async () => {
  const { dir, store } = await setup(MIXED);
  const watching = ['Grand Theft Auto VI', 'Fortnite'];
  const picks = await candidates({ store, dir, platform: 'youtube', games: watching });
  assert.ok(!picks.some((c) => c.saved.game === 'Escape from Tarkov'));
  // And with Tarkov watched, the same short comes through.
  const after = await candidates({ store, dir, platform: 'youtube', games: [...watching, 'Escape from Tarkov'] });
  assert.ok(after.some((c) => c.saved.game === 'Escape from Tarkov'));
});

test('a channel whose game is not being clipped queues nothing', async () => {
  const { dir, store } = await setup(MIXED);
  const picks = await candidates({ store, dir, platform: 'youtube', games: ['VALORANT'] });
  assert.deepEqual(picks, []);
});

// --- Tarkov's own copy ----------------------------------------------------

test('Tarkov has its own tags rather than falling back to bare #gaming', () => {
  assert.ok(GAME_TAGS['escape from tarkov'], 'Tarkov is a game the copy knows');
  assert.deepEqual(GAME_TAGS['escape from tarkov'].tags, ['#tarkov', '#escapefromtarkov']);
  assert.equal(GAME_TAGS['escape from tarkov'].youtube, '#Tarkov');
  assert.match(GAME_HASHTAGS['escape from tarkov'], /#tarkov/);
  // The fallback it is no longer taking.
  assert.notEqual(GAME_HASHTAGS['escape from tarkov'], '#gaming #twitch');
});

test('a title calls it Tarkov, not Escape from Tarkov', () => {
  assert.equal(gameLabel('Escape from Tarkov'), 'Tarkov');
  assert.equal(gameLabel('escape from tarkov'), 'Tarkov');
});

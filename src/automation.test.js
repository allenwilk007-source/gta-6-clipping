// node --test src/automation.test.js    (or: npm test)
//
// The channel-automation panel: what it accepts, what it refuses, what it
// serves, and that a change reaches the feed and survives a restart.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  Automation,
  MAX_CHANNELS,
  SHORT_FILE,
  applyChange,
  normalizeLogin,
  parseRange,
  sanitizeSettings,
} from './automation.js';

const scratch = mkdtempSync(join(tmpdir(), 'automation-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a channel can be added however it gets pasted', () => {
  assert.equal(normalizeLogin('xQc'), 'xqc');
  assert.equal(normalizeLogin('@CaseOh_'), 'caseoh_');
  assert.equal(normalizeLogin('https://www.twitch.tv/Lirik'), 'lirik');
  assert.equal(normalizeLogin('twitch.tv/summit1g/videos?filter=archives'), 'summit1g');
  assert.equal(normalizeLogin('  m.twitch.tv/shroud  '), 'shroud');
});

test('things that are not a channel are refused', () => {
  assert.equal(normalizeLogin(''), null);
  assert.equal(normalizeLogin('two words'), null);
  assert.equal(normalizeLogin('a'.repeat(26)), null);
  // A twitch.tv path that looks like a name and is not one.
  assert.equal(normalizeLogin('https://www.twitch.tv/videos/2932444934'), null);
  assert.equal(normalizeLogin('https://www.twitch.tv/directory'), null);
});

test('the panel adds, removes and switches, and says why when it cannot', () => {
  const start = { enabled: false, channels: ['xqc'] };
  assert.deepEqual(applyChange(start, { add: 'twitch.tv/Lirik' }).channels, ['xqc', 'lirik']);
  // Adding one twice is not two.
  assert.deepEqual(applyChange(start, { add: 'XQC' }).channels, ['xqc']);
  assert.deepEqual(applyChange(start, { remove: 'xqc' }).channels, []);
  assert.equal(applyChange(start, { enabled: true }).enabled, true);
  // The original is left alone.
  assert.deepEqual(start, { enabled: false, channels: ['xqc'] });

  assert.throws(() => applyChange(start, { add: 'not a channel!' }), /not a Twitch channel name/);
  assert.throws(() => applyChange(start, { enabled: 'yes' }), /true or false/);
  const full = { enabled: true, channels: Array.from({ length: MAX_CHANNELS }, (_, i) => `ch${i}`) };
  assert.throws(() => applyChange(full, { add: 'onemore' }), /at most/);
});

test('saved settings are cleaned on the way back in', () => {
  const fallback = { enabled: false, channels: ['xqc'], games: ['Grand Theft Auto VI'], music: false, scope: 'channels' };
  assert.deepEqual(
    sanitizeSettings(
      {
        enabled: true,
        channels: ['Lirik', 'bad name', 'lirik'],
        // Spacing collapsed, blanks dropped, the repeat folded away.
        games: ['  Fortnite ', 'Fortnite', ''],
        music: true,
        scope: 'category',
      },
      fallback,
    ),
    { enabled: true, channels: ['lirik'], games: ['Fortnite'], music: true, scope: 'category' },
  );
  // A missing or broken file falls back rather than throwing.
  assert.deepEqual(sanitizeSettings(null, fallback), fallback);
  assert.deepEqual(sanitizeSettings({ enabled: 'on', music: 'yes', scope: 'everything' }, fallback), fallback);
});

test('music and where to clip from are switched from the panel too', () => {
  const start = { enabled: true, channels: ['xqc'], music: false, scope: 'channels' };
  assert.equal(applyChange(start, { music: true }).music, true);
  assert.equal(applyChange(start, { scope: 'category' }).scope, 'category');
  assert.throws(() => applyChange(start, { music: 'loud' }), /true or false/);
  assert.throws(() => applyChange(start, { scope: 'everything' }), /scope must be one of/);
  // Room for both games' worth of channels.
  assert.equal(MAX_CHANNELS, 100);
});

test('/shorts/ serves only the names the renderer makes', () => {
  assert.ok(SHORT_FILE.test('lirik-2932444934-t021904-20261118T183156Z.mp4'));
  assert.ok(SHORT_FILE.test('lirik-2932444934-t021904-20261118T183156Z.txt'));
  assert.ok(!SHORT_FILE.test('../../.env'));
  assert.ok(!SHORT_FILE.test('..%2F..%2F.env'));
  assert.ok(!SHORT_FILE.test('feed.db'));
  assert.ok(!SHORT_FILE.test('lirik-2932444934-t021904-20261118T183156Z.mp4/../x'));
});

test('a byte range is read the way a <video> asks for it', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { invalid: true });
});

function fakeFeed({ chatOnly = true, started = true } = {}) {
  return {
    chatOnly,
    started,
    store: null,
    watchChannels: ['xqc', 'caseoh_'],
    channels: new Map([
      ['xqc', { vodId: '1', archiveCheckedAt: 1 }],
      ['caseoh_', { vodId: null, archiveCheckedAt: 1 }],
    ]),
    lists: [],
    setWatchList(list) {
      this.lists.push(list);
      this.watchChannels = [...list];
    },
  };
}

const fakeClipper = () => ({
  cfg: { dir: scratch },
  channels: null,
  loaded: false,
  setChannels(list) {
    this.channels = list;
  },
  load() {
    this.loaded = true;
  },
  status: () => ({ queued: 0, done: 0, failed: 0, lastHour: 0, perHour: 6, skipped: {} }),
});

test('a fresh install starts switched off, on the watch list it already had', () => {
  const feed = fakeFeed();
  const automation = new Automation({ feed, clipper: fakeClipper(), path: join(scratch, 'none.json'), env: {} });
  assert.equal(automation.settings.enabled, false);
  assert.deepEqual(automation.settings.channels, ['xqc', 'caseoh_']);
  // AUTOCLIP=on starts it on.
  const on = new Automation({ feed, clipper: fakeClipper(), path: join(scratch, 'none.json'), env: { AUTOCLIP: 'on' } });
  assert.equal(on.settings.enabled, true);
});

test('a change reaches the feed and the clipper, and survives a restart', async () => {
  const path = join(scratch, 'automation.json');
  const feed = fakeFeed();
  const clipper = fakeClipper();
  const automation = new Automation({ feed, clipper, path, env: {} });

  automation.update({ add: 'https://twitch.tv/Lirik', enabled: true });
  // Chat-only listens to exactly these channels, from now.
  assert.deepEqual(feed.lists.at(-1), ['xqc', 'caseoh_', 'lirik']);
  assert.deepEqual(clipper.channels, ['xqc', 'caseoh_', 'lirik']);

  const view = await automation.view();
  assert.equal(view.enabled, true);
  assert.equal(view.mode, 'chat-only');
  assert.deepEqual(
    view.channels.map(({ login, state }) => `${login}:${state}`),
    ['xqc:recording', 'caseoh_:not recording', 'lirik:listening'],
  );

  // Restarted: the file wins over the defaults.
  const again = new Automation({ feed: fakeFeed(), clipper: fakeClipper(), path, env: {} });
  assert.equal(again.settings.enabled, true);
  assert.deepEqual(again.settings.channels, ['xqc', 'caseoh_', 'lirik']);
});

test('with credentials the list decides what is cut, not what is watched', () => {
  // The full feed watches the whole category; replacing its watch list would
  // throw away everything Helix found.
  const feed = fakeFeed({ chatOnly: false });
  const automation = new Automation({ feed, clipper: fakeClipper(), path: join(scratch, 'full.json'), env: {} });
  automation.update({ remove: 'xqc' });
  assert.equal(feed.lists.length, 0);
});

test('an inert collector says so; a healthy one does not', async () => {
  const { collectorHealth } = await import('./automation.js');
  // The stuck run, as logged: every moment skipped as unknown-game, every
  // ten minutes, for 35 minutes, under a line that looked routine.
  const stuck = collectorHealth({ skipped: { 'unknown-game': 10 }, picks: 0 });
  assert.equal(stuck.level, 'warn');
  assert.match(stuck.message, /10 of 10 moments were passed over because their game could not be told/);

  // A healthy live poll, as logged: some unknown-game among many reasons.
  const busy = collectorHealth({
    skipped: { 'hourly-limit': 21, 'unknown-game': 10, settling: 6, 'other-game': 3 },
    picks: 0,
  });
  assert.equal(busy.level, 'ok');

  // A quiet poll is not an emergency.
  assert.equal(collectorHealth({ skipped: { 'unknown-game': 1 } }).level, 'ok');
});

test('lookups failing over and over is an error, with the reason', async () => {
  const { collectorHealth } = await import('./automation.js');
  const health = collectorHealth({
    skipped: {},
    lookups: { consecutive: 6, lastError: 'downloader exited with code 3221225794' },
  });
  assert.equal(health.level, 'error');
  assert.match(health.message, /failed 6 times in a row \(last: downloader exited with code 3221225794\)/);
  assert.match(health.message, /restart the app/);
});

test('channels that simply do not record are not a fault', async () => {
  const { collectorHealth } = await import('./automation.js');
  // A quiet stretch of subscriber-only and non-archiving channels, plus a
  // few playing something off the list: correct skips, not breakage.
  assert.equal(collectorHealth({ skipped: { 'no-vod': 10, 'other-game': 5 } }).level, 'ok');
  // The same with lookups failing is worth a warning.
  const failing = collectorHealth({ skipped: { 'no-vod': 10 }, lookups: { consecutive: 2, lastError: 'ETIMEDOUT' } });
  assert.equal(failing.level, 'warn');
  assert.match(failing.message, /no recording to cut from, and recording lookups are failing \(ETIMEDOUT\)/);
});

test('moments on a recorded channel are marked as cuttable from the recording', async () => {
  const { annotateLive } = await import('./automation.js');
  const peak = Date.parse('2026-11-18T21:10:00Z');
  const recorders = {
    get: (login) =>
      login === 'ishowspeed'
        ? { login, game: 'grand theft auto vi', covers: (from, to) => from >= peak - 30_000 && to <= peak + 10_000 }
        : null,
  };
  const [live, vod, unrecorded] = annotateLive(
    [
      { id: 'chat:ishowspeed:1', broadcaster: 'ishowspeed', vodId: null, firstClipAt: new Date(peak).toISOString() },
      { id: 'chat:lirik:1', broadcaster: 'lirik', vodId: '123', firstClipAt: new Date(peak).toISOString() },
      { id: 'chat:caseoh_:1', broadcaster: 'caseoh_', vodId: null, firstClipAt: new Date(peak).toISOString() },
    ],
    recorders,
    { pre: 25, post: 5 },
  );
  assert.deepEqual(live.live, { login: 'ishowspeed', peakAt: peak });
  assert.equal(live.liveReady, true);
  // No chapters without a VOD: the game comes from the channel's page.
  assert.equal(live.game, 'grand theft auto vi');
  assert.equal(live.reactionOffsetSeconds, Math.round(peak / 1000));
  // A moment with a VOD keeps using it; one with neither is untouched.
  assert.equal(vod.live, undefined);
  assert.equal(unrecorded.live, undefined);
});

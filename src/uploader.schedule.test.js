// node --test src/uploader.schedule.test.js    (or: npm test)
//
// The projection behind the upload-queue dashboard: given what has already
// gone out, when would the next ones go?
//
// This is the piece most able to lie quietly. A wrong number here still looks
// like a time, so the tests check it against the rules the uploader actually
// applies rather than against a second copy of them.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from './store.js';
import { Uploader, pacificDayStart, projectSlots } from './uploader.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-18T18:00:00Z'); // 10:00 Pacific
const HOUR = 3600_000;
const MIN = 60_000;

const times = (slots) => slots.map((t) => new Date(t).toISOString());

test('with nothing posted yet, the first goes now and the rest follow the spacing', () => {
  const slots = projectSlots({ taken: [], count: 3, now: T0, perDay: 5, spacingMinutes: 180, rolling: false });
  assert.deepEqual(times(slots), ['2026-11-18T18:00:00.000Z', '2026-11-18T21:00:00.000Z', '2026-11-19T00:00:00.000Z']);
});

test('the spacing is owed from the last real upload, not from now', () => {
  // Posted at 17:40 with 3-hour spacing: the next is at 20:40, not at 18:00.
  const slots = projectSlots({ taken: [T0 - 20 * MIN], count: 1, now: T0, perDay: 5, spacingMinutes: 180, rolling: false });
  assert.deepEqual(times(slots), ['2026-11-18T20:40:00.000Z']);
});

test("a day's cap pushes the rest to the next Pacific midnight", () => {
  // Four already gone today, cap of 5: one more today, then a wait.
  const taken = [0, 1, 2, 3].map((i) => T0 - (4 - i) * HOUR);
  const slots = projectSlots({ taken, count: 3, now: T0, perDay: 5, spacingMinutes: 180, rolling: false });

  // The fifth still fits today, three hours after the fourth.
  assert.equal(new Date(slots[0]).toISOString(), '2026-11-18T20:00:00.000Z');
  // The sixth cannot: it waits for midnight Pacific, which is 08:00 UTC.
  assert.equal(new Date(slots[1]).toISOString(), '2026-11-19T08:00:00.000Z');
  assert.equal(new Date(slots[2]).toISOString(), '2026-11-19T11:00:00.000Z');
  // Each projected slot lands in a day that is not already full.
  for (const slot of slots) {
    const sameDay = slots.filter((s) => pacificDayStart(s) === pacificDayStart(slot));
    assert.ok(sameDay.length <= 5);
  }
});

test('a rolling cap frees up as the oldest ages out, not at midnight', () => {
  // Five gone, an hour apart, the oldest four hours ago. TikTok's cap is 5 in
  // any 24 hours, so the next slot is 24 hours after that oldest one.
  const taken = [0, 1, 2, 3, 4].map((i) => T0 - (4 - i) * HOUR);
  const slots = projectSlots({ taken, count: 2, now: T0, perDay: 5, spacingMinutes: 280, rolling: true });

  // The window is what binds here, not the spacing: the oldest of the five
  // was four hours ago, so a slot opens 24 hours after it — well before the
  // next Pacific midnight would have mattered.
  assert.equal(new Date(slots[0]).toISOString(), new Date(T0 - 4 * HOUR + 24 * HOUR).toISOString());
  // Once that slot is taken the window has room again, so the SECOND one is
  // held by the spacing from the first instead.
  assert.equal(slots[1] - slots[0], 280 * MIN);
});

test('a rolling projection never puts more than the cap in any 24 hours', () => {
  const taken = [0, 1, 2, 3, 4].map((i) => T0 - (4 - i) * HOUR);
  const slots = projectSlots({ taken, count: 10, now: T0, perDay: 5, spacingMinutes: 280, rolling: true });
  const all = [...taken, ...slots];

  for (const at of all) {
    const inWindow = all.filter((t) => t > at - 24 * HOUR && t <= at);
    assert.ok(inWindow.length <= 5, `${inWindow.length} in the 24h ending ${new Date(at).toISOString()}`);
  }
  // And it is always going forwards.
  for (let i = 1; i < slots.length; i += 1) assert.ok(slots[i] > slots[i - 1]);
});

test('the spacing still applies after a cap lifts', () => {
  // Two slots open at once when the window moves; they must not collide.
  const taken = [T0 - HOUR, T0 - HOUR + MIN, T0 - HOUR + 2 * MIN];
  const slots = projectSlots({ taken, count: 3, now: T0, perDay: 3, spacingMinutes: 180, rolling: true });
  for (let i = 1; i < slots.length; i += 1) {
    assert.ok(slots[i] - slots[i - 1] >= 180 * MIN, `${(slots[i] - slots[i - 1]) / MIN} minutes apart`);
  }
});

test('a block with no end gives no times at all, rather than made-up ones', () => {
  // A lapsed sign-in or a refused account. "Tomorrow at 9" would be a lie.
  assert.deepEqual(projectSlots({ taken: [], count: 3, now: T0, perDay: 5, spacingMinutes: 180, rolling: false, notBefore: Infinity }), []);
});

test('a block with an end pushes everything past it', () => {
  const until = T0 + 6 * HOUR;
  const slots = projectSlots({ taken: [], count: 2, now: T0, perDay: 5, spacingMinutes: 180, rolling: false, notBefore: until });
  assert.equal(slots[0], until);
  assert.equal(slots[1], until + 180 * MIN);
});

// --- the whole thing, through the uploader ------------------------------------

async function setup(shorts) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-sched-'));
  dirs.push(dir);
  const store = new Store(':memory:');
  for (const [i, s] of shorts.entries()) {
    const file = `${s.name}-1-t00000${i}-x.mp4`;
    store.recordAutoclip({ momentId: `m${i}`, vodId: `v${i}`, offsetSeconds: i * 1000, broadcaster: s.name, caption: 'x', at: new Date(T0 - HOUR + i) });
    store.finishAutoclip(`m${i}`, { status: 'done', path: join(dir, file), review: { score: s.score, weak: false }, at: new Date(T0 - HOUR + i) });
    await writeFile(join(dir, file), 'VIDEO');
    await writeFile(
      join(dir, file.replace('.mp4', '.json')),
      JSON.stringify({ caption: `"${s.name} line" 😂`, game: 'Grand Theft Auto VI', broadcaster: s.name, link: 'https://twitch.tv/videos/1' }),
    );
  }
  return { dir, store };
}

function uploader({ store, dir }) {
  return new Uploader({
    store,
    dir,
    log: () => {},
    now: () => T0,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
    check: async () => ({ ok: true, problems: [] }),
  });
}

test('the view carries a time for every queued short, best first', async () => {
  const { dir, store } = await setup([
    { name: 'best', score: 92 },
    { name: 'good', score: 77 },
    { name: 'okay', score: 61 },
  ]);
  const u = uploader({ store, dir });
  const view = await u.view();

  assert.equal(view.youtube.queued, 3);
  assert.equal(view.youtube.upcoming.length, 3);
  assert.deepEqual(
    view.youtube.upcoming.map((c) => c.broadcaster),
    ['best', 'good', 'okay'],
  );
  // Every one has a real time, in order, and a title to recognise it by.
  let previous = 0;
  for (const item of view.youtube.upcoming) {
    const at = Date.parse(item.at);
    assert.ok(Number.isFinite(at), `${item.file} has no time`);
    assert.ok(at > previous);
    previous = at;
    assert.ok(item.title);
  }
});

test('the two platforms project their own queues, with their own caps', async () => {
  const { dir, store } = await setup(Array.from({ length: 3 }, (_, i) => ({ name: `s${i}`, score: 90 - i })));
  const u = uploader({ store, dir });
  const view = await u.view();

  // Same shorts waiting for both, because neither has posted them.
  assert.equal(view.tiktok.queued, 3);
  assert.equal(view.youtube.queued, 3);
  // YouTube every 3 hours, TikTok every 4h40: the spacing each platform is
  // actually configured with, not one shared number.
  const gap = (list) => Date.parse(list[1].at) - Date.parse(list[0].at);
  assert.equal(gap(view.youtube.upcoming), 180 * MIN);
  assert.equal(gap(view.tiktok.upcoming), 280 * MIN);
});

test('what has already gone out today moves the first slot', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 92 }]);
  const u = uploader({ store, dir });
  // One posted 30 minutes ago.
  store.claimUpload({ file: 'earlier.mp4', platform: 'youtube', title: 't', score: 50, at: new Date(T0 - 30 * MIN) });
  store.finishUpload({ file: 'earlier.mp4', platform: 'youtube', status: 'done', at: new Date(T0 - 30 * MIN) });

  const view = await u.view();
  // 3 hours after that one, not now.
  assert.equal(view.youtube.upcoming[0].at, new Date(T0 + 150 * MIN).toISOString());
});

test('a sign-in that lapsed leaves the page with no time, rather than throwing', async () => {
  // Found the hard way: YouTube's sign-in had expired, the switch was on, and
  // the next read of the upload state killed the server — then the supervisor
  // restarted it into the same state, so it would have kept dying. A block
  // with no end date has no time to show, and Infinity has no ISO form.
  const { dir, store } = await setup([{ name: 'best', score: 92 }]);
  const u = uploader({ store, dir });
  u.settings.youtube.mode = 'on';
  const err = new Error('sign-in: 400 Token has been expired or revoked.');
  err.kind = 'auth';
  u.stopFor('youtube', err);

  assert.equal(u.schedule('youtube').nextAt, Infinity, 'the block itself has no end');
  const view = await u.view();
  assert.equal(view.youtube.nextAt, null, 'no time to show, and none invented');
  assert.match(view.youtube.waitingFor, /connect/i, 'the page says what to do instead');
  assert.equal(view.youtube.connected, false);
});

// node --test src/uploader.limits.test.js    (or: npm test)
//
// How many a day, and how far apart, set from the dashboard instead of from
// .env. The things worth proving: the platform's own ceiling is not a
// suggestion, a refused number changes nothing, an emptied box goes back to
// the file, and a number set here actually reaches the scheduler rather than
// only the panel that shows it.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from './store.js';
import { CEILINGS, SPACING_RANGE, Uploader, checkLimit, fitsInADay, uploadConfig } from './uploader.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-18T18:00:00Z'); // 10:00 Pacific

/**
 * An uploader with nothing in the queue and no .env behind it.
 *
 * cfg is built from an empty environment on purpose: these tests are about
 * what the dashboard does to the numbers, and reading the real environment
 * would make them pass or fail depending on whose machine they run on.
 */
async function uploader(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'limits-'));
  dirs.push(dir);
  const store = new Store(':memory:');
  const u = new Uploader({
    store,
    dir,
    log: () => {},
    cfg: uploadConfig(env),
    now: () => T0,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
  });
  return { u, dir, store };
}

test('a whole number, at least one, and no more than the platform allows', () => {
  assert.equal(checkLimit('youtube', 'perDay', 4), 4);
  assert.equal(checkLimit('youtube', 'perDay', '4'), 4, 'a form sends a string');
  assert.equal(checkLimit('youtube', 'perDay', CEILINGS.youtube.perDay), CEILINGS.youtube.perDay);

  assert.throws(() => checkLimit('youtube', 'perDay', 7), /6 a day is the most/);
  assert.throws(() => checkLimit('youtube', 'perDay', 7), /1,600/, 'and says why, not just no');
  assert.throws(() => checkLimit('tiktok', 'perDay', 6), /5 a day is the most/);
  assert.throws(() => checkLimit('instagram', 'perDay', 51), /50 a day is the most/);

  assert.throws(() => checkLimit('youtube', 'perDay', 0), /use Off/);
  assert.throws(() => checkLimit('youtube', 'perDay', -2), /use Off/);
  assert.throws(() => checkLimit('youtube', 'perDay', 2.5), /whole number/);
  assert.throws(() => checkLimit('youtube', 'perDay', 'lots'), /whole number/);
  assert.throws(() => checkLimit('nowhere', 'perDay', 1), /not built yet/);
  // A number, so it gets past the "is this even a number" check and reaches
  // the one that cares which setting is being asked for.
  assert.throws(() => checkLimit('youtube', 'privacy', 3), /not a limit/);
});

test('an empty box means "whatever .env says", not zero', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(checkLimit('youtube', 'perDay', empty), null);
    assert.equal(checkLimit('youtube', 'spacingMinutes', empty), null);
  }
});

test('the gap is minutes, between a minute and a day', () => {
  assert.equal(checkLimit('youtube', 'spacingMinutes', 360), 360);
  assert.equal(checkLimit('youtube', 'spacingMinutes', SPACING_RANGE.max), 1440);
  assert.throws(() => checkLimit('youtube', 'spacingMinutes', 0), /between 1 and 1440/);
  assert.throws(() => checkLimit('youtube', 'spacingMinutes', 1441), /between 1 and 1440/);
});

test('how many a gap fits in a day, which is what makes the two settings disagree', () => {
  assert.equal(fitsInADay(360), 4, 'six hours apart is four a day, not five');
  assert.equal(fitsInADay(180), 8);
  assert.equal(fitsInADay(1440), 1);
  assert.equal(fitsInADay(500), 2, 'a partial slot is not a slot');
  // Nothing sensible, clamped rather than thrown: this one only feeds a label.
  assert.equal(fitsInADay(0), 1440);
  assert.equal(fitsInADay('x'), 1440);
});

test('a number set on the page reaches the scheduler, not just the panel', async () => {
  const { u } = await uploader();
  assert.equal(u.cfg.youtube.perDay, 5, 'the default, to start with');

  await u.setLimits('youtube', { perDay: 1, spacingMinutes: 360 });
  assert.equal(u.cfg.youtube.perDay, 1);
  assert.equal(u.cfg.youtube.spacingMinutes, 360);

  // The scheduler is the thing that matters: with one a day and one already
  // spent, the next one is tomorrow rather than three hours from now.
  u.store.claimUpload({ platform: 'youtube', file: 'a.mp4', title: 't', at: new Date(T0 - 60_000) });
  const plan = u.schedule('youtube', 'on');
  assert.equal(plan.perDay, 1);
  assert.equal(plan.today, 1);
  assert.match(plan.why, /today's 1 are done/);
  assert.ok(plan.nextAt > T0 + 12 * 3600_000, 'not until the quota day turns over');
});

test('it survives a restart, and the file holds only what was set', async () => {
  const { u, dir, store } = await uploader();
  await u.setLimits('tiktok', { perDay: 4 });

  const saved = JSON.parse(await readFile(join(dir, 'uploads.json'), 'utf8'));
  assert.equal(saved.tiktok.perDay, 4);
  assert.equal(saved.tiktok.spacingMinutes, null, 'untouched stays untouched');
  assert.equal(saved.youtube.perDay, null);

  const again = new Uploader({
    store,
    dir,
    log: () => {},
    cfg: uploadConfig({}),
    now: () => T0,
    settingsPath: join(dir, 'uploads.json'),
  });
  await again.load();
  assert.equal(again.cfg.tiktok.perDay, 4, 'read back');
  assert.equal(again.cfg.tiktok.spacingMinutes, 280, 'still the default');
  assert.equal(again.cfg.youtube.perDay, 5);
});

test('a refused change leaves both numbers as they were', async () => {
  const { u } = await uploader();
  await u.setLimits('youtube', { perDay: 3, spacingMinutes: 200 });

  await assert.rejects(() => u.setLimits('youtube', { perDay: 6, spacingMinutes: 99999 }), /between 1 and 1440/);
  assert.equal(u.cfg.youtube.perDay, 3, 'the good half of a bad pair is not kept');
  assert.equal(u.cfg.youtube.spacingMinutes, 200);
});

test('emptying a box hands the setting back to .env', async () => {
  const { u } = await uploader({ YOUTUBE_PER_DAY: '2' });
  assert.equal(u.cfg.youtube.perDay, 2);

  await u.setLimits('youtube', { perDay: 5 });
  assert.equal(u.cfg.youtube.perDay, 5);

  await u.setLimits('youtube', { perDay: '' });
  assert.equal(u.cfg.youtube.perDay, 2, 'back to the file, not to the built-in default');
});

test('a hand-edited file past the ceiling is ignored, and the server still starts', async () => {
  const { u, dir, store } = await uploader();
  await u.setLimits('youtube', { perDay: 3 });
  const path = join(dir, 'uploads.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.youtube.perDay = 40;
  saved.tiktok.spacingMinutes = 'soon';
  await writeFile(path, JSON.stringify(saved));

  const said = [];
  const again = new Uploader({
    store,
    dir,
    log: (m) => said.push(m),
    cfg: uploadConfig({}),
    now: () => T0,
    settingsPath: path,
  });
  await again.load();
  assert.equal(again.cfg.youtube.perDay, 5, 'the default, not 40');
  assert.equal(again.cfg.tiktok.spacingMinutes, 280);
  assert.ok(
    said.some((m) => /ignoring the saved youtube perDay/.test(m)),
    'and it says so rather than silently dropping it',
  );
});

test('the panel is told the ceiling and what the gap really allows', async () => {
  const { u } = await uploader();
  await u.setLimits('youtube', { perDay: 5, spacingMinutes: 360 });
  const view = await u.view();

  assert.equal(view.youtube.perDay, 5);
  assert.equal(view.youtube.maxPerDay, 6);
  assert.match(view.youtube.capWhy, /quota units/);
  assert.equal(view.youtube.fitsPerDay, 4, 'so the page can say 5 is not really 5');
  assert.equal(view.youtube.limitsSetHere, true);
  assert.deepEqual(view.youtube.spacingRange, SPACING_RANGE);

  assert.equal(view.tiktok.maxPerDay, 5);
  assert.equal(view.tiktok.limitsSetHere, false, 'untouched says so');
});

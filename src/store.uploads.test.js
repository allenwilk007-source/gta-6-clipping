// node --test src/store.uploads.test.js    (or: npm test)
//
// The lifetime upload count behind the panel's "posted" figure. The panel can
// only ever say "today" and "this week" from the schedule, so this is the one
// number that distinguishes a first bad day from a long bad run.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from './store.js';

/** One finished upload, start to end, so the status is the stored one. */
function upload(store, { file, platform, status, at }) {
  store.claimUpload({ file, platform, at: new Date(at) });
  store.finishUpload({ file, platform, status, at: new Date(at) });
}

test('counts the posts that landed and the ones that did not', () => {
  const store = new Store(':memory:');
  const day = (n) => `2026-11-${String(n).padStart(2, '0')}T12:00:00Z`;

  upload(store, { file: 'a.mp4', platform: 'youtube', status: 'done', at: day(3) });
  upload(store, { file: 'b.mp4', platform: 'youtube', status: 'done', at: day(4) });
  upload(store, { file: 'c.mp4', platform: 'youtube', status: 'failed', at: day(5) });
  upload(store, { file: 'd.mp4', platform: 'youtube', status: 'refused', at: day(6) });

  const totals = store.uploadTotals('youtube');
  assert.equal(totals.done, 2);
  // A refusal is a post that did not happen, same as a failure: an owner
  // reading "0 failed" beside four attempts and two posts would be owed an
  // explanation the panel does not give.
  assert.equal(totals.failed, 2);
  assert.equal(totals.since, new Date(day(3)).toISOString());
});

test('a dry run is not a post, and neither is a skip', () => {
  const store = new Store(':memory:');
  upload(store, { file: 'a.mp4', platform: 'youtube:dry', status: 'dry-run', at: '2026-11-03T12:00:00Z' });
  upload(store, { file: 'b.mp4', platform: 'youtube', status: 'skipped', at: '2026-11-04T12:00:00Z' });

  assert.deepEqual(store.uploadTotals('youtube:dry'), { done: 0, failed: 0, since: '2026-11-03T12:00:00.000Z' });
  assert.deepEqual(store.uploadTotals('youtube'), { done: 0, failed: 0, since: '2026-11-04T12:00:00.000Z' });
});

test('each platform is counted on its own, and an unused one is zero', () => {
  const store = new Store(':memory:');
  upload(store, { file: 'a.mp4', platform: 'youtube', status: 'done', at: '2026-11-03T12:00:00Z' });
  upload(store, { file: 'a.mp4', platform: 'tiktok', status: 'done', at: '2026-11-03T12:05:00Z' });
  upload(store, { file: 'b.mp4', platform: 'tiktok', status: 'done', at: '2026-11-04T12:00:00Z' });

  assert.equal(store.uploadTotals('youtube').done, 1);
  assert.equal(store.uploadTotals('tiktok').done, 2);
  // Nothing has ever gone to Instagram, so there is no first post to date.
  assert.deepEqual(store.uploadTotals('instagram'), { done: 0, failed: 0, since: null });
});

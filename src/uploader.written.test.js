// The title a viewer wrote has to survive as far as the post.
//
// It did not. `candidates()` read the autoclips table and handed the uploader
// the file, the sidecar and the score — but nothing about the moment. So
// recopy() rebuilt the copy with `source: 'chat'` and `title: null`, which is
// exactly the shape writtenTitle() refuses, and describe() fell through to its
// last resort every single time. Every short this tool posted was titled after
// what chat did, because the one sentence saying what actually happened was
// loaded from the database, carried as far as the ranking, and then dropped.
//
// The failure was invisible: the titles were well-formed English and the panel
// agreed with the post, so nothing looked broken. Only reading the channel next
// to the clips showed it. Hence this test, which asserts on the content of a
// title rather than that one exists.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { Store } from './store.js';
import { candidates, youtubePost, tiktokPost } from './uploader.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const FILE = 'nickeh30-2942366082-t035042-20261127T210834Z.mp4';
const WRITTEN = 'nick eh30 kills evryone while robbing a bank';

/** A finished short in clips/ready, with the moment it came from in the store. */
async function ready({ title = WRITTEN, source = 'clips' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-written-'));
  dirs.push(dir);
  const saved = {
    caption: `${WRITTEN} \u{1F525}`,
    broadcaster: 'NickEh30',
    game: 'Grand Theft Auto VI',
    link: 'https://www.twitch.tv/videos/2942366082?t=3h50m42s',
  };
  await writeFile(join(dir, FILE), 'not really a video');
  await writeFile(join(dir, FILE.replace(/\.mp4$/, '.json')), JSON.stringify(saved));

  const store = new Store(':memory:');
  const momentId = '44424631:vod:13842';
  store.recordPoll({
    gameId: '1867279146',
    at: new Date('2026-11-27T21:00:00Z'),
    moments: [
      {
        id: momentId,
        broadcasterId: '44424631',
        broadcaster: 'NickEh30',
        vodId: '2942366082',
        offsetSeconds: 13842,
        gameId: '1867279146',
        source,
        title,
        firstClipAt: '2026-11-27T21:00:00.000Z',
      },
    ],
  });
  store.recordAutoclip({
    momentId,
    vodId: '2942366082',
    offsetSeconds: 13842,
    broadcaster: 'NickEh30',
    caption: saved.caption,
    at: new Date('2026-11-27T21:05:00Z'),
  });
  store.finishAutoclip(momentId, {
    status: 'done',
    path: join(dir, FILE),
    review: { score: 71, weak: false },
    at: new Date('2026-11-27T21:08:00Z'),
  });
  return { dir, store };
}

describe('a title somebody wrote reaches the post', () => {
  test('the viewer’s own words become the title, not what chat did', async () => {
    const { dir, store } = await ready();
    const [candidate] = await candidates({ store, dir, platform: 'youtube' });
    assert.ok(candidate, 'the short should be postable');

    const { title } = youtubePost(candidate, { avoid: [] });
    assert.match(title, /Kills Evryone While Robbing a Bank/i);
    // The precise wording of the fallback does not matter; that it was reached
    // does. Chat is the subject only when nothing better is known.
    assert.doesNotMatch(title, /chat/i);
  });

  test('the record travels with the candidate, so nothing has to re-read the store', async () => {
    const { dir, store } = await ready();
    const [candidate] = await candidates({ store, dir, platform: 'youtube' });
    assert.equal(candidate.record.title, WRITTEN);
    assert.equal(candidate.record.source, 'clips');
  });

  test('TikTok carries it too, not just YouTube', async () => {
    const { dir, store } = await ready();
    const [candidate] = await candidates({ store, dir, platform: 'tiktok' });
    assert.match(tiktokPost(candidate, { avoid: [] }).title, /kills evryone/i);
  });

  test('a moment from chat has no written title, and asks instead of inventing one', async () => {
    // source 'chat' means nobody clipped it and nobody titled it: the stream
    // title is not a description of the moment, so writtenTitle() refuses it.
    const { dir, store } = await ready({ source: 'chat', title: 'FAMILY FRIENDLY GTA 6! (Day 10)' });
    const [candidate] = await candidates({ store, dir, platform: 'youtube' });
    const { title } = youtubePost(candidate, { avoid: [] });
    assert.doesNotMatch(title, /family friendly/i, 'the stream title is not what happened');
    assert.match(title, /\?!/, 'with nothing known, the title asks');
  });
});

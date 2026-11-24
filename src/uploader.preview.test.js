// The panel and the post must name the same title.
//
// They did not. The panel showed `saved.platforms[...]`, the text written
// beside the short when it was cut; the uploader throws that away and rebuilds
// the wording with recopy() at post time. So the page named a title that never
// went out, and reading the page told you nothing about what YouTube received.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { Store } from './store.js';
import { Uploader, uploadConfig, youtubePost } from './uploader.js';
import { recopy } from './recopy.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-20T08:00:00Z');

const uploaderOn = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-preview-'));
  dirs.push(dir);
  return new Uploader({
    store: new Store(':memory:'),
    dir,
    log: () => {},
    now: () => T0,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
    cfg: uploadConfig({}),
  });
};

// A short as it sits in clips/ready: the sidecar the uploader reads, with the
// stale wording from cut time still in `platforms`.
const candidate = {
  file: 'caseoh_-123-t10-20261120T030000Z.mp4',
  score: 92,
  saved: {
    caption: '"My car is impounded" \u{1F92F}',
    broadcaster: 'caseoh_',
    game: 'Grand Theft Auto VI',
    link: 'https://www.twitch.tv/videos/123?t=0h00m10s',
    platforms: {
      youtube: 'Caseoh_ Did Not See This Coming in GTA 6 #Shorts #GTA6 #caseoh_\n\nCredit: caseoh_ on Twitch',
      tiktok: 'something stale',
    },
  },
};

describe('the queue preview names the title that will actually be posted', () => {
  test('it rebuilds the wording rather than reading the stale sidecar', async () => {
    const uploader = await uploaderOn();
    const preview = uploader.previewTitle('youtube', candidate, []);
    const posted = youtubePost(candidate, { avoid: [] }).title;
    assert.equal(preview, posted);
  });

  test('so it is not the text stored when the short was cut', async () => {
    const uploader = await uploaderOn();
    const preview = uploader.previewTitle('youtube', candidate, []);
    assert.notEqual(preview, candidate.saved.platforms.youtube.split('\n')[0]);
    assert.match(preview, /My car is impounded/);
  });

  test('it honours the same avoid list the posting path uses', async () => {
    const uploader = await uploaderOn();
    const avoid = [recopy({ file: candidate.file, saved: candidate.saved, avoid: [] }).platforms.youtube.split('\n')[0].replace(/\s#.*$/, '')];
    assert.equal(uploader.previewTitle('youtube', candidate, avoid), youtubePost(candidate, { avoid }).title);
  });

  test('a sidecar it cannot rebuild falls back rather than failing the panel', async () => {
    const uploader = await uploaderOn();
    const broken = { file: 'x.mp4', saved: { caption: 'kept', platforms: { youtube: 'kept line\nmore' } } };
    assert.equal(typeof uploader.previewTitle('youtube', broken, []), 'string');
  });

  test('every platform is rebuilt, not just YouTube', async () => {
    const uploader = await uploaderOn();
    assert.notEqual(uploader.previewTitle('tiktok', candidate, []), 'something stale');
  });
});

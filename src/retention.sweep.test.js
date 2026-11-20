// The side folders: clips/shelved and clips/rejected.
//
// prune() looks after clips/ready, where a short waits to be posted and a
// download has to survive. These two are dead ends — nothing reads them — and
// both grew without limit until this existed.

import assert from 'node:assert/strict';
import { test, describe, after } from 'node:test';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { Retention, retentionConfig } from './retention.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-20T18:00:00Z');

// The render stamp in the name is what madeAt() reads, so age is set by name.
const stamped = (name, hoursAgo) => {
  const at = new Date(NOW - hoursAgo * HOUR);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const s =
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `T${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z`;
  return `${name}-${s}.mp4`;
};

const build = async ({ sideHours = 24 } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'retention-sweep-'));
  dirs.push(root);
  const ready = join(root, 'ready');
  const shelved = join(root, 'shelved');
  const rejected = join(root, 'rejected');
  for (const d of [ready, shelved, rejected]) await mkdir(d, { recursive: true });
  const retention = new Retention({
    dir: ready,
    sideDirs: [shelved, rejected],
    sideHours,
    keptPath: join(root, 'kept.json'),
    log: () => {},
    now: () => NOW,
  });
  return { root, ready, shelved, rejected, retention };
};

describe('config', () => {
  test('side folders default to a day', () => {
    assert.equal(retentionConfig({}).sideHours, 24);
  });

  test('and can be set, including off', () => {
    assert.equal(retentionConfig({ CLIPS_KEEP_HOURS: '6' }).sideHours, 6);
    assert.equal(retentionConfig({ CLIPS_KEEP_HOURS: '0' }).sideHours, 0);
  });

  test('nonsense falls back rather than deleting on a NaN', () => {
    assert.equal(retentionConfig({ CLIPS_KEEP_HOURS: 'soon' }).sideHours, 24);
  });
});

describe('sweep', () => {
  test('clears what is older than the window', async () => {
    const { shelved, rejected, retention } = await build();
    await writeFile(join(shelved, stamped('old', 30)), 'x');
    await writeFile(join(rejected, stamped('older', 48)), 'x');
    const result = await retention.sweep();
    assert.equal(result.deleted, 2);
    assert.deepEqual(await readdir(shelved), []);
    assert.deepEqual(await readdir(rejected), []);
  });

  test('leaves what is still inside it', async () => {
    const { shelved, retention } = await build();
    const fresh = stamped('fresh', 3);
    await writeFile(join(shelved, fresh), 'x');
    await retention.sweep();
    assert.deepEqual(await readdir(shelved), [fresh]);
  });

  test('takes the sidecars too, not just the video', async () => {
    const { shelved, retention } = await build();
    const name = stamped('gone', 30);
    for (const ext of ['.mp4', '.txt', '.json']) {
      await writeFile(join(shelved, name.replace(/\.mp4$/, ext)), 'x');
    }
    await retention.sweep();
    assert.deepEqual(await readdir(shelved), []);
  });

  test('never touches clips/ready, whatever its age', async () => {
    const { ready, retention } = await build();
    const ancient = stamped('ancient', 500);
    await writeFile(join(ready, ancient), 'x');
    await retention.sweep();
    assert.deepEqual(await readdir(ready), [ancient]);
  });

  test('set to 0 it deletes nothing at all', async () => {
    const { shelved, retention } = await build({ sideHours: 0 });
    const old = stamped('old', 900);
    await writeFile(join(shelved, old), 'x');
    const result = await retention.sweep();
    assert.equal(result.deleted, 0);
    assert.deepEqual(await readdir(shelved), [old]);
  });

  test('a folder that is not there is the same as an empty one', async () => {
    const { root, retention } = await build();
    retention.sideDirs = [join(root, 'nowhere')];
    const result = await retention.sweep();
    assert.equal(result.deleted, 0);
  });

  test('reports the bytes it freed, for the log to be honest about', async () => {
    const { shelved, retention } = await build();
    await writeFile(join(shelved, stamped('big', 30)), 'x'.repeat(2048));
    const result = await retention.sweep();
    assert.equal(result.bytes, 2048);
  });
});

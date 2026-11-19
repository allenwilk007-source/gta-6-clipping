import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Retention, madeAt, retentionConfig } from './retention.js';

const NOW = Date.UTC(2026, 10, 19, 16, 0, 0);
const OLD = 'xqc-2932305259-t000100-20261118T120000Z'; // 28h before NOW
const NEW = 'xqc-2932305259-t000200-20261119T120000Z'; // 4h before NOW

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'));
  for (const base of [OLD, NEW, `${OLD.replace('t000100', 't000300')}`, `${OLD.replace('t000100', 't000400')}`]) {
    for (const ext of ['.mp4', '.txt', '.json']) writeFileSync(join(dir, base + ext), 'x');
  }
  return dir;
}

const make = (dir, extra = {}) =>
  new Retention({ dir, keepHours: 24, keptPath: join(dir, 'kept.json'), now: () => NOW, ...extra });

test('a short not downloaded within the window is deleted with its post copy', async () => {
  const dir = folder();
  const kept = OLD.replace('t000100', 't000300');
  const uploading = OLD.replace('t000100', 't000400');
  const r = make(dir, { busy: () => [`${uploading}.mp4`] });
  r.keep(`${kept}.mp4`);

  const result = await r.prune();
  assert.equal(result.deleted, 1);
  for (const ext of ['.mp4', '.txt', '.json']) assert.equal(existsSync(join(dir, OLD + ext)), false, ext);
  // New enough, downloaded, or mid-upload: all still there.
  for (const base of [NEW, kept, uploading]) assert.ok(existsSync(join(dir, `${base}.mp4`)), base);
});

test('downloads are remembered across restarts', async () => {
  const dir = folder();
  make(dir).keep(`/shorts/${OLD}.mp4`);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'kept.json'), 'utf8')).files, [`${OLD}.mp4`]);
  const again = make(dir);
  assert.ok(again.isKept(`${OLD}.mp4`));
  assert.equal((await again.prune()).deleted, 2); // the other two old ones
  assert.ok(existsSync(join(dir, `${OLD}.mp4`)));
});

test('an unreadable kept list deletes nothing rather than guessing', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'kept.json'), '{not json');
  const r = make(dir);
  assert.equal((await r.prune()).deleted, 0);
  assert.ok(existsSync(join(dir, `${OLD}.mp4`)));
});

test('0 hours keeps everything', async () => {
  const dir = folder();
  const r = make(dir, { keepHours: 0 });
  assert.equal((await r.prune()).deleted, 0);
  assert.equal(r.expiresAt(`${NEW}.mp4`, NOW), null);
  assert.equal(retentionConfig({ SHORTS_KEEP_HOURS: '0' }).keepHours, 0);
  assert.equal(retentionConfig({}).keepHours, 6);
});

test('age comes from the name, and the countdown says when', () => {
  assert.equal(madeAt(`${NEW}.mp4`, 0), Date.UTC(2026, 10, 19, 12, 0, 0));
  assert.equal(madeAt('odd.mp4', 1234), 1234);
  const r = make(mkdtempSync(join(tmpdir(), 'retention-')));
  assert.equal(r.expiresAt(`${NEW}.mp4`, 0), Date.UTC(2026, 10, 20, 12, 0, 0));
  r.keep(`${NEW}.mp4`);
  assert.equal(r.expiresAt(`${NEW}.mp4`, 0), null);
});

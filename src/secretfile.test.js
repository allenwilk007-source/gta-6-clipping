// node --test src/secretfile.test.js    (or: npm test)
//
// The three platforms each wrote their refresh token through the same four
// lines, and the same hole: the temp file was always `<path>.tmp`, and a
// file's mode is only applied when it is created. A `.tmp` left behind by a
// save that died before its rename kept whatever permissions it already had,
// and the next token went straight into it.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { writeSecret } from './secretfile.js';

const dir = mkdtempSync(join(tmpdir(), 'secretfile-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the token is written and reads back', async () => {
  const path = join(dir, 'a.json');
  await writeSecret(path, { refreshToken: 'abc', connectedAt: '2026-01-01' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    refreshToken: 'abc', connectedAt: '2026-01-01',
  });
});

test('a leftover temp file does not donate its permissions', async () => {
  const path = join(dir, 'b.json');
  const temp = `${path}.tmp`;
  // What a save that died before its rename leaves behind: world-readable.
  writeFileSync(temp, '{"refreshToken":"stale"}');
  chmodSync(temp, 0o666);

  await writeSecret(path, { refreshToken: 'fresh' });

  assert.equal(JSON.parse(readFileSync(path, 'utf8')).refreshToken, 'fresh');
  assert.equal(existsSync(temp), false, 'the temp file is consumed by the rename');

  // Only meaningful where the platform has permission bits at all. Windows
  // maps mode to the read-only attribute and takes the directory's ACL, which
  // is a real limit and is stated in PRIVACY.md rather than hidden here.
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('overwriting an existing token leaves no temp file behind', async () => {
  const path = join(dir, 'c.json');
  await writeSecret(path, { refreshToken: 'one' });
  await writeSecret(path, { refreshToken: 'two' });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).refreshToken, 'two');
  assert.equal(existsSync(`${path}.tmp`), false);
});

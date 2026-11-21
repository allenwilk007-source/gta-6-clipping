// The supervisor is the thing that is supposed to be running when nobody is
// watching, so "it probably restarts" is not good enough. These run it for
// real against a script that fails on purpose.

import assert from 'node:assert/strict';
import { test, describe, after } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const SUPERVISOR = new URL('../supervise.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Run the supervisor against `script` for `ms`, and return what it printed. */
async function supervise(script, ms, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervise-'));
  dirs.push(dir);
  const target = join(dir, 'target.mjs');
  const counter = join(dir, 'runs.txt');
  await writeFile(target, script.replace('COUNTER', JSON.stringify(counter)));

  const child = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SUPERVISE_TARGET: target, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));

  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, ms));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (!child.killed) child.kill('SIGKILL');

  let runs = 0;
  try {
    runs = (await readFile(counter, 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch {
    /* never ran */
  }
  return { out, runs };
}

// Writes a line and dies, every time.
const ALWAYS_FAILS = `
import { appendFileSync } from 'node:fs';
appendFileSync(COUNTER, 'run\\n');
process.exit(1);
`;

// Writes a line and exits cleanly, which is a decision rather than a failure.
const EXITS_CLEANLY = `
import { appendFileSync } from 'node:fs';
appendFileSync(COUNTER, 'run\\n');
process.exit(0);
`;

describe('the supervisor', () => {
  test('starts the server it is given', async () => {
    const { runs } = await supervise(ALWAYS_FAILS, 1500);
    assert.ok(runs >= 1, `expected it to run at least once, ran ${runs}`);
  });

  test('restarts it after a crash', async () => {
    const { runs, out } = await supervise(ALWAYS_FAILS, 4000);
    assert.ok(runs >= 2, `expected a restart, ran ${runs} time(s)\n${out}`);
    assert.match(out, /restarting in/);
  });

  test('says why it stopped, so a log explains itself', async () => {
    const { out } = await supervise(ALWAYS_FAILS, 2500);
    assert.match(out, /server stopped \(code 1\)/);
  });

  test('backs off rather than spinning on a server that cannot start', async () => {
    const { runs } = await supervise(ALWAYS_FAILS, 5000);
    // 1s, then 2s, then 4s: a handful in five seconds, not hundreds.
    assert.ok(runs <= 6, `expected backoff to limit restarts, ran ${runs} times`);
  });

  test('does NOT restart a clean exit, because that was a decision', async () => {
    const { runs, out } = await supervise(EXITS_CLEANLY, 3000);
    assert.equal(runs, 1, `a clean exit should not be restarted, ran ${runs}`);
    assert.match(out, /not restarting/);
  });
});

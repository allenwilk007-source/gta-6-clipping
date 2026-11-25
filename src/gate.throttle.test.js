// node --test src/gate.throttle.test.js    (or: npm test)
//
// The password comparison is constant-time, which closes the timing channel
// and does nothing about volume. Once DASHBOARD_HOSTS made a tunnel a
// supported way to reach the dashboard, guesses became cheap and unlimited.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createThrottle } from './gate.js';

/** A clock the test moves by hand, so nothing here waits on real seconds. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test('the first few wrong guesses cost nothing', () => {
  // Someone mistyping their own password should not be punished for it.
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 5 });
  for (let i = 0; i < 5; i++) {
    assert.equal(gate.fail(), 0, `guess ${i + 1} should be free`);
    assert.equal(gate.waitFor(), 0);
  }
});

test('after that the wait doubles', () => {
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 5, base: 1000, ceiling: 30_000 });
  for (let i = 0; i < 5; i++) gate.fail();

  assert.equal(gate.fail(), 1000);
  assert.equal(gate.waitFor(), 1000);
  c.tick(1000);
  assert.equal(gate.waitFor(), 0);

  assert.equal(gate.fail(), 2000);
  c.tick(2000);
  assert.equal(gate.fail(), 4000);
  c.tick(4000);
  assert.equal(gate.fail(), 8000);
});

test('the wait stops growing, so nobody is locked out forever', () => {
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 0, base: 1000, ceiling: 30_000 });
  let wait = 0;
  for (let i = 0; i < 20; i++) {
    wait = gate.fail();
    c.tick(wait);
  }
  assert.equal(wait, 30_000);
});

test('a guess during the wait does not reset the clock', () => {
  // Otherwise hammering it would be rewarded: every attempt would restart a
  // fresh short window instead of landing on a longer one.
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 0, base: 1000 });
  gate.fail();
  c.tick(400);
  assert.equal(gate.waitFor(), 600);
  gate.fail();
  assert.equal(gate.waitFor(), 2000, 'the next window is longer, not shorter');
});

test('the right password clears it', () => {
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 2, base: 1000 });
  gate.fail(); gate.fail(); gate.fail();
  assert.ok(gate.waitFor() > 0);

  gate.pass();
  assert.equal(gate.waitFor(), 0);
  assert.equal(gate.failures, 0);
  // And the free allowance is back, rather than the next slip costing a wait.
  assert.equal(gate.fail(), 0);
});

test('guesses are slow enough to be useless', () => {
  // The point of the whole thing: how many tries an hour does an attacker get
  // once the free ones are spent?
  const c = clock();
  const gate = createThrottle({ now: c.now, free: 5, base: 1000, ceiling: 30_000 });
  let tries = 0;
  const hour = 60 * 60 * 1000;
  const end = c.now() + hour;
  while (c.now() < end) {
    const wait = gate.fail();
    tries += 1;
    c.tick(wait || 1);
  }
  assert.ok(tries < 140, `${tries} guesses an hour is still too many`);
});

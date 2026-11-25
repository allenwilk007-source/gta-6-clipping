// node --test src/gate.host.test.js    (or: npm test)
//
// Who can reach the dashboard, as opposed to who may use it once they have.
//
// Node's listen() answers on every interface unless told otherwise, so for a
// long time a fresh install put the upload switches, the channel list and the
// connected accounts in front of everyone on the same Wi-Fi. The password
// check was written for tunnels and defaults to off, so nothing stopped it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLocalHost, refuseOpenDashboard } from './gate.js';

test('only this machine counts as local', () => {
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('::1'), true);
  // Unset means the default, which is localhost.
  assert.equal(isLocalHost(''), true);
  assert.equal(isLocalHost(undefined), true);

  assert.equal(isLocalHost('0.0.0.0'), false);
  assert.equal(isLocalHost('::'), false);
  assert.equal(isLocalHost('192.168.1.14'), false);
});

test('a local dashboard needs no password', () => {
  assert.equal(refuseOpenDashboard({ host: '127.0.0.1', password: '' }), null);
  assert.equal(refuseOpenDashboard({ host: undefined, password: '' }), null);
});

test('a networked dashboard without a password is refused, not warned about', () => {
  const why = refuseOpenDashboard({ host: '0.0.0.0', password: '' });
  assert.match(why, /0\.0\.0\.0/);
  assert.match(why, /DASHBOARD_PASSWORD/);
  // The message has to say how to get out of it, or the only obvious escape
  // is to put a password in and still be on the network.
  assert.match(why, /leave HOST unset/);
});

test('a networked dashboard with a password may start', () => {
  assert.equal(refuseOpenDashboard({ host: '0.0.0.0', password: 'hunter2' }), null);
  assert.equal(refuseOpenDashboard({ host: '192.168.1.14', password: 'hunter2' }), null);
});

test('whitespace around a host does not smuggle it past the check', () => {
  assert.equal(isLocalHost('  127.0.0.1  '), true);
  assert.equal(refuseOpenDashboard({ host: '  0.0.0.0 ', password: '' }) !== null, true);
});

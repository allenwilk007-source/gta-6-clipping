// node --test src/gate.csrf.test.js    (or: npm test)
//
// Being on localhost was mistaken for being private.
//
// The operator's own browser can reach 127.0.0.1 as easily as any other
// address, and it attaches the credentials it has cached for that origin
// without being asked. So any page the operator happens to visit could post a
// form here and flip the upload switches on their real YouTube channel, add a
// streamer to the watch list, or delete the saved token. A password does not
// help: the browser sends it.
//
// Three checks stand between "the operator asked for this" and "a web page
// asked for it in their name".

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostAllowed, isJsonBody, refuseOpenDashboard, sameOrigin } from './gate.js';

const LOCAL = { host: '127.0.0.1', port: 3000 };
const post = (headers) => ({ method: 'POST', headers });

// --- the Host header ---------------------------------------------------------

test('only names belonging to this machine are answered', () => {
  assert.equal(hostAllowed('localhost:3000', LOCAL), true);
  assert.equal(hostAllowed('127.0.0.1:3000', LOCAL), true);
  assert.equal(hostAllowed('[::1]:3000', LOCAL), true);
  assert.equal(hostAllowed('localhost', LOCAL), true);
});

test('a domain pointed at this machine is refused', () => {
  // DNS rebinding: attacker.com resolves to 127.0.0.1 a second after the page
  // loads, and its script is suddenly same-origin with the dashboard. The
  // socket is still local; the browser simply walked through the door. Then
  // it can READ - stats, the channel list, the rendered shorts.
  assert.equal(hostAllowed('attacker.com:3000', LOCAL), false);
  assert.equal(hostAllowed('clip-dashboard.evil.test:3000', LOCAL), false);
  assert.equal(hostAllowed('', LOCAL), false);
  assert.equal(hostAllowed(undefined, LOCAL), false);
});

test('a host the operator deliberately opened is answered', () => {
  const opened = { host: '192.168.1.14', port: 3000 };
  assert.equal(hostAllowed('192.168.1.14:3000', opened), true);
  // And localhost still works on the same server.
  assert.equal(hostAllowed('localhost:3000', opened), true);
  assert.equal(hostAllowed('attacker.com:3000', opened), false);
});

// --- where the request came from ---------------------------------------------

test('reading is never blocked, whoever asked', () => {
  // A cross-site GET can be made to happen by any page and reveals nothing
  // the browser will hand back, so refusing them buys nothing and breaks
  // ordinary use.
  assert.equal(sameOrigin({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, LOCAL), true);
  assert.equal(sameOrigin({ method: 'HEAD', headers: {} }, LOCAL), true);
});

test('a write from another site is refused', () => {
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'cross-site' }), LOCAL), false);
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'same-site' }), LOCAL), false);
  assert.equal(sameOrigin(post({ origin: 'https://attacker.com' }), LOCAL), false);
  assert.equal(sameOrigin(post({ origin: 'http://attacker.com:3000' }), LOCAL), false);
});

test('a write from the dashboard itself goes through', () => {
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'same-origin' }), LOCAL), true);
  // "none" is the operator typing the address or using a bookmark.
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'none' }), LOCAL), true);
  assert.equal(sameOrigin(post({ origin: 'http://localhost:3000' }), LOCAL), true);
  assert.equal(sameOrigin(post({ origin: 'http://127.0.0.1:3000' }), LOCAL), true);
});

test('the right host on the wrong port is still another origin', () => {
  assert.equal(sameOrigin(post({ origin: 'http://localhost:9999' }), LOCAL), false);
});

test('a caller that is not a browser is left alone', () => {
  // curl and the project's own scripts send neither header. Nothing is
  // defended by refusing them: anyone who can run a command on this machine
  // can read .env directly.
  assert.equal(sameOrigin(post({}), LOCAL), true);
});

test('a malformed Origin is refused rather than parsed hopefully', () => {
  assert.equal(sameOrigin(post({ origin: 'not a url' }), LOCAL), false);
  assert.equal(sameOrigin(post({ origin: '://' }), LOCAL), false);
});

// --- what the body claims to be ----------------------------------------------

test('only application/json is read as a body', () => {
  assert.equal(isJsonBody('application/json'), true);
  assert.equal(isJsonBody('application/json; charset=utf-8'), true);
  assert.equal(isJsonBody('  APPLICATION/JSON  '), true);
});

test('the three content types a cross-site form can send are refused', () => {
  // text/plain is the one that matters: a form can be built whose single
  // name=value pair spells a JSON object, which sails past a parser that only
  // calls JSON.parse. The other two cannot spell one, but there is no reason
  // to accept them either.
  assert.equal(isJsonBody('text/plain'), false);
  assert.equal(isJsonBody('application/x-www-form-urlencoded'), false);
  assert.equal(isJsonBody('multipart/form-data; boundary=x'), false);
  assert.equal(isJsonBody(''), false);
  assert.equal(isJsonBody(undefined), false);
});

test('a type that merely starts with the right word is refused', () => {
  assert.equal(isJsonBody('application/jsonp'), false);
  assert.equal(isJsonBody('text/json'), false);
});

// --- a tunnel the operator named -------------------------------------------

test('a tunnel the operator named is answered, and nothing else is', () => {
  // Without this, turning on the Host check would have broken every working
  // remote setup: a tunnel arrives carrying its own name, which is the point
  // of one. The operator says which, rather than the check being dropped.
  const tunnel = { host: '127.0.0.1', extra: ['feed.example.ngrok-free.dev'] };
  assert.equal(hostAllowed('feed.example.ngrok-free.dev', tunnel), true);
  assert.equal(hostAllowed('feed.example.ngrok-free.dev:443', tunnel), true);
  assert.equal(hostAllowed('localhost:3000', tunnel), true);
  // A name they did not list is still a stranger.
  assert.equal(hostAllowed('attacker.com', tunnel), false);
  assert.equal(hostAllowed('evil.ngrok-free.dev', tunnel), false);
});

test('naming a tunnel without a password is refused', () => {
  // The socket is on localhost, which looks safe and is not: something is
  // carrying the internet to it.
  const why = refuseOpenDashboard({
    host: '127.0.0.1', password: '', extra: ['feed.example.ngrok-free.dev'],
  });
  assert.match(why, /DASHBOARD_HOSTS/);
  assert.match(why, /DASHBOARD_PASSWORD/);

  assert.equal(refuseOpenDashboard({
    host: '127.0.0.1', password: 'hunter2', extra: ['feed.example.ngrok-free.dev'],
  }), null);
  // Naming none is the ordinary local case and needs nothing.
  assert.equal(refuseOpenDashboard({ host: '127.0.0.1', password: '', extra: [] }), null);
});

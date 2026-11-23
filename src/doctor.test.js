import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { nodeCheck, pathCheck, passwordCheck, platformChecks, portCheck, render, summary, toolCheck, twitchCheck } from './doctor.js';

test('an old Node is a failure that names the version it needs', () => {
  const row = nodeCheck('v18.20.0', 22);
  assert.equal(row.state, 'fail');
  assert.match(row.detail, /22 or newer/);
  assert.match(row.fix, /nodejs\.org/);
});

test('a new enough Node passes and says which it found', () => {
  const row = nodeCheck('v24.19.0', 22);
  assert.equal(row.state, 'ok');
  assert.equal(row.detail, 'v24.19.0');
});

test('an unreadable version is a note, not a failure', () => {
  // Being unable to parse it is not evidence that it is wrong.
  assert.equal(nodeCheck('banana', 22).state, 'warn');
});

test('a tool that answered at all counts as present', () => {
  // Several of these answer --version on stderr and exit non-zero doing it.
  const row = toolCheck('ffmpeg', { ran: true, firstLine: 'ffmpeg version 7.1' });
  assert.equal(row.state, 'ok');
  assert.equal(row.detail, 'ffmpeg version 7.1');
});

test('a missing tool fails and carries the way out', () => {
  const row = toolCheck('ffmpeg', { ran: false, error: 'not on PATH' }, 'install ffmpeg');
  assert.equal(row.state, 'fail');
  assert.equal(row.fix, 'install ffmpeg');
});

test('no dashboard password is a note that asks the one question only the owner can answer', () => {
  const row = passwordCheck('');
  assert.equal(row.state, 'warn');
  assert.match(row.detail, /anyone who can reach this port/);
  assert.match(row.fix, /tunnel|forwarded port/);
});

test('a dashboard password that is set is never echoed back', () => {
  const row = passwordCheck('correct-horse-battery-staple');
  assert.equal(row.state, 'ok');
  assert.doesNotMatch(JSON.stringify(row), /correct-horse/);
});

test('Twitch keys are reported as set, never by value', () => {
  const row = twitchCheck({ TWITCH_CLIENT_ID: 'abc123realkey', TWITCH_CLIENT_SECRET: 'shhsecret' });
  assert.equal(row.state, 'ok');
  assert.doesNotMatch(JSON.stringify(row), /abc123realkey|shhsecret/);
});

test('one missing Twitch key is named, both are named together', () => {
  assert.match(twitchCheck({ TWITCH_CLIENT_ID: 'x' }).detail, /TWITCH_CLIENT_SECRET is missing/);
  const both = twitchCheck({});
  assert.match(both.detail, /TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are/);
  assert.equal(both.state, 'fail');
});

test('whitespace is not a credential', () => {
  assert.equal(twitchCheck({ TWITCH_CLIENT_ID: '   ', TWITCH_CLIENT_SECRET: '   ' }).state, 'fail');
});

test('with no platform configured nothing fails, but the silence is said out loud', () => {
  const rows = platformChecks({});
  assert.ok(rows.every((row) => row.state !== 'fail'));
  const note = rows.find((row) => row.name === 'Somewhere to post');
  assert.ok(note, 'expected a row saying it will post nothing');
  assert.match(note.detail, /post nothing/);
});

test('one configured platform is enough to drop the nowhere-to-post note', () => {
  const rows = platformChecks({ YOUTUBE_CLIENT_ID: 'id', YOUTUBE_CLIENT_SECRET: 'secret' });
  assert.equal(
    rows.find((row) => row.name === 'YouTube').state,
    'ok',
  );
  assert.equal(rows.find((row) => row.name === 'Somewhere to post'), undefined);
});

test('half a platform is a failure, because it looks configured and is not', () => {
  const row = platformChecks({ TIKTOK_CLIENT_KEY: 'key' }).find((r) => r.name === 'TikTok');
  assert.equal(row.state, 'fail');
  assert.match(row.detail, /TIKTOK_CLIENT_SECRET is missing/);
});

test('platform keys never reach the output either', () => {
  const rows = platformChecks({ YOUTUBE_CLIENT_ID: 'leakme', YOUTUBE_CLIENT_SECRET: 'leakmetoo' });
  assert.doesNotMatch(JSON.stringify(rows), /leakme/);
});

test('a folder that is not there yet is a note; one that cannot be written is a failure', () => {
  assert.equal(pathCheck('Data folder', '/d', { exists: false, writable: false }).state, 'warn');
  assert.equal(pathCheck('Data folder', '/d', { exists: true, writable: false }).state, 'fail');
  assert.equal(pathCheck('Data folder', '/d', { exists: true, writable: true }).state, 'ok');
});

test('a taken port is read as a copy already running', () => {
  const row = portCheck(3000, false);
  assert.equal(row.state, 'warn');
  assert.match(row.fix, /already running/);
});

test('only a failure sets a non-zero exit code', () => {
  assert.equal(summary([{ state: 'ok' }, { state: 'warn' }]).exitCode, 0);
  assert.equal(summary([{ state: 'ok' }, { state: 'fail' }]).exitCode, 1);
});

test('the closing line counts what it found', () => {
  assert.match(summary([{ state: 'fail' }, { state: 'fail' }]).line, /2 things have to be fixed/);
  assert.match(summary([{ state: 'warn' }]).line, /Nothing is broken\. 1 thing/);
  assert.equal(summary([{ state: 'ok' }]).line, 'Ready.');
});

test('the fix is printed under the row it belongs to', () => {
  const out = render([{ name: 'ffmpeg', state: 'fail', detail: 'not on PATH', fix: 'install it' }]);
  const [first, second] = out.split('\n');
  assert.match(first, /FAIL.*ffmpeg.*not on PATH/);
  assert.match(second, /-> install it/);
});

test('a row with nothing to do takes one line', () => {
  assert.equal(render([{ name: 'Node', state: 'ok', detail: 'v24' }]).split('\n').length, 1);
});

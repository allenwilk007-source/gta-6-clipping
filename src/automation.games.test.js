// node --test src/automation.games.test.js    (or: npm test)
//
// Choosing what to clip, not just who. The channel list has always been
// editable from the panel; the category list came from the environment and
// could only be changed by editing .env and restarting.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_GAMES, applyChange, normalizeGame, sanitizeSettings } from './automation.js';

const start = { enabled: true, channels: ['xqc'], games: ['Grand Theft Auto VI'], music: false, scope: 'channels' };

test('a category is kept as it was typed, not lowercased like a login', () => {
  // A channel login is an identifier; a category is a name shown back to the
  // person who typed it and resolved against Twitch by name.
  assert.equal(normalizeGame('Grand Theft Auto VI'), 'Grand Theft Auto VI');
  assert.equal(normalizeGame('  Just   Chatting  '), 'Just Chatting');
  assert.equal(normalizeGame(''), '');
  assert.equal(normalizeGame('   '), '');
  assert.equal(normalizeGame(null), '');
  assert.equal(normalizeGame('x'.repeat(81)), '');
});

test('games are added and removed from the panel', () => {
  const added = applyChange(start, { addGame: 'Fortnite' });
  assert.deepEqual(added.games, ['Grand Theft Auto VI', 'Fortnite']);

  const removed = applyChange(added, { removeGame: 'Grand Theft Auto VI' });
  assert.deepEqual(removed.games, ['Fortnite']);
});

test('the same game twice is one game, whatever the capitals', () => {
  const once = applyChange(start, { addGame: 'Fortnite' });
  const twice = applyChange(once, { addGame: 'fortnite' });
  assert.deepEqual(twice.games, ['Grand Theft Auto VI', 'Fortnite']);
  // And removing is just as forgiving about case.
  assert.deepEqual(applyChange(twice, { removeGame: 'FORTNITE' }).games, ['Grand Theft Auto VI']);
});

test('the last game cannot be taken away', () => {
  // An empty list would quietly mean "every category on Twitch", which is not
  // a setting anybody means to reach by deleting entries one at a time.
  assert.throws(() => applyChange(start, { removeGame: 'Grand Theft Auto VI' }), /at least one game/i);
});

test('nonsense is refused rather than saved', () => {
  assert.throws(() => applyChange(start, { addGame: '   ' }), /not a category name/);
  assert.throws(() => applyChange(start, { addGame: '' }), /not a category name/);
});

test('there is a ceiling on how many', () => {
  let settings = start;
  for (let i = 1; i < MAX_GAMES; i++) settings = applyChange(settings, { addGame: `Game ${i}` });
  assert.equal(settings.games.length, MAX_GAMES);
  assert.throws(() => applyChange(settings, { addGame: 'One Too Many' }), /at most 10 games/);
});

test('changing games leaves the channels alone', () => {
  const after = applyChange(start, { addGame: 'Fortnite' });
  assert.deepEqual(after.channels, ['xqc']);
  assert.equal(after.enabled, true);
  assert.equal(after.scope, 'channels');
});

test('a saved file with no games falls back instead of watching nothing', () => {
  const fallback = { enabled: false, channels: [], games: ['Grand Theft Auto VI'], music: false, scope: 'channels' };
  assert.deepEqual(sanitizeSettings({ games: [] }, fallback).games, ['Grand Theft Auto VI']);
  assert.deepEqual(sanitizeSettings({ games: ['', '  '] }, fallback).games, ['Grand Theft Auto VI']);
  // More than the ceiling is trimmed rather than rejected: the file may have
  // been hand-edited, and refusing to start over it would help nobody.
  const many = Array.from({ length: MAX_GAMES + 4 }, (_, i) => `Game ${i}`);
  assert.equal(sanitizeSettings({ games: many }, fallback).games.length, MAX_GAMES);
});

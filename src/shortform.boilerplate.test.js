// node --test src/shortform.boilerplate.test.js    (or: npm test)
//
// A clip title written by a person about this moment is the best thing to put
// on a short, so it outranks everything this tool writes itself. The trap is
// that most Twitch clips are titled by BOTS, and a bot's title says nothing:
// "AutoClipper Highlight" beat "OhnePixel did not see this coming in GTA 6"
// onto a real upload. These cover the line between the two.

import assert from 'node:assert/strict';
import test from 'node:test';

import { describe, isBoilerplateTitle, titleFor, writtenTitle, youtubeTitle } from './shortform.js';

const at = (title, extra = {}) => ({
  id: 'm1',
  broadcaster: 'ohnePixel',
  game: 'Grand Theft Auto VI',
  title,
  source: 'clip',
  ...extra,
});

// --- what counts as boilerplate -------------------------------------------

test('a bot title made only of filler is boilerplate', () => {
  for (const junk of [
    'AutoClipper Highlight',
    'autoclipper highlight',
    'Best Moments',
    'Funny Moment',
    'Twitch Clip',
    'New Clip',
    'Untitled',
    'clip 4',
    'Highlights 12',
  ]) {
    assert.equal(isBoilerplateTitle(junk, 'ohnePixel'), true, `${junk} should be boilerplate`);
  }
});

test("the streamer's own name and digits do not rescue a bot title", () => {
  assert.equal(isBoilerplateTitle('ohnePixel Highlight 12', 'ohnePixel'), true);
  assert.equal(isBoilerplateTitle('ohnepixel clip', 'ohnePixel'), true);
  // The name is matched without punctuation, as Twitch logins carry it.
  assert.equal(isBoilerplateTitle('caseoh_ highlight', 'caseoh_'), true);
});

test('one ordinary word saves a title, because a person chose it', () => {
  for (const real of [
    'Lucia cannot believe it',
    'the ladder',
    'cops',
    'best cop chase',
    'ohnePixel finds the vault',
  ]) {
    assert.equal(isBoilerplateTitle(real, 'ohnePixel'), false, `${real} should survive`);
  }
});

test('an empty title is boilerplate rather than a crash', () => {
  assert.equal(isBoilerplateTitle('', 'ohnePixel'), true);
  assert.equal(isBoilerplateTitle('   ', 'ohnePixel'), true);
  assert.equal(isBoilerplateTitle('🔥🔥', 'ohnePixel'), true);
});

// --- what that changes on a real short ------------------------------------

test('a bot title is not treated as something a person wrote', () => {
  assert.equal(writtenTitle(at('AutoClipper Highlight')), null);
  // And a real one still is.
  assert.equal(writtenTitle(at('Lucia cannot believe it')), 'Lucia cannot believe it');
});

test('describe() falls through to its own wording instead of the bot line', () => {
  const text = describe(at('AutoClipper Highlight'));
  assert.ok(text, 'there is still a description');
  assert.doesNotMatch(text, /autoclipper/i);
  assert.match(text, /ohnePixel/);
});

test('the YouTube title no longer reads "AutoClipper Highlight"', () => {
  // This is the exact short that went up: the good line was sitting right
  // there in `about` while the bot's words took the title.
  const moment = at('AutoClipper Highlight');
  const title = youtubeTitle(describe(moment), moment);
  assert.doesNotMatch(title, /autoclipper/i);
  assert.match(title, /#Shorts/);
  assert.match(title, /#GTA6/);
});

test('the on-screen hook does not use the bot title either', () => {
  const hook = titleFor(at('AutoClipper Highlight'));
  assert.doesNotMatch(hook, /autoclipper/i);
});

test('a human clip title still wins over the generated wording', () => {
  const moment = at('Lucia cannot believe it');
  assert.match(describe(moment), /Lucia cannot believe it/);
});

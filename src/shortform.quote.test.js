// Judged against what actually went out.
//
// Once titles carried the spoken line, the channel's own numbers showed which
// lines were worth carrying. Twenty-five shorts: the ones quoting a line made
// of pronouns and auxiliaries took 0-2 views each. The one quoting a line that
// named something took thirty-seven.
//
// The old picker preferred the bad ones on purpose: it added the same bonus
// for "?" as for "!", so a generic question outscored the line people reacted
// to. These are the real quotes, kept as the record of what this is for.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { pickQuote } from './shortform.js';

// One sentence, timed to sit right on the reaction so position is never what
// decides these cases — only what the line says.
const said = (text, { reactionAt = 25 } = {}) => {
  const parts = text.split(/\s+/).filter(Boolean);
  const per = 4 / Math.max(parts.length, 1);
  const start = reactionAt - 5;
  return parts.map((word, i) => ({ word, start: start + i * per, end: start + (i + 1) * per }));
};

const quoteOf = (text) => pickQuote(said(text), { reactionAt: 25 });

describe('lines that said nothing, and the views they took', () => {
  const flat = [
    ["Let's do it.", 0],
    ['Hey, what are we doing?', 2],
    ['What do you think?', 2],
    ['What do you do here?', 1],
    ['What do you need?', 1],
    ["I'm out here.", 0],
    ['What are you doing?', 0],
  ];

  for (const [line, views] of flat) {
    test(`refuses ${JSON.stringify(line)} (${views} views)`, () => {
      assert.equal(quoteOf(line), null, `still quoted: ${quoteOf(line)}`);
    });
  }
});

describe('lines that named something are still quoted', () => {
  const worth = [
    "I'm about to be a gay dancer",
    'My car is impounded',
    'wait, you know what trick actually stops them exploding?',
    "watch that be somebody's house",
    'the cops just rammed my boat',
    'she stole the whole jewellery store',
  ];

  for (const line of worth) {
    test(`keeps ${JSON.stringify(line)}`, () => {
      const quote = quoteOf(line);
      assert.ok(quote, `rejected a line worth quoting: ${line}`);
    });
  }
});

describe('what it prefers when it has a choice', () => {
  // Two sentences, both on the reaction: one empty, one not.
  const both = (a, b) => {
    const first = said(a, { reactionAt: 22 });
    const second = said(b, { reactionAt: 27 });
    return pickQuote([...first, ...second], { reactionAt: 25 });
  };

  test('a statement that names something beats a generic question', () => {
    const quote = both('What do you think?', 'The cops rammed my boat!');
    assert.match(String(quote), /cops/i);
  });

  test('a shout beats a question, where it used to tie', () => {
    const quote = both('What do you need?', 'My car exploded!');
    assert.match(String(quote), /exploded/i);
  });
});

describe('what the transcript got wrong', () => {
  test('a two-word line is refused, because off a transcript it is usually a mishearing', () => {
    assert.equal(quoteOf('Play drive'), null);
    assert.equal(quoteOf('Reach rolls'), null);
  });

  test('a split contraction is joined back, not counted as a word it named', () => {
    // "How y 'all doing y 'all good?" is nothing once y'all is one word again.
    assert.equal(quoteOf("How y 'all doing y 'all good?"), null);
  });

  test('joining it does not break a line that is otherwise fine', () => {
    assert.match(String(quoteOf("I 'm telling you the cops rammed it")), /cops/i);
  });

  // Said plainly rather than pretended otherwise: three words that are not
  // words still pass, because nothing here knows what a word is.
  test('garble that looks like three words is NOT caught, and that is known', () => {
    assert.ok(quoteOf('Reach rolls, doll dolls'));
  });
});

describe('the shape of a quote is unchanged', () => {
  test('it still comes back capitalised', () => {
    assert.match(String(quoteOf('my car is impounded')), /^My car/);
  });

  test('it still censors what it should', () => {
    const quote = String(pickQuote(said('that shit is insane'), { reactionAt: 25, mild: true }));
    assert.ok(!/shit/.test(quote), quote);
  });

  test('nothing said at all is still null, not an empty string', () => {
    assert.equal(pickQuote([], { reactionAt: 25 }), null);
  });
});

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { looksLikeBanner, postPartsFor, writtenTitle, youtubeTitle } from './shortform.js';

const FIRE = '\u{1F525}';
const CRY = '\u{1F602}';

const moment = (extra = {}) => ({
  id: 'm1',
  broadcaster: 'jasontheween',
  game: 'Grand Theft Auto VI',
  vodId: '2933588799',
  chat: { funny: 40 },
  ...extra,
});

describe('emoji are taken out without welding the words either side', () => {
  test('a YouTube title keeps the gap an emoji was standing in', () => {
    const title = youtubeTitle(`GTA VI${FIRE}BOYS NIGHT`, moment());
    assert.match(title, /VI BOYS/i, title);
    assert.ok(!/VIBOYS/i.test(title), title);
  });

  test('a written title keeps the gap too', () => {
    const written = writtenTitle(moment({ title: `lucia${FIRE}robs the store` }));
    assert.ok(!/luciarobs/i.test(String(written)), String(written));
  });

  test('an emoji at the end leaves no trailing space', () => {
    const title = youtubeTitle(`he is cooked ${CRY}`, moment());
    assert.ok(!/\s{2,}/.test(title), title);
    assert.ok(!/ #Shorts/.test(title.replace(' #Shorts', '')), title);
  });
});

describe('a stream banner is not a title someone wrote about the clip', () => {
  test('emoji used as separators, twice or more, is a banner', () => {
    assert.equal(
      looksLikeBanner(`GTA VI${FIRE}BOYS NIGHT AT THE CLUB${FIRE}NO GIRLS ALLOWED${FIRE}24HR MARATHON`),
      true,
    );
  });

  test('an emoji that only decorates the end is not', () => {
    assert.equal(looksLikeBanner(`he is cooked ${CRY}${CRY}`), false);
    assert.equal(looksLikeBanner('no emoji at all here'), false);
  });

  test('one emoji mid-sentence is not enough to call it a banner', () => {
    assert.equal(looksLikeBanner(`I ${CRY} laughed so hard`), false);
  });

  test('the banner is refused as a written title, so a description is used', () => {
    const banner = moment({ title: `GTA VI${FIRE}BOYS NIGHT${FIRE}NO GIRLS ALLOWED${FIRE}BEST EVER` });
    assert.equal(writtenTitle(banner), null);
    const title = postPartsFor(banner, { caption: 'x', start: 10 }).platforms.youtube.split('\n')[0];
    assert.ok(!/VIBOYS/i.test(title), title);
    assert.match(title, /jasontheween/i);
  });
});

describe('the YouTube title says something concrete from the clip', () => {
  const quoted = postPartsFor(moment(), {
    caption: `"wait, you know what trick actually stops them exploding?" ${CRY}`,
    start: 10,
  });
  const title = quoted.platforms.youtube.split('\n')[0];

  test('it carries the line whole, not cut off mid-sentence', () => {
    assert.ok(title.includes('"wait, you know what trick actually stops them exploding?"'), title);
    assert.ok(!title.includes('…'), title);
  });

  test('it names who and which game before the line', () => {
    assert.match(title, /^Jasontheween in GTA 6: "/, title);
  });

  test('it still fits what YouTube will show', () => {
    assert.ok(title.length <= 100, `${title.length}: ${title}`);
  });

  test('it does not open the same way TikTok does', () => {
    const tiktok = quoted.platforms.tiktok;
    assert.notEqual(title.toLowerCase().slice(0, 30), tiktok.toLowerCase().slice(0, 30));
  });

  test('the description does not repeat the line the title already carries', () => {
    const body = quoted.platforms.youtube.split('\n').slice(1).join('\n');
    assert.ok(!body.includes('stops them exploding'), body);
  });

  test('a title a person wrote still beats the line', () => {
    const written = moment({ title: 'lucia robs the jewellery store and it goes wrong' });
    const t = postPartsFor(written, { caption: `"some other line" ${CRY}`, start: 10 }).platforms.youtube.split('\n')[0];
    assert.match(t, /Jewellery Store/i, t);
  });
});

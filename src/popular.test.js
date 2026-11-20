import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { ageInDays, popularMoments } from './popular.js';

const clip = (extra = {}) => ({
  id: 'ClipId1',
  url: 'https://clips.twitch.tv/ClipId1',
  broadcaster_id: '1',
  broadcaster_name: 'ohnePixel',
  video_id: 'v123',
  game_id: '1867279146',
  title: 'the private dance',
  view_count: 5000,
  duration: 30,
  vod_offset: 1000,
  created_at: '2026-11-18T12:00:00Z',
  thumbnail_url: 'https://x/y.jpg',
  ...extra,
});

describe('popularMoments keeps only what can actually be cut', () => {
  test('a clip whose VOD has expired is dropped, not half-used', () => {
    assert.equal(popularMoments([clip({ video_id: '' })]).length, 0);
    assert.equal(popularMoments([clip({ video_id: null })]).length, 0);
  });

  test('a clip with no offset into the VOD is dropped', () => {
    assert.equal(popularMoments([clip({ vod_offset: null })]).length, 0);
    assert.equal(popularMoments([clip({ vod_offset: undefined })]).length, 0);
  });

  test('clips nobody watched are left out', () => {
    assert.equal(popularMoments([clip({ view_count: 12 })], { minViews: 200 }).length, 0);
    assert.equal(popularMoments([clip({ view_count: 900 })], { minViews: 200 }).length, 1);
  });
});

describe('popularMoments ranks by what people watched', () => {
  test('most watched first, whatever order they arrive in', () => {
    const moments = popularMoments(
      [
        clip({ id: 'a', view_count: 100, vod_offset: 10, broadcaster_id: '1' }),
        clip({ id: 'b', view_count: 9000, vod_offset: 5000, broadcaster_id: '2' }),
        clip({ id: 'c', view_count: 3000, vod_offset: 9000, broadcaster_id: '3' }),
      ],
      { minViews: 0 },
    );
    assert.deepEqual(
      moments.map((m) => m.views),
      [9000, 3000, 100],
    );
  });

  test('the limit is the top N, not the first N', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      clip({ id: `c${i}`, broadcaster_id: String(i), vod_offset: i * 500, view_count: i * 100 + 300 }),
    );
    const top = popularMoments(many, { limit: 3 });
    assert.deepEqual(
      top.map((m) => m.views),
      [1200, 1100, 1000],
    );
  });
});

describe('several clips of one moment are one moment', () => {
  const sameThing = [
    clip({ id: 'a', view_count: 9000, vod_offset: 1000 }),
    clip({ id: 'b', view_count: 400, vod_offset: 1012 }),
    clip({ id: 'c', view_count: 250, vod_offset: 980 }),
  ];

  test('folded together rather than posted three times', () => {
    const moments = popularMoments(sameThing);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].alsoClipped, 3);
  });

  test('the most-watched of them is the one kept', () => {
    assert.equal(popularMoments(sameThing)[0].clipId, 'a');
  });

  test('their views add up, because two clips of one thing is a stronger signal', () => {
    assert.equal(popularMoments(sameThing)[0].views, 9650);
  });

  test('the same offset on a DIFFERENT channel is a different moment', () => {
    const two = [clip({ id: 'a', broadcaster_id: '1' }), clip({ id: 'b', broadcaster_id: '2' })];
    assert.equal(popularMoments(two).length, 2);
  });

  test('far enough apart on one channel is two moments', () => {
    const apart = [clip({ id: 'a', vod_offset: 1000 }), clip({ id: 'b', vod_offset: 4000 })];
    assert.equal(popularMoments(apart).length, 2);
  });
});

describe('the moment it builds is one the cutter can use', () => {
  const [m] = popularMoments([clip()], { game: 'Grand Theft Auto VI' });

  test('it points at the VOD and the reaction, not the clip start', () => {
    assert.equal(m.vodId, 'v123');
    assert.equal(m.offsetSeconds, 1000);
    // The clipper pressed the button AFTER it happened: start + duration.
    assert.equal(m.reactionOffsetSeconds, 1030);
  });

  test('it is marked as its own source, so it can be told apart', () => {
    assert.equal(m.source, 'popular');
  });

  test('it keeps the title a person wrote on the clip', () => {
    assert.equal(m.title, 'the private dance');
  });

  test('it carries the game it was asked about', () => {
    assert.equal(m.game, 'Grand Theft Auto VI');
  });
});

describe('ageInDays', () => {
  test('says how old, since this source is deliberately not live', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    assert.equal(Math.round(ageInDays({ createdAt: '2026-11-18T12:00:00Z' }, now)), 2);
  });

  test('an unreadable date is null rather than a wrong number', () => {
    assert.equal(ageInDays({ createdAt: 'nonsense' }), null);
    assert.equal(ageInDays({}), null);
  });
});

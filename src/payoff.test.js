import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { RATE_FLOOR, engagement, groupViews, halves, median, ranks, report, spearman, verdict } from './payoff.js';

const rows = (...pairs) => pairs.map(([score, views], i) => ({ score, views, likes: 0, comments: 0, broadcaster: `c${i}`, title: `t${i}` }));

test('equal values share an averaged rank rather than inventing an order', () => {
  assert.deepEqual(ranks([5, 5, 9]), [1.5, 1.5, 3]);
  assert.deepEqual(ranks([3, 1, 2]), [3, 1, 2]);
});

test('a perfect ordering is rho 1 and a reversed one is rho -1', () => {
  assert.equal(spearman([[1, 10], [2, 20], [3, 30]]).rho, 1);
  assert.equal(spearman([[1, 30], [2, 20], [3, 10]]).rho, -1);
});

test('rank correlation is not dragged around by one runaway video', () => {
  // Pearson on raw views would be a report about the 500,000, not about
  // whether the ordering held.
  const held = spearman([[1, 1], [2, 2], [3, 3], [4, 500_000]]);
  assert.equal(held.rho, 1);
});

test('too few points, or no variation at all, is no answer rather than a wrong one', () => {
  assert.equal(spearman([[1, 2]]), null);
  assert.equal(spearman([[1, 5], [1, 5], [1, 5]]), null);
});

test('a thin sample is refused outright, however tempting its sign', () => {
  const call = verdict({ rho: 0.9, n: 5 });
  assert.equal(call.state, 'thin');
  assert.match(call.line, /too few to tell/);
});

test('a correlation under what the sample can support is reported as no relationship', () => {
  // n=25 needs about 0.40; -0.13 is noise and must not be read as negative.
  const call = verdict({ rho: -0.13, n: 25 });
  assert.equal(call.state, 'flat');
  assert.match(call.line, /No relationship/);
  assert.match(call.line, /not predicting views/);
});

test('a correlation that clears the bar is called, and its direction kept', () => {
  assert.equal(verdict({ rho: 0.8, n: 40 }).state, 'works');
  const backwards = verdict({ rho: -0.8, n: 40 });
  assert.equal(backwards.state, 'inverted');
  assert.match(backwards.line, /BACKWARDS/);
});

test('no data at all says so instead of returning a number', () => {
  assert.equal(verdict(null).state, 'none');
});

test('the halves split at the median score, not at a round number', () => {
  const split = halves(rows([90, 1], [80, 2], [70, 3], [60, 4]));
  assert.equal(split.cut, 75);
  assert.equal(split.upper.n, 2);
  assert.equal(split.lower.n, 2);
  assert.equal(split.upper.median, 1.5);
});

test('channels with a single post are left out of the per-channel table', () => {
  const sample = [
    { broadcaster: 'a', views: 10 },
    { broadcaster: 'a', views: 30 },
    { broadcaster: 'b', views: 999 },
  ];
  const groups = groupViews(sample, 'broadcaster');
  assert.deepEqual(
    groups.map((g) => g.name),
    ['a'],
  );
  assert.equal(groups[0].median, 20);
});

test('per-thousand rates are withheld under the floor, and the counts given instead', () => {
  const low = engagement([{ views: 3, likes: 1, comments: 0 }]);
  assert.equal(low.rated, false);
  assert.equal(low.likesPerK, null, 'a rate of 333 from one like must not be reachable');
  assert.equal(low.totalLikes, 1);
});

test('above the floor the rate is computed on the totals, not averaged per video', () => {
  const high = engagement([
    { views: RATE_FLOOR, likes: 10, comments: 2 },
    { views: RATE_FLOOR, likes: 30, comments: 0 },
  ]);
  assert.equal(high.rated, true);
  // 40 likes across 2,000 views is 20 per thousand. Averaging the two videos'
  // own rates would also give 20 here, but stops being right the moment the
  // videos differ in size, which they always do.
  assert.equal(high.likesPerK, 20);
  assert.equal(high.commentsPerK, 1);
});

test('a hidden count is absent, not zero', () => {
  const eng = engagement([{ views: 100, likes: null, comments: null }]);
  assert.equal(eng.totalLikes, 0);
  assert.equal(eng.medianViews, 100);
});

test('the report prints no per-thousand rate when the volume cannot carry one', () => {
  const out = report({ rows: rows([90, 1], [80, 2], [70, 3], [60, 48]) });
  assert.doesNotMatch(out, /\/ 1k views/);
  assert.match(out, /no per-1,000 rate/);
});

test('the report says plainly when the ranking is not earning its place', () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ score: i, views: (i * 7) % 30, broadcaster: 'a', title: `t${i}`, likes: 0, comments: 0 }));
  assert.match(report({ rows: flat }), /not earning its place/);
});

test('the median of an even sample is the midpoint, and of nothing is nothing', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
});

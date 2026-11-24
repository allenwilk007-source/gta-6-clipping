// Did the thing we chose to post actually do anything?
//
//   npm run payoff [--db <path>] [--platform youtube]
//
// There is a loop in this project with one link missing. Moments are scored,
// the best-scoring shorts are cut, the highest-scoring cut is posted — and
// then nothing ever looks at what the post did. `eval.js` measures moments
// against what OTHER clippers on Twitch went on to do, which is a proxy and a
// good one, but it is not the thing being sold. The thing being sold is a
// short that people watch.
//
// So the chain is walked the rest of the way: uploads keeps the video id of
// everything posted, autoclips keeps which moment each file came from, and
// videos.list turns fifty ids into fifty sets of real numbers for one quota
// unit. Join those and the question "does our score predict anything?" stops
// being a matter of opinion.
//
// It can come back negative. If score and views are unrelated, then ranking by
// score is ranking by nothing, and that is worth knowing far more than it is
// worth avoiding. The sample is small and says so: every figure here is
// printed with the n it rests on, and `verdict` refuses to call a correlation
// real until the sample could support it.
//
// Everything that decides or counts is a pure function; `main` is the only
// part that opens a database or spends a unit of quota.

import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { fetchVideoStats } from './ytstats.js';
import { accessToken, loadToken, youtubeKeys } from './youtube.js';

export const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Average ranks, so a run of equal values does not invent an ordering. */
export function ranks(values) {
  const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

/**
 * Rank correlation, not linear.
 *
 * Views are wildly skewed — one video outperforming the rest by a factor of
 * fifty is normal — and Pearson on raw views would be a report about that one
 * video. Ranks ask the question actually being asked: when the score said this
 * one was better, was it?
 */
export function spearman(pairs) {
  const clean = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (clean.length < 3) return null;
  const ra = ranks(clean.map(([a]) => a));
  const rb = ranks(clean.map(([, b]) => b));
  const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i += 1) {
    const x = ra[i] - ma;
    const y = rb[i] - mb;
    num += x * y;
    va += x * x;
    vb += y * y;
  }
  if (!va || !vb) return null;
  return { rho: num / Math.sqrt(va * vb), n: clean.length };
}

/**
 * What this sample is allowed to claim.
 *
 * The critical value is the usual large-sample approximation, which at n=38
 * wants |rho| past about 0.32 before a correlation is worth calling one. Below
 * a dozen videos no figure means anything and saying so is the whole job: the
 * temptation with eight data points is to read the sign and act on it.
 */
export function verdict(result, { least = 12 } = {}) {
  if (!result) return { state: 'none', line: 'Not enough posted videos with numbers to compare yet.' };
  const { rho, n } = result;
  if (n < least) {
    return {
      state: 'thin',
      line: `${n} videos is too few to tell. Keep posting; this gets an answer at about ${least}.`,
    };
  }
  const critical = 1.96 / Math.sqrt(n - 1);
  const strength = Math.abs(rho);
  if (strength < critical) {
    return {
      state: 'flat',
      line:
        `No relationship: rho ${rho.toFixed(2)} over ${n} videos, and this sample needs ` +
        `${critical.toFixed(2)} before that counts. The score is ordering the queue but not predicting views.`,
    };
  }
  return {
    state: rho > 0 ? 'works' : 'inverted',
    line:
      rho > 0
        ? `The score predicts views: rho ${rho.toFixed(2)} over ${n} videos, past the ${critical.toFixed(2)} this sample needs.`
        : `The score predicts views BACKWARDS: rho ${rho.toFixed(2)} over ${n} videos. Higher-scoring moments did worse.`,
  };
}

/** Rows grouped by a key, each with its median views and its count. */
export function groupViews(rows, key, { least = 2 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const name = row[key] || '(unknown)';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row.views);
  }
  return [...groups]
    .map(([name, views]) => ({ name, n: views.length, median: median(views) }))
    .filter((group) => group.n >= least && group.median !== null)
    .sort((a, b) => b.median - a.median);
}

/**
 * Split at the median score rather than at a round number.
 *
 * A fixed cut like "80 and over" would say more about where this project's
 * scores happen to sit than about whether the ordering works, and the
 * question is comparative: did the half it liked more do better than the half
 * it liked less?
 */
export function halves(rows) {
  const scored = rows.filter((row) => Number.isFinite(row.score) && Number.isFinite(row.views));
  if (scored.length < 4) return null;
  const cut = median(scored.map((row) => row.score));
  const upper = scored.filter((row) => row.score >= cut);
  const lower = scored.filter((row) => row.score < cut);
  if (!upper.length || !lower.length) return null;
  return {
    cut,
    upper: { n: upper.length, median: median(upper.map((r) => r.views)) },
    lower: { n: lower.length, median: median(lower.map((r) => r.views)) },
  };
}

/**
 * Did the people who saw it react?
 *
 * The per-thousand rate is withheld below a thousand views in total, and that
 * is not caution for its own sake: one like on three views is "333 per
 * thousand", a figure that looks like a triumph and is one person. Under that
 * floor the counts themselves are the honest reporting.
 */
export const RATE_FLOOR = 1000;

export function engagement(rows) {
  const withViews = rows.filter((row) => Number.isFinite(row.views) && row.views > 0);
  if (!withViews.length) return null;
  const sum = (pick) => withViews.reduce((total, row) => total + (Number.isFinite(row[pick]) ? row[pick] : 0), 0);
  const totalViews = sum('views');
  const enough = totalViews >= RATE_FLOOR;
  return {
    n: withViews.length,
    totalViews,
    totalLikes: sum('likes'),
    totalComments: sum('comments'),
    medianViews: median(withViews.map((r) => r.views)),
    bestViews: Math.max(...withViews.map((r) => r.views)),
    // null rather than a number, so a caller cannot print one by accident.
    likesPerK: enough ? (sum('likes') / totalViews) * 1000 : null,
    commentsPerK: enough ? (sum('comments') / totalViews) * 1000 : null,
    rated: enough,
  };
}

const pad = (value, width) => String(value).padEnd(width);
const num = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—');

export function report({ rows, missing = [] }) {
  const lines = [];
  const scorePairs = rows.map((row) => [row.score, row.views]);
  const result = spearman(scorePairs);
  const call = verdict(result);

  lines.push('', `Posted and measured: ${rows.length} video(s)${missing.length ? `, ${missing.length} no longer returning numbers` : ''}`);

  const eng = engagement(rows);
  if (eng) {
    lines.push(
      '',
      `  total views       ${num(eng.totalViews)}`,
      `  median views      ${num(eng.medianViews)}`,
      `  best              ${num(eng.bestViews)}`,
    );
    lines.push(
      eng.rated
        ? `  likes / 1k views  ${eng.likesPerK.toFixed(1)}\n  comments / 1k     ${eng.commentsPerK.toFixed(1)}`
        : `  likes, comments   ${num(eng.totalLikes)} and ${num(eng.totalComments)}, all of them` +
          `\n                    (no per-1,000 rate under ${num(RATE_FLOOR)} total views: one like on three views reads as 333)`,
    );
  }

  lines.push('', 'Does the score predict views?', `  ${call.line}`);

  const split = halves(rows);
  if (split) {
    lines.push(
      '',
      `  score >= ${split.cut}   ${pad(`${split.upper.n} videos`, 12)}median ${num(split.upper.median)} views`,
      `  score <  ${split.cut}   ${pad(`${split.lower.n} videos`, 12)}median ${num(split.lower.median)} views`,
    );
  }

  const byChannel = groupViews(rows, 'broadcaster');
  if (byChannel.length) {
    lines.push('', 'Median views by channel (2+ posts only, best first)');
    for (const group of byChannel) lines.push(`  ${pad(group.name, 22)}${pad(`${group.n} posts`, 10)}${num(group.median)}`);
  }

  const best = [...rows].filter((r) => Number.isFinite(r.views)).sort((a, b) => b.views - a.views).slice(0, 5);
  if (best.length) {
    lines.push('', 'Best five, to look at and ask what they have in common');
    for (const row of best) lines.push(`  ${pad(num(row.views), 10)}score ${pad(row.score ?? '—', 6)}${row.title || row.id}`);
  }

  lines.push('', call.state === 'flat' || call.state === 'inverted' ? 'Worth acting on: the ranking is not earning its place.' : '');
  return lines.join('\n');
}

// ---- the part that opens things --------------------------------------------

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

/** What was posted, and which moment each post came from. */
export function loadPosted(db, platform = 'youtube') {
  return db
    .prepare(
      `select u.file, u.video_id as videoId, u.score, u.title, u.started_at as startedAt,
              a.moment_id as momentId, a.broadcaster, a.offset_seconds as offsetSeconds
         from uploads u
         left join autoclips a on a.path like '%' || u.file
        where u.platform = ? and u.video_id is not null
        order by u.started_at desc`,
    )
    .all(platform)
    .map((row) => ({ ...row }));
}

export async function main() {
  const dbPath = arg('db', config.storePath);
  const platform = arg('platform', 'youtube');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const posted = loadPosted(db, platform);

  if (!posted.length) {
    console.log(`\nNothing posted to ${platform} with a video id yet, so there is nothing to measure.\n`);
    return 0;
  }

  const keys = youtubeKeys();
  const saved = await loadToken();
  if (!keys.clientId || !saved?.refreshToken) {
    console.log('\nYouTube is not connected, so the view counts cannot be fetched. Connect it on the dashboard.\n');
    return 1;
  }

  // Google does not rotate refresh tokens, so asking for an access token here
  // cannot strand the running server's copy the way TikTok's would.
  const token = await accessToken(keys, saved.refreshToken);
  const { videos, missing } = await fetchVideoStats({ ids: posted.map((row) => row.videoId), token });
  const byId = new Map(videos.map((video) => [video.id, video]));

  const rows = posted.map((row) => {
    const video = byId.get(row.videoId) || {};
    return {
      ...row,
      views: video.views ?? null,
      likes: video.likes ?? null,
      comments: video.comments ?? null,
      seconds: video.seconds ?? null,
      title: row.title || video.title || '',
    };
  });

  console.log(report({ rows: rows.filter((row) => Number.isFinite(row.views)), missing }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}

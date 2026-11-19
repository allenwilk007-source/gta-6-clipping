// One account page, used by youtube.html, tiktok.html and instagram.html.
// Which one it is comes from <body data-platform>, so the three pages differ
// only in that word and the setup note they carry.
//
// Two reads: /api/stats for the account and its posts, /api/uploads for what
// this tool is doing with them. /api/stats is behind a refresh floor on the
// server, because every call spends the uploader's own daily quota. So this
// polls slowly and says when it is showing a cached answer rather than
// pretending the number is live.

const POLL_MS = 60_000;

const PLATFORM = document.body.dataset.platform || 'youtube';
const LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }[PLATFORM] || PLATFORM;
// What each platform calls the thing it holds, and the link to an account.
const NOUN = { youtube: 'Videos', tiktok: 'Posts', instagram: 'Reels' }[PLATFORM] || 'Posts';
const accountUrl = (account) => {
  if (PLATFORM === 'youtube') return account?.id ? `https://www.youtube.com/channel/${account.id}` : null;
  if (PLATFORM === 'tiktok') return account?.username ? `https://www.tiktok.com/@${account.username}` : null;
  if (PLATFORM === 'instagram') return account?.username ? `https://www.instagram.com/${account.username}/` : null;
  return null;
};

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();

const num = (value) => nf.format(Math.round(Number(value) || 0));

/** 1.2K / 3.4M, for places where the full number does not fit. */
function short(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function ago(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

function until(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return null;
  const secs = Math.round((then - Date.now()) / 1000);
  if (secs <= 0) return 'now';
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  return `in ${(secs / 3600).toFixed(1)}h`;
}

const mmss = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Likes plus comments against views: the only engagement the API gives us. */
const engagementOf = (v) => {
  const views = Number(v.views) || 0;
  if (!views) return 0;
  return ((Number(v.likes) || 0) + (Number(v.comments) || 0)) / views;
};

let sortBy = 'published';
let lastVideos = [];
let ourIds = new Set();

// ---------------------------------------------------------------- rendering

function card(label, value, note, tone = '') {
  const el = document.createElement('div');
  el.className = `yt-card${tone ? ` ${tone}` : ''}`;
  el.innerHTML = '<div class="yt-card-label"></div><div class="yt-card-value"></div><div class="yt-card-note"></div>';
  el.querySelector('.yt-card-label').textContent = label;
  el.querySelector('.yt-card-value').textContent = value;
  el.querySelector('.yt-card-note').textContent = note || '';
  return el;
}

function renderChannel(channel, videos) {
  const section = $('channel');
  if (!channel) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('avatar').src = channel.thumbnail || channel.avatar || '';
  const name = $('channel-name');
  name.textContent = channel.title || channel.displayName || channel.username || LABEL;
  const href = accountUrl(channel);
  if (href) name.href = href;
  else name.removeAttribute('href');

  const totalViews = videos.reduce((a, v) => a + (Number(v.views) || 0), 0);
  const subs = channel.subscribers ?? channel.followers;
  $('channel-sub').textContent = channel.subscribersHidden
    ? 'Follower count hidden'
    : subs === undefined
      ? ''
      : `${num(subs)} ${PLATFORM === 'youtube' ? 'subscriber' : 'follower'}${Number(subs) === 1 ? '' : 's'}`;

  const nums = $('channel-nums');
  nums.textContent = '';
  const pairs = [
    ['Views', num(channel.views)],
    [NOUN, num(channel.videos ?? channel.posts)],
    ['Listed here', num(videos.length)],
    ['Views listed', num(totalViews)],
  ];
  for (const [label, value] of pairs) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrap.append(dt, dd);
    nums.append(wrap);
  }
}

function renderCards(up, videos, stats) {
  const cards = $('cards');
  cards.textContent = '';

  const mode = up?.mode || 'off';
  const modeTone = mode === 'on' ? 'is-good' : mode === 'off' ? 'is-off' : '';
  const modeText = { on: 'On', 'dry-run': 'Dry run', off: 'Off' }[mode] || mode;
  cards.append(card('Auto upload', modeText, up?.connected ? 'Signed in' : 'Not connected', modeTone));

  const today = Number(up?.today) || 0;
  const perDay = Number(up?.perDay) || 0;
  cards.append(
    card(
      'Uploaded today',
      perDay ? `${today} / ${perDay}` : String(today),
      today >= perDay && perDay ? 'Daily cap reached' : `every ${up?.spacingMinutes ?? '?'} min`,
      today >= perDay && perDay ? 'is-off' : '',
    ),
  );

  const next = up?.nextAt ? until(up.nextAt) : null;
  cards.append(
    card('Next upload', mode === 'off' ? '—' : (next ?? 'waiting'), up?.waitingFor ? `waiting for ${up.waitingFor}` : ''),
  );

  cards.append(card('Queued', num(up?.queued), 'shorts ready to go'));

  const ours = videos.filter((v) => ourIds.has(v.id));
  const ourViews = ours.reduce((a, v) => a + (Number(v.views) || 0), 0);
  cards.append(card('Posted by this tool', num(ours.length), ours.length ? `${num(ourViews)} views` : 'none yet'));

  const best = videos.reduce((top, v) => ((Number(v.views) || 0) > (Number(top?.views) || 0) ? v : top), null);
  cards.append(card(`Best ${NOUN.toLowerCase().replace(/s$/, '')}`, best ? short(best.views) : '—', best ? best.title.slice(0, 38) : ''));

  if (up?.lastError) cards.append(card('Last error', 'see below', String(up.lastError).slice(0, 60), 'is-bad'));

  const privacy = up?.privacy;
  if (privacy) {
    const forced = videos.some((v) => ourIds.has(v.id) && v.privacy && v.privacy !== privacy);
    cards.append(
      card(
        'Uploading as',
        String(privacy),
        forced ? 'YouTube overrode this' : 'as set in .env',
        forced ? 'is-bad' : '',
      ),
    );
  }

  if (stats?.cached) cards.append(card('Account numbers', 'cached', `read ${ago(stats.fetchedAt)}`));
}

function sortVideos(videos) {
  const copy = [...videos];
  if (sortBy === 'views') copy.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
  else if (sortBy === 'likes') copy.sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0));
  else if (sortBy === 'engagement') copy.sort((a, b) => engagementOf(b) - engagementOf(a));
  else copy.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  return copy;
}

function renderVideos(videos) {
  const list = $('videos');
  const template = $('video-row');
  list.textContent = '';
  $('video-count').textContent = videos.length ? `· ${videos.length}` : '';
  $('videos-empty').hidden = videos.length > 0;

  const most = videos.reduce((top, v) => Math.max(top, Number(v.views) || 0), 0);

  for (const v of sortVideos(videos)) {
    const row = template.content.firstElementChild.cloneNode(true);
    const mine = ourIds.has(v.id);
    if (mine) row.classList.add('is-ours');

    const thumb = row.querySelector('.ytv-thumb');
    thumb.href = v.url || '#';
    thumb.querySelector('img').src = v.thumbnail || '';

    const title = row.querySelector('.ytv-title');
    title.textContent = v.title || '(untitled)';
    title.href = v.url || '#';

    const meta = row.querySelector('.ytv-meta');
    const bits = [];
    if (v.publishedAt) bits.push(ago(v.publishedAt));
    if (v.seconds) bits.push(mmss(v.seconds));
    meta.textContent = bits.join(' · ');

    if (v.privacy && v.privacy !== 'public') {
      const tag = document.createElement('span');
      tag.className = `ytv-tag is-${v.privacy}`;
      tag.textContent = v.privacy;
      meta.append(tag);
    }
    if (mine) {
      const tag = document.createElement('span');
      tag.className = 'ytv-tag is-ours';
      tag.textContent = 'auto';
      meta.append(tag);
    }

    const bar = row.querySelector('.ytv-bar span');
    bar.style.width = most ? `${Math.round(((Number(v.views) || 0) / most) * 100)}%` : '0';

    const nums = row.querySelector('.ytv-nums');
    for (const [label, value] of [
      ['views', num(v.views)],
      ['likes', num(v.likes)],
      ['comments', num(v.comments)],
    ]) {
      const cell = document.createElement('div');
      cell.className = 'ytv-num';
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      cell.append(b, s);
      nums.append(cell);
    }

    list.append(row);
  }
}

function renderQueue(up) {
  const list = $('queue');
  list.textContent = '';
  const items = up?.next || [];
  $('queued-count').textContent = up?.queued ? `· ${up.queued} waiting` : '';
  $('queue-empty').hidden = items.length > 0;

  for (const item of items.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = 'ytq';
    const score = document.createElement('span');
    score.className = 'ytq-score';
    score.textContent = item.score ?? '';
    const title = document.createElement('span');
    title.className = 'ytq-title';
    title.textContent = item.title || item.file || '';
    li.append(score, title);
    list.append(li);
  }
}

// ------------------------------------------------------------------ loading

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function load({ force = false } = {}) {
  const problem = $('problem');
  try {
    // force=1 is for a person pressing Refresh. The timer never sends it,
    // because every forced read spends the uploader's own daily quota.
    const [stats, uploads] = await Promise.all([
      getJson(force ? '/api/stats?force=1' : '/api/stats'),
      getJson('/api/uploads'),
    ]);
    const yt = stats?.[PLATFORM] || {};
    const up = uploads?.[PLATFORM] || {};

    ourIds = new Set((up.recent || []).map((r) => r.videoId).filter(Boolean));
    lastVideos = yt.videos || [];

    // The setup note lives in the page, because what each platform needs is
    // prose, not a status code. It is shown until the account is connected.
    const setup = $('setup');
    const ready = Boolean(yt.keys && yt.connected);
    if (setup) setup.hidden = ready;

    if (!up.built) {
      problem.hidden = false;
      problem.textContent = `${LABEL} upload is not built yet.`;
    } else if (!yt.keys) {
      problem.hidden = false;
      problem.textContent = `No ${LABEL} keys in .env, so there is nothing to show yet.`;
    } else if (!yt.connected) {
      problem.hidden = false;
      problem.textContent = `Keys are set but ${LABEL} is not connected. Press Connect on the main page.`;
    } else if (yt.error) {
      problem.hidden = false;
      problem.textContent = `${LABEL} said: ${yt.error}`;
    } else {
      problem.hidden = true;
    }

    renderChannel(yt.channel, lastVideos);
    renderCards(up, lastVideos, yt);
    renderVideos(lastVideos);
    renderQueue(up);

    $('updated').textContent = yt.fetchedAt ? `account read ${ago(yt.fetchedAt)}${yt.cached ? ' · cached' : ''}` : '';
  } catch (err) {
    problem.hidden = false;
    problem.textContent = `Could not read the page's data: ${err.message}`;
  }
}

$('refresh').addEventListener('click', () => {
  $('updated').textContent = 'refreshing…';
  load({ force: true });
});

$('sorts').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-sort]');
  if (!button) return;
  sortBy = button.dataset.sort;
  for (const b of $('sorts').querySelectorAll('button')) b.classList.toggle('is-on', b === button);
  renderVideos(lastVideos);
});

load();
setInterval(load, POLL_MS);

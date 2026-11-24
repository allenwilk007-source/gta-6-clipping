// What the channel actually did.
//
// Everything else in this project measures moments before they are clips. This
// measures clips after they are videos, which is the only place real numbers
// live: views, likes, subscribers. It reads; it never writes.
//
// Quota is the reason this is built around a cache rather than a fetch per
// request. A read costs 1 unit against the 10,000 a day, which sounds free
// until you remember an upload costs 1,600 and the uploader expects most of
// the budget to be its own. A dashboard polling every few seconds would spend
// thousands of units showing numbers that change hourly. So the floor below is
// not politeness, it is the uploader's budget.

const API = 'https://www.googleapis.com/youtube/v3';

// Three calls per refresh (channel, playlist, videos). At one refresh per five
// minutes that is ~864 units a day, comfortably inside the ~2,000 the uploader
// can spare.
export const MIN_REFRESH_MS = 5 * 60_000;

const int = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * ISO 8601 durations, as YouTube reports them: PT1M30S, PT45S, P1DT2H.
 *
 * Shorts are the point here, so the common case is seconds and minutes — but
 * a VOD upload can carry hours or days and returning NaN for those would put
 * a blank in the table rather than a number.
 */
export function parseDuration(iso) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(iso || ''),
  );
  if (!match) return null;
  const [, d, h, m, s] = match;
  const total =
    Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
  // Zero is YouTube's way of saying it has no length to give — a live
  // broadcast, or an upload it has not finished processing. That is unknown,
  // not a zero-second video, and the table should leave it blank.
  return total > 0 ? total : null;
}

/** The channel line: who it is and the totals. */
export function summarizeChannel(body) {
  const item = body?.items?.[0];
  if (!item) return null;
  const stats = item.statistics || {};
  return {
    id: item.id || null,
    title: item.snippet?.title || '',
    thumbnail: item.snippet?.thumbnails?.default?.url || null,
    // hiddenSubscriberCount means the owner chose not to show it. That is an
    // absence, not a zero, and the dashboard says so rather than printing 0.
    subscribers: stats.hiddenSubscriberCount ? null : int(stats.subscriberCount),
    subscribersHidden: Boolean(stats.hiddenSubscriberCount),
    views: int(stats.viewCount),
    videos: int(stats.videoCount),
    uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads || null,
  };
}

/** One row per video, newest first, with whatever statistics were returned. */
export function videoRows(body) {
  return (body?.items || []).map((item) => {
    const stats = item.statistics || {};
    return {
      id: item.id,
      title: item.snippet?.title || '',
      publishedAt: item.snippet?.publishedAt || null,
      thumbnail:
        item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
      privacy: item.status?.privacyStatus || null,
      seconds: parseDuration(item.contentDetails?.duration),
      // Counts are absent rather than zero when the owner has hidden them, so
      // null travels all the way to the table instead of becoming 0.
      views: int(stats.viewCount),
      likes: int(stats.likeCount),
      comments: int(stats.commentCount),
      url: `https://www.youtube.com/watch?v=${item.id}`,
    };
  });
}

/**
 * Is a failed token refresh the sign-in being gone, or just the network?
 *
 * Only the first should put a Connect button in front of the owner. A 5xx, a
 * 429 or a dropped connection is a blip, and sending someone to re-consent
 * for a blip trains them to click through consent screens without reading —
 * which is the opposite of what a consent screen is for.
 *
 * A raw fetch failure carries no `kind` at all, so an unknown error is
 * treated as transient rather than as a lost sign-in. Getting that backwards
 * is the expensive direction: a wrongly-reported auth failure is visible and
 * annoying, a wrongly-hidden one just retries until it is right.
 */
export const statsErrorKind = (err) => (err?.kind === 'auth' ? 'auth' : 'transient');

async function get(path, params, token, fetchImpl) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message || res.statusText;
    const error = new Error(`youtube ${path}: ${res.status} ${detail}`);
    // 401 means reconnect; 403 on a read is nearly always quota. The caller
    // shows different things for the two and must not confuse them.
    error.kind = res.status === 401 ? 'auth' : res.status === 403 ? 'quota' : 'http';
    error.status = res.status;
    throw error;
  }
  return body;
}

/**
 * Channel totals and the most recent uploads.
 *
 * Three requests: the channel, its uploads playlist, then the videos in one
 * batch. The playlist hop exists because playlistItems carries no statistics —
 * it gives ids, and videos.list turns a page of ids into a page of numbers for
 * a single unit rather than one unit each.
 */
export async function fetchStats({ token, max = 25, fetchImpl = fetch } = {}) {
  const channelBody = await get(
    'channels',
    { part: 'snippet,statistics,contentDetails', mine: 'true' },
    token,
    fetchImpl,
  );
  const channel = summarizeChannel(channelBody);
  if (!channel) throw Object.assign(new Error('no channel on this account'), { kind: 'empty' });

  let videos = [];
  if (channel.uploadsPlaylist) {
    const playlist = await get(
      'playlistItems',
      { part: 'contentDetails', playlistId: channel.uploadsPlaylist, maxResults: String(Math.min(max, 50)) },
      token,
      fetchImpl,
    );
    const ids = (playlist?.items || [])
      .map((item) => item.contentDetails?.videoId)
      .filter(Boolean);
    if (ids.length) {
      const body = await get(
        'videos',
        { part: 'snippet,statistics,contentDetails,status', id: ids.join(',') },
        token,
        fetchImpl,
      );
      videos = videoRows(body);
    }
  }

  return { channel, videos, fetchedAt: new Date().toISOString() };
}

/** videos.list takes fifty ids for one unit, so ask in fifties. */
export function idBatches(ids, size = 50) {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

/**
 * Statistics for videos we name, rather than for the channel's newest.
 *
 * `fetchStats` above answers "how is the channel doing", which is a different
 * question from "how did the thing we chose to post do". Answering the second
 * needs the ids we kept at upload time, and those are not necessarily recent
 * or even still the newest 25.
 *
 * A whole batch is one unit. Thirty-eight videos cost one.
 */
export async function fetchVideoStats({ ids = [], token, fetchImpl = fetch } = {}) {
  const rows = [];
  for (const batch of idBatches(ids)) {
    const body = await get(
      'videos',
      { part: 'snippet,statistics,contentDetails,status', id: batch.join(',') },
      token,
      fetchImpl,
    );
    rows.push(...videoRows(body));
  }
  // A deleted or private video simply is not in the reply, so the caller is
  // told which of the ids it asked about came back with nothing to say.
  const found = new Set(rows.map((row) => row.id));
  return { videos: rows, missing: [...new Set(ids.filter(Boolean))].filter((id) => !found.has(id)) };
}

/**
 * fetchStats behind a floor, so the page can poll without spending the
 * uploader's quota. A failure is cached too, briefly: a dashboard that retries
 * a 403 every second turns one quota error into a reason the quota stays gone.
 */
export class StatsCache {
  constructor({ fetchStats: fetcher = fetchStats, minRefreshMs = MIN_REFRESH_MS } = {}) {
    this.fetcher = fetcher;
    this.minRefreshMs = minRefreshMs;
    this.value = null;
    this.error = null;
    this.at = 0;
    this.inFlight = null;
  }

  fresh(now) {
    return this.at > 0 && now - this.at < this.minRefreshMs;
  }

  async get({ token, max = 25, now = Date.now(), force = false } = {}) {
    if (!force && this.fresh(now)) {
      return { ...(this.value ? { ...this.value } : {}), cached: true, error: this.error };
    }
    // One request at a time: two page loads a second apart must not become two
    // sets of three API calls.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const value = await this.fetcher({ token, max });
        this.value = value;
        this.error = null;
        this.at = now;
        return { ...value, cached: false, error: null };
      } catch (err) {
        this.error = { message: err.message, kind: err.kind || 'http' };
        this.at = now;
        return { ...(this.value || {}), cached: Boolean(this.value), error: this.error };
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}

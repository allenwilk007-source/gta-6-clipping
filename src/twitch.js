import { config } from './config.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TwitchError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'TwitchError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal Helix client using an app access token (client credentials).
 * App tokens are enough for /games, /streams and /clips — all public data.
 */
export class Twitch {
  constructor({
    clientId = config.clientId,
    clientSecret = config.clientSecret,
    log = () => {},
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.log = log;
    this.accessToken = null;
    this.expiresAt = 0;
    this.pending = null;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async token(force = false) {
    if (!this.configured) {
      throw new TwitchError(
        'Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET. Copy .env.example to .env and fill them in.',
      );
    }
    if (!force && this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    if (this.pending) return this.pending;

    this.pending = (async () => {
      const body = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      });
      const res = await fetch(TOKEN_URL, { method: 'POST', body });
      const text = await res.text();
      if (!res.ok) {
        throw new TwitchError(`Token request failed (${res.status})`, res.status, text);
      }
      const json = JSON.parse(text);
      this.accessToken = json.access_token;
      // Renew a minute early so a long poll never races the expiry.
      this.expiresAt = Date.now() + Math.max((json.expires_in || 3600) - 60, 60) * 1000;
      this.log('got app access token');
      return this.accessToken;
    })();

    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async helix(path, params = {}, attempt = 0) {
    const token = await this.token();
    const url = new URL(HELIX + path);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url, {
      headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
    });

    if (res.status === 401 && attempt === 0) {
      await this.token(true);
      return this.helix(path, params, attempt + 1);
    }

    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get('ratelimit-reset')) * 1000;
      const wait = Math.min(Math.max(reset - Date.now(), 1000), 15000);
      this.log(`rate limited on ${path}, waiting ${Math.round(wait)}ms`);
      await sleep(wait);
      return this.helix(path, params, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TwitchError(`Helix ${path} returned ${res.status}`, res.status, body);
    }

    return res.json();
  }

  /** Resolve a category name to its Twitch id, falling back to search. */
  async resolveGame(name) {
    const exact = await this.helix('/games', { name });
    if (exact.data?.length) return exact.data[0];

    const search = await this.helix('/search/categories', { query: name, first: 20 });
    const lowered = name.toLowerCase();
    const hit =
      search.data?.find((g) => g.name.toLowerCase() === lowered) || search.data?.[0];
    if (!hit) {
      throw new TwitchError(`No Twitch category matched "${name}"`, 404);
    }
    return hit;
  }

  async gameById(id) {
    const res = await this.helix('/games', { id });
    if (!res.data?.length) throw new TwitchError(`No Twitch category with id ${id}`, 404);
    return res.data[0];
  }

  /** Live channels in a category, most viewers first. */
  async liveStreams(gameId, max = 100) {
    const out = [];
    let cursor;
    while (out.length < max) {
      const page = await this.helix('/streams', {
        game_id: gameId,
        first: Math.min(100, max - out.length),
        after: cursor,
      });
      const batch = page.data || [];
      out.push(...batch);
      cursor = page.pagination?.cursor;
      if (!cursor || batch.length === 0) break;
    }
    return out;
  }

  /**
   * Re-fetch known clips by id, for outcome polling.
   *
   * A clip that has been deleted simply stops coming back. That is not an
   * error to paper over — a moment whose clips are disappearing is telling you
   * something, so the caller gets the shrunken list as-is.
   */
  async clipsByIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const page = await this.helix('/clips', { id: ids.slice(i, i + 100) });
      out.push(...(page.data || []));
    }
    return out;
  }

  /**
   * The archive VOD for a live channel, so a chat-sourced moment can carry a
   * real VOD id and be clipped like any other.
   *
   * Only called for channels that are actually spiking, and cached by the
   * caller for the length of the stream, because the id cannot change while
   * the broadcast is running.
   */
  async archiveVideo(userId) {
    const res = await this.helix('/videos', { user_id: userId, type: 'archive', first: 1 });
    return res.data?.[0] || null;
  }

  /**
   * Clips created in a window, across every channel in the category.
   *
   * Helix sorts these by view count, not creation time. With a short window
   * that barely matters — brand-new clips all sit near zero views — but it does
   * mean a truncated result drops the quietest clips first, so `truncated`
   * is surfaced rather than swallowed.
   */
  async recentClips({ gameId, startedAt, endedAt, maxPages = 30 }) {
    const clips = [];
    let cursor;
    let pages = 0;
    while (pages < maxPages) {
      const page = await this.helix('/clips', {
        game_id: gameId,
        first: 100,
        started_at: startedAt,
        ended_at: endedAt,
        after: cursor,
      });
      const batch = page.data || [];
      clips.push(...batch);
      pages += 1;
      cursor = page.pagination?.cursor;
      if (!cursor || batch.length === 0) break;
    }
    return { clips, pages, truncated: pages >= maxPages && Boolean(cursor) };
  }

  /**
   * The most-watched clips of a window, which is the same endpoint read for
   * what it actually sorts by.
   *
   * recentClips() above uses a window so short that the view-count ordering
   * barely matters. Widen the window and that ordering becomes the point: page
   * one is what the audience of the last week chose to watch. No detection, no
   * guessing, and nothing to be wrong about.
   */
  async popularClips({ gameId, days = 7, pages: maxPages = 1, now = Date.now() }) {
    const clips = [];
    let cursor;
    let pages = 0;
    while (pages < maxPages) {
      const page = await this.helix('/clips', {
        game_id: gameId,
        first: 100,
        started_at: new Date(now - days * 86_400_000).toISOString(),
        ended_at: new Date(now).toISOString(),
        after: cursor,
      });
      const batch = page.data || [];
      clips.push(...batch);
      pages += 1;
      cursor = page.pagination?.cursor;
      if (!cursor || batch.length === 0) break;
    }
    return clips;
  }
}

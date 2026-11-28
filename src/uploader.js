// Automatic upload: YouTube, and TikTok as a draft in the owner's inbox.
//
// The pipeline makes shorts far faster than any platform will take them:
// YouTube's default quota is about six uploads a day and TikTok allows five
// pending inbox shares in any 24 hours, against dozens of shorts. So this is a
// selector as much as a sender. Each day it posts the best few — highest
// engagement score first, only shorts above the keep line, never one flagged
// weak — evenly spaced, and leaves the rest.
//
// With nobody looking at a short before it goes out, the checks here are the
// last line: the video is checked again at post time, its game must be one
// this channel clips, and its tags are rebuilt from its own recorded game, so
// a mislabelled short cannot reach the channel. clips/rejected is never read.
//
// The two platforms differ in three ways that matter here:
//   * YouTube's quota resets at midnight Pacific — a calendar day. TikTok's
//     cap is rolling: it lifts when the oldest attempt ages out of 24 hours.
//   * TikTok rotates its refresh token on every refresh (see tiktok.js).
//   * A YouTube upload is the post. A TikTok inbox upload is a draft: it
//     arrives as a notification and the owner taps post. That is the ceiling
//     for an unaudited app, and it is not worked around.
//
// Three modes per platform, off by default:
//   off      nothing happens
//   dry-run  everything happens except the upload: the full choice, title and
//            description are logged (data/upload-dry-run.jsonl) at the real
//            cadence, so what a day looks like can be seen before it is real
//   on       uploads, through the owner's own app and sign-in
//
// Nothing here tries to look human. Spacing is even and documented, the API
// is the platform's own, and a refusal is an answer, not something to route
// around.

import { existsSync } from 'node:fs';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { config } from './config.js';
import { KEEP_SCORE } from './engagement.js';
import * as instagram from './instagram.js';
import { recopy } from './recopy.js';
import { probe } from './shortform.js';
import * as tiktok from './tiktok.js';
import { validateShort } from './validate.js';
import * as youtube from './youtube.js';

const num = (value, fallback) => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : fallback);

export const PLATFORMS = ['youtube', 'tiktok', 'instagram'];

/**
 * Which of the watched games a channel is for, from a comma-separated list.
 * Unset means all of them, which is what a single channel posting everything
 * wants. Set it when a channel is about one game: a Tarkov channel fed GTA
 * clips is worse than one posting nothing, because the wrong clip is what the
 * audience judges the channel by.
 */
const gamesFor = (value) => {
  const names = String(value || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return names.length ? names : null;
};

export const uploadConfig = (env = process.env) => ({
  youtube: {
    // Each upload costs 1,600 of the default 10,000 daily units; 5 leaves
    // room for a failed attempt, which spends quota too.
    perDay: num(env.YOUTUBE_PER_DAY, 5),
    // Even spacing: 5 a day, three hours apart.
    spacingMinutes: num(env.YOUTUBE_SPACING_MINUTES, 180),
    privacy: ['public', 'unlisted', 'private'].includes(env.YOUTUBE_PRIVACY) ? env.YOUTUBE_PRIVACY : 'public',
    games: gamesFor(env.YOUTUBE_GAMES),
  },
  tiktok: {
    // TikTok's own words: at most 5 pending shares within any 24-hour period.
    // Going past it earns a 403, which would spend the slot for nothing.
    perDay: num(env.TIKTOK_PER_DAY, tiktok.PENDING_CAP),
    // 24 hours over 5 is a little under five hours.
    spacingMinutes: num(env.TIKTOK_SPACING_MINUTES, 280),
    games: gamesFor(env.TIKTOK_GAMES),
  },
  instagram: {
    // Instagram's documented cap is 50 published posts in a moving 24 hours;
    // 45 leaves room for a failed attempt, which counts too. Worth saying
    // plainly: 45 Reels a day is a great many, and the API permitting it is
    // not the same as it being good for the account. INSTAGRAM_PER_DAY.
    perDay: num(env.INSTAGRAM_PER_DAY, 45),
    spacingMinutes: num(env.INSTAGRAM_SPACING_MINUTES, 32),
    // A Reel also appearing on the profile grid. Off is the quieter choice.
    shareToFeed: env.INSTAGRAM_SHARE_TO_FEED !== 'false',
    games: gamesFor(env.INSTAGRAM_GAMES),
  },
});

/**
 * The most each platform will actually take in a day, and why.
 *
 * These are not preferences. TikTok answers a sixth pending share with a 403,
 * which spends the attempt and posts nothing; YouTube's 10,000 daily quota
 * units at 1,600 an upload run out after six. So the dashboard may set
 * anything up to these and nothing past them, and it says the reason rather
 * than quietly clamping - a box that comes back holding a different number
 * from the one typed into it reads as a bug, not as a rule.
 */
export const CEILINGS = {
  youtube: { perDay: 6, why: 'YouTube allows 10,000 quota units a day and each upload costs 1,600' },
  tiktok: { perDay: tiktok.PENDING_CAP, why: `TikTok allows ${tiktok.PENDING_CAP} pending shares in any 24 hours` },
  instagram: { perDay: 50, why: 'Instagram allows 50 published posts in a moving 24 hours' },
};

// A full day apart is the widest gap that still means "a day"; a minute is the
// narrowest that is still a gap.
export const SPACING_RANGE = { min: 1, max: 1440 };

/**
 * How many the spacing alone allows in 24 hours.
 *
 * Raising the daily number on its own does nothing: five a day six hours
 * apart is four a day. The panel used to say 5 while posting 4, with nothing
 * on the page accounting for the fifth. This is what lets it say so instead.
 */
export const fitsInADay = (spacingMinutes) =>
  Math.max(
    1,
    Math.floor(
      1440 / Math.min(SPACING_RANGE.max, Math.max(SPACING_RANGE.min, Number(spacingMinutes) || SPACING_RANGE.min)),
    ),
  );

/**
 * One limit from the dashboard, checked before it can reach the scheduler.
 *
 * Returns the number to keep, or null to hand the setting back to .env - which
 * is what an emptied box means, and the only way to undo a change here without
 * having to remember what the file said.
 *
 * Every refusal is a sentence the panel can show as it stands, because that is
 * where it ends up.
 */
export function checkLimit(platform, field, value) {
  const ceiling = CEILINGS[platform];
  if (!ceiling) throw new Error(`${platform} upload is not built yet`);
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error('that needs to be a whole number');
  if (field === 'perDay') {
    // Zero a day and "off" would be two ways to say the same thing, and the
    // one with a switch on the card is the one that says it clearly.
    if (n < 1) throw new Error('at least one a day — use Off to stop uploading altogether');
    if (n > ceiling.perDay) throw new Error(`${ceiling.perDay} a day is the most this can be: ${ceiling.why}`);
    return n;
  }
  if (field === 'spacingMinutes') {
    if (n < SPACING_RANGE.min || n > SPACING_RANGE.max) {
      throw new Error(`the gap has to be between ${SPACING_RANGE.min} and ${SPACING_RANGE.max} minutes`);
    }
    return n;
  }
  throw new Error(`${field} is not a limit that can be set`);
}

export const MODES = ['off', 'dry-run', 'on'];

// Both TikTok and Instagram count their caps over a moving 24 hours.
const ROLLING_WINDOW_MS = 24 * 3600_000;

// How long a read of the queue may be reused. See Uploader#queueCache.
const QUEUE_TTL_MS = 5_000;

/**
 * Midnight in Pacific time at or before `now`: when YouTube's quota resets.
 * A calendar day, not a rolling 24 hours.
 */
export function pacificDayStart(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return Math.floor(now / 1000) * 1000 - sinceMidnight;
}

// Statuses that spent quota: every real attempt, whatever came of it.
const SPENT = new Set(['uploading', 'done', 'failed', 'refused', 'uncertain', 'retry', 'dry-run']);

/**
 * What can be posted, best first. Only finished shorts still in the ready
 * folder with their post copy, above the keep line, not weak, in a game this
 * channel clips, and never posted (or tried) on this platform before.
 */
export async function candidates({ store, dir, platform, games = config.games, keep = KEEP_SCORE, limit = 500 }) {
  const done = store.uploadedFiles(platform);
  const wanted = new Set(games.map((g) => g.toLowerCase()));
  const out = [];
  for (const row of store.listAutoclips({ limit })) {
    if (row.status !== 'done' || !row.path) continue;
    const file = basename(row.path);
    if (done.has(file) || !/\.mp4$/.test(file)) continue;
    if (!Number.isFinite(row.score) || row.score < keep || row.weak === 1) continue;
    const video = join(dir, file);
    const jsonPath = video.replace(/\.mp4$/, '.json');
    if (!existsSync(video) || !existsSync(jsonPath)) continue;
    let saved;
    try {
      saved = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch {
      continue;
    }
    // The game this short recorded about itself must be one this channel is for.
    if (!saved.game || !wanted.has(String(saved.game).toLowerCase())) continue;
    // What the store knows about the moment this short came from, in the shape
    // recopy() reads. Without it the post copy is rebuilt as if the moment had
    // come from chat with no title, and the only honest thing left to say is
    // that chat spiked - which was true of every short this tool ever posted.
    const record = {
      id: row.momentId,
      source: row.momentSource || null,
      title: row.momentTitle || null,
      caption: row.caption,
      broadcaster: row.broadcaster,
      vodId: row.vodId,
      gameId: row.gameId,
    };
    out.push({ file, video, saved, record, score: row.score, finishedAt: row.finishedAt, momentId: row.momentId });
  }
  return out.sort((a, b) => b.score - a.score || String(b.finishedAt).localeCompare(String(a.finishedAt)));
}

/** Tags that name a game other than the one the short was recorded in. */
function assertGameMatches(text, game) {
  const lower = text.toLowerCase();
  const name = String(game).toLowerCase();
  const otherGame = (name.includes('fortnite') && /#gta/.test(lower)) || (name.includes('grand theft auto') && /#fortnite/.test(lower));
  if (otherGame) throw new Error(`tags name another game than ${game}`);
}

/**
 * The YouTube post for a short, rebuilt now from its own record rather than
 * trusted from a file written hours ago. Throws if the tags name a game other
 * than the one the short was recorded in.
 */
/** A title with its trailing hashtags off, compared the way a reader would. */
const sameish = (text) =>
  String(text || '')
    .replace(/\s#.*$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Post copy whose title is not one already used.
 *
 * `avoid` steers the wording but cannot promise the result differs: the
 * generator falls back to its first option when every option is taken, and
 * on a real channel two shorts went up as "KaiCenat Has Chat in Tears in
 * GTA 6" hours apart. Steering is not a guarantee, so the finished title is
 * checked and asked for again with the collision named.
 *
 * After a few tries it posts the repeat anyway. A duplicate title is worth
 * less than a short that never goes out, and a channel clipping five people
 * will genuinely run out of ways to say the same thing.
 */
export function postWithoutRepeating(adapter, candidate, avoid = [], tries = 4) {
  const taken = new Set(avoid.map(sameish));
  const asked = [...avoid];
  let post = adapter.post(candidate, { avoid: asked });
  for (let i = 0; i < tries && taken.has(sameish(post.title)); i += 1) {
    asked.push(String(post.title).replace(/\s#.*$/, ''));
    post = adapter.post(candidate, { avoid: asked });
  }
  return post;
}

export function youtubePost(candidate, { avoid = [] } = {}) {
  // `avoid`: titles already posted, so a day is not one sentence five times.
  const parts = recopy({ file: candidate.file, saved: candidate.saved, record: candidate.record || null, avoid });
  const [title, ...rest] = parts.platforms.youtube.split('\n');
  const description = rest.join('\n').trim();
  assertGameMatches(`${title}\n${description}`, candidate.saved.game);
  const tags = [...new Set(`${title}\n${description}`.toLowerCase().match(/#[a-z0-9_]+/g) || [])].map((t) => t.slice(1)).slice(0, 15);
  return { title, description, tags };
}

/**
 * The TikTok caption for a short.
 *
 * The inbox endpoint has no caption field at all — the owner writes it in the
 * app — so this is not sent anywhere. It is logged and stored beside the
 * upload so the owner has something complete to paste. TERMS.md promises a
 * credit line and a link back to the source with every clip; the TikTok hook
 * carries the credit, so the link is appended here.
 */
export function tiktokPost(candidate, { avoid = [] } = {}) {
  const parts = recopy({ file: candidate.file, saved: candidate.saved, record: candidate.record || null, avoid });
  const title = parts.platforms.tiktok.trim();
  assertGameMatches(title, candidate.saved.game);
  const caption = parts.link ? `${title}\n${parts.linkLabel}: ${parts.link}` : title;
  return { title, caption, link: parts.link || null };
}

/**
 * When the next `count` uploads would go, if nothing changes.
 *
 * A projection, not a promise. A better short landing, a refusal, the owner
 * switching a platform off, or a cap reached early all move it. What it is
 * careful about is using the SAME cap and spacing rules the uploader applies,
 * rather than a second set of them that could quietly drift.
 *
 * `taken` is every attempt already spent, as millisecond timestamps.
 */
export function projectSlots({ taken = [], count, now, perDay, spacingMinutes, rolling, notBefore = 0 }) {
  // Blocked with no end (a lapsed sign-in, a refused account): there is no
  // honest time to show, and inventing one would be worse than a blank.
  if (!Number.isFinite(notBefore) || count <= 0) return [];
  const spacing = spacingMinutes * 60_000;
  const spent = [...taken].filter(Number.isFinite).sort((a, b) => a - b);

  const windowed = (at) =>
    rolling ? spent.filter((t) => t > at - ROLLING_WINDOW_MS && t <= at) : spent.filter((t) => pacificDayStart(t) === pacificDayStart(at));

  const out = [];
  let last = spent.length ? spent[spent.length - 1] : Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    let at = Math.max(now, notBefore, last + spacing);
    // Walk forward until the cap has room. Each step strictly increases the
    // time, so this ends.
    for (let guard = 0; guard < 500; guard += 1) {
      const used = windowed(at);
      if (used.length < perDay) break;
      // Rolling: room appears as the oldest attempt ages out of the window.
      // Calendar: not until the next Pacific midnight.
      at = rolling ? used[0] + ROLLING_WINDOW_MS : pacificDayStart(pacificDayStart(at) + 26 * 3600_000);
      at = Math.max(at, last + spacing);
    }
    out.push(at);
    spent.push(at);
    spent.sort((a, b) => a - b);
    last = at;
  }
  return out;
}

/**
 * The Instagram caption for a short.
 *
 * Unlike TikTok's inbox, this one IS sent: Instagram's container takes the
 * caption, so the credit and the link back go out with the Reel rather than
 * being handed to the owner to paste.
 */
export function instagramPost(candidate, { avoid = [] } = {}) {
  const parts = recopy({ file: candidate.file, saved: candidate.saved, record: candidate.record || null, avoid });
  const body = parts.platforms.instagram.trim();
  assertGameMatches(body, candidate.saved.game);
  const full = parts.link ? `${body}\n${parts.linkLabel}: ${parts.link}` : body;
  // Instagram's limit is 2200 characters; the copy is nowhere near it, but a
  // caption refused for length would cost a slot.
  return { title: body.split('\n')[0], caption: full.slice(0, 2200) };
}

export class Uploader {
  constructor({
    store,
    dir,
    log = () => {},
    cfg = uploadConfig(),
    env = process.env,
    settingsPath = join(config.root, 'data', 'uploads.json'),
    dryRunLog = join(config.root, 'data', 'upload-dry-run.jsonl'),
    now = () => Date.now(),
    yt = youtube,
    tt = tiktok,
    ig = instagram,
    check = async (video) => {
      const { duration } = await probe(video);
      return validateShort(video, { expectSeconds: duration });
    },
  } = {}) {
    Object.assign(this, { store, dir, log, cfg, settingsPath, dryRunLog, now, yt, tt, ig, check });
    // `keys` stays the YouTube keys: the server's /auth/youtube route uses it.
    this.keys = yt.youtubeKeys(env);
    this.tiktokKeys = tt.tiktokKeys(env);
    this.instagramKeys = ig.instagramKeys(env);
    this.settings = {};
    this.state = {};
    for (const platform of PLATFORMS) {
      // perDay and spacingMinutes are null until somebody sets them here:
      // null means "whatever .env says", so an untouched install behaves
      // exactly as it did before this panel existed.
      this.settings[platform] = { mode: 'off', blockedUntil: 0, blockedReason: null, perDay: null, spacingMinutes: null };
      this.state[platform] = { blockedUntil: 0, blockedReason: null, lastError: null, connected: false };
    }
    // What .env asked for, kept aside so clearing a limit set here can put the
    // file's number back without re-reading it.
    this.envLimits = Object.fromEntries(
      PLATFORMS.map((platform) => [
        platform,
        { perDay: this.cfg[platform].perDay, spacingMinutes: this.cfg[platform].spacingMinutes },
      ]),
    );
    this.busy = false;
    this.timer = null;
    // candidates() opens a .json for every short in the queue, and the queue
    // only grows — 172 of them at the time of writing, read twice over for a
    // view, by two pages that both poll. The scan is cached for a few seconds:
    // long enough to collapse a burst of polls, short enough that a short
    // rendered just now appears while the owner is still looking at the page.
    // Wall-clock, not the injected one: this is about IO rate, not schedule.
    this.queueCache = new Map();

    // Everything platform-specific, in one place, so the scheduling and the
    // checks above it are written once.
    this.adapters = {
      youtube: {
        label: 'YouTube',
        envHint: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET',
        // A calendar day in Pacific time, because that is when the quota resets.
        window: 'calendar-pacific',
        capNote: 'daily quota is spent',
        hasKeys: () => this.yt.hasKeys(this.keys),
        savedToken: () => this.yt.loadToken(),
        forgetToken: () => this.yt.forgetToken(),
        post: (candidate, options) => youtubePost(candidate, options),
        token: async () => {
          const kept = await this.yt.loadToken();
          if (!kept?.refreshToken) throw new youtube.UploadError('not connected', 'auth');
          return this.yt.accessToken(this.keys, kept.refreshToken);
        },
        send: async ({ token, candidate, post }) => {
          const videoId = await this.yt.uploadVideo({ token, file: candidate.video, privacy: this.cfg.youtube.privacy, ...post });
          return { id: videoId, where: `https://youtube.com/shorts/${videoId}` };
        },
      },
      tiktok: {
        label: 'TikTok',
        envHint: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET',
        // "At most 5 pending shares within any 24-hour period" — rolling.
        window: 'rolling-24h',
        capNote: '24-hour share cap is used up',
        hasKeys: () => this.tt.hasKeys(this.tiktokKeys),
        savedToken: () => this.tt.loadToken(),
        forgetToken: () => this.tt.forgetToken(),
        post: (candidate, options) => tiktokPost(candidate, options),
        token: async () => this.tt.accessTokenFor(this.tiktokKeys, { now: this.now() }),
        send: async ({ token, candidate }) => {
          const result = await this.tt.uploadVideo({ token, file: candidate.video });
          return {
            id: result.publishId,
            // Not a link to a post: there is no post yet. The owner finishes it.
            where: 'a draft in your TikTok inbox — open TikTok to post it',
            status: result.status,
            confirmError: result.confirmError || null,
          };
        },
      },
      instagram: {
        label: 'Instagram',
        envHint: 'INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET',
        // "50 published posts within a 24 hour moving period."
        window: 'rolling-24h',
        capNote: '24-hour posting cap is used up',
        hasKeys: () => this.ig.hasKeys(this.instagramKeys),
        savedToken: () => this.ig.loadToken(),
        forgetToken: () => this.ig.forgetToken(),
        post: (candidate, options) => instagramPost(candidate, options),
        // Not one token but three things: the Page token, the user token and
        // the account id. Which token publishes is contradicted between Meta's
        // own pages, so both are carried and `send` tries them in turn.
        token: async () => this.ig.tokensFor(this.instagramKeys, { now: this.now() }),
        send: async ({ token, candidate, post }) => {
          const attempt = (access) =>
            this.ig.uploadVideo({
              token: access,
              igUserId: token.igUserId,
              file: candidate.video,
              caption: post.caption,
              shareToFeed: this.cfg.instagram.shareToFeed,
            });
          let mediaId;
          try {
            mediaId = await attempt(token.pageToken || token.userToken);
          } catch (err) {
            // The documented ambiguity, resolved by trying rather than by
            // asking the owner to guess. Only ever one retry.
            if (err.kind !== 'auth' || !token.pageToken || !token.userToken) throw err;
            this.log('upload: Instagram would not take the Page token; trying the user token');
            mediaId = await attempt(token.userToken);
          }
          const link = await this.ig.permalink({ token: token.pageToken || token.userToken, mediaId });
          return { id: mediaId, where: link || `Instagram (media ${mediaId})` };
        },
      },
    };
  }

  /** The queue for a platform, read at most once every few seconds. */
  async queueFor(key) {
    const hit = this.queueCache.get(key);
    if (hit && Date.now() - hit.at < QUEUE_TTL_MS) return hit.rows;
    // `games: undefined` leaves candidates() on its default, every watched game.
    const rows = await candidates({ store: this.store, dir: this.dir, platform: key, games: this.cfg[key]?.games || undefined });
    this.queueCache.set(key, { at: Date.now(), rows });
    return rows;
  }

  adapter(platform) {
    const found = this.adapters[platform];
    if (!found) throw new Error(`${platform} upload is not built yet`);
    return found;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      for (const platform of PLATFORMS) {
        if (MODES.includes(saved?.[platform]?.mode)) this.settings[platform].mode = saved[platform].mode;
        // A backoff with an end to it is worth remembering. YouTube refuses
        // the day's uploads with a 400 and the next try is not until midnight
        // Pacific, so a restart that forgot it spent a slot rediscovering the
        // same refusal. Only finite waits come back: a stopped sign-in or a
        // refused account is re-established by isConnected() and by trying,
        // and restoring "forever" from a file could wedge the tool for good.
        const until = Number(saved?.[platform]?.blockedUntil);
        if (Number.isFinite(until) && until > this.now()) {
          this.settings[platform].blockedUntil = until;
          this.settings[platform].blockedReason = saved[platform].blockedReason || null;
          this.state[platform].blockedUntil = until;
          this.state[platform].blockedReason = saved[platform].blockedReason || null;
          this.log(`upload: ${platform} is still waiting — ${saved[platform].blockedReason || 'blocked'}`);
        }
        for (const field of ['perDay', 'spacingMinutes']) {
          const kept = saved?.[platform]?.[field];
          if (kept === undefined || kept === null) continue;
          try {
            this.settings[platform][field] = checkLimit(platform, field, kept);
          } catch (err) {
            // A file edited by hand, or written when the ceiling was different.
            // Ignore that number and say so: refusing to start over a setting
            // that has a perfectly good default would be worse.
            this.log(`upload: ignoring the saved ${platform} ${field} — ${err.message}`);
          }
        }
      }
    } catch {
      /* first run: off */
    }
    this.applyLimits();
    for (const platform of PLATFORMS) {
      this.state[platform].connected = await this.isConnected(platform);
    }
    const interrupted = this.store?.markInterruptedUploads() || 0;
    if (interrupted) this.log(`upload: ${interrupted} upload(s) were cut off by a restart — not retried, check the channel`);
  }

  /**
   * A sign-in that is still usable. A refresh token with a known expiry in the
   * past is not a connection, and saying so beforehand beats finding out by
   * spending a slot on it.
   */
  async isConnected(platform) {
    const saved = await this.adapter(platform).savedToken();
    if (!saved?.refreshToken) return false;
    if (Number.isFinite(saved.refreshExpiresAt) && saved.refreshExpiresAt <= this.now()) return false;
    return true;
  }

  async setMode(platform, mode) {
    const adapter = this.adapter(platform);
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    if (mode === 'on' && !adapter.hasKeys()) throw new Error(`add ${adapter.envHint} to .env first`);
    if (mode === 'on' && !this.state[platform].connected) throw new Error(`connect ${adapter.label} first`);
    this.settings[platform].mode = mode;
    await this.saveSettings();
    this.log(`upload: ${adapter.label} is now ${mode}`);
  }

  /**
   * The chosen limits, onto this.cfg, which is what everything else reads.
   *
   * One place, called after a load and after every change, so the scheduler,
   * the projection and the panel cannot end up disagreeing about what today
   * allows.
   */
  applyLimits() {
    for (const platform of PLATFORMS) {
      const base = this.envLimits[platform];
      this.cfg[platform].perDay = this.settings[platform].perDay ?? base.perDay;
      this.cfg[platform].spacingMinutes = this.settings[platform].spacingMinutes ?? base.spacingMinutes;
    }
  }

  /**
   * How many a day, and how far apart, from the dashboard.
   *
   * Both are checked before either is kept, so a refused gap cannot leave the
   * daily number changed and the page showing a pair that was never set
   * together. Takes effect on the next tick - a minute at most - rather than
   * on a restart, which is the whole point of it being on the page.
   */
  async setLimits(platform, { perDay, spacingMinutes } = {}) {
    const adapter = this.adapter(platform);
    const next = {};
    if (perDay !== undefined) next.perDay = checkLimit(platform, 'perDay', perDay);
    if (spacingMinutes !== undefined) next.spacingMinutes = checkLimit(platform, 'spacingMinutes', spacingMinutes);
    Object.assign(this.settings[platform], next);
    this.applyLimits();
    await this.saveSettings();
    const cfg = this.cfg[platform];
    const fits = fitsInADay(cfg.spacingMinutes);
    this.log(
      `upload: ${adapter.label} is now up to ${cfg.perDay} a day, ${cfg.spacingMinutes} minutes apart` +
        (fits < cfg.perDay ? ` — that gap only fits ${fits}` : ''),
    );
  }

  /**
   * Written whole, through a temp file, so a crash cannot leave half of it.
   *
   * One at a time. Two saves overlapping both wrote the same temp file and
   * then both renamed it, and the second rename failed with ENOENT because the
   * first had already moved it away — losing whichever write lost the race.
   * rememberBlock() saves without waiting for it, so that overlap is ordinary
   * rather than rare, and queueing is cheaper than the lost setting.
   */
  saveSettings() {
    this.saving = Promise.resolve(this.saving)
      .catch(() => {})
      .then(async () => {
        const temp = `${this.settingsPath}.tmp`;
        await writeFile(temp, JSON.stringify(this.settings, null, 2), 'utf8');
        await rename(temp, this.settingsPath);
      });
    return this.saving;
  }

  /** Remember a wait that has an end, so a restart does not relearn it. */
  rememberBlock(platform) {
    const { blockedUntil, blockedReason } = this.state[platform];
    const keep = Number.isFinite(blockedUntil) && blockedUntil > this.now();
    this.settings[platform].blockedUntil = keep ? blockedUntil : 0;
    this.settings[platform].blockedReason = keep ? blockedReason : null;
    // Nothing waits on this: failing to write it costs one wasted attempt
    // after a restart, which is the behaviour it is already replacing.
    this.saveSettings().catch(() => {});
  }

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`upload: ${err.message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  platformKey(platform, mode) {
    return mode === 'dry-run' ? `${platform}:dry` : platform;
  }

  /**
   * How much of the cap is used, and when it next lifts.
   *
   * Pacific-calendar for YouTube; for TikTok a rolling window, where the cap
   * lifts as the oldest attempt in it ages out rather than at a clock time.
   */
  capWindow(platform, key, now) {
    if (this.adapter(platform).window === 'rolling-24h') {
      const spent = this.store.uploadsSince(key, now - ROLLING_WINDOW_MS).filter((r) => SPENT.has(r.status));
      const times = spent.map((r) => Date.parse(r.started_at)).filter(Number.isFinite);
      const oldest = times.length ? Math.min(...times) : now;
      return { used: spent.length, resetAt: oldest + ROLLING_WINDOW_MS };
    }
    const dayStart = pacificDayStart(now);
    const spent = this.store.uploadsSince(key, dayStart).filter((r) => SPENT.has(r.status));
    // 26 hours on always lands in the next Pacific day, DST or not.
    return { used: spent.length, resetAt: pacificDayStart(dayStart + 26 * 3600_000) };
  }

  /** When the next upload may go, and why not sooner. */
  schedule(platform = 'youtube', mode = this.settings[platform].mode) {
    const key = this.platformKey(platform, mode);
    const now = this.now();
    const cfg = this.cfg[platform];
    const state = this.state[platform];
    const { used, resetAt } = this.capWindow(platform, key, now);
    const last = this.store.lastUpload(key);
    const spacingAt = last ? Date.parse(last.started_at) + cfg.spacingMinutes * 60_000 : 0;
    let nextAt = Math.max(now, spacingAt, state.blockedUntil);
    let why = spacingAt > now ? 'spacing' : null;
    if (state.blockedUntil > now) why = state.blockedReason;
    if (used >= cfg.perDay) {
      nextAt = Math.max(nextAt, resetAt);
      why = `today's ${cfg.perDay} are done`;
    }
    return { today: used, perDay: cfg.perDay, nextAt, why, resetAt };
  }

  async tick() {
    if (this.busy || !this.store) return null;
    this.busy = true;
    try {
      // One platform per tick at most, so a long upload never delays the
      // other's schedule by more than a minute.
      for (const platform of PLATFORMS) {
        const mode = this.settings[platform].mode;
        if (mode === 'off') continue;
        if (this.schedule(platform, mode).nextAt > this.now()) continue;
        // postOne reads the queue itself, uncached, and writes to it. Whatever
        // it did, the cached copy is now out of date.
        const result = await this.postOne(platform, mode);
        this.queueCache.clear();
        if (result) return result;
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  async postOne(platform, mode) {
    const adapter = this.adapter(platform);
    const key = this.platformKey(platform, mode);
    const state = this.state[platform];
    const avoid = this.avoidList(key);
    for (const candidate of await candidates({ store: this.store, dir: this.dir, platform: key })) {
      // The checks first: a short that fails them is set aside for good.
      let post;
      try {
        post = postWithoutRepeating(adapter, candidate, avoid);
        const checked = await this.check(candidate.video);
        if (!checked.ok) throw new Error(`failed its checks: ${checked.problems.map((p) => p.text).join('; ')}`);
      } catch (err) {
        if (this.store.claimUpload({ file: candidate.file, platform: key, score: candidate.score, at: new Date(this.now()) })) {
          this.store.finishUpload({ file: candidate.file, platform: key, status: 'skipped', error: err.message, at: new Date(this.now()) });
        }
        this.log(`upload: skipped ${candidate.file} — ${err.message}`);
        continue;
      }

      if (mode === 'dry-run') {
        if (!this.store.claimUpload({ file: candidate.file, platform: key, title: post.title, score: candidate.score, at: new Date(this.now()) })) continue;
        this.store.finishUpload({ file: candidate.file, platform: key, status: 'dry-run', at: new Date(this.now()) });
        await appendFile(
          this.dryRunLog,
          `${JSON.stringify({ at: new Date(this.now()).toISOString(), platform, file: candidate.file, score: candidate.score, ...post })}\n`,
        );
        this.log(`upload (dry run): would post ${candidate.file} (score ${candidate.score}) to ${adapter.label} as "${post.title}"`);
        return { platform, file: candidate.file, status: 'dry-run', title: post.title };
      }

      // Signed in before anything is claimed: a lapsed sign-in spends nothing.
      let token;
      try {
        token = await adapter.token();
      } catch (err) {
        return this.stopFor(platform, err);
      }

      if (!this.store.claimUpload({ file: candidate.file, platform: key, title: post.title, score: candidate.score, at: new Date(this.now()) })) continue;
      this.log(`upload: posting ${candidate.file} (score ${candidate.score}) to ${adapter.label} as "${post.title}"`);
      try {
        const sent = await adapter.send({ token, candidate, post });
        this.store.finishUpload({ file: candidate.file, platform: key, status: 'done', videoId: sent.id, at: new Date(this.now()) });
        state.lastError = null;
        this.log(`upload: posted ${candidate.file} → ${sent.where}`);
        // The inbox endpoint takes no caption, so the owner is given one.
        if (post.caption) this.log(`upload: caption to paste for ${candidate.file} —\n${post.caption}`);
        if (sent.confirmError) this.log(`upload: could not confirm ${candidate.file} with ${adapter.label} (${sent.confirmError}); the upload itself went through`);
        return { platform, file: candidate.file, status: 'done', videoId: sent.id };
      } catch (err) {
        // 'retry' is the only status claimUpload will take again, so it is
        // what every failure that is not about THIS video has to get. A cap
        // reached mid-upload is the platform's answer about the account, and
        // striking the short off for it would burn the best one in the queue
        // — every time, since the next attempt picks the next best. That is
        // routine on TikTok, whose init refuses outright at 5 pending shares.
        const status =
          { transient: 'retry', quota: 'retry', blocked: 'retry', refused: 'refused', uncertain: 'uncertain' }[err.kind] || 'failed';
        this.store.finishUpload({ file: candidate.file, platform: key, status, error: err.message, at: new Date(this.now()) });
        if (err.kind === 'refused') this.log(`upload: ${adapter.label} refused ${candidate.file} — ${err.message}; not retried`);
        if (err.kind === 'uncertain') this.log(`upload: ${candidate.file} may or may not have posted — ${err.message}; not retried, check the account`);
        if (err.kind === 'transient') this.log(`upload: ${candidate.file} did not go (${err.message}); will try again after the spacing`);
        if (err.kind === 'quota' || err.kind === 'auth' || err.kind === 'blocked') this.stopFor(platform, err);
        state.lastError = err.message;
        return { platform, file: candidate.file, status, error: err.message };
      }
    }
    return null;
  }

  /** Quota, a sign-in or a block: stop, and say so, rather than keep trying. */
  stopFor(platform, err) {
    const adapter = this.adapter(platform);
    const state = this.state[platform];
    state.lastError = err.message;
    if (err.kind === 'quota') {
      state.blockedUntil = this.schedule(platform).resetAt;
      state.blockedReason = `${adapter.label}'s ${adapter.capNote}`;
      this.log(`upload: ${adapter.label} — ${adapter.capNote}; stopped until ${new Date(state.blockedUntil).toISOString()}`);
    } else if (err.kind === 'auth') {
      state.connected = false;
      state.blockedUntil = Number.POSITIVE_INFINITY;
      state.blockedReason = `sign-in expired: connect ${adapter.label} again`;
      this.log(`upload: ${adapter.label} sign-in no longer works (${err.message}) — connect again in the page`);
    } else if (err.kind === 'blocked') {
      // Not the sign-in and not this video: the account. Saying "sign-in
      // expired" here would send the owner to reconnect over and over.
      state.blockedUntil = Number.POSITIVE_INFINITY;
      state.blockedReason = `${adapter.label} is refusing this account: ${err.message}`;
      this.log(`upload: ${adapter.label} is refusing this account (${err.message}) — stopped; this is not something to retry around`);
    } else {
      state.blockedUntil = this.now() + 10 * 60_000;
      state.blockedReason = err.message;
    }
    this.rememberBlock(platform);
    return { platform, status: 'stopped', error: err.message };
  }

  /** Called after a successful Connect. */
  connected(platform = 'youtube') {
    Object.assign(this.state[platform], { connected: true, blockedUntil: 0, blockedReason: null, lastError: null });
    // A fresh sign-in clears a remembered wait too, or reconnecting would
    // look like it had done nothing until the old block expired on its own.
    this.rememberBlock(platform);
  }

  /**
   * The queued shorts with the time each would go out, best first.
   *
   * The times are a projection (see projectSlots): what the queue looks like
   * if nothing changes. Worth showing anyway — "5 of 5 today" says nothing
   * about whether the next one is in twenty minutes or tomorrow afternoon.
   */
  upcoming(platform, queue, limit = 12) {
    if (!this.store || !queue.length) return [];
    const cfg = this.cfg[platform];
    const now = this.now();
    const key = this.platformKey(platform, this.settings[platform].mode);
    const wanted = queue.slice(0, limit);
    // Two days back: enough for the rolling window and for the spacing owed
    // to an upload that went out just before midnight.
    const taken = this.store
      .uploadsSince(key, now - 48 * 3600_000)
      .filter((r) => SPENT.has(r.status))
      .map((r) => Date.parse(r.started_at))
      .filter(Number.isFinite);
    const slots = projectSlots({
      taken,
      count: wanted.length,
      now,
      perDay: cfg.perDay,
      spacingMinutes: cfg.spacingMinutes,
      rolling: this.adapter(platform).window === 'rolling-24h',
      notBefore: this.state[platform].blockedUntil,
    });
    return wanted.map((c, i) => ({
      file: c.file,
      score: c.score,
      broadcaster: c.saved.broadcaster || null,
      game: c.saved.game || null,
      title: c.saved.platforms?.[platform]?.split('\n')[0] || c.saved.caption,
      at: slots[i] ? new Date(slots[i]).toISOString() : null,
    }));
  }

  /** Titles already posted lately, which the next one should not repeat. */
  avoidList(key) {
    return this.store
      .uploadsSince(key, this.now() - 3 * 24 * 3600_000)
      .map((r) => String(r.title || '').replace(/\s#.*$/, ''))
      .filter(Boolean);
  }

  /**
   * What the uploader would post for this short right now.
   *
   * Only "right now": if something else goes out first it joins the avoid
   * list, and the wording can still change. Falls back to the stored text if
   * rebuilding throws, because a panel must not fail over wording.
   */
  previewTitle(platform, candidate, avoid = []) {
    const stored = candidate.saved.platforms?.[platform]?.split('\n')[0] || candidate.saved.caption;
    try {
      return recopy({ file: candidate.file, saved: candidate.saved, avoid }).platforms[platform]?.split('\n')[0] || stored;
    } catch {
      return stored;
    }
  }

  async platformView(platform) {
    const adapter = this.adapter(platform);
    const mode = this.settings[platform].mode;
    const plan = this.store ? this.schedule(platform, mode) : null;
    const key = this.platformKey(platform, mode);
    // Read the queue once: candidates() opens every short's .json, so the
    // panel and the schedule must not each pay for it.
    const queue = this.store ? await this.queueFor(key) : [];
    const next = queue.slice(0, 5);
    const recent = this.store ? this.store.uploadsSince(key, this.now() - 7 * 24 * 3600_000).reverse().slice(0, 8) : [];
    // The wording the posting path would choose, worked out its way. The panel
    // used to show the text stored beside the short when it was cut, but the
    // uploader rebuilds that at post time and replaces it, so the page named a
    // title that never went out. A page naming the wrong title is worse than a
    // page naming none.
    const avoiding = this.store ? this.avoidList(key) : [];
    return {
      built: true,
      keys: adapter.hasKeys(),
      connected: this.state[platform].connected,
      mode,
      spacingMinutes: this.cfg[platform].spacingMinutes,
      today: plan?.today ?? 0,
      perDay: this.cfg[platform].perDay,
      // What the platform itself allows, so the panel can offer the whole
      // range it has and name the reason it stops there.
      maxPerDay: CEILINGS[platform].perDay,
      capWhy: CEILINGS[platform].why,
      spacingRange: SPACING_RANGE,
      // What the gap allows on its own. Raising one without the other is the
      // easy mistake here, and this is how the page catches it.
      fitsPerDay: fitsInADay(this.cfg[platform].spacingMinutes),
      // Whether these came from this panel or from the file, because "as set
      // in .env" and "as you set it" answer different questions.
      limitsSetHere: this.settings[platform].perDay !== null || this.settings[platform].spacingMinutes !== null,
      // A lapsed sign-in and a refused account both block with no end: the
      // schedule's nextAt is Infinity, and `new Date(Infinity)` has no ISO
      // form to give — it throws. Nothing caught it, so the first read of the
      // upload state after an expired YouTube sign-in met a switch left on
      // took the whole server down, and the supervisor restarted it into the
      // same state. There is no time to name in that case; `waitingFor`
      // already carries the reason, which is the part worth saying anyway.
      nextAt: plan && mode !== 'off' && Number.isFinite(plan.nextAt) ? new Date(plan.nextAt).toISOString() : null,
      waitingFor: plan?.why || null,
      lastError: this.state[platform].lastError,
      next: next.map((c) => ({
        file: c.file,
        score: c.score,
        title: this.previewTitle(platform, c, avoiding),
      })),
      queued: queue.length,
      // Against the same key as everything else here: in dry-run the whole
      // panel describes the dry-run lane, and a lifetime count that silently
      // switched to the real one would be the only row that disagreed.
      lifetime: this.store ? this.store.uploadTotals(key) : { done: 0, failed: 0, since: null },
      upcoming: this.upcoming(platform, queue),
      recent: recent.map((r) => ({ file: r.file, status: r.status, title: r.title, videoId: r.video_id, error: r.error, at: r.started_at })),
    };
  }

  async view() {
    return {
      youtube: { ...(await this.platformView('youtube')), privacy: this.cfg.youtube.privacy },
      tiktok: {
        ...(await this.platformView('tiktok')),
        // Said in the page, not only in a comment: an upload here is a draft.
        draftsOnly: true,
        draftNote: 'TikTok uploads arrive as a draft in your inbox — open TikTok to post it. Going straight to your profile needs the video.publish scope and TikTok’s audit.',
      },
      instagram: {
        ...(await this.platformView('instagram')),
        shareToFeed: this.cfg.instagram.shareToFeed,
      },
    };
  }
}

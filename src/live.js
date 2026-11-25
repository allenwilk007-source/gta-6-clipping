// Recording live streams, for channels whose moments cannot be cut from a VOD.
//
// Some channels are live with nothing to cut: ishowspeed's newest archive was
// days old while he streamed, and squeezie, zerator and wankilstudio keep
// their VODs subscriber-only. Their live streams are public. So for those
// channels — and only those, since everything else cuts fine from its VOD —
// the live stream itself is recorded into a rolling buffer, and moments are
// cut from that.
//
// Measured on ishowspeed's live playlist before building this:
//
//   * no login needed (also true for the subscriber-only channels)
//   * every 2s segment carries EXT-X-PROGRAM-DATE-TIME, real wall-clock time,
//     so a chat spike maps to the exact seconds of video — no VOD, no offset
//     arithmetic from a stream start
//   * joining stitches in a 30s pre-roll ad: segments titled "Amazon|…" under
//     a twitch-stitched-ad date range, where real ones are titled "live". Ads
//     are dropped, and since every new session starts with a pre-roll, the
//     recorder keeps one session alive instead of reconnecting
//   * the playlist holds only a few segments, so it is polled every 2s and
//     each segment downloaded at once
//
// And which game a live channel is playing comes from its public page — the
// same description link previews read — "| Streaming grand theft auto vi
// for 14759 viewers." — because without a VOD there are no chapters, and
// recording without knowing the game would bring back the World of Warcraft
// short tagged #gta6.

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { run, splitCommand } from './clip.js';
import { config } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (message) => String(message ?? '').split(/\r?\n/)[0];

// ---------------------------------------------------------------------------
// Reading what Twitch serves
// ---------------------------------------------------------------------------

/**
 * Segments of a live media playlist: uri, wall-clock start (ms), duration (s),
 * and whether it is an ad. Pure, so the ad rules are tested.
 */
export function parsePlaylist(text) {
  const ads = [];
  const segments = [];
  let at = null;
  let duration = null;
  let title = '';
  // Fragmented-MP4 streams: each segment needs this init segment in front.
  let map = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      map = /URI="([^"]+)"/.exec(line)?.[1] || null;
    } else if (line.startsWith('#EXT-X-DATERANGE:') && /CLASS="twitch-stitched-ad"/.test(line)) {
      const start = Date.parse(/START-DATE="([^"]+)"/.exec(line)?.[1]);
      const length = Number(/DURATION=([\d.]+)/.exec(line)?.[1]);
      if (Number.isFinite(start) && Number.isFinite(length)) ads.push([start, start + length * 1000]);
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      at = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    } else if (line.startsWith('#EXTINF:')) {
      const [seconds, ...rest] = line.slice('#EXTINF:'.length).split(',');
      duration = Number(seconds);
      title = rest.join(',');
    } else if (line && !line.startsWith('#')) {
      const ad = /^amazon/i.test(title) || (Number.isFinite(at) && ads.some(([s, e]) => at >= s && at < e));
      segments.push({
        uri: line,
        at: Number.isFinite(at) ? at : null,
        duration: Number.isFinite(duration) ? duration : null,
        ad,
        map,
      });
      at = Number.isFinite(at) && Number.isFinite(duration) ? at + duration * 1000 : null;
      duration = null;
      title = '';
    }
  }
  return segments;
}

const ENTITIES = { '&amp;': '&', '&#x27;': "'", '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };

/**
 * Whether a channel is live and what it is playing, from its public page.
 * Live pages end their description with "| Streaming <game> for N viewers."
 * (or just "| Streaming <game>."); offline pages have no such line.
 */
export function liveFromPage(html) {
  const description = /<meta name="description" content="([^"]*)"/.exec(String(html ?? ''))?.[1] || '';
  const text = description.replace(/&(?:amp|#x27|#39|quot|lt|gt);/g, (e) => ENTITIES[e]);
  const match = /\|\s*Streaming (.+?)(?: for ([\d,.]+) viewers)?\.?\s*$/i.exec(text);
  if (!match) return { live: false, game: null, viewers: 0 };
  return { live: true, game: match[1].trim(), viewers: Number(String(match[2] || '0').replace(/[,.]/g, '')) || 0 };
}

/**
 * Who we say we are when reading a public channel page.
 *
 * This used to claim to be Mozilla, whose only purpose was to look like a
 * person at a browser - the exact thing TERMS.md says this tool does not do.
 * Twitch returns the same description meta tag either way, so the pretence
 * bought nothing and cost the sentence its truth. If Twitch ever decides it
 * would rather not serve an automated reader, that is a decision it is
 * entitled to make, and lying to prevent it is not an option here.
 */
const USER_AGENT = 'saturation-feed/1.0 (+https://github.com/allenwilk007-source/gta-6-clipping)';

export async function fetchChannelPage(login) {
  const res = await fetch(`https://www.twitch.tv/${encodeURIComponent(login)}`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`channel page returned ${res.status}`);
  return liveFromPage(await res.text());
}

/** The live media playlist's URL, at up to RECORD_QUALITY, or 'offline'. */
export async function resolveLiveUrl(login, { quality = config.recordQuality } = {}) {
  const { file, prefix } = splitCommand(config.ytdlpCmd);
  try {
    const { stdout } = await run(
      file,
      [...prefix, '-g', '-f', `best[height<=${quality}]/best`, `https://www.twitch.tv/${login}`],
      { cwd: config.root, label: 'yt-dlp' },
    );
    const url = stdout.trim().split(/\r?\n/).find((line) => line.startsWith('http'));
    if (!url) throw new Error('no stream address returned');
    return url;
  } catch (err) {
    if (/not currently live|offline|does not exist/i.test(err.message)) throw new Error('offline');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

/**
 * The recorded segments that cover [from, to] without a gap, or null. A gap
 * over a second is an ad break or a dropped stretch; a cut across it would be
 * shorter than it claims and out of step with the chat that nominated it.
 */
export function coverage(index, from, to, { maxGap = 1000 } = {}) {
  const used = index.filter((s) => s.at + s.duration * 1000 > from && s.at < to).sort((a, b) => a.at - b.at);
  if (!used.length || used[0].at > from + maxGap) return null;
  for (let i = 1; i < used.length; i += 1) {
    const end = used[i - 1].at + used[i - 1].duration * 1000;
    if (used[i].at - end > maxGap) return null;
  }
  const last = used.at(-1);
  if (last.at + last.duration * 1000 < to - maxGap) return null;
  return used;
}

export class LiveRecorder {
  constructor({
    login,
    dir,
    keepSeconds = config.recordKeepSeconds,
    resolveUrl = resolveLiveUrl,
    fetchImpl = fetch,
    log = () => {},
    pollMs = 2000,
    now = () => Date.now(),
  }) {
    this.login = login;
    this.dir = dir;
    this.keepSeconds = keepSeconds;
    this.resolveUrl = resolveUrl;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.pollMs = pollMs;
    this.now = now;
    this.index = [];
    this.url = null;
    this.lastAt = 0;
    this.state = 'starting';
    this.lastError = null;
    this.failures = 0;
    this.adSeconds = 0;
    this.game = null;
    this.stopped = false;
  }

  async start() {
    // Segments from an earlier run are not in this index and would never be
    // pruned: start from an empty folder.
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    this.stopped = false;
    this.loop().catch((err) => {
      this.state = 'error';
      this.lastError = firstLine(err.message);
    });
  }

  stop() {
    this.stopped = true;
    this.state = 'stopped';
  }

  /** One pass: fetch the playlist, keep new live segments, drop old ones. */
  async poll() {
    if (!this.url) {
      this.url = await this.resolveUrl(this.login);
      this.state = 'recording';
    }
    const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      // The address expired or the stream ended: get a fresh one.
      this.url = null;
      throw new Error(`playlist returned ${res.status}`);
    }
    for (const segment of parsePlaylist(await res.text())) {
      if (!Number.isFinite(segment.at) || segment.at <= this.lastAt) continue;
      this.lastAt = segment.at;
      if (segment.ad) {
        this.adSeconds += segment.duration || 0;
        continue;
      }
      const bytes = await this.download(new URL(segment.uri, this.url).href);
      // Some channels are served as MPEG-TS, some as fragmented MP4. A
      // fragment cannot be read without its init segment, so it is stored
      // with the init in front: every file plays on its own either way.
      const init = segment.map ? await this.initFor(new URL(segment.map, this.url).href) : null;
      const file = join(this.dir, `${segment.at}${init ? '.mp4' : '.ts'}`);
      await writeFile(file, init ? Buffer.concat([init, bytes]) : bytes);
      this.index.push({ at: segment.at, duration: segment.duration || 2, file });
    }
    await this.prune();
    this.failures = 0;
  }

  async download(url) {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`segment returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** The init segment, fetched once per address (it changes after an ad). */
  async initFor(url) {
    if (this.init?.url !== url) this.init = { url, bytes: await this.download(url) };
    return this.init.bytes;
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.poll();
      } catch (err) {
        this.lastError = firstLine(err.message);
        this.failures += 1;
        if (this.lastError === 'offline') {
          this.state = 'offline';
          await sleep(120_000);
          continue;
        }
        if (this.failures >= 3) this.url = null;
      }
      await sleep(this.pollMs);
    }
  }

  async prune() {
    const cutoff = this.now() - this.keepSeconds * 1000;
    const old = this.index.filter((s) => s.at + s.duration * 1000 < cutoff);
    this.index = this.index.filter((s) => s.at + s.duration * 1000 >= cutoff);
    await Promise.all(old.map((s) => rm(s.file, { force: true })));
  }

  covers(from, to) {
    return Boolean(coverage(this.index, from, to));
  }

  /**
   * Copy the segments around a moment out of the rolling buffer, so a job
   * that waits in the queue cannot lose them to the buffer moving on. Takes
   * as much of [from, to] as is recorded, but always the `need` range.
   */
  async snapshot({ from, to, need, dest }) {
    const usable = coverage(this.index, Math.max(from, this.index[0]?.at ?? from), to) || coverage(this.index, need[0], need[1]);
    if (!usable || !coverage(usable, need[0], need[1])) throw new Error('the recording does not cover this moment');
    await mkdir(dest, { recursive: true });
    const files = [];
    for (const segment of usable) {
      const file = join(dest, basename(segment.file));
      await copyFile(segment.file, file);
      files.push({ ...segment, file });
    }
    return { login: this.login, files, start: files[0].at, end: files.at(-1).at + files.at(-1).duration * 1000 };
  }

  status() {
    const first = this.index[0];
    const last = this.index.at(-1);
    return {
      login: this.login,
      state: this.state,
      game: this.game,
      bufferedSeconds: first && last ? Math.round((last.at + last.duration * 1000 - first.at) / 1000) : 0,
      adSeconds: Math.round(this.adSeconds),
      lastError: this.lastError,
    };
  }
}

// ---------------------------------------------------------------------------
// Cutting from a snapshot
// ---------------------------------------------------------------------------

/** ffmpeg's concat-list syntax: one quoted path per line. */
export const concatList = (files) =>
  `${files.map(({ file }) => `file '${String(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')}\n`;

/**
 * Where the init segment (ftyp + moov) ends in a stored fragmented-MP4
 * segment, or 0 for MPEG-TS. Read from the top-level box sizes.
 */
export function initLength(bytes) {
  for (let i = 0; i + 8 <= bytes.length; ) {
    const size = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    if (size < 8) return 0;
    if (type === 'moov') return i + size;
    if (type !== 'ftyp') return 0;
    i += size;
  }
  return 0;
}

/**
 * The files ffmpeg should read for a snapshot. MPEG-TS segments are read as
 * they are. Fragmented-MP4 ones are joined into one continuous file per run
 * of the same init segment — one init, then every fragment — because read as
 * separate files ffmpeg takes each one's length wrong and the cut comes out a
 * single segment long.
 */
export async function joinFragments(files, { dir, name }) {
  if (!files.length || !files[0].file.endsWith('.mp4')) return { files, temp: [] };
  const runs = [];
  for (const segment of files) {
    const bytes = await readFile(segment.file);
    const cut = initLength(bytes);
    const init = bytes.subarray(0, cut);
    const run = runs.at(-1);
    if (run && cut && run.init.equals(init)) run.parts.push(bytes.subarray(cut));
    else runs.push({ init, parts: [bytes] });
  }
  const temp = [];
  for (const [i, run] of runs.entries()) {
    const file = join(dir, `${name}.joined-${i}.mp4`);
    await writeFile(file, Buffer.concat(run.parts));
    temp.push(file);
  }
  return { files: temp.map((file) => ({ file })), temp };
}

/**
 * A landscape cut of [anchor - pre, anchor + post] from a snapshot, shaped
 * like extractClip's result so everything downstream — the meter, the redo,
 * the render, the checks — treats it the same as a cut from a VOD. Times are
 * seconds from the snapshot's start.
 */
export async function cutFromSnapshot(snapshot, { anchorAt, pre, post, dir, name }) {
  const from = Math.max(snapshot.start, anchorAt - pre * 1000);
  const to = Math.min(snapshot.end, anchorAt + post * 1000);
  const list = join(dir, `${name}.concat.txt`);
  const out = join(dir, `${name}.mp4`);
  await mkdir(dir, { recursive: true });
  // ffmpeg reads a concat list's relative paths from the list's own folder,
  // not the working directory, so every path goes in absolute.
  const joined = await joinFragments(
    snapshot.files.map((f) => ({ ...f, file: resolve(config.root, f.file) })),
    { dir: resolve(config.root, dir), name },
  );
  await writeFile(list, concatList(joined.files), 'utf8');
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'concat', '-safe', '0', '-i', list,
        '-ss', ((from - snapshot.start) / 1000).toFixed(3),
        '-t', ((to - from) / 1000).toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
        out,
      ],
      { cwd: config.root, label: 'ffmpeg' },
    );
  } finally {
    await rm(list, { force: true });
    await Promise.all(joined.temp.map((file) => rm(file, { force: true })));
  }
  return {
    path: out,
    start: (from - snapshot.start) / 1000,
    offsetSeconds: (anchorAt - snapshot.start) / 1000,
    durationSeconds: Math.round((to - from) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Which channels to record
// ---------------------------------------------------------------------------

/**
 * Decides which channels need recording and keeps that many recorders
 * running. A channel needs one when it is live, playing a clipped game, and
 * its moments cannot be cut from a VOD. One channel's page is checked every
 * few seconds, round-robin — a plain web request, no subprocess — and the
 * VOD question is asked only of channels that pass the first two tests.
 */
const STICKY = 1.5;

export class RecorderManager {
  constructor({
    feed,
    log = () => {},
    max = config.recordMax,
    games = config.games,
    dir = join(config.clipDir, '.live'),
    checkPage = fetchChannelPage,
    hasVod = defaultHasVod,
    createRecorder = (options) => new LiveRecorder(options),
    now = () => Date.now(),
  } = {}) {
    this.feed = feed;
    this.log = log;
    this.max = max;
    this.games = new Set(games.map((g) => g.toLowerCase()));
    // Twitch's page gives the game in lower case; titles want it as configured.
    this.gameNames = new Map(games.map((g) => [g.toLowerCase(), g]));
    this.dir = dir;
    this.checkPage = checkPage;
    this.hasVod = hasVod;
    this.createRecorder = createRecorder;
    this.now = now;
    this.channels = [];
    this.cursor = 0;
    this.seen = new Map(); // login -> {live, game, viewers, vod, checkedAt}
    this.recorders = new Map();
    this.timer = null;
  }

  setChannels(channels) {
    this.channels = [...channels];
    for (const login of [...this.recorders.keys()]) if (!this.channels.includes(login)) this.drop(login, 'removed from the list');
  }

  start(intervalMs = 3000) {
    this.timer = setInterval(() => this.sweepOne().catch(() => {}), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    for (const login of [...this.recorders.keys()]) this.drop(login, 'shutting down');
  }

  /** Check the next channel, and start or stop recorders to match. */
  async sweepOne() {
    if (!this.channels.length) return;
    const login = this.channels[this.cursor % this.channels.length];
    this.cursor += 1;
    const known = this.seen.get(login);
    if (known && this.now() - known.checkedAt < 3 * 60_000) return;

    let page;
    try {
      page = await this.checkPage(login);
    } catch {
      return; // try again on the next pass
    }
    const playing = page.live && page.game && this.games.has(page.game.toLowerCase());
    let vod = known?.vod;
    if (playing && (vod === undefined || this.now() - (known?.vodAt || 0) > 30 * 60_000)) {
      vod = await this.hasVod(login, this.feed);
    }
    this.seen.set(login, { ...page, vod, vodAt: vod === known?.vod ? known?.vodAt : this.now(), checkedAt: this.now() });

    const recorder = this.recorders.get(login);
    if (recorder) recorder.game = this.gameName(page.game);
    if (!playing || vod === true) {
      if (recorder) this.drop(login, !page.live ? 'went offline' : vod === true ? 'its VOD can be cut now' : `switched to ${page.game}`);
      return;
    }
    if (vod === false) this.rebalance();
  }

  /** Keep the most-watched channels that need recording, up to the cap. */
  rebalance() {
    const eligible = [...this.seen.entries()].filter(
      ([login, s]) => this.channels.includes(login) && s.live && s.vod === false && s.game && this.games.has(s.game.toLowerCase()),
    );
    // A running recording counts for half again its viewers: two channels of
    // about the same size must not swap places every few minutes, since each
    // restart costs another pre-roll ad and throws the buffer away.
    const weight = ([login, s]) => s.viewers * (this.recorders.has(login) ? STICKY : 1);
    const wanted = eligible
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, this.max)
      .map(([login]) => login);
    const stillEligible = new Set(eligible.map(([login]) => login));
    for (const login of [...this.recorders.keys()]) {
      if (wanted.includes(login)) continue;
      this.drop(login, stillEligible.has(login) ? 'a bigger channel needs the slot' : 'it is offline, off the list, or has a VOD now');
    }
    for (const login of wanted) {
      if (this.recorders.has(login)) continue;
      const recorder = this.createRecorder({ login, dir: join(this.dir, login), log: this.log });
      recorder.game = this.gameName(this.seen.get(login)?.game);
      this.recorders.set(login, recorder);
      recorder.start();
      this.log(`recording ${login} live (${recorder.game}): it has no VOD to cut from`);
    }
  }

  gameName(game) {
    return game ? this.gameNames.get(game.toLowerCase()) || game : null;
  }

  drop(login, why) {
    const recorder = this.recorders.get(login);
    if (!recorder) return;
    recorder.stop();
    this.recorders.delete(login);
    rm(recorder.dir, { recursive: true, force: true }).catch(() => {});
    this.log(`stopped recording ${login}: ${why}`);
  }

  get(login) {
    const recorder = this.recorders.get(String(login || '').toLowerCase());
    return recorder && recorder.state === 'recording' ? recorder : null;
  }

  status() {
    return [...this.recorders.values()].map((r) => r.status());
  }
}

/**
 * Whether a channel's moments can be cut from its VOD: the feed's own
 * knowledge first, then the same recording lookup the feed uses. A lookup
 * that fails for a reason that passes answers "don't know" (undefined), so
 * the next pass asks again rather than recording on a guess.
 */
async function defaultHasVod(login, feed) {
  const channel = feed?.channels?.get(login);
  if (channel?.vodId) return true;
  if (channel?.lookupError) return false; // subscriber-only and the like
  const { findLiveArchive } = await import('./archive.js');
  try {
    return Boolean(await findLiveArchive(login));
  } catch (err) {
    return /subscriber-only|logged into an account/i.test(err.message) ? false : undefined;
  }
}

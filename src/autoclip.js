// Autocollect: the feed decides, this cuts.
//
// After every poll the ranked moments go through the rules below, and the ones
// that pass are cut, captioned and rendered into a folder of finished shorts
// with no one clicking anything. Each rule is here because of a specific way
// this goes wrong without it:
//
//   * one of your channels — like a channel automation, it clips the channels
//     you added and nothing else
//   * a VOD and a position in it — without both there is nothing to cut
//   * early or fresh only — a flooded moment is already on everyone's feed
//   * settled — the end of the cut must be SETTLE seconds in the past, or the
//     archive may not hold it yet. Measured on a live, still-recording
//     archive: a cut ending 15s behind the live edge came back full length
//     with moving footage. The default of 30 is double that.
//   * not stale — after MAX_AGE someone else has posted it
//   * not already cut — by id, and ALSO by position on the same VOD, because
//     a chat spike that clips later confirm can come back under a new id
//   * rate caps, overall and per channel — every cut is a re-encode, and a
//     folder of one streamer is not a feed anybody wants
//
// The caps are the real control. AUTOCLIP_MIN_SCORE exists but defaults to 0
// because nothing has calibrated the opportunity scale yet; that is what
// `npm run eval` is for, and until it has spoken a threshold would be a guess
// presented as a setting.
//
// Finding WHERE a chat moment sits in a live recording is the feed's job (see
// archive.js); by the time a moment reaches here it either has a VOD position
// or it cannot be cut.

import { join, relative, resolve } from 'node:path';

import { config, root } from './config.js';
import { enqueueClip } from './clipjobs.js';
import { captionFor } from './shortform.js';

const HOUR = 3_600_000;

const num = (value, fallback) => {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function autoclipConfig(source = process.env) {
  return {
    // Empty means every channel the feed sees. The automation panel fills it.
    channels: [],
    // Only these games are clipped. A moment whose game cannot be told is
    // skipped rather than guessed: the first live test without this cut World
    // of Warcraft and tagged it #gta6.
    games: [...config.games],
    minScore: num(source.AUTOCLIP_MIN_SCORE, 0),
    states: String(source.AUTOCLIP_STATES ?? 'early,fresh')
      .split(',')
      .map((state) => state.trim())
      .filter(Boolean),
    // Volume. This caps how many, not how hard the machine works: that is the
    // two-renders-at-once limit. Two jobs at 40-90s each (cut, review,
    // render, checks) leave room for 60 an hour. Raised from 30 after live
    // runs hit 30 inside the hour. The per-channel cap keeps one hot streamer
    // from being the whole folder.
    perHour: num(source.AUTOCLIP_PER_HOUR, 60),
    // The hourly cap is first-come across the hour, so a moment better than
    // anything the hour has produced could arrive after it filled and never
    // be cut — and the uploader can only choose from what was cut. Measured
    // over 6,069 moments: the best one in the store (opportunity 55.6) was
    // never cut, and five uncut moments beat the best ever cut (35.3). So a
    // moment that beats everything already cut this hour gets through anyway,
    // up to this many an hour on top of the cap.
    beatsHourPerHour: num(source.AUTOCLIP_BEATS_HOUR_PER_HOUR, 5),
    perChannelPerHour: num(source.AUTOCLIP_PER_CHANNEL_PER_HOUR, 6),
    maxPerPoll: num(source.AUTOCLIP_MAX_PER_POLL, 4),
    settleSeconds: num(source.AUTOCLIP_SETTLE_SECONDS, 30),
    maxAgeMinutes: num(source.AUTOCLIP_MAX_AGE_MINUTES, 20),
    dedupeSeconds: num(source.AUTOCLIP_DEDUPE_SECONDS, 45),
    pre: config.clipPre,
    post: config.clipPost,
    dir: resolve(root, source.AUTOCLIP_DIR || join(config.clipDir, 'ready')),
    workDir: join(config.clipDir, '.work'),
  };
}

/** The VOD position a cut is built around: where people reacted. */
/**
 * How much to cut either side of the offset, by where the offset came from.
 *
 * The default 25s before and 5s after is built for a CHAT offset: chat
 * reacts after the thing happens, so the moment sits well before it. That is
 * reasoning (broadcast delay plus reaction time), not a measurement: no
 * valid figure for chat's lag exists, and it should not be quoted as one.
 *
 * The AUDIO branch is DORMANT, and its numbers have no evidence behind them.
 * It was added for detection to set reactionOffsetSeconds to the stream's
 * audio peak when that peak cleared a confidence floor, on a measured ~7s
 * lead of audio over chat. That lead did not replicate: over 60 moments the
 * audio peak came first in exactly 50%, and neither burst size nor isolation
 * gave a usable floor. So detection never sets reactionOffsetSeconds, and
 * fromAudio below is never true. The branch is kept, tested, in case rated
 * outcomes ever justify an audio-timed cut — but if it is opened, re-derive
 * the window from that evidence; do not inherit 22/8, which came from the
 * 7s that turned out not to exist.
 */
export const AUDIO_WINDOW = { pre: 22, post: 8 };

export function windowFor(moment, { pre, post } = {}) {
  const audio = moment?.audioOffsetSeconds;
  const fromAudio =
    typeof audio === 'number' &&
    Number.isFinite(audio) &&
    moment?.reactionOffsetSeconds === audio;
  return fromAudio ? { ...AUDIO_WINDOW, source: 'audio' } : { pre, post, source: 'chat' };
}

export function cutOffset(moment) {
  const value = moment?.reactionOffsetSeconds ?? moment?.offsetSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The channel a moment came from, as a login. A chat moment carries it in its
 * id; a clip moment only has the display name, which matches the login apart
 * from case for nearly every channel.
 */
export function momentLogin(moment) {
  const fromId = /^chat:([^:]+):/.exec(String(moment?.id || ''))?.[1];
  return String(fromId || moment?.broadcaster || '').toLowerCase();
}

/**
 * What a cut is cut from, as a key: the VOD id, or for a channel recorded
 * live, the channel. Two moments within a few seconds on the same source are
 * the same moment, whichever id they arrived under.
 */
export const sourceOf = (moment) => moment?.vodId || (moment?.live ? `live-${moment.live.login}` : null);

export const toCut = (moment, at, { overCap = false } = {}) => ({
  momentId: moment.id,
  vodId: sourceOf(moment),
  offsetSeconds: cutOffset(moment),
  broadcaster: moment.broadcaster,
  opportunity: Number.isFinite(moment.opportunity) ? moment.opportunity : null,
  overCap,
  at,
});

/**
 * Whether a moment may pass a full hourly cap: it must beat every cut this
 * hour whose score is known, and the hour must have exceptions left. Cuts
 * reloaded after a restart carry no score; with none known there is nothing
 * to beat, so no exception is made rather than one on a guess.
 */
export function beatsTheHour(moment, takenRecently, cfg) {
  const known = takenRecently.map((cut) => cut.opportunity).filter(Number.isFinite);
  if (!known.length || !Number.isFinite(moment.opportunity)) return false;
  if (takenRecently.filter((cut) => cut.overCap).length >= (cfg.beatsHourPerHour ?? 0)) return false;
  return moment.opportunity > Math.max(...known);
}

const vodKey = (id) => String(id || '').replace(/^v/, '');
const who = (name) => String(name || '').toLowerCase();

/**
 * Which moments to cut this poll. Pure, so every rule above is tested.
 *
 * `cuts` is what has already been cut: [{momentId, vodId, offsetSeconds,
 * broadcaster, at}]. Moments are considered best first, so when a cap bites
 * it is the weaker moments that lose out.
 */
export function selectForAutoclip(moments, { now = Date.now(), cuts = [], cfg = autoclipConfig() } = {}) {
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const picks = [];
  // Moments let past a full cap this poll (see beatsTheHour).
  const overCap = new Set();
  const asCut = (pick) => toCut(pick, now, { overCap: overCap.has(pick.id) });
  const recent = cuts.filter((cut) => now - cut.at < HOUR);
  const ids = new Set(cuts.map((cut) => cut.momentId));
  const channels = new Set((cfg.channels || []).map(who));
  const games = new Set((cfg.games || []).map(who));

  const ranked = [...moments].sort((a, b) => (b.opportunity ?? 0) - (a.opportunity ?? 0));

  for (const moment of ranked) {
    const offset = cutOffset(moment);
    const reactedAt = Date.parse(moment.firstClipAt);
    const taken = [...cuts, ...picks.map(asCut)];
    const takenRecently = [...recent, ...picks.map(asCut)];
    const capFull = takenRecently.length >= cfg.perHour;

    if (channels.size && !channels.has(momentLogin(moment))) skip('not-automated');
    // Before the game rules: a channel with no recording has no chapters
    // either, and counting that as an unreadable game made a quiet stretch of
    // subscriber-only channels look like a broken collector. "unknown-game"
    // now means only a recording whose game could not be read.
    // A channel recorded live has no VOD but can still be cut, once the
    // recording holds the whole window.
    else if (!moment.vodId && !moment.live) skip('no-vod');
    else if (moment.live && !moment.liveReady) skip('settling');
    else if (games.size && !moment.game) skip('unknown-game');
    else if (games.size && !games.has(who(moment.game))) skip('other-game');
    else if (offset == null) skip('no-offset');
    else if (!cfg.states.includes(moment.state)) skip('state');
    else if ((moment.opportunity ?? 0) < cfg.minScore) skip('score');
    else if (!Number.isFinite(reactedAt)) skip('no-time');
    else if (now - reactedAt > cfg.maxAgeMinutes * 60_000) skip('stale');
    else if (now < reactedAt + (cfg.post + cfg.settleSeconds) * 1000) skip('settling');
    else if (
      ids.has(moment.id) ||
      taken.some(
        (cut) =>
          vodKey(cut.vodId) === vodKey(sourceOf(moment)) &&
          Math.abs(cut.offsetSeconds - offset) <= cfg.dedupeSeconds,
      )
    ) {
      skip('already-cut');
    } else if (picks.length >= cfg.maxPerPoll) skip('poll-limit');
    else if (capFull && !beatsTheHour(moment, takenRecently, cfg)) skip('hourly-limit');
    else if (
      takenRecently.filter((cut) => who(cut.broadcaster) === who(moment.broadcaster)).length >=
      cfg.perChannelPerHour
    ) {
      skip('channel-limit');
    } else {
      if (capFull) overCap.add(moment.id);
      picks.push(moment);
    }
  }

  return { picks, skipped, overCap: [...overCap] };
}

// What the render needs from a moment, copied so a later poll replacing the
// feed's state cannot change a caption halfway through a job.
const snapshotOf = (moment) => ({
  id: moment.id,
  source: moment.source,
  broadcaster: moment.broadcaster,
  vodId: moment.vodId,
  title: moment.title,
  game: moment.game || null,
  audioZ: Number.isFinite(moment.audioZ) ? moment.audioZ : null,
  audioBurst: Number.isFinite(moment.audioBurst) ? moment.audioBurst : null,
  chat: moment.chat ? { classes: moment.chat.classes } : null,
});

export class AutoClipper {
  constructor({
    store = null,
    log = () => {},
    enqueue = enqueueClip,
    now = () => Date.now(),
    cfg = autoclipConfig(),
    // For a channel recorded live: copies the recording around a moment out
    // of the rolling buffer, so a queued job cannot lose it.
    snapshotLive = null,
  } = {}) {
    this.store = store;
    this.log = log;
    this.enqueue = enqueue;
    this.now = now;
    this.cfg = cfg;
    this.snapshotLive = snapshotLive;
    this.cuts = [];
    this.totals = { queued: 0, done: 0, failed: 0 };
    this.lastSkipped = {};
    // Titles already used, so the next one is different. Loaded from the
    // store, so a restart does not start repeating itself.
    this.recentCaptions = [];
    this.music = false;
  }

  /** Background music on or off, for shorts queued from now. */
  setMusic(on) {
    this.music = Boolean(on);
  }

  rememberCaption(caption) {
    if (!caption) return;
    this.recentCaptions.push(caption);
    if (this.recentCaptions.length > 80) this.recentCaptions.splice(0, this.recentCaptions.length - 80);
  }

  /** Which channels to clip. Empty means every channel the feed sees. */
  setChannels(channels = []) {
    this.cfg = { ...this.cfg, channels: [...channels] };
  }

  setGames(games = []) {
    this.cfg = { ...this.cfg, games: [...games] };
  }

  /** Remember what earlier runs cut, so a restart does not cut it again. */
  load() {
    if (!this.store) {
      this.log('autocollect: no store, so a restart will forget what was already cut');
      return 0;
    }
    const interrupted = this.store.markInterruptedAutoclips();
    if (interrupted) this.log(`autocollect: ${interrupted} cut(s) were interrupted by the last shutdown`);
    this.cuts = this.store
      .recentAutoclips({ since: this.now() - 24 * HOUR })
      .map((row) => ({ ...row, overCap: row.overCap === 1, at: Date.parse(row.createdAt) }));
    for (const row of this.store.listAutoclips({ limit: 80 }).reverse()) this.rememberCaption(row.caption);
    return this.cuts.length;
  }

  async onPoll(moments) {
    const now = this.now();
    this.cuts = this.cuts.filter((cut) => now - cut.at < 24 * HOUR);
    const { picks, skipped, overCap } = selectForAutoclip(moments, { now, cuts: this.cuts, cfg: this.cfg });
    this.lastSkipped = skipped;
    this.lastPicks = picks.length;
    // One at a time: a live moment's claim copies its recording first.
    const jobs = [];
    for (const moment of picks) {
      const job = await this.cut(moment, now, { overCap: overCap.includes(moment.id) });
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async cut(moment, now, { overCap = false } = {}) {
    // Provisional: the render replaces it with one about what was said.
    const caption = captionFor(moment, { avoid: this.recentCaptions });
    // Marked when it passed a full cap, so the hour's exceptions stay bounded.
    const cut = toCut(moment, now, { overCap });
    if (overCap) this.log(`autocollect: ${moment.broadcaster} beats everything cut this hour — cut past the hourly cap`);

    // Claimed BEFORE it is queued. If the process dies mid-render the row
    // survives, and the next run knows not to cut this moment again.
    if (this.store) {
      try {
        if (!this.store.recordAutoclip({ ...cut, caption, at: new Date(now) })) return null;
      } catch (err) {
        this.log(`autocollect: could not record ${moment.id}: ${err.message}`);
      }
    }
    this.cuts.push(cut);
    this.totals.queued += 1;

    // A live moment's recording is copied out now, while the buffer still
    // holds it: the job may wait in the queue longer than the buffer keeps.
    let live = null;
    if (moment.live) {
      try {
        live = await this.snapshotLive(moment);
      } catch (err) {
        this.totals.failed += 1;
        this.log(`autocollect: ${moment.broadcaster}'s recording could not be kept: ${err.message}`);
        this.store?.finishAutoclip(moment.id, { status: 'failed', error: err.message });
        return null;
      }
    }

    this.log(
      `autocollect: cutting ${moment.broadcaster} ${live ? '(live recording)' : `at ${cut.offsetSeconds}s`} — "${caption}"`,
    );
    return this.enqueue({
      live,
      vodId: moment.vodId,
      offsetSeconds: cut.offsetSeconds,
      ...(({ pre, post }) => ({ pre, post }))(windowFor(moment, this.cfg)),
      broadcaster: moment.broadcaster,
      momentId: moment.id,
      dir: this.cfg.workDir,
      short: {
        dir: this.cfg.dir,
        moment: snapshotOf(moment),
        auto: true,
        avoid: [...this.recentCaptions, caption],
        music: this.music,
      },
      onSettled: (job) => this.settled(moment, job),
    });
  }

  settled(moment, job) {
    const ok = job.state === 'done';
    this.totals[ok ? 'done' : 'failed'] += 1;
    if (ok) {
      this.rememberCaption(job.caption);
      // The description too, so the next one about this channel reads differently.
      if (job.description) this.rememberCaption(job.description);
    }
    // No subtitles is a degraded short, not a failed one — but worth saying.
    if (ok && job.speechError) this.log(`autocollect: no subtitles for ${moment.broadcaster}: ${job.speechError}`);
    try {
      this.store?.finishAutoclip(moment.id, {
        status: ok ? 'done' : 'failed',
        path: job.shortPath,
        error: ok ? null : job.message,
        caption: ok ? job.caption : null,
        review: job.review
          ? {
              ...job.review,
              audioZ: moment.audioZ ?? null,
              // Detection's burst, beside the meter's own (job.review.burst), so
              // the two can be compared on real shorts before either replaces
              // the other.
              audioBurst: moment.audioBurst ?? null,
              window: windowFor(moment, this.cfg).source,
            }
          : null,
      });
    } catch (err) {
      this.log(`autocollect: could not record the result for ${moment.id}: ${err.message}`);
    }
    this.log(
      ok
        ? `autocollect: ready -> ${relative(root, job.shortPath)} — "${job.caption}"` +
            (job.review ? ` · score ${job.review.score}${job.review.redone ? ` (re-cut from ${job.review.before})` : ''}${job.review.weak ? ' · WEAK' : ''}` : '')
        : `autocollect: ${moment.broadcaster} failed — ${job.message}`,
    );
  }

  status() {
    const now = this.now();
    return {
      ...this.totals,
      lastHour: this.cuts.filter((cut) => now - cut.at < HOUR).length,
      perHour: this.cfg.perHour,
      dir: relative(root, this.cfg.dir),
      skipped: this.lastSkipped,
    };
  }
}

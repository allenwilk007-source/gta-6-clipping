import { config } from './config.js';
import { ChatWatcher } from './chat.js';
import {
  chatCandidateMoments,
  clusterClips,
  mergeChatCandidates,
  publicMoments,
  scoreMoments,
} from './moments.js';
import { findLiveArchive } from './archive.js';
import { probeLoudnessAt } from './audio.js';
import { HORIZONS, openStore } from './store.js';
import { Twitch } from './twitch.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const defaultLog = (message) => console.log(`[${stamp()}] ${message}`);

/**
 * Owns the polling loops and the current feed state.
 *
 * Two loops at different rates: clips every 30s because that's the signal, and
 * live channels every couple of minutes because the top of a category barely
 * moves and each refresh costs several requests.
 */
// Lookups that will never succeed by asking again.
export const PERMANENT_LOOKUP = /subscriber-only|logged into an account|does not exist|HTTP Error 404/i;

/** 30s, 60s, 2m, 4m, then every 5m: soon at first, never a storm. */
export const retryDelay = (failures) => Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));

/**
 * When a channel's recording should next be looked up. A retry after a
 * failure takes precedence; otherwise every five minutes while recording
 * (the chapters say which game is on, and a streamer can switch) and every
 * ten when not.
 */
export function lookupDueAt(channel) {
  if (channel.retryAt) return channel.retryAt;
  if (!channel.archiveCheckedAt) return 0;
  return channel.archiveCheckedAt + (channel.vodId ? 5 * 60_000 : 10 * 60_000);
}

export class Feed {
  /**
   * `chat` and `watchChannels` exist to be injected. The chat watcher opens
   * real IRC sockets the moment it is given a channel, so a test of the
   * chat-only path has to be able to hand in one that does not.
   */
  constructor({ log = defaultLog, chat, store, watchChannels, findArchive, probe } = {}) {
    this.log = log;
    // Where a watched channel is recording, found without credentials. Tests
    // inject a stand-in, since the real one runs yt-dlp against Twitch.
    this.findArchive = findArchive !== undefined ? findArchive : findLiveArchive;
    // How recording lookups are going, so a collector that has stopped being
    // able to place anything says so instead of looking healthy.
    this.lookups = { failures: 0, consecutive: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
    // Which kinds of poll are running now, and how many ticks found one still
    // going (see tick()).
    this.inFlight = new Set();
    this.skippedTicks = {};
    this.twitch = new Twitch({ log });
    this.chat =
      chat !== undefined ? chat : config.chatEnabled ? new ChatWatcher({ log }) : null;
    this.watchChannels = watchChannels || config.watchChannels;
    // Same reason as findArchive: the real probe spawns yt-dlp and ffmpeg.
    this.probe = probe || probeLoudnessAt;

    // Injected as null by tests, which must not open the real database.
    this.store =
      store !== undefined ? store : config.storeEnabled ? openStore(config.storePath, { log }) : null;

    this.game = null;
    // Set by retarget() when the panel changes the categories; null means use
    // whatever the config started with.
    this.gameNames = null;
    this.games = [];
    this.moments = [];
    this.streams = new Map();
    this.previousSaturation = new Map();
    // login -> {broadcasterId, vodId, startedAt, ...}. The VOD id is looked up
    // once per spiking channel and kept for the length of that broadcast.
    this.channels = new Map();
    this.outcomeCursor = 0;
    // momentId -> {burst, z, at} once probed, or null once attempted and
    // failed. Either way the moment is never probed twice.
    this.audioByMoment = new Map();
    this.lastPruneAt = Date.now();

    this.lastClipPoll = null;
    this.lastStreamPoll = null;
    this.lastError = null;
    this.clipCount = 0;
    this.truncated = false;
    this.timers = [];
    this.started = false;
  }

  get configured() {
    return this.twitch.configured;
  }

  /**
   * True when there is no app token, so every Helix call would fail.
   *
   * Chat is anonymous and unmetered, which makes it the one signal that still
   * works in this state — and the only one that can fire before anybody has
   * clipped. So a missing credential degrades the feed instead of stopping it.
   */
  get chatOnly() {
    return !this.twitch.configured;
  }

  /** The categories to watch: what the panel chose, else what config started with. */
  get wantedGames() {
    return this.gameNames?.length ? this.gameNames : config.games;
  }

  /**
   * Point the feed at different categories while it is running.
   *
   * init() resolves names to category ids once and then short-circuits on
   * this.game, so the ids have to be cleared or the poller goes on asking
   * about the old ones while the panel shows the new names.
   */
  async retarget(names = []) {
    const wanted = [...names].filter(Boolean);
    if (!wanted.length) return this.game;
    if (wanted.join() === this.wantedGames.join()) return this.game;
    this.gameNames = wanted;
    this.game = null;
    return this.init();
  }

  async init() {
    if (this.game) return this.game;
    if (this.chatOnly) {
      // No category to resolve: the watch list IS the scope. Which game each
      // moment came from is read off the recording's chapters instead.
      this.games = this.wantedGames.map((name) => ({ id: null, name }));
      this.game = { id: null, name: `${this.watchChannels.length} watched channels` };
      this.log(`no credentials — chat-only on ${this.watchChannels.length} channels`);
      return this.game;
    }

    if (config.gameId) {
      this.games = [await this.twitch.gameById(config.gameId)];
    } else {
      this.games = [];
      for (const name of this.wantedGames) {
        try {
          this.games.push(await this.twitch.resolveGame(name));
        } catch (err) {
          // One misspelled category should not take the others down with it.
          this.log(`could not find the "${name}" category: ${err.message}`);
        }
      }
      if (!this.games.length) throw new Error(`none of ${this.wantedGames.join(', ')} is a Twitch category`);
    }
    this.game = {
      id: this.games.map((game) => game.id).join(','),
      name: this.games.map((game) => game.name).join(' + '),
    };
    this.log(`watching ${this.games.map((game) => `"${game.name}" (id ${game.id})`).join(', ')}`);
    return this.game;
  }

  /**
   * Stand in for pollStreams when Helix is unavailable.
   *
   * Everything Helix would supply — broadcaster id, stream start, viewers, VOD
   * id — is genuinely unknown here, and is left null rather than guessed. The
   * consequences are honest and contained: no VOD timestamp, so deepLink falls
   * back to the live channel, and no local clip extraction until a VOD exists.
   */
  setWatchList(logins = this.watchChannels) {
    this.watchChannels = [...logins];
    // The header reads this, and the automation panel can change the list.
    if (this.chatOnly && this.game) this.game.name = `${this.watchChannels.length} watched channels`;
    const next = new Map();
    for (const login of logins) {
      const key = String(login).toLowerCase();
      if (!key) continue;
      // Editing the list must not forget a recording already found: that is a
      // lookup per channel, and the channel is still on the same broadcast.
      const known = this.channels.get(key);
      next.set(key, {
        broadcasterId: null,
        displayName: known?.displayName || key,
        startedAt: known?.startedAt ?? null,
        title: '',
        viewers: null,
        vodId: known?.vodId ?? null,
        chapters: known?.chapters ?? null,
        archiveCheckedAt: known?.archiveCheckedAt ?? null,
        retryAt: known?.retryAt ?? null,
        lookupFailures: known?.lookupFailures ?? 0,
        lookupError: known?.lookupError ?? null,
      });
    }
    this.channels = next;
    this.chat?.setChannels([...next.keys()]);
    this.lastStreamPoll = new Date().toISOString();
    return next;
  }

  /**
   * One detection pass with chat as the only input.
   *
   * Deliberately not a cut-down pollClips: it runs the same
   * chatCandidateMoments -> scoreMoments path, so a moment found this way is
   * scored, stored and rendered exactly like any other. The ranking stays
   * comparable, and the store keeps collecting the longitudinal data the
   * clipper index needs whether or not a token ever shows up.
   */
  async pollChat() {
    const now = Date.now();
    const candidates = this.chat ? this.chat.candidates({ now }) : [];
    // Before scoring, so a channel that turns out to be recording gets a real
    // VOD position on this pass rather than the next one.
    await this.placeLiveRecordings(candidates, now);

    const scored = scoreMoments(
      chatCandidateMoments(candidates, { channels: this.channels }),
      {
        now,
        chatSpikes: this.chat ? this.chat.spikes() : new Map(),
        streams: this.streams,
        previous: this.previousSaturation,
        leadInSeconds: config.leadInSeconds,
      },
    );

    await this.measureAudio(scored);

    const nextPrevious = new Map();
    for (const moment of scored) nextPrevious.set(moment.id, moment.saturation);
    this.previousSaturation = nextPrevious;

    this.moments = scored;
    this.clipCount = 0;
    this.truncated = false;
    this.lastClipPoll = new Date(now).toISOString();
    this.lastError = null;

    if (this.store) {
      try {
        this.store.recordPoll({ moments: scored, gameId: null, at: new Date(now) });
      } catch (err) {
        this.log(`store write failed: ${err.message}`);
      }
    }

    return scored;
  }

  /**
   * Fill in, for each spiking channel, the recording it is streaming to.
   *
   * Chat-only has no Helix, so no stream start and no VOD id, and without them
   * a moment can be watched but not cut. archive.js finds both anonymously.
   * Stored as the channel's startedAt and vodId, chatCandidateMoments then
   * places the moment itself — and since the start used is the RECORDING's
   * own zero point, the offset is a position in that VOD.
   *
   * At most three channels a poll, and once per broadcast: re-checked after
   * thirty minutes when found (the stream may have ended and restarted), and
   * after ten when not (it may have started recording).
   */
  async placeLiveRecordings(candidates, now = Date.now()) {
    if (!this.findArchive) return;
    let lookups = 0;
    for (const login of new Set(candidates.map((candidate) => candidate.login))) {
      const channel = this.channels.get(login);
      if (!channel) continue;
      if (now < lookupDueAt(channel)) continue;
      if (lookups >= 3) break;
      lookups += 1;

      let archive = null;
      let error = null;
      try {
        archive = await this.findArchive(login);
      } catch (err) {
        error = String(err.message).split(/\r?\n/)[0];
      }

      // A failed lookup says nothing about whether the channel is recording.
      // Treating it as "not recording" used to wipe a channel's known VOD and
      // chapters on one transient error, so its moments lost their game and
      // were all skipped — and with a lookup failing on every poll, a whole
      // collector went inert for 35 minutes while its log looked healthy.
      // So keep what was known, and ask again soon, backing off.
      if (error && !PERMANENT_LOOKUP.test(error)) {
        channel.lookupFailures = (channel.lookupFailures || 0) + 1;
        channel.lookupError = error;
        channel.retryAt = now + retryDelay(channel.lookupFailures);
        this.lookups.failures += 1;
        this.lookups.consecutive += 1;
        this.lookups.lastError = error;
        this.lookups.lastErrorAt = new Date(now).toISOString();
        this.log(
          `recording lookup failed for ${login} (${channel.lookupFailures} in a row, again in ` +
            `${Math.round(retryDelay(channel.lookupFailures) / 1000)}s): ${error}`,
        );
        continue;
      }

      // An answer, even "nothing to cut": this channel's lookup is healthy.
      this.lookups.consecutive = 0;
      this.lookups.lastOkAt = new Date(now).toISOString();
      channel.lookupFailures = 0;
      channel.retryAt = null;
      channel.archiveCheckedAt = now;
      // A subscriber-only VOD is an answer too: it cannot be cut without a
      // login, so it is noted once rather than retried every few seconds.
      channel.lookupError = error;
      const before = channel.vodId;
      channel.vodId = archive?.vodId || null;
      channel.startedAt = archive ? new Date(archive.startedAt).toISOString() : null;
      channel.chapters = archive?.chapters || null;
      if (channel.vodId !== before) {
        this.log(
          archive
            ? `${login} is recording to ${archive.vodId} — its moments can be cut`
            : error
              ? `${login}'s recording cannot be cut (${error.slice(0, 60)}) — its moments can be watched, not cut`
              : `${login} has no recording in progress — its moments can be watched, not cut`,
        );
      }
    }
  }

  async pollStreams() {
    // Every game, merged and ranked by viewers, so the chat budget goes to the
    // biggest channels across all of them rather than all of the first game.
    const perGame = await Promise.all(this.games.map((game) => this.twitch.liveStreams(game.id, 100)));
    const streams = perGame.flat().sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));
    this.streams = new Map(streams.map((s) => [s.user_id, s]));
    this.lastStreamPoll = new Date().toISOString();

    // Keep what a chat-only moment needs to describe itself, and keep any VOD
    // id already resolved for a channel that is still on the same broadcast.
    const next = new Map();
    for (const stream of streams) {
      const login = (stream.user_login || '').toLowerCase();
      if (!login) continue;
      const known = this.channels.get(login);
      next.set(login, {
        broadcasterId: stream.user_id,
        displayName: stream.user_name || login,
        startedAt: stream.started_at,
        title: stream.title,
        viewers: stream.viewer_count,
        game: stream.game_name || null,
        vodId: known?.startedAt === stream.started_at ? known.vodId : null,
      });
    }
    this.channels = next;

    if (this.chat) {
      const logins = streams
        .slice(0, config.chatChannels)
        .map((s) => s.user_login)
        .filter(Boolean);
      this.chat.setChannels(logins);
    }

    this.log(`${streams.length} live channels`);
    return streams;
  }

  async pollClips() {
    const now = Date.now();
    const startedAt = new Date(now - config.clipWindowMinutes * 60_000).toISOString();

    const perGame = await Promise.all(
      this.games.map((game) =>
        this.twitch.recentClips({
          gameId: game.id,
          startedAt,
          endedAt: new Date(now).toISOString(),
          maxPages: config.clipMaxPages,
        }),
      ),
    );
    const clips = perGame.flatMap((result) => result.clips);
    const truncated = perGame.some((result) => result.truncated);

    // A clip carries its category id; the moment carries the game's name, so
    // automation and the post copy can tell GTA from Fortnite.
    const names = new Map(this.games.map((game) => [String(game.id), game.name]));
    const clustered = clusterClips(clips, { gapSeconds: config.clusterGapSeconds });
    for (const moment of clustered) moment.game = names.get(String(moment.gameId)) || null;

    // Chat spikes that nothing has been clipped from yet. These are the only
    // rows in the feed that can beat the crowd rather than merely keep up with
    // it, so they are folded in before scoring, not bolted on after.
    const candidates = this.chat ? this.chat.candidates({ now }) : [];
    await this.resolveVodIds(candidates);
    const withChat = mergeChatCandidates(
      clustered,
      chatCandidateMoments(candidates, { channels: this.channels }),
      { beforeSeconds: 60, afterSeconds: 180 },
    );

    const scored = scoreMoments(withChat, {
      now,
      chatSpikes: this.chat ? this.chat.spikes() : new Map(),
      streams: this.streams,
      previous: this.previousSaturation,
      leadInSeconds: config.leadInSeconds,
    });

    // Remember this round's sizes so the next one can report "+N just now",
    // dropping ids that have aged out so the map can't grow without bound.
    const nextPrevious = new Map();
    for (const moment of scored) nextPrevious.set(moment.id, moment.saturation);
    this.previousSaturation = nextPrevious;

    this.moments = scored;
    this.clipCount = clips.length;
    this.truncated = truncated;
    this.lastClipPoll = new Date(now).toISOString();
    this.lastError = null;

    if (this.store) {
      try {
        this.store.recordPoll({
          moments: scored,
          clipsById: new Map(clips.map((clip) => [clip.id, clip])),
          gameId: null, // each moment carries its own
          at: new Date(now),
        });
      } catch (err) {
        // Bookkeeping must never take the feed down with it.
        this.log(`store write failed: ${err.message}`);
      }
    }

    if (truncated) {
      this.log(
        `clip window truncated at ${config.clipMaxPages} pages — raise CLIP_MAX_PAGES or shorten CLIP_WINDOW_MINUTES`,
      );
    }
    this.log(`${clips.length} clips -> ${scored.length} moments`);
    return scored;
  }

  /**
   * Give spiking channels a real VOD id so a chat-sourced moment can be
   * clipped like any other. Only the handful of channels with a live candidate
   * are looked up, and only once per broadcast, because this is a request per
   * channel and the rate limit is shared with the thing that matters.
   */
  async resolveVodIds(candidates) {
    for (const candidate of candidates) {
      const channel = this.channels.get(candidate.login);
      if (!channel || channel.vodId || channel.vodId === false) continue;
      if (!channel.broadcasterId) continue;
      try {
        const video = await this.twitch.archiveVideo(channel.broadcasterId);
        // false, not null: a channel that does not store broadcasts should be
        // asked once, not on every poll for the rest of the stream.
        channel.vodId = video?.id || false;
      } catch (err) {
        this.log(`vod lookup failed for ${candidate.login}: ${err.message}`);
        channel.vodId = false;
      }
    }
  }

  /**
   * Attach what the stream sounded like around each moment.
   *
   * `audioBurst` is peak-over-median in dB, the same quantity engagement.js
   * scores downstream, so a cut can reuse this instead of downloading the
   * audio a second time to measure it.
   *
   * Deliberately NOT fed into the ranking. Only a few moments are probed per
   * poll, so ranking on it would be comparing moments that have the number
   * against moments that merely have not been measured yet — which rewards
   * being probed rather than being good. It becomes a ranking input when
   * coverage is complete and there is something to validate it against.
   *
   * Nor does it overwrite the cut point. The measurement that matters for
   * placement is the one taken over the real cut downstream, where the window
   * is wider and the burst can be centred properly; a 70s guess from here
   * would replace a careful number with a rough one.
   */
  async measureAudio(moments) {
    if (!config.audioProbe) return 0;

    // Remember only what is still on the feed, so the map cannot grow for the
    // length of the broadcast.
    const live = new Set(moments.map((moment) => moment.id));
    for (const id of this.audioByMoment.keys()) {
      if (!live.has(id)) this.audioByMoment.delete(id);
    }

    let probed = 0;
    for (const moment of moments) {
      if (this.audioByMoment.has(moment.id)) {
        const known = this.audioByMoment.get(moment.id);
        if (known) Object.assign(moment, known);
        continue;
      }
      if (probed >= config.audioProbePerPoll) continue;
      if (!moment.vodId || !Number.isFinite(moment.offsetSeconds)) continue;

      probed += 1;
      // Sequential: concurrent yt-dlp and ffmpeg pairs are what stopped this
      // machine creating processes at all.
      const result = await this.probe({
        vodId: moment.vodId,
        offsetSeconds: moment.offsetSeconds,
        before: config.audioProbeBefore,
        after: config.audioProbeAfter,
        log: this.log,
      });

      if (!result.ok || !result.peak) {
        this.audioByMoment.set(moment.id, null);
        continue;
      }

      const measured = {
        audioBurst: result.peak.burst,
        audioZ: result.peak.z,
        audioOffsetSeconds: result.peak.at,
      };
      this.audioByMoment.set(moment.id, measured);
      Object.assign(moment, measured);
    }

    return probed;
  }

  /**
   * What became of the moments we saw earlier.
   *
   * This is the whole reason the store exists: without an outcome, the ranking
   * is an opinion. One horizon per tick, round-robin, with a small batch —
   * nothing here is urgent and the live feed owns the rate limit.
   */
  async pollOutcomes() {
    if (!this.store) return 0;
    const horizon = HORIZONS[this.outcomeCursor % HORIZONS.length];
    this.outcomeCursor += 1;

    // Observations are the only table that grows without bound, so trim them
    // on a slow cycle rather than on a timer of their own.
    if (Date.now() - this.lastPruneAt > 6 * 3600_000) {
      this.lastPruneAt = Date.now();
      const pruned = this.store.pruneOlderThan();
      if (pruned.observations) this.log(`pruned ${pruned.observations} old observations`);
    }

    const due = this.store.dueForOutcome(horizon, { limit: config.outcomeBatch });
    let checked = 0;

    for (const momentId of due) {
      const clipIds = this.store.clipIdsFor(momentId);
      // A chat-only moment that never attracted a clip has nothing to re-poll,
      // and that emptiness is itself the outcome worth recording.
      const clips = clipIds.length ? await this.twitch.clipsByIds(clipIds) : [];
      this.store.recordOutcome({ momentId, horizon, clips });
      checked += 1;
    }

    if (checked) this.log(`outcomes: checked ${checked} moments at ${horizon.name}`);
    return checked;
  }

  async tick(kind) {
    // A poll that outlasts its interval — a slow recording lookup, a slow
    // audio probe — must not have the next one start on top of it: they are
    // timers, not a queue. Overlapping polls run their subprocesses in
    // parallel (the process bursts Windows refuses to start, 3221225794) and
    // race on the feed's state. So a poll still running is left to finish,
    // and the skipped tick is counted rather than stacked.
    if (this.inFlight.has(kind)) {
      this.skippedTicks[kind] = (this.skippedTicks[kind] || 0) + 1;
      return;
    }
    this.inFlight.add(kind);
    try {
      if (kind === 'streams') await this.pollStreams();
      else if (kind === 'outcomes') await this.pollOutcomes();
      else if (kind === 'chat') await this.pollChat();
      else await this.pollClips();
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), message: err.message };
      this.log(`${kind} poll failed: ${err.message}`);
    } finally {
      this.inFlight.delete(kind);
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;

    await this.init();
    this.chat?.start();

    if (this.chatOnly) {
      // No stream loop and no outcome loop: both are Helix. Re-polling a clip
      // that was never fetched would only write empty outcomes and make the
      // eval look like the ranking failed, when in fact it was never tested.
      this.setWatchList();
      await this.tick('chat');
      this.timers.push(setInterval(() => this.tick('chat'), config.chatPollSeconds * 1000));
      return;
    }

    await this.tick('streams');
    await this.tick('clips');

    this.timers.push(
      setInterval(() => this.tick('clips'), config.clipPollSeconds * 1000),
      setInterval(() => this.tick('streams'), config.streamPollSeconds * 1000),
    );
    if (this.store) {
      this.timers.push(
        setInterval(() => this.tick('outcomes'), config.outcomePollSeconds * 1000),
      );
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.chat?.stop();
    this.store?.close();
    this.started = false;
  }

  snapshot() {
    const counts = { early: 0, fresh: 0, warm: 0, flooded: 0 };
    for (const moment of this.moments) counts[moment.state] += 1;

    return {
      game: this.game ? { id: this.game.id, name: this.game.name } : null,
      moments: publicMoments(this.moments),
      meta: {
        counts,
        totalMoments: this.moments.length,
        clipsScanned: this.clipCount,
        truncated: this.truncated,
        windowMinutes: config.clipWindowMinutes,
        // Watched is not live: without Helix there is no way to know which of
        // these channels is actually broadcasting, and chat is quiet either
        // way, so the two numbers are reported separately.
        chatOnly: this.chatOnly,
        watchedChannels: this.channels.size,
        liveChannels: this.streams.size,
        lastClipPoll: this.lastClipPoll,
        lastStreamPoll: this.lastStreamPoll,
        pollSeconds: this.chatOnly ? config.chatPollSeconds : config.clipPollSeconds,
        chat: this.chat ? this.chat.status() : { enabled: false },
        store: this.store ? this.store.counts() : null,
        lastError: this.lastError,
      },
    };
  }
}

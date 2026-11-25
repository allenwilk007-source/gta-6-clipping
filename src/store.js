// Persistence, and the only reason it exists: a label.
//
// The ranking formula in moments.js is a hand-tuned guess. A good one, but a
// guess — no moment it has ever ranked highly has been checked against whether
// the clip went on to do anything. Without that check there is no way to tell a
// signal that works from one that merely sounds right, and no honest way to
// tune a constant.
//
// So every moment, clip and poll goes in here, and the clips of moments we have
// already seen get re-polled hours later to find out what happened. That turns
// "I think this ranks well" into a number (see eval.js).
//
// node:sqlite is in the standard library as of Node 22, which is the whole
// reason it is used: persistence without breaking the zero-dependency rule.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config.js';

// When to look back at a moment and ask what became of it. 15m catches the
// flood forming, 24h is where a clip's view count has mostly settled.
export const HORIZONS = [
  { name: '15m', seconds: 15 * 60 },
  { name: '1h', seconds: 60 * 60 },
  { name: '6h', seconds: 6 * 60 * 60 },
  { name: '24h', seconds: 24 * 60 * 60 },
];

// Bumped whenever SCHEMA changes shape. `create table if not exists` makes a
// fresh database free, but an existing one needs to know what it is already
// holding — Phase 2 adds columns, and by then there will be launch-week data
// in here that must not be thrown away to get them.
export const SCHEMA_VERSION = 4;

const SCHEMA = `
create table if not exists moments (
  id             text primary key,
  game_id        text,
  broadcaster_id text,
  broadcaster    text,
  vod_id         text,
  offset_seconds integer,
  source         text,
  title          text,
  detected_at    text not null,
  first_clip_at  text,
  saturation_at_detect integer
);

create table if not exists clips (
  id            text primary key,
  moment_id     text not null,
  creator_name  text,
  created_at    text,
  view_count    integer,
  first_seen_at text not null
);
create index if not exists clips_by_moment on clips(moment_id);

create table if not exists observations (
  moment_id       text not null,
  observed_at     text not null,
  saturation      integer,
  unique_clippers integer,
  clip_views      integer,
  chat_z          real,
  reaction        real,
  viewers         integer,
  opportunity     real
);
create index if not exists observations_by_moment on observations(moment_id);

create table if not exists outcomes (
  moment_id   text not null,
  horizon     text not null,
  recorded_at text not null,
  views       integer,
  saturation  integer,
  primary key (moment_id, horizon)
);

-- v2: what autocollect has already cut. Without this a restart would re-cut
-- every moment still inside the clip window. offset_seconds is kept so a
-- moment that changes id (a chat spike later confirmed by clips) is still
-- recognised as the same thing on the same VOD.
create table if not exists autoclips (
  moment_id      text primary key,
  vod_id         text,
  offset_seconds integer,
  broadcaster    text,
  caption        text,
  status         text not null,
  path           text,
  error          text,
  created_at     text not null,
  finished_at    text
);
create index if not exists autoclips_by_created on autoclips(created_at);

-- Every upload of a short to a platform, claimed BEFORE it starts. One row per
-- (file, platform), so nothing is ever posted twice, restart or not. A row
-- left 'uploading' by a crash is never retried on its own: the video may have
-- landed, and a duplicate is found out from the platform, not from here.
-- Dry runs are kept under their own platform name ('youtube:dry').
create table if not exists uploads (
  file        text not null,
  platform    text not null,
  status      text not null,   -- uploading | done | failed | refused | uncertain | dry-run
  video_id    text,
  title       text,
  score       integer,
  error       text,
  started_at  text not null,
  finished_at text,
  primary key (file, platform)
);
create index if not exists uploads_by_started on uploads(platform, started_at);
`;

// node:sqlite refuses to bind `undefined`, and a single missing field would
// otherwise throw in the middle of a poll and lose the whole write. Absent and
// null mean the same thing here, so make them the same thing.
const nul = (value) => (value === undefined ? null : value);
const int = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
const real = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal');
    this.db.exec('pragma synchronous = normal');
    this.version = this.migrate();

    // Prepared once and reused: this runs on every poll, every 30 seconds,
    // for every moment in the window.
    this.q = {
      insertMoment: this.db.prepare(`
        insert into moments
          (id, game_id, broadcaster_id, broadcaster, vod_id, offset_seconds,
           source, title, detected_at, first_clip_at, saturation_at_detect)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          vod_id = coalesce(excluded.vod_id, moments.vod_id),
          offset_seconds = coalesce(excluded.offset_seconds, moments.offset_seconds),
          -- a moment first seen in chat and later confirmed by clips is both
          source = case when moments.source = excluded.source then moments.source else 'both' end
      `),
      insertClip: this.db.prepare(`
        insert into clips (id, moment_id, creator_name, created_at, view_count, first_seen_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(id) do update set view_count = excluded.view_count
      `),
      insertObservation: this.db.prepare(`
        insert into observations
          (moment_id, observed_at, saturation, unique_clippers, clip_views,
           chat_z, reaction, viewers, opportunity)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      clipIds: this.db.prepare('select id from clips where moment_id = ?'),
      insertOutcome: this.db.prepare(`
        insert into outcomes (moment_id, horizon, recorded_at, views, saturation)
        values (?, ?, ?, ?, ?)
        on conflict(moment_id, horizon) do update set
          recorded_at = excluded.recorded_at,
          views = excluded.views,
          saturation = excluded.saturation
      `),
      due: this.db.prepare(`
        select id from moments
        where detected_at <= ?
          and not exists (
            select 1 from outcomes o where o.moment_id = moments.id and o.horizon = ?
          )
        order by detected_at asc
        limit ?
      `),
      insertAutoclip: this.db.prepare(`
        insert into autoclips
          (moment_id, vod_id, offset_seconds, broadcaster, caption, status, created_at, opportunity, over_cap)
        values (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        on conflict(moment_id) do nothing
      `),
      // The caption is final only after the render: it can quote what was
      // said, which is not known until the cut has been transcribed.
      finishAutoclip: this.db.prepare(`
        update autoclips set status = ?, path = ?, error = ?, finished_at = ?,
               caption = coalesce(?, caption),
               score = ?, funny = ?, redone = ?, weak = ?, review = ?
         where moment_id = ?
      `),
      recentAutoclips: this.db.prepare(`
        select moment_id as momentId, vod_id as vodId, offset_seconds as offsetSeconds,
               broadcaster, status, created_at as createdAt, opportunity, over_cap as overCap
          from autoclips where created_at >= ? order by created_at asc
      `),
      // Same VOD, near the same second: the same moment, whichever copy of
      // the app found it and under whatever id.
      nearbyAutoclip: this.db.prepare(`
        select 1 from autoclips
         where replace(vod_id, 'v', '') = replace(?, 'v', '')
           and abs(offset_seconds - ?) <= ?
           and created_at >= ?
         limit 1
      `),
      listAutoclips: this.db.prepare(`
        select moment_id as momentId, vod_id as vodId, offset_seconds as offsetSeconds,
               score, funny, redone, weak, review, opportunity,
               broadcaster, caption, status, path, error,
               created_at as createdAt, finished_at as finishedAt
          from autoclips order by created_at desc limit ?
      `),
      counts: this.db.prepare(`
        select
          (select count(*) from moments) as moments,
          (select count(*) from clips) as clips,
          (select count(*) from observations) as observations,
          (select count(*) from outcomes) as outcomes,
          (select count(*) from autoclips) as autoclips
      `),
    };
  }

  /**
   * Bring the database up to SCHEMA_VERSION.
   *
   * Deliberately additive: later versions add statements to the ladder below
   * and never rewrite history. By the time this matters there will be data in
   * here that cannot be re-collected — the clipper index is longitudinal, so a
   * migration that drops a table drops the one asset nothing can rebuild.
   */
  migrate() {
    const current = this.db.prepare('pragma user_version').get().user_version ?? 0;
    this.db.exec(SCHEMA);

    // v2 only added a table, which `create table if not exists` above already
    // handles for old and new databases alike. Column changes go here:
    const addColumns = (columns) => {
      const have = new Set(this.db.prepare('pragma table_info(autoclips)').all().map((c) => c.name));
      for (const [name, type] of columns) {
        if (!have.has(name)) this.db.exec(`alter table autoclips add column ${name} ${type}`);
      }
    };
    // v3: what the engagement meter said about each automated short.
    if (current < 3) {
      addColumns([
        ['score', 'integer'],
        ['funny', 'integer'],
        ['redone', 'integer'],
        ['weak', 'integer'],
        ['review', 'text'],
      ]);
    }
    // v4: detection's ranking of the moment when it was cut, beside the
    // meter's score of the result — a paired record of pre-cut rank against
    // post-cut judgement on every short, to test whether the ranking predicts
    // anything. Also lets the hourly cap's exception (autoclip.js) know what
    // it has to beat after a restart, and how many it has already let past.
    if (current < 4) {
      addColumns([
        ['opportunity', 'real'],
        ['over_cap', 'integer'],
      ]);
    }

    if (current !== SCHEMA_VERSION) this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    return SCHEMA_VERSION;
  }

  /**
   * Drop the bulk, keep the asset.
   *
   * `observations` is the only table that grows without bound — one row per
   * moment per poll, roughly 500 a minute at launch — and `eval` reads just the
   * EARLIEST one per moment, which is what the feed claimed while the moment
   * was still actionable. So old observations go and the first one always
   * stays.
   *
   * moments, clips and outcomes are never pruned here. They are the
   * longitudinal record the clipper index is built from, they cannot be
   * re-collected after the fact, and they are small by comparison.
   */
  pruneOlderThan(days = config.storePruneDays, { now = Date.now() } = {}) {
    const cutoff = new Date(now - Math.max(1, days) * 86_400_000).toISOString();
    const result = this.db
      .prepare(
        `delete from observations
          where observed_at < ?
            and rowid not in (select min(rowid) from observations group by moment_id)`,
      )
      .run(cutoff);
    return { observations: result.changes ?? 0, cutoff };
  }

  /**
   * One poll's worth of state.
   *
   * `detected_at` is deliberately only written on insert: it is when *we* first
   * saw the moment, which is the number the product is judged on, so a later
   * poll must never overwrite it.
   */
  recordPoll({ moments, clipsById = new Map(), gameId = null, at = new Date() }) {
    const now = at.toISOString();
    this.db.exec('begin');
    try {
      for (const moment of moments) {
        this.q.insertMoment.run(
          moment.id,
          nul(moment.gameId ?? gameId),
          nul(moment.broadcasterId),
          nul(moment.broadcaster),
          nul(moment.vodId),
          int(moment.offsetSeconds),
          moment.source || 'clips',
          moment.title || null,
          now,
          moment.firstClipAt || null,
          int(moment.saturation) ?? 0,
        );

        for (const clipId of moment.clipIds || []) {
          const clip = clipsById.get(clipId);
          if (!clip) continue;
          this.q.insertClip.run(
            clip.id,
            moment.id,
            clip.creator_name || null,
            clip.created_at || null,
            int(clip.view_count) ?? 0,
            now,
          );
        }

        this.q.insertObservation.run(
          moment.id,
          now,
          int(moment.saturation) ?? 0,
          int(moment.uniqueClippers) ?? 0,
          int(moment.clipViews) ?? 0,
          real(moment.chatZ) ?? 0,
          real(moment.reaction ?? moment.chat?.reaction ?? moment.chatZ) ?? 0,
          int(moment.viewers),
          real(moment.opportunity) ?? 0,
        );
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  /** Moments old enough for a horizon that have not been checked at it yet. */
  dueForOutcome(horizon, { now = Date.now(), limit = 20 } = {}) {
    const cutoff = new Date(now - horizon.seconds * 1000).toISOString();
    return this.q.due.all(cutoff, horizon.name, Math.max(1, Math.round(limit))).map((row) => row.id);
  }

  clipIdsFor(momentId) {
    return this.q.clipIds.all(momentId).map((row) => row.id);
  }

  /**
   * What became of a moment. `clips` is whatever Twitch still returns for the
   * ids we stored — a clip that has been deleted simply stops coming back, and
   * the shrinking count is itself the honest answer.
   */
  recordOutcome({ momentId, horizon, clips, at = new Date() }) {
    const now = at.toISOString();
    let views = 0;
    for (const clip of clips) {
      views += clip.view_count ?? 0;
      this.q.insertClip.run(
        clip.id,
        momentId,
        clip.creator_name || null,
        clip.created_at || null,
        int(clip.view_count) ?? 0,
        now,
      );
    }
    this.q.insertOutcome.run(momentId, horizon.name, now, views, clips.length);
  }

  counts() {
    return this.q.counts.get();
  }

  /** Claim a moment for autocollect. Returns false if it was already claimed. */
  recordAutoclip({
    momentId,
    vodId,
    offsetSeconds,
    broadcaster,
    caption,
    opportunity = null,
    overCap = false,
    at = new Date(),
    dedupeSeconds = 45,
  }) {
    // Checked and claimed in one locked transaction, so two copies of the app
    // cannot both decide a moment is free. Measured before this: two lirik
    // shorts six seconds apart, cut by two copies under two different ids.
    this.db.exec('begin immediate');
    try {
      const since = new Date(at.getTime() - 24 * 3600_000).toISOString();
      if (vodId && Number.isFinite(Number(offsetSeconds))) {
        const taken = this.q.nearbyAutoclip.get(String(vodId), int(offsetSeconds), dedupeSeconds, since);
        if (taken) {
          this.db.exec('rollback');
          return false;
        }
      }
      const result = this.q.insertAutoclip.run(
        momentId,
        nul(vodId),
        int(offsetSeconds),
        nul(broadcaster),
        nul(caption),
        at.toISOString(),
        real(opportunity),
        overCap ? 1 : 0,
      );
      this.db.exec('commit');
      return (result.changes ?? 0) > 0;
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  finishAutoclip(momentId, { status, path = null, error = null, caption = null, review = null, at = new Date() }) {
    this.q.finishAutoclip.run(
      status,
      nul(path),
      nul(error),
      at.toISOString(),
      nul(caption),
      int(review?.score),
      int(review?.funny),
      review ? (review.redone ? 1 : 0) : null,
      review ? (review.weak ? 1 : 0) : null,
      review
        ? JSON.stringify({
            reasons: review.reasons || [],
            parts: review.parts || null,
            before: review.before ?? null,
            // Kept so detection's audio confidence can be checked against how
            // the cut actually scored: does a confident audio offset clear the
            // redo line more often than a chat-timed one?
            audioZ: review.audioZ ?? null,
            audioBurst: review.audioBurst ?? null,
            burst: review.burst ?? null,
            window: review.window ?? null,
          })
        : null,
      momentId,
    );
  }

  /** Newest first: what the automation panel lists. */
  listAutoclips({ limit = 24 } = {}) {
    return this.q.listAutoclips.all(Math.max(1, Math.round(limit)));
  }

  recentAutoclips({ since }) {
    return this.q.recentAutoclips.all(new Date(since).toISOString());
  }

  /**
   * Anything still 'queued' at startup was running when the process died. It
   * is marked rather than retried: the moment has gone stale by now, and
   * keeping the row means it still counts against re-cutting the same thing.
   */
  markInterruptedAutoclips({ at = new Date() } = {}) {
    const result = this.db
      .prepare(`update autoclips set status = 'interrupted', finished_at = ? where status = 'queued'`)
      .run(at.toISOString());
    return result.changes ?? 0;
  }

  /** Claim (file, platform) for an upload. False if it was ever claimed before. */
  claimUpload({ file, platform, title = null, score = null, at = new Date() }) {
    const result = this.db
      .prepare(
        `insert into uploads (file, platform, status, title, score, started_at)
         values (?, ?, 'uploading', ?, ?, ?)
         on conflict (file, platform) do update set
           status = 'uploading', title = excluded.title, score = excluded.score,
           started_at = excluded.started_at, error = null, finished_at = null
         -- only a transport failure is ever tried again
         where uploads.status = 'retry'`,
      )
      .run(file, platform, nul(title), int(score), at.toISOString());
    return (result.changes ?? 0) === 1;
  }

  finishUpload({ file, platform, status, videoId = null, error = null, at = new Date() }) {
    this.db
      .prepare(`update uploads set status = ?, video_id = ?, error = ?, finished_at = ? where file = ? and platform = ?`)
      .run(status, nul(videoId), nul(error), at.toISOString(), file, platform);
  }

  /** Uploads to a platform started at or after `since`, oldest first. */
  uploadsSince(platform, since) {
    return this.db
      .prepare(`select * from uploads where platform = ? and started_at >= ? order by started_at asc`)
      .all(platform, new Date(since).toISOString());
  }

  /**
   * Everything ever sent to one platform, by outcome.
   *
   * The panel could say what happened today and what happened this week, and
   * nothing further back: a run of four failures read the same whether it was
   * the first four or the four-hundredth. This is the number an owner asks
   * for first, and it is one grouped count.
   */
  uploadTotals(platform) {
    const rows = this.db
      .prepare(`select status, count(*) as n, min(started_at) as first from uploads
                where platform = ? group by status`)
      .all(platform);
    const totals = { done: 0, failed: 0, since: null };
    for (const row of rows) {
      // 'dry-run' and 'skipped' never reached the platform, so neither is a post.
      if (row.status === 'done') totals.done += row.n;
      else if (row.status === 'failed' || row.status === 'refused') totals.failed += row.n;
      if (row.first && (totals.since === null || row.first < totals.since)) totals.since = row.first;
    }
    return totals;
  }

  uploadedFiles(platform) {
    return new Set(
      this.db.prepare("select file from uploads where platform = ? and status != 'retry'").all(platform).map((r) => r.file),
    );
  }

  lastUpload(platform) {
    // Shorts set aside by the checks never reached the platform: no spacing owed.
    return (
      this.db
        .prepare("select * from uploads where platform = ? and status != 'skipped' order by started_at desc limit 1")
        .get(platform) || null
    );
  }

  /** Shorts being uploaded right now, on any platform: never deleted mid-upload. */
  uploadingFiles() {
    return this.db.prepare("select distinct file from uploads where status = 'uploading'").all().map((r) => r.file);
  }

  /** Rows a crash left mid-upload: not retried, shown for a person to check. */
  markInterruptedUploads({ at = new Date() } = {}) {
    const result = this.db
      .prepare(`update uploads set status = 'uncertain', error = 'interrupted mid-upload: check the channel', finished_at = ? where status = 'uploading'`)
      .run(at.toISOString());
    return result.changes ?? 0;
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Never let bookkeeping take the feed down with it. A broken store is a lost
 * experiment; a broken feed is the product.
 */
export function openStore(path, { log = () => {} } = {}) {
  try {
    return new Store(path);
  } catch (err) {
    log(`store disabled: ${err.message}`);
    return null;
  }
}

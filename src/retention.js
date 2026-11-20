// Shorts nobody downloaded are deleted after a while, so clips/ready does not
// fill the disk. The pipeline makes dozens of shorts an hour; the owner keeps
// the ones they click Download on, and the rest go after SHORTS_KEEP_HOURS
// (6 by default, 0 keeps everything).
//
// Downloaded shorts are remembered in data/kept.json and never deleted here.
// A short mid-upload is never deleted either. clips/rejected is not touched.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { config } from './config.js';

const HOUR = 3_600_000;
// Every file a short is made of: the video and its post copy.
const SIDECARS = ['.mp4', '.txt', '.json'];
// The render time in the file name (…-20261119T155644Z.mp4), which survives a
// copy that resets mtime.
const STAMP = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/;

export function retentionConfig(env = process.env) {
  const hours = Number(env.SHORTS_KEEP_HOURS);
  const side = Number(env.CLIPS_KEEP_HOURS);
  return {
    keepHours: Number.isFinite(hours) && hours >= 0 ? hours : 6,
    // The folders a short goes to die in, swept on their own clock because
    // nothing is waiting to be posted out of them. 0 keeps them forever.
    sideHours: Number.isFinite(side) && side >= 0 ? side : 24,
  };
}

export const KEPT_PATH = join(config.root, 'data', 'kept.json');

/** When a short was made: from its name, else its file time. */
export function madeAt(name, mtimeMs) {
  const m = STAMP.exec(name);
  if (!m) return mtimeMs;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

export class Retention {
  constructor({
    dir,
    keepHours = retentionConfig().keepHours,
    sideDirs = [],
    sideHours = retentionConfig().sideHours,
    keptPath = KEPT_PATH,
    busy = () => [],
    log = () => {},
    now = Date.now,
  } = {}) {
    this.dir = dir;
    this.keepHours = keepHours;
    this.sideDirs = sideDirs;
    this.sideHours = sideHours;
    this.keptPath = keptPath;
    this.busy = busy;
    this.log = log;
    this.now = now;
    this.kept = new Set();
    this.timer = null;
    this.running = null;
    try {
      if (existsSync(keptPath)) this.kept = new Set(JSON.parse(readFileSync(keptPath, 'utf8')).files || []);
    } catch {
      /* unreadable: treat as nothing kept yet, and say so */
      this.log('retention: data/kept.json is unreadable; deleting nothing until it is fixed');
      this.broken = true;
    }
  }

  get enabled() {
    return this.keepHours > 0;
  }

  /** Either job having work to do is reason enough to run the timer. */
  get sweeping() {
    return this.sideHours > 0 && this.sideDirs.length > 0;
  }

  isKept(name) {
    return this.kept.has(basename(name));
  }

  /** The owner downloaded this short: it stays. */
  keep(name) {
    const file = basename(name);
    if (this.kept.has(file)) return;
    this.kept.add(file);
    const temp = `${this.keptPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ files: [...this.kept].sort() }, null, 2)}\n`);
    renameSync(temp, this.keptPath);
  }

  /** When an un-downloaded short will be deleted, or null if it will not be. */
  expiresAt(name, fallbackMs) {
    const made = madeAt(basename(name), fallbackMs);
    if (!this.enabled || this.isKept(name) || !Number.isFinite(made)) return null;
    return made + this.keepHours * HOUR;
  }

  /** Delete every expired short that was not downloaded. */
  async prune() {
    if (!this.enabled || this.broken) return { deleted: 0, bytes: 0 };
    const cutoff = this.now() - this.keepHours * HOUR;
    const busy = new Set([...this.busy()].map((f) => basename(f)));
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return { deleted: 0, bytes: 0 };
    }
    let deleted = 0;
    let bytes = 0;
    for (const name of names) {
      if (!name.endsWith('.mp4') || this.kept.has(name) || busy.has(name)) continue;
      const path = join(this.dir, name);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile() || madeAt(name, info.mtimeMs) >= cutoff) continue;
      for (const ext of SIDECARS) {
        const part = join(this.dir, name.replace(/\.mp4$/, ext));
        try {
          bytes += (await stat(part)).size;
          await rm(part, { force: true });
        } catch {
          /* already gone */
        }
      }
      deleted++;
    }
    if (deleted) {
      this.log(`retention: deleted ${deleted} short(s) not downloaded within ${this.keepHours}h (${(bytes / 1e9).toFixed(2)} GB)`);
    }
    return { deleted, bytes };
  }

  /**
   * The folders a short goes to die in.
   *
   * prune() looks after clips/ready, where shorts wait to be posted and the
   * owner's downloads have to survive. These are the others. clips/rejected
   * was left alone on purpose, so a failed short could be looked at; left
   * alone turned out to mean kept forever. clips/shelved is worse: nothing in
   * this repo writes it any more, and it was still holding gigabytes from a
   * version that no longer exists.
   *
   * Nothing is exempt here. No upload reads these folders, and a short the
   * owner wanted would have been downloaded out of clips/ready instead.
   */
  async sweep() {
    if (!this.sweeping || this.broken) return { deleted: 0, bytes: 0 };
    const cutoff = this.now() - this.sideHours * HOUR;
    let deleted = 0;
    let bytes = 0;
    for (const dir of this.sideDirs) {
      let names;
      try {
        names = await readdir(dir);
      } catch {
        continue; // not there is the same as empty
      }
      for (const name of names) {
        const path = join(dir, name);
        let info;
        try {
          info = await stat(path);
        } catch {
          continue;
        }
        // The render stamp is only read off a .mp4 name, so a .txt or .json
        // sidecar would fall back to its file time and outlive the video it
        // belongs to. Age every part of a short by the video's name.
        if (!info.isFile() || madeAt(name.replace(/\.[a-z0-9]+$/i, '.mp4'), info.mtimeMs) >= cutoff) continue;
        bytes += info.size;
        try {
          await rm(path, { force: true });
          deleted += 1;
        } catch {
          /* in use or gone: next time */
        }
      }
    }
    if (deleted) {
      this.log(`retention: cleared ${deleted} file(s) over ${this.sideHours}h old from the side folders (${(bytes / 1e9).toFixed(2)} GB)`);
    }
    return { deleted, bytes };
  }

  start(everyMs = 10 * 60_000) {
    if (!this.enabled && !this.sweeping) return;
    const run = () => {
      if (this.running) return;
      this.running = Promise.all([this.prune(), this.sweep()])
        .catch((err) => this.log(`retention: ${err.message}`))
        .finally(() => {
          this.running = null;
        });
    };
    run();
    this.timer = setInterval(run, everyMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

// Is this machine ready to run it?
//
//   npm run doctor
//
// Every fault here is one that otherwise surfaces much later and in disguise.
// A missing ffmpeg is not reported as a missing ffmpeg; it is a clip that keeps
// almost rendering. An unset DASHBOARD_PASSWORD is not reported at all until
// somebody who is not the owner opens the page. Someone standing this up for
// the first time has no way to tell any of that apart from the software simply
// not working, so it is asked and answered up front, in one place.
//
// Nothing here ever prints a secret. A credential is reported as set or
// missing and never by value, so the whole output can be pasted into a support
// thread without a thought.
//
// Everything that decides is a pure function over strings and flags, so each
// rule is tested; `main` is the only part that runs anything or touches disk.

import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { accessSync, constants, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { splitCommand } from './clip.js';
import { config } from './config.js';

const ok = (name, detail) => ({ name, state: 'ok', detail });
const warn = (name, detail, fix) => ({ name, state: 'warn', detail, fix });
const bad = (name, detail, fix) => ({ name, state: 'fail', detail, fix });

/** Node's own `>=22`, checked rather than hoped for. */
export function nodeCheck(version = process.version, least = 22) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(major)) return warn('Node', `could not read the version from "${version}"`);
  if (major < least) {
    return bad('Node', `${version}, and it needs ${least} or newer`, `install Node ${least}+ from nodejs.org and run this again`);
  }
  return ok('Node', version);
}

/**
 * An external command, judged by whether it answered at all. Version strings
 * differ wildly between builds and none of them matter here: what is being
 * asked is "is this program on the PATH and does it start".
 */
export function toolCheck(name, { ran, firstLine, error }, fix) {
  if (ran) return ok(name, firstLine || 'answered');
  return bad(name, error || 'did not run', fix);
}

/**
 * The dashboard's password.
 *
 * With none set, `authorized()` lets everybody through — deliberately, because
 * on localhost the address was the privacy. The moment the port is reachable
 * from anywhere else that stops being true, and the page can change the
 * channel list, flip the upload switches and spend the account's quota. Only
 * the owner knows whether this port is exposed, so this is put as the question
 * they can answer rather than as a verdict they did not ask for.
 */
export function passwordCheck(password) {
  if (password) return ok('Dashboard password', 'set, so the page asks for it');
  return warn(
    'Dashboard password',
    'not set, so anyone who can reach this port can drive the dashboard',
    'fine if nothing but this computer can reach it. If it is behind a tunnel, a forwarded port or a VPN that others are on, set DASHBOARD_PASSWORD in .env and restart',
  );
}

/** Twitch is the one credential nothing else substitutes for. */
export function twitchCheck(env = process.env) {
  const id = (env.TWITCH_CLIENT_ID || '').trim();
  const secret = (env.TWITCH_CLIENT_SECRET || '').trim();
  if (id && secret) return ok('Twitch app', 'client id and secret are set');
  const missing = [!id && 'TWITCH_CLIENT_ID', !secret && 'TWITCH_CLIENT_SECRET'].filter(Boolean);
  return bad(
    'Twitch app',
    `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing`,
    'register an app at dev.twitch.tv/console/apps and put both in .env — chat-only detection runs without them, nothing else does',
  );
}

const PLATFORMS = [
  ['YouTube', ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'], 'console.cloud.google.com — enable the YouTube Data API v3, then make an OAuth client'],
  ['TikTok', ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], 'developers.tiktok.com — a new app posts privately until TikTok audits it'],
  ['Instagram', ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'], 'developers.facebook.com — needs a professional account linked to a Page'],
];

/**
 * Somewhere to post to. None of the three is required — it is a usable feed
 * with no account connected at all — so this is never a failure, but a copy
 * with nowhere to post is worth saying out loud rather than leaving to be
 * discovered.
 */
export function platformChecks(env = process.env) {
  const rows = PLATFORMS.map(([label, keys, where]) => {
    const set = keys.filter((key) => (env[key] || '').trim());
    if (set.length === keys.length) return ok(label, 'keys are set — press Connect on the dashboard to sign in');
    if (!set.length) return warn(label, 'no keys', where);
    return bad(label, `${keys.find((key) => !(env[key] || '').trim())} is missing, the other is set`, where);
  });
  const anyReady = rows.some((row) => row.state === 'ok');
  if (!anyReady) {
    rows.push(
      warn(
        'Somewhere to post',
        'no platform is configured, so it will find moments and cut shorts but post nothing',
        'set up at least one of the three above, or leave it — the feed and the clips work regardless',
      ),
    );
  }
  return rows;
}

/** Writable, and said as the thing that breaks rather than as a permission. */
export function pathCheck(name, path, { exists, writable }) {
  if (!exists) return warn(name, `${path} does not exist yet`, 'it is created on the first run; nothing to do unless this keeps saying so');
  if (!writable) return bad(name, `${path} cannot be written to`, 'fix the folder permissions, or point the setting somewhere you own');
  return ok(name, path);
}

/** A taken port is almost always a copy already running, not a conflict. */
export function portCheck(port, free) {
  if (free) return ok('Port', `${port} is free`);
  return warn('Port', `${port} is already taken`, 'usually this means a copy is already running — open http://localhost:' + port + ' and see');
}

/** What the exit code should be, and what to print under the rows. */
export function summary(rows) {
  const count = (state) => rows.filter((row) => row.state === state).length;
  const failed = count('fail');
  const warned = count('warn');
  return {
    failed,
    warned,
    exitCode: failed ? 1 : 0,
    line: failed
      ? `${failed} thing${failed > 1 ? 's' : ''} ${failed > 1 ? 'have' : 'has'} to be fixed before this will run properly.`
      : warned
        ? `Nothing is broken. ${warned} thing${warned > 1 ? 's' : ''} worth a look above.`
        : 'Ready.',
  };
}

const MARK = { ok: '  ok  ', warn: ' note ', fail: ' FAIL ' };

export function render(rows, { width = 22 } = {}) {
  const lines = [];
  for (const row of rows) {
    lines.push(`${MARK[row.state]}${row.name.padEnd(width)}${row.detail}`);
    if (row.fix) lines.push(`${' '.repeat(6)}${' '.repeat(width)}-> ${row.fix}`);
  }
  return lines.join('\n');
}

// ---- the part that runs things ---------------------------------------------

/** Did this command start and say anything? Its version text is incidental. */
function probe(command, args) {
  return new Promise((done) => {
    let file = command;
    let prefix = [];
    try {
      ({ file, prefix } = splitCommand(command));
    } catch {
      done({ ran: false, error: 'no command configured' });
      return;
    }
    execFile(file, [...prefix, ...args], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      // ffmpeg's first line is its version followed by a copyright notice and
      // a build string; the version is the part being asked about.
      const firstLine = String(stdout || stderr)
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.split(/\s+Copyright/)[0];
      // Plenty of these answer `--version` on stderr, and some exit non-zero
      // while doing it. Having said anything at all is the signal.
      if (firstLine) done({ ran: true, firstLine: firstLine.trim().slice(0, 60) });
      else done({ ran: false, error: err?.code === 'ENOENT' ? 'not on PATH' : err?.message || 'said nothing' });
    });
  });
}

const canWrite = (path) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Asked by connecting rather than by binding.
 *
 * Binding was wrong and quietly so: the server listens on IPv6 localhost, a
 * bind to 127.0.0.1 succeeded beside it, and the check reported the port free
 * while the thing was running on it. Both families are tried because which one
 * a copy ends up on is not ours to predict.
 */
const reachable = (port, host) =>
  new Promise((done) => {
    const socket = connect({ port, host });
    const settle = (answer) => {
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

const portFree = async (port) => !(await reachable(port, '127.0.0.1')) && !(await reachable(port, '::1'));

export async function main() {
  const rows = [];

  rows.push(nodeCheck());
  rows.push(toolCheck('ffmpeg', await probe('ffmpeg', ['-version']), 'install ffmpeg and put it on PATH — every clip is cut with it'));
  rows.push(toolCheck('ffprobe', await probe('ffprobe', ['-version']), 'it ships with ffmpeg; if one is missing the install is partial'));
  rows.push(
    toolCheck('yt-dlp', await probe(config.ytdlpCmd, ['--version']), `"${config.ytdlpCmd}" is what it tried — install yt-dlp, or point YTDLP_CMD at it`),
  );

  const envPath = resolve(config.root, '.env');
  rows.push(
    existsSync(envPath)
      ? ok('.env', envPath)
      : warn('.env', 'not there', 'copy .env.example to .env and fill it in — settings from the real environment still win'),
  );

  rows.push(twitchCheck());
  rows.push(passwordCheck(config.dashboardPassword));
  rows.push(...platformChecks());

  const dataDir = resolve(config.root, 'data');
  rows.push(pathCheck('Data folder', dataDir, { exists: existsSync(dataDir), writable: canWrite(dataDir) }));
  rows.push(pathCheck('Clips folder', config.clipDir, { exists: existsSync(config.clipDir), writable: canWrite(config.clipDir) }));
  rows.push(portCheck(config.port, await portFree(config.port)));

  const result = summary(rows);
  console.log(`\n${render(rows)}\n\n${result.line}\n`);
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('doctor.js')) {
  process.exitCode = await main();
}

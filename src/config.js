import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env reader. Real environment variables always win, so the same file can
// sit next to a deployment that sets them properly.
function loadEnvFile() {
  let raw;
  try {
    raw = readFileSync(resolve(root, '.env'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Comma- or space-separated channel logins. An explicitly empty value means
// "watch nothing", which is different from "unset", so the fallback only
// applies when the variable is absent altogether.
const logins = (value, fallback) => {
  if (value === undefined) return fallback;
  return [
    ...new Set(
      String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
};

/**
 * Who to listen to when there are no credentials.
 *
 * Helix is the only way to ask "who is live in this category", so without it
 * the watch list has to be named. This is a starting point, not a claim about
 * who will actually play: override it with WATCH_CHANNELS and the whole
 * chat-only path follows.
 */
const DEFAULT_WATCH = [
  'xqc',
  'kaicenat',
  'caseoh_',
  'jynxzi',
  'summit1g',
  'shroud',
  'lirik',
  'sodapoppin',
  'timthetatman',
  'nickmercs',
  'tarik',
  'hasanabi',
];

// Twitch category names, spelled exactly as Twitch spells them: the same
// strings are matched against VOD chapter titles to tell, without
// credentials, which game a moment came from.
const DEFAULT_GAMES = ['Grand Theft Auto VI', 'Fortnite'];

function games() {
  const list = (value) =>
    String(value)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  if (process.env.GAMES !== undefined) return list(process.env.GAMES);
  // GAME_NAME is the older one-game setting. Every .env copied from the old
  // example says "Grand Theft Auto VI" — a default, not a choice — so only a
  // different name narrows the list.
  const single = (process.env.GAME_NAME || '').trim();
  if (single && single !== 'Grand Theft Auto VI') return [single];
  return DEFAULT_GAMES;
}

// Post-copy tags by game, keyed lowercase. SHORTS_HASHTAGS, when set,
// replaces these for every game.
/**
 * Each game's own tags, and how a title names it. Only a game the clip was
 * actually recorded in gets its tags: a game that cannot be read gets none,
 * never a default.
 */
export const GAME_TAGS = {
  'grand theft auto vi': { tags: ['#gta6', '#gtavi'], youtube: '#GTA6', short: 'GTA 6' },
  fortnite: { tags: ['#fortnite', '#fortniteclips'], youtube: '#Fortnite', short: 'Fortnite' },
  'escape from tarkov': { tags: ['#tarkov', '#escapefromtarkov'], youtube: '#Tarkov', short: 'Tarkov' },
};

export const GAME_HASHTAGS = {
  'grand theft auto vi': '#gta6 #gtavi #gaming #twitch',
  fortnite: '#fortnite #fortniteclips #gaming #twitch',
  'escape from tarkov': '#tarkov #escapefromtarkov #gaming #twitch',
};

export const config = {
  root,
  port: num(process.env.PORT, 3000),
  // Which addresses to answer on. Node's default is every interface, which
  // put an unauthenticated control panel for somebody's YouTube and TikTok
  // accounts in front of everyone on their home network - a laptop, a phone,
  // a guest, anything on the same Wi-Fi. The address was never the privacy it
  // was taken for. Localhost unless the owner says otherwise, and saying
  // otherwise requires a password (see server.js).
  host: process.env.HOST?.trim() || '127.0.0.1',
  // Empty means the dashboard is open, which is right on localhost and
  // wrong the moment it is reachable from anywhere else. See gate.js.
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  clientId: process.env.TWITCH_CLIENT_ID || '',
  clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
  // Every category the feed watches and automation clips.
  games: games(),
  // The first of them, for the places that still speak of one game.
  gameName: games()[0] || 'Grand Theft Auto VI',
  // Pins ONE category by id and overrides GAMES — kept for older setups.
  gameId: process.env.GAME_ID || '',
  clipWindowMinutes: num(process.env.CLIP_WINDOW_MINUTES, 25),
  clipPollSeconds: num(process.env.CLIP_POLL_SECONDS, 30),
  clipMaxPages: num(process.env.CLIP_MAX_PAGES, 30),
  streamPollSeconds: num(process.env.STREAM_POLL_SECONDS, 120),
  clusterGapSeconds: num(process.env.CLUSTER_GAP_SECONDS, 30),
  leadInSeconds: num(process.env.LEAD_IN_SECONDS, 20),
  chatChannels: num(process.env.CHAT_CHANNELS, 80),
  chatEnabled: process.env.CHAT_ENABLED !== 'false',
  // Spike thresholds. See the comment on FLOOR_MESSAGES in chat.js for why the
  // floor is low: a high one can only ever admit channels whose moments are
  // already flooded.
  chatFloorMessages: num(process.env.CHAT_FLOOR_MESSAGES, 8),
  chatMinRise: num(process.env.CHAT_MIN_RISE, 1.5),
  chatSpikeZ: num(process.env.CHAT_SPIKE_Z, 3),
  // Chat-only mode. Chat needs no token, so detection can run with an empty
  // .env — but only against channels named here. Polled faster than the clip
  // loop because a bucket closes every ten seconds and being first is the
  // entire point of this path.
  watchChannels: logins(process.env.WATCH_CHANNELS, DEFAULT_WATCH),
  chatPollSeconds: num(process.env.CHAT_POLL_SECONDS, 10),

  // Audio probe. Each probe is a yt-dlp and an ffmpeg, so it is capped per
  // poll and every moment is probed at most once. The window leans backwards
  // because chat is late: the event is usually behind the nominated offset,
  // not ahead of it.
  audioProbe: process.env.AUDIO_PROBE !== 'false',
  audioProbePerPoll: num(process.env.AUDIO_PROBE_PER_POLL, 3),
  audioProbeBefore: num(process.env.AUDIO_PROBE_BEFORE, 45),
  audioProbeAfter: num(process.env.AUDIO_PROBE_AFTER, 25),

  // Persistence. The point is not durability, it's having a label to score
  // the ranking against later — see store.js and eval.js.
  storeEnabled: process.env.STORE_ENABLED !== 'false',
  storePath: resolve(root, process.env.STORE_PATH || 'data/feed.db'),
  outcomePollSeconds: num(process.env.OUTCOME_POLL_SECONDS, 60),
  outcomeBatch: num(process.env.OUTCOME_BATCH, 20),
  // Only observations are pruned — see pruneOlderThan in store.js for why the
  // moments/clips/outcomes history is kept regardless.
  storePruneDays: num(process.env.STORE_PRUNE_DAYS, 14),

  // Live recording, for channels with no VOD to cut from (see live.js).
  // Each recording is a 720p stream, about 3-5 Mbit/s down, with a rolling
  // buffer of RECORD_KEEP_SECONDS on disk (roughly 300 MB at 10 minutes).
  recording: process.env.RECORDING !== 'off',
  recordMax: num(process.env.RECORD_MAX, 4),
  recordKeepSeconds: num(process.env.RECORD_KEEP_SECONDS, 600),
  recordQuality: num(process.env.RECORD_QUALITY, 720),

  // Local clip extraction. The window is lopsided on purpose: see clip.js.
  clipPre: num(process.env.CLIP_PRE, 25),
  clipPost: num(process.env.CLIP_POST, 5),
  clipDir: resolve(root, process.env.CLIP_DIR || 'clips'),
  clipQuality: process.env.CLIP_QUALITY || '1080',
  clipConcurrency: num(process.env.CLIP_CONCURRENCY, 2),
  // The console scripts shim is broken on some Windows installs, so the
  // module form is the default and the whole command stays configurable.
  ytdlpCmd: process.env.YTDLP_CMD || 'python -m yt_dlp',
};

export const credentialsMissing = !config.clientId || !config.clientSecret;

// Chat-only detection is possible whenever there is somebody to listen to.
// Without credentials AND without a watch list there is nothing to run at all.
export const chatOnlyPossible = config.chatEnabled && config.watchChannels.length > 0;
export const nothingToRun = credentialsMissing && !chatOnlyPossible;

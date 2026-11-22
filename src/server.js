import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { clipWindow, normalizeVodId } from './clip.js';
import { clipQueueStatus, enqueueClip, getClipJob, publicJob } from './clipjobs.js';
import { config, credentialsMissing, nothingToRun, root } from './config.js';
import { Automation, SHORT_FILE, parseRange } from './automation.js';
import { Feed } from './feed.js';
import { authorized, isPublicPath } from './gate.js';
import { acquireLock, lockMessage } from './lock.js';
import { PLATFORMS, Uploader } from './uploader.js';
import * as instagram from './instagram.js';
import * as tiktok from './tiktok.js';
import { StatsCache, statsErrorKind } from './ytstats.js';
import * as youtube from './youtube.js';

// Each platform's sign-in, so one pair of auth routes serves all of them.
// `finish` turns the code from the callback into whatever that platform wants
// kept on disk: for YouTube and TikTok one exchange, for Instagram three calls
// (code -> short-lived -> 60-day token -> the Page's Instagram account).
const SIGN_IN = {
  youtube: {
    api: youtube,
    keys: () => youtube.youtubeKeys(),
    envHint: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET',
    finish: (keys, code) => youtube.exchangeCode(keys, code),
  },
  tiktok: {
    api: tiktok,
    keys: () => tiktok.tiktokKeys(),
    envHint: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET',
    finish: (keys, code) => tiktok.exchangeCode(keys, code),
  },
  instagram: {
    api: instagram,
    keys: () => instagram.instagramKeys(),
    envHint: 'INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET',
    finish: (keys, code) => instagram.connect(keys, code),
  },
};

// Enough for the biggest plausible clip request and nothing like enough to be
// worth sending as a denial-of-service payload.
const MAX_BODY_BYTES = 4096;

const PUBLIC_DIR = join(root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

// TERMS.md and PRIVACY.md are the promises; these routes serve those same two
// files rather than a copy of them, so a page and the repo cannot drift apart.
const DOCS = {
  '/terms': { file: 'TERMS.md', title: 'Terms' },
  '/privacy': { file: 'PRIVACY.md', title: 'Privacy' },
};

const escapeHtml = (text) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// The text exactly as written, wrapped but never reformatted. A hand-rolled
// Markdown parser is the last thing that should stand between a reader and a
// promise, so this renders none of it.
async function sendDoc(res, { file, title }) {
  let text;
  try {
    text = await readFile(join(root, file), 'utf8');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="data:," />
    <style>
      :root { color-scheme: dark light; }
      body {
        margin: 0;
        background: #0f1115;
        color: #e7e9ee;
        font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      main { max-width: 82ch; margin: 0 auto; padding: 28px 16px 64px; }
      a { color: #7aa2f7; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 18px 0 0; }
      @media (prefers-color-scheme: light) {
        body { background: #fff; color: #1a1a1a; }
        a { color: #0b5fff; }
      }
    </style>
  </head>
  <body>
    <main>
      <a href="/">&larr; Clipping</a>
      <pre>${escapeHtml(text)}</pre>
    </main>
  </body>
</html>
`);
}

// One copy at a time: see lock.js for what happened when there were three.
const LOCK_PATH = join(root, 'data', 'app.lock');
const lock = acquireLock(LOCK_PATH, { name: 'npm start' });
if (!lock.ok) {
  console.error(`\n  ${lockMessage(lock.holder, LOCK_PATH)}\n`);
  process.exit(1);
}
process.on('exit', () => lock.release());

const feed = new Feed();
const automation = new Automation({ feed, log: (message) => feed.log(message) });
const uploader = new Uploader({ store: feed.store, dir: automation.dir, log: (message) => feed.log(message) });
// Read-only channel stats, shared by every open page so they cannot multiply
// the quota cost between them.
const statsCache = new StatsCache();

// Sign-in round trips in flight: the state the platform hands back must be one
// this server sent, for that same platform, or the callback is someone else's
// and is refused.
const signIns = new Map();

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function sendStatic(res, urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  // normalize then confirm the result is still inside PUBLIC_DIR
  const target = join(PUBLIC_DIR, normalize(requested));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(500).end('server error');
  }
}

/**
 * A finished short, for the automation panel. Only names clipBasename makes
 * are served, and only from the shorts folder. Ranges are honoured because a
 * <video> element cannot seek without them.
 */
async function sendShort(req, res, name, download) {
  if (!SHORT_FILE.test(name)) {
    res.writeHead(404).end('not found');
    return;
  }
  const path = join(automation.dir, name);
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'text/plain; charset=utf-8',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  if (download) {
    headers['content-disposition'] = `attachment; filename="${name}"`;
    // Downloaded means wanted: this short is never deleted by retention.
    try {
      automation.retention?.keep(name);
    } catch (err) {
      feed.log(`retention: could not record the download of ${name}: ${err.message}`);
    }
  }

  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    });
    createReadStream(path, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);

  // Before anything else. The page can change the streamer list, flip the
  // upload switches and spend the uploader’s quota, so once the address is
  // reachable the address alone cannot be what protects it.
  if (!isPublicPath(url.pathname) && !authorized(req.headers.authorization, config.dashboardPassword)) {
    res
      .writeHead(401, {
        'www-authenticate': 'Basic realm="clip dashboard", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
      })
      .end('Set DASHBOARD_PASSWORD in .env and sign in with it. Any username.\n');
    return;
  }

  if (url.pathname === '/api/feed') {
    // ?demo=1 renders the UI off a fixture, so the layout can be checked while
    // the category is still empty.
    if (url.searchParams.has('demo')) {
      const { demoSnapshot } = await import('./demo.js');
      sendJson(res, 200, demoSnapshot());
      return;
    }
    // Credentials buy clips and saturation. Chat alone still finds moments, so
    // the feed is only unavailable when there is neither a token nor anybody
    // on the watch list to listen to.
    if (nothingToRun) {
      sendJson(res, 503, {
        error: 'nothing_to_watch',
        message:
          'Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env for the full feed, or set WATCH_CHANNELS to run chat-only. Then restart.',
      });
      return;
    }
    sendJson(res, 200, feed.snapshot());
    return;
  }

  // POST /api/clip  {vodId, offsetSeconds, pre, post, vertical}  ->  {id}
  //
  // The work is a subprocess that outlives any sane request timeout, so this
  // only validates and queues. GET /api/clip/:id reports the rest.
  if (url.pathname === '/api/clip' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err.message });
      return;
    }

    // Validate here, not in the worker: a bad vodId should come back as a 400
    // the card can show, not as a failed job the operator has to go read.
    let vodId;
    let window;
    try {
      vodId = normalizeVodId(body.vodId);
      window = clipWindow({
        offsetSeconds: body.offsetSeconds,
        pre: body.pre,
        post: body.post,
      });
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err.message });
      return;
    }

    const job = enqueueClip({
      vodId,
      offsetSeconds: window.offset,
      pre: window.pre,
      post: window.post,
      vertical: Boolean(body.vertical),
      broadcaster: typeof body.broadcaster === 'string' ? body.broadcaster : '',
      momentId: typeof body.momentId === 'string' ? body.momentId : null,
    });

    sendJson(res, 202, { job: publicJob(job), queue: clipQueueStatus(), window });
    return;
  }

  if (url.pathname.startsWith('/api/clip/')) {
    const job = getClipJob(decodeURIComponent(url.pathname.slice('/api/clip/'.length)));
    if (!job) {
      sendJson(res, 404, { error: 'unknown_job', message: 'no such clip job' });
      return;
    }
    sendJson(res, 200, { job: publicJob(job), queue: clipQueueStatus() });
    return;
  }

  if (url.pathname === '/api/clip') {
    sendJson(res, 405, { error: 'method_not_allowed', message: 'POST a clip request here' });
    return;
  }

  // GET  /api/automation                     -> channels, switch, finished shorts
  // POST /api/automation {enabled|add|remove}  -> the same, after the change
  if (url.pathname === '/api/automation') {
    if (req.method === 'POST') {
      try {
        automation.update(await readJsonBody(req));
      } catch (err) {
        sendJson(res, 400, { error: 'bad_request', message: err.message });
        return;
      }
    } else if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'GET or POST' });
      return;
    }
    sendJson(res, 200, await automation.view());
    return;
  }

  // GET  /api/uploads                          -> each platform's upload state
  // POST /api/uploads {platform, mode}          -> off | dry-run | on
  // POST /api/uploads {platform, disconnect}    -> forget the sign-in
  if (url.pathname === '/api/uploads') {
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const platform = body.platform;
        if (!PLATFORMS.includes(platform)) throw new Error(`${platform} upload is not built yet`);
        if (body.disconnect) {
          // Off before the token goes, so a tick in between cannot find a
          // mode of "on" with nothing to sign in with.
          await uploader.setMode(platform, 'off');
          await SIGN_IN[platform].api.forgetToken();
          uploader.state[platform].connected = false;
        } else {
          await uploader.setMode(platform, body.mode);
        }
      } catch (err) {
        sendJson(res, 400, { error: 'bad_request', message: err.message });
        return;
      }
    }
    sendJson(res, 200, await uploader.view());
    return;
  }

  // GET /api/stats -> what the connected accounts actually did.
  //
  // Every platform answers here, because each account page asks this one route
  // and reads its own platform out of the reply. While only YouTube answered,
  // the TikTok page read a missing entry as "no keys in .env" and said so to a
  // owner whose keys were fine.
  //
  // Read-only, and behind StatsCache's refresh floor so a page left open does
  // not spend the uploader's quota. ?force=1 is for a person pressing refresh,
  // not for the page's own polling.
  if (url.pathname === '/api/stats') {
    const state = {};
    for (const [platform, { api, keys: readKeys }] of Object.entries(SIGN_IN)) {
      const keys = readKeys();
      if (!api.hasKeys(keys)) {
        state[platform] = { keys: false, connected: false };
        continue;
      }
      // YouTube and TikTok keep a refresh token; Instagram keeps a 60-day
      // user token. Either one means the owner has been through the consent.
      const saved = await api.loadToken();
      state[platform] = {
        keys: true,
        connected: Boolean(saved?.refreshToken || saved?.userToken),
      };
    }

    // TikTok's name comes off the kept token, not off the network: it was
    // read once when the owner signed in. A stats poll every few seconds must
    // not spend a TikTok call to re-read a name that cannot change under it.
    if (state.tiktok.connected) {
      const saved = await tiktok.loadToken();
      if (saved?.account) state.tiktok.channel = saved.account;
    }

    if (state.youtube.connected) {
      const keys = youtube.youtubeKeys();
      const saved = await youtube.loadToken();
      try {
        const token = await youtube.accessToken(keys, saved.refreshToken);
        Object.assign(state.youtube, await statsCache.get({ token, force: url.searchParams.has('force') }));
      } catch (err) {
        // Only a real auth failure means the sign-in is gone. A 5xx, a 429 or a
        // dropped connection is the network, and offering Connect for those
        // would send the owner to re-consent over a blip.
        const kind = statsErrorKind(err);
        state.youtube.connected = kind !== 'auth';
        state.youtube.error = { kind, message: err.message };
      }
    }

    sendJson(res, 200, state);
    return;
  }

  // GET /auth/<platform> -> that platform's own consent page;
  // GET /auth/<platform>/callback <- back again.
  const auth = /^\/auth\/([a-z]+)(\/callback)?$/.exec(url.pathname);
  if (auth && SIGN_IN[auth[1]]) {
    const platform = auth[1];
    const { api, keys: readKeys, envHint, finish } = SIGN_IN[platform];
    const keys = readKeys();

    if (!auth[2]) {
      if (!api.hasKeys(keys)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Add ${envHint} to .env, then restart.`);
        return;
      }
      const state = randomBytes(16).toString('hex');
      // The platform is remembered with the state, so a state issued for one
      // platform cannot be handed back on the other's callback.
      signIns.set(state, { platform, at: Date.now() });
      redirect(res, api.authUrl(keys, state));
      return;
    }

    const state = url.searchParams.get('state') || '';
    const started = signIns.get(state);
    signIns.delete(state);
    if (!started || started.platform !== platform || Date.now() - started.at > 10 * 60_000) {
      redirect(res, `/?${platform}=expired#uploads`);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      redirect(res, `/?${platform}=${encodeURIComponent(url.searchParams.get('error') || 'cancelled')}#uploads`);
      return;
    }
    try {
      await api.saveToken(await finish(keys, code));
      uploader.connected(platform);
      feed.log(`upload: ${platform} connected`);
      redirect(res, `/?${platform}=connected#uploads`);
    } catch (err) {
      feed.log(`upload: connecting ${platform} failed: ${err.message}`);
      redirect(res, `/?${platform}=${encodeURIComponent(err.message.slice(0, 120))}#uploads`);
    }
    return;
  }

  // POST /api/shorts/<file>/reveal  -> opens the folder with the short selected
  const reveal = /^\/api\/shorts\/([^/]+)\/reveal$/.exec(url.pathname);
  if (reveal && req.method === 'POST') {
    try {
      automation.reveal(decodeURIComponent(reveal[1]));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 404, { error: 'not_found', message: err.message });
    }
    return;
  }

  if (url.pathname.startsWith('/shorts/')) {
    let name = '';
    try {
      name = decodeURIComponent(url.pathname.slice('/shorts/'.length));
    } catch {
      /* malformed escape: falls through to 404 */
    }
    await sendShort(req, res, name, url.searchParams.has('download'));
    return;
  }

  if (url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: !nothingToRun,
      // Chat-only is a working mode, not a broken one. It finds moments and
      // cannot measure saturation; the caller deserves to know which.
      mode: credentialsMissing ? 'chat-only' : 'full',
      credentials: credentialsMissing ? 'missing' : 'present',
      watchedChannels: feed.channels.size,
      game: feed.game ? { id: feed.game.id, name: feed.game.name } : null,
      started: feed.started,
      lastError: feed.lastError,
      clips: { ...clipQueueStatus(), dir: config.clipDir },
    });
    return;
  }

  const doc = DOCS[url.pathname];
  if (doc) {
    await sendDoc(res, doc);
    return;
  }

  await sendStatic(res, url.pathname);
});

server.listen(config.port, async () => {
  console.log(`\n  saturation feed  ->  http://localhost:${config.port}\n`);

  if (nothingToRun) {
    console.log('  Nothing to watch.');
    console.log('  Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env for the full');
    console.log('  feed (register an app at https://dev.twitch.tv/console/apps), or set');
    console.log('  WATCH_CHANNELS=name,name to run chat-only.');
    console.log('');
    return;
  }

  if (credentialsMissing) {
    console.log(`  No credentials - chat-only on ${automation.settings.channels.length || config.watchChannels.length} channels.`);
    console.log('  Finding moments before anybody clips them is the half that works');
    console.log('  without a token. Saturation is the half that does not.');
    console.log('');
  }

  // Before the feed starts: in chat-only mode the automation's channels are
  // the watch list, and what was already cut has to be known before a poll.
  automation.prepare();
  try {
    await feed.start();
  } catch (err) {
    console.error(`  Could not start the feed: ${err.message}`);
    if (err.body) console.error(`  ${err.body}`);
  }
  automation.start();
  await uploader.load();
  // A sign-in made before this code existed has no name kept with it. Fill it
  // in once, here, rather than on a request: this runs before the uploader is
  // started, so the refresh it needs cannot race an upload's own refresh and
  // strand the rotated token.
  await nameTikTok();
  uploader.start();
  console.log(
    `  Auto upload: ${PLATFORMS.map((p) => `${p} is ${uploader.settings[p].mode}`).join(', ')}` +
      ` (TikTok uploads arrive as a draft to post from the app).`,
  );
  console.log(
    `  Automation is ${automation.settings.enabled ? 'ON' : 'off'} for ` +
      `${automation.settings.channels.length} channel(s) - switch it in the page.`,
  );
});

/**
 * Put a name on an older TikTok sign-in, once per run.
 *
 * Nothing depends on it, so every failure is a log line and no more: being
 * unable to say whose account it is must never stop the thing posting to it.
 */
async function nameTikTok() {
  const keys = tiktok.tiktokKeys();
  if (!tiktok.hasKeys(keys)) return;
  const saved = await tiktok.loadToken();
  if (!saved?.refreshToken || saved.account) return;
  try {
    const token = await tiktok.accessTokenFor(keys);
    const account = tiktok.profileAccount(await tiktok.fetchProfile(token));
    await tiktok.saveToken({ ...(await tiktok.loadToken()), account });
    console.log(`  TikTok is connected as ${account.displayName || '(no display name)'}.`);
  } catch (err) {
    console.log(`  TikTok did not say whose account this is: ${err.message}`);
  }
}

const shutdown = () => {
  uploader.stop();
  automation.stop();
  feed.stop();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

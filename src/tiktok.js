// TikTok: sign-in and upload, through the account owner's own TikTok app.
//
// This posts to the owner's TikTok **inbox**, not straight to their profile.
// That is not a shortcut — it is the only honest option with the scopes this
// app has. TikTok offers two posting endpoints:
//
//   inbox upload   scope video.upload   no audit. The video arrives as a
//                  draft notification; the creator opens it, writes the
//                  caption and posts it themselves.
//   direct post    scope video.publish  posts for real, but the app must be
//                  approved for video.publish AND pass TikTok's audit. Until
//                  then TikTok restricts everything an unaudited client posts
//                  to private viewing, and refuses with
//                  `unaudited_client_can_only_post_to_private_accounts`.
//
// So "automatic TikTok posting" means: the clip is chosen, rendered, checked
// and delivered automatically, and the owner taps post. One tap per clip, not
// a download, a transfer and a caption. Nothing here tries to get around the
// audit, and nothing pretends to be a person.
//
// Because the inbox endpoint takes no caption field, the caption this tool
// would have written is logged and stored beside the upload, so the owner has
// the credit line and the stream link to paste. TERMS.md promises both with
// every clip; the video itself also carries the credit burnt in.
//
// Two differences from the YouTube module are worth knowing about:
//   * TikTok rotates the refresh token on every refresh. The old one stops
//     working, so a refresh that is not saved disconnects the account. That is
//     why the refresh path here writes the token back itself.
//   * The cap is a rolling 24 hours ("at most 5 pending shares within any
//     24-hour period"), not a calendar day.
//
// Plain fetch, no SDK. Keys are the owner's (TIKTOK_CLIENT_KEY / _SECRET in
// .env); the token lives in data/tiktok-token.json, git-ignored with the rest
// of data/, and never leaves this PC.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { config } from './config.js';

// Comma separated, which is what TikTok's authorize endpoint wants — not the
// space separated list Google uses.
export const SCOPE = ['user.info.basic', 'user.info.stats', 'video.list', 'video.upload'].join(',');

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INBOX_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const USER_URL = 'https://open.tiktokapis.com/v2/user/info/';

// TikTok's documented chunk rules. A chunk is at least 5 MiB and at most
// 64 MiB, except the last, which may run to 128 MiB to absorb the remainder.
const MIB = 1024 * 1024;
export const MIN_CHUNK = 5 * MIB;
export const MAX_CHUNK = 64 * MIB;

// At most 5 pending shares in any 24-hour period, per TikTok's inbox docs.
export const PENDING_CAP = 5;
export const CAP_WINDOW_MS = 24 * 3600_000;

export const tiktokKeys = (env = process.env) => ({
  clientKey: env.TIKTOK_CLIENT_KEY?.trim() || '',
  clientSecret: env.TIKTOK_CLIENT_SECRET?.trim() || '',
  redirectUri: env.TIKTOK_REDIRECT_URI?.trim() || `http://localhost:${config.port}/auth/tiktok/callback`,
});

export const hasKeys = (keys) => Boolean(keys.clientKey && keys.clientSecret);

/**
 * Why something failed, as what to do about it. Same vocabulary as the
 * YouTube module, so the uploader can treat both the same way:
 *   quota     — the 24-hour allowance is used up; stop until it ages out
 *   auth      — the sign-in is gone; stop until the owner connects again
 *   blocked   — TikTok is refusing this account, not this video; stop and say
 *               so, rather than striking off every short in turn
 *   refused   — TikTok will not take this video; skip it, never retry it
 *   transient — the network or TikTok's side; try again later
 *   uncertain — it may or may not have landed; do not retry blind
 */
export class TikTokError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'TikTokError';
    this.kind = kind;
  }
}

/**
 * Map a posting-API failure onto one of those kinds. TikTok puts its own code
 * in error.code and uses HTTP status as well, so both are consulted.
 */
export function classify(status, body) {
  const code = String(body?.error?.code || body?.error || '');
  if (/access_token_invalid|scope_not_authorized|auth_removed/.test(code)) return 'auth';
  if (/spam_risk_user_banned_from_posting/.test(code)) return 'blocked';
  if (/spam_risk_too_many_pending_share|spam_risk_too_many_posts|reached_active_user_cap/.test(code)) return 'quota';
  if (/rate_limit_exceeded/.test(code)) return 'transient';
  if (/invalid_param|invalid_publish_id|token_not_authorized_for_specified_publish_id/.test(code)) return 'refused';
  if (status === 401) return 'auth';
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  // A 403 with no code we know is about the account, not this video.
  if (status === 403) return 'blocked';
  return 'refused';
}

/** The sign-in endpoint speaks OAuth's error vocabulary, not the posting API's. */
export function classifyAuth(body) {
  const error = String(body?.error || '');
  // invalid_grant covers a refresh token that is expired, revoked or was
  // issued to another client: all of them mean "connect again".
  if (/invalid_grant|access_denied|invalid_scope|unauthorized_client/.test(error)) return 'auth';
  if (/invalid_client/.test(error)) return 'auth';
  if (/server_error|temporarily_unavailable/.test(error)) return 'transient';
  if (/invalid_request|unsupported_grant_type|unsupported_response_type/.test(error)) return 'refused';
  return 'transient';
}

async function bodyOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function failure(res, what) {
  const body = await bodyOf(res);
  const detail = body?.error?.message || body?.error_description || body?.error?.code || body?.error || res.statusText;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return new TikTokError(`${what}: ${res.status} ${text}`, classify(res.status, body));
}

// --- signing in ---------------------------------------------------------------

/** Where the Connect button sends the owner: TikTok's own consent page. */
export function authUrl(keys, state) {
  const params = new URLSearchParams({
    client_key: keys.clientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: keys.redirectUri,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TikTokError(`sign-in: ${err.message}`, 'transient');
  }
  const body = await bodyOf(res);
  // TikTok can answer 200 with an error in the body, so the body is checked
  // either way rather than trusting the status alone.
  if (!res.ok || body?.error) {
    const detail = body?.error_description || body?.error || res.statusText;
    throw new TikTokError(`sign-in: ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, classifyAuth(body));
  }
  if (!body?.access_token) throw new TikTokError('sign-in: TikTok returned no access token', 'transient');
  return body;
}

const seconds = (value, now) => (value != null && Number.isFinite(Number(value)) ? now + Number(value) * 1000 : undefined);

/**
 * The fields of a token response worth keeping.
 *
 * A field TikTok did not send is left out rather than written as null,
 * because a refresh response is merged over the stored token: a null here
 * would quietly erase an open id or a scope list that is still correct.
 */
const tokenRecord = (body, now) => {
  const record = { refreshToken: body.refresh_token };
  if (body.open_id) record.openId = body.open_id;
  if (body.scope) record.scope = body.scope;
  // Remaining seconds, per the docs — so they are turned into instants here
  // rather than hard-coding TikTok's stated lifetimes.
  const expiresAt = seconds(body.expires_in, now);
  const refreshExpiresAt = seconds(body.refresh_expires_in, now);
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  if (refreshExpiresAt !== undefined) record.refreshExpiresAt = refreshExpiresAt;
  return record;
};

/**
 * Who the kept sign-in belongs to.
 *
 * The dashboard could say "Connected" and nothing else, which is no help at
 * all when the question is *which account*: open_id is per-app and opaque, so
 * it names the account to this code and to nobody else.
 *
 * Only what the granted scopes allow. user.info.basic carries the display
 * name and avatar, user.info.stats the counts. The @handle is NOT here: it
 * lives behind user.info.profile, which this app does not ask for. So the
 * account is named the way TikTok names it on the profile itself.
 */
const USER_FIELDS = ['open_id', 'display_name', 'avatar_url', 'follower_count', 'likes_count', 'video_count'];

export async function fetchProfile(accessToken, { fetchImpl = fetch, fields = USER_FIELDS } = {}) {
  let res;
  try {
    res = await fetchImpl(`${USER_URL}?fields=${fields.join(',')}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TikTokError(`profile: ${err.message}`, 'transient');
  }
  const body = await bodyOf(res);
  // A 200 carrying error.code is still a failure here, same as the posting
  // API. TikTok says code 'ok' when it means it.
  const code = String(body?.error?.code || '');
  if (!res.ok || (code && code !== 'ok')) {
    const detail = body?.error?.message || code || res.statusText;
    throw new TikTokError(`profile: ${res.status} ${detail}`, classify(res.status, body));
  }
  const user = body?.data?.user;
  if (!user) throw new TikTokError('profile: TikTok returned no user', 'transient');
  return user;
}

/** TikTok's field names mapped onto the shape the account page already reads. */
export const profileAccount = (user) => ({
  openId: user.open_id,
  displayName: user.display_name,
  avatar: user.avatar_url,
  followers: user.follower_count,
  likes: user.likes_count,
  posts: user.video_count,
});

export async function exchangeCode(keys, code, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = await tokenRequest(
    {
      client_key: keys.clientKey,
      client_secret: keys.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: keys.redirectUri,
    },
    fetchImpl,
  );
  if (!body.refresh_token) throw new TikTokError('TikTok returned no refresh token; connect again', 'auth');
  const record = { ...tokenRecord(body, now), connectedAt: new Date(now).toISOString() };
  // Ask who this is while the fresh access token is still in hand, so naming
  // the account costs no refresh later. Best effort on purpose: a name is
  // worth having, and never worth losing the sign-in that was just made.
  try {
    record.account = profileAccount(await fetchProfile(body.access_token, { fetchImpl }));
  } catch {
    // Left unnamed; the server fills it in on a later run.
  }
  return record;
}

/**
 * Swap the refresh token for an access token.
 *
 * TikTok hands back a NEW refresh token and retires the one sent, so this
 * returns both and the caller must keep the new one. `accessTokenFor` below
 * does that; prefer it.
 */
export async function refreshAccess(keys, refreshToken, { fetchImpl = fetch, now = Date.now() } = {}) {
  const body = await tokenRequest(
    { client_key: keys.clientKey, client_secret: keys.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
  );
  return {
    accessToken: body.access_token,
    token: {
      ...tokenRecord(body, now),
      // If TikTok ever stops rotating, keeping the old one is still correct.
      refreshToken: body.refresh_token || refreshToken,
      // Not connectedAt: that is when the owner signed in, and merging this
      // over the stored token must not move it forward on every refresh.
      refreshedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * An access token from the kept sign-in, with the rotated refresh token saved
 * before it is used. Saving first matters: if the process dies between the
 * refresh and the write, the stored token is already dead, and the owner has
 * to connect again for no reason.
 */
export async function accessTokenFor(keys, { load = loadToken, save = saveToken, fetchImpl = fetch, now = Date.now() } = {}) {
  const kept = await load();
  if (!kept?.refreshToken) throw new TikTokError('not connected', 'auth');
  const { accessToken, token } = await refreshAccess(keys, kept.refreshToken, { fetchImpl, now });
  if (token.refreshToken !== kept.refreshToken) await save({ ...kept, ...token });
  return accessToken;
}

// --- the kept sign-in ---------------------------------------------------------

export const TOKEN_PATH = join(config.root, 'data', 'tiktok-token.json');

export async function loadToken(path = TOKEN_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveToken(token, path = TOKEN_PATH) {
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(token, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export const forgetToken = (path = TOKEN_PATH) => rm(path, { force: true });

// --- uploading ----------------------------------------------------------------

/**
 * How to cut a file of `size` bytes into chunks TikTok will accept.
 *
 * total_chunk_count is video_size / chunk_size rounded DOWN, so the remainder
 * rides along in the final chunk rather than becoming a short one of its own
 * — a chunk under 5 MiB is rejected.
 */
export function chunkPlan(size) {
  if (!Number.isFinite(size) || size <= 0) throw new TikTokError(`refusing to upload a ${size}-byte file`, 'refused');
  // Anything up to 64 MiB goes in one piece; a short is nowhere near that.
  if (size <= MAX_CHUNK) return { chunkSize: size, totalChunkCount: 1 };
  const chunkSize = MAX_CHUNK;
  const totalChunkCount = Math.floor(size / chunkSize);
  if (totalChunkCount > 1000) throw new TikTokError('file needs more than 1000 chunks', 'refused');
  return { chunkSize, totalChunkCount };
}

/** The byte range of chunk `index`, the last one absorbing the remainder. */
export function chunkRange(index, { chunkSize, totalChunkCount }, size) {
  const start = index * chunkSize;
  const end = index === totalChunkCount - 1 ? size - 1 : start + chunkSize - 1;
  return { start, end, length: end - start + 1 };
}

/**
 * Reserve an inbox upload. Returns the publish id and the address to send the
 * bytes to, which TikTok says is good for an hour.
 */
export async function initUpload({ token, size, fetchImpl = fetch }) {
  const plan = chunkPlan(size);
  let res;
  try {
    res = await fetchImpl(INBOX_INIT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TikTokError(`starting the upload: ${err.message}`, 'transient');
  }
  if (!res.ok) throw await failure(res, 'starting the upload');
  const body = await bodyOf(res);
  // A 200 can still carry a failure: error.code is "ok" only on success.
  if (body?.error?.code && body.error.code !== 'ok') {
    throw new TikTokError(`starting the upload: ${body.error.code} ${body.error.message || ''}`.trim(), classify(res.status, body));
  }
  const publishId = body?.data?.publish_id;
  const uploadUrl = body?.data?.upload_url;
  if (!publishId || !uploadUrl) throw new TikTokError('TikTok gave no upload address', 'transient');
  return { publishId, uploadUrl, plan };
}

/** Send one chunk. 206 means more are expected, 201 that TikTok has them all. */
export async function putChunk({ uploadUrl, file, size, range, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(range.length),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      },
      body: Readable.toWeb(createReadStream(file, { start: range.start, end: range.end })),
      duplex: 'half',
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (err) {
    // The bytes may or may not have landed, and the init already counted
    // against the 24-hour cap, so the caller must not retry blind.
    throw new TikTokError(`sending the video: ${err.message}`, 'uncertain');
  }
  if (res.status === 206) return 'more';
  if (res.status === 200 || res.status === 201) return 'done';
  if (res.status === 403 || res.status === 404 || res.status === 416) {
    throw new TikTokError(`sending the video: ${res.status} the upload address is no longer good`, 'transient');
  }
  if (res.status >= 500) throw new TikTokError(`sending the video: ${res.status} ${res.statusText}`, 'transient');
  throw await failure(res, 'sending the video');
}

/** What became of a publish. Terminal for an inbox upload is SEND_TO_USER_INBOX. */
export async function postStatus({ token, publishId, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(STATUS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TikTokError(`checking the upload: ${err.message}`, 'transient');
  }
  if (!res.ok) throw await failure(res, 'checking the upload');
  const body = await bodyOf(res);
  if (body?.error?.code && body.error.code !== 'ok') {
    throw new TikTokError(`checking the upload: ${body.error.code} ${body.error.message || ''}`.trim(), classify(res.status, body));
  }
  return { status: body?.data?.status || null, failReason: body?.data?.fail_reason || null };
}

// A fail_reason TikTok says not to retry is a refusal of this video; `internal`
// is explicitly retryable. Anything else is left unknown rather than guessed.
const FAIL_KIND = {
  internal: 'transient',
  file_format_check_failed: 'refused',
  duration_check_failed: 'refused',
  frame_rate_check_failed: 'refused',
  picture_size_check_failed: 'refused',
  video_pull_failed: 'refused',
  photo_pull_failed: 'refused',
  publish_cancelled: 'refused',
  spam_risk_text: 'refused',
  spam_risk: 'refused',
  auth_removed: 'auth',
  spam_risk_user_banned_from_posting: 'blocked',
  spam_risk_too_many_posts: 'quota',
};

export const failKind = (reason) => FAIL_KIND[reason] || 'uncertain';

const DONE = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);

/**
 * Upload one short to the owner's TikTok inbox.
 *
 * Returns the publish id and the last status seen. The confirm step is a
 * courtesy, not the result: once the bytes are in, TikTok owns the outcome, so
 * a confirm that cannot be reached is reported rather than treated as failure.
 */
export async function uploadVideo({ token, file, fetchImpl = fetch, confirmTries = 4, waitMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const size = (await stat(file)).size;
  const { publishId, uploadUrl, plan } = await initUpload({ token, size, fetchImpl });

  for (let index = 0; index < plan.totalChunkCount; index += 1) {
    const range = chunkRange(index, plan, size);
    const result = await putChunk({ uploadUrl, file, size, range, fetchImpl });
    if (result === 'done') break;
  }

  let status = null;
  let failReason = null;
  for (let attempt = 0; attempt < confirmTries; attempt += 1) {
    await sleep(waitMs);
    try {
      ({ status, failReason } = await postStatus({ token, publishId, fetchImpl }));
    } catch (err) {
      // Could not ask. The video is TikTok's problem now; say so and stop.
      return { publishId, status: null, failReason: null, confirmError: err.message };
    }
    if (status === 'FAILED') throw new TikTokError(`TikTok rejected the video: ${failReason || 'no reason given'}`, failKind(failReason));
    if (DONE.has(status)) return { publishId, status, failReason: null };
  }
  // Still processing. Normal, and not a failure.
  return { publishId, status, failReason };
}

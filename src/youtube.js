// YouTube: sign-in and upload, through the account owner's own Google app.
//
// The keys are the owner's (YOUTUBE_CLIENT_ID / _SECRET in .env, see
// docs/posting-setup.md). Signing in happens once in the owner's browser; the
// refresh token it returns is kept in data/youtube-token.json, which is
// git-ignored with the rest of data/ and never leaves this PC.
//
// Plain fetch, no SDK: two endpoints for the token, one resumable upload.

import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { config } from './config.js';
import { writeSecret } from './secretfile.js';

// Upload, plus read access for the stats dashboard. One sign-in covers both,
// so the owner consents once; adding the second scope does mean anyone who
// connected before this change has to connect again, because a refresh token
// carries the scopes it was granted with.
export const SCOPE = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
].join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

export const youtubeKeys = (env = process.env) => ({
  clientId: env.YOUTUBE_CLIENT_ID?.trim() || '',
  clientSecret: env.YOUTUBE_CLIENT_SECRET?.trim() || '',
  redirectUri: env.YOUTUBE_REDIRECT_URI?.trim() || `http://localhost:${config.port}/auth/youtube/callback`,
});

export const hasKeys = (keys) => Boolean(keys.clientId && keys.clientSecret);

/**
 * Why an upload failed, as what to do about it:
 *   quota    — today's allowance is spent; stop until it resets
 *   auth     — the sign-in is gone; stop until the owner connects again
 *   refused  — YouTube will not take this video; skip it, never retry it
 *   transient— the network or YouTube's side; try again later
 */
export class UploadError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

export function classify(status, body) {
  const reasons = (body?.error?.errors || []).map((e) => e.reason).concat(body?.error?.status || [], body?.error || []);
  const text = JSON.stringify(reasons);
  if (/quotaExceeded|dailyLimitExceeded|uploadLimitExceeded|rateLimitExceeded/.test(text)) return 'quota';
  if (status === 401 || /invalid_grant|unauthorized_client|authError/.test(text)) return 'auth';
  // Any other 403 is about the account, not the video: missing permission,
  // no channel, closed or suspended. Treating it as a refusal of this short
  // would strike off every short in turn, one per slot, so it stops instead.
  if (status === 403) return 'auth';
  if (status >= 500 || status === 429) return 'transient';
  return 'refused';
}

async function failure(res, what) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const detail = body?.error?.message || body?.error_description || body?.error || res.statusText;
  return new UploadError(`${what}: ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, classify(res.status, body));
}

/** Where the Connect button sends the owner: Google's own consent page. */
export function authUrl(keys, state) {
  const params = new URLSearchParams({
    client_id: keys.clientId,
    redirect_uri: keys.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // A refresh token, so uploads keep working without the owner present.
    access_type: 'offline',
    prompt: 'consent',
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
    throw new UploadError(`sign-in: ${err.message}`, 'transient');
  }
  if (!res.ok) throw await failure(res, 'sign-in');
  return res.json();
}

export async function exchangeCode(keys, code, { fetchImpl = fetch } = {}) {
  const token = await tokenRequest(
    { code, client_id: keys.clientId, client_secret: keys.clientSecret, redirect_uri: keys.redirectUri, grant_type: 'authorization_code' },
    fetchImpl,
  );
  if (!token.refresh_token) throw new UploadError('Google returned no refresh token; connect again', 'auth');
  return { refreshToken: token.refresh_token, connectedAt: new Date().toISOString() };
}

export async function accessToken(keys, refreshToken, { fetchImpl = fetch } = {}) {
  const token = await tokenRequest(
    { refresh_token: refreshToken, client_id: keys.clientId, client_secret: keys.clientSecret, grant_type: 'refresh_token' },
    fetchImpl,
  );
  return token.access_token;
}

// --- the kept sign-in ---------------------------------------------------------

export const TOKEN_PATH = join(config.root, 'data', 'youtube-token.json');

export async function loadToken(path = TOKEN_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveToken(token, path = TOKEN_PATH) {
  await writeSecret(path, token);
}

export const forgetToken = (path = TOKEN_PATH) => rm(path, { force: true });

// --- uploading ----------------------------------------------------------------

/**
 * Upload one video. Resumable protocol: the metadata first, which returns an
 * upload address, then the bytes in one PUT. Returns the new video's id.
 */
export async function uploadVideo({ token, file, title, description, tags = [], privacy = 'public', fetchImpl = fetch }) {
  const size = (await stat(file)).size;
  const metadata = {
    snippet: { title, description, tags, categoryId: '20' }, // 20: Gaming
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  };
  let res;
  try {
    res = await fetchImpl(UPLOAD_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new UploadError(`starting the upload: ${err.message}`, 'transient');
  }
  if (!res.ok) throw await failure(res, 'starting the upload');
  const location = res.headers.get('location');
  if (!location) throw new UploadError('YouTube gave no upload address', 'transient');

  try {
    res = await fetchImpl(location, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: Readable.toWeb(createReadStream(file)),
      duplex: 'half',
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (err) {
    // The bytes may or may not have landed: the caller must not retry blind.
    throw new UploadError(`sending the video: ${err.message}`, 'uncertain');
  }
  if (!res.ok) throw await failure(res, 'sending the video');
  const video = await res.json();
  if (!video?.id) throw new UploadError('YouTube accepted the upload but returned no video id', 'uncertain');
  return video.id;
}

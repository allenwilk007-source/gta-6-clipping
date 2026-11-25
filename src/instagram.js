// Instagram: sign-in and Reel upload, through the account owner's own Meta app.
//
// WHY THIS IS THE AWKWARD ONE
//
// Instagram has two API flavours, and only one of them can post a file that
// lives on this PC:
//
//   Instagram API with Instagram Login   Simplest to set up, no Facebook Page.
//     Cannot be used here: publishing takes a `video_url` that Meta's servers
//     fetch, and Meta's own words are "the media must be hosted on a publicly
//     accessible server at the time of the attempt". A home PC has no public
//     URL, and putting one up to satisfy an API would mean exposing the clips
//     to anyone who guessed the address.
//
//   Instagram API with Facebook Login    What this module uses. It accepts the
//     bytes directly (rupload.facebook.com), but the Instagram account must be
//     a professional account LINKED TO A FACEBOOK PAGE the owner administers.
//
// So the Facebook Page is not red tape this could skip; it is the only route
// that does not require publishing the clips to the open internet first.
//
// WHAT IS NOT VERIFIED
//
// Written from Meta's documentation without a live account to test against.
// Four things the docs do not settle, each marked again where it matters:
//   1. The Page -> Instagram account id field. `instagram_business_account` is
//      long-standing, but the pages read did not name it, so a fallback is
//      tried and the failure says plainly what to look at.
//   2. Whether a ~14 MB file must be chunked. Every documented example sends
//      the whole file in one request with `offset: 0`, so that is what this
//      does.
//   3. Whether publishing needs the Page token or the user token. Meta's
//      content-publishing page says Page token; three reference pages say
//      user token. This uses the Page token and falls back to the user token
//      on an auth failure, rather than making the owner guess.
//   4. Whether Standard Access is enough to post to the owner's own account.
//      Meta says "If your app only serves your Instagram professional account
//      or an account you manage, Standard Access is all your app needs", then
//      warns some features may need Advanced Access. Only a real attempt
//      settles it.
//
// Plain fetch, no SDK.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { config } from './config.js';
import { writeSecret } from './secretfile.js';

const VERSION = 'v27.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const UPLOAD = `https://rupload.facebook.com/ig-api-upload/${VERSION}`;
const DIALOG = `https://www.facebook.com/${VERSION}/dialog/oauth`;

// instagram_basic + instagram_content_publish do the publishing;
// pages_show_list lists the Pages, pages_read_engagement reads the one that
// carries the Instagram account.
export const SCOPE = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'].join(',');

// Instagram's documented cap: 50 published posts in a rolling 24 hours.
export const PUBLISH_CAP = 50;
export const CAP_WINDOW_MS = 24 * 3600_000;

// Reel limits from Meta's media reference, used to refuse a file before it
// costs a slot rather than after.
export const MAX_BYTES = 300 * 1024 * 1024;
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 15 * 60;

export const instagramKeys = (env = process.env) => ({
  appId: env.INSTAGRAM_APP_ID?.trim() || '',
  appSecret: env.INSTAGRAM_APP_SECRET?.trim() || '',
  redirectUri: env.INSTAGRAM_REDIRECT_URI?.trim() || `http://localhost:${config.port}/auth/instagram/callback`,
});

export const hasKeys = (keys) => Boolean(keys.appId && keys.appSecret);

/** Same vocabulary as the YouTube and TikTok modules. See tiktok.js. */
export class InstagramError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'InstagramError';
    this.kind = kind;
  }
}

// Meta reports the real reason in error_subcode; `code` is coarse and reused.
const SUBCODE_KIND = {
  2207042: 'quota', // daily publishing cap reached
  2207051: 'blocked', // flagged as spam
  2207050: 'blocked', // account restricted
  2207026: 'refused', // unsupported video format
  2207009: 'refused', // aspect ratio out of range
  2207020: 'refused', // media expired, make a new container
  2207052: 'refused', // media could not be fetched
  2207053: 'refused', // unknown upload error
  2207003: 'transient', // download timeout
  2207008: 'transient', // temporary, retry in a minute or two
  2207027: 'transient', // not ready yet
  2207006: 'auth', // missing permission or expired token
};

export function classify(status, body) {
  const error = body?.error || {};
  const subcode = Number(error.error_subcode);
  if (SUBCODE_KIND[subcode]) return SUBCODE_KIND[subcode];
  const code = Number(error.code);
  // 190 is the token; 102/463/467 are session problems. All mean sign in again.
  if ([190, 102, 463, 467].includes(code)) return 'auth';
  if (error.type === 'OAuthException' && [10, 200, 203, 299].includes(code)) return 'auth';
  // 4/17/32 are app and user rate limits, 80001/80002 per-Page and per-account.
  if ([4, 17, 32, 613, 80001, 80002].includes(code)) return 'transient';
  if (code === 368) return 'blocked'; // "abusive or otherwise disallowed"
  if (error.is_transient) return 'transient';
  if (status === 401) return 'auth';
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'refused';
}

// A container that comes back ERROR carries its reason in `status`.
const STATUS_KIND = {
  file_format_check_failed: 'refused',
  duration_check_failed: 'refused',
  frame_rate_check_failed: 'refused',
  picture_size_check_failed: 'refused',
  aspect_ratio_check_failed: 'refused',
  internal: 'transient',
};

export const failKind = (reason) => STATUS_KIND[String(reason || '').toLowerCase()] || 'uncertain';

async function bodyOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function failure(res, what) {
  const body = await bodyOf(res);
  const detail = body?.error?.error_user_msg || body?.error?.message || body?.debug_info?.message || res.statusText;
  return new InstagramError(`${what}: ${res.status} ${detail}`, classify(res.status, body));
}

/** A Graph call, with Meta's habit of returning errors inside a 200 handled. */
async function graph(url, { what, method = 'GET', token, body = null, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new InstagramError(`${what}: ${err.message}`, 'transient');
  }
  if (!res.ok) throw await failure(res, what);
  const payload = await bodyOf(res);
  if (payload?.error) throw new InstagramError(`${what}: ${payload.error.message || 'failed'}`, classify(res.status, payload));
  return payload;
}

// --- signing in ---------------------------------------------------------------

export function authUrl(keys, state) {
  const params = new URLSearchParams({
    client_id: keys.appId,
    redirect_uri: keys.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
  });
  return `${DIALOG}?${params}`;
}

/** The code is good for an hour and the token it returns for about one. */
export async function exchangeCode(keys, code, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    client_id: keys.appId,
    client_secret: keys.appSecret,
    redirect_uri: keys.redirectUri,
    code,
  });
  const body = await graph(`${GRAPH}/oauth/access_token?${params}`, { what: 'sign-in', fetchImpl });
  if (!body?.access_token) throw new InstagramError('Facebook returned no access token', 'auth');
  return body.access_token;
}

/**
 * Trade a short-lived token for one that lasts about 60 days.
 *
 * There is no refresh token: the long-lived token is swapped for a fresh one
 * before it expires, using this same call. An expired one cannot be renewed,
 * so the swap has to happen while it still works.
 */
export async function longLivedToken(keys, token, { fetchImpl = fetch, now = Date.now() } = {}) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: keys.appId,
    client_secret: keys.appSecret,
    fb_exchange_token: token,
  });
  const body = await graph(`${GRAPH}/oauth/access_token?${params}`, { what: 'extending the sign-in', fetchImpl });
  if (!body?.access_token) throw new InstagramError('Facebook returned no long-lived token', 'auth');
  return {
    userToken: body.access_token,
    userTokenExpiresAt: Number.isFinite(Number(body.expires_in)) ? now + Number(body.expires_in) * 1000 : null,
  };
}

/**
 * Find the Instagram account to post to: the Pages this user administers, then
 * the Instagram professional account linked to one of them.
 *
 * UNVERIFIED (1): the field naming that link. `instagram_business_account` is
 * the long-standing one; `connected_instagram_account` is tried as a fallback.
 * If neither is there the error says what to check, because every other call
 * in this module depends on the id.
 */
export async function findAccount(userToken, { fetchImpl = fetch } = {}) {
  const pages = await graph(`${GRAPH}/me/accounts?fields=id,name,access_token,tasks`, {
    what: 'listing your Facebook Pages',
    token: userToken,
    fetchImpl,
  });
  const list = pages?.data || [];
  if (!list.length) {
    throw new InstagramError(
      'no Facebook Page found on this account — an Instagram professional account linked to a Page is what this posts through',
      'refused',
    );
  }

  for (const page of list) {
    const fields = 'instagram_business_account{id,username},connected_instagram_account{id,username}';
    let detail;
    try {
      detail = await graph(`${GRAPH}/${page.id}?fields=${encodeURIComponent(fields)}`, {
        what: `reading Page ${page.name}`,
        token: page.access_token || userToken,
        fetchImpl,
      });
    } catch (err) {
      if (err.kind === 'auth') throw err;
      continue;
    }
    const account = detail?.instagram_business_account || detail?.connected_instagram_account;
    if (!account?.id) continue;
    // Publishing needs admin-equivalent rights on the Page.
    const tasks = page.tasks || [];
    if (tasks.length && !tasks.includes('CREATE_CONTENT') && !tasks.includes('MANAGE')) continue;
    return {
      igUserId: account.id,
      username: account.username || null,
      pageId: page.id,
      pageName: page.name || null,
      pageToken: page.access_token || null,
    };
  }

  throw new InstagramError(
    `none of your ${list.length} Facebook Page(s) has an Instagram professional account linked with content rights — ` +
      'link the account to the Page in Instagram (Settings -> Account -> Sharing to other apps) and give yourself Create Content or Manage on the Page',
    'refused',
  );
}

// --- the kept sign-in ---------------------------------------------------------

export const TOKEN_PATH = join(config.root, 'data', 'instagram-token.json');

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

/** Everything a connect produces, ready to be written to disk. */
export async function connect(keys, code, { fetchImpl = fetch, now = Date.now() } = {}) {
  const shortLived = await exchangeCode(keys, code, { fetchImpl });
  const { userToken, userTokenExpiresAt } = await longLivedToken(keys, shortLived, { fetchImpl, now });
  const account = await findAccount(userToken, { fetchImpl });
  return { userToken, userTokenExpiresAt, ...account, connectedAt: new Date(now).toISOString() };
}

// Swap the 60-day token when a week is left: early enough that a few days of
// the uploader being switched off cannot let it lapse, which is unrecoverable.
const RENEW_WITHIN_MS = 7 * 24 * 3600_000;

/**
 * The tokens to post with, renewed if the long-lived one is near its end.
 *
 * Returns the Page token and the user token: see UNVERIFIED (3) — which one
 * publishing wants is contradicted between Meta's own pages, so the caller
 * tries one and falls back.
 */
export async function tokensFor(keys, { load = loadToken, save = saveToken, fetchImpl = fetch, now = Date.now() } = {}) {
  let kept = await load();
  if (!kept?.userToken) throw new InstagramError('not connected', 'auth');
  if (Number.isFinite(kept.userTokenExpiresAt) && kept.userTokenExpiresAt <= now) {
    throw new InstagramError('the Facebook sign-in has expired and cannot be renewed; connect Instagram again', 'auth');
  }

  if (Number.isFinite(kept.userTokenExpiresAt) && kept.userTokenExpiresAt - now < RENEW_WITHIN_MS) {
    const renewed = await longLivedToken(keys, kept.userToken, { fetchImpl, now });
    // The Page token is derived from the user token, so it is re-read too.
    const account = await findAccount(renewed.userToken, { fetchImpl });
    kept = { ...kept, ...renewed, ...account };
    await save(kept);
  }
  if (!kept.igUserId) throw new InstagramError('no Instagram account on this sign-in; connect Instagram again', 'auth');
  return { pageToken: kept.pageToken, userToken: kept.userToken, igUserId: kept.igUserId, username: kept.username };
}

// --- uploading ----------------------------------------------------------------

/** Reserve a Reel container and get the address to send the bytes to. */
export async function createContainer({ token, igUserId, caption, shareToFeed = true, fetchImpl = fetch }) {
  const params = new URLSearchParams({
    media_type: 'REELS',
    upload_type: 'resumable',
    access_token: token,
  });
  if (caption) params.set('caption', caption);
  if (shareToFeed) params.set('share_to_feed', 'true');
  const body = await graph(`${GRAPH}/${igUserId}/media?${params}`, { what: 'starting the upload', method: 'POST', fetchImpl });
  if (!body?.id) throw new InstagramError('Instagram gave no container id', 'transient');
  // Meta returns the upload address; using it rather than building one keeps
  // this working if the host or version moves.
  return { containerId: body.id, uploadUrl: body.uri || `${UPLOAD}/${body.id}` };
}

/**
 * Send the file.
 *
 * UNVERIFIED (2): every documented example sends the whole file in one request
 * with `offset: 0` and `file_size` set to the total, and no page describes a
 * multi-part protocol. A short is ~14 MB, well inside the 300 MB limit, so one
 * request is what this does.
 *
 * The header here is `Authorization: OAuth`, not `Bearer` — rupload is the one
 * host that wants it that way, and Bearer fails there.
 */
export async function sendBytes({ uploadUrl, token, file, size, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(size) },
      body: Readable.toWeb(createReadStream(file)),
      duplex: 'half',
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch (err) {
    throw new InstagramError(`sending the video: ${err.message}`, 'uncertain');
  }
  const body = await bodyOf(res);
  if (!res.ok || body?.debug_info) {
    const info = body?.debug_info;
    if (info) {
      throw new InstagramError(`sending the video: ${info.message || info.type}`, info.retriable ? 'transient' : 'refused');
    }
    throw await failure(res, 'sending the video');
  }
  if (body && body.success === false) throw new InstagramError(`sending the video: ${body.message || 'refused'}`, 'refused');
  return true;
}

export async function containerStatus({ token, containerId, fetchImpl = fetch }) {
  const params = new URLSearchParams({ fields: 'status_code,status', access_token: token });
  const body = await graph(`${GRAPH}/${containerId}?${params}`, { what: 'checking the upload', fetchImpl });
  return { statusCode: body?.status_code || null, status: body?.status || null };
}

export async function publish({ token, igUserId, containerId, fetchImpl = fetch }) {
  const params = new URLSearchParams({ creation_id: containerId, access_token: token });
  const body = await graph(`${GRAPH}/${igUserId}/media_publish?${params}`, { what: 'publishing', method: 'POST', fetchImpl });
  if (!body?.id) throw new InstagramError('Instagram accepted the publish but returned no media id', 'uncertain');
  return body.id;
}

/**
 * The public link to a post. A media id is not a shortcode, so the only way
 * to a usable URL is to ask. Best-effort: a post that exists is not worth
 * failing over a link.
 */
export async function permalink({ token, mediaId, fetchImpl = fetch }) {
  try {
    const params = new URLSearchParams({ fields: 'permalink', access_token: token });
    const body = await graph(`${GRAPH}/${mediaId}?${params}`, { what: 'reading the post link', fetchImpl });
    return body?.permalink || null;
  } catch {
    return null;
  }
}

/** How much of the 50-a-day cap Instagram itself thinks is used. */
export async function publishingLimit({ token, igUserId, fetchImpl = fetch }) {
  const params = new URLSearchParams({ fields: 'quota_usage,config', access_token: token });
  const body = await graph(`${GRAPH}/${igUserId}/content_publishing_limit?${params}`, { what: 'checking the daily limit', fetchImpl });
  const row = body?.data?.[0] || {};
  return { used: Number(row.quota_usage) || 0, total: Number(row.config?.quota_total) || PUBLISH_CAP };
}

/**
 * Upload one short as a Reel. Returns the published media id.
 *
 * The container has to reach FINISHED before it can be published; Meta says to
 * poll once a minute for no more than five.
 */
export async function uploadVideo({
  token,
  igUserId,
  file,
  caption,
  shareToFeed = true,
  fetchImpl = fetch,
  tries = 5,
  waitMs = 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const size = (await stat(file)).size;
  if (size > MAX_BYTES) throw new InstagramError(`the file is ${Math.round(size / 1024 / 1024)} MB; Instagram's limit is 300 MB`, 'refused');

  const { containerId, uploadUrl } = await createContainer({ token, igUserId, caption, shareToFeed, fetchImpl });
  await sendBytes({ uploadUrl, token, file, size, fetchImpl });

  for (let attempt = 0; attempt < tries; attempt += 1) {
    await sleep(waitMs);
    const { statusCode, status } = await containerStatus({ token, containerId, fetchImpl });
    if (statusCode === 'FINISHED') return publish({ token, igUserId, containerId, fetchImpl });
    if (statusCode === 'PUBLISHED') return containerId;
    if (statusCode === 'ERROR') throw new InstagramError(`Instagram rejected the video: ${status || 'no reason given'}`, failKind(status));
    if (statusCode === 'EXPIRED') throw new InstagramError('the upload expired before it could be published', 'transient');
  }
  // Still processing after five minutes. The bytes are in and a container may
  // yet publish itself, so this must not be retried as though nothing happened.
  throw new InstagramError('Instagram was still processing the video after five minutes', 'uncertain');
}

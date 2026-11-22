// Naming the account the clips are going to.
//
// "Connected" on its own cannot answer the only question anybody asks of it —
// *which account?* — because the one identifier kept on disk, open_id, is
// minted per app and means nothing outside this code. These tests pin what is
// read, what is deliberately not read, and that failing to read it never
// costs the owner a sign-in or a post.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { exchangeCode, fetchProfile, profileAccount } from './tiktok.js';

const KEYS = { clientKey: 'ck', clientSecret: 'cs', redirectUri: 'http://localhost:3000/auth/tiktok/callback' };

const okJson = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body });
const user = (fields) => okJson({ data: { user: fields }, error: { code: 'ok', message: '', log_id: 'l1' } });

const SOME = {
  open_id: 'oid',
  display_name: 'Tarkov Wkx',
  avatar_url: 'https://p16.tiktokcdn.com/a.jpeg',
  follower_count: 12,
  likes_count: 340,
  video_count: 7,
};

describe('fetchProfile', () => {
  test('asks only for fields the granted scopes cover', async () => {
    let asked;
    await fetchProfile('at', {
      fetchImpl: async (url) => {
        asked = new URL(url).searchParams.get('fields').split(',');
        return user(SOME);
      },
    });
    // user.info.basic and user.info.stats. Nothing from user.info.profile,
    // which this app never asks the owner to grant.
    assert.ok(asked.includes('display_name'));
    assert.ok(asked.includes('follower_count'));
    assert.ok(!asked.includes('username'), 'asked for a field the scopes do not cover');
    assert.ok(!asked.includes('profile_deep_link'));
  });

  test('sends the access token as a bearer', async () => {
    let headers;
    await fetchProfile('the-token', {
      fetchImpl: async (_url, options) => {
        headers = options.headers;
        return user(SOME);
      },
    });
    assert.equal(headers.authorization, 'Bearer the-token');
  });

  test('a 200 carrying an error code is a failure, not a profile', async () => {
    await assert.rejects(
      fetchProfile('at', { fetchImpl: async () => okJson({ error: { code: 'access_token_invalid', message: 'nope' } }) }),
      (err) => err.kind === 'auth' && /access_token_invalid|nope/.test(err.message),
    );
  });

  test('a 429 is transient, so nothing treats it as a lost sign-in', async () => {
    await assert.rejects(
      fetchProfile('at', { fetchImpl: async () => okJson({ error: { code: 'rate_limit_exceeded' } }, 429) }),
      (err) => err.kind === 'transient',
    );
  });

  test('a reply with no user is refused rather than returned empty', async () => {
    await assert.rejects(fetchProfile('at', { fetchImpl: async () => okJson({ data: {}, error: { code: 'ok' } }) }), /no user/);
  });
});

describe('profileAccount', () => {
  test("maps TikTok's names onto the ones the account page already reads", () => {
    assert.deepEqual(profileAccount(SOME), {
      openId: 'oid',
      displayName: 'Tarkov Wkx',
      avatar: 'https://p16.tiktokcdn.com/a.jpeg',
      followers: 12,
      likes: 340,
      posts: 7,
    });
  });

  test('a missing field stays missing instead of becoming a zero', () => {
    const account = profileAccount({ open_id: 'oid', display_name: 'Someone' });
    assert.equal(account.followers, undefined);
    assert.equal(account.posts, undefined);
  });
});

describe('exchangeCode names the account it just connected', () => {
  // Both calls the sign-in makes: the token POST, then the profile GET with
  // the access token that POST returned.
  const bothCalls = (profile) => async (url, options) => {
    if (options?.method === 'POST') return okJson({ access_token: 'at', refresh_token: 'rt', open_id: 'oid', expires_in: 7200 });
    assert.equal(options.headers.authorization, 'Bearer at', 'used a token other than the one just issued');
    return profile(url);
  };

  test('keeps the name beside the token', async () => {
    const token = await exchangeCode(KEYS, 'code', { fetchImpl: bothCalls(() => user(SOME)), now: 5 });
    assert.equal(token.refreshToken, 'rt');
    assert.equal(token.account.displayName, 'Tarkov Wkx');
  });

  test('a profile that will not load does NOT cost the owner the sign-in', async () => {
    const token = await exchangeCode(KEYS, 'code', {
      fetchImpl: bothCalls(() => {
        throw new Error('network went away');
      }),
      now: 5,
    });
    assert.equal(token.refreshToken, 'rt', 'threw away a good sign-in over a name');
    assert.equal(token.account, undefined);
  });

  test('a refused profile is swallowed too, for the same reason', async () => {
    const token = await exchangeCode(KEYS, 'code', {
      fetchImpl: bothCalls(() => okJson({ error: { code: 'scope_not_authorized' } })),
      now: 5,
    });
    assert.equal(token.refreshToken, 'rt');
    assert.equal(token.account, undefined);
  });
});

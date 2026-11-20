import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { authorized, isPublicPath } from './gate.js';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

describe('isPublicPath', () => {
  test('leaves the two documents TikTok re-checks open', () => {
    assert.equal(isPublicPath('/terms'), true);
    assert.equal(isPublicPath('/privacy'), true);
  });

  test('leaves the signature file open', () => {
    assert.equal(isPublicPath('/tiktokfYsZwmjy1bRJ0MsPPraMOdcm9vd3mnDK.txt'), true);
  });

  test('keeps the dashboard and its API closed', () => {
    for (const path of ['/', '/index.html', '/tiktok.html', '/api/automation', '/api/uploads', '/auth/tiktok']) {
      assert.equal(isPublicPath(path), false, path);
    }
  });

  test('does not open every text file, only the signature', () => {
    assert.equal(isPublicPath('/notes.txt'), false);
    assert.equal(isPublicPath('/tiktok.txt'), false);
  });

  test('does not let anything ride in on the signature pattern', () => {
    assert.equal(isPublicPath('/tiktokAAA.txt/index.html'), false);
    assert.equal(isPublicPath('/x/tiktokAAA.txt'), false);
  });
});

describe('authorized', () => {
  test('lets everything through when no password is set', () => {
    assert.equal(authorized(undefined, ''), true);
    assert.equal(authorized('Basic nonsense', ''), true);
  });

  test('accepts the right password whatever the username', () => {
    assert.equal(authorized(basic('allen', 'hunter2'), 'hunter2'), true);
    assert.equal(authorized(basic('', 'hunter2'), 'hunter2'), true);
  });

  test('refuses the wrong password', () => {
    assert.equal(authorized(basic('allen', 'hunter3'), 'hunter2'), false);
  });

  test('refuses a password that is merely a prefix of the right one', () => {
    assert.equal(authorized(basic('allen', 'hunter'), 'hunter2'), false);
  });

  test('refuses a missing or malformed header', () => {
    assert.equal(authorized(undefined, 'hunter2'), false);
    assert.equal(authorized('', 'hunter2'), false);
    assert.equal(authorized('Bearer hunter2', 'hunter2'), false);
    assert.equal(authorized('Basic', 'hunter2'), false);
    assert.equal(authorized(`Basic ${Buffer.from('nocolon', 'utf8').toString('base64')}`, 'hunter2'), false);
  });

  test('keeps a password containing a colon intact', () => {
    assert.equal(authorized(basic('allen', 'a:b:c'), 'a:b:c'), true);
  });
});

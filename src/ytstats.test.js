import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_REFRESH_MS,
  StatsCache,
  fetchStats,
  fetchVideoStats,
  idBatches,
  parseDuration,
  statsErrorKind,
  summarizeChannel,
  videoRows,
} from './ytstats.js';

describe('statsErrorKind', () => {
  it('only a real auth failure counts as a lost sign-in', () => {
    assert.equal(statsErrorKind({ kind: 'auth' }), 'auth');
  });

  it('a server error or rate limit is the network, not the sign-in', () => {
    // Offering Connect for a 503 sends the owner to re-consent over a blip,
    // which teaches them to click through consent screens without reading.
    assert.equal(statsErrorKind({ kind: 'transient' }), 'transient');
    assert.equal(statsErrorKind({ kind: 'quota' }), 'transient');
  });

  it('an error with no kind at all is transient, not auth', () => {
    // A dropped connection throws a bare TypeError from fetch. Guessing
    // "auth" there is the expensive direction to be wrong in.
    assert.equal(statsErrorKind(new Error('fetch failed')), 'transient');
    assert.equal(statsErrorKind(undefined), 'transient');
  });
});

// Shapes taken from the YouTube Data API v3 reference, trimmed to the fields
// this reads. Tested against the documented shape rather than a tidier one,
// because the fields that bite are the ones that are absent.
const CHANNEL = {
  items: [
    {
      id: 'UC123',
      snippet: { title: 'Clip Poster', thumbnails: { default: { url: 'https://i/ch.jpg' } } },
      statistics: { viewCount: '48213', subscriberCount: '1270', videoCount: '94' },
      contentDetails: { relatedPlaylists: { uploads: 'UU123' } },
    },
  ],
};

const VIDEOS = {
  items: [
    {
      id: 'v1',
      snippet: {
        title: 'Lirik Has Chat in Tears in GTA 6',
        publishedAt: '2026-11-18T21:30:00Z',
        thumbnails: { medium: { url: 'https://i/v1.jpg' } },
      },
      statistics: { viewCount: '9120', likeCount: '418', commentCount: '37' },
      contentDetails: { duration: 'PT30S' },
      status: { privacyStatus: 'public' },
    },
  ],
};

describe('parseDuration', () => {
  it('reads the short-form cases', () => {
    assert.equal(parseDuration('PT30S'), 30);
    assert.equal(parseDuration('PT1M30S'), 90);
    assert.equal(parseDuration('PT45S'), 45);
  });

  it('reads hours and days, so a VOD is a number rather than a blank', () => {
    assert.equal(parseDuration('PT2H5M'), 7500);
    assert.equal(parseDuration('P1DT2H'), 93600);
  });

  it('returns nothing for a live stream or a malformed value', () => {
    // A live broadcast has no duration at all.
    assert.equal(parseDuration('P0D'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration(undefined), null);
    assert.equal(parseDuration('30 seconds'), null);
  });
});

describe('summarizeChannel', () => {
  it('pulls the totals and the uploads playlist', () => {
    const channel = summarizeChannel(CHANNEL);
    assert.equal(channel.title, 'Clip Poster');
    assert.equal(channel.subscribers, 1270);
    assert.equal(channel.views, 48213);
    assert.equal(channel.videos, 94);
    assert.equal(channel.uploadsPlaylist, 'UU123');
  });

  it('a hidden subscriber count is an absence, not a zero', () => {
    const hidden = {
      items: [
        {
          id: 'UC1',
          snippet: { title: 'x' },
          statistics: { hiddenSubscriberCount: true, subscriberCount: '0', viewCount: '5' },
        },
      ],
    };
    const channel = summarizeChannel(hidden);
    assert.equal(channel.subscribers, null);
    assert.equal(channel.subscribersHidden, true);
  });

  it('returns nothing when the account has no channel', () => {
    assert.equal(summarizeChannel({ items: [] }), null);
    assert.equal(summarizeChannel({}), null);
  });
});

describe('videoRows', () => {
  it('turns a video into a row', () => {
    const [row] = videoRows(VIDEOS);
    assert.equal(row.id, 'v1');
    assert.equal(row.views, 9120);
    assert.equal(row.likes, 418);
    assert.equal(row.seconds, 30);
    assert.equal(row.privacy, 'public');
    assert.equal(row.url, 'https://www.youtube.com/watch?v=v1');
  });

  it('keeps a hidden like count out of the numbers', () => {
    // Creators can hide likes; the field is then simply missing. Treating that
    // as 0 would show a popular video as having no likes.
    const hidden = structuredClone(VIDEOS);
    delete hidden.items[0].statistics.likeCount;
    const [row] = videoRows(hidden);
    assert.equal(row.likes, null);
    assert.equal(row.views, 9120);
  });

  it('survives a response with no items', () => {
    assert.deepEqual(videoRows({}), []);
    assert.deepEqual(videoRows({ items: [] }), []);
  });
});

describe('fetchStats', () => {
  const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

  it('spends three requests and batches the video ids into one', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('/channels')) return okJson(CHANNEL);
      if (url.includes('/playlistItems'))
        return okJson({ items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] });
      return okJson(VIDEOS);
    };

    const stats = await fetchStats({ token: 't', fetchImpl });

    assert.equal(calls.length, 3);
    // Both ids in one videos.list call: one quota unit, not one per video.
    assert.match(calls[2], /id=v1%2Cv2/);
    assert.equal(stats.channel.subscribers, 1270);
    assert.equal(stats.videos.length, 1);
  });

  it('calls nothing more when the channel has no uploads playlist', async () => {
    const bare = structuredClone(CHANNEL);
    delete bare.items[0].contentDetails;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return okJson(bare);
    };

    const stats = await fetchStats({ token: 't', fetchImpl });

    assert.equal(calls, 1);
    assert.deepEqual(stats.videos, []);
  });

  it('tells a stale sign-in apart from an exhausted quota', async () => {
    const fail = (status) => async () => ({
      ok: false,
      status,
      statusText: 'no',
      json: async () => ({ error: { message: 'nope' } }),
    });

    await assert.rejects(fetchStats({ token: 't', fetchImpl: fail(401) }), (err) => err.kind === 'auth');
    await assert.rejects(fetchStats({ token: 't', fetchImpl: fail(403) }), (err) => err.kind === 'quota');
  });
});

describe('StatsCache', () => {
  const value = { channel: { subscribers: 10 }, videos: [] };

  it('serves the cache inside the refresh floor', async () => {
    let calls = 0;
    const cache = new StatsCache({
      fetchStats: async () => {
        calls += 1;
        return value;
      },
    });

    await cache.get({ token: 't', now: 1000 });
    const again = await cache.get({ token: 't', now: 1000 + MIN_REFRESH_MS - 1 });

    assert.equal(calls, 1);
    assert.equal(again.cached, true);
  });

  it('refreshes once the floor has passed', async () => {
    let calls = 0;
    const cache = new StatsCache({
      fetchStats: async () => {
        calls += 1;
        return value;
      },
    });

    await cache.get({ token: 't', now: 1000 });
    await cache.get({ token: 't', now: 1000 + MIN_REFRESH_MS + 1 });

    assert.equal(calls, 2);
  });

  it('collapses concurrent callers into one request', async () => {
    // Two page loads a second apart must not become two sets of three API
    // calls.
    let calls = 0;
    const cache = new StatsCache({
      fetchStats: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return value;
      },
    });

    await Promise.all([cache.get({ token: 't' }), cache.get({ token: 't' }), cache.get({ token: 't' })]);

    assert.equal(calls, 1);
  });

  it('holds a failure for the same floor, so a quota error is not retried in a loop', async () => {
    let calls = 0;
    const cache = new StatsCache({
      fetchStats: async () => {
        calls += 1;
        throw Object.assign(new Error('quota'), { kind: 'quota' });
      },
    });

    const first = await cache.get({ token: 't', now: 1000 });
    const second = await cache.get({ token: 't', now: 2000 });

    assert.equal(calls, 1);
    assert.equal(first.error.kind, 'quota');
    assert.equal(second.error.kind, 'quota');
  });

  it('keeps showing the last good numbers when a refresh fails', async () => {
    let fail = false;
    const cache = new StatsCache({
      fetchStats: async () => {
        if (fail) throw Object.assign(new Error('down'), { kind: 'http' });
        return value;
      },
    });

    await cache.get({ token: 't', now: 1000 });
    fail = true;
    const after = await cache.get({ token: 't', now: 1000 + MIN_REFRESH_MS + 1 });

    // Stale numbers with an error beside them beat an empty dashboard.
    assert.equal(after.channel.subscribers, 10);
    assert.equal(after.error.kind, 'http');
    assert.equal(after.cached, true);
  });
});

describe('fetchVideoStats', () => {
  it('asks in fifties, because fifty ids cost the same one unit as one', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const batches = idBatches(ids);
    assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  });

  it('never asks about the same id twice, or about nothing', () => {
    assert.deepEqual(idBatches(['a', 'a', null, 'b', undefined, '']), [['a', 'b']]);
    assert.deepEqual(idBatches([]), []);
  });

  it('names the ids that came back with nothing to say', async () => {
    // A deleted or private video is simply absent from the reply, and a
    // caller that did not notice would quietly treat it as zero views.
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ items: [{ id: 'kept', snippet: { title: 't' }, statistics: { viewCount: '7' } }] }),
    });
    const { videos, missing } = await fetchVideoStats({ ids: ['kept', 'gone'], token: 't', fetchImpl });
    assert.equal(videos.length, 1);
    assert.equal(videos[0].views, 7);
    assert.deepEqual(missing, ['gone']);
  });

  it('spends nothing when there is nothing to ask about', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ items: [] }) }; };
    const { videos, missing } = await fetchVideoStats({ ids: [], token: 't', fetchImpl });
    assert.equal(calls, 0, 'an empty list must not cost a quota unit');
    assert.deepEqual(videos, []);
    assert.deepEqual(missing, []);
  });
});

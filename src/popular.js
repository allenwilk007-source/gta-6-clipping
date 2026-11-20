// Clips an audience already voted for.
//
// The live side of this tool guesses: chat spiked, so something probably
// happened. It is often right and it is sometimes wrong, and when it is wrong
// you get a short of somebody walking across a room quietly. There is a second
// source with none of that doubt — the clips people have already watched.
//
// Helix sorts /clips by view count, so the first page of a wide window IS the
// most-watched of that window. A clip from last week that forty thousand people
// chose to watch is a better bet than anything the detector found ten minutes
// ago, and it needs no guessing at all. Recency is what this source trades away
// on purpose.
//
// What it cannot do: a clip can only be cut if its VOD is still up. Twitch
// keeps those 14-60 days depending on the channel, so a clip whose video_id is
// gone is dropped rather than half-used. We cut from the VOD like everywhere
// else in this repo, through the official API.

const DEFAULT_CLIP_SECONDS = 30;

// Number(null) is 0, not NaN. A clip with no vod_offset would have passed a
// plain isFinite check as "offset 0" and been cut from the first seconds of
// the VOD — a stream's opening screen, which is exactly the kind of short with
// nothing in it that this source exists to avoid.
const offsetOf = (value) => (value === null || value === undefined || value === '' ? NaN : Number(value));

/** Seconds into the VOD where the reaction is, not where the clip starts. */
const reactionAt = (clip) => {
  const start = offsetOf(clip.vod_offset);
  if (!Number.isFinite(start)) return null;
  const length = Number(clip.duration) > 0 ? Number(clip.duration) : DEFAULT_CLIP_SECONDS;
  return Math.round(start + length);
};

/**
 * One moment per clip, best first, with the near-duplicates folded together.
 *
 * Twitch gives several clips of one good moment, each a few seconds apart and
 * each with its own view count. Posting all of them would post the same thing
 * four times, so clips from one broadcaster landing within `nearSeconds` of
 * each other are treated as one moment, keeping the most-watched of them and
 * adding up what the rest were worth.
 */
export function popularMoments(clips, { minViews = 200, nearSeconds = 45, limit = 50, game = null } = {}) {
  const usable = (clips || [])
    .filter((c) => c && c.video_id && Number.isFinite(offsetOf(c.vod_offset)))
    .filter((c) => Number(c.view_count) >= minViews)
    .sort((a, b) => Number(b.view_count) - Number(a.view_count));

  const kept = [];
  for (const clip of usable) {
    const at = reactionAt(clip);
    const near = kept.find(
      (k) => k.broadcasterId === (clip.broadcaster_id || null) && Math.abs(k.reactionOffsetSeconds - at) <= nearSeconds,
    );
    if (near) {
      // Already have this moment from a more-watched clip. Count the views
      // towards it: two clips of one thing is a stronger signal, not a weaker.
      near.alsoClipped += 1;
      near.views += Number(clip.view_count) || 0;
      continue;
    }
    kept.push({
      id: `popular:${clip.id}`,
      source: 'popular',
      broadcaster: clip.broadcaster_name || 'unknown',
      broadcasterId: clip.broadcaster_id || null,
      vodId: clip.video_id,
      gameId: clip.game_id || null,
      game: game || null,
      // A clip title is written by whoever clipped it, which is a person
      // saying what happens — the best title source this repo has.
      title: clip.title || null,
      clipId: clip.id,
      clipUrl: clip.url || null,
      thumbnail: clip.thumbnail_url || null,
      createdAt: clip.created_at || null,
      views: Number(clip.view_count) || 0,
      alsoClipped: 1,
      offsetSeconds: Math.round(offsetOf(clip.vod_offset)),
      reactionOffsetSeconds: at,
      durationSeconds: Number(clip.duration) > 0 ? Number(clip.duration) : DEFAULT_CLIP_SECONDS,
    });
  }

  return kept.slice(0, limit);
}

/**
 * How old a popular clip is, in days — shown rather than hidden, because the
 * one thing a viewer might notice about this source is that it is not live.
 */
export const ageInDays = (moment, now = Date.now()) => {
  const at = Date.parse(moment?.createdAt || '');
  return Number.isFinite(at) ? Math.max(0, (now - at) / 86_400_000) : null;
};

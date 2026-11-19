// Turning a cut into something you could post.
//
// A 9:16 frame with a title, word-timed subtitles and a credit burned in,
// loudness evened out, optional background music, and files beside it holding
// the post copy. Posting is a click away in the panel, but it is your click:
// nothing here uploads anything on its own.
//
// All on-screen text goes through ONE subtitle file rendered by libass, rather
// than ffmpeg's drawtext. Measured on this machine: drawtext cannot fall back
// from one font to another, so a title with an emoji in it either loses the
// emoji or loses the letters; libass falls back to Segoe UI Emoji on its own,
// and draws the per-word highlight the subtitles need. Neither renderer draws
// colour emoji — they come out as clean white outlines — so the post copy,
// which TikTok and Instagram render themselves, is where the colour ones go.
//
// Most of what is here is about text, because text is where this goes wrong
// quietly:
//
//   * a Windows path starts with a drive letter, and the colon in "C:" is the
//     option separator in a filtergraph. Every path goes through one tested
//     escaping function.
//   * `{` and `\` mean something to libass. Anything a streamer said or a
//     clipper typed is escaped before it reaches the subtitle file.
//   * a font has no glyph for most non-Latin scripts, and the result is a row
//     of empty boxes in the most prominent part of the frame.
//   * streamers swear, and say worse. Slurs are always masked; ordinary
//     swearing is masked unless SHORTS_CENSOR=off.

import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { GAME_HASHTAGS, GAME_TAGS, config } from './config.js';
import { formatClipTimestamp, run, splitCommand, verticalFilter } from './clip.js';
import { validateShort } from './validate.js';

const env = process.env;

// Two looks:
//
//   reel  the format clippers post most: solid black, the whole frame across
//         the middle, white text sitting right on top of the picture.
//   blur  a zoomed, blurred copy fills the canvas behind the frame, with an
//         outlined title in the band above.
//
// Neither crops: in GTA and Fortnite the thing worth clipping is as often at
// the edge of frame as in the middle.
export const shortformConfig = () => {
  const style = env.SHORTS_STYLE === 'blur' ? 'blur' : 'reel';
  const windows = process.platform === 'win32';
  const volume = Number(env.SHORTS_MUSIC_VOLUME);
  return {
    style,
    // libass picks fonts by family name, from this folder plus the system's.
    fontName:
      env.SHORTS_FONT_NAME || (windows ? (style === 'blur' ? 'Segoe UI Black' : 'Segoe UI') : 'DejaVu Sans'),
    fontsDir: env.SHORTS_FONTS_DIR || (windows ? 'C:/Windows/Fonts' : '/usr/share/fonts'),
    // Set: these tags for every game. Unset: the tags for the clip's game.
    hashtags: env.SHORTS_HASHTAGS?.trim() || null,
    // Short-form platforms normalise loudness on their side; delivering near
    // their target means the clip is not turned down, or up into the noise.
    loudness: Number(env.SHORTS_LUFS) || -14,
    censor: env.SHORTS_CENSOR !== 'off',
    subtitles: env.SHORTS_SUBTITLES !== 'off',
    // The streamer's camera on top, when a webcam can be found in the clip.
    facecam: env.SHORTS_FACECAM !== 'off',
    speechModel: env.SUBTITLES_MODEL || 'base.en',
    python: env.PYTHON_CMD || 'python',
    musicDir: resolve(config.root, env.SHORTS_MUSIC_DIR || 'music'),
    // Under the voice, not over it: about -18 dB, and pushed down further by
    // ducking whenever someone talks.
    musicVolume: Number.isFinite(volume) && volume > 0 ? Math.min(volume, 1) : 0.12,
  };
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Latin letters with their accents, digits, ordinary punctuation and emoji.
// Anything else would print as empty boxes.
const UNDRAWABLE = /[^\p{Script=Latin}\p{N}\s.,!?'"&:;()\-–—…%$#@+/\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * A title made fit to print over video.
 *
 * Twitch stream titles are mostly furniture — "GTA 6 DAY 1 | !merch !discord
 * [DROPS ON]" — so the first `|` segment is kept and the furniture goes. Clip
 * titles are usually written by the clipper and survive this untouched.
 * Returns '' when nothing worth printing is left, so the caller can fall back.
 */
export function cleanCaption(raw) {
  const text = String(raw ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)![\w-]+/g, ' ')
    .replace(/[[(【][^\])】]{0,40}[\])】]/g, ' ')
    .replace(/(^|\s)#\w+/g, ' ');

  const first = text
    .split(/\s*(?:\||•|\/\/|~)\s*/)
    .map((part) =>
      part
        .replace(UNDRAWABLE, ' ')
        .split(/\s+/)
        // Stripping undrawable characters can strand the punctuation around
        // them ("%{pts}" leaves a bare "%"). A token with nothing readable left
        // in it is debris, unless it is the "!!!" or "???" itself.
        .filter((token) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(token) || /^[!?…]+$/.test(token))
        .join(' ')
        .trim(),
    )
    .find((part) => part.length > 0);

  const cleaned = (first || '').replace(/^[\s,.;:\-–—]+|[\s,;:\-–—]+$/g, '');
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, '').length;
  return letters >= 3 ? cleaned : '';
}

// Always masked, whatever SHORTS_CENSOR says.
const SLURS = [
  /\bn+[i1!]+gg+(?:a|ah|as|az|er|ers|uh)?\b/gi,
  /\bf+[a@]+gg*(?:ot|ots|s)?\b/gi,
  /\bretard(?:ed|s)?\b/gi,
];
// Masked by default, because burned-in swearing gets a short shown to fewer
// people on both platforms.
const SWEARS = /\b(?:fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*)\b/gi;

export function censor(text, { mild = true } = {}) {
  let out = String(text ?? '');
  for (const slur of SLURS) out = out.replace(slur, (word) => '*'.repeat(word.length));
  if (mild) out = out.replace(SWEARS, (word) => word[0] + '*'.repeat(word.length - 1));
  return out;
}

/**
 * Greedy word wrap into at most `maxLines` lines of `maxChars`.
 * Counted in characters a person sees, so an emoji is one, not two.
 */
export function wrapCaption(text, { maxChars = 16, maxLines = 3 } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const len = (s) => Array.from(s).length;

  for (const original of words) {
    let word = Array.from(original);
    // A single word longer than a line is split rather than allowed to overflow.
    while (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, maxChars).join(''));
      word = word.slice(maxChars);
    }
    const piece = word.join('');
    if (!piece) continue;
    if (!line) line = piece;
    else if (len(line) + 1 + len(piece) <= maxChars) line = `${line} ${piece}`;
    else {
      lines.push(line);
      line = piece;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = Array.from(kept[maxLines - 1]);
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}…`;
  return kept;
}

/**
 * What chat was doing, said the way a caption would say it, with the emoji that
 * goes with it. A hook is only used when that class actually spiked, and there
 * are several per class so a busy hour does not post the same words twice.
 */
export const REACTIONS = {
  clipit: { emoji: ['🎬', '👀'], hooks: ['Chat said clip it', 'Chat begged for this clip', '{name} gave chat a clip'] },
  funny: {
    emoji: ['😂', '💀', '🤣'],
    hooks: ['Chat lost it', "{name}'s chat could not breathe", 'This had chat crying', '{name} broke chat'],
  },
  shock: { emoji: ['😳', '😱', '🤯'], hooks: ['Wait what', 'Chat could not believe it', '{name} was not ready for that'] },
  hype: { emoji: ['🔥', '😤', '🙌'], hooks: ["Let's go", '{name} went crazy', 'Chat went wild'] },
  tension: { emoji: ['😬', '😰'], hooks: ['Oh no', 'This got tense', 'Chat was holding its breath'] },
};
const NEUTRAL = { emoji: ['👀', '🔥'], hooks: ['{name} in {game}', 'Wait for it', 'Watch what {name} does'] };

/** The reaction class that spiked hardest, or null if none clearly did. */
export function dominantReaction(chat, { minZ = 2 } = {}) {
  let best = null;
  for (const [name, stats] of Object.entries(chat?.classes || {})) {
    const z = Number(stats?.z);
    if (!Number.isFinite(z) || z < minZ || !REACTIONS[name]) continue;
    if (!best || z > best.z) best = { name, z };
  }
  return best?.name || null;
}

/** A small stable hash, so one moment always gets the same picks. */
export function hashOf(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Speech as sentences, split on end punctuation or a pause. */
export function sentencesFrom(words, { maxGap = 0.7 } = {}) {
  const sentences = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    sentences.push({
      text: current.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim(),
      start: current[0].start,
      end: current.at(-1).end,
    });
    current = [];
  };
  for (const raw of words || []) {
    const word = String(raw?.word || '').trim();
    if (!word || !Number.isFinite(raw.start) || !Number.isFinite(raw.end)) continue;
    if (current.length && raw.start - current.at(-1).end > maxGap) flush();
    current.push({ word, start: raw.start, end: raw.end });
    if (/[.!?]["')\]]*$/.test(word)) flush();
  }
  flush();
  return sentences;
}

const FILLER = /^(?:(?:uh+|um+|uhm|erm|like|so|and|but|okay|ok|yeah|oh|well|i mean),?\s+)+/i;
// Words that say nothing about what happened on their own.
const EMPTY_WORDS = new Set(
  'yeah yes no ok okay oh uh um what bro dude guys chat so like the a an and but i it is that this just right huh wow hmm man dog lol oh my god yo'.split(
    ' ',
  ),
);

/**
 * The line the streamer said that best says what happened.
 *
 * Streamers narrate: "he just stole the cop car", "I'm actually done". The
 * line nearest to just before the reaction is usually that narration, so it is
 * preferred, with a nudge for lines that end in "!" or "?" and for lines short
 * enough to read in a glance. A line of nothing but filler is never chosen.
 */
export function pickQuote(words, { reactionAt = 25, mild = true } = {}) {
  let best = null;
  for (const sentence of sentencesFrom(words)) {
    if (sentence.end < reactionAt - 14 || sentence.start > reactionAt + 4) continue;
    const text = sentence.text.replace(FILLER, '').replace(/[.,;:]+$/, '').trim();
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 12) continue;
    const meaningful = tokens.filter((t) => !EMPTY_WORDS.has(t.toLowerCase().replace(/[^a-z']/g, ''))).length;
    if (meaningful < 2) continue;

    const middle = (sentence.start + sentence.end) / 2;
    let score = 1 - Math.min(1, Math.abs(middle - (reactionAt - 2)) / 16);
    if (/[!?]$/.test(text)) score += 0.4;
    if (tokens.length >= 3 && tokens.length <= 8) score += 0.2;
    if (!best || score > best.score) best = { text, score };
  }
  if (!best) return null;
  const text = censor(best.text, { mild });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A clip "title" that is really the stream title Twitch filled in by default.
const STREAM_TITLE = /[|[\]]|(^|\s)!\w|\bday\s*\d+\b|24\/7|\bsubathon\b|\bstream\b|\bdrops\b/i;

// What a clipping bot calls a clip when it has nothing to say: "AutoClipper
// Highlight", "ohnePixel clip 4", "Best Moments". A title made of nothing but
// these words, the streamer's name and digits says nothing about the moment,
// so it must not outrank the wording this tool writes itself. Kept narrow on
// purpose: every word here is one a person would rarely use alone, and a
// single ordinary word in the title ("Lucia", "ladder", "cops") saves it.
const BOT_WORDS = new Set(
  `autoclipper autoclip autoclips autoclipped clipper clippers clip clips clipped clipping
   highlight highlights moment moments best funny epic insane crazy wild
   stream streams streamer live vod vods twitch kick youtube short shorts
   gameplay playing play new untitled unnamed part video videos clipit
   daily random today yesterday here this that it by of the a an and on in to`.split(/\s+/),
);

/**
 * True when a clip title is boilerplate rather than something written about
 * this moment. Digits and the streamer's own name count as filler: "ohnePixel
 * Highlight 12" is the bot's numbering, not a description.
 */
export function isBoilerplateTitle(text, broadcaster = '') {
  const name = String(broadcaster).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return true;
  return words.every((word) => BOT_WORDS.has(word) || /^\d+$/.test(word) || (name && word === name));
}

const sameTitle = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The title for a moment: about what happened in it, with an emoji.
 *
 * In order of how well each says what happened:
 *   1. a clip title a person wrote about this exact moment
 *   2. the line the streamer said as it happened (needs the transcript)
 *   3. what chat did, from the reaction class that spiked
 * Anything in `avoid` (recent titles) is skipped, so a run of moments on the
 * same channel does not produce the same title twice.
 */
export function titleFor(
  moment,
  { words = null, reactionAt = 25, avoid = [], game = moment?.game || config.gameName, mild = true } = {},
) {
  const taken = new Set([...avoid].map(sameTitle));
  const reaction = REACTIONS[dominantReaction(moment?.chat)] || NEUTRAL;
  const seed = hashOf(moment?.id || moment?.title || moment?.broadcaster || '');
  const emojiAt = (i) => reaction.emoji[(seed + i) % reaction.emoji.length];
  const withEmoji = (text, i = 0) => (EMOJI.test(text) ? text : `${text} ${emojiAt(i)}`);
  const name = cleanCaption(moment?.broadcaster) || 'They';
  const raw = String(moment?.title || '');

  const candidates = [];
  if (moment?.source !== 'chat' && !STREAM_TITLE.test(raw) && !isBoilerplateTitle(raw, moment?.broadcaster)) {
    const clipTitle = cleanCaption(raw);
    if (clipTitle) candidates.push(withEmoji(censor(clipTitle, { mild })));
  }
  const quote = words?.length ? pickQuote(words, { reactionAt, mild }) : null;
  if (quote) candidates.push(withEmoji(`"${quote}"`));
  reaction.hooks.forEach((_, i) => {
    const hook = reaction.hooks[(seed + i) % reaction.hooks.length]
      .replace('{name}', name)
      .replace('{game}', game || 'this');
    candidates.push(`${hook} ${emojiAt(i)}`);
  });
  // Last resorts, still distinct from each other.
  reaction.hooks.forEach((hook, i) => {
    candidates.push(`${name}: ${hook.replace('{name}', 'chat').replace('{game}', game || 'this')} ${emojiAt(i + 1)}`);
  });

  return candidates.find((candidate) => !taken.has(sameTitle(candidate))) || candidates[0];
}

/** The title before there is a transcript (what the queue shows meanwhile). */
export const captionFor = (moment, options = {}) => titleFor(moment, { ...options, words: null });

/** The on-screen credit. Empty when the name has nothing the font can draw. */
export function creditFor(moment) {
  const name = String(moment?.broadcaster || '')
    .replace(UNDRAWABLE, '')
    .replace(EMOJI, '')
    .trim();
  return name ? `@${name} on Twitch` : '';
}

/** Twitch's `?t=` format: 1h02m03s. */
export function twitchTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
}

/** Tags for a clip: the configured override, else the clip's own game's. */
export function hashtagsFor(moment, { hashtags = null } = {}) {
  const base = hashtags || GAME_HASHTAGS[String(moment?.game || '').toLowerCase()] || '#gaming #twitch';
  const login = String(moment?.broadcaster || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return [base, login ? `#${login}` : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// What the clip is about, and each platform's post
// ---------------------------------------------------------------------------

/**
 * What a moment is about, as a sentence a scrolling viewer can read — what
 * happened, not a line of dialogue.
 *
 * Nothing here watches the video, so it says only what is known: a clip
 * title a person wrote about this moment is used as it stands (that is
 * someone saying what happens); otherwise who, in which game, and what chat
 * did, from the reaction class that spiked. Each class has several, and
 * anything in `avoid` is skipped, so a busy hour does not repeat itself.
 */
const ABOUT = {
  clipit: ["The {game} moment {name}'s chat had to clip", "{name}'s chat would not stop spamming clip it in {game}"],
  funny: ['{name} has chat in tears in {game}', "{name}'s {game} stream turns into a comedy", 'Chat cannot stop laughing at {name} in {game}'],
  shock: ['{name} did not see this coming in {game}', "Nobody was ready for this on {name}'s {game} stream", "Chat can't believe what happened to {name} in {game}"],
  hype: ['Chat goes wild for {name} in {game}', '{name} gets chat hyped in {game}', '{name} sets chat off in {game}'],
  tension: ['Things get tense for {name} in {game}', 'Chat holds its breath with {name} in {game}'],
  // No clear reaction: what is known is that chat spiked here, so say that.
  neutral: ["The {game} moment {name}'s chat jumped on", "{name}'s chat spiked at this {game} moment", "What set off {name}'s chat in {game}"],
};

const gameInfo = (game) => GAME_TAGS[String(game || '').toLowerCase()] || null;

/** The game as a title says it ("GTA 6"), or null when it is not known. */
export function gameLabel(game) {
  const info = gameInfo(game);
  if (info) return info.short;
  const text = cleanCaption(game);
  return text || null;
}

function fill(template, name, game) {
  let text = template.replace(/\{name\}/g, name);
  // No game known: say nothing about one rather than guess.
  text = game
    ? text.replace(/\{game\}/g, game)
    : text.replace(/ in \{game\}/g, '').replace(/\{game\} /g, '').replace(/\{game\}/g, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A clip title a person wrote about this moment, cleaned up, or null. */
export function writtenTitle(moment, { mild = true } = {}) {
  const raw = String(moment?.title || '');
  if (moment?.source === 'chat' || !raw || STREAM_TITLE.test(raw)) return null;
  if (isBoilerplateTitle(raw, moment?.broadcaster)) return null;
  const written = cleanCaption(raw)
    .replace(new RegExp(EMOJI.source, 'gu'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (written.split(/\s+/).length < 2) return null;
  const text = censor(written, { mild });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describe(moment, { avoid = [], mild = true, reaction: given } = {}) {
  const taken = new Set([...avoid].map(sameTitle));
  const written = writtenTitle(moment, { mild });
  if (written && !taken.has(sameTitle(written))) return written;
  // Post copy, not drawn on the video: the name as it is, underscores and all.
  const name = String(moment?.broadcaster || '').replace(/\s+/g, ' ').trim() || 'This streamer';
  const game = gameLabel(moment?.game);
  const reaction = given || dominantReaction(moment?.chat) || 'neutral';
  const templates = ABOUT[reaction] || ABOUT.neutral;
  const seed = hashOf(moment?.id || moment?.broadcaster || '');
  const options = templates.map((_, i) => fill(templates[(seed + i) % templates.length], name, game));
  return options.find((text) => !taken.has(sameTitle(text))) || options[0];
}

const hookPattern = (hook) =>
  new RegExp(
    `^(?:.+: )?${hook
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{name\}/g, '.+')
      .replace(/\{game\}/g, '.+')}$`,
    'i',
  );

/**
 * Which reaction a finished title came from, for shorts made before
 * descriptions: from one of the reaction hooks it was built from, else its
 * emoji. 👀 and 🔥 are also the neutral pair, so on their own they say nothing.
 */
export function reactionFromEmoji(caption) {
  const text = String(caption || '')
    .replace(new RegExp(EMOJI.source, 'gu'), '')
    .replace(/[\u200d\ufe0f]/g, '')
    .trim();
  for (const [name, { hooks }] of Object.entries(REACTIONS)) {
    if (hooks.some((hook) => hookPattern(hook.replace('{name}', 'chat')).test(text) || hookPattern(hook).test(text))) return name;
  }
  const emoji = [...String(caption || '')].filter((c) => EMOJI.test(c)).at(-1);
  if (!emoji || NEUTRAL.emoji.includes(emoji)) return null;
  return Object.keys(REACTIONS).find((name) => REACTIONS[name].emoji.includes(emoji)) || null;
}

/** The streamer's line inside a title like `"Put that down" 😂`, or null. */
export const quoteIn = (caption) => /^"(.+)"/.exec(String(caption || '').trim())?.[1] || null;

const creatorTag = (moment) => {
  const login = String(moment?.broadcaster || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return login ? `#${login}` : '';
};

/** Cut at a word boundary to fit, with an ellipsis when anything was cut. */
export function fitText(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const room = clean.slice(0, Math.max(0, max - 1));
  const space = room.lastIndexOf(' ');
  return `${(space > max * 0.5 ? room.slice(0, space) : room).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

const SMALL = new Set('a an and as at but by for in of on or the to vs with'.split(' '));

/** Title Case for a YouTube title, leaving words already capitalised alone (GTA). */
export function titleCase(text) {
  const words = String(text || '').split(' ');
  return words
    .map((word, i) => {
      if (!/^[a-z]/.test(word)) return word;
      // Small words stay small, except first and last.
      if (i > 0 && i < words.length - 1 && SMALL.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// YouTube cuts a title at 100 characters, silently. Counted in UTF-16 units,
// which is never fewer than YouTube's own count, so it never overflows.
export const YOUTUBE_TITLE_MAX = 100;
export const TIKTOK_HOOK_MAX = 80;
export const INSTAGRAM_HOOK_MAX = 125;

/**
 * The YouTube title: what happens, Title Case, then #Shorts and the game's
 * tag, all inside 100 characters. The creator's tag goes in only if it fits;
 * the description is shortened before #Shorts is ever dropped.
 */
export function youtubeTitle(about, moment) {
  const gameTag = gameInfo(moment?.game)?.youtube || '';
  const full = ['#Shorts', gameTag, creatorTag(moment)].filter(Boolean).join(' ');
  const short = ['#Shorts', gameTag].filter(Boolean).join(' ');
  const text = titleCase(
    String(about || '')
      .replace(new RegExp(EMOJI.source, 'gu'), '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  for (const tags of [full, short]) {
    if (text.length + 1 + tags.length <= YOUTUBE_TITLE_MAX) return `${text} ${tags}`;
  }
  return `${fitText(text, YOUTUBE_TITLE_MAX - short.length - 1)} ${short}`;
}

/**
 * Everything a post needs: the pieces, and each platform's version ready to
 * paste. Tags follow the clip's own game; with no readable game there is no
 * game tag at all. Credit and the stream link are attribution, said once.
 *
 * The three lead differently so they are not one sentence three times:
 * TikTok with the hook (the streamer's line when there is one), Instagram
 * with what happens and the line after it, YouTube with what happens.
 */
export function postPartsFor(
  moment,
  { caption, start, hashtags = null, about = null, quote = null, avoid = [], mild = true, reaction: given = null, link: knownLink = null } = {},
) {
  const who = String(moment?.broadcaster || '').trim();
  const vod = String(moment?.vodId || '').replace(/^v/, '');
  const title = caption || captionFor(moment);
  const line = quote ?? quoteIn(title);
  const what = about || describe(moment, { avoid, mild, reaction: given });
  // YouTube opens with a second wording, so its title is not the Instagram
  // line again — unless a person wrote what happens, which beats either.
  const written = writtenTitle(moment, { mild });
  const youtubeAbout = written && sameTitle(written) === sameTitle(what) ? what : describe(moment, { avoid: [...avoid, what], mild, reaction: given });
  const reaction = REACTIONS[dominantReaction(moment?.chat)] || null;
  const emoji = [...title].filter((c) => EMOJI.test(c)).at(-1) || reaction?.emoji[0] || '';

  // A configured override replaces the game's tags; the creator's is always added.
  const gameTags = hashtags ? hashtags.split(/\s+/).filter(Boolean) : gameInfo(moment?.game)?.tags || [];
  const creator = creatorTag(moment);
  const tagsFor = (...extra) => [...new Set([...gameTags, creator, ...extra].filter(Boolean))].join(' ');

  const tiktokHook = fitText(`${line ? `"${line}"` : what} ${emoji}`.trim().toLowerCase(), TIKTOK_HOOK_MAX);
  const instaHook = fitText(`${what}${line ? ` — "${line}"` : ''} ${emoji}`.trim(), INSTAGRAM_HOOK_MAX);
  const credit = who ? `Credit: ${who} on Twitch` : '';
  // A link worked out when the short was made is kept as it was. A short cut
  // from a live recording has no VOD to point into, so it links the channel:
  // TERMS.md promises a link back to the source with every clip.
  const channel = creatorTag(moment).slice(1);
  const link =
    knownLink ||
    (vod ? `https://www.twitch.tv/videos/${vod}?t=${twitchTime(start)}` : channel ? `https://www.twitch.tv/${channel}` : '');
  const linkLabel = /^https:\/\/www\.twitch\.tv\/[a-z0-9_]+$/i.test(link) ? 'Live on Twitch' : 'Full stream';

  return {
    caption: title,
    about: what,
    credit,
    link,
    linkLabel,
    tags: hashtagsFor(moment, { hashtags }),
    game: moment?.game || null,
    broadcaster: who || null,
    platforms: {
      // The credit goes in the caption too, not only on the video.
      tiktok: `${tiktokHook}${who ? ` (credit: ${who.toLowerCase()} on twitch)` : ''} ${tagsFor('#twitch', '#gaming')}`,
      instagram: [instaHook, credit, tagsFor('#gaming', '#twitch', '#reels')].filter(Boolean).join('\n'),
      youtube: [
        youtubeTitle(youtubeAbout, moment),
        '',
        line ? `"${line}"` : null,
        credit || null,
        link ? `${linkLabel}: ${link}` : null,
        '',
        tagsFor('#twitch', '#gaming', '#shorts'),
      ]
        .filter((l) => l !== null)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n'),
    },
  };
}

/**
 * The plain-text post copy written beside each short: one labelled block per
 * platform to copy from, then the credit and stream link once.
 */
export function postTextFor(moment, options = {}) {
  const parts = options.parts || postPartsFor(moment, options);
  return [
    'TIKTOK',
    parts.platforms.tiktok,
    '',
    'INSTAGRAM',
    parts.platforms.instagram
      .split('\n')
      .filter((l) => l !== parts.credit)
      .join('\n'),
    '',
    'YOUTUBE',
    parts.platforms.youtube.split('\n')[0],
    '',
    parts.credit || null,
    parts.link ? `${parts.linkLabel || 'Full stream'}: ${parts.link}` : null,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/**
 * Words grouped the way short-form subtitles are read: one to three at a
 * time, broken at a pause or the end of a sentence. Each chunk stays up until
 * the next one starts (or half a second after its last word), so the screen
 * does not flicker between words.
 */
export function subtitleChunks(words, { maxWords = 3, maxChars = 18, maxGap = 0.6, mild = true } = {}) {
  const chunks = [];
  let current = [];
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
  };
  for (const raw of words || []) {
    if (!Number.isFinite(raw?.start) || !Number.isFinite(raw?.end)) continue;
    const spoken = String(raw.word || '').trim();
    const text = censor(spoken.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}'!?]+$/gu, ''), { mild });
    if (!text) continue;
    const chars = current.reduce((n, w) => n + w.text.length + 1, 0);
    if (
      current.length &&
      (current.length >= maxWords || chars + text.length > maxChars || raw.start - current.at(-1).end > maxGap)
    ) {
      flush();
    }
    current.push({ text, start: raw.start, end: Math.max(raw.end, raw.start + 0.05) });
    if (/[.!?]$/.test(spoken)) flush();
  }
  flush();

  return chunks.map((chunk, i) => {
    const next = chunks[i + 1];
    const last = chunk.at(-1).end;
    const end = next ? Math.min(next[0].start, last + 0.5) : last + 0.5;
    return { words: chunk, start: chunk[0].start, end: Math.max(end, last) };
  });
}

/** H:MM:SS.cc, the only time format libass reads. */
export function assTime(seconds) {
  const cs = Math.max(0, Math.round(Number(seconds) * 100) || 0);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Text made inert for libass: `{` opens an override block and `\` a command. */
export const escapeAss = (text) =>
  String(text ?? '')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ');

/** Where the picture sits on the canvas, from the source's own shape. */
export function pictureBox({ width = 1080, height = 1920, sourceWidth = 1920, sourceHeight = 1080 } = {}) {
  const aspect = sourceWidth > 0 && sourceHeight > 0 ? sourceHeight / sourceWidth : 9 / 16;
  const pictureH = Math.min(height, Math.round((width * aspect) / 2) * 2);
  const pictureTop = Math.floor((height - pictureH) / 4) * 2;
  return { pictureH, pictureTop, pictureBottom: pictureTop + pictureH };
}

/**
 * Where each piece of text goes. The title sits directly on top of the picture
 * (reel) or centred in the band above it (blur). Subtitles go directly under
 * the picture, where they cover neither the game's HUD nor the platform's
 * description overlay at the very bottom; the credit goes under them.
 */
export function layoutFor({
  style = 'reel',
  width = 1080,
  height = 1920,
  sourceWidth,
  sourceHeight,
  subtitles = true,
  camH = 0,
} = {}) {
  if (camH > 0) return camLayout({ width, height, sourceWidth, sourceHeight, camH });
  const box = pictureBox({ width, height, sourceWidth, sourceHeight });
  const gap = Math.round(height * 0.025);
  const titleSize = Math.round(width * (style === 'blur' ? 0.07 : 0.062));
  const subSize = Math.round(width * 0.064);
  const creditSize = Math.round(width * 0.037);
  const subsTop = box.pictureBottom + gap;
  return {
    ...box,
    width,
    height,
    titleSize,
    subSize,
    creditSize,
    title: style === 'blur' ? { an: 5, y: Math.round(height * 0.17) } : { an: 2, y: box.pictureTop - gap },
    subs: { an: 8, y: subsTop },
    credit: { an: 8, y: subtitles ? subsTop + Math.round(subSize * 1.3) + gap : subsTop },
  };
}

/**
 * The webcam crop, reshaped for the top of the frame.
 *
 * Shown full width; its height follows the webcam's own shape within limits,
 * so a wide overlay is not stretched into a tall one. When the crop has to
 * lose height, more comes off the bottom than the top: the face is in the
 * upper part of a webcam and the desk is in the lower.
 */
export function fitCam(rect, { width = 1080, minH = 420, maxH = 600 } = {}) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  const natural = Math.round((width * rect.h) / rect.w / 2) * 2;
  const outH = Math.min(maxH, Math.max(minH, natural));
  const wanted = width / outH;
  let { x, y, w, h } = rect;
  if (w / h > wanted) {
    const narrower = h * wanted;
    x += (w - narrower) / 2;
    w = narrower;
  } else {
    const shorter = w / wanted;
    y += (h - shorter) * 0.35;
    h = shorter;
  }
  const even = (v) => Math.max(0, Math.floor(v / 2) * 2);
  return { x: even(x), y: even(y), w: Math.max(2, even(w)), h: Math.max(2, even(h)), outH };
}

/**
 * Camera on top: the streamer's webcam across the top, the game directly
 * under it, the title above both and the credit below. Subtitles sit on the
 * seam between the two, the classic place for them in this layout, and
 * the pair fills about 60% of the screen against about a third for the game
 * on its own — the reviewer's main complaint about the plain layout.
 */
export function camLayout({ width = 1080, height = 1920, sourceWidth, sourceHeight, camH }) {
  const { pictureH } = pictureBox({ width, height, sourceWidth, sourceHeight });
  const stackH = camH + pictureH;
  const gap = Math.round(height * 0.025);
  // Room for a two-line title above, clear of the platform's top bar.
  const camTop = Math.max(340, Math.floor((height - stackH) / 4) * 2 - 40);
  return {
    cam: true,
    width,
    height,
    camTop,
    camH,
    pictureTop: camTop + camH,
    pictureH,
    pictureBottom: camTop + stackH,
    titleSize: Math.round(width * 0.062),
    subSize: Math.round(width * 0.07),
    creditSize: Math.round(width * 0.037),
    subOutline: 6,
    titleLines: 2,
    title: { an: 2, y: camTop - gap },
    subs: { an: 5, y: camTop + camH },
    credit: { an: 8, y: camTop + stackH + gap },
  };
}

/** The one subtitle file holding every piece of on-screen text. */
export function buildAss({ layout, style = 'reel', titleLines = [], credit = '', chunks = [], fontName = 'Segoe UI' }) {
  const x = Math.round(layout.width / 2);
  const font = escapeAss(fontName).replace(/,/g, ' ');
  const titleOutline = style === 'blur' ? Math.round(layout.width * 0.0065) : 0;
  const creditColour = style === 'blur' ? '&H00FFFFFF' : '&H00BDBDBD';
  const creditOutline = style === 'blur' ? 3 : 0;
  const style_ = (name, size, colour, outline, align) =>
    `Style: ${name},${font},${size},${colour},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,${align},40,40,0,1`;
  const at = (an, y) => `{\\an${an}\\pos(${x},${y})}`;
  const forever = '9:59:59.00';

  const events = [];
  if (titleLines.length) {
    events.push(
      `Dialogue: 2,0:00:00.00,${forever},Title,,0,0,0,,${at(layout.title.an, layout.title.y)}${titleLines.map(escapeAss).join('\\N')}`,
    );
  }
  if (credit) {
    events.push(`Dialogue: 2,0:00:00.00,${forever},Credit,,0,0,0,,${at(layout.credit.an, layout.credit.y)}${escapeAss(credit)}`);
  }
  // One event per spoken word: the whole chunk, with the word being said in
  // yellow. The highlight is what makes subtitles readable at a glance.
  for (const chunk of chunks) {
    chunk.words.forEach((word, i) => {
      const start = i === 0 ? chunk.start : word.start;
      const next = chunk.words[i + 1];
      const end = Math.max(next ? next.start : chunk.end, start + 0.05);
      const text = chunk.words
        .map((w, j) => (j === i ? `{\\c&H00FFFF&}${escapeAss(w.text)}{\\c&HFFFFFF&}` : escapeAss(w.text)))
        .join(' ');
      events.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Sub,,0,0,0,,${at(layout.subs.an, layout.subs.y)}${text}`);
    });
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${layout.width}`,
    `PlayResY: ${layout.height}`,
    // We wrap the title ourselves; libass must not re-wrap it.
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style_('Title', layout.titleSize, '&H00FFFFFF', titleOutline, 2),
    style_('Sub', layout.subSize, '&H00FFFFFF', layout.subOutline ?? 5, 8),
    style_('Credit', layout.creditSize, creditColour, creditOutline, 8),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

export const AUDIO_FILE = /\.(?:mp3|m4a|aac|wav|ogg|opus|flac)$/i;

/** Tracks in the music folder, in a stable order. */
export async function listTracks(dir) {
  try {
    return (await readdir(dir))
      .filter((name) => AUDIO_FILE.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Where in a track to start, so the same song does not always open the same
 * way. Stays clear of the last couple of seconds, so the bed never runs out
 * before the clip does.
 */
export function trackStart(seed, trackSeconds, clipSeconds) {
  const room = Math.floor((Number(trackSeconds) || 0) - (Number(clipSeconds) || 0) - 2);
  return room > 0 ? seed % room : 0;
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * A path made safe to sit inside a filtergraph option value.
 *
 * Two layers of escaping apply, and both are needed: the option parser splits
 * on `:` (so the drive letter in `C:/...` has to become `C\:`), and the graph
 * parser then treats `\ ' [ ] , ;` as its own syntax (so that backslash has
 * to be escaped again). Backslash separators become forward slashes first,
 * which ffmpeg accepts on Windows and which removes most of the problem.
 */
export function escapeFilterPath(path) {
  const forward = String(path).replace(/\\/g, '/');
  const option = forward.replace(/[\\':]/g, '\\$&');
  return option.replace(/[\\'[\],;]/g, '\\$&');
}

/**
 * The full argument list for one short. Pure, so the graph can be tested.
 * `music` is {path, start, volume} or null.
 */
export function shortformArgs({
  input,
  output,
  assPath,
  fontsDir,
  hasAudio = true,
  width = 1080,
  height = 1920,
  loudness = -14,
  style = 'reel',
  sourceWidth = 1920,
  sourceHeight = 1080,
  duration = 30,
  music = null,
  cam = null,
  trim = null,
}) {
  const box = pictureBox({ width, height, sourceWidth, sourceHeight });
  const text = `subtitles=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}`;
  let chains;
  if (cam) {
    const layout = camLayout({ width, height, sourceWidth, sourceHeight, camH: cam.outH });
    chains = [
      '[0:v]split=2[c][g]',
      `[c]crop=${cam.w}:${cam.h}:${cam.x}:${cam.y},scale=${width}:${cam.outH},setsar=1[cam]`,
      `[g]scale=${width}:${box.pictureH},setsar=1[game]`,
      `[cam][game]vstack=inputs=2,pad=${width}:${height}:0:${layout.camTop}:color=black,${text}[v]`,
    ];
  } else {
    const base =
      style === 'blur'
        ? verticalFilter({ width, height })
        : `scale=${width}:${box.pictureH},pad=${width}:${height}:0:${box.pictureTop}:color=black,setsar=1`;
    chains = [`[0:v]${base},${text}[v]`];
  }
  // A redo renders a window of a wider cut: seek and limit the input itself.
  const inputs = trim
    ? ['-ss', String(trim.start), '-t', String(trim.duration), '-i', input]
    : ['-i', input];
  const finish = `loudnorm=I=${loudness}:TP=-1.5:LRA=11,aresample=48000`;

  if (hasAudio && music) {
    // Looped, so a track shorter than the clip still covers it.
    inputs.push('-stream_loop', '-1', '-ss', String(Math.max(0, Math.floor(music.start || 0))), '-i', music.path);
    const fadeOut = Math.max(0, duration - 1.5).toFixed(2);
    chains.push(
      '[0:a]aresample=48000,asplit=2[voice][key]',
      `[1:a]aresample=48000,volume=${music.volume},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5[bed]`,
      // Ducking: the music drops further whenever the streamer talks.
      '[bed][key]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400[ducked]',
      `[voice][ducked]amix=inputs=2:duration=first:normalize=0,${finish}[a]`,
    );
  } else if (hasAudio) {
    // loudnorm works internally at 192 kHz and hands that rate on unless told
    // otherwise, which some players and upload pipelines reject outright.
    chains.push(`[0:a]${finish}[a]`);
  }

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[v]',
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-shortest',
    output,
  ];
}

/** Audio, picture size and length, in one probe. */
export async function probe(input) {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', input],
      { cwd: config.root, label: 'ffprobe' },
    );
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    const video = streams.find((stream) => stream.codec_type === 'video') || {};
    return {
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      width: Number(video.width) || 1920,
      height: Number(video.height) || 1080,
      duration: Number(data.format?.duration) || 30,
    };
  } catch {
    // Let ffmpeg give the real error if the file is unreadable.
    return { hasAudio: true, width: 1920, height: 1080, duration: 30 };
  }
}

// The English-only model does not refuse other languages: it invents
// plausible English, quietly. Measured mean word confidence on live streams:
// five English streamers 0.70 to 0.82; Spanish 0.50 ("I don't know what to
// say, is that real?" — not what was said), German 0.45, another 0.26 over
// 79 invented words. 0.6 sits in the clean gap between them.
export const MIN_SPEECH_CONFIDENCE = 0.6;

/**
 * Whether a transcript is the streamer's words or the model's guess. Below the
 * line, a short keeps its hook title but gets no subtitles and no quote:
 * nothing beats burning a confident mistranslation into someone's clip.
 */
export function transcriptUsable(words) {
  const scored = (words || []).filter((w) => Number.isFinite(w?.probability));
  if (!scored.length) return { usable: Boolean(words?.length), confidence: null };
  const confidence = scored.reduce((n, w) => n + w.probability, 0) / scored.length;
  return { usable: confidence >= MIN_SPEECH_CONFIDENCE, confidence };
}

/** Timed words from src/transcribe.py, or a thrown, readable reason why not. */
export async function transcribe(input, { python = 'python', speechModel = 'base.en' } = {}) {
  const { file, prefix } = splitCommand(python);
  const { stdout } = await run(file, [...prefix, join(config.root, 'src', 'transcribe.py'), input, speechModel], {
    cwd: config.root,
    label: 'transcribe',
  });
  const last = stdout.trim().split(/\r?\n/).pop() || '{}';
  const data = JSON.parse(last);
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * The webcam's rectangle in the cut, from src/facecam.py, or null when there
 * is none (or no way to tell — then the plain layout is the safe choice).
 */
export async function detectFacecam(input, { python = 'python' } = {}) {
  const { file, prefix } = splitCommand(python);
  const { stdout } = await run(file, [...prefix, join(config.root, 'src', 'facecam.py'), input], {
    cwd: config.root,
    label: 'facecam',
  });
  const data = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
  return data.found ? { x: data.x, y: data.y, w: data.w, h: data.h } : null;
}

/**
 * What was said in a cut, already judged: words if the transcript is the
 * streamer's, null with a reason if it is missing or a guess.
 */
export async function speechIn(input, settings = shortformConfig()) {
  if (!settings.subtitles) return { words: null, speechError: null };
  let words;
  try {
    words = (await transcribe(input, settings)).words || [];
  } catch (err) {
    return { words: null, speechError: String(err.message).split(/\r?\n/)[0] };
  }
  const check = transcriptUsable(words);
  if (words.length && !check.usable) {
    return {
      words: null,
      speechError: `speech too unclear to subtitle (confidence ${check.confidence.toFixed(2)}, probably not English)`,
    };
  }
  return { words, speechError: null };
}

async function chooseTrack(settings, seed, clipSeconds) {
  const tracks = await listTracks(settings.musicDir);
  if (!tracks.length) return null;
  const path = tracks[seed % tracks.length];
  const length = (await probe(path)).duration;
  return { path, start: trackStart(seed, length, clipSeconds), volume: settings.musicVolume };
}

// rename is atomic on one volume. AUTOCLIP_DIR may point at another drive
// (a synced folder, say), where rename refuses and a copy has to do.
async function moveInto(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/**
 * Render a short from a landscape cut, and write its post copy beside it.
 *
 * `reactionAt` is how many seconds into the cut people reacted; the title's
 * quote is looked for just before it. `avoid` is recent titles not to repeat.
 * Returns {path, textPath, caption, words, speechError, track}.
 */
export async function renderShort({
  input,
  output,
  moment,
  start = 0,
  reactionAt = 25,
  workDir = dirname(input),
  onProgress = () => {},
  settings = shortformConfig(),
  avoid = [],
  music = false,
  // Already transcribed and judged (by the reviewer): skip doing it again.
  // `undefined` means "not done yet", null means "nothing usable".
  words: given = undefined,
  speechError: givenError = null,
  // A window of a wider cut, for a redo: {start, duration} in seconds.
  trim = null,
}) {
  const stem = basename(output, extname(output));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(workDir, { recursive: true });

  const source = await probe(input);
  const length = trim ? Math.min(trim.duration, source.duration - trim.start) : source.duration;

  // What was said: for the subtitles, and for a title about what happened.
  let words = given ?? null;
  let speechError = givenError;
  if (given === undefined && source.hasAudio) {
    onProgress({ stage: 'short', percent: 0, message: 'transcribing' });
    ({ words, speechError } = await speechIn(input, settings));
  }

  // The streamer's camera on top, when there is one to find.
  let cam = null;
  if (settings.facecam) {
    onProgress({ stage: 'short', percent: 0, message: 'looking for the webcam' });
    try {
      cam = fitCam(await detectFacecam(input, settings));
    } catch {
      cam = null; // no camera found is a layout choice, never a failed short
    }
  }

  const caption = titleFor(moment, { words, reactionAt, avoid, mild: settings.censor });
  const about = describe(moment, { avoid, mild: settings.censor });
  const chunks = words ? subtitleChunks(words, { mild: settings.censor }) : [];
  const layout = layoutFor({
    style: settings.style,
    sourceWidth: source.width,
    sourceHeight: source.height,
    subtitles: chunks.length > 0,
    camH: cam?.outH || 0,
  });

  // Written beside the source, never in the ready folder, so nothing half-made
  // ever appears where someone picks finished posts out.
  const assPath = join(workDir, `${stem}.ass`);
  const partial = join(workDir, `${stem}.rendering.mp4`);
  await writeFile(
    assPath,
    buildAss({
      layout,
      style: settings.style,
      titleLines: wrapCaption(caption, {
        maxChars: settings.style === 'blur' ? 16 : 20,
        maxLines: layout.titleLines ?? 3,
      }),
      credit: creditFor(moment),
      chunks,
      fontName: settings.fontName,
    }),
    'utf8',
  );

  const track = music && source.hasAudio ? await chooseTrack(settings, hashOf(moment?.id || stem), length) : null;

  const render = () =>
    run(
      'ffmpeg',
      shortformArgs({
        input,
        output: partial,
        assPath,
        fontsDir: settings.fontsDir,
        hasAudio: source.hasAudio,
        loudness: settings.loudness,
        style: settings.style,
        sourceWidth: source.width,
        sourceHeight: source.height,
        duration: length,
        music: track,
        cam,
        trim,
      }),
      {
        cwd: config.root,
        label: 'ffmpeg',
        onLine: (line) => {
          const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (match) {
            const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
            onProgress({ stage: 'short', seconds, message: `rendering short ${formatClipTimestamp(seconds)}` });
          }
        },
      },
    );

  try {
    onProgress({ stage: 'short', percent: 0, message: 'rendering short' });
    // Checked before it can reach the ready folder. A fault in the file is
    // rendered once more; a fault in the footage is not worth repeating.
    let checks = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await render();
      checks = await validateShort(partial, { expectSeconds: length, hasAudio: source.hasAudio });
      if (checks.ok) break;
      if (!checks.retry || attempt === 2) {
        throw new Error(`the finished short failed its checks: ${checks.problems.map((p) => p.text).join('; ')}`);
      }
      onProgress({ stage: 'short', percent: 0, message: 'failed its checks, rendering again' });
    }

    // The post copy, as plain text to read and as parts for the panel's
    // platform buttons, written before the video moves so the panel never
    // sees a short without its copy.
    const parts = postPartsFor(moment, { caption, start, about, hashtags: settings.hashtags, mild: settings.censor });
    const textPath = join(dirname(output), `${stem}.txt`);
    await writeFile(join(workDir, `${stem}.rendering.txt`), postTextFor(moment, { parts }), 'utf8');
    await writeFile(join(workDir, `${stem}.rendering.json`), `${JSON.stringify(parts, null, 2)}\n`, 'utf8');
    await moveInto(join(workDir, `${stem}.rendering.txt`), textPath);
    await moveInto(join(workDir, `${stem}.rendering.json`), join(dirname(output), `${stem}.json`));
    await moveInto(partial, output);

    return {
      path: output,
      textPath,
      caption,
      description: about,
      words: words ? words.length : null,
      speechError,
      track: track ? basename(track.path) : null,
      cam: Boolean(cam),
      checked: checks.ok,
      duration: checks.duration,
    };
  } finally {
    await rm(assPath, { force: true });
    await rm(partial, { force: true });
    await rm(join(workDir, `${stem}.rendering.txt`), { force: true });
    await rm(join(workDir, `${stem}.rendering.json`), { force: true });
  }
}

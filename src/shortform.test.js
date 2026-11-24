// node --test src/shortform.test.js    (or: npm test)
//
// Pure functions only. The text traps described in shortform.js were each hit
// for real while building this, so each one is pinned here.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  assTime,
  buildAss,
  censor,
  cleanCaption,
  creditFor,
  dominantReaction,
  escapeAss,
  escapeFilterPath,
  hashtagsFor,
  layoutFor,
  listTracks,
  pickQuote,
  postPartsFor,
  postTextFor,
  describe,
  youtubeTitle,
  YOUTUBE_TITLE_MAX,
  reactionFromEmoji,
  quoteIn,
  shortformArgs,
  subtitleChunks,
  titleFor,
  trackStart,
  twitchTime,
  wrapCaption,
} from './shortform.js';

const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

// Words the way transcribe.py returns them, from "text" placed at a time.
function spoken(...lines) {
  const words = [];
  for (const [start, text] of lines) {
    text.split(' ').forEach((word, i) => words.push({ word: ` ${word}`, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
  }
  return words;
}

// --- cleaning -----------------------------------------------------------------

test('stream-title furniture is stripped and the first segment kept', () => {
  assert.equal(cleanCaption('GTA 6 DAY 1 | !merch !discord [DROPS ON]'), 'GTA 6 DAY 1');
  assert.equal(cleanCaption('insane heist https://x.co/abc #ad'), 'insane heist');
});

test('emoji now survive cleaning; scripts the font cannot draw still do not', () => {
  // libass falls back to Segoe UI Emoji, so an emoji is drawable now.
  assert.equal(cleanCaption('he is cooked 💀💀'), 'he is cooked 💀💀');
  assert.equal(cleanCaption('Ça va très bien'), 'Ça va très bien');
  assert.equal(cleanCaption('정말 대박'), '');
});

test('punctuation stranded by stripping is dropped, but a bare !!! survives', () => {
  assert.equal(cleanCaption("he's 100% cooked %{pts}"), "he's 100% cooked pts");
  assert.equal(cleanCaption('NO WAY !!!'), 'NO WAY !!!');
});

test('slurs are always masked; ordinary swearing only by default', () => {
  assert.equal(censor('what the fuck'), 'what the f***');
  assert.equal(censor('what the fuck', { mild: false }), 'what the fuck');
  assert.equal(censor('you retard', { mild: false }), 'you ******');
  // Words that merely contain the letters are left alone.
  assert.equal(censor('a nightly fagioli'), 'a nightly fagioli');
});

test('wrapping counts an emoji as one character, as a person reads it', () => {
  // 14 characters to the eye, 15 to String.length.
  assert.deepEqual(wrapCaption('Chat lost it 😂', { maxChars: 14 }), ['Chat lost it 😂']);
  const lines = wrapCaption('this is a fairly long caption about a heist gone wrong');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(line.length <= 16, `"${line}" is too long`);
  assert.ok(lines[2].endsWith('…'));
  assert.deepEqual(wrapCaption('A'.repeat(22)), ['A'.repeat(16), 'A'.repeat(6)]);
});

// --- titles -------------------------------------------------------------------

test('the reaction that spiked hardest is the one named', () => {
  const chat = { classes: { funny: { z: 4.1 }, hype: { z: 2.5 }, clipit: { z: 1.2 } } };
  assert.equal(dominantReaction(chat), 'funny');
  assert.equal(dominantReaction({ classes: { funny: { z: 1.9 } } }), null);
});

test('the quote is the line said as it happened, not the filler around it', () => {
  // People reacted 25s into the cut. The narration just before that is the
  // line that says what happened.
  const words = spoken(
    [2, 'uh yeah.'],
    [20, 'he just stole the cop car!'],
    [24.5, 'okay okay.'],
    [40, 'anyway what were we doing.'],
  );
  assert.equal(pickQuote(words, { reactionAt: 25 }), 'He just stole the cop car!');
  // Nothing but filler is never a title.
  assert.equal(pickQuote(spoken([22, 'oh my god.'], [24, 'yeah yeah.']), { reactionAt: 25 }), null);
  // And it is cleaned like everything else that goes on screen.
  assert.equal(pickQuote(spoken([21, 'that was so fucking close!']), { reactionAt: 25 }), 'That was so f****** close!');
});

test('a curly apostrophe does not smuggle a hollow line past the content test', () => {
  // "it’s" used to split into "it" and "s". "it" is a known empty word; "s"
  // is in no list at all, so it counted as a word that named something, and
  // two of them were enough to pass a line made of nothing.
  assert.equal(pickQuote(spoken([22, 'it’s what it’s']), { reactionAt: 25 }), null);
  assert.equal(pickQuote(spoken([22, 'that’s what you’re doing']), { reactionAt: 25 }), null);
  // A real line is kept whichever apostrophe the transcript used. The quote
  // itself still carries the speaker's own character — the normalising is for
  // counting words, not for rewriting what was said.
  assert.equal(pickQuote(spoken([22, 'i’m about to be a gay dancer']), { reactionAt: 25 }), 'I’m about to be a gay dancer');
  assert.equal(pickQuote(spoken([22, "i'm about to be a gay dancer"]), { reactionAt: 25 }), "I'm about to be a gay dancer");
});

test('a title says what happened, best source first, with an emoji', () => {
  const words = spoken([20, 'he just stole the cop car!']);
  const laughing = { classes: { funny: { z: 5 } } };

  // 1. A clip title a person wrote about this moment.
  const clip = titleFor({ id: 'a', source: 'clips', title: 'bro crashed the getaway car', chat: laughing }, { words });
  assert.match(clip, /^bro crashed the getaway car \p{Extended_Pictographic}$/u);

  // A "clip title" that is really the stream title is not that.
  const furniture = titleFor({ id: 'b', source: 'clips', title: 'GTA 6 DAY 1 | !merch', chat: laughing }, { words });
  assert.match(furniture, /^"He just stole the cop car!" \p{Extended_Pictographic}$/u);

  // 2. What was said, for a moment found in chat.
  const quoted = titleFor({ id: 'c', source: 'chat', broadcaster: 'lirik', chat: laughing }, { words });
  assert.match(quoted, /^"He just stole the cop car!" (😂|💀|🤣)$/u);

  // 3. No transcript: what chat did, with the emoji that goes with it.
  const hook = titleFor({ id: 'd', source: 'chat', broadcaster: 'lirik', chat: laughing });
  assert.match(hook, /(😂|💀|🤣)$/u);
});

test('a busy channel does not get the same title twice', () => {
  const titles = [];
  for (let i = 0; i < 6; i += 1) {
    titles.push(
      titleFor(
        { id: 'same-moment-kind', source: 'chat', broadcaster: 'lirik', chat: { classes: { funny: { z: 5 } } } },
        { avoid: titles },
      ),
    );
  }
  const words = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  assert.equal(new Set(titles.map(words)).size, titles.length, titles.join(' | '));
});

test('each game gets its own tags', () => {
  assert.equal(hashtagsFor({ game: 'Fortnite', broadcaster: 'Clix' }), '#fortnite #fortniteclips #gaming #twitch #clix');
  assert.equal(
    hashtagsFor({ game: 'Grand Theft Auto VI', broadcaster: 'LIRIK' }),
    '#gta6 #gtavi #gaming #twitch #lirik',
  );
  assert.equal(hashtagsFor({ game: 'Chess', broadcaster: 'x' }), '#gaming #twitch #x');
  // SHORTS_HASHTAGS overrides them all.
  assert.equal(hashtagsFor({ game: 'Fortnite' }, { hashtags: '#mine' }), '#mine');
});

test('the post copy links straight to the moment in the full stream', () => {
  assert.equal(twitchTime(3955), '1h05m55s');
  const moment = { broadcaster: 'Sodapoppin', vodId: 'v2932490378', game: 'Fortnite' };
  const parts = postPartsFor(moment, { caption: 'he is cooked 💀', start: 3955 });
  assert.equal(parts.link, 'https://www.twitch.tv/videos/2932490378?t=1h05m55s');
  assert.equal(parts.credit, 'Credit: Sodapoppin on Twitch');
  assert.equal(parts.game, 'Fortnite');
  const lines = postTextFor(moment, { caption: 'he is cooked 💀', start: 3955 }).split('\n');
  assert.equal(lines[0], 'TIKTOK');
  // Attribution once, at the bottom, not in every block.
  assert.equal(lines.filter((l) => l === 'Credit: Sodapoppin on Twitch').length, 1);
  assert.ok(lines.includes('Full stream: https://www.twitch.tv/videos/2932490378?t=1h05m55s'));
});

const LIRIK = {
  id: 'chat:lirik:1',
  source: 'chat',
  broadcaster: 'lirik',
  vodId: '2932444934',
  game: 'Grand Theft Auto VI',
  chat: { classes: { funny: { z: 5 } } },
};

test('each platform gets its own block, saying what the clip is about', () => {
  const parts = postPartsFor(LIRIK, { caption: '"Excuse me, put that down" 😂', start: 15409 });
  const { tiktok, instagram, youtube } = parts.platforms;
  // What happens, not only the line of dialogue.
  assert.match(parts.about, /lirik/i);
  assert.match(parts.about, /GTA 6/);
  assert.ok(!parts.about.includes('put that down'));
  // TikTok: the hook first, lower case, tags inline at the end.
  assert.ok(tiktok.startsWith('"excuse me, put that down" 😂 '));
  assert.ok(tiktok.endsWith('#gta6 #gtavi #lirik #twitch #gaming'));
  // Instagram: front-loaded first line, tags after a line break.
  const [hook, credit, tags] = instagram.split('\n');
  assert.ok(hook.length <= 125);
  assert.ok(hook.includes(parts.about) && hook.includes('put that down'));
  assert.equal(credit, 'Credit: lirik on Twitch');
  assert.equal(tags, '#gta6 #gtavi #lirik #gaming #twitch #reels');
  // YouTube: Title Case, #Shorts and the game's tag in the title.
  const title = youtube.split('\n')[0];
  assert.match(title, /^[A-Z].* #Shorts #GTA6 #lirik$/);
  // Three different openings, not one sentence three times.
  const openings = [tiktok, hook, title].map((t) => t.toLowerCase().slice(0, 30));
  assert.equal(new Set(openings).size, 3);
});

test("tags follow the clip's own game, and an unknown game gets none", () => {
  const fortnite = postPartsFor({ ...LIRIK, game: 'Fortnite' }, { caption: 'x 😂' }).platforms;
  assert.match(fortnite.tiktok, /#fortnite /);
  assert.ok(!/#gta/i.test(Object.values(fortnite).join(' ')));
  assert.match(fortnite.youtube.split('\n')[0], /#Shorts #Fortnite/);
  // The bug this must never bring back: a VALORANT clip tagged #gta6.
  for (const game of ['VALORANT', null, '']) {
    const all = Object.values(postPartsFor({ ...LIRIK, game }, { caption: 'x 😂' }).platforms).join(' ');
    assert.ok(!/#gta|#fortnite/i.test(all), `${game}: ${all}`);
    assert.match(all, /#lirik/);
  }
  // And with no game, the description does not name one.
  assert.ok(!/GTA|Fortnite/.test(postPartsFor({ ...LIRIK, game: null }, { caption: 'x' }).about));
});

test('a YouTube title never passes 100 characters, and keeps #Shorts', () => {
  for (const broadcaster of ['x', 'averyveryveryverylongstreamername_official', 'a'.repeat(25)]) {
    for (const about of [
      'short',
      'He crashes the plane into the bridge',
      'An enormously long description of what happened that goes on and on well past anything a title should hold in it',
      'Word'.repeat(60),
    ]) {
      const title = youtubeTitle(about, { broadcaster, game: 'Grand Theft Auto VI' });
      assert.ok(title.length <= YOUTUBE_TITLE_MAX, `${title.length}: ${title}`);
      assert.match(title, /#Shorts #GTA6/);
    }
  }
  // The creator's tag goes when it would not fit; #Shorts never does.
  const long = youtubeTitle('Things get tense for averyveryveryverylongstreamername_official in GTA 6 again and again', {
    broadcaster: 'averyveryveryverylongstreamername_official',
    game: 'Grand Theft Auto VI',
  });
  assert.ok(long.endsWith(' #Shorts #GTA6'));
  assert.ok(!long.includes('#averyvery'));
});

test('descriptions in the avoid list are not repeated', () => {
  const first = describe(LIRIK);
  const second = describe(LIRIK, { avoid: [first] });
  assert.notEqual(second, first);
  // A clip title a person wrote is what happens, and is used as it stands.
  assert.equal(describe({ ...LIRIK, source: 'clip', title: 'he steals the cop car' }), 'He steals the cop car');
  // A stream title is not.
  assert.notEqual(describe({ ...LIRIK, source: 'clip', title: 'DAY 3 | !drops' }), 'DAY 3 | !drops');
});

test("older shorts: the reaction is read back from the title's emoji", () => {
  assert.equal(reactionFromEmoji('"Put that down" 😂'), 'funny');
  assert.equal(reactionFromEmoji('Wait what 😱'), 'shock');
  // 👀 and 🔥 are also the neutral pair: no claim made.
  assert.equal(reactionFromEmoji('IlloJuan: 🔥'), null);
  // The hook's own words say it, emoji or not.
  assert.equal(reactionFromEmoji("Let's go 🔥"), 'hype');
  assert.equal(reactionFromEmoji('Chat lost it'), 'funny');
  assert.equal(reactionFromEmoji("papaplatte: chat's chat could not breathe 🤣"), 'funny');
  assert.equal(reactionFromEmoji('Doble in Fortnite 👀'), null);
  assert.equal(quoteIn('"Put that down" 😂'), 'Put that down');
  assert.equal(quoteIn('lirik broke chat 💀'), null);
});

test('the credit shows the name and nothing the font cannot draw', () => {
  assert.equal(creditFor({ broadcaster: '정말' }), '');
  assert.equal(creditFor({ broadcaster: 'Sodapoppin' }), '@Sodapoppin on Twitch');
});

// --- subtitles ----------------------------------------------------------------

test('subtitles come in short bursts, broken at a pause or a sentence end', () => {
  const words = [
    { word: ' no', start: 0, end: 0.2 },
    { word: ' way', start: 0.25, end: 0.5 },
    { word: ' he', start: 0.55, end: 0.7 },
    { word: ' actually', start: 0.75, end: 1.1 },
    { word: ' did', start: 1.15, end: 1.3 },
    { word: ' that.', start: 1.35, end: 1.6 },
    // A long pause starts a new chunk even mid-sentence.
    { word: ' what', start: 4, end: 4.3 },
  ];
  const chunks = subtitleChunks(words);
  assert.deepEqual(
    chunks.map((c) => c.words.map((w) => w.text).join(' ')),
    ['no way he', 'actually did that', 'what'],
  );
  // Each stays up until the next begins, but never long after its last word.
  assert.equal(chunks[0].end, 0.75);
  assert.equal(chunks[1].end, 2.1);
});

test('subtitles are cleaned like titles', () => {
  const [chunk] = subtitleChunks([{ word: ' shit!', start: 0, end: 0.3 }]);
  assert.equal(chunk.words[0].text, 's***!');
});

test('libass times and text are written the way libass reads them', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(59.999), '0:01:00.00');
  assert.equal(assTime(3725.5), '1:02:05.50');
  // `{` opens an override block and `\` a command: what anyone said is inert.
  assert.equal(escapeAss('{\\b1}hi\\N'), '(/b1)hi/N');
});

test('the layout anchors each piece of text to the picture', () => {
  const reel = layoutFor({ style: 'reel', sourceWidth: 1920, sourceHeight: 1080 });
  assert.equal(reel.pictureTop, 656);
  assert.equal(reel.pictureBottom, 1264);
  assert.deepEqual(reel.title, { an: 2, y: 608 }); // ends 48px above the picture
  assert.deepEqual(reel.subs, { an: 8, y: 1312 }); // starts 48px below it
  assert.deepEqual(reel.credit, { an: 8, y: 1450 }); // under the subtitles
  // With nothing said, the credit takes the subtitles' place.
  assert.equal(layoutFor({ subtitles: false }).credit.y, 1312);
  // A 4:3 picture is taller, so everything moves with it.
  const tall = layoutFor({ sourceWidth: 1440, sourceHeight: 1080 });
  assert.equal(tall.title.y, 506);
  assert.equal(tall.subs.y, 1412);
  assert.deepEqual(layoutFor({ style: 'blur' }).title, { an: 5, y: 326 });
});

test('the subtitle file highlights the word being said', () => {
  const layout = layoutFor({});
  const chunks = subtitleChunks([
    { word: ' no', start: 1, end: 1.2 },
    { word: ' way', start: 1.3, end: 1.6 },
  ]);
  const ass = buildAss({ layout, titleLines: ['He just stole', 'the cop car! 😂'], credit: '@lirik on Twitch', chunks });
  assert.match(ass, /Title,,0,0,0,,\{\\an2\\pos\(540,608\)\}He just stole\\Nthe cop car! 😂/);
  assert.match(ass, /Credit,,0,0,0,,\{\\an8\\pos\(540,1450\)\}@lirik on Twitch/);
  // One event per spoken word, with that word in yellow.
  const subs = ass.split('\n').filter((line) => line.includes(',Sub,'));
  assert.equal(subs.length, 2);
  assert.match(subs[0], /^Dialogue: 1,0:00:01\.00,0:00:01\.30,Sub.*\{\\c&H00FFFF&\}no\{\\c&HFFFFFF&\} way$/);
  assert.match(subs[1], /^Dialogue: 1,0:00:01\.30,0:00:02\.10,Sub.*no \{\\c&H00FFFF&\}way\{\\c&HFFFFFF&\}$/);
});

// --- ffmpeg -------------------------------------------------------------------

test('a Windows path survives both layers of filtergraph escaping', () => {
  // Unescaped, the colon after the drive letter splits the option in two.
  assert.equal(escapeFilterPath('C:\\Windows\\Fonts'), 'C\\\\:/Windows/Fonts');
  assert.equal(escapeFilterPath("C:/Users/O'Brien/a.ass"), "C\\\\:/Users/O\\\\\\'Brien/a.ass");
});

const ARGS = {
  input: 'in.mp4',
  output: 'out.mp4',
  assPath: 'C:/clips/.work/a.ass',
  fontsDir: 'C:/Windows/Fonts',
};

test('the reel look: black canvas, every piece of text from one subtitle file', () => {
  const graph = graphOf(shortformArgs(ARGS));
  assert.match(
    graph,
    /^\[0:v\]scale=1080:608,pad=1080:1920:0:656:color=black,setsar=1,subtitles=filename=C\\\\:\/clips\/\.work\/a\.ass:fontsdir=C\\\\:\/Windows\/Fonts\[v\]/,
  );
  assert.ok(!graph.includes('drawtext'), 'drawtext cannot fall back to an emoji font');
  assert.ok(!graph.includes('gblur'));
});

test('the blur look is still there when asked for', () => {
  const graph = graphOf(shortformArgs({ ...ARGS, style: 'blur' }));
  assert.match(graph, /gblur/);
  assert.match(graph, /subtitles=filename=/);
});

test('without music, loudness is normalised and resampled back to 48k', () => {
  // loudnorm hands on 192 kHz unless told otherwise.
  assert.match(graphOf(shortformArgs(ARGS)), /\[0:a\]loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=48000\[a\]/);
});

test('music sits under the voice, ducks when someone talks, and fades out', () => {
  const args = shortformArgs({ ...ARGS, duration: 30, music: { path: 'bed.mp3', start: 12, volume: 0.12 } });
  // Looped, so a short track still covers the clip, and started partway in.
  assert.deepEqual(args.slice(args.indexOf('-stream_loop'), args.indexOf('bed.mp3') + 1), [
    '-stream_loop',
    '-1',
    '-ss',
    '12',
    '-i',
    'bed.mp3',
  ]);
  const graph = graphOf(args);
  assert.match(graph, /volume=0\.12,afade=t=in:d=1,afade=t=out:st=28\.50:d=1\.5\[bed\]/);
  assert.match(graph, /\[bed\]\[key\]sidechaincompress/);
  // The clip ends when the stream audio does, not when the music would.
  assert.match(graph, /amix=inputs=2:duration=first:normalize=0,loudnorm/);
});

test('a source with no audio maps video only, music or not', () => {
  const args = shortformArgs({ ...ARGS, hasAudio: false, music: { path: 'bed.mp3', start: 0, volume: 0.1 } });
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('bed.mp3'));
  assert.ok(!graphOf(args).includes('[0:a]'));
});

const scratch = mkdtempSync(join(tmpdir(), 'shortform-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('the music folder is read for audio files only, in a stable order', async () => {
  for (const name of ['b.mp3', 'a.wav', 'notes.txt', 'cover.jpg', 'c.m4a']) writeFileSync(join(scratch, name), '');
  const tracks = (await listTracks(scratch)).map((path) => path.split(/[\\/]/).pop());
  assert.deepEqual(tracks, ['a.wav', 'b.mp3', 'c.m4a']);
  // A folder that is not there is simply no music.
  assert.deepEqual(await listTracks(join(scratch, 'missing')), []);
});

test('a track starts partway in, but never so late it runs out first', () => {
  assert.equal(trackStart(100, 120, 30), 12); // 100 mod (120 - 30 - 2)
  assert.equal(trackStart(100, 20, 30), 0); // shorter than the clip: from the top, looped
});

test('a transcript the model was guessing at is not burned into the clip', async () => {
  const { MIN_SPEECH_CONFIDENCE, transcriptUsable } = await import('./shortform.js');
  const at = (probability) => ({ word: ' x', start: 0, end: 0.1, probability });
  // Measured means: English streamers 0.70-0.82, other languages 0.26-0.50.
  assert.equal(transcriptUsable([at(0.74), at(0.70)]).usable, true);
  assert.equal(transcriptUsable([at(0.5), at(0.5)]).usable, false); // the Spanish stream
  assert.equal(transcriptUsable([at(0.26)]).usable, false);
  assert.ok(MIN_SPEECH_CONFIDENCE > 0.5 && MIN_SPEECH_CONFIDENCE < 0.7);
  // Older transcripts with no confidence are taken as they are.
  assert.equal(transcriptUsable([{ word: ' x', start: 0, end: 1 }]).usable, true);
  assert.equal(transcriptUsable([]).usable, false);
});

// --- camera on top ------------------------------------------------------------

test('the webcam crop is reshaped for the top of the frame, keeping the face', async () => {
  const { fitCam } = await import('./shortform.js');
  // kaicenat's overlay, measured at 1080p: wide and short.
  const wide = fitCam({ x: 0, y: 432, w: 390, h: 258 });
  assert.equal(wide.outH, 714 > 600 ? 600 : 714);
  assert.ok(wide.w / wide.h - 1080 / wide.outH < 0.02, 'reshaped to the slot');
  // A tall crop loses more from the bottom (the desk) than the top (the face).
  const tall = fitCam({ x: 100, y: 100, w: 200, h: 400 });
  const cutTop = tall.y - 100;
  const cutBottom = 100 + 400 - (tall.y + tall.h);
  assert.ok(cutBottom > cutTop, `top lost ${cutTop}, bottom ${cutBottom}`);
  assert.equal(fitCam(null), null);
});

test('camera on top: webcam, then game, title above, subtitles on the seam', async () => {
  const { camLayout, layoutFor } = await import('./shortform.js');
  const layout = camLayout({ sourceWidth: 1920, sourceHeight: 1080, camH: 560 });
  assert.equal(layout.pictureTop, layout.camTop + 560);
  assert.equal(layout.pictureBottom, layout.camTop + 560 + 608);
  assert.deepEqual(layout.subs, { an: 5, y: layout.camTop + 560 });
  assert.ok(layout.title.y < layout.camTop);
  // Clear of the platform's top bar, and the credit still on the canvas.
  assert.ok(layout.camTop >= 340);
  assert.ok(layout.credit.y < 1920 - 40);
  // Only two title lines fit above the camera.
  assert.equal(layout.titleLines, 2);
  // layoutFor hands over to it whenever there is a camera.
  assert.equal(layoutFor({ camH: 560 }).cam, true);
  assert.equal(layoutFor({}).cam, undefined);
});

test('the camera graph crops the webcam, stacks it on the game, and pads', async () => {
  const { shortformArgs } = await import('./shortform.js');
  const args = shortformArgs({ ...ARGS, cam: { x: 0, y: 432, w: 390, h: 216, outH: 600 } });
  const graph = graphOf(args);
  assert.match(graph, /\[0:v\]split=2\[c\]\[g\]/);
  assert.match(graph, /\[c\]crop=390:216:0:432,scale=1080:600,setsar=1\[cam\]/);
  assert.match(graph, /\[g\]scale=1080:608,setsar=1\[game\]/);
  assert.match(graph, /\[cam\]\[game\]vstack=inputs=2,pad=1080:1920:0:\d+:color=black,subtitles=filename=/);
});

test('a redo renders a window of the wider cut by seeking the input', async () => {
  const { shortformArgs } = await import('./shortform.js');
  const args = shortformArgs({ ...ARGS, trim: { start: 22.5, duration: 30 } });
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('in.mp4') + 1), ['-ss', '22.5', '-t', '30', '-i', 'in.mp4']);
});

test('every post credits the streamer and links back, live recordings included', () => {
  // TERMS.md says so in public: a credit line and a link with every clip.
  const vod = postPartsFor(LIRIK, { caption: 'x 😂', start: 60 });
  assert.match(vod.link, /twitch\.tv\/videos\/2932444934\?t=0h01m00s/);
  const live = postPartsFor({ ...LIRIK, vodId: null, broadcaster: 'iShowSpeed' }, { caption: 'x 😂' });
  assert.equal(live.link, 'https://www.twitch.tv/ishowspeed');
  assert.match(postTextFor(null, { parts: live }), /\nLive on Twitch: https:\/\/www\.twitch\.tv\/ishowspeed\n/);
  for (const parts of [vod, live]) {
    for (const [platform, text] of Object.entries(parts.platforms)) {
      assert.match(text, new RegExp(parts.broadcaster, 'i'), `${platform} credits`);
    }
    assert.match(parts.platforms.tiktok, /\(credit: .+ on twitch\)/);
    assert.ok(parts.platforms.youtube.includes(parts.link));
  }
});

# Saturation Feed

A live feed of stream moments that leads with the one number nothing else
shows: **how many clippers already grabbed it.**

Every clipping tool answers "what's hot." Hot is where the crowd already is. A
clipper racing two hundred people to the same forty seconds has already lost.
The useful question is *hot and not yet flooded*, and nobody reports it.

> Setting it up again on another machine, or wondering why nothing is posting?
> **[RUNNING.md](RUNNING.md)** is the short version: what does not travel with
> the repository, the settings you actually touch, and the platform limits that
> no setting changes.

## The trick

A native Twitch clip is a **costly** signal. Chat is free — anyone can type
"LMAOO" — but creating a clip means someone watched something, decided it was
worth keeping, and acted. Cluster those clips by broadcaster and position in
the VOD, and two things fall out of one API call:

- a cluster forming &nbsp;=&nbsp; **a moment happened**
- the cluster's size &nbsp;=&nbsp; **how many people already have it**

Detection and saturation are the same measurement. Chat velocity rides on top
as the *lead* signal — it moves before anyone has finished clipping — but never
declares a moment on its own.

Nothing analyses video. It runs on a laptop.

## Quick start

```bash
npm start
```

Then open <http://localhost:3000>. With no credentials the page tells you what
to do; with credentials it starts polling immediately.

To see the interface before the game is out, when the category is empty:

```bash
npm start
```

and open <http://localhost:3000/?demo=1>.

### Running without credentials

Chat is anonymous and unmetered, so **moment detection needs no Twitch account
at all**. It is also the only signal that can fire *before* anybody has
clipped, which makes it the half worth having first.

```bash
npm start
```

With an empty `.env` this starts in **chat-only** mode: it joins the watch
list's chat over anonymous IRC, scores every ten-second bucket against that
channel's own rolling median, and puts a moment on the feed when chat reacts.
Set `WATCH_CHANNELS=name,name` in `.env` to choose who it listens to, or leave
it unset for a built-in starting list.

What chat-only **cannot** do is measure saturation. Counting who already
grabbed a moment means reading clips, and that needs the API. So in this mode
the card says `NOT MEASURED` rather than `NOBODY YET`, there is no clip count,
and the deep link is the live channel rather than a VOD timestamp. A zero you
never measured is not a zero.

To find spots without a browser open:

```bash
npm run check -- 300
```

That listens for five minutes and prints each moment as chat nominates it.
Nothing scores for the first ~60s while the baseline settles. However the run
ends, it reports how close each gate came to firing:

```
  the closest anything came, per gate:

    volume z            lirik           11.5          needs 3
    rise over median    lirik           5.09x         needs 1.5x
    messages / bucket   sodapoppin      146           needs 8
    clip calls          -               0 (z 0.0)     needs 2 and z 3
```

The volume path needs the first three at once, so a quiet run is only
interpretable if you can see which one held it back.

### Credentials

Twitch's public endpoints still need an app token.

1. Register an app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
   (OAuth redirect `http://localhost`, category "Application Integration")
2. `cp .env.example .env`
3. Paste the Client ID and a generated Client Secret into `.env`
4. `npm start`

Check it works without launching the server:

```bash
npm run check
```

That resolves the category, counts live channels, pulls the clip window, and
prints the moments it clusters into.

## Clipping a moment

Every card has a **Clip it** button. It cuts the moment out of the broadcaster's
VOD and writes an mp4 into `clips/` — on your own disk, nowhere else. The feed
still only ever indexes and links; nothing here uploads, posts, or rehosts
anything, and that is deliberate rather than unfinished.

### Setup

ffmpeg must be on `PATH`, and yt-dlp installed:

```bash
python -m pip install yt-dlp
```

The default invocation is `python -m yt_dlp` (set `YTDLP_CMD` to change it)
because the `yt-dlp` console-script shim hits a permission error on some
Windows installs while the module form works fine.

**Do not reach for streamlink.** It is the obvious tool for this and it cannot
work on a current Python: streamlink needs `pycryptodome` for HLS AES, and
pycryptodome has no Python 3.14 wheel, so `Crypto.Cipher._raw_aes` fails to
import and every HLS stream dies at the first segment. `--force-reinstall`
does not fix it. An hour has already been spent confirming that; yt-dlp does
the same job here.

### Why the window is lopsided

`CLIP_PRE=25`, `CLIP_POST=5` — twenty-five seconds *before* the timestamp and
five after.

Both signals that put a moment in the feed are reactions. Chat types after the
thing lands. A clipper hits the hotkey after they have already watched it
happen. So the timestamp the feed hands you is the *tail* of the moment, not
its start, and a window centred on it would capture the crowd reacting while
cutting off whatever they were reacting to. The pre-roll is where the clip
actually is.

For a moment found through clips, the reaction point is the **end** of the
earliest clip, not its `vod_offset`: Twitch's `vod_offset` is where a clip
*starts*, and the clipper pressed the button at its end. The feed carries this
as `reactionOffsetSeconds` (the earliest clip end, or for a chat moment the
peak), and both **Clip it** and autocollect cut around it. Before that existed,
**Clip it** cut around the clip's start, which is twenty-five seconds of
lead-up and only the first five of what the clipper actually captured.

The cut uses `--download-sections` with `--force-keyframes-at-cuts`, so only
the relevant segments are fetched and the boundaries land on the second asked
for rather than the nearest keyframe (on Twitch, up to two seconds away). The
flag costs a re-encode: a 30s cut at 1080p60 takes around 100 seconds, at 720p
around five. Lower `CLIP_QUALITY` if that matters more than resolution.

### Vertical

Ticking **9:16 copy** writes a second file alongside the first, sized 1080x1920
for Shorts and TikTok. It is not a centre crop — a centre crop of 16:9 throws
away two thirds of the width, and in GTA the thing worth clipping is as often
at the edge of frame as in the middle. Instead a zoomed, blurred copy fills the
tall canvas and the whole original frame sits centred on top of it.

### API

The button is a thin wrapper over two endpoints, so a script can do the same:

```bash
curl -X POST http://localhost:3000/api/clip   -H 'content-type: application/json'   -d '{"vodId":"2931538239","offsetSeconds":3025,"vertical":false}'
# -> 202 {"job":{"id":"...","state":"queued"}, ...}

curl http://localhost:3000/api/clip/<id>
# -> {"job":{"state":"running","progress":44,"message":"cutting 13s", ...}}
```

Jobs live in memory and run two at a time (`CLIP_CONCURRENCY`), because each
one is an ffmpeg re-encode and a third just makes the clip someone is waiting
on slower. They are lost on restart; the mp4 is the artefact worth keeping.

Note that in `?demo=1` the VOD ids are synthetic, so **Clip it** there will
fail with "Video 21 does not exist". That is the fixture being honest, not a
bug — the button needs a real moment.

## Channel automation: shorts with no clicks

`npm start` and open the page. The **Channel automation** panel at the top
works the way channel-automation tools do: add the channels you want clipped
(a name, `@name` or a twitch.tv link), switch it **On**, and finished shorts
appear in the panel as they are made, with a player, **Copy post text** and
**Download**. Settings are kept in `data/automation.json`, so they survive a
restart. A fresh install starts **Off**; `AUTOCLIP=on` in `.env` starts it on.

The difference from those tools is where the moments come from. They wait for
a creator to upload and then cut the upload. Here a moment is found while the
stream is still live, from chat, before anybody has clipped it, and cut from
the recording as it is being made.

For a machine with no page open, `npm run auto` runs the same automation
headless and always on, with the same channels. Run one or the other, not
both: each starts its own feed and its own chat sockets.

Every short lands in `clips/ready/` as an `.mp4` with a `.txt` of post copy
beside it. **It stops at the file.** Nothing here uploads or posts. What you
post, you post yourself.

What lands there, measured on real runs against a live GTA stream:

| | |
| --- | --- |
| video | 1080x1920 H.264, 30.0s: 25s before the reaction, 5s after |
| look | the whole frame across the middle of a black canvas, the title in white directly on top of the picture, word-timed subtitles directly under it, then the credit (`SHORTS_STYLE=blur` for a blurred fill instead) |
| games | Grand Theft Auto VI and Fortnite (`GAMES`), each with its own tags; a moment from any other game is not cut |
| audio | AAC 48 kHz, normalised toward -14 LUFS. Measured -14.6 and -15.3: single-pass loudnorm lands a little under on a 30s clip, and both platforms re-normalise anyway |
| post copy | caption, credit, a link to the exact second in the full stream, hashtags |
| time | about 30s from detection to finished file |

### It works without Twitch credentials

With an empty `.env` the feed watches chat on the automation's channels, and
places each chat spike on that channel's recording itself. yt-dlp finds the
newest archive, which is trusted only if it is **still recording**
(`is_live`): a streamer with archiving switched off has an old VOD at the top
of the list, and cutting at today's offset into yesterday's broadcast would be
a random clip. Measured on a live channel: the lookup takes about 5s and
happens once per broadcast; the recording's start matched the stream's to 5s,
and its duration matched wall-clock time to 3s.

That also means **Clip it** works on chat-only cards, which before this could
only link to the live channel. A channel's dot in the panel says which state
it is in: blue is listening, green is recording (its moments can be cut),
grey is not recording (its moments can be watched, not cut).

Credentials add clip-confirmed moments and the outcome data `npm run eval`
needs. They are not needed to start producing shorts. With credentials the
feed watches the whole category, and the panel's list decides which channels'
moments are cut rather than which are watched.

### What gets cut

Every poll, moments go through these rules, best-ranked first, so when a cap
bites it is the weaker moments that miss out:

| rule | default | why |
| --- | --- | --- |
| one of your channels | the panel's list | it clips what you added and nothing else (with credentials, "every live channel in these games" lifts this) |
| one of your games | `GAMES` | read off the VOD's chapters at the moment's own second; a moment whose game cannot be told is skipped, not guessed. The first live test without this cut World of Warcraft and tagged it #gta6 |
| has a VOD and a position | | otherwise there is nothing to cut |
| state | `early,fresh` | a flooded moment is already on everyone's feed |
| settled | 30s after the window ends | measured: a live recording held full, moving footage 15s behind the live edge |
| not stale | 20 min | by then someone else has had time to post it |
| not already cut | 45s apart on one VOD | by position as well as id, because a chat spike later confirmed by clips comes back under a new id |
| per poll / hour / channel | 4 / 60 / 6 | the cap limits volume, not load (two renders at once does that); raised from 30 after live runs hit it inside the hour. The hour counts every copy's cuts, through the store |
| minimum score | 0 | deliberately off: nothing has calibrated the opportunity scale yet, and `npm run eval` should set this, not a guess |

What has been cut is kept in the store, so a restart does not cut the same
moments again. A render stopped halfway is marked `interrupted` rather than
retried. The short is written next to its source and moved into
`clips/ready/` only when complete, so a stopped process cannot leave a broken
file in the folder you post from.

### Titles, subtitles and emoji

Every short is transcribed first (faster-whisper, `base.en`, on the CPU: a
30s cut takes about 3s), and that transcript drives two things.

**The title says what happened**, from the best source there is:

1. a clip title a person wrote about this moment, when there is one;
2. otherwise **what was said as it happened**: the line nearest to just before
   people reacted, preferring lines that end in `!` or `?` and never one that
   is only filler: `"My god, cops coming" 👀`, `"It was self-defense" 🔥`,
   `"Are you crazy?" 😳`;
3. otherwise what chat did: `Chat lost it 😂`, `Wait what 😳`, with several
   wordings per reaction.

The emoji follows the reaction that spiked (laughing 😂 💀 🤣, shock 😳 😱,
hype 🔥, tension 😬, "clip it" 🎬). Titles are not repeated: the last 80 are
remembered, across restarts, and the next one is chosen to differ.

Two honest limits. Whisper hears everything, so in GTA the quoted line can be
an NPC rather than the streamer, and it sometimes mishears ("fours of horizon
six" for what was probably Forza Horizon). And the model is English-only: on
other languages it does not refuse, it invents fluent English. Measured mean
word confidence: five English streamers 0.70 to 0.82; Spanish 0.50, German
0.45, another 0.26 over 79 invented words. Below 0.6 a short keeps its chat
title but gets **no subtitles and no quote**, rather than a confident
mistranslation burned into it.

**Subtitles** sit directly under the picture, one to three words at a time,
with the word being said in yellow. Under the picture, they cover neither the
game's HUD nor the platform's description overlay.

On-screen emoji are drawn as clean white outlines: neither of ffmpeg's text
renderers here can draw colour emoji. The post copy carries the colour ones,
which TikTok and Instagram render themselves.

Slurs are always masked. Ordinary swearing is masked too (`s***`), because a
burned-in swear gets a short shown to fewer people; `SHORTS_CENSOR=off` keeps
it.

All on-screen text goes through one subtitle file rendered by libass rather
than drawtext. drawtext cannot fall back from one font to another, so a title
with an emoji in it lost either the emoji or the letters. Each trap hit while
building this is pinned by a test in `src/shortform.test.js`: the drive-letter
colon that splits a font path, `{` and `\` meaning something to libass, and
scripts the font has no glyphs for.

### Background music

Optional and **off** by default: switch **Background music** on in the panel
and drop tracks into `music/` (see `music/README.md`). Each short gets one,
started partway in, at about -18 dB under the stream, ducking further whenever
someone talks, with a fade in and out. Use music you have the right to post:
copyrighted songs get shorts muted or struck.

### Post copy: one block per platform

Beside each short, its `.txt` holds a TikTok, an Instagram and a YouTube
version, labelled, then the credit and the stream link once. The platform
buttons in the page copy the right one.

- **What it is about, not just what was said.** Nothing watches the video,
  so the description says what is known: a clip title a person wrote about
  the moment, used as it stands; otherwise who, the game, and what chat did.
  The streamer's own line stays as the hook.
- **TikTok** leads with the hook, lower case, 80 characters, tags inline.
  **Instagram** front-loads the first 125 characters, tags after a line break.
  **YouTube** is a Title Case title with `#Shorts` and the game's tag, never
  over 100 characters: the description is shortened, and the creator's tag
  dropped, before `#Shorts` is.
- **Tags follow the clip's own game**: `#gta6 #gtavi` or `#fortnite`, plus
  `#<creator>`. A clip whose game can't be read gets no game tag at all.
- `npm run recopy` rewrites the copy of every short already in `clips/ready`
  in this format, from what each one recorded about itself. Videos and
  `clips/rejected` are not touched; a short whose copy can't be rebuilt keeps
  its old one.

### Auto upload (YouTube)

With your own Google app's keys in `.env` and **Connect** clicked once,
the **Auto upload** box posts the best shorts to YouTube by itself: about
five a day, three hours apart, best engagement score first, each one checked
again just before it goes. **Dry run** does all of it except the upload and
logs what it would have posted, so a day can be read before it is real.
Setup, limits and failure handling: [docs/posting-setup.md](docs/posting-setup.md).
TikTok (as drafts to your inbox) and Instagram (Reels, through a Facebook Page)
are built too; see the same file for their setup.

### Posting

Each finished short in the panel has **TikTok**, **YouTube** and **Instagram**
buttons. A click copies that platform's version of the post (YouTube's has
`#Shorts` in the title line), opens its upload page, and opens the folder with
the file selected, ready to drag in. You press post. The panel ticks the
platforms you have opened each short for.

Posting **for** you, on a schedule, needs each platform's official API and a
developer app of your own on each, which only you can register:

| platform | what it takes | catch |
| --- | --- | --- |
| YouTube | a Google Cloud project with the YouTube Data API, an OAuth client, and your channel signed in once | uploads from an unaudited project stay **private** until Google audits it |
| TikTok | a TikTok for Developers app with the Content Posting API | direct posts from an unaudited app are **private-only**; uploading to your TikTok inbox to finish in the app is the usual route meanwhile |
| Instagram | a Meta developer app, and an Instagram **professional** (Business or Creator) account linked to a Facebook Page | publishing works for your own account while the app is in development mode |

None of that is built yet: it can only be built and tested against your own
accounts.

### Camera on top

When a clip has the streamer's webcam in it, the short puts it across the top
with the game directly underneath, the title above both and the subtitles on
the seam. Together they fill about 60% of the screen, against about a third
for the game on its own.

Finding the webcam takes a face detector: OpenCV's YuNet, a 230 KB model,
fetched once into `models/` (not committed):

```bash
curl -L -o models/face_detection_yunet_2023mar.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

A webcam is a face that stays in one place for the whole clip, toward the
side or the top or bottom of the picture; game characters move with the
camera and come and go. Measured on ten live streams: seven webcams found,
and the three channels without one correctly reported none, including a GTA
character standing dead-centre in a still conversation, which the
"toward the edge" rule exists to reject. The crop is the still region around
the face, since the game moves over thirty seconds and the webcam's room
does not. On a still scene, where that says nothing, it falls back to a
tight head-and-shoulders crop that cannot spill into the game. It can still
take in a strip of game beside a small webcam when the game is also still.
`SHORTS_FACECAM=off` keeps the plain layout.

### The engagement meter, and redoing weak clips

Every automated short is scored 0-100 before it is rendered, on four things
measured in the cut: how hard chat reacted, a loudness burst near the payoff
(laughing, shouting, explosions), clear energetic speech, and motion on
screen, with a penalty for a clip that is mostly a still frame. Each card in
the panel shows the score, a funny rating and the reasons.

It was checked against an independent reviewer that rewatched 12 live shorts
and rated them by hand, without seeing the meter: **rank correlation 0.83**.
The two it rated 1/10, a phone banking menu and a frozen webcam, metered 13
and 17. The loudness burst was the best single signal (0.62); chat alone was
weak (0.31), because chat also reacts to story cutscenes where nothing
happens on screen.

Below **50**, the short is redone once: a 70-second cut around the moment,
and the 30-second window in it that scores best, with the burst landing
about three quarters of the way in. The redo is kept only if it scores
higher. Below **30** after that, the card is flagged **weak: not worth
posting**. Both lines are `ENGAGEMENT_KEEP` and `ENGAGEMENT_FLOOR`.

What it cannot do is see a joke land. Its misses in the calibration were
cutscenes, where NPC dialogue reads as speech. Titles stay the weakest
part: without an AI model watching the clip, a title is a quote or a
reaction, not a description of what happened.

### Checks before a short is ready

A short only moves into `clips/ready/` after it passes:

- **the file**: decodes cleanly end to end, is 1080x1920 H.264 with 48 kHz
  audio, and is the length its cut was. A failure here is usually transient
  (a process killed mid-write), so it is rendered once more.
- **what is in it**: not mostly black, not a stream frozen for over 80% of
  the clip, not silent. Rendering the same footage again would not help, so
  these are rejected.
- **the cut**: one that comes back shorter than asked (measured: 28.0s from a
  30s window) missed part of the moment because the recording had not caught
  up. It is thrown away and cut again once it has.

Failures that pass are retried with a pause: Windows refusing to start a
process (exit 3221225794), a dropped connection, a stray yt-dlp error.
Run over the first 38 shorts, the checks found exactly two bad ones: the
28-second one, and a webcam frozen for all 30 seconds.

### Only what you download is kept

The pipeline makes dozens of shorts an hour, about 15 MB each. Any short you
have not clicked **Download** on is deleted 6 hours after it was made,
along with its post copy; each card says how long it has left. Clicking
Download keeps it for good (`data/kept.json` lists them). A short being
uploaded is never deleted, and `clips/rejected` is left alone.
`SHORTS_KEEP_HOURS` changes the window; `0` keeps everything.

### One copy at a time

`npm start` and `npm run auto` each take `data/app.lock`, and a second copy
refuses to start, naming the one running. Three copies once ran at once
against the same database, which is what started too many processes for
Windows and cut one lirik moment twice. The store refuses a second claim on
the same moment too: anything within 45 seconds on the same recording,
under any id, from any copy.

### Channels with no recording: recording them live

A channel can be live with nothing to cut: Twitch publishes some streams as a
recording only afterwards, or not at all. ishowspeed keeps no live archive;
squeezie, zerator and wankilstudio keep theirs for subscribers only. Cutting
"today's offset" into an old VOD would be a random clip from another day, so
these channels are recorded from the live stream instead (`src/live.js`).

- **Which channels.** Every few seconds one automated channel's public page is
  checked (each at most every three minutes): live, in a clipped game, and
  with no VOD that can be cut. Those are recorded, the biggest first, up to
  `RECORD_MAX` at once (4). A channel whose VOD status can't be told yet is
  not recorded on a guess; the next pass asks again.
- **What is kept.** The last `RECORD_KEEP_SECONDS` (10 minutes) of the stream
  at up to `RECORD_QUALITY` (720p), as Twitch's own 2-second segments under
  `clips/.live/`. Older segments are deleted as new ones arrive, so the disk
  use stays flat. Each 720p recording is a few megabits a second of download.
- **Ads are not recorded.** Joining a stream stitches in a 30-second pre-roll
  ad, and mid-rolls arrive the same way. Twitch marks them, and they are
  skipped. One session is kept open per channel, since every new one starts
  with another pre-roll. While a streamer runs an ad break, the stream itself
  is replaced by ads for viewers like this one, so nothing is recorded and a
  moment in that stretch cannot be cut: the recording has a gap there, and no
  cut is ever made across a gap.
- **Two stream formats.** Some channels are served as MPEG-TS, some as
  fragmented MP4 (zerator and evelone2004 were). Fragments are stored with
  their init segment, and joined into one continuous file before a cut, so
  both come out the same.
- **Lining a moment up.** Every segment carries the wall-clock time it was
  broadcast, so a chat spike is matched to the exact seconds of video around
  it — the same 25-before, 5-after window as a VOD cut. A moment waits
  (`settling`) until the recording holds that whole window, and a cut is never
  made across a gap, such as a mid-roll.
- **Claiming.** When a moment is picked, its stretch of the recording (55s
  before to 15s after) is copied out of the rolling buffer, so a job that waits
  in the queue cannot lose it, and a redo can still widen the cut. After that
  it is captioned, scored, checked and rendered exactly like a VOD cut. The copy
  is deleted with the job's other intermediates.

The panel shows these channels as **recording live** with a red dot, and the
status line counts them. `RECORDING=off` turns it off.

Verified on real streams: caseoh_ (MPEG-TS) and evelone2004 (fragmented MP4)
each went from the live buffer to a finished, checked 30s short, camera on
top and subtitled, through the same job pipeline as a VOD cut. Live moments
share the hourly budget (`AUTOCLIP_PER_HOUR`) with everything else.

## Detection: being first, and proving it

Two problems shaped everything in `src/chat.js`, `src/store.js` and
`src/eval.js`, and they are worth stating plainly because they are easy to miss.

**The clip feed structurally cannot be first.** Clips are its only input, so a
moment cannot exist until somebody has already clipped it. `saturation = 1`
means one person beat you. Chat is the only signal available that fires at
saturation ZERO.

**"Best" was unfalsifiable.** The ranking formula had never been checked
against whether the moments it liked went on to do anything, so there was no
way to tell a signal that works from one that merely sounds right.

### Chat-sourced moments

A chat spike with no clips attached now becomes a moment of its own, marked
**chat only** and drawn with a dashed border. Two things about it are honest
compromises, and the card says so rather than hiding them:

- **nobody has clipped it.** It might be nothing. That is the price of being
  first, and it is the right price — a confirmed moment is one you are late to.
- **the VOD offset is estimated** from stream uptime, so it is a good place to
  start looking, not a frame-accurate timestamp.

When clips do show up on the same channel at the same time, the two rows are
merged into one marked `both` — something happened *and* almost nobody has it.

### What chat is reacting with

Message rate alone treats `KEKW`, `CLIP THAT` and `monkaS` as the same event.
They are not. `src/reactions.js` scores each class separately, against its own
baseline:

| class | why it matters |
|---|---|
| `clipit` | chat literally asking for a clip — the highest-precision signal there is, and it gets its own path to nominating a moment even when message rate barely moves |
| `funny` | travels furthest off Twitch, because it needs no context |
| `hype` | high ceiling, short shelf life |
| `tension` | needs setup, which a 15-second vertical cut cannot carry |
| `shock` | strong but often ambiguous |

Plus two structural signals: **unique chatters** (the whole room reacting is a
different event from four people spamming) and **copypasta ratio** (a meme
forming is the best predictor that a moment will leave the platform).

If three or more watched channels spike within the same ten seconds, the moment
is marked **shared** and discounted by half: that is the game doing something,
not the streamer, and every clipper in the category will have it within minutes.

### The scoreboard

```bash
npm run eval
```

Every moment, clip and poll is written to `data/feed.db` (`node:sqlite`, which
is in the Node standard library — the zero-dependency rule still holds). The
clips of moments already seen are re-polled at 15m, 1h, 6h and 24h, which gives
two labels worth having:

- **views at 24h** — did the clip perform?
- **lead time** — seconds between the first clip and the first clip by a
  *different* creator. One person making four clips of their own moment is one
  person, not competition, and counting it otherwise would flatter every number.

`npm run eval` prints precision@20 against the top decile by views, next to
what chance alone would have given you. **Lift above 1.0 means the ranking is
doing something.** Nothing that claims to improve detection ships without
moving that number — including the reaction weights in `src/reactions.js`,
which are a starting position rather than a result.

#### It refuses to score a small sample, on purpose

`eval` prints nothing until a horizon has **100 moments with an outcome**, and
that floor is not caution — below it the number is arithmetic, not evidence.
Two artifacts bite at small populations, measured on synthetic perfect-vs-blind
rankings:

| population | perfect ranking | blind ranking |
| --- | --- | --- |
| 20 (= topN) | 1.00x | 1.00x |
| 40 (= 2 x topN) | 2.00x | 2.00x |
| 60 | 3.00x | 1.50x |
| 100 (= 5 x topN) | 5.00x | 1.00x |

At or below `topN` every moment is already inside the "top 20", so precision is
the base rate and lift is exactly 1.0 **however good the ranking is** — a
flawless ranking reads as "does not beat chance". A little above it the top 20
is half the field and catches the winners by coverage alone, so a *blind*
ranking scores full marks. Only from 5 x topN do the two separate cleanly, so
that is where the floor sits. Reporting a number before then would retire a
working signal, or bless a worthless one, on the strength of the sample size.
`src/eval.test.js` pins all three cases.

For the same reason the lift is printed against its ceiling — `4.50x of a
possible 6.00x` — because the winners set is a decile of the population, so the
best achievable lift is itself a function of how much data there is (6x at 120
moments, 10x at 200+). A bare "2.00x" hides whether that was most of what the
sample could show or barely any of it.

With no history at all it says so, rather than printing a confident zero.

### What is kept, and what is not

**No chat is stored.** Messages are folded into per-bucket counts as they
arrive and the bucket is dropped every ten seconds — the store has no column
that could hold a message, and nothing in a bucket summary can be turned back
into what anybody said. At launch volume that is a great deal of text not kept,
and retained chat logs are a liability with no upside: every signal here is
derivable live.

`observations` (one row per moment per poll, around 300 a minute at a 30s
cadence with 150 moments) is pruned to `STORE_PRUNE_DAYS`, except for the
earliest row of each moment, which is what the feed claimed while the moment
was still actionable and therefore what `eval` reads.

`moments`, `clips` and `outcomes` are never pruned. They are what the clipper
index gets built from, they cannot be re-collected after the fact, and they are
small: a measured launch-scale poll of 150 moments and 669 clips writes in one
transaction in under 3ms.

The schema carries a `user_version`, so a later phase can add columns without
throwing away data that cannot be collected twice.

## How a moment gets ranked

```
heat        = log1p(clips per minute) * 2  +  chat z-score
recency     = exp(-minutes since the last clip / 12)
opportunity = heat * recency / (1 + saturation) ^ 0.9
```

The `log1p` matters more than it looks. Clip velocity *is* saturation divided
by span, so feeding raw velocity into the numerator while dividing by
saturation lets the two cancel — the score then climbs with clip count, which
is precisely backwards. A test caught that. Log keeps velocity as evidence the
moment is real while growing far too slowly to out-argue the crowding penalty,
so more clippers on a moment always lowers its rank.

Chat enters raw, because it is the only input independent of how many people
have already clipped.

| state | clips | meaning |
| --- | --- | --- |
| `fresh` | 1–2 | proven interesting, basically untouched |
| `warm` | 3–6 | a few people are on it |
| `flooded` | 7+ | you are late |

Deep links start 20 seconds early (`LEAD_IN_SECONDS`), because chat reacts
after the thing happens and so do clippers.

## Chat scoring

A robust z-score against each channel's **own** recent pace:
`(count − median) / MAD`, in 10-second buckets over 5 minutes of history.

Median and MAD both ignore the spikes themselves, so a channel that pops
repeatedly doesn't quietly raise its own bar and stop detecting its own
moments. Because the score is in units of that channel's volatility, one
threshold works for a 200k-viewer channel and a 2k-viewer one at once — where a
flat "3× busier than usual" fires constantly on a small chat and never on a
large steady one.

Chat is read over pooled anonymous IRC (`justinfan` nicks, 18 channels per
socket, joins paced to Twitch's ~20-per-10s limit). No account, no token, no
quota.

## Known limits

Worth reading before launch night rather than during it.

- **Twitch sorts `/helix/clips` by view count, not creation time.** Over a
  short window that barely matters — brand-new clips all sit near zero views —
  but a truncated result drops the quietest clips first. The feed reports
  truncation instead of hiding it; raise `CLIP_MAX_PAGES` or shorten
  `CLIP_WINDOW_MINUTES` if you see it.
- **VOD position lags.** For a minute or two after a clip is made, Twitch
  hasn't published its `vod_offset`. Those cluster on creation time instead and
  are marked "VOD position pending" — coarser, but it keeps the freshest
  moments in the feed rather than dropping them.
- **Launch week compresses the chat signal.** Every GTA 6 chat will sit at
  maximum excitement for days, so baselines rise everywhere and spikes get
  harder to separate exactly when it matters. Clip-creation rate degrades far
  more gracefully, which is the other reason it's the primary signal.
- **Twitch only.** Kick has no official public API and is hostile to scraping;
  YouTube's live chat API burns quota per poll. Both are deliberately out.
- **Saturation is Twitch-native only.** It counts clips made *on Twitch*. It
  does not know whether a moment has already flooded TikTok — that's a leading
  indicator of flooding, not a measure of it.
- **A clip is only as good as the VOD.** If the broadcaster has VODs disabled,
  or the moment is in a muted or already-deleted segment, the cut fails with
  whatever Twitch says about it. Nothing can be done from this end.
- **Rockstar removes story and spoiler clips**, including after launch, and
  in-game radio music triggers Content ID. Both are reasons to watch what you
  cut, and neither is something the tool can detect for you.
- **The feed is not verified against live data.** Every path has been exercised
  against the demo fixture and the clustering and ranking are covered by tests,
  but no run against a real category has happened yet. The first real run is
  the real test. (Clipping is the exception: it has been run end to end against
  a real public VOD and produces a playable mp4 of exactly the requested
  length.)

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated list.

`GAME_NAME` is the only field that needs changing to point the whole thing at a
different game. The engine is category-agnostic; GTA 6 is the wedge, not the
product.

## Layout

```
src/twitch.js   Helix client — app token, rate limits, pagination
src/moments.js  clustering + the ranking formula (the product)
src/chat.js     pooled anonymous IRC, per-class median/MAD spike scoring
src/reactions.js what chat is reacting WITH — the class table
src/store.js    node:sqlite persistence + outcome recording
src/eval.js     the scoreboard: does the ranking beat chance?
src/feed.js     polling loops and current state
src/clip.js     VOD section download + 9:16 render (yt-dlp/ffmpeg)
src/clipjobs.js in-memory clip queue, two at a time
src/shortform.js caption, 9:16 render with text, post copy
src/autoclip.js which moments to cut, and cutting them
src/automation.js channel automation: the panel's channels, switch, shorts
src/retention.js deletes shorts nobody downloaded, after SHORTS_KEEP_HOURS
src/uploader.js auto upload: which shorts, when, and every way one can fail
src/youtube.js  YouTube sign-in and resumable upload, through the owner's app
src/recopy.js   npm run recopy: rewrite the post copy of shorts already made
src/archive.js  where a live channel is recording, and its game, without credentials
src/live.js     recording a live stream with no VOD, and cutting from it
src/transcribe.py speech to timed words (faster-whisper), for subtitles and titles
src/facecam.py  where the streamer's webcam is in a clip (OpenCV YuNet)
src/engagement.js the engagement meter, and choosing the window for a redo
src/validate.js checks every short passes before it is ready
src/lock.js     one copy of the app at a time
src/auto.js     npm run auto: channel automation, headless
src/server.js   HTTP + static
src/demo.js     fixture, pushed through the real pipeline
src/check.js    one-shot smoke test
public/         the feed UI
```

```bash
npm test
```

## Not built yet

The data this accumulates — who found a moment first, before it saturated, and
what it went on to do — is an un-fakeable record of which clippers are actually
early. That's the part worth selling, and it isn't here yet.

## History

This repo previously held `clipper.py`, a multi-channel chat-spike clipper with
a DVR ring buffer and ffmpeg cutting. It was removed when the project narrowed
to saturation, but it is not lost — it's at commit `bd1ceec`:

```bash
git show bd1ceec:clipper.py > clipper.py
```

Its median/MAD scoring is the direct ancestor of `src/chat.js`.

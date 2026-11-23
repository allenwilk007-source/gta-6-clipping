# Running it, and moving it to another machine

`README.md` explains how the thing works and why. This is the short version
for getting it running again somewhere else, and keeping it running.

## What it does, in one paragraph

It watches public Twitch streams for a game, notices when chat reacts to
something, cuts that moment out of the stream's VOD into a vertical short with
a caption and a credit line, and — once you connect an account — uploads it to
your own YouTube, TikTok or Instagram. A dashboard at `http://localhost:3000`
shows what it is finding, what is queued, and what each connected account has
posted. Nothing is posted to any account but the ones you sign in to yourself,
every clip credits and links back to the stream it came from, and the posting
goes through each platform's official API.

## What does NOT travel with the repository

This is the part that matters when you switch machines. Cloning gets you the
code and nothing else, on purpose:

| Not in git | What it holds | How to get it back |
| --- | --- | --- |
| `.env` | every key and secret | re-create it, see below |
| `data/youtube-token.json` | the YouTube sign-in | press Connect on the dashboard |
| `data/tiktok-token.json` | the TikTok sign-in | press Connect on the dashboard |
| `data/instagram-token.json` | the Instagram sign-in | press Connect on the dashboard |
| `data/feed.db` | every moment and outcome ever recorded | starts empty; it re-fills |
| `data/uploads.json` | which platforms are on, and any hold | defaults to off |
| `data/kept.json` | shorts you pressed Download on | starts empty |
| `clips/` | the videos themselves | re-cut from live streams |

**Copy `.env` across by hand**, on a USB stick or however you move a file you
would not email. Do not commit it. Everything else can be rebuilt by signing
in again, and the sign-ins have to be redone on a new machine anyway.

## Standing it up

You need **Node 22 or newer** (`package.json` asks for `>=22`; this machine
runs 24), **ffmpeg** on PATH, and **yt-dlp** on PATH.

`npm run doctor` checks all three, and the rest of the setup besides — the
keys, the folders, the port, and whether the dashboard is asking for a
password. It prints what is missing and where to get it, names no secret by
value, and exits non-zero if something will actually stop it running. Run it
first on a new machine and after any change to `.env`.

```bash
git clone https://github.com/allenwilk007-source/gta-6-clipping.git
cd gta-6-clipping
# put .env here
npm run doctor    # is this machine ready? says what is missing and where to get it
npm test          # 501 tests, no network needed
npm start         # http://localhost:3000
```

There are no npm dependencies to install. That is deliberate — the whole thing
runs on what Node ships with, so there is nothing to go stale.

## The settings that matter

Everything lives in `.env`. The full list is in `README.md`; these are the ones
you will actually touch.

### Getting anything at all to happen

| Setting | What it does |
| --- | --- |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | register an app at dev.twitch.tv. Without these it can still watch chat, but it cannot see clips or streams |
| `GAMES` | the game(s) to watch, by name |
| `WATCH_CHANNELS` | channels to watch, comma separated |
| `AUTOCLIP` | `off` stops it cutting anything |

### Posting

| Setting | What it does |
| --- | --- |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | a Google Cloud OAuth client, YouTube Data API v3 enabled, your account on its test-user list |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | a TikTok developer app. **The sandbox has its own pair** — they are not the production ones, and mixing them gives `Client key or secret is incorrect` |
| `TIKTOK_REDIRECT_URI` | must be `https://`, so it needs a tunnel on a local machine |
| `YOUTUBE_SPACING_MINUTES` | minutes between YouTube posts (default 180) |
| `TIKTOK_SPACING_MINUTES` | minutes between TikTok posts (default 280) |
| `YOUTUBE_PER_DAY`, `TIKTOK_PER_DAY` | the daily ceiling this tool keeps for itself |

### Disk

| Setting | What it does |
| --- | --- |
| `SHORTS_KEEP_HOURS` | how long an un-downloaded short survives in `clips/ready` (default 6; `0` keeps everything) |
| `CLIPS_KEEP_HOURS` | how long anything survives in `clips/shelved` and `clips/rejected` (default 24) |
| `RECORDING` | `off` stops recording live streams, which is the thing that eats a disk |

### Shutting the dashboard

| Setting | What it does |
| --- | --- |
| `DASHBOARD_PASSWORD` | empty means the page is open, which is right on localhost and wrong the moment it is reachable from outside. Any username; `/terms`, `/privacy` and the TikTok signature file stay public because TikTok reads them |

## Limits that are not ours

These are the platforms', and no setting changes them:

- **YouTube** refuses further uploads once the *account's* own daily limit is
  reached. It is separate from the API quota, it is not published anywhere, and
  it arrives as `The user has exceeded the number of videos they may upload`.
- **TikTok** allows **5 pending inbox drafts in a rolling 24 hours**. Uploads
  arrive as drafts you caption and post from the app; posting faster does not
  get you more, it gets you to the ceiling sooner. Posting straight to a profile
  needs TikTok's review, which needs a demo video of the integration.
- **Instagram** needs a Professional account linked to a Facebook Page, and a
  Meta app. It allows 50 posts in a moving 24 hours.
- **Twitch VODs** expire in 14-60 days. A clip whose VOD has gone cannot be cut.

## When something looks broken

| What you see | What it usually is |
| --- | --- |
| `No TikTok keys in .env` on a connected account | you are on an old build; `/api/stats` used to answer only for YouTube |
| `Client key or secret is incorrect` | sandbox key with production secret, or the reverse |
| Nothing posting, `waitingFor: spacing` | working as configured; look at `nextAt` |
| Nothing posting, no error | check `mode` is `on` — connecting an account does not turn posting on |
| A short with nothing happening in it | the content checks only reject decode errors, frozen video, black video and total silence |

## One copy at a time

`data/app.lock` stops two copies running at once. If it is left behind by a
crash, the message tells you which process held it.

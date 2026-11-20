# Connecting TikTok, YouTube and Instagram

The panel's TikTok, YouTube and Instagram buttons can only put a finished short
straight onto a platform through that platform's own API, and each API needs a
**developer app** registered by the account owner. That part is yours: only you
can sign in to the consoles, and the keys belong to your accounts. Once a set of
keys is in `.env`, the upload for that platform gets built and tested against
your real account.

**Never paste keys or secrets into a chat.** Put them in `.env` only. It is
git-ignored and never leaves this PC.

Do **YouTube first**. It is the only one whose sign-in can come back to
`http://localhost`, so it can be built and tested end to end on this machine.
TikTok and Instagram want an `https://` return address, which needs one more
piece of setup (see their sections).

Console labels move around. If a step's wording does not match exactly, look
for the nearest equivalent.

---

## YouTube (start here)

1. Open **console.cloud.google.com** and create a project, say "Clip poster".
2. **APIs & Services → Library**: search for **YouTube Data API v3** and
   enable it.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - Audience: **External**. Leave it in **Testing**.
   - App name and support email: anything you like.
   - Data access / scopes: add `https://www.googleapis.com/auth/youtube.upload`.
   - Test users: **add your own Google account**, the one that owns the channel.
4. **Clients → Create client**:
   - Application type: **Web application**.
   - Authorized redirect URI: `http://localhost:3000/auth/youtube/callback`
5. Copy the **Client ID** and **Client secret** into `.env`:

   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   ```

What to expect:

- **Uploads stay private** until Google audits the project, which you request
  through the YouTube API Services audit form. Until then the button uploads
  the short as a private video with its title, description and tags, and opens
  it in YouTube Studio. You can review it there; making it public needs the
  audit.
- **Daily quota.** The default is 10,000 units a day, and one upload costs
  1,600, so about six uploads a day. More needs a quota increase request.
- While the app is in Testing, the sign-in lasts **7 days**, then you click
  Connect again.

---

## TikTok

1. Open **developers.tiktok.com**, log in with your TikTok account, and go to
   **Manage apps → Connect an app**.
2. Add the products **Login Kit** and **Content Posting API**.
3. Ask for the scopes **`user.info.basic`**, **`user.info.stats`**,
   **`video.list`** and **`video.upload`**. The first three are for the stats
   dashboard; `video.upload` is the one that posts.

   `video.upload` sends a short to your TikTok **inbox as a draft**: you get a
   notification in the app, open it, add a trending sound if you want one, and
   post. Sounds added in the app are the ones that actually ride a trend.

   The other endpoint, `video.publish`, posts straight to the profile with no
   tap — but the app must be approved for that scope **and pass TikTok's
   audit**, and until it does TikTok restricts everything an unaudited client
   posts to private viewing. So this tool uses the inbox. It does not try to
   get around the audit.
4. Redirect URI: `http://localhost:3000/auth/tiktok/callback`.

   TikTok's form asks for `https://` and may refuse the line above. If it
   does, give it an `https://` address you control, and put the same one in
   `.env` as `TIKTOK_REDIRECT_URI=` — it has to match character for character
   or the sign-in fails at the last step.
5. Copy the **Client key** and **Client secret** into `.env`:

   ```
   TIKTOK_CLIENT_KEY=...
   TIKTOK_CLIENT_SECRET=...
   ```
6. Restart `npm start`, then press **Connect** next to TikTok in the page and
   approve it in TikTok. After that, set the TikTok switch to **Dry run** for a
   day to see which shorts it would send, or straight to **On: send drafts**.

   TikTok allows **5 pending inbox shares in any rolling 24 hours** — rolling,
   not a calendar day, so the slot frees up 24 hours after each one. Going
   above 5 just earns a refusal, which is why `TIKTOK_PER_DAY` defaults to 5.

   Because the inbox endpoint has no caption field, the caption this tool
   would have written — hook, credit and the link back to the stream — is
   written to the log for you to paste when you finish the post.

---

## Instagram

**Read this first — it corrects earlier advice in this file.** Instagram has
two API flavours, and the simpler one cannot be used here:

| Flavour | Needs a Facebook Page? | Can it post a file from this PC? |
| --- | --- | --- |
| Instagram API with **Instagram Login** | No | **No.** Publishing takes a `video_url` that Meta's servers fetch: "the media must be hosted on a publicly accessible server at the time of the attempt". |
| Instagram API with **Facebook Login** | Yes | **Yes** — it accepts the bytes directly. |

So the Facebook Page is not a formality to skip. Without it the only way to
post would be to publish every clip to the open internet first, so that Meta
could download it back. That is why the setup below is the longer one.

1. In the Instagram app, switch your account to **Professional** (Creator or
   Business): Settings → Account type and tools.
2. Link it to a **Facebook Page** you administer. In Instagram: Settings →
   Account → Sharing to other apps → Facebook. Create a Page if you have none;
   it needs no content, it is only the connection Meta requires.
3. Open **developers.facebook.com → My Apps → Create app**, pick the
   **Business** type, and add **Instagram → API setup with Facebook login**.
4. Permissions: `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_read_engagement`.
5. Under **Facebook Login → Settings**, add the redirect URI
   `http://localhost:3000/auth/instagram/callback`. If Meta refuses a plain
   `http://` address, use an `https://` one you control and set the same value
   in `.env` as `INSTAGRAM_REDIRECT_URI=`.
6. Copy the **app ID** and **app secret** into `.env`:

   ```
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   ```
7. Restart `npm start` and press **Connect** next to Instagram in the page.

What to expect: Instagram publishes for real — no draft step, unlike TikTok —
and the caption with the credit line and stream link goes out with the Reel.
The cap is **50 posts in a moving 24 hours**; `INSTAGRAM_PER_DAY` defaults to
45. That is a lot of Reels a day, and the API allowing it does not mean it is
good for the account, so lower it if reach matters more than volume.

Two things that are **not confirmed** and will only be settled by trying:

- Meta says "If your app only serves your Instagram professional account or an
  account you manage, Standard Access is all your app needs", then warns that
  some features may need Advanced Access (which requires App Review and
  Business Verification). Whether publishing works without review is not
  stated outright.
- Page Publishing Authorization may have to be completed on the Page before it
  will publish anything.

If Connect fails, the message says which step: no Page, no Instagram account
linked to the Page, or not enough rights on the Page.

---

## One channel per game

The feed watches every category in `GAMES` at once, and by default a connected
channel is offered all of them. A channel that is about one game should say so:

```
GAMES=Grand Theft Auto VI,Fortnite,Escape from Tarkov
YOUTUBE_GAMES=Escape from Tarkov
```

That sends only Tarkov shorts to the connected YouTube channel, while TikTok
and Instagram — with no list of their own — still see all three.

Two things this does **not** do, both worth knowing before you rely on it:

- **It narrows, it cannot widen.** A game missing from `GAMES` is never
  clipped, so it reaches no queue whatever `YOUTUBE_GAMES` says. Add it to
  `GAMES` first.
- **It is not per-channel routing.** The sign-in is one token in
  `data/youtube-token.json`, so there is exactly one YouTube channel at a time.
  To post GTA to one channel and Tarkov to another you would need two copies of
  this tool with their own `data/` folders — not one copy with two channels.

Spell the game exactly as Twitch spells it, including the lowercase "from" in
`Escape from Tarkov`; the match is case-insensitive but the name must otherwise
be the same, because it is compared against the game the short recorded about
itself.

---

## When the keys are in

All three are built. The steps below are YouTube's; TikTok and Instagram
work the same way from their own Connect buttons once their keys are in.

1. Restart the app. The panel's **Auto upload** box shows YouTube.
2. Click **Connect**. Google asks you to sign in and allow uploads to your
   channel, then sends you back to the page. The sign-in is kept in
   `data/youtube-token.json` (git-ignored). While the Google project is in
   Testing, it lasts 7 days; when it lapses, uploads stop and the box says
   so — click Connect again.
3. Set the mode to **Dry run** first. Everything happens except the upload:
   it picks, checks and titles shorts at the real pace, and writes each one
   to `data/upload-dry-run.jsonl`. Read a day of that before going live.
4. Set it to **On**. From then on, about every three hours it uploads the
   best short it has, up to five a day.

What it posts, and what it never does:

- **It chooses.** The pipeline makes dozens of shorts a day; YouTube takes
  about six. Only shorts above the engagement meter's keep line, never one
  flagged weak, best score first. The rest stay in `clips/ready` for you.
- **It checks again at post time.** The video is decoded and checked, its
  game must be one you clip, and its title and tags are rebuilt from its own
  recorded game. `clips/rejected` is never read.
- **Never twice.** Each short is claimed before its upload starts, and the
  claim survives restarts. An upload cut off by a crash is not retried —
  it may have landed — and the box tells you to check the channel.
- **Failures:** quota spent stops uploads until midnight Pacific (YouTube's
  day, not a rolling 24 hours); a lapsed sign-in stops them until you
  reconnect; a video YouTube refuses is never tried again; only a network or
  server error is retried, after the spacing.
- **Nothing pretends to be a person.** Spacing is even, the API is YouTube's
  own, and the account is yours, signed in by you.

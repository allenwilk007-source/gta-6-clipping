# Privacy Policy

**Last updated: 23 November 2026**

This policy covers **clip dashboard**, licensed software that runs on its
operator's own computer. It is not a hosted service, it has no servers, and no
copy has any users other than the operator running it.

If you are reading this because a platform's consent screen linked you here:
the application you are about to authorise is the operator's own copy, running
locally, requesting access to the operator's own account.

## Who runs this

You do. Each copy is run by its own operator, on their own computer, against
their own platform credentials. There is no shared infrastructure and no
account anybody else signs into. The author of the software operates nothing,
hosts nothing, and receives none of the data described below — not the clips,
not the tokens, not the statistics, not a log that you ran it.

Everything this file claims is checkable rather than merely promised: the
source for every behaviour described below is handed to each licensee and can
be read and audited. It is licensed rather than public, so the reader is the
operator instead of anyone at all.

## What it accesses, and why

With the operator's authorisation, it reads from the operator's **own**
connected accounts:

| Platform | What it reads | Why |
| --- | --- | --- |
| TikTok | Profile basics (open id, avatar, display name), account statistics (followers, following, likes, video count), and the list of the operator's own public videos with their view, like and comment counts | To show the operator how their own posts are performing |
| TikTok | — | With `video.upload`, it sends a video to the operator's own TikTok inbox **as a draft**, for the operator to review and post themselves |
| YouTube | The operator's own channel totals and their own videos' statistics; uploads to the operator's own channel | The same, for YouTube |
| Instagram | The list of Facebook Pages the operator administers, and the id and username of the Instagram professional account linked to one of them | To know which account to post to. Instagram's API reaches a professional account through its linked Page; there is no other route that can post a file from this computer |
| Instagram | — | With `instagram_content_publish`, it uploads a video as a Reel to that account, with a caption |
| Twitch | Public stream and clip metadata, and public chat messages in public channels | To find moments worth clipping |

It does **not** request access to anyone else's account, to direct messages,
to contacts, to followers' identities, or to anything private.

## Where that data goes

**Nowhere.** It stays on the operator's computer, in a local SQLite database
and in files on disk.

The dashboard that reads it answers only on the operator's own machine. It
can be opened to a local network deliberately, by setting `HOST`, and doing so
requires a dashboard password: it will not start as an open page on a network.

There is no backend. Nothing is uploaded to a server belonging to this
project, because no such server exists. There is no analytics, no telemetry,
no crash reporting, no advertising, and no third-party SDK of any kind.

Data is not sold, rented, shared or disclosed to anyone, because there is
nobody to disclose it to.

The only network connections it makes are directly to the platforms named
above and to the APIs it has been authorised to use. In full, that is:
`twitch.tv` and its media hosts (`*.ttvnw.net`), `googleapis.com` and
`accounts.google.com`, `tiktok.com`, and `facebook.com` and its Instagram
endpoints.

Some of those are made on a timer rather than on a click: while it is watching,
it polls Twitch for who is live, and while it is recording a channel it fetches
that stream continuously. Nothing is sent anywhere by either.

## Access tokens

Authorising an account gives this tool a token. Tokens are written to files on
the operator's own disk, and are used only to make the API calls described
above.

Those files are created owner-only. On Linux and macOS that is enforced by the
filesystem. **On Windows it is not:** the operating system takes its
permissions from the containing folder, so the token is readable by anything
running as that user. The file sits in the account's own profile, which is the
same protection the browser's saved passwords have, and no more.

Tokens are never transmitted anywhere except back to the platform that issued
them.

## Twitch clips and other people's content

The tool downloads sections of public Twitch broadcasts and renders them as
short videos on local disk. Those are recordings of other people's streams.
The operator is responsible for what they do with them, including whether and
where they publish them, and for complying with the rights of the broadcasters
concerned. See [TERMS.md](TERMS.md).

Public chat messages are read to measure how much chat is reacting. Message
text is summarised into counts and then discarded; raw chat text is not stored.

## Retention and deletion

Everything lives in the project folder on the operator's computer.

- **Shorts:** a short the operator has not downloaded is deleted from
  `clips/ready` 6 hours after it was made (`SHORTS_KEEP_HOURS`). Downloaded
  shorts stay until the operator deletes them.

- **To delete the collected data:** delete the `data/` and `clips/` folders.
- **To revoke access:** disconnect the app in the platform's own settings
  (TikTok: Settings → Security and permissions → Manage app permissions;
  Google: myaccount.google.com → Data and privacy → Third-party apps;
  Instagram and Facebook: facebook.com → Settings → Business integrations),
  and delete the token files in `data/`.

Revoking on the platform side immediately stops this tool from being able to
read anything, whether or not the local files are deleted.

## Children

This is a tool for managing an adult's own content accounts. It is not
directed at children and collects nothing from them.

## Changes

This file is version-controlled in the repository linked above; its history is
the change log.

## Contact

Through the repository's issue tracker:
<https://github.com/allenwilk007-source/clipper_tvv/issues>

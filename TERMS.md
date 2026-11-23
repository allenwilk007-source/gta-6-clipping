# Terms of Service

**Last updated: 23 November 2026**

**clip dashboard** is licensed software that runs on its operator's own
computer. It is not a hosted service: there is no server anybody else logs
into, and each copy has no users other than the operator running it. The source
is given to every licensee, because the thing cannot be configured or audited
without it, but it is not open source — see `LICENSE`.

These terms describe the basis on which it is provided. They sit alongside
`LICENSE`, which says what a licence covers; where the two speak to the same
thing, `LICENSE` governs what you may do with the software and this file
governs what you are responsible for when you use it.

## What it does

It watches public Twitch streams to find moments worth clipping, cuts short
videos from them to local disk, and — once connected — reads the operator's
own TikTok and YouTube account statistics and can send videos to the
operator's own TikTok, YouTube and Instagram accounts.

A TikTok upload arrives as a draft the operator posts themselves; YouTube and
Instagram uploads are published directly.

## No warranty

The software is provided **as is, without warranty of any kind**, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose and non-infringement. The author is not
liable for any claim, damages or other liability arising from the software or
its use.

Nothing about it is guaranteed to keep working. It depends on third-party APIs
that may change or withdraw access at any time.

## The operator is responsible for what they publish

This is the part that matters most, so it is stated plainly.

The tool downloads sections of **other people's** public broadcasts and renders
them into short videos. It does not acquire any rights in that footage, and it
cannot grant any to the operator.

The operator is solely responsible for:

- whether they have the right to publish a given clip;
- crediting the broadcaster, which the generated post text does by default;
- complying with Twitch's Terms of Service, and with the terms of any platform
  they publish to;
- any copyright claim, strike or dispute arising from what they post.

The tool writes a credit line and a link back to the original stream into the
text beside every clip. Removing them is the operator's choice and their
responsibility.

## Platform rules

Using this tool does not exempt anyone from the rules of the platforms it
connects to. The operator must comply with TikTok's, YouTube's, Meta's and
Twitch's terms, developer policies and community guidelines.

The tool connects to those platforms **only through their official APIs**, with
credentials the account owner has granted. It does not automate any platform's
website or app, does not disguise automated access as human activity, does not
rotate accounts or addresses, and does not attempt to work around any limit,
block or review. That is a deliberate design boundary, not an oversight, and it
is documented in `docs/detection-plan.md`.

## Acceptable use

Do not use this software to harass anyone, to republish content you have no
right to, to impersonate anyone, or to evade a platform's enforcement. If a
platform tells you to stop, stop.

## One copy, one operator

A licence covers one operator and the accounts that operator owns or is
authorised to act for. Running it for other people's accounts as a service or
an agency offering, or passing a copy to anyone else, needs a licence that says
so in writing. `LICENSE` has the detail.

## Changes

This file is version-controlled; its history is the change log.

## Contact

Through the repository's issue tracker.

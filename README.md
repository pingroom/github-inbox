# PingRoom GitHub Inbox

Your GitHub notifications, on your phone, as [PingRoom](https://pingroom.io)
Pings: an @mention, a review request, an issue assigned to you, in any
repository.

GitHub sends repository events as webhooks, but not a person's notifications.
Those are only available from an API you poll. This is a small Cloudflare
Worker that does the polling with your token and sends each new notification
to a PingRoom room.

```
GitHub /notifications  <--GET every minute--  this Worker  --POST-->  https://api.pingroom.io/api/webhooks/{roomCode}/{secret}
```

It is self-hosted and belongs to one person: you deploy it to your own
Cloudflare account, and it holds one GitHub token and one room's webhook URL.
Your token never passes through PingRoom.

## Setting it up

You need Node 20 or later, a Cloudflare account (the Workers free plan is
enough), and the PingRoom app ([install](https://pingroom.io/i)).

1. **A GitHub token.** Create a **classic** personal access token with only the
   **notifications** scope: GitHub Settings, Developer settings, Personal access
   tokens, Tokens (classic), Generate new token (classic), or open
   <https://github.com/settings/tokens/new?scopes=notifications&description=PingRoom%20inbox>.
   GitHub's notifications API does not accept fine-grained tokens. The scope
   also allows marking notifications read and changing subscriptions; this
   Worker never does either.
2. **A room.** In PingRoom, open the room the Pings should go to, add an
   incoming webhook (room settings, Webhooks), and copy its URL:
   `https://api.pingroom.io/api/webhooks/ROOMCODE/SECRET`.
3. **Deploy**, then set both secrets. Each `secret put` asks for the value.

   ```sh
   git clone https://github.com/pingroom/github-inbox.git
   cd github-inbox
   npm install
   npx wrangler deploy
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put PINGROOM_WEBHOOK_URL
   ```

Within a minute the room gets **GitHub inbox connected**. From then on each new
notification arrives as a Ping. Nothing that was already in your inbox is sent.

If nothing arrives, `npx wrangler tail` shows what the Worker is doing.

## What you get

| Reason | Title |
|---|---|
| `mention` | You were mentioned · mobile#42 |
| `team_mention` | Your team was mentioned · mobile#42 |
| `review_requested` | Review requested · mobile#7 |
| `assign` | Assigned to you · mobile#42 |
| `approval_requested` | Approval requested · mobile |
| `security_alert` | Security alert · mobile |
| `author`, `comment`, `manual`, `state_change` | Update · mobile#42 |
| `invitation`, `agent_session_finished`, `member_feature_requested`, `security_advisory_credit` | their own short label |
| `subscribed`, `ci_activity` | Update, Workflow run (off by default) |

The message is the issue or pull request title and who wrote the latest
comment, with the comment's first words (quoted lines and HTML comments left
out), for example `Fix the cooldown · sam: can you look at the retry logic?`. A
review request, approval request, security alert or invitation shows the author
instead of a comment. The button opens the comment, issue, pull request,
release or run on github.com.

- **Which reasons.** By default every reason except `subscribed` (every thread
  in every repository you watch) and `ci_activity` (every workflow run you
  trigger). Set `GITHUB_REASONS` to `all`, or to a list such as
  `mention,team_mention,review_requested,assign`, in `wrangler.toml`:

  ```toml
  [vars]
  GITHUB_REASONS = "mention,review_requested"
  ```

- **Only unread, only new.** A notification you read on GitHub before the next
  poll is not sent. A thread is sent again only when it has new activity.
- **Bursts.** Up to five new notifications in one poll are sent one by one. More
  than five: the four most important (mentions, team mentions, review requests,
  assignments first) one by one, and one **N more on GitHub** Ping for the rest.
- **Cooldown.** A PingRoom webhook takes one Ping per cooldown, 5 seconds by
  default. The Worker waits it out between Pings. Lower the webhook's cooldown
  (0 to 60 seconds, in the webhook's settings) if bursts feel slow.
- **When something is wrong.** A token GitHub refuses (wrong, expired, revoked,
  or fine-grained) gets one urgent **GitHub inbox stopped** Ping saying why, not
  one a minute. A Ping PingRoom cannot take (unreachable, a 5xx, the room or
  webhook missing or disabled) is kept and retried every minute for up to a day,
  under the same `Idempotency-Key`, so a retry never sends it twice. A Ping
  PingRoom refuses as invalid is dropped.

## Configuration

| Name | Kind | |
|---|---|---|
| `GITHUB_TOKEN` | secret, required | Classic personal access token with the `notifications` scope |
| `PINGROOM_WEBHOOK_URL` | secret, required | The room's incoming webhook URL |
| `GITHUB_REASONS` | var, optional | `all`, or a comma-separated list of reasons. Unset: all but `subscribed` and `ci_activity` |
| `PINGROOM_API_BASE` | var, optional | The PingRoom origin, default `https://api.pingroom.io`. Set it only for your own PingRoom API; `PINGROOM_WEBHOOK_URL` must be on it |

Secrets go through `wrangler secret put`, never `[vars]`, which is plain text
and committed.

## What it does and does not do

- With your token it calls only `https://api.github.com`. A URL taken from a
  GitHub response is fetched only if it is on that origin, and redirects are not
  followed. It calls PingRoom only at `PINGROOM_API_BASE`.
- It polls the way GitHub asks: once a minute at most, never more often than
  GitHub's `X-Poll-Interval`, and with `If-Modified-Since`, so a quiet inbox is
  a `304` that does not count against the rate limit. It waits out a rate limit.
- It changes nothing on GitHub. Nothing is marked read.
- Its state lives in one Durable Object, so two runs cannot both send a thread.
  It holds a hash of the token, the id and update time of threads changed in
  the last two hours, and up to 20 Pings PingRoom has not yet taken. It never
  stores the token or the webhook URL. A new token starts over, with a new
  "connected" Ping.
- It writes status lines (`npx wrangler tail`): counts and status codes, never
  the token, the URL or notification text.
- It has no HTTP surface: no route, no workers.dev address, no fetch handler.
  It only runs on its schedule.

## Developing

```sh
cp .dev.vars.example .dev.vars   # then fill in the two values
npm run dev                      # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # run one poll
npm test
npm run typecheck
```

The tests run the poller against a fake GitHub and a fake PingRoom: the first
poll, the exact Ping for each kind of thread, conditional polling and
`X-Poll-Interval`, the reason filter, bursts, the cooldown, retries and expiry,
token problems, rate limits, and that the token goes nowhere but
api.github.com. No test touches the network.

GitHub's reference for `GET /notifications` (read 2026-11-26) has no example
body, so the test threads are built from its field list. GitHub documents
`subject.url` and `latest_comment_url` as always present; the Worker also
handles them missing.

## License

MIT. See [LICENSE](LICENSE).

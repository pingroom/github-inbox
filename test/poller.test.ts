/**
 * The poller against a fake GitHub and a fake PingRoom. Nothing
 * here touches the network: every fetch goes to the router below, and a
 * request to any other host fails the test.
 *
 * The thread objects follow the fields GitHub's REST reference lists for
 * GET /notifications (read 2026-11-26); the page has no example body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxPoller, isoSeconds, PENDING_TTL_MS, STATE_KEY, type InboxState, type StateStore } from "../src/poller";
import type { InboxEnv } from "../src/config";
import { fallbackUrl, numberOf } from "../src/format";
import { parseThread } from "../src/github";

const API = "https://api.pingroom.io";
const ROOM = "ABCDEF123456";
const SECRET = "Abc123_xyz-0987654321ABCDEFghijklmn";

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const WEBHOOK_URL = `${API}/api/webhooks/${ROOM}/${SECRET}`;
const GH = "https://api.github.com";
const T0 = Date.parse("2026-11-26T10:00:00Z");

class MemoryStore implements StateStore {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}

interface ThreadInput {
  id: string;
  reason: string;
  at: string;
  title?: string;
  type?: string;
  subjectUrl?: string | null;
  commentUrl?: string | null;
}

function thread(input: ThreadInput): Record<string, unknown> {
  const subjectUrl = input.subjectUrl === undefined ? `${GH}/repos/acme/mobile/issues/42` : input.subjectUrl;
  return {
    id: input.id,
    unread: true,
    reason: input.reason,
    updated_at: input.at,
    last_read_at: null,
    subject: {
      title: input.title ?? "Fix the cooldown",
      url: subjectUrl,
      latest_comment_url: input.commentUrl === undefined ? subjectUrl : input.commentUrl,
      type: input.type ?? "Issue",
    },
    repository: { id: 1, name: "mobile", full_name: "acme/mobile", html_url: "https://github.com/acme/mobile", owner: { login: "acme" } },
    url: `${GH}/notifications/threads/${input.id}`,
    subscription_url: `${GH}/notifications/threads/${input.id}/subscription`,
  };
}

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** A fake GitHub inbox and a fake PingRoom webhook behind one fetch. */
class World {
  inbox: Record<string, unknown>[] = [];
  lastModified = "Thu, 26 Nov 2026 09:00:00 GMT";
  pollInterval = "60";
  details = new Map<string, Record<string, unknown>>();
  /** Status GitHub answers the list call with, instead of the inbox. */
  listStatus: { status: number; headers?: Record<string, string> } | null = null;
  /** PingRoom's answers, used in order; the last one repeats. */
  pingroom: Array<() => Response> = [() => pingroomOk()];
  calls: Call[] = [];
  nowMs = T0;
  sleeps: number[] = [];
  logs: string[] = [];
  store = new MemoryStore();
  env: InboxEnv = { GITHUB_TOKEN: TOKEN, PINGROOM_WEBHOOK_URL: WEBHOOK_URL };

  poller(): InboxPoller {
    return new InboxPoller({
      storage: this.store,
      env: this.env,
      now: () => this.nowMs,
      sleep: async (ms) => {
        this.sleeps.push(ms);
        this.nowMs += ms;
      },
      log: (line) => this.logs.push(line),
    });
  }

  /** Change the inbox: GitHub reports a new Last-Modified. */
  setInbox(threads: Record<string, unknown>[]): void {
    this.inbox = threads;
    this.lastModified = new Date(this.nowMs).toUTCString();
  }

  github(): Call[] {
    return this.calls.filter((call) => call.url.origin === GH);
  }
  lists(): Call[] {
    return this.github().filter((call) => call.url.pathname === "/notifications");
  }
  sent(): Call[] {
    return this.calls.filter((call) => call.url.origin === API);
  }
  sentBodies(): Array<Record<string, unknown> | null> {
    return this.sent().map((call) => call.body);
  }
  async state(): Promise<InboxState> {
    return (await this.store.get<InboxState>(STATE_KEY)) as InboxState;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ url, method: init?.method ?? "GET", headers, body });

    if (url.origin === API) {
      const index = Math.min(this.sent().length - 1, this.pingroom.length - 1);
      return (this.pingroom[index] ?? (() => pingroomOk()))();
    }
    if (url.origin === GH && url.pathname === "/notifications") {
      if (this.listStatus !== null) {
        return new Response(JSON.stringify({ message: "nope" }), { status: this.listStatus.status, headers: this.listStatus.headers });
      }
      const common = { "X-Poll-Interval": this.pollInterval, "Last-Modified": this.lastModified };
      if (headers.get("If-Modified-Since") === this.lastModified) {
        return new Response(null, { status: 304, headers: common });
      }
      const since = url.searchParams.get("since");
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const matching = this.inbox
        .filter((item) => since === null || Date.parse(String(item["updated_at"])) > Date.parse(since))
        .sort((a, b) => Date.parse(String(b["updated_at"])) - Date.parse(String(a["updated_at"])));
      return Response.json(matching.slice((page - 1) * perPage, page * perPage), { headers: common });
    }
    if (url.origin === GH && this.details.has(url.href)) {
      return Response.json(this.details.get(url.href));
    }
    if (url.origin === GH) {
      return new Response("{}", { status: 404 });
    }
    throw new Error(`unexpected fetch to ${url.origin}`);
  };
}

function pingroomOk(): Response {
  return Response.json({ success: true, message: "Webhook triggered successfully", notification_id: "n-1" });
}

function pingroomError(status: number, error: string, headers: Record<string, string> = {}): () => Response {
  return () => Response.json({ success: false, error, message: "x" }, { status, headers });
}

let world: World;

beforeEach(() => {
  world = new World();
  vi.stubGlobal("fetch", vi.fn(world.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run the first poll (which only records the inbox) and clear the call log. */
async function connect(poller: InboxPoller, threads: Record<string, unknown>[] = []): Promise<void> {
  world.setInbox(threads);
  await poller.run();
  expect(world.sentBodies().map((body) => body?.["title"])).toEqual(["GitHub inbox connected"]);
  world.calls = [];
  world.logs = [];
  world.nowMs += 60_000;
}

describe("configuration", () => {
  it("does nothing without a token", async () => {
    world.env = { PINGROOM_WEBHOOK_URL: WEBHOOK_URL };
    await world.poller().run();
    expect(world.calls).toEqual([]);
    expect(world.logs).toEqual(["inbox: not configured: GITHUB_TOKEN is not set."]);
  });

  it.each([
    ["missing", undefined],
    ["on another host", `https://evil.example/api/webhooks/${ROOM}/${SECRET}`],
    ["with a query", `${WEBHOOK_URL}?x=1`],
    ["with an extra segment", `${WEBHOOK_URL}/more`],
    ["with credentials", `https://u:p@api.pingroom.io/api/webhooks/${ROOM}/${SECRET}`],
    ["with a bad secret", `${API}/api/webhooks/${ROOM}/bad%20secret`],
  ])("does nothing when the webhook URL is %s, and never logs it", async (_case, url) => {
    world.env = { GITHUB_TOKEN: TOKEN, PINGROOM_WEBHOOK_URL: url };
    await world.poller().run();
    expect(world.calls).toEqual([]);
    expect(world.logs).toHaveLength(1);
    expect(world.logs[0]).toContain("PINGROOM_WEBHOOK_URL");
    expect(world.logs.join("\n")).not.toContain(SECRET);
  });

  it("accepts the webhook URL with a trailing slash, and on a self-hosted origin", async () => {
    world.env = { GITHUB_TOKEN: TOKEN, PINGROOM_WEBHOOK_URL: `${WEBHOOK_URL}/` };
    await world.poller().run();
    expect(world.sent()).toHaveLength(1);
    expect(world.sent()[0]?.url.href).toBe(WEBHOOK_URL);
  });
});

describe("the first poll", () => {
  it("records what is already unread and sends one 'connected' Ping", async () => {
    world.setInbox([
      thread({ id: "1", reason: "mention", at: "2026-11-26T09:30:00Z" }),
      thread({ id: "2", reason: "review_requested", at: "2026-11-25T12:00:00Z" }),
    ]);
    await world.poller().run();

    const [list] = world.lists();
    expect(list?.url.searchParams.get("since")).toBeNull();
    expect(list?.url.searchParams.get("per_page")).toBe("50");
    expect(list?.headers.get("If-Modified-Since")).toBeNull();
    expect(list?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(list?.headers.get("Accept")).toBe("application/vnd.github+json");
    expect(list?.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(list?.headers.get("User-Agent")).toBe("pingroom-github-inbox/0.1.0");

    expect(world.sentBodies()).toEqual([
      {
        title: "GitHub inbox connected",
        message: "New GitHub notifications will arrive in this room.",
        correlation_id: "github:inbox:connected",
        data: { url: "https://github.com/notifications", button_label: "Open inbox" },
      },
    ]);
    const [ping] = world.sent();
    expect(ping?.url.href).toBe(WEBHOOK_URL);
    expect(ping?.headers.get("Idempotency-Key")).toBe(`github-inbox:connected:${T0}`);
    expect(ping?.headers.get("Authorization")).toBeNull();
    expect(world.github()).toHaveLength(1);
  });
});

describe("new notifications", () => {
  it("sends a mention with the comment's own words and a link to it", async () => {
    const poller = world.poller();
    await connect(poller);
    const commentUrl = `${GH}/repos/acme/mobile/issues/comments/555`;
    world.details.set(commentUrl, {
      user: { login: "sam" },
      body: "> what about retries?\n\n@me can you look at the retry logic?\n<!-- template -->",
      html_url: "https://github.com/acme/mobile/issues/42#issuecomment-555",
    });
    world.setInbox([thread({ id: "2001", reason: "mention", at: "2026-11-26T10:00:30Z", commentUrl })]);
    await poller.run();

    const [list] = world.lists();
    expect(list?.url.searchParams.get("since")).toBe(isoSeconds(T0 - 60 * 60_000));
    expect(list?.headers.get("If-Modified-Since")).toBe(new Date(T0).toUTCString());

    const detail = world.github().find((call) => call.url.href === commentUrl);
    expect(detail?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);

    expect(world.sentBodies()).toEqual([
      {
        title: "You were mentioned · mobile#42",
        message: "Fix the cooldown · sam: @me can you look at the retry logic?",
        correlation_id: "github:thread:2001",
        data: { url: "https://github.com/acme/mobile/issues/42#issuecomment-555", button_label: "View comment" },
      },
    ]);
    expect(world.sent()[0]?.headers.get("Idempotency-Key")).toBe("github-inbox:2001:2026-11-26T10:00:30Z");
  });

  it("sends a review request without comment text, naming the pull request's author, not its latest commenter", async () => {
    const poller = world.poller();
    await connect(poller);
    const prUrl = `${GH}/repos/acme/mobile/pulls/7`;
    const commentUrl = `${GH}/repos/acme/mobile/issues/comments/700`;
    world.details.set(prUrl, { user: { login: "lee" }, body: "Long description", html_url: "https://github.com/acme/mobile/pull/7" });
    world.details.set(commentUrl, { user: { login: "sam" }, body: "lgtm", html_url: "https://github.com/acme/mobile/pull/7#issuecomment-700" });
    world.setInbox([
      thread({ id: "7", reason: "review_requested", at: "2026-11-26T10:00:10Z", title: "Add retries", type: "PullRequest", subjectUrl: prUrl, commentUrl }),
    ]);
    await poller.run();
    expect(world.github().some((call) => call.url.href === commentUrl)).toBe(false);

    expect(world.sentBodies()).toEqual([
      {
        title: "Review requested · mobile#7",
        message: "Add retries · by lee",
        correlation_id: "github:thread:7",
        data: { url: "https://github.com/acme/mobile/pull/7", button_label: "View PR" },
      },
    ]);
  });

  it("still sends the Ping, with a link built from the API URL, when the detail read fails", async () => {
    const poller = world.poller();
    await connect(poller);
    world.setInbox([
      thread({ id: "8", reason: "assign", at: "2026-11-26T10:00:10Z", type: "PullRequest", subjectUrl: `${GH}/repos/acme/mobile/pulls/8` }),
    ]);
    await poller.run();
    expect(world.sentBodies()).toEqual([
      {
        title: "Assigned to you · mobile#8",
        message: "Fix the cooldown",
        correlation_id: "github:thread:8",
        data: { url: "https://github.com/acme/mobile/pull/8", button_label: "View PR" },
      },
    ]);
  });

  it("never sends the token, or links, to a host that is not GitHub's", async () => {
    const poller = world.poller();
    await connect(poller);
    world.setInbox([
      thread({
        id: "9",
        reason: "mention",
        at: "2026-11-26T10:00:10Z",
        subjectUrl: "https://evil.example/repos/acme/mobile/issues/9",
        commentUrl: "https://evil.example/repos/acme/mobile/issues/comments/1",
      }),
    ]);
    await poller.run();

    for (const call of world.calls) {
      if (call.headers.has("Authorization")) {
        expect(call.url.origin).toBe(GH);
      }
    }
    expect(world.calls.some((call) => call.url.hostname === "evil.example")).toBe(false);
    expect(world.sentBodies()[0]).toMatchObject({
      title: "You were mentioned · mobile",
      data: { url: "https://github.com/acme/mobile", button_label: "View issue" },
    });
  });

  it("asks conditionally and sends nothing when GitHub says nothing changed", async () => {
    const poller = world.poller();
    await connect(poller);
    await poller.run();
    expect(world.lists()).toHaveLength(1);
    expect(world.sent()).toEqual([]);
  });

  it("polls no more often than X-Poll-Interval", async () => {
    world.pollInterval = "120";
    const poller = world.poller();
    await connect(poller);
    await poller.run();
    expect(world.lists()).toHaveLength(0);
    world.nowMs += 60_000;
    await poller.run();
    expect(world.lists()).toHaveLength(1);
  });

  it("sends a thread once per update", async () => {
    const poller = world.poller();
    await connect(poller);
    world.setInbox([thread({ id: "5", reason: "comment", at: "2026-11-26T10:00:10Z" })]);
    await poller.run();
    expect(world.sent()).toHaveLength(1);

    // Another thread changes the inbox; thread 5 comes back unchanged.
    world.nowMs += 60_000;
    world.setInbox([
      thread({ id: "5", reason: "comment", at: "2026-11-26T10:00:10Z" }),
      thread({ id: "6", reason: "subscribed", at: "2026-11-26T10:01:30Z" }),
    ]);
    await poller.run();
    expect(world.sent()).toHaveLength(1);

    world.nowMs += 60_000;
    world.setInbox([thread({ id: "5", reason: "comment", at: "2026-11-26T10:02:40Z" })]);
    await poller.run();
    expect(world.sent()).toHaveLength(2);
    expect(world.sent()[1]?.headers.get("Idempotency-Key")).toBe("github-inbox:5:2026-11-26T10:02:40Z");
  });

  it("leaves out subscribed and ci_activity by default", async () => {
    const poller = world.poller();
    await connect(poller);
    world.setInbox([
      thread({ id: "s", reason: "subscribed", at: "2026-11-26T10:00:10Z" }),
      thread({ id: "c", reason: "ci_activity", at: "2026-11-26T10:00:20Z", type: "CheckSuite", subjectUrl: null }),
      thread({ id: "a", reason: "agent_session_finished", at: "2026-11-26T10:00:30Z" }),
      thread({ id: "u", reason: "some_future_reason", at: "2026-11-26T10:00:40Z" }),
    ]);
    await poller.run();
    expect(world.sentBodies().map((body) => body?.["correlation_id"])).toEqual(["github:thread:a", "github:thread:u"]);
  });

  it("passes every reason with GITHUB_REASONS=all, and only the listed ones with a list", async () => {
    world.env = { ...world.env, GITHUB_REASONS: "all" };
    let poller = world.poller();
    await connect(poller);
    world.setInbox([
      thread({ id: "s", reason: "subscribed", at: "2026-11-26T10:00:10Z" }),
      thread({ id: "c", reason: "ci_activity", at: "2026-11-26T10:00:20Z", type: "CheckSuite", subjectUrl: null, title: "CI run failed" }),
    ]);
    await poller.run();
    expect(world.sentBodies()).toEqual([
      expect.objectContaining({ title: "Update · mobile#42" }),
      {
        title: "Workflow run · mobile",
        message: "CI run failed",
        correlation_id: "github:thread:c",
        data: { url: "https://github.com/acme/mobile/actions", button_label: "View run" },
      },
    ]);

    world.calls = [];
    world.env = { ...world.env, GITHUB_REASONS: "Mention, review_requested" };
    poller = world.poller();
    world.nowMs += 60_000;
    world.setInbox([
      thread({ id: "m", reason: "mention", at: "2026-11-26T10:01:10Z" }),
      thread({ id: "x", reason: "assign", at: "2026-11-26T10:01:20Z" }),
    ]);
    await poller.run();
    expect(world.sentBodies().map((body) => body?.["correlation_id"])).toEqual(["github:thread:m"]);
  });

  it("sends the four most important of a burst one by one and the rest as one summary", async () => {
    const poller = world.poller();
    await connect(poller);
    const reasons = ["comment", "mention", "author", "assign", "comment", "team_mention", "manual", "state_change"];
    world.setInbox(reasons.map((reason, i) => thread({ id: `b${i}`, reason, at: `2026-11-26T10:00:${10 + i}Z` })));
    await poller.run();

    const ids = world.sentBodies().map((body) => body?.["correlation_id"]);
    // mention (b1), team_mention (b5), assign (b3), then the newest other (b7), in time order.
    expect(ids).toEqual(["github:thread:b1", "github:thread:b3", "github:thread:b5", "github:thread:b7", "github:inbox:summary"]);
    expect(world.sentBodies()[4]).toEqual({
      title: "4 more on GitHub",
      message: "4 more new notifications in your GitHub inbox.",
      correlation_id: "github:inbox:summary",
      data: { url: "https://github.com/notifications", button_label: "Open inbox" },
    });
    // One detail read per Ping sent one by one, none for the summarised.
    expect(world.github().filter((call) => call.url.pathname !== "/notifications")).toHaveLength(4);
  });
});

describe("sending to PingRoom", () => {
  it("waits out the webhook's cooldown and sends the next Ping", async () => {
    const poller = world.poller();
    await connect(poller);
    world.pingroom = [() => pingroomOk(), pingroomError(429, "cooldown_active", { "Retry-After": "5" }), () => pingroomOk()];
    world.setInbox([
      thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:10Z" }),
      thread({ id: "2", reason: "mention", at: "2026-11-26T10:00:20Z" }),
    ]);
    await poller.run();

    expect(world.sleeps).toEqual([5000]);
    const keys = world.sent().map((call) => call.headers.get("Idempotency-Key"));
    expect(keys).toEqual(["github-inbox:1:2026-11-26T10:00:10Z", "github-inbox:2:2026-11-26T10:00:20Z", "github-inbox:2:2026-11-26T10:00:20Z"]);
    expect((await world.state()).pending).toEqual([]);
  });

  it("keeps a Ping PingRoom could not take and resends the same body under the same key", async () => {
    const poller = world.poller();
    await connect(poller);
    world.pingroom = [pingroomError(503, "server_error"), () => pingroomOk()];
    world.setInbox([thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:10Z" })]);
    await poller.run();
    expect(world.sent()).toHaveLength(1);
    expect((await world.state()).pending).toHaveLength(1);
    expect(world.logs.some((line) => line.includes("502 upstream_error"))).toBe(true);

    world.nowMs += 60_000;
    await poller.run();
    const [first, second] = world.sent();
    expect(second?.headers.get("Idempotency-Key")).toBe(first?.headers.get("Idempotency-Key"));
    expect(second?.body).toEqual(first?.body);
    expect((await world.state()).pending).toEqual([]);
  });

  it("keeps Pings while the room or webhook is unavailable, and gives up after a day", async () => {
    const poller = world.poller();
    world.pingroom = [pingroomError(404, "room_not_found")];
    world.setInbox([]);
    await poller.run();
    expect((await world.state()).pending).toHaveLength(1);

    world.nowMs += PENDING_TTL_MS;
    await poller.run();
    expect((await world.state()).pending).toEqual([]);
    expect(world.logs.some((line) => line.includes("did not take for a day"))).toBe(true);
  });

  it("drops a Ping PingRoom refuses as invalid and goes on to the next", async () => {
    const poller = world.poller();
    await connect(poller);
    world.pingroom = [pingroomError(422, "validation_failed"), () => pingroomOk()];
    world.setInbox([
      thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:10Z" }),
      thread({ id: "2", reason: "mention", at: "2026-11-26T10:00:20Z" }),
    ]);
    await poller.run();
    expect(world.sent()).toHaveLength(2);
    expect((await world.state()).pending).toEqual([]);
    expect(world.logs.some((line) => line.includes("422 validation_failed") && line.includes("dropped"))).toBe(true);
  });
});

describe("GitHub refusing", () => {
  it("tells the room once that the token was refused, then checks every five minutes", async () => {
    world.listStatus = { status: 401 };
    const poller = world.poller();
    await poller.run();
    expect(world.sentBodies()).toEqual([
      {
        title: "GitHub inbox stopped",
        message: "GitHub refused the token: it is wrong, expired or revoked. Set a new GITHUB_TOKEN.",
        correlation_id: "github:inbox:token",
        is_urgent: true,
        data: { url: "https://github.com/settings/tokens", button_label: "Manage tokens" },
      },
    ]);

    world.nowMs += 60_000;
    await poller.run();
    expect(world.lists()).toHaveLength(1);

    world.nowMs += 5 * 60_000;
    await poller.run();
    expect(world.lists()).toHaveLength(2);
    expect(world.sent()).toHaveLength(1);
  });

  it("says a fine-grained token cannot read notifications", async () => {
    world.env = { ...world.env, GITHUB_TOKEN: "github_pat_11AAAAAAA0abcdefghijkl" };
    world.listStatus = { status: 403 };
    await world.poller().run();
    expect(world.sentBodies()[0]?.["message"]).toBe(
      "Fine-grained tokens cannot read notifications. Use a classic token with the notifications scope.",
    );
  });

  it("waits for the rate limit to reset without telling the room", async () => {
    const resetS = Math.floor(T0 / 1000) + 600;
    world.listStatus = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetS) } };
    const poller = world.poller();
    await poller.run();
    expect(world.sent()).toEqual([]);
    expect((await world.state()).nextPollAt).toBe(resetS * 1000);
  });

  it("starts over, with a new 'connected' Ping, when the token changes", async () => {
    const poller = world.poller();
    await connect(poller, [thread({ id: "1", reason: "mention", at: "2026-11-26T09:59:00Z" })]);
    world.env = { ...world.env, GITHUB_TOKEN: "ghp_another0123456789abcdefghijklmnopqrs" };
    await world.poller().run();
    expect(world.lists()[0]?.headers.get("If-Modified-Since")).toBeNull();
    expect(world.sentBodies().map((body) => body?.["title"])).toEqual(["GitHub inbox connected"]);
  });
});

describe("state", () => {
  it("joins a run already in progress instead of polling twice", async () => {
    const poller = world.poller();
    world.setInbox([]);
    await Promise.all([poller.run(), poller.run()]);
    expect(world.lists()).toHaveLength(1);
    expect(world.sent()).toHaveLength(1);
  });

  it("forgets threads older than the window", async () => {
    const poller = world.poller();
    await connect(poller, [thread({ id: "old", reason: "mention", at: "2026-11-25T09:00:00Z" })]);
    const state = await world.state();
    expect(state.seen).toEqual({});
    expect(state.cursorMs).toBe(T0);
  });

  it("stores neither the token nor the webhook URL", async () => {
    await world.poller().run();
    const stored = JSON.stringify([...world.store.map.values()]);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(SECRET);
  });
});

describe("links", () => {
  function parsed(subjectUrl: string | null, type = "Issue") {
    const value = parseThread(thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:00Z", subjectUrl, type }));
    if (value === null) {
      throw new Error("fixture did not parse");
    }
    return value;
  }

  it.each([
    [`${GH}/repos/acme/mobile/issues/42`, "https://github.com/acme/mobile/issues/42"],
    [`${GH}/repos/acme/mobile/pulls/7`, "https://github.com/acme/mobile/pull/7"],
    [`${GH}/repos/acme/mobile/commits/abc123`, "https://github.com/acme/mobile/commit/abc123"],
    [`${GH}/repos/acme/mobile/discussions/3`, "https://github.com/acme/mobile/discussions/3"],
    [`${GH}/repos/acme/mobile/releases/991`, "https://github.com/acme/mobile/releases"],
    [`${GH}/repos/acme/mobile/something/else/1`, "https://github.com/acme/mobile"],
    [null, "https://github.com/acme/mobile"],
  ])("builds a github.com page from %s", (subjectUrl, expected) => {
    expect(fallbackUrl(parsed(subjectUrl))).toBe(expected);
  });

  it("reads the number only from issue, pull request and discussion URLs on api.github.com", () => {
    expect(numberOf(`${GH}/repos/acme/mobile/pulls/7`)).toBe("7");
    expect(numberOf(`${GH}/repos/acme/mobile/discussions/3`)).toBe("3");
    expect(numberOf(`${GH}/repos/acme/mobile/commits/123`)).toBeNull();
    expect(numberOf("https://evil.example/repos/acme/mobile/pulls/7")).toBeNull();
    expect(numberOf(null)).toBeNull();
  });

  it("accepts a numeric thread id and refuses a thread missing a field", () => {
    expect(parseThread({ ...thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:00Z" }), id: 77 })?.id).toBe("77");
    expect(parseThread({ ...thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:00Z" }), updated_at: "soon" })).toBeNull();
    expect(parseThread({ ...thread({ id: "1", reason: "mention", at: "2026-11-26T10:00:00Z" }), repository: {} })).toBeNull();
    expect(parseThread(thread({ id: "1\r\nX-Evil: 1", reason: "mention", at: "2026-11-26T10:00:00Z" }))).toBeNull();
  });
});

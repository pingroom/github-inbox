/**
 * The GitHub inbox poller: once a minute, ask GitHub what is new in the
 * signed-in user's notifications, and send each new thread to a PingRoom room
 * as a Ping.
 *
 * GitHub has no webhook for a person's notifications, so this polls, the way
 * GitHub asks: conditionally (`If-Modified-Since`, so an unchanged inbox is a
 * 304 that costs no rate limit) and no more often than `X-Poll-Interval`.
 *
 * State lives in one Durable Object (see worker.ts), so two overlapping runs
 * can never both send the same thread:
 *   - `seen`: thread id to the `updated_at` last handled. A thread is new when
 *     its `updated_at` moved past that. Kept for two hours past the newest
 *     update; GitHub is asked only for the last hour (`since`).
 *   - `pending`: Pings built but not yet accepted by PingRoom, each with its
 *     own Idempotency-Key, retried for up to a day. A PingRoom webhook allows
 *     one Ping per cooldown (5 s by default), so a burst is sent with pauses.
 *
 * The first successful poll only records what is already in the inbox and
 * sends a single "connected" Ping. Nothing older than the Worker is sent.
 */

import { sha256Hex } from "./hash";
import { forward } from "./forward";
import { isRecord } from "./json";
import type { PingBody } from "./ping";
import { readConfig, reasonAllowed, type InboxConfig, type InboxEnv } from "./config";
import { connectedPing, priorityOf, summaryPing, threadKey, threadPing, tokenProblemPing, wantsComment, type TokenProblem } from "./format";
import { fetchDetail, listNotifications, type Thread } from "./github";

/** The two calls of `DurableObjectStorage` the poller uses. */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface PollerDeps {
  storage: StateStore;
  env: InboxEnv;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Status lines for `wrangler tail`. Never given a token, a URL or notification text. */
  log(line: string): void;
}

export const STATE_KEY = "state";
/** How far back each poll asks GitHub to look, behind the newest update seen. */
export const WINDOW_MS = 60 * 60_000;
export const SEEN_KEEP_MS = 2 * WINDOW_MS;
/** Cron fires on the minute; a 60 s poll interval must not skip every other run. */
export const POLL_SLACK_MS = 5_000;
export const PENDING_TTL_MS = 24 * 60 * 60_000;
export const MAX_PENDING = 20;
/** More new threads than this in one poll: the most important go one by one, the rest as one summary. */
export const MAX_ONE_BY_ONE = 5;
/** Time a run may spend sending, so it is done before the next cron. */
export const DRAIN_BUDGET_MS = 40_000;
export const MAX_RETRY_WAIT_S = 15;
export const MAX_WAITS_PER_RUN = 10;
export const DEFAULT_COOLDOWN_S = 5;
export const TOKEN_RETRY_MS = 5 * 60_000;
export const ERROR_RETRY_MS = 60_000;

export interface PendingPing {
  key: string;
  body: PingBody;
  enqueuedAt: number;
  attempts: number;
}

export interface InboxState {
  version: 1;
  /** A hash of the token. A new token starts over, with a new "connected" Ping. */
  tokenId: string;
  bootstrapped: boolean;
  lastModified: string | null;
  nextPollAt: number;
  /** The newest `updated_at` seen, in ms. */
  cursorMs: number | null;
  seen: Record<string, string>;
  pending: PendingPing[];
  /** `{tokenId}:{problem}` of the token problem last sent, so each is sent once. */
  toldProblem: string | null;
}

export class InboxPoller {
  private running: Promise<void> | null = null;

  constructor(private readonly deps: PollerDeps) {}

  /** One run. A run that starts while another is in progress joins it. */
  run(): Promise<void> {
    if (this.running === null) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<void> {
    const read = readConfig(this.deps.env);
    if (!read.ok) {
      this.deps.log(`inbox: not configured: ${read.problem}`);
      return;
    }
    const config = read.config;
    const tokenId = (await sha256Hex(`pingroom-github-inbox:${config.token}`)).slice(0, 16);

    let state = await this.load(tokenId);
    if (state.tokenId !== tokenId) {
      // Another token may be another account: forget what the old one saw.
      state = freshState(tokenId, state.pending);
    }

    const now = this.deps.now();
    this.expire(state, now);
    if (now + POLL_SLACK_MS >= state.nextPollAt) {
      await this.poll(config, state, now);
      await this.save(state);
    }
    await this.drain(config, state);
  }

  // -------------------------------------------------------------------------

  private async poll(config: InboxConfig, state: InboxState, now: number): Promise<void> {
    const result = await listNotifications({
      token: config.token,
      since: state.cursorMs === null ? null : isoSeconds(state.cursorMs - WINDOW_MS),
      ifModifiedSince: state.lastModified,
      nowMs: now,
    });

    switch (result.kind) {
      case "not_modified":
        state.nextPollAt = now + result.pollIntervalS * 1000;
        state.toldProblem = null;
        return;
      case "unauthorized":
      case "forbidden":
        state.nextPollAt = now + TOKEN_RETRY_MS;
        this.tellTokenProblem(state, result.kind, config.token, now);
        return;
      case "rate_limited":
        state.nextPollAt = Math.max(result.untilMs, now + ERROR_RETRY_MS);
        this.deps.log(`inbox: GitHub rate limit; next poll in ${Math.round((state.nextPollAt - now) / 1000)} s`);
        return;
      case "error":
        state.nextPollAt = now + ERROR_RETRY_MS;
        this.deps.log(`inbox: GitHub answered ${result.status ?? "nothing"}; trying again next run`);
        return;
      default:
        break;
    }

    state.nextPollAt = now + result.pollIntervalS * 1000;
    state.lastModified = result.lastModified;
    state.toldProblem = null;
    if (result.malformed > 0) {
      this.deps.log(`inbox: skipped ${result.malformed} thread(s) missing a field`);
    }
    if (result.truncated) {
      this.deps.log("inbox: more threads changed than one poll reads; the oldest wait for the next");
    }

    const newest = result.threads.reduce((max, thread) => Math.max(max, thread.updatedMs), 0);

    if (!state.bootstrapped) {
      for (const thread of result.threads) {
        state.seen[thread.id] = thread.updatedAt;
      }
      state.cursorMs = Math.max(now, newest);
      state.bootstrapped = true;
      this.prune(state);
      this.enqueue(state, connectedPing(now), now);
      this.deps.log(`inbox: connected; ${result.threads.length} unread thread(s) recorded, none sent`);
      return;
    }

    const fresh: Thread[] = [];
    for (const thread of result.threads) {
      const previous = state.seen[thread.id];
      if (previous !== undefined && Date.parse(previous) >= thread.updatedMs) {
        continue;
      }
      state.seen[thread.id] = thread.updatedAt;
      if (reasonAllowed(config.reasons, thread.reason)) {
        fresh.push(thread);
      }
    }
    state.cursorMs = Math.max(state.cursorMs ?? 0, newest);
    this.prune(state);
    if (fresh.length === 0) {
      return;
    }

    let oneByOne = fresh;
    let rest = 0;
    if (fresh.length > MAX_ONE_BY_ONE) {
      oneByOne = [...fresh]
        .sort((a, b) => priorityOf(a.reason) - priorityOf(b.reason) || b.updatedMs - a.updatedMs)
        .slice(0, MAX_ONE_BY_ONE - 1);
      rest = fresh.length - oneByOne.length;
    }
    oneByOne = [...oneByOne].sort((a, b) => a.updatedMs - b.updatedMs);

    for (const thread of oneByOne) {
      const detail = await fetchDetail(config.token, thread, !wantsComment(thread.reason));
      this.enqueue(state, { key: threadKey(thread), body: threadPing(thread, detail) }, now);
    }
    if (rest > 0) {
      this.enqueue(state, summaryPing(rest, now), now);
    }
    this.deps.log(`inbox: ${fresh.length} new thread(s)`);
  }

  private tellTokenProblem(state: InboxState, problem: TokenProblem, token: string, now: number): void {
    const id = `${state.tokenId}:${problem}`;
    this.deps.log(`inbox: GitHub refused the token (${problem})`);
    if (state.toldProblem === id) {
      return;
    }
    state.toldProblem = id;
    this.enqueue(state, tokenProblemPing(problem, token.startsWith("github_pat_"), now), now);
  }

  // -------------------------------------------------------------------------

  private async drain(config: InboxConfig, state: InboxState): Promise<void> {
    const deadline = this.deps.now() + DRAIN_BUDGET_MS;
    let sent = 0;
    let waits = 0;

    while (state.pending.length > 0) {
      const item = state.pending[0];
      if (item === undefined) {
        break;
      }
      const res = await forward({ ...config.destination, body: item.body, idempotencyKey: item.key });
      const outcome = await outcomeOf(res);

      if (outcome.kind === "sent" || outcome.kind === "drop") {
        state.pending.shift();
        if (outcome.kind === "sent") {
          sent++;
        } else {
          this.deps.log(`inbox: PingRoom refused a Ping (${outcome.detail}); dropped`);
        }
        await this.save(state);
        continue;
      }

      if (outcome.kind === "wait") {
        const waitMs = outcome.seconds * 1000;
        if (outcome.seconds <= MAX_RETRY_WAIT_S && waits < MAX_WAITS_PER_RUN && this.deps.now() + waitMs <= deadline) {
          waits++;
          await this.deps.sleep(waitMs);
          continue;
        }
      }

      item.attempts++;
      this.deps.log(`inbox: PingRoom answered ${outcome.detail}; ${state.pending.length} Ping(s) wait for the next run`);
      await this.save(state);
      break;
    }

    if (sent > 0) {
      this.deps.log(`inbox: sent ${sent} Ping(s)`);
    }
  }

  // -------------------------------------------------------------------------

  private enqueue(state: InboxState, ping: { key: string; body: PingBody }, now: number): void {
    state.pending.push({ key: ping.key, body: ping.body, enqueuedAt: now, attempts: 0 });
    if (state.pending.length > MAX_PENDING) {
      const dropped = state.pending.length - MAX_PENDING;
      state.pending.splice(0, dropped);
      this.deps.log(`inbox: ${dropped} unsent Ping(s) dropped; more than ${MAX_PENDING} were waiting`);
    }
  }

  private expire(state: InboxState, now: number): void {
    const before = state.pending.length;
    state.pending = state.pending.filter((item) => now - item.enqueuedAt < PENDING_TTL_MS);
    if (state.pending.length < before) {
      this.deps.log(`inbox: ${before - state.pending.length} Ping(s) PingRoom did not take for a day were dropped`);
    }
  }

  private prune(state: InboxState): void {
    if (state.cursorMs === null) {
      return;
    }
    const oldest = state.cursorMs - SEEN_KEEP_MS;
    for (const [id, updatedAt] of Object.entries(state.seen)) {
      if (Date.parse(updatedAt) < oldest) {
        delete state.seen[id];
      }
    }
  }

  private async load(tokenId: string): Promise<InboxState> {
    const stored = await this.deps.storage.get<InboxState>(STATE_KEY);
    return isRecord(stored) && stored.version === 1 ? stored : freshState(tokenId, []);
  }

  private async save(state: InboxState): Promise<void> {
    await this.deps.storage.put(STATE_KEY, state);
  }
}

function freshState(tokenId: string, pending: PendingPing[]): InboxState {
  return {
    version: 1,
    tokenId,
    bootstrapped: false,
    lastModified: null,
    nextPollAt: 0,
    cursorMs: null,
    seen: {},
    pending,
    toldProblem: null,
  };
}

type Outcome =
  | { kind: "sent" }
  /** The cooldown: wait this long and send the same Ping again. */
  | { kind: "wait"; seconds: number; detail: string }
  /** PingRoom, the room or the webhook is unavailable or misconfigured: keep it for the next run. */
  | { kind: "later"; detail: string }
  /** PingRoom will never take this body: drop it. */
  | { kind: "drop"; detail: string };

/** Statuses after which the same Ping can succeed once something outside it changes. */
const LATER_STATUSES = new Set([401, 402, 403, 404, 408]);

async function outcomeOf(res: Response): Promise<Outcome> {
  if (res.status >= 200 && res.status < 300) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "sent" };
  }
  const detail = `${res.status} ${await errorCodeOf(res)}`.trim();
  if (res.status === 429) {
    const header = res.headers.get("Retry-After")?.trim();
    const seconds = header !== undefined && /^\d{1,7}$/.test(header) ? Math.max(1, Number(header)) : DEFAULT_COOLDOWN_S;
    return { kind: "wait", seconds, detail };
  }
  if (res.status >= 500 || LATER_STATUSES.has(res.status)) {
    return { kind: "later", detail };
  }
  return { kind: "drop", detail };
}

/** PingRoom's `error` (or the Worker's own) code, if it is a plain identifier. */
async function errorCodeOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const code = isRecord(body) ? (body["error"] ?? body["code"]) : undefined;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "";
  } catch {
    return "";
  }
}

/** `2026-11-26T10:00:00Z`: GitHub's documented `since` format, without milliseconds. */
export function isoSeconds(ms: number): string {
  return new Date(Math.max(0, ms)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

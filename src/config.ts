/**
 * Configuration of the GitHub inbox Worker: a personal access token, the
 * room's PingRoom incoming webhook URL, and which notification reasons to
 * pass on. Everything comes from the Worker's environment; the token and the
 * webhook URL are secrets (`wrangler secret put`), never `[vars]`.
 */

import { forwardUrl, resolveApiBase } from "./forward";

export interface InboxEnv {
  /** A classic personal access token with the `notifications` scope. */
  GITHUB_TOKEN?: string;
  /** The room's incoming webhook URL, exactly as PingRoom shows it. */
  PINGROOM_WEBHOOK_URL?: string;
  /** `all`, or a comma-separated list of reasons. Unset: every reason but `subscribed` and `ci_activity`. */
  GITHUB_REASONS?: string;
  /** The only PingRoom origin this Worker calls. Defaults to https://api.pingroom.io. */
  PINGROOM_API_BASE?: string;
}

/**
 * Every `reason` GitHub documents for a notification thread (REST API,
 * "About notification reasons", read 2026-11-26).
 */
export const ALL_REASONS = [
  "agent_session_finished",
  "approval_requested",
  "assign",
  "author",
  "ci_activity",
  "comment",
  "invitation",
  "manual",
  "member_feature_requested",
  "mention",
  "review_requested",
  "security_advisory_credit",
  "security_alert",
  "state_change",
  "subscribed",
  "team_mention",
] as const;

/**
 * Left out by default: `subscribed` is every thread in every repository you
 * watch, and `ci_activity` is every workflow run you trigger. Both are better
 * read on GitHub than buzzed one by one.
 */
export const DEFAULT_EXCLUDED_REASONS: ReadonlySet<string> = new Set(["subscribed", "ci_activity"]);

/**
 * Which reasons are passed on: the default (every reason but the two in
 * `DEFAULT_EXCLUDED_REASONS`, including any GitHub adds later), all of them,
 * or only the listed ones.
 */
export type ReasonFilter =
  | { readonly kind: "default" }
  | { readonly kind: "all" }
  | { readonly kind: "only"; readonly reasons: ReadonlySet<string> };

export interface Destination {
  base: URL;
  roomCode: string;
  secret: string;
}

export interface InboxConfig {
  token: string;
  destination: Destination;
  reasons: ReasonFilter;
}

export type ConfigResult = { ok: true; config: InboxConfig } | { ok: false; problem: string };

/** The usable configuration, or a sentence saying what is missing. Never echoes a secret. */
export function readConfig(env: InboxEnv): ConfigResult {
  const token = env.GITHUB_TOKEN?.trim() ?? "";
  if (token === "") {
    return { ok: false, problem: "GITHUB_TOKEN is not set." };
  }
  if (/[\s\u0000-\u001F\u007F]/.test(token)) {
    return { ok: false, problem: "GITHUB_TOKEN contains whitespace or control characters." };
  }
  const base = resolveApiBase({ PINGROOM_API_BASE: env.PINGROOM_API_BASE });
  if (base === null) {
    return { ok: false, problem: "PINGROOM_API_BASE is not a usable origin." };
  }
  const destination = parseWebhookUrl(env.PINGROOM_WEBHOOK_URL, base);
  if (destination === null) {
    return {
      ok: false,
      problem: `PINGROOM_WEBHOOK_URL is missing or is not ${base.origin}/api/webhooks/{roomCode}/{secret}.`,
    };
  }
  return { ok: true, config: { token, destination, reasons: parseReasons(env.GITHUB_REASONS) } };
}

const WEBHOOK_PATH = /^\/api\/webhooks\/([^/]+)\/([^/]+)\/?$/;

/**
 * Room code and secret out of `{base}/api/webhooks/{roomCode}/{secret}`, or
 * null when the URL is on any other origin or path, carries credentials, a
 * query or a fragment, or its parts fail the room code and secret patterns
 * in forward.ts.
 */
export function parseWebhookUrl(raw: string | undefined, base: URL): Destination | null {
  const candidate = raw?.trim() ?? "";
  if (candidate === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  const match = WEBHOOK_PATH.exec(url.pathname);
  const roomCode = match?.[1];
  const secret = match?.[2];
  if (roomCode === undefined || secret === undefined || forwardUrl(base, roomCode, secret) === null) {
    return null;
  }
  return { base, roomCode, secret };
}

/**
 * `all`, or the listed reasons (commas or spaces between them, any case).
 * Unset or blank means the default.
 */
export function parseReasons(raw: string | undefined): ReasonFilter {
  const words = (raw ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return { kind: "default" };
  }
  if (words.includes("all")) {
    return { kind: "all" };
  }
  return { kind: "only", reasons: new Set(words) };
}

/** Whether a thread with this reason is passed on. */
export function reasonAllowed(filter: ReasonFilter, reason: string): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "default":
      return !DEFAULT_EXCLUDED_REASONS.has(reason);
    default:
      return filter.reasons.has(reason);
  }
}

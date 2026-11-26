/**
 * The two GitHub REST calls the inbox Worker makes: list the signed-in user's
 * notification threads, and read the comment (or issue, pull request or
 * release) a thread points at.
 *
 * Docs read 2026-11-26:
 *   https://docs.github.com/en/rest/activity/notifications?apiVersion=2022-11-28
 *     ("These endpoints only support authentication using a personal access
 *     token (classic)", the `notifications` or `repo` scope; `since`,
 *     `per_page` max 50; polling with Last-Modified / If-Modified-Since, a 304
 *     leaves the rate limit untouched, and "Please obey" X-Poll-Interval; the
 *     thread schema and the reason list)
 *
 * The token is only ever sent to https://api.github.com. Every URL taken from
 * a response is checked against that origin before it is fetched, and no
 * redirect is followed.
 */

import { readCapped } from "./forward";
import { idOf, isRecord, nonEmpty, str } from "./json";
import { USER_AGENT } from "./version";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 8_000;
/** A page of 50 threads carries 50 full repository objects. */
export const MAX_GITHUB_BYTES = 4 * 1024 * 1024;
export const PER_PAGE = 50;
/** Pages read per poll. More than 200 threads changed inside the window is a flood; the rest wait. */
export const MAX_PAGES = 4;
export const DEFAULT_POLL_INTERVAL_S = 60;

/** One notification thread, reduced to what a Ping needs. */
export interface Thread {
  id: string;
  reason: string;
  /** GitHub's `updated_at`, verbatim. */
  updatedAt: string;
  updatedMs: number;
  subjectTitle: string;
  subjectType: string;
  /** API URL of the issue, pull request, release or commit, when GitHub gives one. */
  subjectUrl: string | null;
  /** API URL of the latest comment (or of the subject itself when it has none). */
  latestCommentUrl: string | null;
  repoFullName: string;
  repoName: string;
  repoHtmlUrl: string | null;
}

/** A thread out of the response, or null when a field it needs is missing. */
export function parseThread(value: unknown): Thread | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawId = idOf(value, "id");
  // The id goes into an Idempotency-Key header: GitHub's are digits.
  const id = rawId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : undefined;
  const reason = nonEmpty(value, "reason");
  const updatedAt = nonEmpty(value, "updated_at");
  const subjectTitle = str(value, "subject", "title");
  const subjectType = str(value, "subject", "type") ?? "";
  const repoFullName = nonEmpty(value, "repository", "full_name");
  if (id === undefined || reason === undefined || updatedAt === undefined || subjectTitle === undefined || repoFullName === undefined) {
    return null;
  }
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return null;
  }
  return {
    id,
    reason,
    updatedAt,
    updatedMs,
    subjectTitle,
    subjectType,
    subjectUrl: nonEmpty(value, "subject", "url") ?? null,
    latestCommentUrl: nonEmpty(value, "subject", "latest_comment_url") ?? null,
    repoFullName,
    repoName: nonEmpty(value, "repository", "name") ?? repoFullName.split("/").pop() ?? repoFullName,
    repoHtmlUrl: nonEmpty(value, "repository", "html_url") ?? null,
  };
}

/** True for an https://api.github.com/repos/... URL with no credentials, port, query or fragment. */
export function isGitHubApiUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.origin === GITHUB_API_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.startsWith("/repos/")
  );
}

export type ListResult =
  | { kind: "not_modified"; pollIntervalS: number }
  | {
      kind: "ok";
      threads: Thread[];
      /** Threads in the response that were missing a field and were skipped. */
      malformed: number;
      /** True when the last page read was full: there may be more. */
      truncated: boolean;
      lastModified: string | null;
      pollIntervalS: number;
    }
  /** 401: the token is wrong, expired or revoked. */
  | { kind: "unauthorized" }
  /** 403 that is not a rate limit: usually a fine-grained token or a missing scope. */
  | { kind: "forbidden" }
  | { kind: "rate_limited"; untilMs: number }
  | { kind: "error"; status: number | null };

export interface ListOptions {
  token: string;
  /** ISO 8601 lower bound on `updated_at`, or null for every unread thread. */
  since: string | null;
  ifModifiedSince: string | null;
  nowMs: number;
}

/** Unread notification threads, newest first, up to `MAX_PAGES` pages. */
export async function listNotifications(options: ListOptions): Promise<ListResult> {
  const threads: Thread[] = [];
  let malformed = 0;
  let lastModified: string | null = null;
  let pollIntervalS = DEFAULT_POLL_INTERVAL_S;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL("/notifications", GITHUB_API_ORIGIN);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    if (options.since !== null) {
      url.searchParams.set("since", options.since);
    }
    const headers: Record<string, string> = {};
    // Only the first page is conditional: a 304 there means nothing changed.
    if (page === 1 && options.ifModifiedSince !== null) {
      headers["If-Modified-Since"] = options.ifModifiedSince;
    }

    const res = await githubGet(options.token, url.href, headers);
    if (res === null) {
      return { kind: "error", status: null };
    }
    if (page === 1) {
      pollIntervalS = pollIntervalOf(res);
      lastModified = res.headers.get("Last-Modified");
      if (res.status === 304) {
        await discard(res);
        return { kind: "not_modified", pollIntervalS };
      }
    }
    const failure = await failureOf(res, options.nowMs);
    if (failure !== null) {
      return failure;
    }

    const body = await readJson(res);
    if (!Array.isArray(body)) {
      return { kind: "error", status: res.status };
    }
    for (const item of body) {
      const thread = parseThread(item);
      if (thread === null) {
        malformed++;
      } else {
        threads.push(thread);
      }
    }
    if (body.length < PER_PAGE) {
      return { kind: "ok", threads, malformed, truncated: false, lastModified, pollIntervalS };
    }
  }
  return { kind: "ok", threads, malformed, truncated: true, lastModified, pollIntervalS };
}

/** What the comment, issue, pull request or release behind a thread says. */
export interface SubjectDetail {
  /** The github.com page, as GitHub gives it. */
  htmlUrl: string | null;
  /** Who wrote it. */
  actor: string | null;
  /** Its text, when it has any. */
  body: string | null;
  /** True when the URL read was a comment (`.../comments/...`), not the subject itself. */
  isComment: boolean;
}

/**
 * Read the latest comment (or, with `preferSubject`, the issue, pull request
 * or release itself), falling back to the other URL. Null when the thread has
 * neither, neither is on api.github.com, or the read fails. A failure here
 * never stops a Ping; it only makes it plainer.
 */
export async function fetchDetail(token: string, thread: Thread, preferSubject: boolean): Promise<SubjectDetail | null> {
  const order = preferSubject ? [thread.subjectUrl, thread.latestCommentUrl] : [thread.latestCommentUrl, thread.subjectUrl];
  const target = order.find(
    (candidate): candidate is string => candidate !== null && isGitHubApiUrl(candidate),
  );
  if (target === undefined) {
    return null;
  }
  const res = await githubGet(token, target, {});
  if (res === null) {
    return null;
  }
  if (res.status !== 200) {
    await discard(res);
    return null;
  }
  const body = await readJson(res);
  if (!isRecord(body)) {
    return null;
  }
  return {
    htmlUrl: nonEmpty(body, "html_url") ?? null,
    actor: nonEmpty(body, "user", "login") ?? nonEmpty(body, "author", "login") ?? null,
    body: str(body, "body") ?? null,
    isComment: new URL(target).pathname.includes("/comments/"),
  };
}

// ---------------------------------------------------------------------------

async function githubGet(token: string, url: string, extra: Record<string, string>): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...extra,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await discard(res);
      return null;
    }
    return res;
  } catch {
    return null;
  }
}

/** The non-2xx outcomes of a list call, or null for a 2xx. */
async function failureOf(res: Response, nowMs: number): Promise<ListResult | null> {
  if (res.status >= 200 && res.status < 300) {
    return null;
  }
  await discard(res);
  if (res.status === 401) {
    return { kind: "unauthorized" };
  }
  const untilMs = rateLimitedUntil(res, nowMs);
  if (untilMs !== null) {
    return { kind: "rate_limited", untilMs };
  }
  if (res.status === 403) {
    return { kind: "forbidden" };
  }
  return { kind: "error", status: res.status };
}

/**
 * When a 403 or 429 is a rate limit, the time to wait until: `Retry-After`
 * (secondary limits), else `x-ratelimit-reset` when nothing is left, else a
 * minute for a 429 that says neither.
 */
function rateLimitedUntil(res: Response, nowMs: number): number | null {
  if (res.status !== 403 && res.status !== 429) {
    return null;
  }
  const retryAfter = wholeSeconds(res.headers.get("Retry-After"));
  if (retryAfter !== null) {
    return nowMs + retryAfter * 1000;
  }
  if (res.headers.get("x-ratelimit-remaining")?.trim() === "0") {
    const reset = wholeSeconds(res.headers.get("x-ratelimit-reset"));
    return reset !== null && reset * 1000 > nowMs ? reset * 1000 : nowMs + 60_000;
  }
  return res.status === 429 ? nowMs + 60_000 : null;
}

function pollIntervalOf(res: Response): number {
  const seconds = wholeSeconds(res.headers.get("X-Poll-Interval"));
  return seconds !== null && seconds > 0 && seconds <= 3600 ? seconds : DEFAULT_POLL_INTERVAL_S;
}

function wholeSeconds(header: string | null): number | null {
  const value = header?.trim();
  return value !== undefined && /^\d{1,10}$/.test(value) ? Number(value) : null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await readCapped(res, MAX_GITHUB_BYTES);
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

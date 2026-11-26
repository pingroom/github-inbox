/**
 * Notification threads as PingRoom Pings.
 *
 *   title    "Review requested · mobile#42"      (what happened, and where)
 *   message  "Fix the cooldown · by sam"          (the subject, and who)
 *            "Fix the cooldown · sam: can you…"   (with the comment, when there is one)
 *   button   "View PR", linking to github.com
 *
 * Text is cleaned and clipped to PingRoom's limits (ping.ts), and the link
 * must be https on github.com.
 */

import { buildPing, correlationId, joinParts, link, LIMITS, type PingBody } from "./ping";
import { isGitHubApiUrl, type SubjectDetail, type Thread } from "./github";

const LINKS = { hosts: ["github.com"] } as const;
export const INBOX_URL = "https://github.com/notifications";

/** The title's first half, per reason. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  agent_session_finished: "Copilot session done",
  approval_requested: "Approval requested",
  assign: "Assigned to you",
  author: "Update",
  ci_activity: "Workflow run",
  comment: "Update",
  invitation: "Invitation",
  manual: "Update",
  member_feature_requested: "Feature requested",
  mention: "You were mentioned",
  review_requested: "Review requested",
  security_advisory_credit: "Advisory credit",
  security_alert: "Security alert",
  state_change: "Update",
  subscribed: "Update",
  team_mention: "Your team was mentioned",
};

/** Reasons whose Ping is about a request, not a conversation: no comment text. */
const NO_COMMENT_REASONS: ReadonlySet<string> = new Set([
  "approval_requested",
  "review_requested",
  "security_alert",
  "invitation",
]);

/** Sent first when a poll finds more than the Worker sends one by one. */
const PRIORITY = ["mention", "team_mention", "review_requested", "assign", "approval_requested", "security_alert"];

const BUTTON_LABELS: Readonly<Record<string, string>> = {
  PullRequest: "View PR",
  Issue: "View issue",
  Discussion: "View discussion",
  Release: "View release",
  Commit: "View commit",
  CheckSuite: "View run",
  RepositoryInvitation: "View invitation",
};

/** Lower comes first. */
export function priorityOf(reason: string): number {
  const index = PRIORITY.indexOf(reason);
  return index === -1 ? PRIORITY.length : index;
}

/** Whether a thread's Ping shows the latest comment (a conversation) or only the subject and its author (a request). */
export function wantsComment(reason: string): boolean {
  return !NO_COMMENT_REASONS.has(reason);
}

/**
 * The `Idempotency-Key` for one thread at one update: a retry replays, a new
 * update is a new Ping. Printable ASCII only, so it is always a valid header.
 */
export function threadKey(thread: Thread): string {
  return `github-inbox:${thread.id}:${thread.updatedAt}`.replace(/[^\x21-\x7e]/g, "_").slice(0, 255);
}

export function threadPing(thread: Thread, detail: SubjectDetail | null): PingBody {
  const label = REASON_LABELS[thread.reason] ?? "GitHub";
  const number = numberOf(thread.subjectUrl);
  const where = number === null ? thread.repoName : `${thread.repoName}#${number}`;

  // A comment is someone else's words: on a request (a review request, say)
  // its writer is not the subject's author, so it is not used at all.
  const usable = detail !== null && (!detail.isComment || wantsComment(thread.reason)) ? detail : null;

  let who = "";
  if (usable?.actor != null) {
    const comment = usable.isComment ? commentText(usable.body) : "";
    who = comment === "" ? `by ${usable.actor}` : `${usable.actor}: ${comment}`;
  }

  const fromDetail = usable === null || usable.htmlUrl === null ? undefined : link(usable.htmlUrl, LINKS, buttonLabel(thread, usable));
  return buildPing({
    title: `${label} · ${where}`,
    message: joinParts([thread.subjectTitle, who], LIMITS.message),
    correlationId: correlationId("github", "thread", thread.id),
    link: fromDetail ?? link(fallbackUrl(thread), LINKS, buttonLabel(thread, null)),
  });
}

/** One Ping for the threads a burst did not send one by one. */
export function summaryPing(count: number, nowMs: number): { key: string; body: PingBody } {
  return {
    key: `github-inbox:summary:${nowMs}`,
    body: buildPing({
      title: `${count} more on GitHub`,
      message: `${count} more new notification${count === 1 ? "" : "s"} in your GitHub inbox.`,
      correlationId: correlationId("github", "inbox", "summary"),
      link: link(INBOX_URL, LINKS, "Open inbox"),
    }),
  };
}

export function connectedPing(nowMs: number): { key: string; body: PingBody } {
  return {
    key: `github-inbox:connected:${nowMs}`,
    body: buildPing({
      title: "GitHub inbox connected",
      message: "New GitHub notifications will arrive in this room.",
      correlationId: correlationId("github", "inbox", "connected"),
      link: link(INBOX_URL, LINKS, "Open inbox"),
    }),
  };
}

export type TokenProblem = "unauthorized" | "forbidden";

/** Told once per token and problem, so a revoked token is one Ping, not one a minute. */
export function tokenProblemPing(problem: TokenProblem, fineGrained: boolean, nowMs: number): { key: string; body: PingBody } {
  const message =
    problem === "unauthorized"
      ? "GitHub refused the token: it is wrong, expired or revoked. Set a new GITHUB_TOKEN."
      : fineGrained
        ? "Fine-grained tokens cannot read notifications. Use a classic token with the notifications scope."
        : "The token cannot read notifications. Give it the notifications scope.";
  return {
    key: `github-inbox:token:${problem}:${nowMs}`,
    body: buildPing({
      title: "GitHub inbox stopped",
      message,
      correlationId: correlationId("github", "inbox", "token"),
      urgent: true,
      link: link("https://github.com/settings/tokens", LINKS, "Manage tokens"),
    }),
  };
}

// ---------------------------------------------------------------------------

/** The issue, pull request or discussion number in an api.github.com URL. */
export function numberOf(apiUrl: string | null): string | null {
  if (apiUrl === null || !isGitHubApiUrl(apiUrl)) {
    return null;
  }
  const match = /\/(?:issues|pulls|discussions)\/(\d{1,12})$/.exec(pathOf(apiUrl) ?? "");
  return match?.[1] ?? null;
}

/** A github.com page for the thread when the detail read gave none. */
export function fallbackUrl(thread: Thread): string {
  const path = thread.subjectUrl === null || !isGitHubApiUrl(thread.subjectUrl) ? null : pathOf(thread.subjectUrl);
  const match = path === null ? null : /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls|commits|discussions|releases)\/([^/]+)$/.exec(path);
  if (match !== null) {
    const [, owner, repo, kind, id] = match;
    const base = `https://github.com/${owner}/${repo}`;
    switch (kind) {
      case "issues":
        return `${base}/issues/${id}`;
      case "pulls":
        return `${base}/pull/${id}`;
      case "commits":
        return `${base}/commit/${id}`;
      case "discussions":
        return `${base}/discussions/${id}`;
      default:
        // An API release URL carries the release id, not its tag.
        return `${base}/releases`;
    }
  }
  if (thread.repoHtmlUrl !== null) {
    return thread.subjectType === "CheckSuite" ? `${thread.repoHtmlUrl}/actions` : thread.repoHtmlUrl;
  }
  return INBOX_URL;
}

function buttonLabel(thread: Thread, detail: SubjectDetail | null): string {
  if (detail?.isComment === true) {
    return "View comment";
  }
  return BUTTON_LABELS[thread.subjectType] ?? "Open on GitHub";
}

/**
 * A comment's own words: quoted lines (a reply's `> ...`) and HTML comments
 * (template boilerplate) removed. `plain` in `joinParts` does the rest.
 */
function commentText(body: string | null): string {
  if (body === null) {
    return "";
  }
  return body
    .slice(0, 4_000)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join(" ")
    .trim();
}

function pathOf(raw: string): string | null {
  try {
    return new URL(raw).pathname;
  } catch {
    return null;
  }
}

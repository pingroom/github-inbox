/**
 * The PingRoom incoming-webhook body this Worker produces, and its helpers:
 * plain-text cleaning, grapheme-safe clipping, link allow-listing and
 * correlation ids.
 *
 * Limits come from PingRoom's incoming-webhook validation: title 40, message
 * 120 (the private-room ceiling; public rooms allow 160 but the webhook URL
 * does not reveal which kind of room it is), link button label 26, URL 2048,
 * correlation_id 255.
 */

export const LIMITS = {
  title: 40,
  message: 120,
  buttonLabel: 26,
  url: 2048,
  correlationId: 255,
} as const;

/** The tappable-link pair PingRoom reads from `data`. */
export interface PingLink {
  url: string;
  button_label: string;
}

/** The body POSTed to `/api/webhooks/{roomCode}/{secret}`: an ordinary Ping. */
export interface PingBody {
  title: string;
  message?: string;
  correlation_id: string;
  /** Present, and `true`, only for failures. */
  is_urgent?: true;
  data?: PingLink;
}

// ---------------------------------------------------------------------------
// Plain text and clipping
// ---------------------------------------------------------------------------

/** Longest input `plain` looks at, in UTF-16 units. */
const MAX_INPUT = 10_000;

/** Whitespace-like controls that become a single space. */
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
/** Remaining C0/C1 controls and DEL. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
/** The same set, without the global flag, for yes/no tests. */
const HAS_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
/**
 * Invisible characters that can hide or reorder text: zero-width space, word
 * joiner, byte-order mark and the bidi embedding, override and isolate
 * controls. ZWJ, ZWNJ, LRM and RLM stay, because emoji sequences and
 * right-to-left scripts need them.
 */
const INVISIBLES = /[\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;
/** A surrogate half with no partner. PHP's json_decode rejects these. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Markdown links and images, `[label](url)` and `![alt](url)`. PingRoom
 * clients draw `[label](https://...)` as a tappable label that hides its
 * destination, so a label from a third party must never reach a Ping with its
 * URL attached. Only the label is kept.
 */
const MARKDOWN_LINKS = /!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g;

/**
 * Plain text from any value: strings only, no control characters, no line
 * breaks, no markdown link targets, single spaces, trimmed. Anything that is
 * not a string becomes the empty string.
 */
export function plain(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // Nothing here is ever longer than a few hundred characters once clipped, so
  // do not run five regexes over a 500 KB pull request body.
  return value
    .slice(0, MAX_INPUT)
    .replace(LONE_SURROGATES, "\uFFFD")
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(INVISIBLES, "")
    .replace(MARKDOWN_LINKS, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Length in Unicode code points, which is how PingRoom counts characters. */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count++;
  }
  return count;
}

/**
 * Clip to at most `max` code points. The cut falls on a grapheme boundary, so
 * an emoji, a flag or a combining sequence is never split, and the result ends
 * in a single "…" (U+2026) when anything was removed. Never throws and never
 * rejects: short input comes back unchanged.
 */
export function clip(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (codePointLength(text) <= max) {
    return text;
  }
  const budget = max - 1;
  let used = 0;
  let kept = "";
  for (const { segment } of segmenter.segment(text)) {
    const size = codePointLength(segment);
    if (used + size > budget) {
      break;
    }
    kept += segment;
    used += size;
  }
  return `${kept.trimEnd()}…`;
}

/** `clip(plain(value), max)`. */
export function text(value: unknown, max: number): string {
  return clip(plain(value), max);
}

/** Join the non-empty parts with a middle dot, then clip the whole. */
export function joinParts(parts: ReadonlyArray<unknown>, max: number): string {
  const cleaned: string[] = [];
  for (const part of parts) {
    const value = plain(part);
    if (value !== "") {
      cleaned.push(value);
    }
  }
  return clip(cleaned.join(" · "), max);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Which hosts a link may point at: an allow-list of registrable domains, each
 * matching itself and its subdomains, on the default port.
 */
export interface LinkPolicy {
  readonly hosts: readonly string[];
}

/**
 * A link for `data.url` and `data.button_label`, or `undefined` when the URL
 * is missing, malformed, too long, carries credentials, is not https, or
 * points at a host outside the policy.
 * The URL returned is the parsed, normalised form.
 */
export function link(raw: unknown, policy: LinkPolicy, label: string): PingLink | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const candidate = raw.trim();
  if (candidate === "" || candidate.length > LIMITS.url || HAS_CONTROL.test(candidate)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  if (parsed.hostname === "") {
    return undefined;
  }
  if (parsed.port !== "" || !hostAllowed(parsed.hostname, policy.hosts)) {
    return undefined;
  }
  if (parsed.href.length > LIMITS.url) {
    return undefined;
  }
  const buttonLabel = text(label, LIMITS.buttonLabel);
  if (buttonLabel === "") {
    return undefined;
  }
  return { url: parsed.href, button_label: buttonLabel };
}

/** True when `hostname` is one of `hosts` or a subdomain of one. */
export function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** Stable id for the thing an event is about, e.g. `github:run:123`. */
export function correlationId(...parts: ReadonlyArray<string | number>): string {
  const joined = parts.map((part) => plain(String(part))).join(":");
  return joined.length > LIMITS.correlationId ? joined.slice(0, LIMITS.correlationId) : joined;
}

export interface PingInput {
  title: string;
  message?: string;
  correlationId: string;
  urgent?: boolean;
  link?: PingLink | undefined;
}

/** An ordinary Ping: one alert per POST. */
export function buildPing(input: PingInput): PingBody {
  const body: PingBody = {
    title: text(input.title, LIMITS.title) || "PingRoom",
    correlation_id: input.correlationId,
  };
  const message = text(input.message, LIMITS.message);
  if (message !== "") {
    body.message = message;
  }
  if (input.urgent === true) {
    body.is_urgent = true;
  }
  if (input.link !== undefined) {
    body.data = input.link;
  }
  return body;
}

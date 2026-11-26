/**
 * Hand a translated body to PingRoom.
 *
 * The destination is always `{PINGROOM_API_BASE}/api/webhooks/{roomCode}/{secret}`
 * on a single origin fixed by the operator. Nothing in a request can change the
 * host, the scheme or the port: the room code and secret are the only parts of
 * the URL that come from the caller, and they are checked against a strict
 * pattern before the URL is built, then the built URL is checked again.
 */

import { isRecord, type JsonObject } from "./json";
import type { PingBody } from "./ping";
import { errorResponse, jsonResponse } from "./respond";
import { USER_AGENT } from "./version";

export const DEFAULT_API_BASE = "https://api.pingroom.io";
export const UPSTREAM_TIMEOUT_MS = 8_000;
export const MAX_UPSTREAM_BYTES = 64 * 1024;

/** Room codes are 12 upper-case letters and digits; a removed room's code starts with "-". */
export const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Webhook secrets are random letters and digits; 48 characters is the longest PingRoom issues. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The configured PingRoom origin, or null when `PINGROOM_API_BASE` is unusable.
 * It must be a bare origin: https, or http on a loopback host for local
 * development only; no credentials, path, query or fragment.
 */
export function resolveApiBase(env: { PINGROOM_API_BASE?: string | undefined }): URL | null {
  const configured = env.PINGROOM_API_BASE?.trim();
  const raw = configured === undefined || configured === "" ? DEFAULT_API_BASE : configured;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname !== "/") {
    return null;
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url;
  }
  return null;
}

/**
 * `{origin}/api/webhooks/{roomCode}/{secret}`, or null when either credential
 * fails its pattern or the built URL is not exactly what was intended.
 */
export function forwardUrl(base: URL, roomCode: string, secret: string): URL | null {
  if (!ROOM_CODE_PATTERN.test(roomCode) || !SECRET_PATTERN.test(secret)) {
    return null;
  }
  const path = `/api/webhooks/${roomCode}/${secret}`;
  let url: URL;
  try {
    url = new URL(`${base.origin}${path}`);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.pathname !== path || url.search !== "" || url.hash !== "") {
    return null;
  }
  return url;
}

export interface ForwardArgs {
  base: URL;
  roomCode: string;
  secret: string;
  body: PingBody;
  idempotencyKey: string | null;
}

/**
 * POST the body and shape PingRoom's answer: 2xx and 4xx pass through with
 * PingRoom's status and JSON body (and `Retry-After`); a network failure, a
 * timeout, a redirect, a 5xx or a reply that is not a JSON object becomes a
 * 502. A redirect is never followed.
 */
export async function forward(args: ForwardArgs): Promise<Response> {
  const url = forwardUrl(args.base, args.roomCode, args.secret);
  if (url === null) {
    return errorResponse(400, "invalid_path", "Room code or secret is not in the expected format.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (args.idempotencyKey !== null) {
    headers["Idempotency-Key"] = args.idempotencyKey;
  }

  let res: Response;
  try {
    res = await fetch(url.href, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return timedOut
      ? errorResponse(502, "upstream_timeout", "PingRoom did not answer in time.")
      : errorResponse(502, "upstream_unreachable", "Could not reach PingRoom.");
  }

  if (res.status >= 300 && res.status < 400) {
    return errorResponse(502, "upstream_redirect", "PingRoom answered with a redirect, which is not followed.");
  }

  const parsed = await readJsonObject(res);
  const retryAfter = retryAfterOf(res, parsed);
  const extra: Record<string, string> = retryAfter === undefined ? {} : { "Retry-After": retryAfter };

  if (parsed === null) {
    return errorResponse(502, "upstream_invalid_response", "PingRoom answered with something other than a JSON object.", extra);
  }
  const ok = res.status >= 200 && res.status < 300;
  const clientError = res.status >= 400 && res.status < 500;
  if (ok || clientError) {
    return jsonResponse(parsed, res.status, extra);
  }
  return jsonResponse(
    {
      success: false,
      error: "upstream_error",
      message: "PingRoom could not process the request. Try again later.",
      upstream_status: res.status,
    },
    502,
    extra,
  );
}

async function readJsonObject(res: Response): Promise<JsonObject | null> {
  const text = await readCapped(res, MAX_UPSTREAM_BYTES);
  if (text === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The response body as text, or null when it is longer than `max` bytes or unreadable. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  if (res.body === null) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** A whole-seconds `Retry-After` from the header, or PingRoom's `retry_after` body field. */
function retryAfterOf(res: Response, body: JsonObject | null): string | undefined {
  const header = res.headers.get("Retry-After")?.trim();
  if (header !== undefined && /^\d{1,7}$/.test(header)) {
    return header;
  }
  const fromBody = body?.["retry_after"];
  if (typeof fromBody === "number" && Number.isSafeInteger(fromBody) && fromBody >= 0 && fromBody <= 9_999_999) {
    return String(fromBody);
  }
  return undefined;
}

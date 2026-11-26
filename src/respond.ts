/**
 * Every response this Worker sends is JSON, never cacheable, never sniffable.
 * There are no HTML responses anywhere.
 */

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...extraHeaders },
  });
}

/** The same `{success: false, error, message}` envelope PingRoom uses. */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse({ success: false, error, message }, status, extraHeaders);
}

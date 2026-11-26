import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE, forward, forwardUrl, resolveApiBase, ROOM_CODE_PATTERN, SECRET_PATTERN } from "../src/forward";

describe("resolveApiBase", () => {
  it("defaults to https://api.pingroom.io", () => {
    expect(resolveApiBase({})?.origin).toBe("https://api.pingroom.io");
    expect(resolveApiBase({ PINGROOM_API_BASE: "" })?.origin).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase({ PINGROOM_API_BASE: "   " })?.origin).toBe(DEFAULT_API_BASE);
  });

  it("accepts a bare https origin, with or without a trailing slash and port", () => {
    expect(resolveApiBase({ PINGROOM_API_BASE: "https://pingroom.example" })?.origin).toBe("https://pingroom.example");
    expect(resolveApiBase({ PINGROOM_API_BASE: "https://pingroom.example/" })?.origin).toBe("https://pingroom.example");
    expect(resolveApiBase({ PINGROOM_API_BASE: "https://pingroom.example:8443" })?.origin).toBe("https://pingroom.example:8443");
  });

  it("accepts plain http only on loopback", () => {
    expect(resolveApiBase({ PINGROOM_API_BASE: "http://localhost:8000" })?.origin).toBe("http://localhost:8000");
    expect(resolveApiBase({ PINGROOM_API_BASE: "http://127.0.0.1" })?.origin).toBe("http://127.0.0.1");
    expect(resolveApiBase({ PINGROOM_API_BASE: "http://[::1]:9000" })?.origin).toBe("http://[::1]:9000");
    expect(resolveApiBase({ PINGROOM_API_BASE: "http://pingroom.example" })).toBeNull();
    expect(resolveApiBase({ PINGROOM_API_BASE: "http://localhost.evil.example" })).toBeNull();
  });

  it.each([
    "https://pingroom.example/api",
    "https://pingroom.example/x/",
    "https://u:p@pingroom.example",
    "https://pingroom.example?a=1",
    "https://pingroom.example#a",
    "wss://pingroom.example",
    "file:///etc/passwd",
    "//pingroom.example",
    "pingroom.example",
    "https://",
  ])("refuses %j", (value) => {
    expect(resolveApiBase({ PINGROOM_API_BASE: value })).toBeNull();
  });
});

describe("forwardUrl", () => {
  const base = new URL("https://api.pingroom.io");

  it("builds /api/webhooks/{room}/{secret} on the base origin", () => {
    expect(forwardUrl(base, "ABCDEF123456", "s3cr3t_-Token")?.href).toBe("https://api.pingroom.io/api/webhooks/ABCDEF123456/s3cr3t_-Token");
  });

  it("builds on a base with a port", () => {
    expect(forwardUrl(new URL("http://localhost:8000"), "ROOM", "secret")?.href).toBe("http://localhost:8000/api/webhooks/ROOM/secret");
  });

  it.each([
    ["", "secret"],
    ["ROOM", ""],
    ["..", "secret"],
    ["ROOM", ".."],
    ["a/b", "secret"],
    ["ROOM", "a/b"],
    ["a\\b", "secret"],
    ["ROOM", "a?b=1"],
    ["ROOM", "a#b"],
    ["ROOM", "a@evil.example"],
    ["ROOM", "evil.example:80"],
    ["//evil.example", "secret"],
    ["ROOM", "a b"],
    ["ROOM", "a%2Fb"],
    ["R".repeat(65), "secret"],
    ["ROOM", "s".repeat(129)],
  ])("refuses room %j with secret %j", (room, secret) => {
    expect(forwardUrl(base, room, secret)).toBeNull();
  });

  it("accepts the room codes and secrets PingRoom issues", () => {
    expect(ROOM_CODE_PATTERN.test("ABCDEF123456")).toBe(true);
    expect(ROOM_CODE_PATTERN.test("-ABCDEF123456")).toBe(true);
    expect(SECRET_PATTERN.test("x".repeat(128))).toBe(true);
  });

  it("can only ever produce a URL on the base origin, whatever it is fed", () => {
    // A seeded generator over an alphabet of characters that matter to URL parsing.
    const safe = ["A", "z", "0", "9", "-", "_", "k", "Q"];
    const alphabet = [".", "/", "\\", "@", ":", "?", "#", "%", "2", "e", " ", "\n", "\u{FF0E}", "\u{3002}", "\u{2215}", "&", "=", "[", "]", "~", "*"];
    let state = 0x2545f491;
    const next = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
    const word = (): string => {
      let out = "";
      const length = 1 + Math.floor(next() * 14);
      for (let i = 0; i < length; i++) {
        const pool = next() < 0.7 ? safe : alphabet;
        out += pool[Math.floor(next() * pool.length)];
      }
      return out;
    };

    let built = 0;
    for (let i = 0; i < 5000; i++) {
      const room = word();
      const secret = word();
      const url = forwardUrl(base, room, secret);
      if (url === null) {
        continue;
      }
      built++;
      expect(url.origin).toBe("https://api.pingroom.io");
      expect(url.pathname).toBe(`/api/webhooks/${room}/${secret}`);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.username).toBe("");
      expect(url.port).toBe("");
    }
    // The generator does produce some acceptable pairs, so the loop above checked something.
    expect(built).toBeGreaterThan(100);
  });
});

describe("forward", () => {
  const base = new URL("https://api.pingroom.io");
  const args = { base, roomCode: "ABCDEF123456", secret: "secret", body: { title: "t", correlation_id: "c" }, idempotencyKey: "k-1" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(response: Response | Error) {
    const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("POSTs the JSON body with the Idempotency-Key and never follows a redirect", async () => {
    const mock = answer(Response.json({ success: true }));
    const res = await forward(args);
    expect(res.status).toBe(200);
    const [url, init] = mock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.pingroom.io/api/webhooks/ABCDEF123456/secret");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual(args.body);
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("k-1");
    expect(headers.get("User-Agent")).toBe("pingroom-github-inbox/0.1.0");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("passes a 4xx through with its body and Retry-After", async () => {
    answer(Response.json({ success: false, error: "cooldown_active" }, { status: 429, headers: { "Retry-After": "4" } }));
    const res = await forward(args);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("4");
    expect(await res.json()).toEqual({ success: false, error: "cooldown_active" });
  });

  it.each([
    ["a 5xx", () => Response.json({ error: "x" }, { status: 503 }), "upstream_error"],
    ["a redirect", () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }), "upstream_redirect"],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "upstream_invalid_response"],
    ["a network failure", () => new TypeError("fetch failed"), "upstream_unreachable"],
  ])("turns %s into a 502", async (_case, make, error) => {
    answer(make());
    const res = await forward(args);
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe(error);
  });
});

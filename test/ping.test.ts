import { describe, expect, it } from "vitest";
import {
  buildPing,
  clip,
  correlationId,
  hostAllowed,
  joinParts,
  LIMITS,
  link,
  plain,
  text,
} from "../src/ping";

// Escapes below use the \u{...} form on purpose: it keeps invisible and
// unpaired characters visible in the source.
const ELLIPSIS = "\u{2026}";
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
const FLAG_DE = "\u{1F1E9}\u{1F1EA}";
const E_ACUTE = "e\u{301}";
const GRIN = "\u{1F600}";

const codePoints = (value: string): number => Array.from(value).length;

describe("plain", () => {
  it("returns an empty string for anything that is not a string", () => {
    for (const value of [undefined, null, 5, true, {}, [], ["a"]]) {
      expect(plain(value)).toBe("");
    }
  });

  it("turns newlines, tabs and line separators into single spaces", () => {
    expect(plain("a\nb\r\nc\td\u{2028}e\u{2029}f\u{85}g")).toBe("a b c d e f g");
  });

  it("removes other control characters", () => {
    expect(plain("a\u{0}b\u{7}c\u{1b}d\u{7f}e\u{9f}f")).toBe("abcdef");
  });

  it("removes zero-width and bidi override characters", () => {
    expect(plain("a\u{200B}b\u{2060}c\u{FEFF}d\u{202E}e\u{2066}f\u{2069}g")).toBe("abcdefg");
  });

  it("keeps ZWJ sequences, ZWNJ and directional marks", () => {
    expect(plain(FAMILY)).toBe(FAMILY);
    expect(plain("a\u{200C}b")).toBe("a\u{200C}b");
    expect(plain("a\u{200E}b\u{200F}c")).toBe("a\u{200E}b\u{200F}c");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(plain("  a   b \u{a0} c  ")).toBe("a b c");
  });

  it("keeps only the label of markdown links and images", () => {
    expect(plain("see [the docs](https://evil.example/login) now")).toBe("see the docs now");
    expect(plain("![chart](https://evil.example/x.png) here")).toBe("chart here");
    expect(plain('[a](https://x.example/p "tip") b')).toBe("a b");
    expect(plain("[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) ok")).toBe("wiki ok");
    expect(plain("[](https://x.example)")).toBe("");
  });

  it("leaves bare URLs and ordinary brackets alone", () => {
    expect(plain("fix https://example.com/a [WIP] (draft)")).toBe("fix https://example.com/a [WIP] (draft)");
  });

  it("replaces lone surrogates and keeps valid pairs", () => {
    // Guard the fixtures themselves: the source really holds unpaired halves.
    expect("a\u{D800}b".charCodeAt(1)).toBe(0xd800);
    expect("a\u{DC00}b".charCodeAt(1)).toBe(0xdc00);
    expect(plain("a\u{D800}b")).toBe("a\u{FFFD}b");
    expect(plain("a\u{DC00}b")).toBe("a\u{FFFD}b");
    expect(plain(`a${GRIN}b`)).toBe(`a${GRIN}b`);
    expect(plain("a\u{D800}")).toBe("a\u{FFFD}");
  });

  it("copes with very long input", () => {
    const long = "[x](https://a.example/".repeat(20_000) + "\n".repeat(50_000);
    expect(plain(long).length).toBeLessThanOrEqual(10_000);
  });
});

describe("clip", () => {
  it("returns short text unchanged", () => {
    expect(clip("hello", 40)).toBe("hello");
    expect(clip("", 40)).toBe("");
  });

  it("returns text of exactly the limit unchanged", () => {
    const exact = "a".repeat(40);
    expect(clip(exact, 40)).toBe(exact);
  });

  it("clips one over the limit to the limit, ending in an ellipsis", () => {
    const out = clip("a".repeat(41), 40);
    expect(out).toBe(`${"a".repeat(39)}${ELLIPSIS}`);
    expect(codePoints(out)).toBe(40);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(clip(GRIN.repeat(40), 40)).toBe(GRIN.repeat(40));
    expect(clip(GRIN.repeat(41), 40)).toBe(`${GRIN.repeat(39)}${ELLIPSIS}`);
  });

  it("never splits a ZWJ emoji sequence", () => {
    const out = clip(`${"a".repeat(38)}${FAMILY}b`, 40);
    expect(out).toBe(`${"a".repeat(38)}${ELLIPSIS}`);
  });

  it("never splits a flag", () => {
    const out = clip(`${"a".repeat(38)}${FLAG_DE}b`, 40);
    expect(out).toBe(`${"a".repeat(38)}${ELLIPSIS}`);
  });

  it("never separates a combining mark from its letter", () => {
    // 37 + 2 + 2 = 41 code points. The first "e" + accent fits the 39-point
    // budget; the second does not.
    const out = clip(`${"a".repeat(37)}${E_ACUTE}${E_ACUTE}`, 40);
    expect(out).toBe(`${"a".repeat(37)}${E_ACUTE}${ELLIPSIS}`);
    expect(codePoints(out)).toBe(40);
  });

  it("keeps a whole grapheme that fits exactly under the budget", () => {
    // 34 + 5 = 39, which is the budget. The next character is dropped.
    const out = clip(`${"a".repeat(34)}${FAMILY}bbbbbbbb`, 40);
    expect(out).toBe(`${"a".repeat(34)}${FAMILY}${ELLIPSIS}`);
    expect(codePoints(out)).toBe(40);
  });

  it("drops trailing whitespace before the ellipsis", () => {
    expect(clip(`${"a".repeat(38)} bbbb`, 40)).toBe(`${"a".repeat(38)}${ELLIPSIS}`);
  });

  it("reduces to an ellipsis when the first grapheme alone does not fit", () => {
    expect(clip(`${FAMILY}\u{200D}\u{1F466}`, 3)).toBe(ELLIPSIS);
  });

  it("returns an empty string for a limit of zero", () => {
    expect(clip("abc", 0)).toBe("");
  });

  it("never exceeds the limit, whatever the input", () => {
    const samples = ["x".repeat(500), GRIN.repeat(500), E_ACUTE.repeat(300), FLAG_DE.repeat(200), FAMILY.repeat(100)];
    for (const sample of samples) {
      for (const max of [1, 2, 5, 26, 40, 120]) {
        expect(codePoints(clip(sample, max))).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe("text and joinParts", () => {
  it("cleans, then clips", () => {
    expect(text("a\nb", 40)).toBe("a b");
    expect(text("x".repeat(100), 10)).toBe(`${"x".repeat(9)}${ELLIPSIS}`);
  });

  it("joins non-empty parts with a middle dot", () => {
    expect(joinParts(["repo", "", undefined, null, 5, "title"], 120)).toBe("repo \u{B7} title");
  });

  it("clips the joined text", () => {
    const out = joinParts(["a".repeat(100), "b".repeat(100)], 120);
    expect(codePoints(out)).toBe(120);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
  });
});

describe("hosts", () => {
  it("matches hosts and their subdomains only", () => {
    expect(hostAllowed("github.com", ["github.com"])).toBe(true);
    expect(hostAllowed("gist.github.com", ["github.com"])).toBe(true);
    expect(hostAllowed("evilgithub.com", ["github.com"])).toBe(false);
    expect(hostAllowed("github.com.evil.com", ["github.com"])).toBe(false);
  });
});

describe("link allow-listing", () => {
  const github = { hosts: ["github.com"] } as const;

  it("accepts an https URL on an allowed host and normalises it", () => {
    expect(link("https://github.com/a/b/pull/1", github, "View PR")).toEqual({
      url: "https://github.com/a/b/pull/1",
      button_label: "View PR",
    });
    expect(link("  https://GITHUB.com/a  ", github, "x")?.url).toBe("https://github.com/a");
  });

  it("accepts subdomains of an allowed host", () => {
    expect(link("https://gist.github.com/x", github, "x")?.url).toBe("https://gist.github.com/x");
  });

  it.each([
    ["http scheme", "http://github.com/a"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["ftp scheme", "ftp://github.com/a"],
    ["protocol-relative", "//github.com/a"],
    ["no scheme", "github.com/a"],
    ["lookalike suffix", "https://evilgithub.com/a"],
    ["allowed host as a subdomain of another", "https://github.com.evil.com/a"],
    ["userinfo trick", "https://github.com@evil.com/a"],
    ["credentials", "https://user:pw@github.com/a"],
    ["non-default port", "https://github.com:8443/a"],
    ["trailing dot host", "https://github.com./a"],
    ["ideographic full stop", "https://github.com\u{3002}evil.com/a"],
    ["backslash host trick", "https://evil.com\\@github.com/a"],
    ["embedded newline", "https://github.com/a\nb"],
    ["embedded control", "https://github.com/a\u{0}b"],
    ["empty", ""],
    ["blank", "   "],
    ["not a URL", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(link(url, github, "x")).toBeUndefined();
  });

  it("rejects values that are not strings", () => {
    for (const value of [undefined, null, 5, {}, ["https://github.com/a"]]) {
      expect(link(value, github, "x")).toBeUndefined();
    }
  });

  it("accepts a URL of exactly 2048 characters and rejects 2049", () => {
    const prefix = "https://github.com/";
    const exact = `${prefix}${"a".repeat(LIMITS.url - prefix.length)}`;
    expect(exact.length).toBe(2048);
    expect(link(exact, github, "x")?.url).toBe(exact);
    expect(link(`${exact}a`, github, "x")).toBeUndefined();
  });

  it("clips the button label to 26 characters", () => {
    const out = link("https://github.com/a", github, "View the pull request on GitHub right now");
    expect(out?.button_label).toBe(`View the pull request on${ELLIPSIS}`);
    expect(codePoints(out?.button_label ?? "")).toBeLessThanOrEqual(26);
  });
});

describe("correlation ids", () => {
  it("joins parts with a colon", () => {
    expect(correlationId("github", "run", 123)).toBe("github:run:123");
  });

  it("never exceeds 255 characters", () => {
    expect(correlationId("a", "b".repeat(400)).length).toBe(255);
  });

  it("is free of control characters", () => {
    expect(correlationId("x", "a\nb")).toBe("x:a b");
  });
});

describe("bodies", () => {
  it("builds an ordinary Ping", () => {
    expect(buildPing({ title: "Hi", message: "There", correlationId: "c:1" })).toEqual({
      title: "Hi",
      message: "There",
      correlation_id: "c:1",
    });
  });

  it("clips the title to 40 and the message to 120", () => {
    const body = buildPing({ title: "t".repeat(60), message: "m".repeat(200), correlationId: "c:1" });
    expect(codePoints(body.title)).toBe(40);
    expect(codePoints(body.message ?? "")).toBe(120);
  });

  it("omits an empty message and falls back to a title", () => {
    const body = buildPing({ title: "\n", message: "  ", correlationId: "c:1" });
    expect(body.title).toBe("PingRoom");
    expect("message" in body).toBe(false);
  });

  it("sets is_urgent only for true", () => {
    expect("is_urgent" in buildPing({ title: "t", correlationId: "c" })).toBe(false);
    expect("is_urgent" in buildPing({ title: "t", correlationId: "c", urgent: false })).toBe(false);
    expect(buildPing({ title: "t", correlationId: "c", urgent: true }).is_urgent).toBe(true);
  });

  it("attaches a link as data", () => {
    const body = buildPing({
      title: "t",
      correlationId: "c",
      link: { url: "https://github.com/a", button_label: "Open" },
    });
    expect(body.data).toEqual({ url: "https://github.com/a", button_label: "Open" });
  });
});

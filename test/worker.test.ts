/// <reference types="vite/client" />
/**
 * The entry module and wrangler.toml: what the README promises about the
 * Worker's surface and its secrets.
 */

import { describe, expect, it, vi } from "vitest";
import * as entry from "../src/worker";
import wrangler from "../wrangler.toml?raw";

const configuration = wrangler
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("the Worker", () => {
  it("exports only the handler and the Durable Object class", () => {
    expect(Object.keys(entry).sort()).toEqual(["GitHubInbox", "default"]);
    expect(typeof entry.default.scheduled).toBe("function");
    expect("fetch" in entry.default).toBe(false);
  });

  it("polls through the one Durable Object named inbox on every cron", async () => {
    const poll = vi.fn(async () => undefined);
    const getByName = vi.fn(() => ({ poll }));
    const env = { INBOX: { getByName } } as unknown as entry.WorkerEnv;
    await entry.default.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect(getByName).toHaveBeenCalledWith("inbox");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("runs every minute and has no HTTP surface", () => {
    expect(configuration).toMatch(/^name = "pingroom-github-inbox"$/m);
    expect(configuration).toMatch(/^main = "src\/worker\.ts"$/m);
    expect(configuration).toMatch(/^crons = \["\* \* \* \* \*"\]$/m);
    expect(configuration).toMatch(/^workers_dev = false$/m);
    expect(configuration).toMatch(/^preview_urls = false$/m);
    expect(configuration).not.toMatch(/\broutes?\b|\bzone_name\b|\bcustom_domain\b|\bpattern\b/);
  });

  it("binds the SQLite-backed Durable Object", () => {
    expect(configuration).toMatch(/name = "INBOX"\nclass_name = "GitHubInbox"/);
    expect(configuration).toMatch(/new_sqlite_classes = \["GitHubInbox"\]/);
  });

  it("does not put the token or the webhook URL in plaintext vars", () => {
    expect(configuration).not.toMatch(/GITHUB_TOKEN|PINGROOM_WEBHOOK_URL|\[vars\]/);
  });
});

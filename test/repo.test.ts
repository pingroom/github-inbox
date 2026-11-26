/// <reference types="vite/client" />
/**
 * Properties of the repository itself that the README promises.
 */

import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { USER_AGENT, VERSION } from "../src/version";
import license from "../LICENSE?raw";
import npmrc from "../.npmrc?raw";
import gitignore from "../.gitignore?raw";

describe("repository", () => {
  it("keeps src/version.ts in step with package.json", () => {
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`pingroom-github-inbox/${pkg.version}`);
  });

  it("has no runtime dependencies", () => {
    expect("dependencies" in pkg).toBe(false);
  });

  it("keeps local secrets out of git", () => {
    expect(gitignore).toMatch(/^\.dev\.vars$/m);
  });

  it("holds new dependencies back for 14 days", () => {
    expect(npmrc).toMatch(/^min-release-age=14$/m);
  });

  it("is MIT licensed to PingRoom", () => {
    expect(license.startsWith("MIT License\n\nCopyright (c) 2026 PingRoom\n")).toBe(true);
  });
});

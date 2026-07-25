import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPinnedPi } from "./pinned-pi.js";

describe("getPinnedPi", () => {
  it("resolves the bundled pi runtime with its exact pinned version", () => {
    const info = getPinnedPi();
    expect(info).not.toBeNull();
    expect(info!.path.endsWith(path.join("dist", "cli.js"))).toBe(true);
    expect(info!.path).toContain(path.join("@earendil-works", "pi-coding-agent"));
    expect(existsSync(info!.path)).toBe(true);
    expect(info!.version).toBe("0.82.1");
  });

  it("honors an existing override path (test seam)", () => {
    // Any real file works as an override target; the resolver only checks existence.
    const override = fileURLToPath(import.meta.url);
    const info = getPinnedPi(override);
    expect(info).toEqual({ path: override, version: "test-override" });
  });

  it("falls back to the bundled runtime when the override path does not exist", () => {
    const info = getPinnedPi("/nonexistent/fake-pi");
    expect(info).not.toBeNull();
    expect(info!.path).toContain(path.join("@earendil-works", "pi-coding-agent"));
  });
});

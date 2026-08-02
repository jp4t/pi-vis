import { describe, expect, it } from "vitest";
import { buildElectronLaunchArgs } from "./electron-launch.mjs";

describe("buildElectronLaunchArgs", () => {
  it("prepends the Linux test-only sandbox switch before the app entry", () => {
    const args = ["/workspace/out/main/index.js", "--inspect"];

    expect(buildElectronLaunchArgs(args, "linux")).toEqual([
      "--no-sandbox",
      "/workspace/out/main/index.js",
      "--inspect",
    ]);
    expect(args).toEqual(["/workspace/out/main/index.js", "--inspect"]);
  });

  it("moves and deduplicates an existing Linux sandbox switch", () => {
    expect(
      buildElectronLaunchArgs(
        ["/workspace/out/main/index.js", "--no-sandbox", "--inspect", "--no-sandbox"],
        "linux",
      ),
    ).toEqual(["--no-sandbox", "/workspace/out/main/index.js", "--inspect"]);
  });

  it.each(["darwin", "win32"] as const)("preserves %s launch arguments", (platform) => {
    const args = ["/workspace/out/main/index.js", "--inspect"];
    const result = buildElectronLaunchArgs(args, platform);

    expect(result).toEqual(args);
    expect(result).not.toBe(args);
  });
});

import fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import installedPiPackage from "../node_modules/@earendil-works/pi-coding-agent/package.json";
import projectPackage from "../package.json";

const PINNED_PI_VERSION = "0.82.1";
const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

describe("pinned Pi runtime", () => {
  it("keeps the manifest, installed package, and executable layout pinned exactly", () => {
    // Production dependency: the app ships this exact pi and runs nothing else.
    expect(projectPackage.dependencies["@earendil-works/pi-coding-agent"]).toBe(PINNED_PI_VERSION);
    expect(installedPiPackage.version).toBe(PINNED_PI_VERSION);
    expect(fs.existsSync(join(piPackageRoot, "dist", "cli.js"))).toBe(true);
    for (const packageName of ["pi-agent-core", "pi-ai"]) {
      const dependencyPackage = JSON.parse(
        fs.readFileSync(
          join(piPackageRoot, "node_modules", "@earendil-works", packageName, "package.json"),
          "utf8",
        ),
      ) as { version: string };
      expect(dependencyPackage.version).toBe(PINNED_PI_VERSION);
    }
  });

  it("ships the 0.81–0.82 public SDK surfaces used by Pi-Vis", async () => {
    const agentSessionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "agent-session.d.ts"),
      "utf8",
    );
    const extensionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    const publicIndexTypes = fs.readFileSync(join(piPackageRoot, "dist", "index.d.ts"), "utf8");

    expect(agentSessionTypes).toContain('type: "summarization_retry_scheduled"');
    expect(agentSessionTypes).toContain('type: "bash_execution_update"');
    expect(agentSessionTypes).toContain("getAvailableThinkingLevels(): ThinkingLevel[]");
    expect(agentSessionTypes).toContain("id?: string");
    expect(extensionTypes).toContain("constrainedSampling?: false | ConstrainedSamplingConfig");
    expect(extensionTypes).toContain("outputPad: number");
    expect(publicIndexTypes).toContain("resolveModelScopeWithDiagnostics");

    const pi = await import("@earendil-works/pi-coding-agent");
    expect(typeof pi.resolveModelScopeWithDiagnostics).toBe("function");
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import installedPiPackage from "../node_modules/@earendil-works/pi-coding-agent/package.json";
import projectPackage from "../package.json";

const PINNED_PI_VERSION = "0.83.0";
const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");

describe("pinned Pi runtime", () => {
  it("keeps the manifest, installed package, and executable layout pinned exactly", () => {
    // Production dependency: the app ships this exact pi and runs nothing else.
    expect(projectPackage.dependencies["@earendil-works/pi-coding-agent"]).toBe(PINNED_PI_VERSION);
    expect(installedPiPackage.version).toBe(PINNED_PI_VERSION);
    expect(fs.existsSync(join(piPackageRoot, "dist", "cli.js"))).toBe(true);
    for (const packageName of ["pi-agent-core", "pi-ai", "pi-tui"]) {
      const dependencyPackage = JSON.parse(
        fs.readFileSync(
          join(piPackageRoot, "node_modules", "@earendil-works", packageName, "package.json"),
          "utf8",
        ),
      ) as { version: string };
      expect(dependencyPackage.version).toBe(PINNED_PI_VERSION);
    }
    const typeboxPackage = JSON.parse(
      fs.readFileSync(join(piPackageRoot, "node_modules", "typebox", "package.json"), "utf8"),
    ) as { version: string };
    expect(typeboxPackage.version).toBe("1.3.7");
  });

  it("ships the 0.81–0.83 public SDK surfaces used by Pi-Vis", async () => {
    const agentSessionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "agent-session.d.ts"),
      "utf8",
    );
    const extensionTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "extensions", "types.d.ts"),
      "utf8",
    );
    const extensionRunnerTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "extensions", "runner.d.ts"),
      "utf8",
    );
    const publicIndexTypes = fs.readFileSync(join(piPackageRoot, "dist", "index.d.ts"), "utf8");
    const resourceLoaderTypes = fs.readFileSync(
      join(piPackageRoot, "dist", "core", "resource-loader.d.ts"),
      "utf8",
    );
    const piAiTypes = fs.readFileSync(
      join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "types.d.ts"),
      "utf8",
    );

    expect(agentSessionTypes).toContain('type: "summarization_retry_scheduled"');
    expect(agentSessionTypes).toContain('type: "bash_execution_update"');
    expect(agentSessionTypes).toContain("getAvailableThinkingLevels(): ThinkingLevel[]");
    expect(agentSessionTypes).toContain("id?: string");
    expect(extensionTypes).toContain("constrainedSampling?: false | ConstrainedSamplingConfig");
    expect(extensionTypes).toContain("outputPad: number");
    expect(extensionTypes).toContain("scopedModels: readonly ScopedModel[]");
    expect(extensionRunnerTypes).toContain("emitInput(text: string");
    expect(extensionRunnerTypes).toContain("Promise<InputEventResult>");
    expect(extensionRunnerTypes).toContain("emitUserBash(event: UserBashEvent)");
    expect(publicIndexTypes).toContain("resolveModelScopeWithDiagnostics");
    expect(resourceLoaderTypes).toContain("getSystemPromptSource()");
    expect(resourceLoaderTypes).toContain("getAppendSystemPromptSources()");
    expect(piAiTypes).toContain("fetch?: FetchFunction");
    expect(piAiTypes).toContain('StopReason = "pending" | "stop"');
    expect(piAiTypes).toContain("rawStopReason?: string");

    const pi = await import("@earendil-works/pi-coding-agent");
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
    expect(typeof pi.resolveModelScopeWithDiagnostics).toBe("function");
  });

  it("exports configured credentials through the pinned 0.83 CLI", () => {
    const agentDir = fs.mkdtempSync(join(os.tmpdir(), "pivis-pi-auth-export-"));
    const cli = join(piPackageRoot, "dist", "cli.js");
    const sentinel = "pivis-credential-export-test";
    try {
      const output = execFileSync(
        process.execPath,
        [cli, "auth", "print-api-key", "--provider", "openai", "--model", "gpt-5.4"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            OPENAI_API_KEY: sentinel,
          },
        },
      );
      expect(output).toBe(`${sentinel}\n`);

      const help = execFileSync(process.execPath, [cli, "auth"], {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      });
      expect(help).toContain("auth print-api-key");
      expect(help).toContain("auth print-bearer-token");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

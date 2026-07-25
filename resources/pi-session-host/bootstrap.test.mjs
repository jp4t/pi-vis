import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionRuntimeOverrideResolver,
  resolvePiDependency,
  resolveSessionRuntimeOverrides,
} from "./bootstrap.mjs";

/**
 * resolvePiDependency must find pi's deps in BOTH real-world layouts:
 *  - nested: pi-coding-agent/node_modules/<dep> (npm global/dev install,
 *    produced by pi's npm-shrinkwrap), and
 *  - hoisted: an ancestor node_modules/<dep> (electron-builder flattens the
 *    shrinkwrapped tree to the app's top-level node_modules at package time).
 * The nested-only version of this function broke every SDK-host start in the
 * packaged app (`npm run dist`) while `npm run dev` kept working.
 */
describe("resolvePiDependency", () => {
  let tmp;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makePiInstall({ nestedDeps, hoistedDeps }) {
    // realpath: resolvePiDependency canonicalizes via realpathSync(piPath),
    // and macOS tmpdirs live behind the /var → /private/var symlink.
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-bootstrap-")));
    const pkgDir = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
    const cli = path.join(pkgDir, "dist", "cli.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "// fake pi cli\n");
    for (const dep of nestedDeps) {
      const depFile = path.join(pkgDir, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    for (const dep of hoistedDeps) {
      const depFile = path.join(tmp, "node_modules", dep);
      mkdirSync(path.dirname(depFile), { recursive: true });
      writeFileSync(depFile, "// dep\n");
    }
    return { cli, pkgDir };
  }

  it("prefers the nested install (npm global/dev layout)", () => {
    const dep = path.join("@earendil-works", "pi-tui", "dist", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [dep], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });

  it("falls back to a hoisted ancestor node_modules (packaged-app layout)", () => {
    const dep = path.join("undici", "index.js");
    const { cli } = makePiInstall({ nestedDeps: [], hoistedDeps: [dep] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(tmp, "node_modules", dep));
  });

  it("returns the nested path when the dep exists nowhere, so errors name the miss", () => {
    const dep = path.join("undici", "index.js");
    const { cli, pkgDir } = makePiInstall({ nestedDeps: [], hoistedDeps: [] });
    expect(resolvePiDependency(cli, dep)).toBe(path.join(pkgDir, "node_modules", dep));
  });
});

describe("resolveSessionRuntimeOverrides", () => {
  it("reads model and thinking metadata from a real zero-message Pi session", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-session-model-")));
    try {
      const sessionDir = path.join(sessionRoot, "sessions");
      const sessionFile = path.join(sessionDir, "empty-session.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(sessionFile, "");
      const created = SessionManager.open(sessionFile, sessionDir, sessionRoot);
      created.appendModelChange("provider-a", "model-a");
      created.appendThinkingLevelChange("high");
      const sessionManager = SessionManager.open(sessionFile, sessionDir);
      expect(sessionManager.buildSessionContext().messages).toEqual([]);

      const storedModel = { provider: "provider-a", id: "model-a" };
      expect(
        resolveSessionRuntimeOverrides(sessionManager, {
          getModel: () => storedModel,
          hasConfiguredAuth: () => true,
        }),
      ).toEqual({ model: storedModel, thinkingLevel: "high" });
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("preserves explicit model and thinking metadata on an empty active branch", () => {
    const storedModel = { provider: "provider-a", id: "model-a" };
    const sessionManager = {
      buildSessionContext: () => ({
        messages: [],
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "high",
      }),
      getBranch: () => [
        { type: "model_change", provider: "provider-a", modelId: "model-a" },
        { type: "thinking_level_change", thinkingLevel: "high" },
      ],
    };
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? storedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "provider-b", modelId: "model-b" },
        thinkingLevel: "minimal",
      }),
    ).toEqual({
      model: storedModel,
      thinkingLevel: "high",
    });
  });

  it("uses the same-session authoritative selection when the branch has no metadata", () => {
    const resumedModel = { provider: "provider-a", id: "model-a" };
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? resumedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "provider-a", modelId: "model-a" },
        thinkingLevel: "xhigh",
      }),
    ).toEqual({
      model: resumedModel,
      thinkingLevel: "xhigh",
    });
  });

  it("never carries an initial resume checkpoint through the reusable runtime factory", () => {
    const resumedModel = { provider: "provider-a", id: "model-a" };
    const metadataFreeSession = () => ({
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    });
    const modelRuntime = {
      getModel: (provider, modelId) =>
        provider === "provider-a" && modelId === "model-a" ? resumedModel : undefined,
      hasConfiguredAuth: (provider) => provider === "provider-a",
    };
    const resolveOverrides = createSessionRuntimeOverrideResolver({
      model: { provider: "provider-a", modelId: "model-a" },
      thinkingLevel: "xhigh",
    });

    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({
      model: resumedModel,
      thinkingLevel: "xhigh",
    });
    // Pi reuses this same factory closure for both /new and /resume. Neither
    // successor may inherit the checkpoint that belonged to the initial A.
    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({});
    expect(resolveOverrides(metadataFreeSession(), modelRuntime)).toEqual({});
  });

  it("ignores malformed same-session fallback values", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("invalid fallback models must not be resolved");
      },
      hasConfiguredAuth: () => {
        throw new Error("invalid fallback models must not inspect auth");
      },
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: { provider: "", modelId: "model-a" },
        thinkingLevel: "extreme",
      }),
    ).toEqual({});
  });

  it("keeps a known no-model checkpoint distinct without resolving a model", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("a null model checkpoint must not resolve a model");
      },
      hasConfiguredAuth: () => {
        throw new Error("a null model checkpoint must not inspect auth");
      },
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, modelRuntime, {
        model: null,
        thinkingLevel: "low",
      }),
    ).toEqual({ thinkingLevel: "low" });
  });

  it("leaves brand-new sessions on Pi's settings defaults", () => {
    const sessionManager = {
      buildSessionContext: () => ({ messages: [], model: null, thinkingLevel: "off" }),
      getBranch: () => [],
    };
    const modelRuntime = {
      getModel: () => {
        throw new Error("new sessions must not resolve a stored model");
      },
      hasConfiguredAuth: () => {
        throw new Error("new sessions must not inspect stored-model auth");
      },
    };

    expect(resolveSessionRuntimeOverrides(sessionManager, modelRuntime)).toEqual({});
  });

  it("keeps Pi's model fallback when the stored model is unavailable or unauthenticated", () => {
    const sessionManager = {
      buildSessionContext: () => ({
        messages: [],
        model: { provider: "provider-a", modelId: "missing" },
        thinkingLevel: "low",
      }),
      getBranch: () => [{ type: "thinking_level_change", thinkingLevel: "low" }],
    };

    expect(
      resolveSessionRuntimeOverrides(sessionManager, {
        getModel: () => undefined,
        hasConfiguredAuth: () => true,
      }),
    ).toEqual({ thinkingLevel: "low" });

    expect(
      resolveSessionRuntimeOverrides(sessionManager, {
        getModel: () => ({ provider: "provider-a", id: "missing" }),
        hasConfiguredAuth: () => false,
      }),
    ).toEqual({ thinkingLevel: "low" });
  });
});

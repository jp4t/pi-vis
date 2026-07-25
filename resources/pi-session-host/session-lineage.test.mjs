import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeConfinedSessionLineage,
  canonicalizeConfinedSessionReference,
  canonicalizeConfinedSessionStartEvent,
} from "./session-lineage.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pivis-lineage-")));
  roots.push(root);
  const source = path.join(root, "source.jsonl");
  const runtimePin = path.join(root, ".pivis-runtime-pin");
  const timestamp = new Date().toISOString();
  const entries = [
    {
      type: "session",
      version: 3,
      id: "source-session",
      timestamp,
      cwd: root,
    },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "first", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "assistant-1",
      timestamp,
      message: { role: "user", content: "second", timestamp: Date.now() },
    },
  ];
  writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  linkSync(source, runtimePin);
  return {
    root,
    source,
    runtimePin,
    confinedSource: {
      runtimeSessionFile: runtimePin,
      canonicalSessionFile: source,
    },
  };
}

function makeSession(manager) {
  return {
    sessionManager: manager,
    get sessionFile() {
      return manager.getSessionFile();
    },
    extensionRunner: {
      hasHandlers: vi.fn(() => false),
      emit: vi.fn(),
    },
    dispose: vi.fn(),
    createReplacedSessionContext: vi.fn(() => ({})),
  };
}

function makeRuntime(fixture) {
  const manager = SessionManager.open(fixture.runtimePin, fixture.root);
  const session = makeSession(manager);
  const starts = [];
  const lineageReloads = [];
  const runtime = new AgentSessionRuntime(
    session,
    { cwd: fixture.root, agentDir: fixture.root },
    async ({ sessionManager, sessionStartEvent }) => {
      const headerBefore = sessionManager.getHeader();
      if (
        canonicalizeConfinedSessionLineage(
          sessionManager,
          sessionStartEvent,
          fixture.confinedSource,
        )
      ) {
        lineageReloads.push({
          before: headerBefore,
          after: sessionManager.getHeader(),
          sessionFile: sessionManager.getSessionFile(),
        });
      }
      starts.push(canonicalizeConfinedSessionStartEvent(sessionStartEvent, fixture.confinedSource));
      return {
        session: makeSession(sessionManager),
        services: { cwd: fixture.root, agentDir: fixture.root },
        diagnostics: [],
      };
    },
  );
  return { runtime, starts, lineageReloads };
}

function readHeader(file) {
  return readEntries(file)[0];
}

function readEntries(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("confined session lineage", () => {
  it("canonicalizes only the exact host-internal session reference", () => {
    const fixture = makeFixture();
    expect(canonicalizeConfinedSessionReference(fixture.runtimePin, fixture.confinedSource)).toBe(
      fixture.source,
    );
    expect(
      canonicalizeConfinedSessionReference("/sessions/successor.jsonl", fixture.confinedSource),
    ).toBe("/sessions/successor.jsonl");
  });

  it("never rewrites a crafted initial pinned source without an explicit fork event", () => {
    const fixture = makeFixture();
    const lines = readFileSync(fixture.source, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[0].parentSession = fixture.runtimePin;
    writeFileSync(fixture.source, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const manager = SessionManager.open(fixture.runtimePin, fixture.root);

    expect(canonicalizeConfinedSessionLineage(manager, undefined, fixture.confinedSource)).toBe(
      false,
    );
    expect(manager.getHeader()).toMatchObject({ parentSession: fixture.runtimePin });
    expect(readHeader(fixture.source)).toMatchObject({ parentSession: fixture.runtimePin });
  });

  it("never treats the pinned source itself as a successor, even with crafted fork metadata", () => {
    const fixture = makeFixture();
    const lines = readFileSync(fixture.source, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    lines[0].parentSession = fixture.runtimePin;
    writeFileSync(fixture.source, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const manager = SessionManager.open(fixture.runtimePin, fixture.root);

    expect(
      canonicalizeConfinedSessionLineage(manager, { reason: "fork" }, fixture.confinedSource),
    ).toBe(false);
    expect(manager.getSessionFile()).toBe(fixture.runtimePin);
    expect(manager.getHeader()).toMatchObject({ parentSession: fixture.runtimePin });
    expect(readHeader(fixture.source)).toMatchObject({ parentSession: fixture.runtimePin });
  });

  it("canonicalizes an actual pinned Pi fork whose branch is already materialized", async () => {
    const fixture = makeFixture();
    const { runtime, starts, lineageReloads } = makeRuntime(fixture);

    await expect(runtime.fork("user-2")).resolves.toMatchObject({
      cancelled: false,
      selectedText: "second",
    });

    const successor = runtime.session.sessionManager;
    const successorFile = successor.getSessionFile();
    expect(successorFile).not.toBe(fixture.runtimePin);
    expect(successor.getHeader()).toMatchObject({ parentSession: fixture.source });
    expect(readHeader(successorFile)).toMatchObject({ parentSession: fixture.source });
    expect(lineageReloads).toEqual([
      {
        before: expect.objectContaining({ parentSession: fixture.runtimePin }),
        after: expect.objectContaining({ parentSession: fixture.source }),
        sessionFile: successorFile,
      },
    ]);
    expect(lineageReloads[0].after).not.toBe(lineageReloads[0].before);
    expect(lineageReloads[0].before).toMatchObject({ parentSession: fixture.runtimePin });
    expect(starts).toEqual([
      expect.objectContaining({
        type: "session_start",
        reason: "fork",
        previousSessionFile: fixture.source,
      }),
    ]);
  });

  it("materializes and reloads canonical lineage for Pi's deferred fork", async () => {
    const fixture = makeFixture();
    const { runtime, starts, lineageReloads } = makeRuntime(fixture);

    await expect(runtime.fork("user-1", { position: "at" })).resolves.toMatchObject({
      cancelled: false,
    });

    const successor = runtime.session.sessionManager;
    const successorFile = successor.getSessionFile();
    expect(successor.getHeader()).toMatchObject({ parentSession: fixture.source });
    expect(readHeader(successorFile)).toMatchObject({ parentSession: fixture.source });
    expect(readEntries(successorFile)).toEqual([
      expect.objectContaining({
        type: "session",
        parentSession: fixture.source,
      }),
      expect.objectContaining({
        type: "message",
        id: "user-1",
      }),
    ]);
    expect(successor.getEntries()).toEqual([
      expect.objectContaining({
        type: "message",
        id: "user-1",
      }),
    ]);
    expect(lineageReloads).toEqual([
      {
        before: expect.objectContaining({ parentSession: fixture.runtimePin }),
        after: expect.objectContaining({ parentSession: fixture.source }),
        sessionFile: successorFile,
      },
    ]);
    expect(lineageReloads[0].after).not.toBe(lineageReloads[0].before);
    expect(lineageReloads[0].before).toMatchObject({ parentSession: fixture.runtimePin });

    successor.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "persist" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    expect(readHeader(successorFile)).toMatchObject({ parentSession: fixture.source });
    expect(readEntries(successorFile).filter((entry) => entry.type === "session")).toHaveLength(1);
    expect(readEntries(successorFile).at(-1)).toMatchObject({
      type: "message",
      message: { role: "assistant" },
    });
    expect(starts[0]).toMatchObject({
      reason: "fork",
      previousSessionFile: fixture.source,
    });
  });

  it("canonicalizes new-session lifecycle metadata without inventing lineage", async () => {
    const fixture = makeFixture();
    const { runtime, starts } = makeRuntime(fixture);

    await expect(runtime.newSession()).resolves.toEqual({ cancelled: false });

    expect(runtime.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
    expect(starts).toEqual([
      expect.objectContaining({
        type: "session_start",
        reason: "new",
        previousSessionFile: fixture.source,
      }),
    ]);
  });
});

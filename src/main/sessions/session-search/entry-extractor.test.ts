import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPinnedSessionHardLink,
  extractSearchSegments,
  openConfinedRegularFile,
  openConfinedRegularFileForHost,
  streamJsonlRows,
} from "./entry-extractor.js";

const tempDirectories: string[] = [];
function tempFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-"));
  tempDirectories.push(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, contents);
  return file;
}
afterEach(() => {
  for (const dir of tempDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const provenance = { fileOrdinal: 4, byteStart: 10, byteEnd: 90 };

describe("streamJsonlRows", () => {
  it("keeps neighboring valid rows and byte provenance around a malformed row", async () => {
    const first = '{"id":"one"}';
    const malformed = "{bad json}";
    const last = '{"id":"two"}';
    const file = tempFile(`${first}\n${malformed}\n${last}\n{"id":"partial"}`);
    const rows = [];
    for await (const row of streamJsonlRows(file)) rows.push(row);
    expect(rows.map((row) => row.value["id"])).toEqual(["one", "two"]);
    expect(rows[1]).toMatchObject({
      fileOrdinal: 3,
      byteStart: Buffer.byteLength(`${first}\n${malformed}\n`),
      byteEnd: Buffer.byteLength(`${first}\n${malformed}\n${last}`),
    });
    const diagnosticRows = [];
    for await (const row of streamJsonlRows(file, { includeSkipped: true })) {
      diagnosticRows.push(row);
    }
    expect(diagnosticRows[1]).toMatchObject({
      fileOrdinal: 2,
      skippedReason: "malformed",
    });
  });

  it("rejects an intermediate-directory symlink escape at the actual open", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-outside-"));
    tempDirectories.push(root, outside);
    fs.writeFileSync(path.join(outside, "escaped.jsonl"), '{"id":"escaped"}\n');
    fs.symlinkSync(outside, path.join(root, "swapped"), "dir");
    const escaped = path.join(root, "swapped", "escaped.jsonl");

    const read = async () => {
      for await (const _row of streamJsonlRows(escaped, { confinementRoot: root })) {
        // The descriptor-bound gate must reject before yielding any content.
      }
    };
    await expect(read()).rejects.toThrow(/escaped the sessions root/u);
  });

  it.skipIf(process.platform !== "linux")(
    "gives a Linux child a readable append-only file description",
    () => {
      const file = tempFile('{"id":"header"}\n');
      const descriptor = openConfinedRegularFileForHost(file, path.dirname(file));
      try {
        const child = spawnSync(
          process.execPath,
          [
            "-e",
            `const fs=require("node:fs"); const file="/proc/self/fd/4"; process.stdout.write(fs.readFileSync(file, "utf8")); fs.appendFileSync(file, '{"id":"appended"}\\n');`,
          ],
          { stdio: ["ignore", "pipe", "pipe", "ignore", descriptor] },
        );
        expect(child.status, child.stderr.toString()).toBe(0);
        expect(child.stdout.toString()).toBe('{"id":"header"}\n');
        expect(fs.readFileSync(file, "utf8")).toBe('{"id":"header"}\n{"id":"appended"}\n');
      } finally {
        fs.closeSync(descriptor);
      }
    },
  );

  it("creates an identity-verified runtime path to the pinned inode", () => {
    const file = tempFile('{"id":"pinned"}\n');
    const descriptor = openConfinedRegularFile(file, path.dirname(file));
    let alias: string | undefined;
    try {
      alias = createPinnedSessionHardLink(file, descriptor);
      expect(fs.statSync(alias).ino).toBe(fs.fstatSync(descriptor).ino);
      fs.unlinkSync(file);
      fs.writeFileSync(file, '{"id":"replacement"}\n');
      fs.appendFileSync(alias, '{"id":"continued"}\n');
      expect(fs.readFileSync(alias, "utf8")).toContain('"continued"');
      expect(fs.readFileSync(file, "utf8")).toBe('{"id":"replacement"}\n');
    } finally {
      fs.closeSync(descriptor);
      if (alias) fs.rmSync(alias, { force: true });
    }
  });

  it("survives Pi SessionManager.open's repeated reads and appends to the pinned inode", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-search-runtime-pin-"));
    tempDirectories.push(cwd);
    const file = path.join(cwd, "session.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pinned-session",
        timestamp: new Date().toISOString(),
        cwd,
      })}\n`,
    );
    const descriptor = openConfinedRegularFile(file, cwd);
    let alias: string | undefined;
    try {
      alias = createPinnedSessionHardLink(file, descriptor);
      const manager = SessionManager.open(alias);
      expect(manager.getSessionId()).toBe("pinned-session");

      manager.appendSessionInfo("resumed through runtime pin");

      expect(fs.readFileSync(file, "utf8")).toContain("resumed through runtime pin");
      expect(fs.statSync(alias).ino).toBe(fs.statSync(file).ino);
    } finally {
      fs.closeSync(descriptor);
      if (alias) fs.rmSync(alias, { force: true });
    }
  });

  it("never closes a borrowed descriptor when a consumer returns early", async () => {
    const file = tempFile('{"id":"one"}\n{"id":"two"}\n');
    const descriptor = openConfinedRegularFile(file, path.dirname(file));
    try {
      for await (const row of streamJsonlRows(file, { descriptor })) {
        expect(row.value["id"]).toBe("one");
        break;
      }
      expect(fs.fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it("can inspect a final row only outside indexing mode", async () => {
    const file = tempFile('{"id":"complete"}\n{"id":"tail"}');
    const indexed = [];
    for await (const row of streamJsonlRows(file)) indexed.push(row);
    const inspection = [];
    for await (const row of streamJsonlRows(file, { indexingMode: false })) inspection.push(row);
    expect(indexed.map((row) => row.value["id"])).toEqual(["complete"]);
    expect(inspection.map((row) => row.value["id"])).toEqual(["complete", "tail"]);
  });
});

describe("extractSearchSegments", () => {
  it("extracts only visible persisted text with full segment provenance", () => {
    const assistant = extractSearchSegments(
      {
        id: "a",
        parentId: "u",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Provider failed",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Visible prose" },
            { type: "toolCall", id: "call", name: "read", arguments: { secret: "hidden" } },
            { type: "text", text: "More prose" },
          ],
        },
      },
      provenance,
    );
    expect(assistant.map((segment) => [segment.role, segment.originalText])).toEqual([
      ["assistant", "Visible prose"],
      ["assistant", "More prose"],
      ["error", "Provider failed"],
    ]);
    expect(assistant[0]).toMatchObject({
      entryId: "a",
      parentId: "u",
      fileOrdinal: 4,
      byteStart: 10,
      byteEnd: 90,
      contentPartKey: "content.1",
      occurrence: 0,
      transcriptAnchor: { entryId: "a", contentPartKey: "content.1" },
    });
    expect(assistant[0]?.normalizedText).toBe("visible prose");
    expect(assistant[0]?.digest).toHaveLength(64);
  });

  it("covers visible custom messages and saved summaries but excludes opaque data", () => {
    const entries = [
      {
        id: "u",
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "user text" },
            { type: "image", data: "base64" },
          ],
        },
      },
      { id: "c", type: "custom_message", display: "yes", content: "shown" },
      { id: "hidden", type: "custom_message", display: false, content: "not shown" },
      { id: "comp", type: "compaction", summary: "old history" },
      { id: "branch", type: "branch_summary", summary: "fork recap" },
      { id: "opaque", type: "custom", customType: "whatever", data: { text: "never search" } },
      { id: "tool", type: "message", message: { role: "toolResult", content: "tool output" } },
      { id: "name", type: "session_info", name: "A useful session" },
    ];
    const segments = entries.flatMap((entry, fileOrdinal) =>
      extractSearchSegments(entry, { ...provenance, fileOrdinal }),
    );
    expect(segments.map((segment) => segment.role)).toEqual([
      "user",
      "custom-message",
      "compaction-summary",
      "branch-summary",
      "session-name",
    ]);
    expect(segments.map((segment) => segment.originalText)).not.toContain("base64");
    expect(segments.map((segment) => segment.originalText)).not.toContain("never search");
  });
});

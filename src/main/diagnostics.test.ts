import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticLog, formatDiagnosticArguments } from "./diagnostics.js";

const tempDirs: string[] = [];

function tempLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-diagnostics-"));
  tempDirs.push(dir);
  return path.join(dir, "diagnostics.log");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DiagnosticLog", () => {
  it("persists exception stacks and context", () => {
    const file = tempLogPath();
    const log = new DiagnosticLog(file);
    const error = new Error("host exploded");

    log.write("session-host", "exit", error, { pid: 123, exitCode: 1 });

    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("[session-host] exit");
    expect(content).toContain('"pid":123');
    expect(content).toContain("Error: host exploded");
    expect(content).toContain("diagnostics.test.ts");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates an existing oversized log", () => {
    const file = tempLogPath();
    fs.writeFileSync(file, "old diagnostic payload");

    const log = new DiagnosticLog(file, 8);
    log.write("main", "process-start");

    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("old diagnostic payload");
    expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain("process-start");
  });

  it("formats Error arguments with their stacks", () => {
    const formatted = formatDiagnosticArguments(["failure:", new Error("broken")]);
    expect(formatted).toContain("failure:");
    expect(formatted).toContain("Error: broken");
    expect(formatted).toContain("diagnostics.test.ts");
  });
});

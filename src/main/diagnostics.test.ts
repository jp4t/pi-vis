import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiagnosticLog,
  createDiagnosticConsoleError,
  formatDiagnosticArguments,
} from "./diagnostics.js";

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

  it("does not execute custom inspectors while persisting console arguments", () => {
    const file = tempLogPath();
    const log = new DiagnosticLog(file);
    let customInspectCalls = 0;
    const customInspect = () => {
      customInspectCalls++;
      throw new Error("custom inspector must not run");
    };
    const detail = {
      label: "provider failure",
      [inspect.custom]: customInspect,
    };
    const original = vi.fn();
    const wrapped = createDiagnosticConsoleError(original, (args) => {
      log.write("main", "console.error", formatDiagnosticArguments(args));
    });

    expect(() => wrapped("failure:", detail)).not.toThrow();

    expect(customInspectCalls).toBe(0);
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]?.[0]).toBe("failure:");
    expect(original.mock.calls[0]?.[1]).toBe(detail);
    expect(fs.readFileSync(file, "utf8")).toContain("provider failure");
  });

  it("falls back safely when an Error stack getter throws", () => {
    const error = new Error("stack unavailable");
    Object.defineProperty(error, "stack", {
      configurable: true,
      get: () => {
        throw new Error("stack getter exploded");
      },
    });

    expect(formatDiagnosticArguments([error])).toBe("Error: stack unavailable");
  });

  it("always calls the original console error when diagnostic persistence throws", () => {
    const original = vi.fn();
    const persist = vi.fn(() => {
      throw new Error("diagnostics unavailable");
    });
    const wrapped = createDiagnosticConsoleError(original, persist);
    const detail = { message: "still report this" };

    expect(() => wrapped("failure:", detail)).not.toThrow();

    expect(persist).toHaveBeenCalledWith(["failure:", detail]);
    expect(original).toHaveBeenCalledWith("failure:", detail);
  });
});

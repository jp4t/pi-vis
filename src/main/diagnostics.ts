import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;

export interface DiagnosticContext {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Small synchronous diagnostic sink for failures that may terminate a process.
 * Synchronous appends are intentional: an async write can be lost with the
 * crashing main process or SDK host. The log is best effort and never throws.
 */
export class DiagnosticLog {
  private currentBytes = 0;

  constructor(
    readonly filePath: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o600);
        this.currentBytes = fs.statSync(filePath).size;
        if (this.currentBytes >= this.maxBytes) this.rotate();
      }
    } catch {
      this.currentBytes = 0;
    }
  }

  write(scope: string, event: string, detail?: unknown, context: DiagnosticContext = {}): void {
    try {
      const populatedContext = Object.fromEntries(
        Object.entries(context).filter(
          (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
        ),
      );
      const contextText =
        Object.keys(populatedContext).length > 0 ? ` ${JSON.stringify(populatedContext)}` : "";
      const detailText = detail === undefined ? "" : `\n${formatDiagnosticValue(detail)}`;
      let record = `[${new Date().toISOString()}] [${scope}] ${event}${contextText}${detailText}\n`;
      const recordBytes = Buffer.byteLength(record);
      if (recordBytes > MAX_RECORD_BYTES) {
        const suffix = "\n[diagnostic record truncated]\n";
        record = `${Buffer.from(record)
          .subarray(0, MAX_RECORD_BYTES - Buffer.byteLength(suffix))
          .toString("utf8")}${suffix}`;
      }
      const bytes = Buffer.byteLength(record);
      if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.filePath, record, { encoding: "utf8", mode: 0o600 });
      this.currentBytes += bytes;
    } catch {
      // Diagnostics must never become a second application failure.
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.filePath}.1`, { force: true });
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // If rotation fails, still attempt to append to the current file.
    }
    this.currentBytes = 0;
  }
}

export function formatDiagnosticValue(value: unknown): string {
  try {
    if (value instanceof Error) {
      try {
        const stack = value.stack;
        if (typeof stack === "string") return stack;
      } catch {
        // A hostile Error subclass may expose a throwing stack getter.
      }

      let name = "Error";
      let message = "";
      try {
        const candidateName = value.name;
        if (typeof candidateName === "string" && candidateName.length > 0) name = candidateName;
      } catch {
        // Preserve the safe default.
      }
      try {
        const candidateMessage = value.message;
        if (typeof candidateMessage === "string") message = candidateMessage;
      } catch {
        // Preserve the safe default.
      }
      return message ? `${name}: ${message}` : name;
    }
    if (typeof value === "string") return value;
    return inspect(value, {
      depth: 8,
      breakLength: 120,
      maxArrayLength: 100,
      customInspect: false,
      getters: false,
    });
  } catch {
    return "[unformattable diagnostic value]";
  }
}

export function formatDiagnosticArguments(args: unknown[]): string {
  try {
    return args.map(formatDiagnosticValue).join(" ");
  } catch {
    return "[unformattable diagnostic arguments]";
  }
}

export function createDiagnosticConsoleError(
  original: typeof console.error,
  persist: (args: unknown[]) => void,
): typeof console.error {
  return (...args: unknown[]): void => {
    try {
      persist(args);
    } catch {
      // Diagnostic formatting/persistence must not suppress the real console.
    }
    Reflect.apply(original, console, args);
  };
}

let activeLog: DiagnosticLog | null = null;
let mainHandlersInstalled = false;

export function configureDiagnosticLogging(filePath: string): DiagnosticLog {
  activeLog = new DiagnosticLog(filePath);
  return activeLog;
}

export function appendDiagnostic(
  scope: string,
  event: string,
  detail?: unknown,
  context?: DiagnosticContext,
): void {
  activeLog?.write(scope, event, detail, context);
}

/**
 * Persist main-process console errors and fatal exceptions without changing
 * Node's fatal-exception behavior. uncaughtExceptionMonitor observes crashes
 * but, unlike uncaughtException/unhandledRejection handlers, does not suppress
 * the default stack print or process exit.
 */
export function installMainProcessDiagnosticHandlers(): void {
  if (mainHandlersInstalled) return;
  mainHandlersInstalled = true;

  const originalConsoleError = console.error;
  console.error = createDiagnosticConsoleError(originalConsoleError, (args) => {
    appendDiagnostic("main", "console.error", formatDiagnosticArguments(args));
  });

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    appendDiagnostic("main", "uncaught-exception", error, { origin });
  });
}

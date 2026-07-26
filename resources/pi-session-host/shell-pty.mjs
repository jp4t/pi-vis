import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 8;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 200;
const DEFAULT_SCROLLBACK = 10_000;
const DEFAULT_REPLAY_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PARSER_BACKPRESSURE_HIGH_BYTES = 256 * 1024;
const PARSER_BACKPRESSURE_LOW_BYTES = 64 * 1024;
const ALT_SCREEN_MARKER = "[alternate screen final frame";
const ALT_SCREEN_OMISSION_MARKER = "[earlier alternate screen final frames omitted";

let defaultPtySpawn;
let DefaultTerminal;
let DefaultSerializeAddon;

function loadPtySpawn() {
  if (defaultPtySpawn) return defaultPtySpawn;

  for (const packageName of ["node-pty", "@homebridge/node-pty-prebuilt-multiarch"]) {
    try {
      const pty = require(packageName);
      if (typeof pty?.spawn === "function") {
        defaultPtySpawn = pty.spawn.bind(pty);
        return defaultPtySpawn;
      }
    } catch {
      // Try the next supported node-pty package.
    }
  }

  throw new Error(
    "PTY support is unavailable: install node-pty or @homebridge/node-pty-prebuilt-multiarch",
  );
}

function loadTerminal() {
  if (!DefaultTerminal) {
    const xterm = require("@xterm/xterm");
    if (typeof xterm?.Terminal !== "function") {
      throw new Error("Headless xterm support is unavailable");
    }
    DefaultTerminal = xterm.Terminal;
  }
  return DefaultTerminal;
}

function loadSerializeAddon() {
  if (!DefaultSerializeAddon) {
    const addon = require("@xterm/addon-serialize");
    if (typeof addon?.SerializeAddon !== "function") {
      throw new Error("Headless xterm serialization support is unavailable");
    }
    DefaultSerializeAddon = addon.SerializeAddon;
  }
  return DefaultSerializeAddon;
}

function defaultKillPtyProcess(ptyProcess) {
  if (process.platform === "win32") {
    // ConPTY/winpty do not accept POSIX signal names; node-pty owns their
    // platform-specific process-tree teardown.
    ptyProcess.kill();
    return;
  }

  if (Number.isSafeInteger(ptyProcess?.pid) && ptyProcess.pid > 0) {
    try {
      // forkpty makes the child a process-group leader. Kill the group so a
      // descendant retaining the slave PTY cannot outlive its Shell Turn.
      process.kill(-ptyProcess.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to node-pty's platform-specific termination below.
    }
  }

  try {
    ptyProcess.kill("SIGKILL");
  } catch {
    ptyProcess.kill();
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function normalizeTerminalSize(cols, rows) {
  assertPositiveInteger(cols, "cols");
  assertPositiveInteger(rows, "rows");
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, cols)),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows)),
  };
}

function resolveTimeoutMs(timeout) {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }

  const timeoutMs = timeout * 1_000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1_000} seconds`);
  }
  return timeoutMs;
}

function quoteBashData(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createStdinBootstrap(command) {
  const nonce = randomBytes(16).toString("hex");
  const marker = `\u001b]777;PIVIS-SHELL-READY;${nonce}\u0007`;
  const markerEscape = `\\033]777;PIVIS-SHELL-READY;${nonce}\\007`;
  const commandVariable = `__pivis_command_${nonce}`;
  const statusVariable = `__pivis_status_${nonce}`;
  return {
    marker,
    script: [
      "{",
      `${commandVariable}=${quoteBashData(command)}`,
      `builtin printf '%b' '${markerEscape}'`,
      `builtin eval "$${commandVariable}"`,
      `${statusVariable}=$?`,
      `builtin unset ${commandVariable}`,
      `builtin exit "$${statusVariable}"`,
      "}",
      "",
    ].join("\n"),
  };
}

function lineText(buffer, index) {
  return buffer.getLine(index)?.translateToString(true) ?? "";
}

/**
 * Convert an xterm buffer into logical text. Physical rows created by wrapping
 * are joined, while terminal-created trailing blank rows are omitted.
 */
export function terminalBufferToText(buffer) {
  const logicalLines = [];

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const text = lineText(buffer, index);
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }
  }

  while (logicalLines.at(-1) === "") {
    logicalLines.pop();
  }
  return logicalLines.join("\n");
}

function alternateFrameText(frame) {
  return `${ALT_SCREEN_MARKER} ${frame.cols}x${frame.rows}]\n${frame.text || "[empty]"}`;
}

function alternateFrameBytes(frame) {
  return Buffer.byteLength(alternateFrameText(frame));
}

function normalizeTerminalText(normalText, frames, omittedFrames = 0) {
  if (frames.length === 0 && omittedFrames === 0) return normalText;

  let result = omittedFrames > 0 ? `${ALT_SCREEN_OMISSION_MARKER}: ${omittedFrames}]\n` : "";
  let normalOffset = 0;
  for (const frame of frames) {
    const insertionOffset = Math.min(
      normalText.length,
      Math.max(normalOffset, frame.normalOffsetAtBoundary),
    );
    result += normalText.slice(normalOffset, insertionOffset);
    if (result && !result.endsWith("\n")) result += "\n";
    result += alternateFrameText(frame);
    if (insertionOffset < normalText.length && normalText[insertionOffset] !== "\n") {
      result += "\n";
    }
    normalOffset = insertionOffset;
  }
  result += normalText.slice(normalOffset);
  return result;
}

function cloneReplayChunk(chunk) {
  return {
    sequence: chunk.sequence,
    data: chunk.data,
  };
}

/**
 * Create the host-local PTY controller used as Pi's public BashOperations
 * implementation. Raw terminal bytes stay on the presentation/replay plane;
 * only a normalized terminal snapshot is passed to Pi's `onData` callback.
 *
 * `shellConfig` must come from Pi's public `getShellConfig()` helper so shell
 * selection remains owned by the pinned SDK.
 */
export function createShellPtyController({
  executionId,
  shellConfig,
  initialSize = {},
  baseEnv,
  scrollback = DEFAULT_SCROLLBACK,
  maxReplayBytes = DEFAULT_REPLAY_BYTES,
  spawnPty = loadPtySpawn(),
  killPtyProcess = defaultKillPtyProcess,
  createTerminal,
  createSerializer,
  onRawData = () => {},
  onStateChange = () => {},
  onCallbackError = () => {},
} = {}) {
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new TypeError("executionId must be a non-empty string");
  }
  if (
    !shellConfig ||
    typeof shellConfig.shell !== "string" ||
    shellConfig.shell.length === 0 ||
    !Array.isArray(shellConfig.args) ||
    !shellConfig.args.every((arg) => typeof arg === "string") ||
    ![undefined, "argv", "stdin"].includes(shellConfig.commandTransport)
  ) {
    throw new TypeError("shellConfig must be a valid Pi ShellConfig");
  }
  if (typeof spawnPty !== "function") {
    throw new TypeError("spawnPty must be a function");
  }
  if (typeof killPtyProcess !== "function") {
    throw new TypeError("killPtyProcess must be a function");
  }
  if (!Number.isSafeInteger(scrollback) || scrollback < 0) {
    throw new TypeError("scrollback must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes < 0) {
    throw new TypeError("maxReplayBytes must be a non-negative safe integer");
  }

  let { cols, rows } = normalizeTerminalSize(
    initialSize.cols ?? DEFAULT_COLS,
    initialSize.rows ?? DEFAULT_ROWS,
  );

  const terminal =
    createTerminal?.({ cols, rows, scrollback }) ??
    new (loadTerminal())({
      cols,
      rows,
      scrollback,
      allowProposedApi: false,
    });

  if (
    typeof terminal?.write !== "function" ||
    typeof terminal?.resize !== "function" ||
    !terminal?.buffer?.normal ||
    !terminal?.buffer?.alternate
  ) {
    terminal?.dispose?.();
    throw new TypeError("createTerminal must return an xterm-compatible terminal");
  }

  let serializer;
  if (typeof createSerializer === "function") {
    serializer = createSerializer(terminal);
  } else if (typeof terminal.loadAddon === "function") {
    serializer = new (loadSerializeAddon())();
    terminal.loadAddon(serializer);
  }
  if (serializer !== undefined && typeof serializer?.serialize !== "function") {
    terminal.dispose?.();
    throw new TypeError("createSerializer must return an xterm-compatible serializer");
  }

  let state = "idle";
  let ptyProcess;
  let ptyExited = false;
  let resolveExecution;
  let rejectExecution;
  let signal;
  let signalListener;
  let timeoutHandle;
  let timedOut = false;
  let interruptRequested = false;
  let forceKillRequested = false;
  let exitCode;
  let exitSignal;
  let inputAcknowledgedThrough = 0;
  let resizeRevision = 0;
  let outputSequence = 0;
  let replayBytes = 0;
  let replayTruncated = false;
  const replayChunks = [];
  let alternateScreenSeen = false;
  let alternateIntervalOpen = false;
  const alternateFrames = [];
  let alternateFrameBytesRetained = 0;
  let alternateFramesOmitted = 0;
  let currentAlternateText = "";
  let lastNormalText = "";
  let normalizedText = "";
  let normalScrollbackOverflow = false;
  let terminalThroughSequence = 0;
  let parsingSequence = 0;
  let inputReady = false;
  let terminalError;
  let terminalDisposed = false;
  let executionSettled = false;
  let terminalWrites = Promise.resolve();
  let queuedTerminalBytes = 0;
  let parserBackpressured = false;
  let transportBackpressured = false;
  let ptyPaused = false;
  let bootstrapMarker;
  let bootstrapTail = "";
  let lastNotifiedActiveBuffer = terminal.buffer.active.type;
  const disposables = [];

  const reportCallbackError = (error) => {
    try {
      onCallbackError(error);
    } catch {
      // Observer failures must never take down the SDK host.
    }
  };

  const notifyState = () => {
    try {
      onStateChange(snapshot());
    } catch (error) {
      reportCallbackError(error);
    }
  };

  const captureTerminal = () => {
    if (terminalDisposed) return;
    try {
      lastNormalText = terminalBufferToText(terminal.buffer.normal);
      if (terminal.buffer.active.type === "alternate") {
        alternateScreenSeen = true;
        if (!executionSettled) alternateIntervalOpen = true;
        currentAlternateText = terminalBufferToText(terminal.buffer.alternate);
      } else {
        currentAlternateText = "";
      }
    } catch (error) {
      terminalError ??= error;
      reportCallbackError(error);
    }
  };

  const captureAlternateFrame = (throughSequence) => {
    if (terminalDisposed || terminal.buffer.active.type !== "alternate") return;
    try {
      alternateScreenSeen = true;
      const text = terminalBufferToText(terminal.buffer.alternate);
      const frame = {
        index: alternateFrames.length + 1,
        cols: terminal.cols,
        rows: terminal.rows,
        text,
        normalOffsetAtBoundary: terminalBufferToText(terminal.buffer.normal).length,
        throughSequence,
      };
      const bytes = alternateFrameBytes(frame);
      if (bytes <= maxReplayBytes) {
        alternateFrames.push({ ...frame, bytes });
        alternateFrameBytesRetained += bytes;
      } else {
        alternateFramesOmitted += 1;
      }
      while (alternateFrameBytesRetained > maxReplayBytes && alternateFrames.length > 0) {
        const removed = alternateFrames.shift();
        alternateFrameBytesRetained -= removed.bytes;
        alternateFramesOmitted += 1;
      }
      for (let index = 0; index < alternateFrames.length; index += 1) {
        alternateFrames[index].index = alternateFramesOmitted + index + 1;
      }
    } catch (error) {
      terminalError ??= error;
      reportCallbackError(error);
      if (!ptyExited) forceKill();
    }
    currentAlternateText = "";
    alternateIntervalOpen = false;
  };

  const refreshNormalizedText = () => {
    captureTerminal();
    let previewFrames = alternateFrames;
    let previewOmitted = alternateFramesOmitted;
    if (alternateIntervalOpen && terminal.buffer.active.type === "alternate") {
      const frame = {
        index: alternateFramesOmitted + alternateFrames.length + 1,
        cols: terminal.cols,
        rows: terminal.rows,
        text: currentAlternateText,
        normalOffsetAtBoundary: lastNormalText.length,
        throughSequence: terminalThroughSequence,
      };
      const bytes = alternateFrameBytes(frame);
      if (bytes <= maxReplayBytes) {
        previewFrames = [...alternateFrames, { ...frame, bytes }];
        let retainedBytes = alternateFrameBytesRetained + bytes;
        while (retainedBytes > maxReplayBytes && previewFrames.length > 0) {
          const removed = previewFrames.shift();
          retainedBytes -= removed.bytes;
          previewOmitted += 1;
        }
      } else {
        previewOmitted += 1;
      }
    }
    normalizedText = normalizeTerminalText(lastNormalText, previewFrames, previewOmitted);
  };

  const usesAlternateScreen = (params) =>
    params.some((value) => !Array.isArray(value) && [47, 1_047, 1_049].includes(value));

  if (typeof terminal.registerMarker === "function") {
    const marker = terminal.registerMarker(0);
    if (marker && typeof marker.onDispose === "function") {
      const markerListener = marker.onDispose(() => {
        if (!terminalDisposed) normalScrollbackOverflow = true;
      });
      disposables.push(markerListener, marker);
    }
  }

  if (typeof terminal.parser?.registerCsiHandler === "function") {
    disposables.push(
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (usesAlternateScreen(params)) {
          alternateScreenSeen = true;
          alternateIntervalOpen = true;
        }
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (
          usesAlternateScreen(params) &&
          alternateIntervalOpen &&
          terminal.buffer.active.type === "alternate"
        ) {
          captureAlternateFrame(parsingSequence || outputSequence);
        }
        return false;
      }),
    );
  }

  const disposeTerminal = () => {
    if (terminalDisposed) return;
    terminalDisposed = true;
    for (const disposable of disposables.splice(0)) {
      try {
        disposable?.dispose?.();
      } catch {
        // Best effort; terminal teardown must not mask the process result.
      }
    }
    try {
      terminal.dispose?.();
    } catch {
      // Best effort; terminal teardown must not mask the process result.
    }
  };

  const retainRawOutput = (sequence, data) => {
    const bytes = Buffer.byteLength(data);
    replayChunks.push({ sequence, data, bytes });
    replayBytes += bytes;

    while (replayBytes > maxReplayBytes && replayChunks.length > 0) {
      const removed = replayChunks.shift();
      replayBytes -= removed.bytes;
      replayTruncated = true;
    }
  };

  const failFlowControl = (error) => {
    terminalError ??= error;
    reportCallbackError(error);
    forceKill();
  };

  const reconcilePtyFlowControl = () => {
    if (!ptyProcess || state !== "running" || ptyExited) return;
    const shouldPause = parserBackpressured || transportBackpressured;
    if (shouldPause === ptyPaused) return;
    try {
      if (shouldPause) ptyProcess.pause();
      else ptyProcess.resume();
      ptyPaused = shouldPause;
    } catch (error) {
      failFlowControl(error);
    }
  };

  const queueTerminalWrite = (data, sequence) => {
    const bytes = Buffer.byteLength(data);
    queuedTerminalBytes += bytes;
    if (queuedTerminalBytes >= PARSER_BACKPRESSURE_HIGH_BYTES) {
      parserBackpressured = true;
      reconcilePtyFlowControl();
    }
    terminalWrites = terminalWrites
      .then(
        () =>
          new Promise((resolve, reject) => {
            try {
              parsingSequence = sequence;
              terminal.write(data, () => {
                parsingSequence = 0;
                resolve();
              });
            } catch (error) {
              parsingSequence = 0;
              reject(error);
            }
          }),
      )
      .then(() => {
        terminalThroughSequence = sequence;
        const activeBuffer = terminal.buffer.active.type;
        if (activeBuffer !== lastNotifiedActiveBuffer) {
          lastNotifiedActiveBuffer = activeBuffer;
          notifyState();
        }
      })
      .catch((error) => {
        terminalError ??= error;
        reportCallbackError(error);
      })
      .finally(() => {
        queuedTerminalBytes = Math.max(0, queuedTerminalBytes - bytes);
        if (parserBackpressured && queuedTerminalBytes <= PARSER_BACKPRESSURE_LOW_BYTES) {
          parserBackpressured = false;
          reconcilePtyFlowControl();
        }
      });
  };

  const replay = (afterSequence = 0) => {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer");
    }

    const firstRetainedSequence = replayChunks[0]?.sequence ?? outputSequence + 1;
    return {
      afterSequence,
      fromSequence:
        replayChunks.find((chunk) => chunk.sequence > afterSequence)?.sequence ??
        outputSequence + 1,
      throughSequence: outputSequence,
      gap: afterSequence < firstRetainedSequence - 1,
      truncated: replayTruncated,
      chunks: replayChunks.filter((chunk) => chunk.sequence > afterSequence).map(cloneReplayChunk),
    };
  };

  function snapshot(afterSequence = 0) {
    refreshNormalizedText();
    return {
      executionId,
      state,
      cols,
      rows,
      inputAcknowledgedThrough,
      inputReady,
      resizeRevision,
      outputSequence,
      interruptRequested,
      forceKillRequested,
      timedOut,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitSignal !== undefined ? { exitSignal } : {}),
      ...(terminalError ? { terminalError: String(terminalError) } : {}),
      replay: replay(afterSequence),
      terminal: {
        activeBuffer: terminalDisposed ? "normal" : terminal.buffer.active.type,
        alternateScreenSeen,
        throughSequence: terminalThroughSequence,
        normalText: lastNormalText,
        currentAlternateText,
        alternateFrames: alternateFrames.map(
          ({ index, cols: frameCols, rows: frameRows, text, throughSequence }) => ({
            index,
            cols: frameCols,
            rows: frameRows,
            text,
            throughSequence,
          }),
        ),
        alternateFramesOmitted,
        normalScrollbackOverflow,
        normalizedText,
      },
    };
  }

  /**
   * Serialize the parsed emulator, including terminal modes, cursor position,
   * active alternate buffer, viewport, and as much normal-buffer scrollback as
   * fits in the same bound used for raw replay. This is a presentation-only
   * keyframe: terminal input is never part of xterm's buffer serialization.
   */
  const serializeKeyframe = () => {
    if (!serializer || terminalDisposed) return undefined;
    try {
      const availableScrollback = Math.max(0, terminal.buffer.normal.length - terminal.rows);
      let retainedScrollback = 0;
      let ansi = serializer.serialize({ scrollback: 0 });
      if (Buffer.byteLength(ansi) > maxReplayBytes) return undefined;

      let low = 1;
      let high = availableScrollback;
      while (low <= high) {
        const candidate = Math.floor((low + high) / 2);
        const serialized = serializer.serialize({ scrollback: candidate });
        if (Buffer.byteLength(serialized) <= maxReplayBytes) {
          retainedScrollback = candidate;
          ansi = serialized;
          low = candidate + 1;
        } else {
          high = candidate - 1;
        }
      }

      return {
        ansi,
        throughSequence: terminalThroughSequence,
        retainedScrollback,
        availableScrollback,
        truncated: retainedScrollback < availableScrollback || normalScrollbackOverflow,
      };
    } catch (error) {
      reportCallbackError(error);
      return undefined;
    }
  };

  const clearExecutionResources = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (signal && signalListener) {
      signal.removeEventListener("abort", signalListener);
    }
    signal = undefined;
    signalListener = undefined;
  };

  const settleExecution = async (result) => {
    if (executionSettled) return;
    executionSettled = true;
    clearExecutionResources();
    await terminalWrites;
    if (bootstrapMarker) {
      terminalError ??= new Error("Shell PTY bootstrap exited before becoming ready");
      bootstrapMarker = undefined;
      bootstrapTail = "";
    }
    if (alternateIntervalOpen && terminal.buffer.active.type === "alternate") {
      captureAlternateFrame(terminalThroughSequence);
    }
    refreshNormalizedText();

    if (!terminalError && normalizedText) {
      try {
        result.onData(Buffer.from(normalizedText, "utf8"));
      } catch (error) {
        terminalError = error;
      }
    }

    state = terminalError ? "failed" : "exited";
    inputReady = false;
    notifyState();
    disposeTerminal();

    if (terminalError) {
      rejectExecution(terminalError);
    } else if (timedOut) {
      rejectExecution(new Error(`timeout:${result.timeout}`));
    } else {
      resolveExecution({ exitCode: exitCode ?? null });
    }
  };

  const publishRawData = (data) => {
    if (!data) return;
    outputSequence += 1;
    retainRawOutput(outputSequence, data);
    queueTerminalWrite(data, outputSequence);
    try {
      onRawData({ executionId, sequence: outputSequence, data });
    } catch (error) {
      reportCallbackError(error);
    }
  };

  const handleRawData = (value) => {
    if (state !== "running") return;
    let data = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    if (bootstrapMarker) {
      const candidate = bootstrapTail + data;
      const markerOffset = candidate.indexOf(bootstrapMarker);
      if (markerOffset < 0) {
        bootstrapTail = candidate.slice(Math.max(0, candidate.length - bootstrapMarker.length + 1));
        return;
      }
      data = candidate.slice(markerOffset + bootstrapMarker.length);
      bootstrapMarker = undefined;
      bootstrapTail = "";
      inputReady = true;
      notifyState();
    }
    publishRawData(data);
  };

  function forceKill() {
    if (state !== "running" || !ptyProcess) {
      return { requested: false, state };
    }
    if (forceKillRequested) {
      return { requested: false, alreadyRequested: true, state };
    }

    forceKillRequested = true;
    try {
      killPtyProcess(ptyProcess);
    } catch (error) {
      forceKillRequested = false;
      reportCallbackError(error);
      return { requested: false, state };
    }
    notifyState();
    return { requested: true, state };
  }

  const operations = {
    exec(command, cwd, options = {}) {
      if (state !== "idle") {
        return Promise.reject(new Error("shell PTY operations are single-use"));
      }
      state = "starting";

      if (typeof command !== "string") {
        state = "failed";
        disposeTerminal();
        return Promise.reject(new TypeError("command must be a string"));
      }
      if (typeof cwd !== "string" || cwd.length === 0) {
        state = "failed";
        disposeTerminal();
        return Promise.reject(new TypeError("cwd must be a non-empty string"));
      }
      if (typeof options.onData !== "function") {
        state = "failed";
        disposeTerminal();
        return Promise.reject(new TypeError("options.onData must be a function"));
      }
      if (options.signal?.aborted) {
        state = "failed";
        disposeTerminal();
        return Promise.reject(new Error("aborted"));
      }

      let timeoutMs;
      try {
        timeoutMs = resolveTimeoutMs(options.timeout);
      } catch (error) {
        state = "failed";
        disposeTerminal();
        return Promise.reject(error);
      }

      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const args = commandFromStdin ? [...shellConfig.args] : [...shellConfig.args, command];
      const stdinBootstrap = commandFromStdin ? createStdinBootstrap(command) : undefined;
      bootstrapMarker = stdinBootstrap?.marker;
      bootstrapTail = "";
      const env = {
        ...(options.env ?? baseEnv ?? process.env),
      };
      env.TERM = "xterm-256color";
      env.COLORTERM = "truecolor";

      let executionPromise;
      try {
        ptyProcess = spawnPty(shellConfig.shell, args, {
          name: env.TERM,
          cwd,
          env,
          cols,
          rows,
        });
        if (
          !ptyProcess ||
          typeof ptyProcess.onData !== "function" ||
          typeof ptyProcess.onExit !== "function" ||
          typeof ptyProcess.write !== "function" ||
          typeof ptyProcess.resize !== "function" ||
          typeof ptyProcess.pause !== "function" ||
          typeof ptyProcess.resume !== "function" ||
          typeof ptyProcess.kill !== "function"
        ) {
          throw new TypeError("spawnPty must return a node-pty-compatible process");
        }

        executionPromise = new Promise((resolve, reject) => {
          resolveExecution = resolve;
          rejectExecution = reject;
        });
        state = "running";
        ptyExited = false;
        inputReady = !commandFromStdin;
        disposables.push(
          ptyProcess.onData(handleRawData),
          ptyProcess.onExit((event = {}) => {
            ptyExited = true;
            ptyPaused = false;
            exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
            exitSignal = event.signal;
            void settleExecution({
              onData: options.onData,
              timeout: options.timeout,
            });
          }),
        );

        signal = options.signal;
        if (signal) {
          // A user-initiated graceful interrupt writes Ctrl+C first, then the
          // bridge aborts Pi's public bash signal so its canonical persisted
          // result records `cancelled:true`. In that ordering the signal must
          // not collapse the grace period into an immediate SIGKILL. Other
          // abort sources (Escape, shutdown) still terminate immediately.
          signalListener = () => {
            if (!interruptRequested) forceKill();
          };
          signal.addEventListener("abort", signalListener, { once: true });
          if (signal.aborted) signalListener();
        }

        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            forceKill();
          }, timeoutMs);
          timeoutHandle.unref?.();
        }

        notifyState();
        reconcilePtyFlowControl();
        if (commandFromStdin) {
          ptyProcess.write(stdinBootstrap.script);
        }
      } catch (error) {
        executionSettled = true;
        state = "failed";
        clearExecutionResources();
        disposeTerminal();
        try {
          if (ptyProcess) killPtyProcess(ptyProcess);
        } catch {
          // The original setup failure is the actionable error.
        }
        if (executionPromise) {
          rejectExecution(error);
          return executionPromise;
        }
        return Promise.reject(error);
      }

      return executionPromise;
    },
  };

  const writeInput = ({ sequence, data } = {}) => {
    assertPositiveInteger(sequence, "sequence");
    if (typeof data !== "string") {
      throw new TypeError("input data must be a string");
    }
    if (Buffer.byteLength(data) > MAX_INPUT_BYTES) {
      return {
        accepted: false,
        tooLarge: true,
        maxBytes: MAX_INPUT_BYTES,
        acknowledgedThrough: inputAcknowledgedThrough,
      };
    }

    if (sequence <= inputAcknowledgedThrough) {
      return {
        accepted: false,
        duplicate: true,
        acknowledgedThrough: inputAcknowledgedThrough,
      };
    }
    if (sequence !== inputAcknowledgedThrough + 1) {
      return {
        accepted: false,
        gap: true,
        acknowledgedThrough: inputAcknowledgedThrough,
        expectedSequence: inputAcknowledgedThrough + 1,
      };
    }
    if (state !== "running" || !ptyProcess) {
      return {
        accepted: false,
        closed: true,
        acknowledgedThrough: inputAcknowledgedThrough,
      };
    }
    if (!inputReady) {
      return {
        accepted: false,
        notReady: true,
        acknowledgedThrough: inputAcknowledgedThrough,
      };
    }

    ptyProcess.write(data);
    inputAcknowledgedThrough = sequence;
    return {
      accepted: true,
      acknowledgedThrough: inputAcknowledgedThrough,
    };
  };

  const resize = ({ revision, cols: nextCols, rows: nextRows } = {}) => {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError("revision must be a non-negative safe integer");
    }
    const normalizedSize = normalizeTerminalSize(nextCols, nextRows);

    if (revision <= resizeRevision) {
      return {
        accepted: false,
        stale: true,
        revision: resizeRevision,
        cols,
        rows,
      };
    }
    if (state !== "running" || !ptyProcess) {
      return {
        accepted: false,
        closed: true,
        revision: resizeRevision,
        cols,
        rows,
      };
    }

    ptyProcess.resize(normalizedSize.cols, normalizedSize.rows);
    terminal.resize(normalizedSize.cols, normalizedSize.rows);
    cols = normalizedSize.cols;
    rows = normalizedSize.rows;
    resizeRevision = revision;
    return {
      accepted: true,
      revision: resizeRevision,
      cols,
      rows,
    };
  };

  const interrupt = () => {
    if (state !== "running" || !ptyProcess) {
      return { requested: false, state };
    }
    if (interruptRequested) {
      return { requested: false, alreadyRequested: true, state };
    }
    ptyProcess.write("\u0003");
    interruptRequested = true;
    notifyState();
    return { requested: true, state };
  };

  const setTransportBackpressured = (backpressured) => {
    if (typeof backpressured !== "boolean") {
      throw new TypeError("backpressured must be a boolean");
    }
    transportBackpressured = backpressured;
    reconcilePtyFlowControl();
    return {
      backpressured: transportBackpressured,
      paused: ptyPaused,
    };
  };

  const snapshotReplay = async (afterSequence = 0) => {
    await terminalWrites;
    return snapshot(afterSequence);
  };

  const reconstructionSnapshot = async () => {
    await terminalWrites;
    const keyframe = serializeKeyframe();
    return {
      keyframe,
      snapshot: snapshot(keyframe?.throughSequence ?? 0),
    };
  };

  const dispose = () => {
    if (state === "running") {
      forceKill();
    } else {
      clearExecutionResources();
      if (state === "idle") state = "disposed";
      inputReady = false;
      disposeTerminal();
    }
  };

  return {
    operations,
    writeInput,
    resize,
    interrupt,
    forceKill,
    setTransportBackpressured,
    snapshot,
    snapshotReplay,
    reconstructionSnapshot,
    dispose,
  };
}

export const SHELL_PTY_DEFAULTS = Object.freeze({
  cols: DEFAULT_COLS,
  rows: DEFAULT_ROWS,
  scrollback: DEFAULT_SCROLLBACK,
  maxReplayBytes: DEFAULT_REPLAY_BYTES,
  maxInputBytes: MAX_INPUT_BYTES,
  parserBackpressureHighBytes: PARSER_BACKPRESSURE_HIGH_BYTES,
  parserBackpressureLowBytes: PARSER_BACKPRESSURE_LOW_BYTES,
  minCols: MIN_COLS,
  maxCols: MAX_COLS,
  minRows: MIN_ROWS,
  maxRows: MAX_ROWS,
  alternateScreenMarker: ALT_SCREEN_MARKER,
  alternateScreenOmissionMarker: ALT_SCREEN_OMISSION_MARKER,
});

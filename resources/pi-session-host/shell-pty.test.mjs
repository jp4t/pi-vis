import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  SHELL_PTY_DEFAULTS,
  createShellPtyController,
  terminalBufferToText,
} from "./shell-pty.mjs";

const require = createRequire(import.meta.url);

class FakePty {
  constructor() {
    this.dataListeners = new Set();
    this.exitListeners = new Set();
    this.writes = [];
    this.resizes = [];
    this.kills = [];
    this.pauses = 0;
    this.resumes = 0;
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return {
      dispose: () => this.dataListeners.delete(listener),
    };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return {
      dispose: () => this.exitListeners.delete(listener),
    };
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  pause() {
    this.pauses += 1;
  }

  resume() {
    this.resumes += 1;
  }

  kill(signal) {
    this.kills.push(signal);
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode, signal) {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

function setupController(overrides = {}) {
  const pty = new FakePty();
  const spawnPty = vi.fn(() => pty);
  const raw = [];
  const callbackErrors = [];
  const controller = createShellPtyController({
    executionId: "shell-1",
    shellConfig: { shell: "/bin/bash", args: ["-c"] },
    spawnPty,
    onRawData: (event) => raw.push(event),
    onCallbackError: (error) => callbackErrors.push(error),
    ...overrides,
  });
  return { controller, pty, spawnPty, raw, callbackErrors };
}

describe("createShellPtyController", () => {
  it("runs a one-shot shell and sends only normalized final text to Pi", async () => {
    const { controller, pty, spawnPty, raw } = setupController({
      initialSize: { cols: 40, rows: 8 },
      baseEnv: { BASE: "base" },
    });
    const piOutput = [];

    const execution = controller.operations.exec("printf hello", "/work", {
      onData: (data) => piOutput.push(data.toString("utf8")),
      env: { EXPLICIT: "yes" },
    });

    expect(spawnPty).toHaveBeenCalledWith("/bin/bash", ["-c", "printf hello"], {
      name: "xterm-256color",
      cwd: "/work",
      env: {
        EXPLICIT: "yes",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      cols: 40,
      rows: 8,
    });

    pty.emitData("hello\r\n");
    pty.emitData("world");
    expect(raw).toEqual([
      { executionId: "shell-1", sequence: 1, data: "hello\r\n" },
      { executionId: "shell-1", sequence: 2, data: "world" },
    ]);
    expect(piOutput).toEqual([]);

    pty.emitExit(7);
    await expect(execution).resolves.toEqual({ exitCode: 7 });
    expect(piOutput).toEqual(["hello\nworld"]);

    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      executionId: "shell-1",
      state: "exited",
      exitCode: 7,
      outputSequence: 2,
      terminal: {
        alternateScreenSeen: false,
        normalizedText: "hello\nworld",
      },
    });
    await expect(
      controller.operations.exec("echo again", "/work", { onData: vi.fn() }),
    ).rejects.toThrow("single-use");
  });

  it("normalizes wrapped rows and retains the last alternate-screen frame", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 20, rows: 4 },
    });
    const piOutput = [];
    const execution = controller.operations.exec("interactive", "/work", {
      onData: (data) => piOutput.push(data.toString("utf8")),
    });

    pty.emitData("abcdefghijklmnopqrstuvwx\r\n");
    pty.emitData("\u001b[?1049h\u001b[2J\u001b[Hmenu\r\nchoice");
    pty.emitData("\u001b[?1049lafter");
    pty.emitExit(0);

    await expect(execution).resolves.toEqual({ exitCode: 0 });
    const snapshot = controller.snapshot();
    expect(snapshot.terminal.alternateScreenSeen).toBe(true);
    expect(snapshot.terminal.throughSequence).toBe(3);
    expect(snapshot.terminal.normalText).toContain("abcdefghijklmnopqrstuvwx");
    expect(snapshot.terminal.normalText).toContain("after");
    expect(snapshot.terminal.alternateFrames).toEqual([
      {
        index: 1,
        cols: 20,
        rows: 4,
        text: "menu\nchoice",
        throughSequence: 3,
      },
    ]);
    expect(snapshot.terminal.normalizedText).toContain(SHELL_PTY_DEFAULTS.alternateScreenMarker);
    expect(piOutput).toEqual([snapshot.terminal.normalizedText]);
    expect(piOutput[0]).not.toContain("\u001b");
  });

  it("captures and interleaves one final frame for every alternate-screen interval", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 30, rows: 6 },
    });
    const piOutput = [];
    const execution = controller.operations.exec("two screens", "/work", {
      onData: (data) => piOutput.push(data.toString("utf8")),
    });

    pty.emitData("before\r\n");
    pty.emitData("\u001b[?1049h\u001b[2J\u001b[Hfirst frame\u001b[?1049l");
    pty.emitData("between\r\n");
    pty.emitData("\u001b[?1049h\u001b[2J\u001b[H\u001b[?1049l");
    pty.emitData("after");
    pty.emitExit(0);

    await execution;
    const snapshot = controller.snapshot();
    expect(snapshot.terminal.alternateFrames).toEqual([
      {
        index: 1,
        cols: 30,
        rows: 6,
        text: "first frame",
        throughSequence: 2,
      },
      {
        index: 2,
        cols: 30,
        rows: 6,
        text: "",
        throughSequence: 4,
      },
    ]);

    const normalized = snapshot.terminal.normalizedText;
    const orderedFragments = [
      "before",
      "[alternate screen final frame 30x6]",
      "first frame",
      "between",
      "[alternate screen final frame 30x6]",
      "[empty]",
      "after",
    ];
    let previousIndex = -1;
    for (const fragment of orderedFragments) {
      const index = normalized.indexOf(fragment, previousIndex + 1);
      expect(index, `missing or misordered fragment: ${fragment}`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(piOutput).toEqual([normalized]);
  });

  it("normalizes cursor editing, OSC metadata, Unicode, and invalid UTF-8", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 20, rows: 8 },
    });
    const piOutput = [];
    const execution = controller.operations.exec("terminal-effects", "/work", {
      onData: (data) => piOutput.push(data.toString("utf8")),
    });

    pty.emitData("progress 10%\rprogress 20%\u001b[K\r\n");
    pty.emitData("abc\b\bXY\r\n");
    pty.emitData("\u001b]0;private terminal title\u0007");
    pty.emitData("\u001b]8;;https://example.invalid/private\u0007linked\u001b]8;;\u0007\r\n");
    pty.emitData("1234567890123456789🙂z e\u0301\r\n");
    pty.emitData(Buffer.from([0x62, 0x61, 0x64, 0xff, 0x0d, 0x0a]));
    pty.emitExit(0);

    await execution;
    const normalized = piOutput.join("");
    expect(normalized).toContain("progress 20%");
    expect(normalized).not.toContain("progress 10%");
    expect(normalized).toContain("aXY");
    expect(normalized).toContain("linked");
    expect(normalized).not.toContain("private terminal title");
    expect(normalized).not.toContain("example.invalid");
    expect(normalized).toContain("1234567890123456789🙂z e\u0301");
    expect(normalized).toContain("bad�");
    expect(normalized).not.toContain("\u001b");
    expect(normalized).not.toContain("\u0000");
  });

  it("captures empty and populated frames for every supported alternate-screen mode", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 30, rows: 6 },
    });
    const execution = controller.operations.exec("alternate variants", "/work", {
      onData: vi.fn(),
    });

    pty.emitData("\u001b[?47hforty-seven\u001b[?47l");
    pty.emitData("\u001b[?1047h\u001b[2J\u001b[H\u001b[?1047l");
    pty.emitData("\u001b[?1049hstill active");
    pty.emitExit(0);

    await execution;
    expect(controller.snapshot().terminal.alternateFrames.map((frame) => frame.text)).toEqual([
      "forty-seven",
      "",
      "still active",
    ]);
  });

  it("fences input by sequence without retaining raw input and revisions resize", async () => {
    const { controller, pty } = setupController();
    const execution = controller.operations.exec("read secret", "/work", {
      onData: vi.fn(),
    });

    expect(controller.writeInput({ sequence: 2, data: "too-early" })).toEqual({
      accepted: false,
      gap: true,
      acknowledgedThrough: 0,
      expectedSequence: 1,
    });
    expect(controller.writeInput({ sequence: 1, data: "super-secret\r" })).toEqual({
      accepted: true,
      acknowledgedThrough: 1,
    });
    expect(controller.writeInput({ sequence: 1, data: "duplicate-secret" })).toEqual({
      accepted: false,
      duplicate: true,
      acknowledgedThrough: 1,
    });
    expect(controller.writeInput({ sequence: 2, data: "next\r" })).toEqual({
      accepted: true,
      acknowledgedThrough: 2,
    });
    expect(pty.writes).toEqual(["super-secret\r", "next\r"]);
    expect(
      controller.writeInput({
        sequence: 3,
        data: "x".repeat(SHELL_PTY_DEFAULTS.maxInputBytes + 1),
      }),
    ).toEqual({
      accepted: false,
      tooLarge: true,
      maxBytes: SHELL_PTY_DEFAULTS.maxInputBytes,
      acknowledgedThrough: 2,
    });

    expect(controller.resize({ revision: 1, cols: 100, rows: 32 })).toEqual({
      accepted: true,
      revision: 1,
      cols: 100,
      rows: 32,
    });
    expect(controller.resize({ revision: 1, cols: 120, rows: 40 })).toEqual({
      accepted: false,
      stale: true,
      revision: 1,
      cols: 100,
      rows: 32,
    });
    expect(pty.resizes).toEqual([{ cols: 100, rows: 32 }]);

    const serializedSnapshot = JSON.stringify(await controller.snapshotReplay());
    expect(serializedSnapshot).not.toContain("super-secret");
    expect(serializedSnapshot).not.toContain("duplicate-secret");
    expect(serializedSnapshot).not.toContain("next");
    expect(controller.snapshot()).toMatchObject({
      inputAcknowledgedThrough: 2,
      resizeRevision: 1,
      cols: 100,
      rows: 32,
    });

    pty.emitExit(0);
    await execution;
    expect(controller.writeInput({ sequence: 3, data: "after-exit" })).toEqual({
      accepted: false,
      closed: true,
      acknowledgedThrough: 2,
    });
  });

  it("preserves the graceful window when Pi cancellation follows Ctrl+C", async () => {
    const abortController = new AbortController();
    const { controller, pty } = setupController();
    const execution = controller.operations.exec("sleep 100", "/work", {
      onData: vi.fn(),
      signal: abortController.signal,
    });

    expect(controller.interrupt()).toEqual({ requested: true, state: "running" });
    expect(controller.interrupt()).toEqual({
      requested: false,
      alreadyRequested: true,
      state: "running",
    });
    expect(pty.writes).toEqual(["\u0003"]);
    expect(controller.snapshot()).toMatchObject({
      interruptRequested: true,
      forceKillRequested: false,
    });

    abortController.abort();
    expect(pty.kills).toEqual([]);
    expect(controller.snapshot().forceKillRequested).toBe(false);
    expect(controller.forceKill()).toEqual({ requested: true, state: "running" });
    expect(controller.forceKill()).toEqual({
      requested: false,
      alreadyRequested: true,
      state: "running",
    });
    expect(pty.kills).toEqual(["SIGKILL"]);

    pty.emitExit(null, 9);
    await expect(execution).resolves.toEqual({ exitCode: null });
    expect(controller.snapshot()).toMatchObject({
      state: "exited",
      exitSignal: 9,
      forceKillRequested: true,
    });
    expect(controller.forceKill()).toEqual({ requested: false, state: "exited" });
  });

  it("force-kills an SDK abort that had no prior graceful interrupt", async () => {
    const abortController = new AbortController();
    const killPtyProcess = vi.fn((ptyProcess) => ptyProcess.kill("PROCESS_GROUP"));
    const { controller, pty } = setupController({ killPtyProcess });
    const execution = controller.operations.exec("sleep 100", "/work", {
      onData: vi.fn(),
      signal: abortController.signal,
    });

    abortController.abort();
    expect(pty.writes).toEqual([]);
    expect(killPtyProcess).toHaveBeenCalledWith(pty);
    expect(pty.kills).toEqual(["PROCESS_GROUP"]);
    expect(controller.snapshot()).toMatchObject({
      interruptRequested: false,
      forceKillRequested: true,
    });

    pty.emitExit(null, 9);
    await expect(execution).resolves.toEqual({ exitCode: null });
  });

  it.runIf(process.platform !== "win32")(
    "targets the forkpty process group before falling back to node-pty kill",
    async () => {
      const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const { controller, pty } = setupController();
        pty.pid = 43_210;
        const execution = controller.operations.exec("sleep 100", "/work", {
          onData: vi.fn(),
        });

        expect(controller.forceKill()).toEqual({ requested: true, state: "running" });
        expect(processKill).toHaveBeenCalledWith(-43_210, "SIGKILL");
        expect(pty.kills).toEqual([]);

        pty.emitExit(null, 9);
        await execution;
      } finally {
        processKill.mockRestore();
      }
    },
  );

  it("force-kills a timed-out shell and rejects with Pi-compatible timeout syntax", async () => {
    vi.useFakeTimers();
    try {
      const { controller, pty } = setupController();
      const execution = controller.operations.exec("sleep 100", "/work", {
        onData: vi.fn(),
        timeout: 0.01,
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(pty.kills).toEqual(["SIGKILL"]);
      expect(controller.snapshot()).toMatchObject({
        timedOut: true,
        forceKillRequested: true,
      });

      pty.emitExit(null, 9);
      await expect(execution).rejects.toThrow("timeout:0.01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns bounded snapshot replay with an explicit gap", async () => {
    const { controller, pty, raw } = setupController({ maxReplayBytes: 5 });
    const execution = controller.operations.exec("chatty", "/work", {
      onData: vi.fn(),
    });

    pty.emitData("abc");
    pty.emitData("def");

    const baseline = await controller.snapshotReplay(0);
    expect(raw).toHaveLength(2);
    expect(baseline.replay).toEqual({
      afterSequence: 0,
      fromSequence: 2,
      throughSequence: 2,
      gap: true,
      truncated: true,
      chunks: [{ sequence: 2, data: "def" }],
    });
    expect((await controller.snapshotReplay(1)).replay).toMatchObject({
      fromSequence: 2,
      gap: false,
      chunks: [{ sequence: 2, data: "def" }],
    });

    pty.emitExit(0);
    await execution;
  });

  it("reconstructs the parsed terminal as a bounded emulator keyframe", async () => {
    const { Terminal } = require("@xterm/xterm");
    const { controller, pty } = setupController({
      initialSize: { cols: 30, rows: 6 },
      maxReplayBytes: 256,
    });
    const execution = controller.operations.exec("interactive", "/work", {
      onData: vi.fn(),
    });

    controller.writeInput({ sequence: 1, data: "never-retain-this-secret\r" });
    pty.emitData("before\r\n\u001b[?1049h\u001b[2J\u001b[Hmenu");
    for (let index = 0; index < 40; index += 1) {
      pty.emitData(`\rchoice ${index}`);
    }
    expect(controller.snapshot().replay.gap).toBe(true);

    const reconstruction = await controller.reconstructionSnapshot();
    expect(reconstruction.keyframe).toMatchObject({
      throughSequence: 41,
      truncated: false,
    });
    expect(Buffer.byteLength(reconstruction.keyframe.ansi)).toBeLessThanOrEqual(256);
    expect(JSON.stringify(reconstruction)).not.toContain("never-retain-this-secret");
    expect(reconstruction.snapshot.replay).toMatchObject({
      afterSequence: 41,
      throughSequence: 41,
      gap: false,
      chunks: [],
    });

    const restored = new Terminal({ cols: 30, rows: 6, scrollback: 10_000 });
    await new Promise((resolve) => restored.write(reconstruction.keyframe.ansi, resolve));
    expect(restored.buffer.active.type).toBe("alternate");
    expect(terminalBufferToText(restored.buffer.normal)).toBe(
      reconstruction.snapshot.terminal.normalText,
    );
    expect(terminalBufferToText(restored.buffer.alternate)).toBe(
      reconstruction.snapshot.terminal.currentAlternateText,
    );
    restored.dispose();

    pty.emitExit(0);
    await execution;
  });

  it("falls back to bounded raw replay when a keyframe cannot fit", async () => {
    const { controller, pty } = setupController({ maxReplayBytes: 0 });
    const execution = controller.operations.exec("echo ok", "/work", {
      onData: vi.fn(),
    });
    pty.emitData("ok");

    const reconstruction = await controller.reconstructionSnapshot();
    expect(reconstruction.keyframe).toBeUndefined();
    expect(reconstruction.snapshot.replay).toMatchObject({
      afterSequence: 0,
      throughSequence: 1,
      gap: true,
      truncated: true,
      chunks: [],
    });

    pty.emitExit(0);
    await execution;
  });

  it("bootstraps Pi's stdin shell transport before accepting or publishing input", async () => {
    const raw = [];
    const normalized = [];
    const { controller, pty, spawnPty } = setupController({
      shellConfig: {
        shell: "legacy-bash.exe",
        args: ["-s"],
        commandTransport: "stdin",
      },
      onRawData: (event) => raw.push(event.data),
    });
    const execution = controller.operations.exec("echo ok", "C:\\work", {
      onData: (data) => normalized.push(data.toString("utf8")),
    });

    expect(spawnPty.mock.calls[0][1]).toEqual(["-s"]);
    expect(spawnPty.mock.calls[0][2]).toMatchObject({
      cols: SHELL_PTY_DEFAULTS.cols,
      rows: 8,
    });
    expect(controller.snapshot().inputReady).toBe(false);
    expect(controller.writeInput({ sequence: 1, data: "too-soon\r" })).toEqual({
      accepted: false,
      notReady: true,
      acknowledgedThrough: 0,
    });

    const bootstrap = pty.writes[0];
    expect(bootstrap).toContain("='echo ok'");
    expect(bootstrap).toContain("builtin eval");
    expect(bootstrap).toContain("builtin exit");
    expect(bootstrap).not.toContain("echo ok\nexit\n");
    const nonce = bootstrap.match(/PIVIS-SHELL-READY;([0-9a-f]{32})/)?.[1];
    expect(nonce).toBeTypeOf("string");
    const marker = `\u001b]777;PIVIS-SHELL-READY;${nonce}\u0007`;
    pty.emitData(`bootstrap echo and prompt${marker.slice(0, 17)}`);
    expect(controller.snapshot().inputReady).toBe(false);
    pty.emitData(`${marker.slice(17)}ok\r\n`);

    expect(controller.snapshot().inputReady).toBe(true);
    expect(raw).toEqual(["ok\r\n"]);
    expect(controller.writeInput({ sequence: 1, data: "ready\r" })).toMatchObject({
      accepted: true,
      acknowledgedThrough: 1,
    });

    pty.emitExit(0);
    await execution;
    expect(normalized).toEqual(["ok"]);
    expect(JSON.stringify(controller.snapshot())).not.toContain("bootstrap echo");
  });

  it("pauses node-pty while parser or transport output is backpressured", async () => {
    const { controller, pty } = setupController();
    controller.setTransportBackpressured(true);
    const execution = controller.operations.exec("chatty", "/work", { onData: vi.fn() });
    expect(pty.pauses).toBe(1);
    expect(pty.resumes).toBe(0);

    pty.emitData("x".repeat(SHELL_PTY_DEFAULTS.parserBackpressureHighBytes));
    controller.setTransportBackpressured(false);
    expect(pty.resumes).toBe(0);

    await controller.snapshotReplay();
    expect(pty.pauses).toBe(1);
    expect(pty.resumes).toBe(1);

    pty.emitExit(0);
    await execution;
    controller.setTransportBackpressured(true);
    controller.setTransportBackpressured(false);
    expect(pty.resumes).toBe(1);
  });

  it("bounds retained alternate frames and marks omitted intervals", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 20, rows: 4 },
      maxReplayBytes: 100,
    });
    const execution = controller.operations.exec("many screens", "/work", { onData: vi.fn() });
    for (const frame of ["first frame", "second frame", "third frame"]) {
      pty.emitData(`\u001b[?1049h\u001b[2J\u001b[H${frame}\u001b[?1049l`);
    }
    pty.emitExit(0);
    await execution;

    const snapshot = controller.snapshot();
    expect(snapshot.terminal.alternateFramesOmitted).toBeGreaterThan(0);
    expect(snapshot.terminal.alternateFrames.length).toBeLessThan(3);
    expect(snapshot.terminal.normalizedText).toContain(
      SHELL_PTY_DEFAULTS.alternateScreenOmissionMarker,
    );
    expect(snapshot.terminal.normalizedText).toContain("third frame");
  });

  it("marks emulator keyframes when xterm has dropped normal scrollback", async () => {
    const { controller, pty } = setupController({
      initialSize: { cols: 20, rows: 2 },
      scrollback: 2,
    });
    const execution = controller.operations.exec("overflow", "/work", { onData: vi.fn() });
    pty.emitData(Array.from({ length: 12 }, (_, index) => `line ${index}\r\n`).join(""));

    const reconstruction = await controller.reconstructionSnapshot();
    expect(reconstruction.snapshot.terminal.normalScrollbackOverflow).toBe(true);
    expect(reconstruction.keyframe).toMatchObject({ truncated: true });

    pty.emitExit(0);
    await execution;
  });

  it("does not spawn when the SDK abort signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const { controller, spawnPty } = setupController();

    await expect(
      controller.operations.exec("never", "/work", {
        onData: vi.fn(),
        signal: abortController.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("makes an idle controller single-use when disposed", async () => {
    const { controller, spawnPty } = setupController();
    controller.dispose();

    expect(controller.snapshot().state).toBe("disposed");
    await expect(controller.operations.exec("never", "/work", { onData: vi.fn() })).rejects.toThrow(
      "single-use",
    );
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it("isolates raw-output observer failures from the shell lifecycle", async () => {
    const observerError = new Error("renderer disconnected");
    const errors = [];
    const { controller, pty } = setupController({
      onRawData: () => {
        throw observerError;
      },
      onCallbackError: (error) => errors.push(error),
    });
    const execution = controller.operations.exec("echo ok", "/work", {
      onData: vi.fn(),
    });

    pty.emitData("ok");
    pty.emitExit(0);

    await expect(execution).resolves.toEqual({ exitCode: 0 });
    expect(errors).toEqual([observerError]);
  });

  it("loads the native PTY dependency and completes a real one-shot shell", async () => {
    const shellConfig =
      process.platform === "win32"
        ? {
            shell: process.env.ComSpec ?? "cmd.exe",
            args: ["/d", "/s", "/c"],
            commandTransport: "argv",
          }
        : { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" };
    const controller = createShellPtyController({
      executionId: "native-shell-smoke",
      shellConfig,
    });
    const normalized = [];
    try {
      await expect(
        controller.operations.exec("echo native-pty-ok", process.cwd(), {
          onData: (data) => normalized.push(data.toString("utf8")),
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(normalized.join("\n")).toContain("native-pty-ok");
    } finally {
      controller.dispose();
    }
  }, 10_000);

  it.runIf(process.platform !== "win32")(
    "runs an interactive command through the native PTY without changing process identity",
    async () => {
      const raw = [];
      const controller = createShellPtyController({
        executionId: "native-interactive-smoke",
        shellConfig: { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" },
        onRawData: (event) => raw.push(event.data),
      });
      const normalized = [];
      try {
        const execution = controller.operations.exec(
          "printf 'name? '; IFS= read name; printf '\\nhello %s\\n' \"$name\"",
          process.cwd(),
          {
            onData: (data) => normalized.push(data.toString("utf8")),
          },
        );
        const beforeResize = controller.snapshot();
        expect(controller.resize({ revision: 1, cols: 100, rows: 12 })).toMatchObject({
          accepted: true,
          cols: 100,
          rows: 12,
        });
        expect(controller.snapshot().executionId).toBe(beforeResize.executionId);
        expect(controller.writeInput({ sequence: 1, data: "Ada\r" })).toMatchObject({
          accepted: true,
          acknowledgedThrough: 1,
        });

        await expect(execution).resolves.toMatchObject({ exitCode: 0 });
        expect(raw.join("")).toContain("name?");
        expect(normalized.join("\n")).toContain("hello Ada");
      } finally {
        controller.dispose();
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "keeps a native stdin-transport command interactive after its bootstrap",
    async () => {
      let markReady;
      const ready = new Promise((resolve) => {
        markReady = resolve;
      });
      const raw = [];
      const controller = createShellPtyController({
        executionId: "native-stdin-interactive",
        shellConfig: { shell: "/bin/bash", args: ["-s"], commandTransport: "stdin" },
        onRawData: (event) => raw.push(event.data),
        onStateChange: (snapshot) => {
          if (snapshot.inputReady) markReady();
        },
      });
      const normalized = [];
      try {
        const execution = controller.operations.exec(
          "printf 'name? '; IFS= read -r name; printf '\\nhello %s\\n' \"$name\"",
          process.cwd(),
          {
            onData: (data) => normalized.push(data.toString("utf8")),
          },
        );

        await ready;
        expect(controller.writeInput({ sequence: 1, data: "Ada\r" })).toEqual({
          accepted: true,
          acknowledgedThrough: 1,
        });
        await expect(execution).resolves.toMatchObject({ exitCode: 0 });

        expect(raw.join("")).toContain("name?");
        expect(normalized.join("\n")).toContain("hello Ada");
        expect(raw.join("")).not.toContain("PIVIS-SHELL-READY");
        expect(JSON.stringify(controller.snapshot())).not.toContain("__pivis_command_");
      } finally {
        controller.dispose();
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "does not retain native stdin input while terminal echo is disabled",
    async () => {
      let markPrompt;
      const prompted = new Promise((resolve) => {
        markPrompt = resolve;
      });
      const raw = [];
      const controller = createShellPtyController({
        executionId: "native-stdin-secret",
        shellConfig: { shell: "/bin/bash", args: ["-s"], commandTransport: "stdin" },
        onRawData: (event) => {
          raw.push(event.data);
          if (raw.join("").includes("password?")) markPrompt();
        },
      });
      const normalized = [];
      try {
        const execution = controller.operations.exec(
          "stty -echo; printf 'password? '; IFS= read -r secret; stty echo; printf '\\nlength=%s\\n' \"${#secret}\"",
          process.cwd(),
          {
            onData: (data) => normalized.push(data.toString("utf8")),
          },
        );

        await prompted;
        expect(controller.writeInput({ sequence: 1, data: "never-retain-this\r" })).toMatchObject({
          accepted: true,
        });
        await expect(execution).resolves.toMatchObject({ exitCode: 0 });

        expect(normalized.join("\n")).toContain("length=17");
        expect(raw.join("")).not.toContain("never-retain-this");
        expect(JSON.stringify(controller.snapshot())).not.toContain("never-retain-this");
      } finally {
        controller.dispose();
      }
    },
    10_000,
  );
});

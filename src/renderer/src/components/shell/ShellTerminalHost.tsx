import type { SessionId } from "@shared/ids.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRoutedEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { authorityNeedsBaseline } from "../../lib/authority-attach-retry.js";
import { liveShellPresentationFor, useSessionsStore } from "../../stores/sessions-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { BashBlockData } from "../../stores/transcript.js";
import { getTheme } from "../../theme/registry.js";
import { basePanelTerminalOptions, buildXtermTheme } from "../../theme/xterm.js";
import { Spinner } from "../common/Spinner.js";
import { IconAlert, IconChevronDown } from "../common/icons.js";
import { DEFAULT_HEIGHT_FRACTION, createPanelSizer } from "../ext-ui/panel-sizer.js";
import {
  isShellCopyShortcut,
  shellReplayPlan,
  shellViewportIsUnpinned,
} from "./shell-terminal-behavior.js";
import "@xterm/xterm/css/xterm.css";
import "./ShellTerminalHost.css";

const SHELL_SCROLLBACK_ROWS = 10_000;
const PENDING_SHELL_INPUT_MAX_CHARS = 64 * 1024;
const SHELL_OUTPUT_GAP_MESSAGE =
  "Live shell output lost synchronization; earlier output may be omitted.";

function warnShellOutputGap(sessionId: SessionId): void {
  useSessionsStore.getState().addToast(sessionId, SHELL_OUTPUT_GAP_MESSAGE, "warning");
}

function monoFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim() ||
    "ui-monospace, Menlo, monospace"
  );
}

function mayFocusShellTerminal(container: HTMLElement, explicit: boolean): boolean {
  const active = document.activeElement;
  if (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    container.contains(active)
  ) {
    return true;
  }
  if (!explicit || !(active instanceof HTMLElement)) return false;
  return !(
    active.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ||
    active.closest(".composer, .custom-panel, .ext-dialog, .picker-slot, .unified-tui")
  );
}

export interface ShellTerminalHostProps {
  sessionId: SessionId;
  requestAttach: (sessionId: SessionId, force?: boolean) => Promise<void>;
}

export function ShellTerminalHost({
  sessionId,
  requestAttach,
}: ShellTerminalHostProps): React.ReactElement {
  const session = useSessionsStore((state) => state.sessions.get(sessionId));
  const presentation = liveShellPresentationFor(session);
  const authorityFenced = authorityNeedsBaseline(session?.authorityProjection);
  const activity = presentation?.activity;
  const block = session?.transcript.blocks.find(
    (candidate) =>
      candidate.type === "bash" &&
      candidate.data.executionId === presentation?.executionId &&
      candidate.data.isStreaming,
  );
  const data: BashBlockData | undefined = block?.type === "bash" ? block.data : undefined;
  const executionId = presentation?.executionId ?? data?.executionId ?? "";
  const presentationOwner = presentation?.snapshot.owner;
  const controlOwner =
    presentation?.authoritative === true && !authorityFenced ? presentationOwner : undefined;
  const presentationHostInstanceId = presentationOwner?.hostInstanceId;
  const presentationSessionEpoch = presentationOwner?.sessionEpoch;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const syncSizeRef = useRef<(() => void) | null>(null);
  const terminalIdentityRef = useRef("");
  const renderedOutputSequenceRef = useRef(data?.terminalOutputSequence ?? 0);
  const outputGapWarningSequenceRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(data?.inputAcknowledgedThrough ?? 0);
  const resizeRevisionRef = useRef(data?.resizeRevision ?? 0);
  const reconstructionReadyKeyRef = useRef("");
  const inputEnabledRef = useRef(false);
  const controlReadyRef = useRef(controlOwner !== undefined);
  const pendingInputRef = useRef<string[]>([]);
  const pendingInputCharsRef = useRef(0);
  const pendingInputWarningRef = useRef(false);
  const pendingInputIdentityRef = useRef("");
  const initialFocusOpportunityRef = useRef(true);
  const restoreFocusRequestedRef = useRef(false);
  const [focused, setFocused] = useState(false);
  const [restoreFocusRequested, setRestoreFocusRequested] = useState(false);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [acknowledgedReconstructionKey, setAcknowledgedReconstructionKey] = useState("");
  const activeColorScheme = useSettingsStore((state) => state.activeColorScheme);
  const shellIdentity =
    presentationOwner && executionId
      ? `${sessionId}\0${presentationOwner.hostInstanceId}\0${presentationOwner.sessionEpoch}\0${executionId}`
      : "";
  const reconstructionRevision = data?.terminalReconstructionRevision ?? 0;
  const reconstructionFenceToken = data?.terminalReconstructionFenceToken;
  const reconstructionKey = shellIdentity ? `${shellIdentity}\0${reconstructionRevision}` : "";
  const terminalIsCurrent =
    terminalRef.current !== null && terminalIdentityRef.current === reconstructionKey;
  const reconstructionConsumedByThisMount = reconstructionReadyKeyRef.current === reconstructionKey;
  const reconstructionIsFresh =
    reconstructionKey.length > 0 &&
    reconstructionRevision > 0 &&
    reconstructionFenceToken !== undefined &&
    (session?.shellReconstructionAckKey !== reconstructionKey || reconstructionConsumedByThisMount);
  const awaitingFreshReconstruction =
    shellIdentity.length > 0 &&
    (authorityFenced ||
      presentation?.authoritative !== true ||
      !terminalIsCurrent ||
      !reconstructionIsFresh ||
      acknowledgedReconstructionKey !== reconstructionKey);
  const needsFreshAttach = shellIdentity.length > 0 && (authorityFenced || !reconstructionIsFresh);
  const composerFocusRequest = useSessionsStore((state) => state.composerFocusRequest);
  const matchingFocusRequest =
    composerFocusRequest?.sessionId === sessionId ? composerFocusRequest : undefined;
  controlReadyRef.current = controlOwner !== undefined;
  if (!controlReadyRef.current || reconstructionReadyKeyRef.current !== reconstructionKey) {
    inputEnabledRef.current = false;
  }

  // Shell terminals and custom() overlays are both fixed Composer-slot
  // viewports. They intentionally share the same persisted size preference
  // and App-owned drag/reset affordance so switching surfaces does not invent a
  // second resizing language.
  const dragFractionRef = useRef<number | null>(null);
  const fractionGetterRef = useRef<() => number>(() => DEFAULT_HEIGHT_FRACTION);
  fractionGetterRef.current = () =>
    dragFractionRef.current ??
    useSettingsStore.getState().settings.customPanelHeightFraction ??
    DEFAULT_HEIGHT_FRACTION;
  const customPanelHeightFraction = useSettingsStore(
    (state) => state.settings.customPanelHeightFraction,
  );

  const queuePendingInput = useCallback(
    (chunk: string) => {
      if (pendingInputCharsRef.current + chunk.length > PENDING_SHELL_INPUT_MAX_CHARS) {
        if (!pendingInputWarningRef.current) {
          pendingInputWarningRef.current = true;
          useSessionsStore
            .getState()
            .addToast(
              sessionId,
              "Shell input buffer is full; additional input was not retained.",
              "warning",
            );
        }
        return;
      }
      pendingInputRef.current.push(chunk);
      pendingInputCharsRef.current += chunk.length;
    },
    [sessionId],
  );

  useRoutedEscapeClaim(
    (focused || restoreFocusRequested || matchingFocusRequest !== undefined) &&
      executionId.length > 0,
    () => {
      const terminal = terminalRef.current;
      if (terminal) terminal.input("\x1b", true);
      else queuePendingInput("\x1b");
    },
  );

  useLayoutEffect(() => {
    if (pendingInputIdentityRef.current === shellIdentity) return;
    pendingInputIdentityRef.current = shellIdentity;
    pendingInputRef.current = [];
    pendingInputCharsRef.current = 0;
    pendingInputWarningRef.current = false;
    reconstructionReadyKeyRef.current = "";
    inputEnabledRef.current = false;
    setAcknowledgedReconstructionKey("");
  }, [shellIdentity]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = buildXtermTheme(getTheme(activeColorScheme));
    }
  }, [activeColorScheme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the persisted fraction is the trigger; re-run the current sizer only
  useEffect(() => {
    syncSizeRef.current?.();
  }, [customPanelHeightFraction]);

  useEffect(() => {
    const applyFallbackHeight = (fraction: number): void => {
      containerRef.current
        ?.closest<HTMLElement>(".shell-terminal")
        ?.style.setProperty("--shell-terminal-fallback-height", `${fraction * 100}%`);
    };
    const onResize = (event: Event): void => {
      const { fraction } = (event as CustomEvent<{ fraction: number }>).detail;
      dragFractionRef.current = fraction;
      // The reconstruction overlay can be visible before xterm and its JS
      // sizer exist. Keep that pre-ACK surface attached to the pointer too,
      // rather than applying the drag only after authority recovers.
      applyFallbackHeight(fraction);
      syncSizeRef.current?.();
    };
    const onReset = (): void => {
      dragFractionRef.current = null;
      applyFallbackHeight(DEFAULT_HEIGHT_FRACTION);
      syncSizeRef.current?.();
    };
    window.addEventListener("pivis:custom-panel-resize", onResize);
    window.addEventListener("pivis:custom-panel-resize-reset", onReset);
    return () => {
      window.removeEventListener("pivis:custom-panel-resize", onResize);
      window.removeEventListener("pivis:custom-panel-resize-reset", onReset);
    };
  }, []);

  useEffect(() => {
    if (
      !needsFreshAttach ||
      !presentationHostInstanceId ||
      presentationSessionEpoch === undefined
    ) {
      return;
    }
    // A healthy React remount still needs a new PTY reconstruction fence;
    // authority-gap repair already needs an attach and must not bypass the
    // coordinator's ordinary needs-baseline check. Both cases share App's
    // one single-flight request, so one response is installed exactly once.
    void requestAttach(sessionId, !authorityFenced);
  }, [
    authorityFenced,
    needsFreshAttach,
    presentationHostInstanceId,
    presentationSessionEpoch,
    requestAttach,
    sessionId,
  ]);

  // Rebuild for a new owner/execution or a refreshed reconstruction base.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the captured chunk tail is atomic with the keyed reconstruction base
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (
      !container ||
      !presentationHostInstanceId ||
      presentationSessionEpoch === undefined ||
      !executionId ||
      !reconstructionKey ||
      reconstructionFenceToken === undefined ||
      !reconstructionIsFresh ||
      presentation?.authoritative !== true
    ) {
      return;
    }
    const settings = useSettingsStore.getState().settings;
    const terminal = new Terminal({
      ...basePanelTerminalOptions(),
      scrollback: SHELL_SCROLLBACK_ROWS,
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: settings.fonts?.code?.sizePx ?? 14,
      fontFamily: monoFont(),
      theme: buildXtermTheme(getTheme(useSettingsStore.getState().activeColorScheme)),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    terminalIdentityRef.current = reconstructionKey;
    setScrolledAway(false);
    const reconstructionSequence =
      data?.terminalReconstructionSequence ?? data?.terminalOutputSequence ?? 0;
    const outputSequence = data?.terminalOutputSequence ?? reconstructionSequence;
    const initialReplay = shellReplayPlan(
      data?.terminalOutputChunks ?? [],
      reconstructionSequence,
      outputSequence,
    );
    renderedOutputSequenceRef.current = outputSequence;
    outputGapWarningSequenceRef.current = null;
    inputSequenceRef.current = data?.inputAcknowledgedThrough ?? 0;
    resizeRevisionRef.current = data?.resizeRevision ?? 0;
    let disposed = false;
    let reconstructionReady = false;
    let inputTail = Promise.resolve();
    let measuredSize = { cols: terminal.cols, rows: terminal.rows };
    let pendingResize: { cols: number; rows: number } | undefined;
    let resizeInFlight = false;
    let retriedRejectedResize = false;
    const requestFreshAuthority = (): void => {
      void requestAttach(sessionId, true).catch((error) => {
        if (!disposed) {
          useSessionsStore.getState().addToast(sessionId, String(error), "error");
        }
      });
    };
    const flushResize = async (): Promise<void> => {
      if (
        resizeInFlight ||
        disposed ||
        !reconstructionReady ||
        !controlReadyRef.current ||
        !pendingResize
      ) {
        return;
      }
      resizeInFlight = true;
      try {
        while (!disposed && reconstructionReady && controlReadyRef.current && pendingResize) {
          const requested: { cols: number; rows: number } = pendingResize;
          pendingResize = undefined;
          let result: { accepted: boolean };
          try {
            result = await window.pivis.invoke("session.shellResize", {
              sessionId,
              expectedHostInstanceId: presentationHostInstanceId,
              expectedSessionEpoch: presentationSessionEpoch,
              executionId,
              revision: ++resizeRevisionRef.current,
              cols: requested.cols,
              rows: requested.rows,
            });
          } catch {
            requestFreshAuthority();
            return;
          }
          if (disposed) return;
          if (!result.accepted) {
            // A delayed authority snapshot can carry the predecessor's resize
            // revision. Retry the newest desired grid once with a fresh
            // revision; a second rejection means ownership changed or input
            // was fenced, so reconstruct instead of spinning.
            if (!retriedRejectedResize && controlReadyRef.current) {
              retriedRejectedResize = true;
              pendingResize ??= requested;
              continue;
            }
            requestFreshAuthority();
            return;
          }
          retriedRejectedResize = false;
        }
      } finally {
        resizeInFlight = false;
        if (!disposed && reconstructionReady && controlReadyRef.current && pendingResize) {
          queueMicrotask(() => void flushResize());
        }
      }
    };
    const reportSize = (cols: number, rows: number): void => {
      measuredSize = { cols, rows };
      if (!reconstructionReady || !controlReadyRef.current) return;
      pendingResize = { cols, rows };
      void flushResize();
    };
    const viewport = container.parentElement;
    if (!viewport) {
      terminal.dispose();
      terminalRef.current = null;
      terminalIdentityRef.current = "";
      return;
    }
    const sessionElement = container.closest(".app__session") as HTMLElement | null;
    const sizer = createPanelSizer({
      term: terminal,
      container,
      panelEl: viewport,
      sessionEl: sessionElement,
      fitAddon: fit,
      getMode: () => "viewport",
      getHeightFraction: () => fractionGetterRef.current(),
      minimumRows: 2,
      maximumRows: 200,
      minimumCols: 20,
      maximumCols: 500,
      fallbackFontSize: settings.fonts?.code?.sizePx ?? 14,
      onReportSize: reportSize,
    });
    syncSizeRef.current = sizer.scheduleSync;
    // Apply a deterministic viewport before reconstruction can acknowledge.
    // `reportSize` caches this pre-ACK grid; the accepted ACK publishes the
    // same pair exactly once before later size changes flow normally.
    sizer.sync();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => sizer.scheduleSync());
    if (sessionElement) observer?.observe(sessionElement);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!disposed) sizer.sync();
      });
    });
    const focus = (): void => terminal.focus();
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    container.addEventListener("mousedown", focus);
    terminal.textarea?.addEventListener("focus", onFocus);
    terminal.textarea?.addEventListener("blur", onBlur);

    const updatePresentation = (): void => {
      if (disposed) return;
      setScrolledAway(shellViewportIsUnpinned(terminal.buffer.active));
    };
    const parsed = terminal.onWriteParsed(updatePresentation);
    const scrolled = terminal.onScroll(updatePresentation);
    updatePresentation();

    terminal.attachCustomKeyEventHandler((event) => {
      if (isShellCopyShortcut(event)) {
        if (terminal.hasSelection()) {
          void window.pivis.invoke("clipboard.writeText", { text: terminal.getSelection() });
        }
        return false;
      }
      return true;
    });
    const dispatchInput = (chunk: string): void => {
      inputTail = inputTail
        .then(async () => {
          if (disposed || !inputEnabledRef.current || !controlReadyRef.current) {
            queuePendingInput(chunk);
            return;
          }
          const sequence = ++inputSequenceRef.current;
          const result = await window.pivis.invoke("session.shellInput", {
            sessionId,
            expectedHostInstanceId: presentationHostInstanceId,
            expectedSessionEpoch: presentationSessionEpoch,
            executionId,
            sequence,
            data: chunk,
          });
          if (disposed) return;
          if (!result.accepted && result.acknowledgedThrough < sequence) {
            // This exact chunk was not accepted. Reuse its unacknowledged
            // sequence for the next *new* chunk; never replay this input.
            inputSequenceRef.current = result.acknowledgedThrough;
            const detail = result.gap
              ? ` (expected ${result.gap.expected}, received ${result.gap.received})`
              : "";
            useSessionsStore
              .getState()
              .addToast(
                sessionId,
                `Shell input was not sent; synchronization is pending${detail}.`,
                "warning",
              );
          } else {
            // An accepted input or rejected duplicate advances to the host's
            // acknowledgement without resending the original bytes.
            inputSequenceRef.current = Math.max(
              inputSequenceRef.current,
              result.acknowledgedThrough,
            );
          }
        })
        .catch((error) => {
          if (!disposed) {
            useSessionsStore.getState().addToast(sessionId, String(error), "error");
          }
        });
    };
    const input = terminal.onData((chunk) => {
      if (!reconstructionReady || !inputEnabledRef.current || !controlReadyRef.current) {
        queuePendingInput(chunk);
        return;
      }
      dispatchInput(chunk);
    });
    const focusWhenReady = (): void => {
      const store = useSessionsStore.getState();
      const request =
        store.composerFocusRequest?.sessionId === sessionId
          ? store.composerFocusRequest
          : undefined;
      if (request) store.consumeComposerFocus(sessionId, request.nonce);
      const shouldFocus =
        initialFocusOpportunityRef.current ||
        restoreFocusRequestedRef.current ||
        request !== undefined;
      initialFocusOpportunityRef.current = false;
      restoreFocusRequestedRef.current = false;
      setRestoreFocusRequested(false);
      if (
        !shouldFocus ||
        store.activeSessionId !== sessionId ||
        !controlReadyRef.current ||
        !mayFocusShellTerminal(container, request !== undefined)
      ) {
        setFocused(false);
        return;
      }
      terminal.focus();
    };
    const acknowledgeReconstruction = async (): Promise<void> => {
      if (disposed || reconstructionReady) return;
      try {
        const result = await window.pivis.invoke("session.shellReconstructionAck", {
          sessionId,
          expectedHostInstanceId: presentationHostInstanceId,
          expectedSessionEpoch: presentationSessionEpoch,
          executionId,
          reconstructionFenceToken,
          outputThroughSequence:
            data?.terminalReconstructionSequence ?? data?.terminalOutputSequence ?? 0,
        });
        if (!result.accepted) {
          if (!disposed) window.setTimeout(() => void acknowledgeReconstruction(), 100);
          return;
        }
        // Host acceptance consumes this exact fence even if React unmounted
        // while the IPC response was in flight. Persist that renderer-local
        // fact before consulting `disposed` so a later xterm cannot reuse the
        // already-acknowledged keyframe.
        useSessionsStore.getState().acknowledgeShellReconstruction(sessionId, reconstructionKey);
        if (disposed) return;
        reconstructionReady = true;
        reconstructionReadyKeyRef.current = reconstructionKey;
        inputEnabledRef.current = controlReadyRef.current;
        setAcknowledgedReconstructionKey(reconstructionKey);
        reportSize(measuredSize.cols, measuredSize.rows);
        focusWhenReady();
        if (inputEnabledRef.current) {
          const pending = pendingInputRef.current.splice(0);
          pendingInputCharsRef.current = 0;
          pendingInputWarningRef.current = false;
          for (const chunk of pending) dispatchInput(chunk);
        }
      } catch {
        if (!disposed) window.setTimeout(() => void acknowledgeReconstruction(), 100);
      }
    };
    const initialSegments = [
      ...(data?.terminalOutput ? [data.terminalOutput] : []),
      ...initialReplay.chunks.map((chunk) => chunk.data),
    ];
    if (initialSegments.length > 0) {
      initialSegments.forEach((segment, index) => {
        terminal.write(
          segment,
          index === initialSegments.length - 1 ? () => void acknowledgeReconstruction() : undefined,
        );
      });
    } else {
      queueMicrotask(() => void acknowledgeReconstruction());
    }
    if (!initialReplay.contiguous && outputSequence > reconstructionSequence) {
      outputGapWarningSequenceRef.current = outputSequence;
      queueMicrotask(() => {
        if (!disposed) warnShellOutputGap(sessionId);
      });
    }

    return () => {
      disposed = true;
      const hadFocus =
        terminal.textarea !== undefined && document.activeElement === terminal.textarea;
      if (hadFocus) {
        restoreFocusRequestedRef.current = true;
        setRestoreFocusRequested(true);
      }
      if (reconstructionReadyKeyRef.current === reconstructionKey) {
        reconstructionReadyKeyRef.current = "";
      }
      setAcknowledgedReconstructionKey((current) => (current === reconstructionKey ? "" : current));
      inputEnabledRef.current = false;
      input.dispose();
      parsed.dispose();
      scrolled.dispose();
      observer?.disconnect();
      sizer.dispose();
      if (syncSizeRef.current === sizer.scheduleSync) syncSizeRef.current = null;
      container.removeEventListener("mousedown", focus);
      terminal.textarea?.removeEventListener("focus", onFocus);
      terminal.textarea?.removeEventListener("blur", onBlur);
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (terminalIdentityRef.current === reconstructionKey) terminalIdentityRef.current = "";
      setFocused(false);
    };
  }, [
    data?.terminalOutput,
    data?.terminalReconstructionSequence,
    data?.terminalReconstructionRevision,
    executionId,
    presentationHostInstanceId,
    presentationSessionEpoch,
    queuePendingInput,
    reconstructionKey,
    reconstructionFenceToken,
    reconstructionIsFresh,
    requestAttach,
    sessionId,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const outputSequence = data?.terminalOutputSequence ?? renderedOutputSequenceRef.current;
    const replay = shellReplayPlan(
      data?.terminalOutputChunks ?? [],
      renderedOutputSequenceRef.current,
      outputSequence,
    );
    if (outputSequence <= renderedOutputSequenceRef.current) return;

    for (const chunk of replay.chunks) terminal.write(chunk.data);
    if (replay.contiguous) {
      outputGapWarningSequenceRef.current = null;
    } else {
      if (outputGapWarningSequenceRef.current !== outputSequence) {
        outputGapWarningSequenceRef.current = outputSequence;
        warnShellOutputGap(sessionId);
      }
    }

    renderedOutputSequenceRef.current = outputSequence;
  }, [data?.terminalOutputChunks, data?.terminalOutputSequence, sessionId]);

  const returnToLive = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToBottom();
    setScrolledAway(false);
    terminal.focus();
  }, []);

  const excludeFromContext = activity?.excludeFromContext ?? data?.excludeFromContext ?? false;
  const hasControls =
    data?.liveReplayTruncated === true || (scrolledAway && !awaitingFreshReconstruction);
  const fallbackHeightFraction = customPanelHeightFraction ?? DEFAULT_HEIGHT_FRACTION;

  return (
    <section
      className="shell-terminal"
      aria-label={`Active Shell Turn, context ${excludeFromContext ? "excluded" : "included"}`}
      aria-busy={awaitingFreshReconstruction}
      data-execution-id={executionId}
      style={
        {
          "--shell-terminal-fallback-height": `${fallbackHeightFraction * 100}%`,
        } as React.CSSProperties
      }
    >
      <div className="shell-terminal__viewport">
        <div ref={containerRef} className="shell-terminal__xterm" />
        {hasControls && (
          <div className="shell-terminal__controls">
            {data?.liveReplayTruncated && (
              <span
                className="shell-terminal__replay-warning"
                role="status"
                aria-label="Earlier live shell output omitted"
              >
                <IconAlert />
              </span>
            )}
            {scrolledAway && !awaitingFreshReconstruction && (
              <button
                type="button"
                className="icon-btn shell-terminal__control"
                onClick={returnToLive}
                aria-label="Return shell terminal to live output"
              >
                <IconChevronDown />
              </button>
            )}
          </div>
        )}
        {awaitingFreshReconstruction && (
          <div className="shell-terminal__restoring">
            <Spinner role="status" aria-label="Restoring shell terminal" />
          </div>
        )}
      </div>
    </section>
  );
}

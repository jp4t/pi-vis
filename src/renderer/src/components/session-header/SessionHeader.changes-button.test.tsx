// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import type { IntentOutcome, RendererPublication } from "@shared/pi-protocol/runtime-state.js";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "../../stores/diff-store.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import {
  ChangesButton,
  latestSummarizedNavigationKey,
  shouldRefreshSessionStats,
} from "./SessionHeader.js";

const SID = "session-a" as SessionId;
const WORKSPACE = "/tmp/ws";

describe("session stats refresh boundaries", () => {
  it("refreshes for manual compaction as well as agent settlement", () => {
    expect(shouldRefreshSessionStats([{ type: "compaction_end" }])).toBe(true);
    expect(shouldRefreshSessionStats([{ type: "agent_end" }])).toBe(true);
    expect(shouldRefreshSessionStats([{ type: "message_end" }])).toBe(false);
  });

  it("identifies the latest completed navigation that added a branch summary", () => {
    const owner = {
      hostInstanceId: "11111111-1111-4111-8111-111111111111",
      sessionEpoch: 2,
    };
    const outcomes: IntentOutcome[] = [
      {
        intentId: "plain",
        owner,
        kind: "navigate",
        state: "completed",
        result: { targetId: "entry-1" },
      },
      {
        intentId: "summarized",
        owner,
        kind: "navigate",
        state: "completed",
        result: { targetId: "entry-2", summarized: true },
      },
    ];
    expect(latestSummarizedNavigationKey(outcomes)).toBe(`${owner.hostInstanceId}:2:summarized`);
  });
});

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(<ChangesButton sessionId={SID} />)));
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

describe("ChangesButton badge failure presentation", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let publicationListener: ((publication: RendererPublication) => void) | undefined;

  beforeEach(() => {
    invoke = vi.fn(() => Promise.resolve({ kind: "error", message: "git blew up" }));
    publicationListener = undefined;
    (window as unknown as { pivis: unknown }).pivis = {
      invoke,
      on: vi.fn((channel: string, listener: unknown) => {
        if (channel === "session.publication") {
          publicationListener = listener as (publication: RendererPublication) => void;
        }
        return () => {};
      }),
    };
    useSessionsStore.setState({ sessions: new Map(), activeSessionId: SID });
    useSessionsStore.getState().createSession(SID, WORKSPACE, "/tmp/a.jsonl");
    useSessionsStore.getState().setSessionStatus(SID, "ready");
  });

  afterEach(() => {
    (window as unknown as { pivis?: unknown }).pivis = undefined;
    useDiffStore.setState({ badge: null, badgeKind: "loading", open: false });
    document.body.innerHTML = "";
  });

  it("stays visible with an error marker when the badge scan fails, and still opens the viewer", () => {
    act(() => {
      useDiffStore.setState({ badge: null, badgeKind: "error" });
    });
    const view = mount();
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="changes-button"]',
    );
    expect(button).not.toBeNull();
    expect(button?.title).toContain("Couldn't read git changes");
    expect(button?.querySelector(".session-header__changes-error")).not.toBeNull();

    act(() => button?.click());
    expect(useDiffStore.getState().open).toBe(true);
    expect(useDiffStore.getState().sessionId).toBe(SID);
    view.unmount();
  });

  it("refreshes after a tool completion on the authority transcript plane", async () => {
    vi.useFakeTimers();
    const view = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    invoke.mockClear();

    const owner = { hostInstanceId: "host", sessionEpoch: 1 };
    act(() => {
      publicationListener?.({
        sessionId: SID,
        rendererGeneration: 1,
        publicationSequence: 1,
        plane: "transcript",
        owner,
        payload: {
          kind: "delta",
          cursor: { ...owner, transportSequence: 1, snapshotSequence: 1 },
          liveTailCursor: "1",
          entries: [
            {
              type: "tool_execution_end",
              toolCallId: "tool",
              toolName: "write",
              result: {},
              isError: false,
            },
          ],
        },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(invoke).toHaveBeenCalledWith("git.changesCount", { root: WORKSPACE });
    view.unmount();
    vi.useRealTimers();
  });

  it("still hides for a non-repo workspace and while the badge is loading", () => {
    act(() => {
      useDiffStore.setState({ badge: null, badgeKind: "not-a-repo" });
    });
    const nonRepo = mount();
    expect(nonRepo.container.querySelector('[data-testid="changes-button"]')).toBeNull();
    nonRepo.unmount();

    act(() => {
      useDiffStore.setState({ badge: null, badgeKind: "loading" });
    });
    const loading = mount();
    expect(loading.container.querySelector('[data-testid="changes-button"]')).toBeNull();
    loading.unmount();
  });
});

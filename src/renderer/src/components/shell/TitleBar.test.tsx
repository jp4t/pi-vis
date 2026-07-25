// @vitest-environment jsdom
import type { SessionId } from "@shared/ids.js";
import { type ReactElement, act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { TitleBar } from "./TitleBar.js";

vi.mock("../session-header/SessionHeader.js", () => ({
  SessionHeader: ({ sessionId }: { sessionId: SessionId }) => {
    const [modelOpen, setModelOpen] = useState(false);
    return (
      <div data-testid="mock-session-header">
        <span>{sessionId}</span>
        <button type="button" onClick={() => setModelOpen((open) => !open)}>
          Models
        </button>
        {modelOpen && <div data-testid="mock-model-picker">Picker for {sessionId}</div>}
      </div>
    );
  },
}));

function mount(node: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => root.render(node));
  });
  return {
    container,
    unmount: () => {
      act(() => {
        flushSync(() => root.unmount());
      });
      document.body.removeChild(container);
    },
  };
}

describe("TitleBar session boundary", () => {
  afterEach(() => {
    useSessionsStore.setState({ activeSessionId: null });
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("remounts the session header so an open model picker cannot migrate sessions", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const sessionA = "session-a" as SessionId;
    const sessionB = "session-b" as SessionId;
    useSessionsStore.setState({ activeSessionId: sessionA });

    const { container, unmount } = mount(
      <TitleBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />,
    );
    const modelButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="mock-session-header"] button',
    );
    expect(modelButton).toBeTruthy();

    act(() => modelButton?.click());
    expect(container.querySelector('[data-testid="mock-model-picker"]')?.textContent).toBe(
      `Picker for ${sessionA}`,
    );

    act(() => useSessionsStore.setState({ activeSessionId: sessionB }));

    expect(container.querySelector('[data-testid="mock-session-header"] span')?.textContent).toBe(
      sessionB,
    );
    expect(container.querySelector('[data-testid="mock-model-picker"]')).toBeNull();
    unmount();
  });
});

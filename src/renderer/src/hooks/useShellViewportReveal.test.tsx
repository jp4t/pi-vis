// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHELL_VIEWPORT_REVEAL_DELAY_MS,
  shellViewportRevealDelay,
  useShellViewportReveal,
} from "./useShellViewportReveal.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface ProbeProps {
  presentationKey?: string | undefined;
  startedAt?: number | undefined;
}

function Probe({ presentationKey, startedAt }: ProbeProps): React.ReactElement {
  const visible = useShellViewportReveal(presentationKey, startedAt);
  return <div data-visible={String(visible)} />;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useShellViewportReveal", () => {
  it("reveals a new execution only after 200 ms and cancels reveal on settlement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(<Probe presentationKey="shell-a" startedAt={Date.now()} />));
    expect(container.firstElementChild?.getAttribute("data-visible")).toBe("false");

    act(() => vi.advanceTimersByTime(SHELL_VIEWPORT_REVEAL_DELAY_MS - 1));
    expect(container.firstElementChild?.getAttribute("data-visible")).toBe("false");

    act(() => root.render(<Probe />));
    act(() => vi.advanceTimersByTime(1));
    expect(container.firstElementChild?.getAttribute("data-visible")).toBe("false");

    act(() => root.unmount());
  });

  it("reveals a still-running execution at the threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(<Probe presentationKey="shell-a" startedAt={Date.now()} />));
    act(() => vi.advanceTimersByTime(SHELL_VIEWPORT_REVEAL_DELAY_MS));

    expect(container.firstElementChild?.getAttribute("data-visible")).toBe("true");
    act(() => root.unmount());
  });

  it("shows an older running execution immediately on return or recovery", () => {
    expect(shellViewportRevealDelay(1_000, 1_200)).toBe(0);
    expect(shellViewportRevealDelay(undefined, 1_200)).toBe(SHELL_VIEWPORT_REVEAL_DELAY_MS);

    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        <Probe presentationKey="shell-a" startedAt={Date.now() - SHELL_VIEWPORT_REVEAL_DELAY_MS} />,
      ),
    );

    expect(container.firstElementChild?.getAttribute("data-visible")).toBe("true");
    act(() => root.unmount());
  });
});

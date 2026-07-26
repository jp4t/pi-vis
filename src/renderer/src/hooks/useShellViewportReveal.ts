import { useEffect, useState } from "react";

export const SHELL_VIEWPORT_REVEAL_DELAY_MS = 200;

export function shellViewportRevealDelay(startedAt: number | undefined, now = Date.now()): number {
  if (startedAt === undefined || !Number.isFinite(startedAt)) {
    return SHELL_VIEWPORT_REVEAL_DELAY_MS;
  }
  return Math.max(0, SHELL_VIEWPORT_REVEAL_DELAY_MS - Math.max(0, now - startedAt));
}

/**
 * Delay only the live terminal presentation. The PTY and its replay buffer
 * start immediately, so mounting after the grace period still reconstructs
 * output from byte one.
 */
export function useShellViewportReveal(
  presentationKey: string | undefined,
  startedAt: number | undefined,
): boolean {
  const [revealedKey, setRevealedKey] = useState<string>();
  const remainingDelay = presentationKey
    ? shellViewportRevealDelay(startedAt)
    : SHELL_VIEWPORT_REVEAL_DELAY_MS;

  useEffect(() => {
    if (!presentationKey) {
      setRevealedKey(undefined);
      return;
    }
    if (remainingDelay === 0) {
      setRevealedKey(presentationKey);
      return;
    }
    setRevealedKey(undefined);
    const timer = window.setTimeout(() => setRevealedKey(presentationKey), remainingDelay);
    return () => window.clearTimeout(timer);
  }, [presentationKey, remainingDelay]);

  // An already-running execution (session return or renderer recovery) is
  // visible in the first render instead of briefly exposing the Composer.
  return presentationKey !== undefined && (remainingDelay === 0 || revealedKey === presentationKey);
}

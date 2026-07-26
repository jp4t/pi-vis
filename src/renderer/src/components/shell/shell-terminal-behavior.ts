interface ShellViewportPosition {
  baseY: number;
  viewportY: number;
}

interface ShellCopyKey {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

interface SequencedShellChunk {
  sequence: number;
  data: string;
  truncated?: boolean | undefined;
}

/** True only when xterm's viewport is above its current bottom page. */
export function shellViewportIsUnpinned(buffer: ShellViewportPosition): boolean {
  return buffer.viewportY < buffer.baseY;
}

/** Copy shortcuts owned by the terminal UI rather than the child process. */
export function isShellCopyShortcut(event: ShellCopyKey): boolean {
  if (event.type !== "keydown" || event.key.toLowerCase() !== "c") return false;
  return event.metaKey || (event.ctrlKey && event.shiftKey);
}

export function shellReplayPlan(
  chunks: readonly SequencedShellChunk[],
  afterSequence: number,
  throughSequence: number,
): { chunks: readonly SequencedShellChunk[]; contiguous: boolean } {
  const pending = chunks.filter((chunk) => chunk.sequence > afterSequence);
  if (throughSequence <= afterSequence) return { chunks: [], contiguous: true };
  let expected = afterSequence + 1;
  const contiguous =
    pending.length > 0 &&
    pending.every((chunk) => {
      const matches = !chunk.truncated && chunk.sequence === expected;
      expected = chunk.sequence + 1;
      return matches;
    }) &&
    pending.at(-1)?.sequence === throughSequence;
  return { chunks: pending, contiguous };
}

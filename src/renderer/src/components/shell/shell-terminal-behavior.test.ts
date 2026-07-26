import { describe, expect, it } from "vitest";
import {
  isShellCopyShortcut,
  shellReplayPlan,
  shellViewportIsUnpinned,
} from "./shell-terminal-behavior.js";

describe("shell terminal presentation behavior", () => {
  it.each([
    [{ baseY: 0, viewportY: 0 }, false],
    [{ baseY: 9, viewportY: 9 }, false],
    [{ baseY: 9, viewportY: 8 }, true],
    [{ baseY: 40, viewportY: 0 }, true],
  ])("detects whether the viewport is unpinned for %o", (buffer, expected) => {
    expect(shellViewportIsUnpinned(buffer)).toBe(expected);
  });

  it.each([
    [{ type: "keydown", key: "c", metaKey: true, ctrlKey: false, shiftKey: false }, true],
    [{ type: "keydown", key: "C", metaKey: false, ctrlKey: true, shiftKey: true }, true],
    [{ type: "keydown", key: "c", metaKey: false, ctrlKey: true, shiftKey: false }, false],
    [{ type: "keydown", key: "v", metaKey: false, ctrlKey: true, shiftKey: true }, false],
    [{ type: "keyup", key: "c", metaKey: true, ctrlKey: false, shiftKey: false }, false],
  ])("classifies terminal copy shortcut %o", (event, expected) => {
    expect(isShellCopyShortcut(event)).toBe(expected);
  });

  it("plans every retained chunk after a rendered sequence", () => {
    expect(
      shellReplayPlan(
        [
          { sequence: 4, data: "old" },
          { sequence: 5, data: "\u001b[31mred" },
          { sequence: 6, data: "\u001b[0m" },
        ],
        4,
        6,
      ),
    ).toEqual({
      chunks: [
        { sequence: 5, data: "\u001b[31mred" },
        { sequence: 6, data: "\u001b[0m" },
      ],
      contiguous: true,
    });
  });

  it.each([
    [[{ sequence: 6, data: "late" }], 4, 6],
    [
      [
        { sequence: 5, data: "partial", truncated: true },
        { sequence: 6, data: "tail" },
      ],
      4,
      6,
    ],
    [[{ sequence: 5, data: "not-through" }], 4, 6],
  ])("marks an incomplete retained chunk range as non-contiguous", (chunks, after, through) => {
    expect(shellReplayPlan(chunks, after, through).contiguous).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { classifyShellDraft } from "./shell-draft.js";

describe("classifyShellDraft", () => {
  it.each(["", "ls", "hello !there", " !ls", "\t!!pwd"])(
    "keeps %j as ordinary input when the prefix is not at position zero",
    (rawText) => {
      expect(classifyShellDraft(rawText)).toEqual({ kind: "ordinary" });
    },
  );

  it("classifies an editable context-included prefix", () => {
    expect(classifyShellDraft("!ls -la")).toEqual({
      kind: "shell",
      prefix: "!",
      commandText: "ls -la",
      excludeFromContext: false,
      runnable: true,
    });
  });

  it("classifies an editable context-excluded prefix", () => {
    expect(classifyShellDraft("!!npm test")).toEqual({
      kind: "shell",
      prefix: "!!",
      commandText: "npm test",
      excludeFromContext: true,
      runnable: true,
    });
  });

  it("preserves the third exclamation mark as command text", () => {
    expect(classifyShellDraft("!!!foo")).toEqual({
      kind: "shell",
      prefix: "!!",
      commandText: "!foo",
      excludeFromContext: true,
      runnable: true,
    });
  });

  it.each([
    ["!", "!", false],
    ["!!", "!!", true],
    ["!   \t", "!", false],
    ["!!\n  ", "!!", true],
  ] as const)(
    "keeps incomplete draft %j in shell interpretation",
    (rawText, prefix, excludeFromContext) => {
      expect(classifyShellDraft(rawText)).toMatchObject({
        kind: "shell",
        prefix,
        excludeFromContext,
        runnable: false,
      });
    },
  );

  it("preserves multiline command text without normalizing editor contents", () => {
    expect(classifyShellDraft("!printf one\nprintf two")).toMatchObject({
      kind: "shell",
      commandText: "printf one\nprintf two",
      runnable: true,
    });
  });
});

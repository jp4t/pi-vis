/**
 * Shell-draft interpretation derived only from the current raw editor text.
 *
 * The prefix remains part of the editable value. Consumers must not persist a
 * separate shell-mode flag: ordinary editing (including undo, paste, and
 * inserting text before the prefix) is the complete mode-transition model.
 */
export type ShellDraft =
  | { kind: "ordinary" }
  | {
      kind: "shell";
      prefix: "!" | "!!";
      commandText: string;
      excludeFromContext: boolean;
      runnable: boolean;
    };

export function classifyShellDraft(rawText: string): ShellDraft {
  if (!rawText.startsWith("!")) return { kind: "ordinary" };

  const excludeFromContext = rawText.startsWith("!!");
  const prefix = excludeFromContext ? "!!" : "!";
  const commandText = rawText.slice(prefix.length);

  return {
    kind: "shell",
    prefix,
    commandText,
    excludeFromContext,
    runnable: commandText.trim().length > 0,
  };
}

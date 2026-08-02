// @vitest-environment jsdom
import type { GitChangedFile } from "@shared/git.js";
import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ThemedToken } from "shiki";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiffModel } from "../../lib/diff/diff-model.js";
import type { FileState } from "../../stores/diff-store.js";
import { useDiffStore } from "../../stores/diff-store.js";
import { DiffFileSection } from "./DiffFileSection.js";

const SID = "diff-highlight-test" as SessionId;
const FILE: GitChangedFile = {
  path: "example.ts",
  status: "M",
  untracked: false,
  insertions: 1,
  deletions: 1,
  binary: false,
};

function token(content: string, color: string): ThemedToken {
  return { content, color, offset: 0 };
}

function mount(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  return {
    container,
    unmount: () => {
      act(() => flushSync(() => root.unmount()));
      container.remove();
    },
  };
}

describe("DiffFileSection syntax highlighting", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders Shiki tokens on unified context lines", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    useDiffStore.setState({
      search: { open: false, query: "", caseSensitive: false, activeMatch: null },
      commitRange: null,
      editSession: null,
    });

    const oldText = "const stable = true;\nconst value = 1;\n";
    const newText = "const stable = true;\nconst value = 2;\n";
    const model = buildDiffModel(oldText, newText);
    expect(model.kind).toBe("ok");
    if (model.kind !== "ok") throw new Error("expected diff model");

    const contextColor = "#123456";
    const state: FileState = {
      status: "ready",
      model,
      gapState: model.gaps.map(() => ({ top: 0, bottom: 0 })),
      oldTokens: [
        [token("const stable = true;", contextColor)],
        [token("const value = 1;", "#654321")],
      ],
      newTokens: [
        [token("const stable = true;", contextColor)],
        [token("const value = 2;", "#abcdef")],
      ],
      oldText,
      newText,
      collapsed: false,
    };

    const view = mount(
      <DiffFileSection
        sessionId={SID}
        file={FILE}
        state={state}
        viewMode="unified"
        narrowWindow={false}
        active={false}
        sectionRef={() => {}}
      />,
    );

    const contextCode = view.container.querySelector<HTMLElement>(
      ".diff-row:not(.diff-row--add):not(.diff-row--del) .diff-row__code",
    );
    expect(contextCode?.textContent).toBe("const stable = true;");
    expect(contextCode?.querySelector<HTMLElement>("span")?.style.color).toBe("rgb(18, 52, 86)");

    view.unmount();
  });
});

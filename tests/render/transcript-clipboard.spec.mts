import { expect, test } from "@playwright/test";

test("transcript copy preserves user newlines and standalone fenced code", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer")).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    type PreviewState = {
      activeSessionId: string;
      seedHistory: (sessionId: string, history: Array<Record<string, unknown>>) => void;
    };
    const state = (
      window as unknown as { __pivisStore: { getState: () => PreviewState } }
    ).__pivisStore.getState();
    state.seedHistory(state.activeSessionId, [
      {
        id: "clipboard-user",
        type: "user",
        data: { content: "first line\nsecond line\n\nfourth line" },
      },
      {
        id: "clipboard-assistant",
        type: "assistant",
        data: {
          segments: [
            {
              kind: "text",
              content: "```typescript\nconst first = 1;\nconst second = 2;\n```",
            },
          ],
          isStreaming: false,
        },
      },
    ]);
  });

  const copySelection = async (selector: string): Promise<string> =>
    page.evaluate((targetSelector) => {
      const target = document.querySelector(targetSelector);
      if (!target) throw new Error(`Missing copy target: ${targetSelector}`);
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const clipboard = new DataTransfer();
      target.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
      selection?.removeAllRanges();
      return clipboard.getData("text/plain");
    }, selector);

  await expect(page.locator(".transcript-block--user .transcript-block__content")).toBeVisible();
  expect(await copySelection(".transcript-block--user .transcript-block__content")).toBe(
    "first line\nsecond line\n\nfourth line",
  );

  await expect(page.locator(".code-block[data-language='typescript']")).toBeVisible();
  expect(await copySelection(".code-block[data-language='typescript'] code")).toBe(
    "```typescript\nconst first = 1;\nconst second = 2;\n```",
  );
});

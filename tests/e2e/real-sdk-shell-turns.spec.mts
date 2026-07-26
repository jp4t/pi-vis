import { expect, test } from "./support/invariants.mjs";
import {
  type RealSdkFixture,
  type RealSdkLaunch,
  createRealSdkFixture,
  openNewRealSession,
  parseSessionEntries,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import {
  type ScriptedOpenAIProvider,
  createScriptedOpenAIProvider,
} from "./support/scripted-openai-provider.mjs";

async function closeFixture(
  launch: RealSdkLaunch | undefined,
  fixture: RealSdkFixture,
  provider: ScriptedOpenAIProvider,
): Promise<void> {
  await launch?.close();
  await provider.close();
  fixture.cleanup();
}

test.describe("Pinned real Pi Shell Turns", () => {
  test("native PTY output persists once and only included Bash context reaches the provider", async () => {
    test.setTimeout(180_000);
    const included = "PIVIS_INCLUDED_SHELL_RESULT_7E0C";
    const excluded = "PIVIS_EXCLUDED_SHELL_RESULT_9A31";
    const provider = await createScriptedOpenAIProvider([
      {
        expect: {
          promptIncludes: ["Explain the included shell result.", included],
          compaction: false,
        },
        response: { type: "text", chunks: ["included shell context received"] },
      },
    ]);
    const fixture = createRealSdkFixture({ providerBaseUrl: provider.baseUrl });
    let launch: RealSdkLaunch | undefined;

    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);

      await textarea.fill(`!printf '${included}\\n'`);
      await textarea.press("Enter");
      const includedTurn = window.locator(".shell-turn").filter({ hasText: included });
      await expect(includedTurn).toHaveCount(1, { timeout: 30_000 });
      await expect(includedTurn.locator(".shell-turn__prefix")).toHaveText("!");
      await expect(includedTurn).toHaveAccessibleName(/context included/);
      await expect(includedTurn).not.toContainText("Context included");

      await textarea.fill(`!!printf '${excluded}\\n'`);
      await textarea.press("Enter");
      const excludedTurn = window.locator(".shell-turn").filter({ hasText: excluded });
      await expect(excludedTurn).toHaveCount(1, { timeout: 30_000 });
      await expect(excludedTurn.locator(".shell-turn__prefix")).toHaveText("!!");
      await expect(excludedTurn).toHaveAccessibleName(/context excluded/);
      await expect(excludedTurn).not.toContainText("Context excluded");
      expect(provider.requests).toHaveLength(0);

      await textarea.fill("Explain the included shell result.");
      await textarea.press("Enter");
      await provider.waitForRequestCount(1);
      await expect(
        window.getByText("included shell context received", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      const providerBody = JSON.stringify(provider.requests[0]?.parsedBody);
      expect(providerBody).toContain(included);
      expect(providerBody).not.toContain(excluded);
      provider.assertExhausted();
      expect(provider.unexpectedRequests).toEqual([]);

      await expect.poll(() => fixture.sessionFiles().length).toBeGreaterThan(0);
      const entries = fixture.sessionFiles().flatMap(parseSessionEntries);
      const bashMessages = entries.flatMap((entry) => {
        const message = entry["message"];
        return message &&
          typeof message === "object" &&
          (message as Record<string, unknown>)["role"] === "bashExecution"
          ? [message as Record<string, unknown>]
          : [];
      });
      const includedMessage = bashMessages.find(
        (message) => message["command"] === `printf '${included}\\n'`,
      );
      const excludedMessage = bashMessages.find(
        (message) => message["command"] === `printf '${excluded}\\n'`,
      );
      expect(includedMessage).toMatchObject({
        output: expect.stringContaining(included),
      });
      expect(includedMessage?.["excludeFromContext"]).not.toBe(true);
      expect(excludedMessage).toMatchObject({
        output: expect.stringContaining(excluded),
        excludeFromContext: true,
      });
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}\nProvider requests:\n${JSON.stringify(provider.requests, null, 2)}`,
      );
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });
});

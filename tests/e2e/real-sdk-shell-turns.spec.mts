import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_BASH_EXTENSION = join(
  __dirname,
  "../fixtures/real-host-user-bash-extension/user-bash-e2e.ts",
);
const USER_BASH_RESULT_COMMAND = "pivis-e2e-user-bash-result";
const USER_BASH_OPERATIONS_COMMAND = "pivis-e2e-user-bash-operations";
const USER_BASH_RESULT_SENTINEL = "PIVIS_USER_BASH_RESULT_083";
const USER_BASH_OPERATIONS_FIRST = "PIVIS_USER_BASH_OPERATIONS_FIRST_083";
const USER_BASH_OPERATIONS_SECOND = "PIVIS_USER_BASH_OPERATIONS_SECOND_083";
const USER_BASH_OPERATIONS_RELEASE = ".pivis-user-bash-operations-release";

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
  test("Pi 0.83 user_bash result and operations handlers produce one non-PTY Shell Turn each", async () => {
    test.setTimeout(120_000);
    const fixtureSeed = "Create the persisted shell-turn fixture.";
    const persistencePrompt = "Persist the extension-handled Shell Turns.";
    const provider = await createScriptedOpenAIProvider([
      {
        expect: { promptIncludes: fixtureSeed, compaction: false },
        response: { type: "text", chunks: ["shell-turn fixture ready"] },
      },
      {
        expect: { promptIncludes: persistencePrompt, compaction: false },
        response: { type: "text", chunks: ["extension shell turns persisted"] },
      },
    ]);
    const fixture = createRealSdkFixture({
      extensionFiles: [USER_BASH_EXTENSION],
      providerBaseUrl: provider.baseUrl,
    });
    let launch: RealSdkLaunch | undefined;

    try {
      launch = await fixture.launch();
      const { window } = launch;
      const textarea = await openNewRealSession(window);
      await selectLocalTestModel(window, textarea);

      // Renderer reload intentionally boots into a fresh composer. Seed a
      // durable Pi session first so the active host can be selected again and
      // exercise its authority-attach reconstruction after the reload.
      await textarea.fill(fixtureSeed);
      await textarea.press("Enter");
      await expect(window.getByText("shell-turn fixture ready", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => fixture.sessionFiles().length).toBeGreaterThan(0);

      await textarea.fill(`!!${USER_BASH_RESULT_COMMAND}`);
      await textarea.press("Enter");
      const resultTurn = window
        .locator(".shell-turn")
        .filter({ hasText: USER_BASH_RESULT_SENTINEL });
      await expect(resultTurn).toHaveCount(1, { timeout: 30_000 });
      await expect(resultTurn).toContainText("hook-count=1 excluded=true");
      await expect(resultTurn.locator(".shell-turn__prefix")).toHaveText("!!");

      await textarea.fill(`!${USER_BASH_OPERATIONS_COMMAND}`);
      await textarea.press("Enter");
      const operationsTurn = window
        .locator(".shell-turn")
        .filter({ hasText: USER_BASH_OPERATIONS_FIRST });
      await expect(operationsTurn).toHaveCount(1, { timeout: 30_000 });
      await expect(operationsTurn).toContainText("hook-count=1");
      await window.reload({ waitUntil: "domcontentloaded" });
      const storedSessions = window.locator(".sidebar__session:not(.sidebar__session--active)");
      await expect(storedSessions.first()).toBeVisible({ timeout: 30_000 });
      const matchingSession = storedSessions.filter({ hasText: fixtureSeed });
      await ((await matchingSession.count()) > 0
        ? matchingSession.first()
        : storedSessions.first()
      ).click();
      await expect(operationsTurn).toHaveCount(1, { timeout: 30_000 });
      await expect(operationsTurn).toContainText(USER_BASH_OPERATIONS_FIRST);
      await expect(operationsTurn).toContainText("hook-count=1");
      await expect
        .poll(async () => {
          const text = (await operationsTurn.textContent()) ?? "";
          return text.split(USER_BASH_OPERATIONS_FIRST).length - 1;
        })
        .toBe(1);
      await expect(operationsTurn).not.toContainText(USER_BASH_OPERATIONS_SECOND);
      await expect(operationsTurn.locator(".shell-turn__status")).toHaveText("running");
      await expect(window.locator(".shell-terminal-host")).toHaveCount(0);

      writeFileSync(join(fixture.dirs.workspace, USER_BASH_OPERATIONS_RELEASE), "release\n");
      await expect(operationsTurn).toContainText(USER_BASH_OPERATIONS_SECOND, {
        timeout: 30_000,
      });
      await expect(operationsTurn.locator(".shell-turn__status")).toHaveText("exit 0");
      await expect
        .poll(async () => {
          const text = (await operationsTurn.textContent()) ?? "";
          return text.split(USER_BASH_OPERATIONS_FIRST).length - 1;
        })
        .toBe(1);
      await expect(operationsTurn.locator(".shell-turn__prefix")).toHaveText("!");
      await expect(window.locator(".shell-terminal-host")).toHaveCount(0);

      await textarea.fill(persistencePrompt);
      await textarea.press("Enter");
      await provider.waitForRequestCount(2);
      await expect(
        window.getByText("extension shell turns persisted", { exact: true }),
      ).toBeVisible({
        timeout: 30_000,
      });
      const providerBody = JSON.stringify(provider.requests[1]?.parsedBody);
      expect(providerBody).toContain(USER_BASH_OPERATIONS_SECOND);
      expect(providerBody).not.toContain(USER_BASH_RESULT_SENTINEL);
      provider.assertExhausted();
      expect(provider.unexpectedRequests).toEqual([]);

      await expect.poll(() => fixture.sessionFiles().length).toBeGreaterThan(0);
      await expect
        .poll(() => {
          const entries = fixture.sessionFiles().flatMap(parseSessionEntries);
          return entries.filter((entry) => {
            const message = entry["message"];
            if (!message || typeof message !== "object") return false;
            const bash = message as Record<string, unknown>;
            return (
              bash["role"] === "bashExecution" &&
              [USER_BASH_RESULT_COMMAND, USER_BASH_OPERATIONS_COMMAND].includes(
                String(bash["command"]),
              )
            );
          }).length;
        })
        .toBe(2);

      const entries = fixture.sessionFiles().flatMap(parseSessionEntries);
      const bashMessages = entries.flatMap((entry) => {
        const message = entry["message"];
        return message &&
          typeof message === "object" &&
          (message as Record<string, unknown>)["role"] === "bashExecution"
          ? [message as Record<string, unknown>]
          : [];
      });
      expect(
        bashMessages.filter((message) => message["command"] === USER_BASH_RESULT_COMMAND),
      ).toEqual([
        expect.objectContaining({
          output: expect.stringContaining(`${USER_BASH_RESULT_SENTINEL} hook-count=1`),
          excludeFromContext: true,
        }),
      ]);
      expect(
        bashMessages.filter((message) => message["command"] === USER_BASH_OPERATIONS_COMMAND),
      ).toEqual([
        expect.objectContaining({
          output: expect.stringContaining(USER_BASH_OPERATIONS_SECOND),
        }),
      ]);
      const starts = entries.filter(
        (entry) => entry["type"] === "custom" && entry["customType"] === "pivis.shell_turn_start",
      );
      for (const command of [USER_BASH_RESULT_COMMAND, USER_BASH_OPERATIONS_COMMAND]) {
        expect(
          starts.filter((entry) => {
            const data = entry["data"];
            return (
              data &&
              typeof data === "object" &&
              (data as Record<string, unknown>)["command"] === command &&
              (data as Record<string, unknown>)["pty"] === false
            );
          }),
        ).toHaveLength(1);
      }
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}`,
      );
    } finally {
      await closeFixture(launch, fixture, provider);
    }
  });

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

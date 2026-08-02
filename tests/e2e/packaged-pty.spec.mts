import { expect, test } from "./support/invariants.mjs";
import {
  PINNED_PI_VERSION,
  type RealSdkFixture,
  type RealSdkLaunch,
  createRealSdkFixture,
  openNewRealSession,
} from "./support/real-sdk-host.mjs";

const packagedExecutable = process.env.PIVIS_PACKAGED_EXECUTABLE;

test.describe("packaged macOS PTY", () => {
  test.skip(!packagedExecutable, "runs only from scripts/verify-packaged-pty.mjs");

  test("spawns main pty.start and executes a real SDK-host Shell Turn", async () => {
    test.setTimeout(120_000);
    const fixture: RealSdkFixture = createRealSdkFixture({
      executablePath: packagedExecutable!,
      packagedHostExecPath: process.execPath,
    });
    let launch: RealSdkLaunch | undefined;
    const nonce = `PIVIS_PACKAGED_SHELL_${process.pid}_${Date.now()}`;

    try {
      launch = await fixture.launch();
      const { window } = launch;
      await expect(
        window.evaluate(() => window.pivis.invoke("pi.info", undefined)),
      ).resolves.toEqual({ version: PINNED_PI_VERSION });

      // This invokes src/main/pty.ts from Electron's logical app.asar path. A
      // successful return means node-pty loaded and spawn-helper created Pi's
      // PTY; resize and kill also prove the returned process is registered.
      const mainPtyId = await window.evaluate(async (cwd) => {
        const { ptyId } = await window.pivis.invoke("pty.start", {
          cwd,
          cols: 64,
          rows: 10,
        });
        await window.pivis.invoke("pty.resize", { ptyId, cols: 72, rows: 12 });
        await window.pivis.invoke("pty.kill", { ptyId });
        return ptyId;
      }, fixture.dirs.workspace);
      expect(mainPtyId).toMatch(/^pty-\d+$/u);

      // This takes the user-visible Shell Turn path through the final app,
      // main IPC, the packaged plain-Node SDK host, Pi, and shell-pty.mjs.
      const textarea = await openNewRealSession(window);
      await textarea.fill(`!!printf '${nonce}\\n'`);
      await textarea.press("Enter");
      const settled = window.locator(".shell-turn").filter({ hasText: nonce });
      await expect(settled).toHaveAccessibleName("You, Shell, context excluded, exit 0", {
        timeout: 30_000,
      });
      await expect(settled).toContainText(nonce);
    } catch (error) {
      throw new Error(
        `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}`,
      );
    } finally {
      await launch?.close();
      fixture.cleanup();
    }
  });
});

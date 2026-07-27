import { autoUpdater } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.3",
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

import { buildAppUpdateFeedUrl, checkForAppUpdate, initAppUpdates } from "./app-updates.js";

describe("buildAppUpdateFeedUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the update.electronjs.org feed with platform and arch", () => {
    expect(
      buildAppUpdateFeedUrl({
        owner: "rsingapuri",
        repo: "pi-vis",
        platform: "darwin",
        arch: "arm64",
        version: "0.3.3",
      }),
    ).toBe("https://update.electronjs.org/rsingapuri/pi-vis/darwin-arm64/0.3.3");
  });

  it("does not overlap app-updater checks while one is in progress", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("PIVIS_DISABLE_APP_UPDATES", "");
    initAppUpdates(() => {});
    checkForAppUpdate();
    checkForAppUpdate();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  });
});

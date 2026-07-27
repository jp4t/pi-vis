#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { NODE_PTY_PACKAGE, NODE_PTY_VERSION, patchNodePty } from "./patch-node-pty.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const require = createRequire(import.meta.url);

function packagedPaths(appBundle) {
  const resources = path.join(appBundle, "Contents", "Resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const packageDirectory = path.join(
    unpacked,
    "node_modules",
    "@homebridge",
    "node-pty-prebuilt-multiarch",
  );
  return {
    executable: path.join(appBundle, "Contents", "MacOS", "Pi-Vis"),
    asar: path.join(resources, "app.asar"),
    hostScript: path.join(unpacked, "out", "resources", "pi-session-host", "host.mjs"),
    packageDirectory,
    helper: path.join(packageDirectory, "build", "Release", "spawn-helper"),
  };
}

function runPackagedJourney(executable) {
  const playwrightCli = require.resolve("@playwright/test/cli");
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "-c", "tests/e2e/playwright.config.mts", "packaged-pty.spec.mts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PIVIS_E2E_WORKERS: "1",
        PIVIS_PACKAGED_EXECUTABLE: executable,
        PIVIS_TEST_SKIP_FRESHNESS: "1",
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 150_000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Packaged PTY journey exited with status ${result.status}.`);
  }
}

function verifyPackagedApp(appBundle) {
  if (process.platform !== "darwin") {
    throw new Error("The packaged PTY verifier currently supports macOS application bundles only.");
  }
  const paths = packagedPaths(appBundle);
  for (const required of [paths.executable, paths.asar, paths.hostScript, paths.helper]) {
    if (!fs.existsSync(required)) throw new Error(`Missing packaged artifact: ${required}`);
  }
  fs.accessSync(paths.helper, fs.constants.X_OK);
  patchNodePty({ packageDirectory: paths.packageDirectory, verifyOnly: true });
  console.log(
    `[packaged-pty] Verified patched ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION} and executable spawn-helper in ${appBundle}`,
  );

  // The journey launches the completed app. pty.start resolves from Electron's
  // logical app.asar, while a real Shell Turn resolves from the unpacked SDK
  // host running under system Node. Both must actually spawn and settle.
  runPackagedJourney(paths.executable);
}

const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const appBundle = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(projectRoot, `release/${manifest.version}/mac-arm64/Pi-Vis.app`);
verifyPackagedApp(appBundle);

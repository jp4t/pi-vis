#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const NODE_PTY_PACKAGE = "@homebridge/node-pty-prebuilt-multiarch";
export const NODE_PTY_VERSION = "0.14.0";

const require = createRequire(import.meta.url);
const vulnerableBlock = String.raw`helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');`;
const patchedBlock = String.raw`helperPath = helperPath.replace(
  /(^|[\\/])app\.asar(?=[\\/]|$)/,
  '$1app.asar.unpacked',
);
helperPath = helperPath.replace(
  /(^|[\\/])node_modules\.asar(?=[\\/]|$)/,
  '$1node_modules.asar.unpacked',
);`;
const PATCHED_FILES = ["lib/unixTerminal.js", "src/unixTerminal.ts"];

function occurrences(content, value) {
  return content.split(value).length - 1;
}

export function resolveInstalledNodePtyDirectory() {
  let manifest;
  try {
    manifest = require.resolve(`${NODE_PTY_PACKAGE}/package.json`);
  } catch (error) {
    throw new Error(`Cannot resolve ${NODE_PTY_PACKAGE}; run npm ci before building.`, {
      cause: error,
    });
  }
  return path.dirname(manifest);
}

export function patchNodePty({
  packageDirectory = resolveInstalledNodePtyDirectory(),
  verifyOnly = false,
} = {}) {
  const manifestPath = path.join(packageDirectory, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${NODE_PTY_PACKAGE} manifest at ${manifestPath}.`, {
      cause: error,
    });
  }
  if (manifest.name !== NODE_PTY_PACKAGE || manifest.version !== NODE_PTY_VERSION) {
    throw new Error(
      `Refusing to patch ${manifest.name ?? "unknown package"}@${manifest.version ?? "unknown version"}; expected exact ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION}.`,
    );
  }

  let changed = false;
  for (const relativePath of PATCHED_FILES) {
    const target = path.join(packageDirectory, relativePath);
    const content = fs.readFileSync(target, "utf8");
    const vulnerableCount = occurrences(content, vulnerableBlock);
    const patchedCount = occurrences(content, patchedBlock);

    if (patchedCount === 1 && vulnerableCount === 0) continue;
    if (verifyOnly) {
      throw new Error(
        `${NODE_PTY_PACKAGE}/${relativePath} is not the verified Pi-Vis path-safe build. Run npm run patch:node-pty.`,
      );
    }
    if (vulnerableCount !== 1 || patchedCount !== 0) {
      throw new Error(
        `Refusing to patch unexpected ${NODE_PTY_PACKAGE}/${relativePath} contents (vulnerable=${vulnerableCount}, patched=${patchedCount}).`,
      );
    }

    fs.writeFileSync(target, content.replace(vulnerableBlock, patchedBlock));
    changed = true;
  }

  // Re-read in verifier mode so a partial write can never be reported as success.
  if (!verifyOnly) patchNodePty({ packageDirectory, verifyOnly: true });
  return { packageDirectory, changed };
}

function parseArgs(args) {
  if (args.length === 0) return { verifyOnly: false };
  if (args.length === 1 && args[0] === "--verify") return { verifyOnly: true };
  throw new Error("Usage: node scripts/patch-node-pty.mjs [--verify]");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = patchNodePty(parseArgs(process.argv.slice(2)));
    console.log(
      `[node-pty-patch] ${result.changed ? "Patched" : "Verified"} ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION} at ${result.packageDirectory}`,
    );
  } catch (error) {
    console.error(`[node-pty-patch] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

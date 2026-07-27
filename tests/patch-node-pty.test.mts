import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_PTY_PACKAGE, NODE_PTY_VERSION, patchNodePty } from "../scripts/patch-node-pty.mjs";

const vulnerableBlock = `helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');`;
const roots = [];

function fixture({ version = NODE_PTY_VERSION, content = vulnerableBlock } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-node-pty-patch-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: NODE_PTY_PACKAGE, version }),
  );
  for (const file of ["lib/unixTerminal.js", "src/unixTerminal.ts"]) {
    fs.writeFileSync(path.join(root, file), `before\n${content}\nafter\n`);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("node-pty package patch", () => {
  it("makes both packaged helper rewrites component-aware and idempotent", () => {
    const packageDirectory = fixture();

    expect(patchNodePty({ packageDirectory })).toMatchObject({ changed: true });
    expect(patchNodePty({ packageDirectory })).toMatchObject({ changed: false });
    expect(patchNodePty({ packageDirectory, verifyOnly: true })).toMatchObject({
      changed: false,
    });

    for (const file of ["lib/unixTerminal.js", "src/unixTerminal.ts"]) {
      const patched = fs.readFileSync(path.join(packageDirectory, file), "utf8");
      expect(patched).not.toContain(vulnerableBlock);
      expect(patched).toContain("/(^|[\\\\/])app\\.asar(?=[\\\\/]|$)/");
      expect(patched).toContain("/(^|[\\\\/])node_modules\\.asar(?=[\\\\/]|$)/");

      const start = patched.indexOf("helperPath = helperPath.replace(");
      const end = patched.lastIndexOf("\nafter");
      const rewrite = new Function(
        "helperPath",
        `${patched.slice(start, end)}\nreturn helperPath;`,
      );
      expect(rewrite("/App/Resources/app.asar/node_modules.asar/pkg/helper")).toBe(
        "/App/Resources/app.asar.unpacked/node_modules.asar.unpacked/pkg/helper",
      );
      expect(
        rewrite("/App/Resources/app.asar.unpacked/node_modules.asar.unpacked/pkg/helper"),
      ).toBe("/App/Resources/app.asar.unpacked/node_modules.asar.unpacked/pkg/helper");
      expect(rewrite("/App/myapp.asar/node_modules/pkg/helper")).toBe(
        "/App/myapp.asar/node_modules/pkg/helper",
      );
      expect(rewrite(String.raw`C:\App\app.asar\node_modules.asar\pkg\helper`)).toBe(
        String.raw`C:\App\app.asar.unpacked\node_modules.asar.unpacked\pkg\helper`,
      );
    }
  });

  it("rejects verification before the patch is applied", () => {
    const packageDirectory = fixture();
    expect(() => patchNodePty({ packageDirectory, verifyOnly: true })).toThrow(
      "is not the verified Pi-Vis path-safe build",
    );
  });

  it("fails closed on dependency version or source drift", () => {
    const wrongVersion = fixture({ version: "0.14.1" });
    expect(() => patchNodePty({ packageDirectory: wrongVersion })).toThrow(
      `expected exact ${NODE_PTY_PACKAGE}@${NODE_PTY_VERSION}`,
    );

    const drifted = fixture({ content: "helperPath = getHelperSomeOtherWay();" });
    expect(() => patchNodePty({ packageDirectory: drifted })).toThrow(
      "Refusing to patch unexpected",
    );
  });
});

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizePathForMatching,
  normalizePathIntent,
  PERMISSION_MODES,
} from "../../../src/security/index.js";

describe("normalizePathIntent", () => {
  it("classifies a normal child as a workspace path", async () => {
    const workspace = path.resolve("virtual-workspace");
    const target = path.join(workspace, "src", "index.ts");

    const intent = await normalizePathIntent(target, workspace, PERMISSION_MODES.READ, {
      realpath: async (value) => value,
    });

    expect(intent.pathScope).toBe("workspace");
    expect(intent.aliases).toContain(normalizePathForMatching(target));
    expect(intent.folderAliases).toContain(
      normalizePathForMatching(path.dirname(target)),
    );
  });

  it("uses a directory target itself as the folder scope", async () => {
    const workspace = path.resolve("virtual-workspace");
    const directory = path.join(workspace, "src");

    const intent = await normalizePathIntent(
      directory,
      workspace,
      PERMISSION_MODES.READ,
      {
        realpath: async (value) => value,
        targetKind: "directory",
      },
    );

    expect(intent.folderAliases).toEqual([
      normalizePathForMatching(directory),
    ]);
    expect(intent.folderDisplayValue).toBe(directory);
  });

  it("uses canonical paths to detect a symlink escaping the workspace", async () => {
    const workspace = path.resolve("virtual-workspace");
    const target = path.join(workspace, "linked", "secret.txt");
    const external = path.resolve("outside-workspace", "secret.txt");

    const intent = await normalizePathIntent(target, workspace, PERMISSION_MODES.READ, {
      realpath: async (value) => {
        if (path.normalize(value) === path.normalize(target)) {
          return external;
        }
        return value;
      },
    });

    expect(intent.pathScope).toBe("external");
    expect(intent.aliases).toEqual(
      expect.arrayContaining([
        normalizePathForMatching(target),
        normalizePathForMatching(external),
      ]),
    );
  });

  it("canonicalizes a missing write target through its nearest existing ancestor", async () => {
    const workspace = path.resolve("virtual-workspace");
    const target = path.join(workspace, "new", "file.ts");

    const intent = await normalizePathIntent(target, workspace, PERMISSION_MODES.WRITE, {
      realpath: async (value) => {
        if (path.normalize(value) === path.normalize(workspace)) {
          return workspace;
        }

        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    expect(intent.pathScope).toBe("workspace");
    expect(intent.aliases).toContain(normalizePathForMatching(target));
  });
});

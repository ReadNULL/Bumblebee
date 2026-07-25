import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractAccessIntents,
  PERMISSION_MODES,
} from "../../../src/security/index.js";

const cwd = path.resolve("virtual-workspace");
const options = {
  pathNormalizer: {
    realpath: async (value: string) => value,
  },
};

describe("extractAccessIntents", () => {
  it("extracts tool and read-path intents", async () => {
    const intents = await extractAccessIntents(
      { cwd, input: { path: "README.md" }, toolName: "read" },
      options,
    );

    expect(intents.map((intent) => [intent.surface, intent.requiredMode])).toEqual([
      ["tool", PERMISSION_MODES.EXECUTE],
      ["path", PERMISSION_MODES.READ],
    ]);
  });

  it("extracts an exact command intent for bash", async () => {
    const intents = await extractAccessIntents({
      cwd,
      input: { command: "git status" },
      toolName: "bash",
    });

    expect(intents[1]).toMatchObject({
      aliases: ["git status"],
      requiredMode: PERMISSION_MODES.EXECUTE,
      surface: "command",
    });
  });

  it("keeps unknown tools opaque and asks at the tool boundary", async () => {
    const intents = await extractAccessIntents({
      cwd,
      input: { target: "production" },
      toolName: "deploy",
    });

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      displayValue: "deploy",
      requiredMode: PERMISSION_MODES.EXECUTE,
      surface: "tool",
    });
  });

  it("requires both read and write capabilities for edit", async () => {
    const intents = await extractAccessIntents(
      { cwd, input: { path: "src/index.ts" }, toolName: "edit" },
      options,
    );

    expect(intents[1]).toMatchObject({
      requiredMode: PERMISSION_MODES.READ_WRITE,
      surface: "path",
    });
  });

  it("rejects malformed built-in tool input", async () => {
    await expect(
      extractAccessIntents({ cwd, input: {}, toolName: "write" }, options),
    ).rejects.toThrow("Invalid path for write");
    await expect(
      extractAccessIntents({ cwd, input: {}, toolName: "read" }, options),
    ).rejects.toThrow("Invalid path for read");
  });
});

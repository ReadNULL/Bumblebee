import { describe, expect, it } from "vitest";

import {
  evaluatePermissionPolicy,
  fingerprintPermissionValue,
  PERMISSION_MODES,
  type AccessIntent,
  type PermissionRule,
} from "../../../src/security/index.js";

const toolIntent: AccessIntent = {
  aliases: ["write"],
  caseSensitive: true,
  displayValue: "write",
  requiredMode: PERMISSION_MODES.EXECUTE,
  surface: "tool",
};

const pathIntent: AccessIntent = {
  aliases: ["C:/workspace/file.ts"],
  caseSensitive: false,
  displayValue: "C:/workspace/file.ts",
  pathScope: "workspace",
  requiredMode: PERMISSION_MODES.WRITE,
  surface: "path",
};

describe("evaluatePermissionPolicy", () => {
  it("uses the last matching rule so configured rules can refine defaults", () => {
    const rules: PermissionRule[] = [
      rule("default", "ask", "*"),
      rule("configured", "allow", "write"),
    ];

    const result = evaluatePermissionPolicy([toolIntent], rules);

    expect(result.action).toBe("allow");
    expect(result.decisions[0]?.rules.map((item) => item.id)).toEqual([
      "configured",
    ]);
  });

  it("takes the strictest result across all intents", () => {
    const rules: PermissionRule[] = [
      rule("tool.allow", "allow", "write"),
      {
        action: "deny",
        id: "path.deny",
        mode: PERMISSION_MODES.WRITE,
        pattern: "**",
        source: "configured",
        surface: "path",
      },
    ];

    const result = evaluatePermissionPolicy(
      [toolIntent, pathIntent],
      rules,
    );

    expect(result.action).toBe("deny");
    expect(result.decisions.map((decision) => decision.action)).toEqual([
      "allow",
      "deny",
    ]);
  });

  it("defaults unmatched intents to ask", () => {
    expect(evaluatePermissionPolicy([toolIntent], []).action).toBe("ask");
  });

  it("matches an exact fingerprint using the intent case mode", () => {
    const intent: AccessIntent = {
      aliases: ["C:/WORKSPACE/README.md"],
      caseSensitive: false,
      displayValue: "C:/WORKSPACE/README.md",
      pathScope: "workspace",
      requiredMode: PERMISSION_MODES.READ,
      surface: "path",
    };
    const rules: PermissionRule[] = [
      {
        action: "allow",
        id: "session.path.fingerprint",
        match: "fingerprint",
        mode: PERMISSION_MODES.READ,
        pathScope: "workspace",
        pattern: fingerprintPermissionValue(
          "c:/workspace/readme.md",
          false,
        ),
        source: "session",
        surface: "path",
      },
    ];

    expect(evaluatePermissionPolicy([intent], rules).action).toBe("allow");
  });

  it("evaluates a compound requirement per bit and asks only for the gap", () => {
    const editIntent: AccessIntent = {
      ...pathIntent,
      requiredMode: PERMISSION_MODES.READ_WRITE,
    };
    const rules: PermissionRule[] = [
      {
        action: "allow",
        id: "path.read.allow",
        mode: PERMISSION_MODES.READ,
        pathScope: "workspace",
        pattern: "**",
        source: "configured",
        surface: "path",
      },
      {
        action: "ask",
        id: "path.write.ask",
        mode: PERMISSION_MODES.WRITE,
        pathScope: "workspace",
        pattern: "**",
        source: "configured",
        surface: "path",
      },
    ];

    const result = evaluatePermissionPolicy([editIntent], rules);

    expect(result.action).toBe("ask");
    expect(result.decisions[0]).toMatchObject({
      allowedMode: PERMISSION_MODES.READ,
      askMode: PERMISSION_MODES.WRITE,
      deniedMode: PERMISSION_MODES.NONE,
    });
  });

  it("rejects duplicate rule ids before evaluation", () => {
    const duplicateRules = [
      rule("same", "allow", "write"),
      rule("same", "deny", "write"),
    ];

    expect(() => evaluatePermissionPolicy([toolIntent], duplicateRules))
      .toThrow("Duplicate permission rule id");
  });

  it("rejects capability bits that do not belong to a resource surface", () => {
    const invalidRule: PermissionRule = {
      action: "allow",
      id: "path.execute.invalid",
      mode: PERMISSION_MODES.EXECUTE,
      pattern: "**",
      source: "configured",
      surface: "path",
    };

    expect(() => evaluatePermissionPolicy([pathIntent], [invalidRule]))
      .toThrow("incompatible with its surface");
  });
});

function rule(
  id: string,
  action: "allow" | "ask" | "deny",
  pattern: string,
): PermissionRule {
  return {
    action,
    id,
    mode: PERMISSION_MODES.EXECUTE,
    pattern,
    source: "configured",
    surface: "tool",
  };
}

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMISSION_MODES,
  PermissionSystem,
  type PermissionApproval,
  type PermissionApprovalRequest,
  type PermissionAuthority,
  type PermissionRule,
  type PermissionSessionGrant,
} from "../../../src/security/index.js";

const cwd = path.resolve("virtual-workspace");

describe("PermissionSystem", () => {
  it("allows workspace reads without prompting", async () => {
    const authority = createAuthority("deny");
    const system = createSystem();

    const result = await system.authorize(
      { cwd, input: { path: "README.md" }, toolName: "read" },
      authority,
    );

    expect(result.action).toBe("allow");
    expect(authority.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps a session grant exact to the approved tool and path", async () => {
    const authority = createAuthority("allow_session");
    const system = createSystem();
    const request = {
      cwd,
      input: { path: "src/index.ts" },
      toolName: "write",
    } as const;

    const first = await system.authorize(request, authority);
    const repeated = await system.authorize(request, authority);
    const differentPath = await system.authorize(
      { cwd, input: { path: "src/other.ts" }, toolName: "write" },
      authority,
    );

    expect(first).toMatchObject({
      action: "allow",
      approval: "allow_session",
    });
    expect(repeated).toMatchObject({ action: "allow" });
    expect(differentPath).toMatchObject({
      action: "allow",
      approval: "allow_session",
    });
    expect(authority.requestApproval).toHaveBeenCalledTimes(2);
    expect(system.sessionGrantCount).toBeGreaterThan(0);
  });

  it("allows the same operation for descendants of an approved folder", async () => {
    const authority = createAuthority("allow_folder");
    const system = createSystem();

    const first = await system.authorize(
      { cwd, input: { path: "src/index.ts" }, toolName: "write" },
      authority,
    );
    const descendant = await system.authorize(
      {
        cwd,
        input: { path: "src/nested/other.ts" },
        toolName: "write",
      },
      authority,
    );
    const differentTool = await system.authorize(
      {
        cwd,
        input: { path: "src/nested/other.ts" },
        toolName: "edit",
      },
      authority,
    );
    await system.authorize(
      { cwd, input: { path: "outside.ts" }, toolName: "write" },
      authority,
    );

    expect(first.approval).toBe("allow_folder");
    expect(descendant.approval).toBeUndefined();
    expect(differentTool.approval).toBe("allow_once");
    expect(authority.requestApproval).toHaveBeenCalledTimes(3);
    expect(
      system.exportSessionGrants().some(
        (grant) => grant.match === "wildcard",
      ),
    ).toBe(true);
  });

  it("does not let a workspace folder grant cross a symlink boundary", async () => {
    const escapedTarget = path.join(cwd, "src", "linked", "secret.ts");
    const externalTarget = path.resolve("outside-workspace", "secret.ts");
    const system = new PermissionSystem({
      pathNormalizer: {
        realpath: async (value) =>
          path.normalize(value) === path.normalize(escapedTarget)
            ? externalTarget
            : value,
      },
    });
    const authority = createAuthority("allow_folder");

    await system.authorize(
      { cwd, input: { path: "src/index.ts" }, toolName: "write" },
      authority,
    );
    await system.authorize(
      {
        cwd,
        input: { path: "src/linked/secret.ts" },
        toolName: "write",
      },
      authority,
    );

    expect(authority.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("does not create broad session grants for opaque custom tools", async () => {
    const authority = createAuthority("allow_session");
    const system = createSystem();

    const result = await system.authorize(
      { cwd, input: { environment: "prod" }, toolName: "deploy" },
      authority,
    );

    expect(result.approval).toBe("allow_once");
    expect(result.sessionGrantCount).toBe(0);
    expect(authority.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ canGrantSession: false }),
      undefined,
    );
  });

  it("blocks when confirmation is required but no authority is available", async () => {
    const system = createSystem();

    const result = await system.authorize(
      { cwd, input: { command: "git status" }, toolName: "bash" },
      createAuthority("unavailable"),
    );

    expect(result).toMatchObject({
      action: "block",
      approval: "unavailable",
    });
    expect(result.reason).toContain("没有可用的授权界面");
  });

  it("applies explicit deny rules without asking the authority", async () => {
    const authority = createAuthority("allow_once");
    const system = createSystem([
      {
        action: "deny",
        id: "configured.tool.deploy.deny",
        match: "exact",
        mode: PERMISSION_MODES.EXECUTE,
        pattern: "deploy",
        source: "configured",
        surface: "tool",
      },
    ]);

    const result = await system.authorize(
      { cwd, input: {}, toolName: "deploy" },
      authority,
    );

    expect(result.action).toBe("block");
    expect(result.reason).toContain("configured.tool.deploy.deny");
    expect(authority.requestApproval).not.toHaveBeenCalled();
  });

  it("clears all temporary grants at a session boundary", async () => {
    const system = createSystem();
    await system.authorize(
      { cwd, input: { command: "git status" }, toolName: "bash" },
      createAuthority("allow_session"),
    );

    expect(system.sessionGrantCount).toBeGreaterThan(0);
    system.clearSessionGrants();
    expect(system.sessionGrantCount).toBe(0);
  });

  it("bounds temporary rules in a long-running session", async () => {
    const system = new PermissionSystem({
      maxSessionGrantRules: 3,
      pathNormalizer: { realpath: async (value) => value },
    });
    const authority = createAuthority("allow_session");

    for (const command of ["git status", "git diff", "git log"]) {
      await system.authorize(
        { cwd, input: { command }, toolName: "bash" },
        authority,
      );
    }

    expect(system.sessionGrantCount).toBe(3);
  });

  it("exports and restores exact grants without restoring rule ids", async () => {
    const original = createSystem();
    const request = {
      cwd,
      input: { command: "git status" },
      toolName: "bash",
    } as const;
    const result = await original.authorize(
      request,
      createAuthority("allow_session"),
    );
    const grants = original.exportSessionGrants();

    const restored = createSystem();
    restored.restoreSessionGrants(grants);
    const authority = createAuthority("deny");
    const restoredResult = await restored.authorize(request, authority);

    expect(result.sessionGrantsAdded).toEqual(grants);
    expect(restoredResult.action).toBe("allow");
    expect(authority.requestApproval).not.toHaveBeenCalled();
  });

  it("merges new capabilities into one effective folder grant", async () => {
    const system = createSystem([
      {
        action: "ask",
        id: "configured.path.read.ask",
        match: "wildcard",
        mode: PERMISSION_MODES.READ,
        pathScope: "workspace",
        pattern: "**",
        source: "configured",
        surface: "path",
      },
    ]);
    const authority = createAuthority("allow_folder");

    await system.authorize(
      { cwd, input: { path: "src/index.ts" }, toolName: "read" },
      authority,
    );
    const writeResult = await system.authorize(
      { cwd, input: { path: "src/index.ts" }, toolName: "write" },
      authority,
    );

    const wildcard = system.exportSessionGrants().find(
      (grant) => grant.match === "wildcard",
    );
    expect(wildcard?.mode).toBe(PERMISSION_MODES.READ_WRITE);
    expect(system.sessionGrantCount).toBe(3);
    expect(
      writeResult.sessionGrantsAdded
        ?.filter((grant) => grant.surface === "path")
        .every((grant) => grant.mode === PERMISSION_MODES.WRITE),
    ).toBe(true);
  });

  it("rejects invalid restored data before replacing valid grants", async () => {
    const system = createSystem();
    await system.authorize(
      { cwd, input: { command: "git status" }, toolName: "bash" },
      createAuthority("allow_session"),
    );
    const original = system.exportSessionGrants();
    const invalid = {
      caseSensitive: true,
      fingerprint: "0".repeat(64),
      match: "fingerprint",
      mode: PERMISSION_MODES.WRITE,
      surface: "command",
    } as PermissionSessionGrant;

    expect(() => system.replaceSessionGrants([invalid]))
      .toThrow("Inconsistent session grant");
    expect(system.exportSessionGrants()).toEqual(original);

    const unscopedWildcard: PermissionSessionGrant = {
      caseSensitive: true,
      match: "wildcard",
      mode: PERMISSION_MODES.WRITE,
      pathScope: "workspace",
      pattern: "**",
      surface: "path",
    };
    expect(() => system.replaceSessionGrants([unscopedWildcard]))
      .toThrow("Invalid folder wildcard grant");
    expect(system.exportSessionGrants()).toEqual(original);
  });
});

function createSystem(
  rules: readonly PermissionRule[] = [],
): PermissionSystem {
  return new PermissionSystem({
    pathNormalizer: { realpath: async (value) => value },
    rules,
  });
}

function createAuthority(
  approval: PermissionApproval,
): PermissionAuthority {
  return {
    requestApproval: vi.fn(
      async (
        _request: PermissionApprovalRequest,
        _signal?: AbortSignal,
      ) => approval,
    ),
  };
}

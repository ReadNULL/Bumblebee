import path from "node:path";

import {
  hasPermission,
  PERMISSION_MODES,
  PermissionSystem,
  type PermissionApproval,
  type PermissionApprovalRequest,
  type PermissionAuthority,
  type PermissionRule,
} from "../../../../src/security/index.js";
import type { ScenarioDefinition } from "../runner/index.js";

export const PERMISSION_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "permission-folder-boundary",
      domain: "Permission",
      async run(context, probe) {
        const cwd = path.join(context.fixtureDirectory, "workspace");
        const escapedPath = path.join(
          cwd,
          "src",
          "linked",
          "secret.ts",
        );
        const externalPath = path.join(
          context.fixtureDirectory,
          "external",
          "secret.ts",
        );
        const approvals: PermissionApproval[] = [
          "allow_folder",
          "deny",
        ];
        const authority = createSequenceAuthority(approvals);
        const system = new PermissionSystem({
          pathNormalizer: {
            realpath: async (value) =>
              path.normalize(value) === path.normalize(escapedPath)
                ? externalPath
                : value,
          },
        });

        const granted = await system.authorize(
          {
            cwd,
            input: { path: "src/index.ts" },
            toolName: "write",
          },
          authority,
          context.signal,
        );
        const descendant = await system.authorize(
          {
            cwd,
            input: { path: "src/nested/file.ts" },
            toolName: "write",
          },
          authority,
          context.signal,
        );
        const escaped = await system.authorize(
          {
            cwd,
            input: { path: "src/linked/secret.ts" },
            toolName: "write",
          },
          authority,
          context.signal,
        );

        probe.check(
          "folder-grant-created",
          granted.action === "allow" &&
            granted.approval === "allow_folder",
        );
        probe.check(
          "descendant-reuses-folder-grant",
          descendant.action === "allow" &&
            descendant.approval === undefined,
        );
        probe.check(
          "canonical-escape-blocked",
          escaped.action === "block",
        );
        probe.check(
          "escape-requires-new-decision",
          authority.requestCount === 2,
        );
        probe.metric(
          "workspace_escape_count",
          escaped.action === "allow" ? 1 : 0,
        );
      },
    },
    {
      id: "permission-resume-merge",
      domain: "Permission",
      async run(context, probe) {
        const cwd = path.join(context.fixtureDirectory, "workspace");
        const rules: readonly PermissionRule[] = [
          {
            action: "ask",
            id: "benchmark.path.read.ask",
            match: "wildcard",
            mode: PERMISSION_MODES.READ,
            pathScope: "workspace",
            pattern: "**",
            source: "configured",
            surface: "path",
          },
        ];
        const originalAuthority = createSequenceAuthority([
          "allow_folder",
          "allow_folder",
        ]);
        const original = createPermissionSystem(rules);

        await original.authorize(
          {
            cwd,
            input: { path: "src/index.ts" },
            toolName: "read",
          },
          originalAuthority,
          context.signal,
        );
        await original.authorize(
          {
            cwd,
            input: { path: "src/index.ts" },
            toolName: "write",
          },
          originalAuthority,
          context.signal,
        );

        const grants = original.exportSessionGrants();
        const folderGrant = grants.find(
          (grant) => grant.match === "wildcard",
        );
        const restored = createPermissionSystem(rules);
        restored.restoreSessionGrants(grants);
        const restoredAuthority = createSequenceAuthority(["deny"]);
        const restoredRead = await restored.authorize(
          {
            cwd,
            input: { path: "src/nested/read.ts" },
            toolName: "read",
          },
          restoredAuthority,
          context.signal,
        );
        const restoredWrite = await restored.authorize(
          {
            cwd,
            input: { path: "src/nested/write.ts" },
            toolName: "write",
          },
          restoredAuthority,
          context.signal,
        );

        probe.check(
          "folder-modes-merged",
          folderGrant !== undefined &&
            hasPermission(folderGrant.mode, PERMISSION_MODES.READ) &&
            hasPermission(folderGrant.mode, PERMISSION_MODES.WRITE),
        );
        probe.check(
          "restored-read-does-not-prompt",
          restoredRead.action === "allow",
        );
        probe.check(
          "restored-write-does-not-prompt",
          restoredWrite.action === "allow",
        );
        probe.check(
          "resume-restores-session-grants",
          restoredAuthority.requestCount === 0,
        );
      },
    },
  ]);

interface RecordingAuthority extends PermissionAuthority {
  readonly requestCount: number;
  readonly requests: readonly PermissionApprovalRequest[];
}

function createSequenceAuthority(
  approvals: readonly PermissionApproval[],
): RecordingAuthority {
  let requestCount = 0;
  const requests: PermissionApprovalRequest[] = [];

  return {
    get requestCount() {
      return requestCount;
    },
    get requests() {
      return requests;
    },
    async requestApproval(request) {
      requests.push(request);
      const approval = approvals[requestCount] ?? "deny";
      requestCount += 1;
      return approval;
    },
  };
}

function createPermissionSystem(
  rules: readonly PermissionRule[],
): PermissionSystem {
  return new PermissionSystem({
    pathNormalizer: { realpath: async (value) => value },
    rules,
  });
}

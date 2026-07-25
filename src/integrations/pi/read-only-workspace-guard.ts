import type {
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  PERMISSION_APPROVALS,
  PermissionSystem,
  type PermissionAuthority,
} from "../../security/index.js";

export const PI_READ_ONLY_TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
] as const);

const READ_ONLY_TOOL_SET = new Set<string>(PI_READ_ONLY_TOOL_NAMES);
const DEFAULT_BOUNDARY_MESSAGE =
  "只读 Agent 只能使用当前工作区内的只读工具。";

export interface ReadOnlyWorkspaceGuardOptions {
  readonly boundaryMessage?: string;
}

/**
 * 为无交互式 UI 的 Pi 会话建立只读边界。
 * 工作区外读取会由 PermissionSystem 的 ask 策略转为 block。
 */
export function createReadOnlyWorkspaceGuard(
  options: ReadOnlyWorkspaceGuardOptions = {},
): ExtensionFactory {
  const boundaryMessage = options.boundaryMessage ?? DEFAULT_BOUNDARY_MESSAGE;

  return (pi) => {
    const permissionSystem = new PermissionSystem();

    pi.on("tool_call", async (event, context) => {
      if (!READ_ONLY_TOOL_SET.has(event.toolName)) {
        return { block: true, reason: boundaryMessage };
      }

      try {
        const result = await permissionSystem.authorize(
          {
            cwd: context.cwd,
            input: event.input,
            toolName: event.toolName,
          },
          READ_ONLY_AUTHORITY,
          context.signal,
        );
        return result.action === "allow"
          ? {}
          : {
              block: true,
              reason: result.reason ?? boundaryMessage,
            };
      } catch (_cause: unknown) {
        return { block: true, reason: boundaryMessage };
      }
    });
  };
}

const READ_ONLY_AUTHORITY: PermissionAuthority = Object.freeze({
  async requestApproval() {
    return PERMISSION_APPROVALS.UNAVAILABLE;
  },
});

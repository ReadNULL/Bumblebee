import type { PermissionRule } from "./types.js";
import { PERMISSION_MODES } from "./permission-mode.js";

/**
 * 默认策略偏向可用性：工作区内只读操作直接通过，所有有副作用或边界外操作询问。
 * 未命中的自定义工具仍由求值器的默认 `ask` 处理。
 */
export function createDefaultPermissionRules(): readonly PermissionRule[] {
  return Object.freeze<PermissionRule[]>([
    builtinToolRule("read", "allow"),
    builtinToolRule("grep", "allow"),
    builtinToolRule("find", "allow"),
    builtinToolRule("ls", "allow"),
    builtinToolRule("write", "ask"),
    builtinToolRule("edit", "ask"),
    builtinToolRule("bash", "ask"),
    {
      id: "builtin.command.ask",
      action: "ask",
      match: "wildcard",
      mode: PERMISSION_MODES.EXECUTE,
      pattern: "**",
      source: "builtin",
      surface: "command",
    },
    {
      id: "builtin.path.workspace.read",
      action: "allow",
      match: "wildcard",
      mode: PERMISSION_MODES.READ,
      pathScope: "workspace",
      pattern: "**",
      source: "builtin",
      surface: "path",
    },
    {
      id: "builtin.path.workspace.write",
      action: "ask",
      match: "wildcard",
      mode: PERMISSION_MODES.WRITE,
      pathScope: "workspace",
      pattern: "**",
      source: "builtin",
      surface: "path",
    },
    {
      id: "builtin.path.external.read",
      action: "ask",
      match: "wildcard",
      mode: PERMISSION_MODES.READ,
      pathScope: "external",
      pattern: "**",
      source: "builtin",
      surface: "path",
    },
    {
      id: "builtin.path.external.write",
      action: "ask",
      match: "wildcard",
      mode: PERMISSION_MODES.WRITE,
      pathScope: "external",
      pattern: "**",
      source: "builtin",
      surface: "path",
    },
  ]);
}

function builtinToolRule(
  toolName: string,
  action: "allow" | "ask",
): PermissionRule {
  return {
    id: `builtin.tool.${toolName}`,
    action,
    match: "exact",
    mode: PERMISSION_MODES.EXECUTE,
    pattern: toolName,
    source: "builtin",
    surface: "tool",
  };
}

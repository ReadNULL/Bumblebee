/**
 * 类 Unix 的三位能力掩码。这里只表达单个 Agent 资源的能力，
 * 不包含 owner/group/other，也不会修改操作系统文件权限。
 */
export const PERMISSION_MODES = {
  NONE: 0,
  EXECUTE: 0b001,
  WRITE: 0b010,
  READ: 0b100,
  READ_WRITE: 0b110,
  ALL: 0b111,
} as const;

export type PermissionMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type NonEmptyPermissionMode = Exclude<PermissionMode, 0>;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return Number.isInteger(value) &&
    Number(value) >= PERMISSION_MODES.NONE &&
    Number(value) <= PERMISSION_MODES.ALL;
}

export function isNonEmptyPermissionMode(
  value: unknown,
): value is NonEmptyPermissionMode {
  return isPermissionMode(value) && value !== PERMISSION_MODES.NONE;
}

export function hasPermission(
  granted: PermissionMode,
  required: PermissionMode,
): boolean {
  return (granted & required) === required;
}

export function mergePermissionModes(
  current: PermissionMode,
  added: PermissionMode,
): PermissionMode {
  return (current | added) as PermissionMode;
}

export function removePermissionMode(
  current: PermissionMode,
  removed: PermissionMode,
): PermissionMode {
  return (current & ~removed & PERMISSION_MODES.ALL) as PermissionMode;
}

export function formatPermissionMode(mode: PermissionMode): string {
  return [
    hasPermission(mode, PERMISSION_MODES.READ) ? "r" : "-",
    hasPermission(mode, PERMISSION_MODES.WRITE) ? "w" : "-",
    hasPermission(mode, PERMISSION_MODES.EXECUTE) ? "x" : "-",
  ].join("");
}

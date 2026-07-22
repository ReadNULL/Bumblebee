import type {
  NonEmptyPermissionMode,
  PermissionMode,
} from "./permission-mode.js";

export const PERMISSION_ACTIONS = {
  ALLOW: "allow",
  ASK: "ask",
  DENY: "deny",
} as const;

export type PermissionAction =
  (typeof PERMISSION_ACTIONS)[keyof typeof PERMISSION_ACTIONS];

export const PERMISSION_SURFACES = {
  COMMAND: "command",
  PATH: "path",
  TOOL: "tool",
} as const;

export type PermissionSurface =
  (typeof PERMISSION_SURFACES)[keyof typeof PERMISSION_SURFACES];

export const PERMISSION_PATH_SCOPES = {
  EXTERNAL: "external",
  WORKSPACE: "workspace",
} as const;

export type PermissionPathScope =
  (typeof PERMISSION_PATH_SCOPES)[keyof typeof PERMISSION_PATH_SCOPES];

export type PermissionRuleMatch = "exact" | "fingerprint" | "wildcard";
export type PermissionRuleSource = "builtin" | "configured" | "session";

/** 一次工具调用中可独立判断的最小访问行为。 */
export interface AccessIntent {
  readonly aliases: readonly string[];
  readonly caseSensitive: boolean;
  readonly displayValue: string;
  readonly folderAliases?: readonly string[];
  readonly folderDisplayValue?: string;
  readonly pathScope?: PermissionPathScope;
  readonly requiredMode: NonEmptyPermissionMode;
  readonly surface: PermissionSurface;
}

/** 规则按数组顺序、按权限位求值，每个权限位由最后一个匹配规则决定。 */
export interface PermissionRule {
  readonly action: PermissionAction;
  readonly id: string;
  readonly match?: PermissionRuleMatch;
  readonly mode: NonEmptyPermissionMode;
  readonly pathScope?: PermissionPathScope;
  readonly pattern: string;
  readonly source: PermissionRuleSource;
  readonly surface: PermissionSurface;
}

export interface IntentPermissionDecision {
  readonly action: PermissionAction;
  readonly allowedMode: PermissionMode;
  readonly askMode: PermissionMode;
  readonly deniedMode: PermissionMode;
  readonly intent: AccessIntent;
  readonly rules: readonly PermissionRule[];
}

export interface PermissionPolicyEvaluation {
  readonly action: PermissionAction;
  readonly decisions: readonly IntentPermissionDecision[];
}

interface PermissionSessionGrantBase {
  readonly caseSensitive: boolean;
  readonly mode: NonEmptyPermissionMode;
  readonly pathScope?: PermissionPathScope;
  readonly surface: PermissionSurface;
}

/** 不保存原文的精确授权。 */
export interface PermissionSessionExactGrant
  extends PermissionSessionGrantBase {
  readonly fingerprint: string;
  readonly match: "fingerprint";
}

/** 文件夹本身和其后代路径的通配授权。 */
export interface PermissionSessionFolderGrant
  extends PermissionSessionGrantBase {
  readonly match: "wildcard";
  readonly pattern: string;
}

export type PermissionSessionGrant =
  | PermissionSessionExactGrant
  | PermissionSessionFolderGrant;

export const PERMISSION_APPROVALS = {
  ALLOW_FOLDER: "allow_folder",
  ALLOW_ONCE: "allow_once",
  ALLOW_SESSION: "allow_session",
  DENY: "deny",
  UNAVAILABLE: "unavailable",
} as const;

export type PermissionApproval =
  (typeof PERMISSION_APPROVALS)[keyof typeof PERMISSION_APPROVALS];

export interface PermissionApprovalRequest {
  /** 只有可精确约束到命令或路径时，才允许生成会话级授权。 */
  readonly canGrantSession: boolean;
  /** 只有存在规范化路径意图时，才允许生成文件夹通配授权。 */
  readonly canGrantFolder: boolean;
  readonly cwd: string;
  readonly decisions: readonly IntentPermissionDecision[];
  readonly toolName: string;
}

export interface PermissionAuthority {
  requestApproval(
    request: PermissionApprovalRequest,
    signal?: AbortSignal,
  ): Promise<PermissionApproval>;
}

export interface PermissionAuthorizationRequest {
  readonly cwd: string;
  readonly input: unknown;
  readonly toolName: string;
}

export interface PermissionAuthorizationResult {
  readonly action: "allow" | "block";
  readonly approval?: PermissionApproval;
  readonly evaluation: PermissionPolicyEvaluation;
  readonly reason?: string;
  readonly sessionGrantCount: number;
  readonly sessionGrantsAdded?: readonly PermissionSessionGrant[];
}

import type {
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  ERROR_CODES,
  getUserMessage,
  normalizeError,
} from "../../foundation/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../runtime/index.js";
import {
  formatPermissionMode,
  PERMISSION_APPROVALS,
  PERMISSION_MODES,
  type PermissionApproval,
  type PermissionApprovalRequest,
  type PermissionAuthority,
  type PermissionMode,
  type PermissionSessionGrant,
  type PermissionSystem,
} from "../../security/index.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const ALLOW_ONCE_LABEL = "仅允许本次";
const ALLOW_SESSION_LABEL = "本会话允许相同操作";
const ALLOW_FOLDER_LABEL = "对此文件夹下均允许该操作";
const DENY_LABEL = "拒绝";
const BOUNDARY_FAILURE_MESSAGE = "权限检查失败，已阻止该工具调用。";
const PERSISTED_GRANT_CUSTOM_TYPE = "bumblebee.permission-grant.v1";
const PERSISTED_GRANT_VERSION = 1;
const MAX_GRANTS_PER_ENTRY = 8;

interface PersistedPermissionGrantBatch {
  readonly grants: readonly PermissionSessionGrant[];
  readonly sessionId: string;
  readonly version: 1;
}

export interface PiPermissionRegistrar {
  appendEntry<T = unknown>(customType: string, data?: T): void;
  on(
    event: "session_start",
    handler: ExtensionHandler<SessionStartEvent>,
  ): void;
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
  on(
    event: "session_tree",
    handler: ExtensionHandler<SessionTreeEvent>,
  ): void;
  on(
    event: "tool_call",
    handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>,
  ): void;
}

export interface PermissionExecutionRuntime {
  execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T>;
}

export interface PiPermissionBindingOptions {
  readonly approvalTimeoutMs?: number;
}

/**
 * Pi 是唯一执行边界：所有模型工具调用在这里先授权，异常一律阻止执行。
 * 会话事件从 pi custom entry 恢复授权，权限领域逻辑仍保持 Pi 无关。
 */
export function bindPiPermissionSystem(
  pi: PiPermissionRegistrar,
  runtime: PermissionExecutionRuntime,
  permissionSystem: PermissionSystem,
  options: PiPermissionBindingOptions = {},
): void {
  const approvalTimeoutMs = normalizeApprovalTimeout(
    options.approvalTimeoutMs,
  );

  pi.on("session_start", (_event, context) => {
    restorePersistedSessionGrants(permissionSystem, context);
  });

  pi.on("session_shutdown", () => {
    permissionSystem.clearSessionGrants();
  });

  pi.on("session_tree", (_event, context) => {
    restorePersistedSessionGrants(permissionSystem, context);
  });

  pi.on("tool_call", async (event, context) => {
    try {
      return await runtime.execute(
        createExecutionRequest(event, context),
        async ({ logger, signal }) => {
          const previousGrants = permissionSystem.exportSessionGrants();

          try {
            const result = await permissionSystem.authorize(
              {
                cwd: context.cwd,
                input: event.input,
                toolName: event.toolName,
              },
              new PiPermissionAuthority(
                context,
                approvalTimeoutMs,
              ),
              signal,
            );

            logger.info("permission evaluated", {
              fields: {
                action: result.action,
                approval: result.approval ?? "not_required",
                intentCount: result.evaluation.decisions.length,
                matchedRuleIds: result.evaluation.decisions.flatMap(
                  (decision) => decision.rules.map((rule) => rule.id),
                ),
                policyAction: result.evaluation.action,
                sessionGrantCount: result.sessionGrantCount,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              },
            });

            if (
              (result.approval === "allow_session" ||
                result.approval === "allow_folder") &&
              result.sessionGrantsAdded !== undefined
            ) {
              persistSessionGrants(
                pi,
                context,
                result.sessionGrantsAdded,
              );
            }

            return result.action === "block"
              ? {
                  block: true,
                  reason:
                    result.reason ?? "权限策略阻止了该工具调用。",
                }
              : {};
          } catch (cause: unknown) {
            // 授权写入会话失败时回滚内存，避免产生“只在当前进程生效”的半持久状态。
            permissionSystem.replaceSessionGrants(previousGrants);
            throw cause;
          }
        },
      );
    } catch (cause: unknown) {
      const error = normalizeError(cause, {
        code: ERROR_CODES.INTERNAL,
        context: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
        message: "Permission boundary failed",
        userMessage: BOUNDARY_FAILURE_MESSAGE,
      });

      return {
        block: true,
        reason: getUserMessage(error, BOUNDARY_FAILURE_MESSAGE),
      };
    }
  });
}

function persistSessionGrants(
  pi: PiPermissionRegistrar,
  context: ExtensionContext,
  grants: readonly PermissionSessionGrant[],
): void {
  if (grants.length === 0) {
    return;
  }
  if (grants.length > MAX_GRANTS_PER_ENTRY) {
    throw new TypeError("Too many permission grants in one session entry");
  }

  pi.appendEntry<PersistedPermissionGrantBatch>(
    PERSISTED_GRANT_CUSTOM_TYPE,
    {
      grants: grants.map(copySessionGrant),
      sessionId: context.sessionManager.getSessionId(),
      version: PERSISTED_GRANT_VERSION,
    },
  );
}

function restorePersistedSessionGrants(
  permissionSystem: PermissionSystem,
  context: ExtensionContext,
): void {
  permissionSystem.clearSessionGrants();
  const sessionId = context.sessionManager.getSessionId();
  const batches: PersistedPermissionGrantBatch[] = [];

  for (const entry of context.sessionManager.getBranch()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== PERSISTED_GRANT_CUSTOM_TYPE
    ) {
      continue;
    }

    const batch = parsePersistedGrantBatch(entry.data);
    if (batch === undefined) {
      reportInvalidPersistedGrants(context);
      permissionSystem.clearSessionGrants();
      return;
    }
    if (batch.sessionId === sessionId) {
      batches.push(batch);
    }
  }

  try {
    for (const batch of batches) {
      permissionSystem.restoreSessionGrants(batch.grants);
    }
  } catch (_cause: unknown) {
    // 损坏或被篡改的数据按无授权处理，并向可用 UI 报告一次。
    permissionSystem.clearSessionGrants();
    reportInvalidPersistedGrants(context);
  }
}

function parsePersistedGrantBatch(
  value: unknown,
): PersistedPermissionGrantBatch | undefined {
  if (
    !isRecord(value) ||
    value.version !== PERSISTED_GRANT_VERSION ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 512 ||
    !Array.isArray(value.grants) ||
    value.grants.length === 0 ||
    value.grants.length > MAX_GRANTS_PER_ENTRY
  ) {
    return undefined;
  }

  return {
    grants: value.grants as readonly PermissionSessionGrant[],
    sessionId: value.sessionId,
    version: PERSISTED_GRANT_VERSION,
  };
}

function copySessionGrant(
  grant: PermissionSessionGrant,
): PermissionSessionGrant {
  const common = {
    caseSensitive: grant.caseSensitive,
    mode: grant.mode,
    ...(grant.pathScope === undefined
      ? {}
      : { pathScope: grant.pathScope }),
    surface: grant.surface,
  } as const;

  return grant.match === "fingerprint"
    ? {
        ...common,
        fingerprint: grant.fingerprint,
        match: grant.match,
      }
    : {
        ...common,
        match: grant.match,
        pattern: grant.pattern,
      };
}

function reportInvalidPersistedGrants(context: ExtensionContext): void {
  if (context.hasUI) {
    context.ui.notify(
      "当前会话的 Bumblebee 授权记录无效，已忽略并恢复为询问模式。",
      "warning",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class PiPermissionAuthority implements PermissionAuthority {
  constructor(
    private readonly context: ExtensionContext,
    private readonly timeoutMs: number,
  ) {}

  async requestApproval(
    request: PermissionApprovalRequest,
    signal?: AbortSignal,
  ): Promise<PermissionApproval> {
    if (!this.context.hasUI) {
      return PERMISSION_APPROVALS.UNAVAILABLE;
    }

    const choices = [
      ALLOW_ONCE_LABEL,
      ...(request.canGrantSession ? [ALLOW_SESSION_LABEL] : []),
      ...(request.canGrantFolder ? [ALLOW_FOLDER_LABEL] : []),
      DENY_LABEL,
    ];
    const selected = await this.context.ui.select(
      formatApprovalTitle(request),
      choices,
      {
        ...(signal === undefined ? {} : { signal }),
        timeout: this.timeoutMs,
      },
    );

    if (selected === ALLOW_ONCE_LABEL) {
      return PERMISSION_APPROVALS.ALLOW_ONCE;
    }
    if (selected === ALLOW_SESSION_LABEL && request.canGrantSession) {
      return PERMISSION_APPROVALS.ALLOW_SESSION;
    }
    if (selected === ALLOW_FOLDER_LABEL && request.canGrantFolder) {
      return PERMISSION_APPROVALS.ALLOW_FOLDER;
    }
    return PERMISSION_APPROVALS.DENY;
  }
}

function createExecutionRequest(
  event: ToolCallEvent,
  context: ExtensionContext,
): TaskExecutionRequest {
  const signal = context.signal;
  return {
    operationName: "permission.authorize",
    sessionKey: `pi:${context.sessionManager.getSessionId()}`,
    ...(signal === undefined ? {} : { signal }),
    traceId: event.toolCallId,
  };
}

function formatApprovalTitle(request: PermissionApprovalRequest): string {
  const lines = request.decisions.map((decision) => {
    const access = permissionModeLabel(decision.askMode);
    const surface = surfaceLabel(decision.intent.surface);
    const value = sanitizeDisplayValue(decision.intent.displayValue);
    return `${access}${surface}(${formatPermissionMode(decision.askMode)}): ${value}`;
  });

  const folders = [
    ...new Set(
      request.decisions.flatMap((decision) =>
        decision.intent.folderDisplayValue === undefined
          ? []
          : [sanitizeDisplayValue(decision.intent.folderDisplayValue)],
      ),
    ),
  ];

  return [
    `Bumblebee 权限确认 - ${sanitizeDisplayValue(request.toolName)}`,
    ...lines,
    ...(request.canGrantFolder
      ? folders.map((folder) => `文件夹范围: ${folder}`)
      : []),
  ].join("\n");
}

function permissionModeLabel(mode: PermissionMode): string {
  const capabilities = [
    ...(mode & PERMISSION_MODES.READ ? ["读取"] : []),
    ...(mode & PERMISSION_MODES.WRITE ? ["写入"] : []),
    ...(mode & PERMISSION_MODES.EXECUTE ? ["执行"] : []),
  ];
  return capabilities.join("、");
}

function surfaceLabel(surface: "command" | "path" | "tool"): string {
  if (surface === "command") {
    return "命令";
  }
  if (surface === "path") {
    return "路径";
  }
  return "工具";
}

function sanitizeDisplayValue(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const maximumLength = 180;

  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 3)}...`;
}

function normalizeApprovalTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError("approvalTimeoutMs must be a positive safe integer");
  }
  return timeout;
}

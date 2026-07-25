import {
  BumblebeeError,
  ERROR_CODES,
  throwIfAborted,
} from "../../foundation/index.js";
import { createDefaultPermissionRules } from "./default-policy.js";
import {
  extractAccessIntents,
  type IntentExtractorOptions,
} from "./intent-extractor.js";
import {
  evaluatePermissionPolicy,
  validatePermissionRules,
} from "./policy-evaluator.js";
import {
  hasPermission,
  isNonEmptyPermissionMode,
  PERMISSION_MODES,
} from "./permission-mode.js";
import { SessionGrantStore } from "./session-grant-store.js";
import type {
  IntentPermissionDecision,
  PermissionApproval,
  PermissionAuthority,
  PermissionAuthorizationRequest,
  PermissionAuthorizationResult,
  PermissionRule,
  PermissionSessionGrant,
} from "./types.js";

export interface PermissionSystemOptions extends IntentExtractorOptions {
  readonly maxSessionGrantRules?: number;
  readonly rules?: readonly PermissionRule[];
}

const DEFAULT_MAX_SESSION_GRANT_RULES = 256;
const SHA_256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/** 权限领域服务：规则和会话授权归它管理，UI、Pi 和日志由外部适配器负责。 */
export class PermissionSystem {
  private readonly configuredRules: readonly PermissionRule[];
  private readonly defaultRules: readonly PermissionRule[];
  private readonly extractorOptions: IntentExtractorOptions;
  private readonly sessionGrants: SessionGrantStore;

  constructor(options: PermissionSystemOptions = {}) {
    this.defaultRules = createDefaultPermissionRules();
    this.configuredRules = Object.freeze([...(options.rules ?? [])]);
    validatePermissionRules([
      ...this.defaultRules,
      ...this.configuredRules,
    ]);
    const maximumRuleCount = normalizeMaximumRuleCount(
      options.maxSessionGrantRules,
    );
    this.sessionGrants = new SessionGrantStore(
      maximumRuleCount,
      new Set(
        [...this.defaultRules, ...this.configuredRules].map(
          (rule) => rule.id,
        ),
      ),
    );
    this.extractorOptions = {
      ...(options.pathNormalizer === undefined
        ? {}
        : { pathNormalizer: options.pathNormalizer }),
    };
  }

  get sessionGrantCount(): number {
    return this.sessionGrants.count;
  }

  async authorize(
    request: PermissionAuthorizationRequest,
    authority: PermissionAuthority,
    signal?: AbortSignal,
  ): Promise<PermissionAuthorizationResult> {
    throwIfAborted(signal);
    const intents = await extractAccessIntents(
      request,
      this.extractorOptions,
    );
    throwIfAborted(signal);

    const evaluation = evaluatePermissionPolicy(intents, [
      ...this.defaultRules,
      ...this.configuredRules,
      ...this.sessionGrants.rules,
    ]);

    if (evaluation.action === "deny") {
      return {
        action: "block",
        evaluation,
        reason: denyReason(request.toolName, evaluation.decisions),
        sessionGrantCount: this.sessionGrantCount,
      };
    }

    if (evaluation.action === "allow") {
      return {
        action: "allow",
        evaluation,
        sessionGrantCount: this.sessionGrantCount,
      };
    }

    const askDecisions = evaluation.decisions.filter(
      (decision) => decision.action === "ask",
    );
    const canGrantSession = askDecisions.some(
      (decision) => decision.intent.surface !== "tool",
    );
    const canGrantFolder = askDecisions.some(
      (decision) =>
        decision.intent.surface === "path" &&
        decision.intent.folderAliases !== undefined &&
        decision.intent.folderAliases.length > 0,
    );
    const approval = await authority.requestApproval(
      {
        canGrantFolder,
        canGrantSession,
        cwd: request.cwd,
        decisions: askDecisions,
        toolName: request.toolName,
      },
      signal,
    );
    throwIfAborted(signal);

    if (approval === "allow_folder" && canGrantFolder) {
      const added = this.sessionGrants.addFolder(askDecisions);
      return allowedAfterApproval(
        evaluation,
        approval,
        this.sessionGrantCount,
        added,
      );
    }

    if (approval === "allow_session" && canGrantSession) {
      const added = this.sessionGrants.addExact(askDecisions);
      return allowedAfterApproval(
        evaluation,
        approval,
        this.sessionGrantCount,
        added,
      );
    }

    if (
      approval === "allow_once" ||
      approval === "allow_session" ||
      approval === "allow_folder"
    ) {
      // 不可信 authority 不能用错误的范围型结果扩大未知工具授权。
      return allowedAfterApproval(
        evaluation,
        "allow_once",
        this.sessionGrantCount,
      );
    }

    return {
      action: "block",
      approval,
      evaluation,
      reason:
        approval === "unavailable"
          ? "该操作需要确认，但当前运行模式没有可用的授权界面。"
          : "用户拒绝了该工具调用。",
      sessionGrantCount: this.sessionGrantCount,
    };
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  exportSessionGrants(): readonly PermissionSessionGrant[] {
    return this.sessionGrants.grants;
  }

  replaceSessionGrants(
    grants: readonly PermissionSessionGrant[],
  ): void {
    validateSessionGrants(grants);
    this.sessionGrants.replace(grants);
  }

  restoreSessionGrants(
    grants: readonly PermissionSessionGrant[],
  ): void {
    validateSessionGrants(grants);
    this.sessionGrants.restore(grants);
  }
}

function normalizeMaximumRuleCount(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_SESSION_GRANT_RULES;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new BumblebeeError(
      "maxSessionGrantRules must be a positive safe integer",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName: "maxSessionGrantRules" },
      },
    );
  }
  return normalized;
}

function allowedAfterApproval(
  evaluation: PermissionAuthorizationResult["evaluation"],
  approval: Extract<
    PermissionApproval,
    "allow_folder" | "allow_once" | "allow_session"
  >,
  sessionGrantCount: number,
  sessionGrantsAdded: readonly PermissionSessionGrant[] = [],
): PermissionAuthorizationResult {
  return {
    action: "allow",
    approval,
    evaluation,
    sessionGrantCount,
    ...(sessionGrantsAdded.length === 0
      ? {}
      : { sessionGrantsAdded }),
  };
}

function validateSessionGrants(
  grants: readonly PermissionSessionGrant[],
): void {
  if (!Array.isArray(grants)) {
    throw invalidSessionGrant("Session grants must be an array");
  }

  for (const [index, grant] of grants.entries()) {
    if (typeof grant !== "object" || grant === null) {
      throw invalidSessionGrant("Session grant must be an object", index);
    }
    if (!isNonEmptyPermissionMode(grant.mode)) {
      throw invalidSessionGrant("Invalid session grant mode", index);
    }
    if (
      grant.surface !== "command" &&
      grant.surface !== "path" &&
      grant.surface !== "tool"
    ) {
      throw invalidSessionGrant("Invalid session grant surface", index);
    }
    if (typeof grant.caseSensitive !== "boolean") {
      throw invalidSessionGrant("Invalid session grant case mode", index);
    }
    if (grant.match === "fingerprint") {
      if (
        typeof grant.fingerprint !== "string" ||
        !SHA_256_HEX_PATTERN.test(grant.fingerprint)
      ) {
        throw invalidSessionGrant("Invalid session grant fingerprint", index);
      }
    } else if (grant.match === "wildcard") {
      if (!isSafeFolderWildcard(grant.pattern)) {
        throw invalidSessionGrant("Invalid folder wildcard grant", index);
      }
    } else {
      throw invalidSessionGrant("Invalid session grant match mode", index);
    }

    const isPathGrant = grant.surface === "path";
    if (
      isPathGrant !== (grant.pathScope !== undefined) ||
      (isPathGrant &&
        hasPermission(grant.mode, PERMISSION_MODES.EXECUTE)) ||
      (!isPathGrant && grant.mode !== PERMISSION_MODES.EXECUTE) ||
      (grant.pathScope !== undefined &&
        grant.pathScope !== "workspace" &&
        grant.pathScope !== "external")
    ) {
      throw invalidSessionGrant("Inconsistent session grant", index);
    }
    if (grant.match === "wildcard" && !isPathGrant) {
      throw invalidSessionGrant("Folder grant must target a path", index);
    }
  }
}

function isSafeFolderWildcard(pattern: unknown): pattern is string {
  if (
    typeof pattern !== "string" ||
    pattern.length > 32_768 ||
    !pattern.endsWith("/**")
  ) {
    return false;
  }

  const folder = pattern === "/**" || /^[a-zA-Z]:\/\*\*$/u.test(pattern)
    ? pattern.slice(0, -2)
    : pattern.slice(0, -3);
  return (
    (folder.startsWith("/") || /^[a-zA-Z]:\//u.test(folder)) &&
    !/[\\*?\u0000-\u001f\u007f]/u.test(folder)
  );
}

function invalidSessionGrant(
  message: string,
  index?: number,
): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context: {
      fieldName: "sessionGrants",
      ...(index === undefined ? {} : { index }),
    },
  });
}

function denyReason(
  toolName: string,
  decisions: readonly IntentPermissionDecision[],
): string {
  const ruleIds = decisions
    .filter((decision) => decision.action === "deny")
    .flatMap((decision) =>
      decision.rules
        .filter((rule) => rule.action === "deny")
        .map((rule) => rule.id),
    );
  const suffix = ruleIds.length > 0
    ? `（规则：${ruleIds.join(", ")}）`
    : "";
  return `权限策略拒绝了工具 ${toolName}${suffix}。`;
}

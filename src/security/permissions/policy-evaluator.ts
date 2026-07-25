import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import type {
  AccessIntent,
  IntentPermissionDecision,
  PermissionAction,
  PermissionPolicyEvaluation,
  PermissionRule,
} from "./types.js";
import { fingerprintPermissionValue } from "./permission-fingerprint.js";
import {
  hasPermission,
  isNonEmptyPermissionMode,
  mergePermissionModes,
  PERMISSION_MODES,
  type NonEmptyPermissionMode,
  type PermissionMode,
} from "./permission-mode.js";
import { matchesPermissionPattern } from "./wildcard-matcher.js";

const ACTION_PRIORITY: Readonly<Record<PermissionAction, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

const PERMISSION_BITS: readonly NonEmptyPermissionMode[] = Object.freeze([
  PERMISSION_MODES.READ,
  PERMISSION_MODES.WRITE,
  PERMISSION_MODES.EXECUTE,
]);

export function evaluatePermissionPolicy(
  intents: readonly AccessIntent[],
  rules: readonly PermissionRule[],
  defaultAction: PermissionAction = "ask",
): PermissionPolicyEvaluation {
  if (intents.length === 0) {
    throw new BumblebeeError("Permission evaluation requires an intent", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }

  for (const intent of intents) {
    if (!isNonEmptyPermissionMode(intent.requiredMode)) {
      throw new BumblebeeError("Permission intent mode is invalid", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { mode: intent.requiredMode, surface: intent.surface },
      });
    }
    if (
      (intent.surface === "path" &&
        (intent.pathScope === undefined ||
          hasPermission(intent.requiredMode, PERMISSION_MODES.EXECUTE))) ||
      (intent.surface !== "path" &&
        (intent.pathScope !== undefined ||
          intent.requiredMode !== PERMISSION_MODES.EXECUTE))
    ) {
      throw new BumblebeeError(
        "Permission intent mode is incompatible with its surface",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { mode: intent.requiredMode, surface: intent.surface },
        },
      );
    }
  }

  validatePermissionRules(rules);

  const decisions = intents.map((intent) =>
    evaluateIntent(intent, rules, defaultAction),
  );
  const action = decisions.reduce<PermissionAction>(
    (current, decision) =>
      ACTION_PRIORITY[decision.action] > ACTION_PRIORITY[current]
        ? decision.action
        : current,
    "allow",
  );

  return Object.freeze({ action, decisions: Object.freeze(decisions) });
}

export function validatePermissionRules(
  rules: readonly PermissionRule[],
): void {
  const ids = new Set<string>();

  for (const rule of rules) {
    if (
      rule.id.trim().length === 0 ||
      rule.pattern.length === 0 ||
      !isNonEmptyPermissionMode(rule.mode)
    ) {
      throw new BumblebeeError(
        "Permission rule id, pattern, and mode must be valid",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { ruleId: rule.id },
        },
      );
    }
    if (
      (rule.surface === "path" &&
        hasPermission(rule.mode, PERMISSION_MODES.EXECUTE)) ||
      (rule.surface !== "path" &&
        (rule.pathScope !== undefined ||
          rule.mode !== PERMISSION_MODES.EXECUTE))
    ) {
      throw new BumblebeeError(
        `Permission rule mode is incompatible with its surface: ${rule.id}`,
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { mode: rule.mode, ruleId: rule.id },
        },
      );
    }

    if (ids.has(rule.id)) {
      throw new BumblebeeError(`Duplicate permission rule id: ${rule.id}`, {
        code: ERROR_CODES.INVALID_INPUT,
        context: { ruleId: rule.id },
      });
    }
    ids.add(rule.id);
  }
}

function evaluateIntent(
  intent: AccessIntent,
  rules: readonly PermissionRule[],
  defaultAction: PermissionAction,
): IntentPermissionDecision {
  let allowedMode: PermissionMode = PERMISSION_MODES.NONE;
  let askMode: PermissionMode = PERMISSION_MODES.NONE;
  let deniedMode: PermissionMode = PERMISSION_MODES.NONE;
  const matchedRules: PermissionRule[] = [];
  const matchedRuleIds = new Set<string>();

  for (const bit of PERMISSION_BITS) {
    if (!hasPermission(intent.requiredMode, bit)) {
      continue;
    }

    let matchedRule: PermissionRule | undefined;
    for (const rule of rules) {
      if (
        hasPermission(rule.mode, bit) &&
        ruleMatchesIntentResource(rule, intent)
      ) {
        matchedRule = rule;
      }
    }

    const action = matchedRule?.action ?? defaultAction;
    if (action === "allow") {
      allowedMode = mergePermissionModes(allowedMode, bit);
    } else if (action === "ask") {
      askMode = mergePermissionModes(askMode, bit);
    } else {
      deniedMode = mergePermissionModes(deniedMode, bit);
    }

    if (matchedRule !== undefined && !matchedRuleIds.has(matchedRule.id)) {
      matchedRuleIds.add(matchedRule.id);
      matchedRules.push(matchedRule);
    }
  }

  const action = deniedMode !== PERMISSION_MODES.NONE
    ? "deny"
    : askMode !== PERMISSION_MODES.NONE
      ? "ask"
      : "allow";

  return Object.freeze({
    action,
    allowedMode,
    askMode,
    deniedMode,
    intent,
    rules: Object.freeze(matchedRules),
  });
}

function ruleMatchesIntentResource(
  rule: PermissionRule,
  intent: AccessIntent,
): boolean {
  if (rule.surface !== intent.surface) {
    return false;
  }
  if (
    rule.pathScope !== undefined &&
    rule.pathScope !== intent.pathScope
  ) {
    return false;
  }

  return intent.aliases.some((alias) => {
    if (rule.match === "exact") {
      return compareExact(rule.pattern, alias, intent.caseSensitive);
    }
    if (rule.match === "fingerprint") {
      return (
        rule.pattern ===
        fingerprintPermissionValue(alias, intent.caseSensitive)
      );
    }
    return matchesPermissionPattern(rule.pattern, alias, {
      caseSensitive: intent.caseSensitive,
    });
  });
}

function compareExact(
  expected: string,
  actual: string,
  caseSensitive: boolean,
): boolean {
  return caseSensitive
    ? expected === actual
    : expected.toLocaleLowerCase("en-US") ===
        actual.toLocaleLowerCase("en-US");
}

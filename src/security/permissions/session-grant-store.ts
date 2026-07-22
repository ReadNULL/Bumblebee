import type {
  IntentPermissionDecision,
  PermissionRule,
  PermissionSessionGrant,
} from "./types.js";
import { fingerprintPermissionValue } from "./permission-fingerprint.js";
import {
  isNonEmptyPermissionMode,
  mergePermissionModes,
  removePermissionMode,
  type NonEmptyPermissionMode,
} from "./permission-mode.js";

interface StoredSessionGrant {
  readonly grant: PermissionSessionGrant;
  readonly rule: PermissionRule;
}

/** 管理有上限的精确授权和用户明确选择的文件夹通配授权。 */
export class SessionGrantStore {
  private nextRuleId = 1;
  private readonly grantsByKey = new Map<string, StoredSessionGrant>();

  constructor(
    private readonly maximumRuleCount: number,
    private readonly reservedRuleIds: ReadonlySet<string>,
  ) {}

  get count(): number {
    return this.grantsByKey.size;
  }

  get grants(): readonly PermissionSessionGrant[] {
    return Object.freeze(
      [...this.grantsByKey.values()].map((entry) => entry.grant),
    );
  }

  get rules(): readonly PermissionRule[] {
    return Object.freeze(
      [...this.grantsByKey.values()].map((entry) => entry.rule),
    );
  }

  addExact(
    decisions: readonly IntentPermissionDecision[],
  ): readonly PermissionSessionGrant[] {
    const grants = decisions.flatMap((decision) => {
      if (decision.action !== "ask") {
        return [];
      }

      return decision.intent.aliases.map((pattern) =>
        createExactGrant(decision, pattern),
      );
    });

    return this.restore(grants);
  }

  addFolder(
    decisions: readonly IntentPermissionDecision[],
  ): readonly PermissionSessionGrant[] {
    const grants = decisions.flatMap((decision) => {
      if (decision.action !== "ask") {
        return [];
      }

      const intent = decision.intent;
      const mode = getAskMode(decision);
      if (
        intent.surface !== "path" ||
        intent.folderAliases === undefined ||
        intent.folderAliases.length === 0
      ) {
        return intent.aliases.map((pattern) =>
          createExactGrant(decision, pattern),
        );
      }

      return intent.folderAliases.flatMap((folder) => [
        createExactGrant(decision, folder),
        Object.freeze<PermissionSessionGrant>({
          caseSensitive: intent.caseSensitive,
          match: "wildcard",
          mode,
          ...(intent.pathScope === undefined
            ? {}
            : { pathScope: intent.pathScope }),
          pattern: createFolderWildcard(folder),
          surface: intent.surface,
        }),
      ]);
    });

    return this.restore(grants);
  }

  replace(grants: readonly PermissionSessionGrant[]): void {
    this.clear();
    this.restore(grants);
  }

  restore(
    grants: readonly PermissionSessionGrant[],
  ): readonly PermissionSessionGrant[] {
    const added: PermissionSessionGrant[] = [];

    for (const grant of grants) {
      const key = grantKey(grant);
      const existing = this.grantsByKey.get(key);

      if (existing !== undefined) {
        const addedMode = removePermissionMode(
          grant.mode,
          existing.grant.mode,
        );
        if (!isNonEmptyPermissionMode(addedMode)) {
          continue;
        }

        const mergedMode = mergePermissionModes(
          existing.grant.mode,
          addedMode,
        );
        if (!isNonEmptyPermissionMode(mergedMode)) {
          throw new TypeError("Merged permission mode cannot be empty");
        }

        const mergedGrant = copyGrant(existing.grant, mergedMode);
        this.grantsByKey.set(key, {
          grant: mergedGrant,
          rule: Object.freeze({
            ...existing.rule,
            mode: mergedMode,
          }),
        });
        added.push(copyGrant(grant, addedMode));
        continue;
      }

      this.evictOldestRuleIfFull();
      const storedGrant = copyGrant(grant);
      this.grantsByKey.set(key, {
        grant: storedGrant,
        rule: Object.freeze({
          id: this.createRuleId(),
          action: "allow",
          match: storedGrant.match,
          mode: storedGrant.mode,
          ...(storedGrant.pathScope === undefined
            ? {}
            : { pathScope: storedGrant.pathScope }),
          pattern:
            storedGrant.match === "fingerprint"
              ? storedGrant.fingerprint
              : storedGrant.pattern,
          source: "session",
          surface: storedGrant.surface,
        }),
      });
      added.push(storedGrant);
    }

    return Object.freeze(added);
  }

  clear(): void {
    this.grantsByKey.clear();
  }

  private createRuleId(): string {
    while (true) {
      const id = `session.grant.${this.nextRuleId}`;
      this.nextRuleId += 1;
      if (!this.reservedRuleIds.has(id)) {
        return id;
      }
    }
  }

  private evictOldestRuleIfFull(): void {
    if (this.grantsByKey.size < this.maximumRuleCount) {
      return;
    }

    const oldestKey = this.grantsByKey.keys().next().value as
      | string
      | undefined;
    if (oldestKey !== undefined) {
      this.grantsByKey.delete(oldestKey);
    }
  }
}

function grantKey(grant: PermissionSessionGrant): string {
  return [
    grant.surface,
    grant.pathScope ?? "",
    grant.caseSensitive ? "sensitive" : "insensitive",
    grant.match,
    grant.match === "fingerprint" ? grant.fingerprint : grant.pattern,
  ].join("\u0000");
}

function createExactGrant(
  decision: IntentPermissionDecision,
  value: string,
): PermissionSessionGrant {
  const intent = decision.intent;
  return Object.freeze<PermissionSessionGrant>({
    caseSensitive: intent.caseSensitive,
    fingerprint: fingerprintPermissionValue(value, intent.caseSensitive),
    match: "fingerprint",
    mode: getAskMode(decision),
    ...(intent.pathScope === undefined
      ? {}
      : { pathScope: intent.pathScope }),
    surface: intent.surface,
  });
}

function copyGrant(
  grant: PermissionSessionGrant,
  mode: NonEmptyPermissionMode = grant.mode,
): PermissionSessionGrant {
  const common = {
    caseSensitive: grant.caseSensitive,
    mode,
    ...(grant.pathScope === undefined
      ? {}
      : { pathScope: grant.pathScope }),
    surface: grant.surface,
  } as const;

  return grant.match === "fingerprint"
    ? Object.freeze({
        ...common,
        fingerprint: grant.fingerprint,
        match: grant.match,
      })
    : Object.freeze({
        ...common,
        match: grant.match,
        pattern: grant.pattern,
      });
}

function getAskMode(
  decision: IntentPermissionDecision,
): NonEmptyPermissionMode {
  if (!isNonEmptyPermissionMode(decision.askMode)) {
    throw new TypeError("Asked permission decision must contain a mode");
  }
  return decision.askMode;
}

function createFolderWildcard(folder: string): string {
  return folder.endsWith("/") ? `${folder}**` : `${folder}/**`;
}

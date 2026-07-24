import {
  ASSURANCE_CRITIC_MARKER,
  ASSURANCE_FOLLOW_UP_MARKER,
  type AssuranceCompletionReview,
  type AssuranceToolCall,
  type AssuranceToolDecision,
  type AssuranceToolResult,
  type TaskAssuranceSnapshot,
  type TaskContract,
  type VerificationTier,
} from "./types.js";
import { extractTaskContract } from "./contract-extractor.js";

interface PendingToolCall {
  readonly copiedArtifacts: readonly string[];
  readonly critic: boolean;
  readonly hashedArtifacts: readonly string[];
  readonly mutation: boolean;
  readonly verification?: {
    readonly command: string;
    readonly key: string;
    readonly tier: VerificationTier;
  };
}

interface PreservationState {
  copied: boolean;
  hashed: boolean;
}

interface TaskState {
  readonly contract: TaskContract;
  readonly pending: Map<string, PendingToolCall>;
  readonly preservation: Map<string, PreservationState>;
  readonly unresolved: Map<string, PendingToolCall["verification"]>;
  criticCostUsd: number;
  criticRuns: number;
  followUpIssued: boolean;
  mutationObserved: boolean;
  successfulVerificationCount: number;
}

export interface TaskAssuranceOptions {
  readonly criticToolEnabled?: boolean;
}

/**
 * Per-session evidence ledger. It never executes tools; the Pi binding feeds it
 * tool calls/results and applies the returned block/follow-up decisions.
 */
export class TaskAssurance {
  private readonly criticToolEnabled: boolean;
  private readonly states = new Map<string, TaskState>();

  constructor(options: TaskAssuranceOptions = {}) {
    this.criticToolEnabled = options.criticToolEnabled ?? true;
  }

  beginTask(sessionId: string, prompt: string): string {
    const existing = this.states.get(sessionId);
    const isFollowUp = prompt.includes(
      ASSURANCE_FOLLOW_UP_MARKER,
    );
    const state = isFollowUp && existing !== undefined
      ? existing
      : createTaskState(extractTaskContract(prompt));
    this.states.set(sessionId, state);
    return formatAssurancePolicy(state.contract);
  }

  beforeTool(
    sessionId: string,
    call: AssuranceToolCall,
  ): AssuranceToolDecision {
    const state = this.requireState(sessionId);
    const pending = inspectToolCall(call, state.contract);
    const unpreserved = findUnpreservedArtifacts(
      call,
      pending,
      state,
    );
    if (unpreserved.length > 0) {
      return Object.freeze({
        block: true,
        reason: [
          "Bumblebee blocked a recovery operation before source evidence was preserved.",
          `Create a byte-for-byte copy and record a SHA-256 hash in earlier successful tool calls: ${unpreserved.join(", ")}.`,
          "Do not open, repair, move, delete, or rewrite the original first.",
        ].join(" "),
      });
    }
    state.pending.set(call.toolCallId, pending);
    return Object.freeze({});
  }

  afterTool(
    sessionId: string,
    result: AssuranceToolResult,
  ): void {
    const state = this.states.get(sessionId);
    const pending = state?.pending.get(result.toolCallId);
    if (state === undefined || pending === undefined) {
      return;
    }
    state.pending.delete(result.toolCallId);
    if (result.isError) {
      if (pending.verification !== undefined) {
        state.unresolved.set(
          pending.verification.key,
          pending.verification,
        );
      }
      return;
    }

    if (pending.mutation) {
      state.mutationObserved = true;
    }
    for (const artifact of pending.copiedArtifacts) {
      requirePreservationState(state, artifact).copied = true;
    }
    for (const artifact of pending.hashedArtifacts) {
      requirePreservationState(state, artifact).hashed = true;
    }
    if (pending.verification !== undefined) {
      state.unresolved.delete(pending.verification.key);
      state.successfulVerificationCount += 1;
    }
    if (pending.critic) {
      state.criticRuns += 1;
      state.criticCostUsd += readCriticCost(result.details);
    }
  }

  reviewCompletion(
    sessionId: string,
  ): AssuranceCompletionReview {
    const state = this.requireState(sessionId);
    const reasons: string[] = [];
    if (state.unresolved.size > 0) {
      reasons.push(
        "Unresolved repository or contract verification failures: " +
          [...state.unresolved.values()]
            .flatMap((value) => value === undefined
              ? []
              : [`${value.key} (${value.command})`])
            .join("; "),
      );
    }
    if (
      state.mutationObserved &&
      state.successfulVerificationCount === 0
    ) {
      reasons.push(
        "The workspace changed without a successful repository or contract verification.",
      );
    }
    if (
      state.mutationObserved &&
      requiresIndependentCritic(state.contract) &&
      state.criticRuns === 0
    ) {
      reasons.push(
        "Explicit external contracts or recovery risk require one independent read-only review.",
      );
    }
    const incompletePreservation = [
      ...state.preservation.entries(),
    ].filter(
      ([, value]) => !value.copied || !value.hashed,
    ).map(([artifact]) => artifact);
    if (
      state.contract.highRiskRecovery &&
      state.mutationObserved &&
      incompletePreservation.length > 0
    ) {
      reasons.push(
        "Recovery evidence is missing a successful copy or SHA-256 record: " +
          incompletePreservation.join(", "),
      );
    }

    const shouldFollowUp =
      reasons.length > 0 && !state.followUpIssued;
    if (shouldFollowUp) {
      state.followUpIssued = true;
    }
    return Object.freeze({
      criticCostUsd: state.criticCostUsd,
      criticRuns: state.criticRuns,
      ...(shouldFollowUp
        ? {
            followUpMessage: formatFollowUp(
              reasons,
              this.criticToolEnabled,
            ),
          }
        : {}),
      reasons: Object.freeze(reasons),
      shouldFollowUp,
    });
  }

  getSnapshot(sessionId: string): TaskAssuranceSnapshot | undefined {
    const state = this.states.get(sessionId);
    if (state === undefined) {
      return undefined;
    }
    return Object.freeze({
      contract: state.contract,
      criticCostUsd: state.criticCostUsd,
      criticRuns: state.criticRuns,
      followUpIssued: state.followUpIssued,
      mutationObserved: state.mutationObserved,
      successfulVerificationCount:
        state.successfulVerificationCount,
      unresolvedVerificationKeys: Object.freeze(
        [...state.unresolved.keys()].sort(),
      ),
    });
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.states.clear();
      return;
    }
    this.states.delete(sessionId);
  }

  private requireState(sessionId: string): TaskState {
    const existing = this.states.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const state = createTaskState(extractTaskContract(""));
    this.states.set(sessionId, state);
    return state;
  }
}

function createTaskState(contract: TaskContract): TaskState {
  return {
    contract,
    pending: new Map(),
    preservation: new Map(
      contract.artifacts.map((artifact) => [
        artifact,
        { copied: false, hashed: false },
      ]),
    ),
    unresolved: new Map(),
    criticCostUsd: 0,
    criticRuns: 0,
    followUpIssued: false,
    mutationObserved: false,
    successfulVerificationCount: 0,
  };
}

function inspectToolCall(
  call: AssuranceToolCall,
  contract: TaskContract,
): PendingToolCall {
  const command = readString(call.input.command);
  const task = readString(call.input.task);
  const copiedArtifacts =
    command === undefined ? [] : matchingArtifacts(
      command,
      contract.artifacts,
      isCopyCommand(command),
    );
  const hashedArtifacts =
    command === undefined ? [] : matchingArtifacts(
      command,
      contract.artifacts,
      isHashCommand(command),
    );
  const verification = command === undefined
    ? undefined
    : classifyVerification(command, contract);
  return Object.freeze({
    copiedArtifacts: Object.freeze(copiedArtifacts),
    critic:
      call.toolName === "delegate_task" &&
      task?.includes(ASSURANCE_CRITIC_MARKER) === true,
    hashedArtifacts: Object.freeze(hashedArtifacts),
    mutation: isMutation(call.toolName, call.input, command),
    ...(verification === undefined ? {} : { verification }),
  });
}

function findUnpreservedArtifacts(
  call: AssuranceToolCall,
  pending: PendingToolCall,
  state: TaskState,
): readonly string[] {
  if (!state.contract.highRiskRecovery) {
    return [];
  }
  const command = readString(call.input.command);
  const path = readString(call.input.path);
  const source = [command, path].filter(
    (value): value is string => value !== undefined,
  ).join(" ");
  const mentioned = matchingArtifacts(
    source,
    state.contract.artifacts,
    true,
  );
  if (
    mentioned.length === 0 ||
    isPurePreservationCall(pending, command)
  ) {
    return [];
  }
  if (!isHazardousArtifactCall(call.toolName, command)) {
    return [];
  }
  return mentioned.filter((artifact) => {
    const evidence = state.preservation.get(artifact);
    return evidence === undefined ||
      !evidence.copied ||
      !evidence.hashed;
  });
}

function isPurePreservationCall(
  pending: PendingToolCall,
  command: string | undefined,
): boolean {
  if (
    pending.copiedArtifacts.length === 0 &&
    pending.hashedArtifacts.length === 0
  ) {
    return false;
  }
  return command !== undefined &&
    !/\b(?:sqlite3?|repair|recover|truncate|delete|vacuum)\b/iu.test(
      command,
    );
}

function isHazardousArtifactCall(
  toolName: string,
  command: string | undefined,
): boolean {
  if (toolName === "write" || toolName === "edit") {
    return true;
  }
  return toolName === "bash" &&
    command !== undefined &&
    /\b(?:sqlite3?|python|node|perl|ruby|rm|mv|move-item|remove-item|sed|dd|truncate|repair|recover|vacuum)\b/iu.test(
      command,
    );
}

function classifyVerification(
  command: string,
  contract: TaskContract,
): PendingToolCall["verification"] | undefined {
  const normalized = normalizeCommand(command);
  const repositoryPatterns: readonly [
    RegExp,
    string,
    VerificationTier,
  ][] = [
    [/(?:^|\s)pytest(?:\s|$)/u, "pytest", "repository"],
    [/\bnpm (?:run )?test\b/u, "npm-test", "repository"],
    [/\bpnpm (?:run )?test\b/u, "pnpm-test", "repository"],
    [/\byarn test\b/u, "yarn-test", "repository"],
    [/\bcargo test\b/u, "cargo-test", "repository"],
    [/\bgo test\b/u, "go-test", "repository"],
    [/\bctest\b/u, "ctest", "repository"],
    [/\bmake (?:check|test)\b/u, "make-test", "repository"],
    [/\b(?:npm|pnpm|yarn) run (?:build|lint|typecheck)\b/u, "package-build", "build"],
    [/\b(?:tsc|mypy|ruff|eslint)\b/u, "static-check", "build"],
    [/\bpython(?:3)? .*setup\.py .*build/u, "python-build", "build"],
  ];
  for (const [pattern, key, tier] of repositoryPatterns) {
    if (pattern.test(normalized)) {
      return {
        command,
        key: `${key}:${normalized}`,
        tier,
      };
    }
  }
  const explicitLiteral = contract.items.find((item) =>
    item.startsWith("Literal contract: ") &&
    normalized.includes(
      normalizeCommand(item.slice("Literal contract: ".length)),
    )
  );
  return explicitLiteral === undefined
    ? undefined
    : {
        command,
        key: `contract:${normalizeCommand(explicitLiteral)}`,
        tier: "contract",
      };
}

function isMutation(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  command: string | undefined,
): boolean {
  if (toolName === "write" || toolName === "edit") {
    return true;
  }
  if (toolName !== "bash" || command === undefined) {
    return false;
  }
  return /\b(?:rm|mv|cp|mkdir|touch|sed\s+-i|git\s+(?:add|commit|checkout|restore|reset)|npm\s+install|pip\s+install)\b|(?:>|>>)/iu.test(
    command,
  ) || Object.hasOwn(input, "command") &&
    /\b(?:python|node|perl|ruby)\b/iu.test(command);
}

function isCopyCommand(command: string): boolean {
  return /\b(?:cp|copy|copy-item|robocopy)\b/iu.test(command);
}

function isHashCommand(command: string): boolean {
  return (
    /\bsha256sum\b/iu.test(command) ||
    /\bshasum\b[^;&|\r\n]*\s-a\s*256\b/iu.test(command) ||
    (
      /\bget-filehash\b/iu.test(command) &&
      (
        !/\b-algorithm\b/iu.test(command) ||
        /\b-algorithm\s+sha256\b/iu.test(command)
      )
    ) ||
    /\bcertutil\b[^;&|\r\n]*\s-hashfile\b[^;&|\r\n]*\ssha256\b/iu.test(
      command,
    )
  );
}

function matchingArtifacts(
  source: string,
  artifacts: readonly string[],
  condition: boolean,
): string[] {
  if (!condition) {
    return [];
  }
  const normalized = normalizePathLike(source);
  return artifacts.filter((artifact) =>
    normalized.includes(normalizePathLike(artifact))
  );
}

function requirePreservationState(
  state: TaskState,
  artifact: string,
): PreservationState {
  const existing = state.preservation.get(artifact);
  if (existing !== undefined) {
    return existing;
  }
  const created = { copied: false, hashed: false };
  state.preservation.set(artifact, created);
  return created;
}

function requiresIndependentCritic(
  contract: TaskContract,
): boolean {
  return contract.highRiskRecovery || contract.items.length >= 2;
}

function formatAssurancePolicy(contract: TaskContract): string {
  const contractLines = contract.items.length === 0
    ? ["- Re-read the current user request and preserve every explicit contract."]
    : contract.items.map((item) => `- ${item}`);
  const recovery = contract.highRiskRecovery
    ? [
        "- Recovery/forensics mode is active.",
        `- Before opening or mutating original evidence, create a byte-for-byte copy and record SHA-256 for: ${contract.artifacts.join(", ")}.`,
        "- Never fabricate recovered values. Report uncertainty when evidence is insufficient.",
      ]
    : [];
  return [
    "<bumblebee-task-assurance>",
    "Maintain a private completion checklist from the external contract below.",
    ...contractLines,
    "- Repository/user-specified verification outranks ad-hoc smoke checks.",
    "- A later smoke check cannot erase an unresolved non-zero repository test.",
    "- Before claiming completion, verify paths, protocol fields, output format, and required final commands independently from the implementation.",
    ...recovery,
    "</bumblebee-task-assurance>",
  ].join("\n");
}

function formatFollowUp(
  reasons: readonly string[],
  criticToolEnabled: boolean,
): string {
  return [
    ASSURANCE_FOLLOW_UP_MARKER,
    "Do not conclude the task yet. The completion evidence has gaps:",
    ...reasons.map((reason) => `- ${reason}`),
    ...(criticToolEnabled
      ? [
          "Call delegate_task exactly once with a task beginning " +
            `${ASSURANCE_CRITIC_MARKER} and ask it to compare the current workspace against the original external contract using read-only evidence.`,
        ]
      : [
          "Perform one independent read-only pass against the original external contract.",
        ]),
    "Re-run unresolved repository or user-specified checks. A narrower smoke test does not supersede a failing stronger check.",
    "If a check cannot pass or recovery evidence is insufficient, report that limitation explicitly instead of claiming complete success.",
  ].join("\n");
}

function readCriticCost(details: unknown): number {
  if (!isRecord(details) || !isRecord(details.usage)) {
    return 0;
  }
  const value = details.usage.costUsd;
  return typeof value === "number" && Number.isFinite(value) &&
      value >= 0
    ? value
    : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function normalizePathLike(value: string): string {
  return value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

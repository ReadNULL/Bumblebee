export const ASSURANCE_FOLLOW_UP_MARKER =
  "[BUMBLEBEE_ASSURANCE_FOLLOW_UP]";
export const ASSURANCE_CRITIC_MARKER =
  "[BUMBLEBEE_ASSURANCE_CRITIC]";

export type VerificationTier =
  | "contract"
  | "repository"
  | "build"
  | "smoke";

export interface TaskContract {
  readonly artifacts: readonly string[];
  readonly highRiskRecovery: boolean;
  readonly items: readonly string[];
  readonly repositoryWideCompatibility: boolean;
}

export interface AssuranceToolCall {
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface AssuranceToolResult {
  readonly details?: unknown;
  readonly isError: boolean;
  readonly output?: unknown;
  readonly toolCallId: string;
}

export interface AssuranceToolDecision {
  readonly block?: boolean;
  readonly reason?: string;
}

export interface AssuranceCompletionReview {
  readonly criticCostUsd: number;
  readonly criticRuns: number;
  readonly followUpMessage?: string;
  readonly reasons: readonly string[];
  readonly shouldFollowUp: boolean;
}

export interface TaskAssuranceSnapshot {
  readonly broadCompatibilityScanObserved: boolean;
  readonly contract: TaskContract;
  readonly criticCostUsd: number;
  readonly criticRuns: number;
  readonly followUpIssued: boolean;
  readonly mutationObserved: boolean;
  readonly successfulVerificationCount: number;
  readonly unresolvedVerificationKeys: readonly string[];
}

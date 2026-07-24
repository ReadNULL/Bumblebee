import {
  LessonStore,
  type FailureCategory,
  type LessonRevision,
  type LessonRevisionInput,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import type {
  NormalizedTerminalBenchJob,
} from "../contracts/index.js";

export interface TerminalBenchLessonDraft {
  readonly lesson: LessonRevisionInput;
  readonly taskId: string;
  readonly failureCode: string;
  readonly harborTrialIds: readonly string[];
}

export interface RecordTerminalBenchLessonDraftsOptions {
  readonly job: NormalizedTerminalBenchJob;
  readonly outputDirectory: string;
  readonly runId: string;
  readonly clock?: () => Date;
}

/**
 * Groups repeated failures into reviewable drafts. Drafts are evidence, not
 * accepted conclusions; a later dev/holdout run must explicitly promote them.
 */
export function createTerminalBenchLessonDrafts(
  job: NormalizedTerminalBenchJob,
  runId: string,
): readonly TerminalBenchLessonDraft[] {
  const groups = new Map<string, {
    category: FailureCategory;
    code: string;
    messages: Set<string>;
    taskId: string;
    trialIds: string[];
  }>();
  for (const trial of job.trials) {
    if (trial.status === "passed") {
      continue;
    }
    const category = trial.failure?.category ?? "model";
    const code = trial.failure?.code ?? "UNKNOWN_FAILURE";
    const key = `${trial.taskId}\u0000${category}\u0000${code}`;
    const group = groups.get(key) ?? {
      category,
      code,
      messages: new Set<string>(),
      taskId: trial.taskId,
      trialIds: [],
    };
    group.trialIds.push(trial.harborTrialId);
    if (trial.failure?.message !== undefined) {
      group.messages.add(trial.failure.message);
    }
    groups.set(key, group);
  }

  const commit = job.trials.find(
    (trial) => trial.extensionCommit !== undefined,
  )?.extensionCommit;
  return Object.freeze(
    [...groups.values()]
      .sort((left, right) =>
        left.taskId.localeCompare(right.taskId) ||
        left.code.localeCompare(right.code)
      )
      .map((group) => {
        const harborTrialIds = Object.freeze(
          [...group.trialIds].sort(),
        );
        const lesson: LessonRevisionInput = {
          lessonId: createLessonId(group.taskId, group.code),
          title: `Terminal-Bench: ${group.taskId} / ${group.code}`,
          category: group.category,
          status: "proposed",
          evidenceRunIds: [runId],
          evidence: [
            `Task: ${group.taskId}`,
            `Failure code: ${group.code}`,
            `Harbor trials: ${harborTrialIds.join(", ")}`,
            ...(group.messages.size === 0
              ? []
              : [`Observed: ${[...group.messages].join(" | ")}`]),
          ].join("\n"),
          hypothesis: hypothesisFor(group.category),
          changeBoundary: changeBoundaryFor(group.category),
          expectedMetrics: [
            "verifier_result_coverage",
            group.category === "model" ||
                group.category === "bumblebee"
              ? "official_reward"
              : "infrastructure_validity",
          ],
          risks: [
            "A task-specific workaround may overfit the public benchmark.",
            "Infrastructure prewarming must not alter task inputs, verifier files, or reward semantics.",
          ],
          ...(commit === undefined ? {} : { relatedCommit: commit }),
        };
        return Object.freeze({
          lesson: Object.freeze(lesson),
          taskId: group.taskId,
          failureCode: group.code,
          harborTrialIds,
        });
      }),
  );
}

export async function recordTerminalBenchLessonDrafts(
  options: RecordTerminalBenchLessonDraftsOptions,
): Promise<readonly LessonRevision[]> {
  const drafts = createTerminalBenchLessonDrafts(
    options.job,
    options.runId,
  );
  const store = new LessonStore({
    outputDirectory: options.outputDirectory,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const revisions: LessonRevision[] = [];
  for (const draft of drafts) {
    revisions.push(await store.append(draft.lesson));
  }
  return Object.freeze(revisions);
}

function createLessonId(taskId: string, code: string): string {
  const slug = `${taskId}-${code}`
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 110);
  return `tb21-${slug || "unknown"}`;
}

function hypothesisFor(category: FailureCategory): string {
  if (category === "infrastructure") {
    return "The verifier bootstrap or external dependency path was unavailable, so the reward does not isolate Agent capability.";
  }
  if (category === "adapter" || category === "dataset") {
    return "The evaluation adapter or dataset contract did not produce a complete, auditable verifier result.";
  }
  return "The Agent likely concluded before fully checking the external contract, strongest available verification, or required evidence.";
}

function changeBoundaryFor(category: FailureCategory): string {
  if (
    category === "infrastructure" ||
    category === "adapter" ||
    category === "dataset"
  ) {
    return "Change only generic benchmark bootstrap, retry, normalization, and evidence handling. Keep upstream task and verifier content immutable.";
  }
  return "Change only generic Agent assurance, context, permission, or tool behavior and add task-agnostic dev/holdout cases. Do not encode benchmark-specific solutions.";
}

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  KeyedSerialQueue,
} from "../../../../src/foundation/index.js";
import {
  ArtifactStore,
  type WriteArtifactInput,
  type WriteJsonArtifactInput,
} from "../artifacts/index.js";
import {
  EVALUATION_CONTRACT_VERSION,
  assertEvaluationTaskResultInput,
  assertFinalizeEvaluationRunInput,
  assertIdentifier,
  assertStartEvaluationRunInput,
  type ArtifactReference,
  type EvaluationRunManifest,
  type EvaluationRunSummary,
  type EvaluationTaskCounts,
  type EvaluationTaskResult,
  type EvaluationTaskResultInput,
  type FinalizeEvaluationRunInput,
  type RunLedgerEntry,
  type StartEvaluationRunInput,
  type TaskStatus,
} from "../contracts/index.js";
import { appendSanitizedJsonLine } from "./json-lines.js";

export interface EvaluationRunStoreOptions {
  readonly outputDirectory: string;
  readonly maxArtifactBytes?: number;
  readonly clock?: () => Date;
  readonly runIdFactory?: () => string;
}

export type RunArtifactInput = Omit<WriteArtifactInput, "runId">;
export type RunJsonArtifactInput = Omit<
  WriteJsonArtifactInput,
  "runId"
>;

export interface FinalizedEvaluationRun {
  readonly summary: EvaluationRunSummary;
  readonly summaryArtifact: ArtifactReference;
}

export interface EvaluationRun {
  readonly manifest: EvaluationRunManifest;

  recordTask(
    input: EvaluationTaskResultInput,
  ): Promise<ArtifactReference>;

  recordRawArtifact(
    input: RunArtifactInput,
  ): Promise<ArtifactReference>;

  recordJsonArtifact(
    input: RunJsonArtifactInput,
  ): Promise<ArtifactReference>;

  finalize(
    input: FinalizeEvaluationRunInput,
  ): Promise<FinalizedEvaluationRun>;
}

/**
 * 评估输出的聚合根。一个评估进程应复用同一实例，以串行化 ledger 和单个 run 的写入。
 */
export class EvaluationRunStore {
  readonly outputDirectory: string;

  private readonly artifactStore: ArtifactStore;
  private readonly clock: () => Date;
  private readonly ledgerPath: string;
  private readonly queue = new KeyedSerialQueue<string>();
  private readonly runIdFactory: () => string;

  constructor(options: EvaluationRunStoreOptions) {
    if (options.outputDirectory.trim().length === 0) {
      throw new BumblebeeError(
        "evaluation output directory must not be empty",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }

    this.outputDirectory = resolve(options.outputDirectory);
    this.clock = options.clock ?? (() => new Date());
    this.runIdFactory =
      options.runIdFactory ??
      (() => `run_${Date.now().toString(36)}_${randomUUID()}`);
    this.ledgerPath = join(
      this.outputDirectory,
      "history",
      "runs.jsonl",
    );
    this.artifactStore = new ArtifactStore(
      join(this.outputDirectory, "artifacts"),
      {
        ...(options.maxArtifactBytes === undefined
          ? {}
          : { maxArtifactBytes: options.maxArtifactBytes }),
        clock: this.clock,
      },
    );
  }

  async startRun(input: StartEvaluationRunInput): Promise<EvaluationRun> {
    assertStartEvaluationRunInput(input);
    const runId = this.runIdFactory();
    assertIdentifier(runId, "runId");

    return this.withRunLock(runId, async () => {
      const manifest: EvaluationRunManifest = {
        ...input,
        contractVersion: EVALUATION_CONTRACT_VERSION,
        runId,
        startedAt: input.startedAt ?? this.clock().toISOString(),
      };
      const manifestArtifact = await this.artifactStore.writeJson({
        runId,
        relativePath: "manifest.json",
        kind: "manifest",
        mediaType: "application/json",
        value: manifest,
      });

      await this.appendLedger({
        contractVersion: EVALUATION_CONTRACT_VERSION,
        event: "run_started",
        runId,
        ...(manifest.parentRunId === undefined
          ? {}
          : { parentRunId: manifest.parentRunId }),
        at: this.clock().toISOString(),
        manifestArtifact,
      });

      return new RunRecorder(
        manifest,
        this.artifactStore,
        this.clock,
        (operation) => this.withRunLock(runId, operation),
        (entry) => this.appendLedger(entry),
      );
    });
  }

  private withRunLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.queue.enqueue(`run:${runId}`, operation);
  }

  private appendLedger(entry: RunLedgerEntry): Promise<void> {
    return this.queue.enqueue("ledger:runs", () =>
      appendSanitizedJsonLine(this.ledgerPath, entry),
    );
  }
}

class RunRecorder implements EvaluationRun {
  private readonly taskKeys = new Set<string>();
  private readonly taskResultArtifacts: ArtifactReference[] = [];
  private readonly taskStatuses: TaskStatus[] = [];
  private finalized = false;

  constructor(
    readonly manifest: EvaluationRunManifest,
    private readonly artifactStore: ArtifactStore,
    private readonly clock: () => Date,
    private readonly withLock: <T>(
      operation: () => Promise<T>,
    ) => Promise<T>,
    private readonly appendLedger: (
      entry: RunLedgerEntry,
    ) => Promise<void>,
  ) {}

  recordTask(
    input: EvaluationTaskResultInput,
  ): Promise<ArtifactReference> {
    assertEvaluationTaskResultInput(input);

    return this.withLock(async () => {
      this.assertOpen();
      const taskKey = `${input.taskId}:${input.trial}`;
      if (this.taskKeys.has(taskKey)) {
        throw new BumblebeeError(
          "task trial has already been recorded",
          {
            code: ERROR_CODES.CONFLICT,
            context: {
              runId: this.manifest.runId,
              taskId: input.taskId,
              trial: input.trial,
            },
          },
        );
      }

      for (const artifact of input.artifacts ?? []) {
        if (artifact.runId !== this.manifest.runId) {
          throw new BumblebeeError(
            "task evidence belongs to another run",
            {
              code: ERROR_CODES.INVALID_INPUT,
              context: {
                artifactRunId: artifact.runId,
                runId: this.manifest.runId,
              },
            },
          );
        }
        const verification = await this.artifactStore.verify(artifact);
        if (!verification.valid) {
          throw new BumblebeeError(
            "task evidence failed integrity verification",
            {
              code: ERROR_CODES.CONFLICT,
              context: {
                artifactId: artifact.artifactId,
                reason: verification.reason,
              },
            },
          );
        }
      }

      const result: EvaluationTaskResult = {
        ...input,
        contractVersion: EVALUATION_CONTRACT_VERSION,
        runId: this.manifest.runId,
        recordedAt: this.clock().toISOString(),
      };
      const artifact = await this.artifactStore.writeJson({
        runId: this.manifest.runId,
        relativePath:
          `task-results/${input.taskId}/trial-${input.trial}.json`,
        kind: "task-result",
        mediaType: "application/json",
        value: result,
      });

      this.taskKeys.add(taskKey);
      this.taskStatuses.push(input.status);
      this.taskResultArtifacts.push(artifact);
      return artifact;
    });
  }

  recordRawArtifact(
    input: RunArtifactInput,
  ): Promise<ArtifactReference> {
    return this.withLock(async () => {
      this.assertOpen();
      return this.artifactStore.writeRaw({
        ...input,
        runId: this.manifest.runId,
        relativePath: `evidence/${input.relativePath}`,
      });
    });
  }

  recordJsonArtifact(
    input: RunJsonArtifactInput,
  ): Promise<ArtifactReference> {
    return this.withLock(async () => {
      this.assertOpen();
      return this.artifactStore.writeJson({
        ...input,
        runId: this.manifest.runId,
        relativePath: `evidence/${input.relativePath}`,
      });
    });
  }

  finalize(
    input: FinalizeEvaluationRunInput,
  ): Promise<FinalizedEvaluationRun> {
    assertFinalizeEvaluationRunInput(input);

    return this.withLock(async () => {
      this.assertOpen();
      if (input.gateEvaluation.scoreSpec !== this.manifest.scoreSpec) {
        throw new BumblebeeError(
          "gate evaluation does not match run manifest",
          {
            code: ERROR_CODES.INVALID_INPUT,
            context: {
              actual: input.gateEvaluation.scoreSpec,
              expected: this.manifest.scoreSpec,
            },
          },
        );
      }
      assertCompositeScoreMatchesGate(input);

      const finishedAt = input.finishedAt ?? this.clock().toISOString();
      const durationMs =
        Date.parse(finishedAt) - Date.parse(this.manifest.startedAt);
      if (durationMs < 0) {
        throw new BumblebeeError(
          "run finishedAt precedes startedAt",
          {
            code: ERROR_CODES.INVALID_INPUT,
            context: {
              finishedAt,
              startedAt: this.manifest.startedAt,
            },
          },
        );
      }

      const taskCounts = countTaskStatuses(this.taskStatuses);
      const summary: EvaluationRunSummary = {
        contractVersion: EVALUATION_CONTRACT_VERSION,
        runId: this.manifest.runId,
        ...(this.manifest.parentRunId === undefined
          ? {}
          : { parentRunId: this.manifest.parentRunId }),
        scoreSpec: this.manifest.scoreSpec,
        status: input.status,
        startedAt: this.manifest.startedAt,
        finishedAt,
        durationMs,
        taskCounts,
        metrics: input.metrics,
        gateEvaluation: input.gateEvaluation,
        ...(input.compositeScore === undefined
          ? {}
          : { compositeScore: input.compositeScore }),
        ...(input.failure === undefined
          ? {}
          : { failure: input.failure }),
        lessonIds: [...(input.lessonIds ?? [])],
        taskResultArtifacts: [...this.taskResultArtifacts],
      };
      const summaryArtifact = await this.artifactStore.writeJson({
        runId: this.manifest.runId,
        relativePath: "summary.json",
        kind: "summary",
        mediaType: "application/json",
        value: summary,
      });

      await this.appendLedger({
        contractVersion: EVALUATION_CONTRACT_VERSION,
        event: "run_finished",
        runId: this.manifest.runId,
        at: this.clock().toISOString(),
        status: input.status,
        qualification: input.gateEvaluation.status,
        taskCounts,
        summaryArtifact,
      });

      this.finalized = true;
      return { summary, summaryArtifact };
    });
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new BumblebeeError(
        "evaluation run has already been finalized",
        {
          code: ERROR_CODES.CONFLICT,
          context: { runId: this.manifest.runId },
        },
      );
    }
  }
}

function countTaskStatuses(
  statuses: readonly TaskStatus[],
): EvaluationTaskCounts {
  const counts: Record<TaskStatus, number> = {
    passed: 0,
    failed: 0,
    cancelled: 0,
    invalid: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
  }

  return {
    ...counts,
    total: statuses.length,
  };
}

function assertCompositeScoreMatchesGate(
  input: FinalizeEvaluationRunInput,
): void {
  const score = input.compositeScore;
  if (score === undefined) {
    return;
  }

  if (
    score.qualification !== input.gateEvaluation.status ||
    (score.qualification === "qualified" && score.score === null) ||
    (score.qualification !== "qualified" && score.score !== null)
  ) {
    throw new BumblebeeError(
      "composite score contradicts gate evaluation",
      { code: ERROR_CODES.INVALID_INPUT },
    );
  }
}

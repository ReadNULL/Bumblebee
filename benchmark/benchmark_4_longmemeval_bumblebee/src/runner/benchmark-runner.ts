import {
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeError,
} from "../../../../src/foundation/index.js";
import {
  EvaluationRunStore,
  type ArtifactReference,
  type EvaluationFailure,
  type EvaluationTaskResultInput,
  type ModelIdentity,
  type StartEvaluationRunInput,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import type {
  LongMemEvalCase,
  LongMemEvalCaseResult,
  LongMemEvalDataset,
  LongMemEvalManifest,
  LongMemEvalProfile,
  LongMemEvalReader,
  LongMemEvalRunReport,
} from "../contracts/index.js";
import { aggregateLongMemEval } from "../scoring/index.js";
import { runLongMemEvalCase } from "./case-runner.js";

export interface RunLongMemEvalOptions {
  readonly manifest: LongMemEvalManifest;
  readonly dataset: LongMemEvalDataset;
  readonly datasetSha256: string;
  readonly profile: LongMemEvalProfile;
  readonly reader?: LongMemEvalReader;
  readonly outputDirectory: string;
  readonly temporaryDirectory?: string;
  readonly hardwareProfile: string;
  readonly observedPiVersion: string;
  readonly bumblebeeCommit: string;
  readonly workspaceClean: boolean;
  readonly model?: ModelIdentity;
  readonly parentRunId?: string;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
}

export async function runLongMemEvalBenchmark(
  options: RunLongMemEvalOptions,
): Promise<LongMemEvalRunReport> {
  assertReaderConfiguration(options);
  const clock = options.clock ?? (() => new Date());
  const store = new EvaluationRunStore({
    outputDirectory: options.outputDirectory,
    clock,
  });
  const run = await store.startRun(createRunInput(options));
  const results: LongMemEvalCaseResult[] = [];
  const parent = options.temporaryDirectory ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const fixtureRoot = await mkdtemp(
    path.join(parent, "bumblebee-longmemory-"),
  );

  try {
    const repetitions =
      options.manifest.profiles[options.profile].repetitions;
    for (let trial = 1; trial <= repetitions; trial += 1) {
      for (const testCase of options.dataset.cases) {
        const fixtureDirectory = path.join(
          fixtureRoot,
          `trial-${trial}`,
          testCase.id,
        );
        const result = await executeCase(
          options,
          testCase,
          trial,
          fixtureDirectory,
        );
        results.push(result);
        const evidence = await run.recordJsonArtifact({
          relativePath:
            `longmemeval/${testCase.id}/trial-${trial}.json`,
          kind: "verifier",
          mediaType: "application/json",
          value: result.evidence,
        });
        await run.recordTask(
          createTaskResult(options.profile, result, evidence),
        );
      }
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  const aggregation = aggregateLongMemEval({
    manifest: options.manifest,
    dataset: options.dataset,
    datasetSha256: options.datasetSha256,
    profile: options.profile,
    results,
    observedPiVersion: options.observedPiVersion,
    bumblebeeCommit: options.bumblebeeCommit,
    workspaceClean: options.workspaceClean,
  });
  const report: LongMemEvalRunReport = Object.freeze({
    runId: run.manifest.runId,
    manifestVersion: options.manifest.version,
    profile: options.profile,
    datasetSha256: options.datasetSha256,
    metrics: aggregation.metrics,
    componentScores: aggregation.componentScores,
    gateEvaluation: aggregation.gateEvaluation,
    score: aggregation.score,
  });
  await run.recordJsonArtifact({
    relativePath: "report.json",
    kind: "report",
    mediaType: "application/json",
    value: report,
  });

  const invalid =
    aggregation.gateEvaluation.status === "invalid";
  await run.finalize({
    status: invalid ? "invalid" : "completed",
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    compositeScore: aggregation.score,
    ...(invalid
      ? {
          failure: {
            category: "infrastructure" as const,
            code: "INVALID_LONGMEMEVAL_RUN",
            message:
              "LongMemEval-Bumblebee run failed a validity gate",
            retryable: true,
          },
        }
      : {}),
  });
  return report;
}

async function executeCase(
  options: RunLongMemEvalOptions,
  testCase: LongMemEvalCase,
  trial: number,
  fixtureDirectory: string,
): Promise<LongMemEvalCaseResult> {
  try {
    return await runLongMemEvalCase({
      case: testCase,
      fixtureDirectory,
      profile: options.profile,
      trial,
      ...(options.reader === undefined
        ? {}
        : { reader: options.reader }),
      ...(options.signal === undefined
        ? {}
        : { signal: options.signal }),
    });
  } catch (cause: unknown) {
    const error = normalizeError(cause, {
      message: "LongMemEval-Bumblebee case execution failed",
    });
    const timestamp = new Date().toISOString();
    return Object.freeze({
      caseId: testCase.id,
      capability: testCase.capability,
      trial,
      profile: options.profile,
      startedAt: timestamp,
      finishedAt: timestamp,
      durationMs: 0,
      status: "invalid",
      metrics: Object.freeze({
        expectedAbstention: testCase.answer.abstain,
      }),
      evidence: Object.freeze({
        caseId: testCase.id,
        capability: testCase.capability,
        trial,
        profile: options.profile,
        query: testCase.query.text,
        retrievedKeys: Object.freeze([]),
        memoryContext: "",
        answer: null,
        answerEvaluation: null,
        operationChecksPassed: false,
        stateChecksPassed: false,
        memoryScopeLeakCount: 0,
        secretPersistedCount: 0,
      }),
      failure: Object.freeze({
        code: error.code,
        message: error.message,
      }),
    });
  }
}

function createTaskResult(
  profile: LongMemEvalProfile,
  result: LongMemEvalCaseResult,
  evidence: ArtifactReference,
): EvaluationTaskResultInput {
  if (result.status === "invalid") {
    return {
      taskId: result.caseId,
      trial: result.trial,
      status: "invalid",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      metrics: {
        expected_abstention:
          result.metrics.expectedAbstention ? 1 : 0,
      },
      failure: {
        category: "adapter",
        code:
          result.failure?.code ?? "LONGMEMEVAL_CASE_INVALID",
        message:
          result.failure?.message ?? "Case execution was invalid",
        retryable: true,
      },
      artifacts: [evidence],
      metadata: {
        capability: result.capability,
        profile,
      },
    };
  }

  const answerPassed =
    profile === "memory-core" ||
    result.metrics.qaAccuracy === 1;
  const safetyPassed =
    result.evidence.memoryScopeLeakCount === 0 &&
    result.evidence.secretPersistedCount === 0;
  const passed =
    answerPassed &&
    safetyPassed &&
    result.evidence.operationChecksPassed &&
    result.evidence.stateChecksPassed;
  const failure = passed
    ? undefined
    : createCaseFailure(result, answerPassed, safetyPassed);

  return {
    taskId: result.caseId,
    trial: result.trial,
    status: passed ? "passed" : "failed",
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.metrics.qaAccuracy === undefined
      ? {}
      : { reward: result.metrics.qaAccuracy }),
    metrics: {
      ...(result.metrics.qaAccuracy === undefined
        ? {}
        : { qa_accuracy: result.metrics.qaAccuracy }),
      ...(result.metrics.recallAt5 === undefined
        ? {}
        : { recall_at_5: result.metrics.recallAt5 }),
      ...(result.metrics.precisionAt5 === undefined
        ? {}
        : { precision_at_5: result.metrics.precisionAt5 }),
      ...(result.metrics.updateAccuracy === undefined
        ? {}
        : { update_accuracy: result.metrics.updateAccuracy }),
      ...(result.metrics.isolationAccuracy === undefined
        ? {}
        : {
            isolation_accuracy:
              result.metrics.isolationAccuracy,
          }),
      expected_abstention:
        result.metrics.expectedAbstention ? 1 : 0,
      ...(result.metrics.predictedAbstention === undefined
        ? {}
        : {
            predicted_abstention:
              result.metrics.predictedAbstention ? 1 : 0,
          }),
      memory_scope_leak_count:
        result.evidence.memoryScopeLeakCount,
      secret_persisted_count:
        result.evidence.secretPersistedCount,
    },
    ...(result.reader?.tokens === undefined
      ? {}
      : { tokens: result.reader.tokens }),
    ...(result.reader?.costUsd === undefined
      ? {}
      : { costUsd: result.reader.costUsd }),
    ...(failure === undefined ? {} : { failure }),
    artifacts: [evidence],
    metadata: {
      capability: result.capability,
      profile,
    },
  };
}

function createCaseFailure(
  result: LongMemEvalCaseResult,
  answerPassed: boolean,
  safetyPassed: boolean,
): EvaluationFailure {
  if (!safetyPassed) {
    return {
      category: "bumblebee",
      code: "LONGMEMEVAL_SAFETY_FAILED",
      message: "Memory scope or secret-persistence check failed",
    };
  }
  if (
    !result.evidence.operationChecksPassed ||
    !result.evidence.stateChecksPassed
  ) {
    return {
      category: "bumblebee",
      code: "LONGMEMEVAL_MEMORY_STATE_FAILED",
      message: "Memory operation or persisted-state check failed",
    };
  }
  if (!answerPassed) {
    return {
      category: "model",
      code: "LONGMEMEVAL_QA_FAILED",
      message: "The model answer did not satisfy the frozen rubric",
    };
  }
  return {
    category: "bumblebee",
    code: "LONGMEMEVAL_CASE_FAILED",
    message: "LongMemEval-Bumblebee case failed",
  };
}

function createRunInput(
  options: RunLongMemEvalOptions,
): StartEvaluationRunInput {
  return {
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    scoreSpec: options.manifest.scoreSpec.id,
    suite: {
      id: options.manifest.id,
      name: "LongMemEval-Bumblebee",
      version: options.manifest.version,
      split: "release",
      datasetHash: options.datasetSha256,
    },
    subject: {
      bumblebeeCommit: options.bumblebeeCommit,
      workspaceClean: options.workspaceClean,
      piVersion: options.observedPiVersion,
    },
    environment: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hardwareProfile: options.hardwareProfile,
    },
    ...(options.model === undefined
      ? {}
      : { model: options.model }),
    budget: {
      timeoutMs: options.manifest.reader.taskTimeoutMs,
      concurrency: 1,
    },
    repetitions:
      options.manifest.profiles[options.profile].repetitions,
    metadata: {
      profile: options.profile,
      officialLeaderboardCompatible: false,
      sourceBenchmark: "LongMemEval",
    },
  };
}

function assertReaderConfiguration(
  options: RunLongMemEvalOptions,
): void {
  const profile = options.manifest.profiles[options.profile];
  if (profile.reader === "pi" && options.reader === undefined) {
    throw new Error(
      "bumblebee-full requires a configured pi memory reader",
    );
  }
  if (profile.reader === "none" && options.reader !== undefined) {
    throw new Error("memory-core must not invoke a model reader");
  }
  if (profile.reader === "pi" && options.model === undefined) {
    throw new Error("bumblebee-full requires model identity");
  }
}

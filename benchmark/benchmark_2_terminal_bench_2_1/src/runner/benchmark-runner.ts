import {
  EvaluationRunStore,
  type StartEvaluationRunInput,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  TERMINAL_BENCH_CONTRACT_VERSION,
  type NormalizedTerminalBenchJob,
  type TerminalBenchBudgetManifest,
  type TerminalBenchManifest,
  type TerminalBenchReport,
} from "../contracts/index.js";
import { aggregateTerminalBench } from "../scoring/index.js";

export interface RunTerminalBenchImportOptions {
  readonly manifest: TerminalBenchManifest;
  readonly job: NormalizedTerminalBenchJob;
  readonly outputDirectory: string;
  readonly budget?: TerminalBenchBudgetManifest;
  readonly parentRunId?: string;
  readonly clock?: () => Date;
}

export async function runTerminalBenchImport(
  options: RunTerminalBenchImportOptions,
): Promise<TerminalBenchReport> {
  const clock = options.clock ?? (() => new Date());
  const aggregation = aggregateTerminalBench(
    options.manifest,
    options.job,
    options.budget,
  );
  const store = new EvaluationRunStore({
    outputDirectory: options.outputDirectory,
    clock,
  });
  const run = await store.startRun(createRunInput(options));
  const provenance = await run.recordJsonArtifact({
    relativePath: "harbor/provenance.json",
    kind: "verifier",
    mediaType: "application/json",
    value: {
      harborJobId: options.job.jobId,
      datasetId: options.job.datasetId,
      datasetReference: options.job.datasetReference,
      datasetHash: options.job.datasetHash,
      ...options.job.provenance,
    },
  });

  for (const trial of options.job.trials) {
    await run.recordTask({
      taskId: trial.taskId,
      trial: trial.trial,
      status: trial.status,
      startedAt: trial.startedAt,
      finishedAt: trial.finishedAt,
      durationMs: trial.durationMs,
      ...(trial.reward === undefined
        ? {}
        : { reward: trial.reward }),
      metrics: {
        agent_duration_ms: trial.agentDurationMs,
        stable: trial.stable ? 1 : 0,
      },
      ...(trial.tokens === undefined
        ? {}
        : { tokens: trial.tokens }),
      ...(trial.costUsd === undefined
        ? {}
        : { costUsd: trial.costUsd }),
      ...(trial.failure === undefined
        ? {}
        : { failure: trial.failure }),
      artifacts: [provenance],
      metadata: {
        harborTrialId: trial.harborTrialId,
        harborTrialName: trial.trialName,
        taskChecksum: trial.taskChecksum,
        datasetReference: trial.datasetReference,
        agentName: trial.identity.agentName,
        agentVersion: trial.identity.agentVersion,
        modelProvider: trial.identity.modelProvider,
        modelName: trial.identity.modelName,
        ...(trial.identity.thinkingLevel === undefined
          ? {}
          : {
              thinkingLevel: trial.identity.thinkingLevel,
            }),
        stable: trial.stable,
      },
    });
  }

  const report: TerminalBenchReport = Object.freeze({
    contractVersion: TERMINAL_BENCH_CONTRACT_VERSION,
    runId: run.manifest.runId,
    manifestId: options.manifest.id,
    manifestVersion: options.manifest.version,
    harborJobId: options.job.jobId,
    generatedAt: clock().toISOString(),
    datasetHash: options.job.datasetHash,
    trialCount: options.job.trials.length,
    componentScores: aggregation.componentScores,
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    score: aggregation.score,
    provenance: options.job.provenance,
  });
  await run.recordJsonArtifact({
    relativePath: "report.json",
    kind: "report",
    mediaType: "application/json",
    value: report,
  });

  const invalidRun =
    aggregation.gateEvaluation.status === "invalid";
  await run.finalize({
    status: invalidRun ? "invalid" : "completed",
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    compositeScore: aggregation.score,
    ...(invalidRun
      ? {
          failure: {
            category: "infrastructure" as const,
            code: "INVALID_TERMINAL_BENCH_IMPORT",
            message:
              "Harbor job did not satisfy the frozen validity gates",
            retryable: true,
          },
        }
      : {}),
  });

  return report;
}

function createRunInput(
  options: RunTerminalBenchImportOptions,
): StartEvaluationRunInput {
  const identity = options.job.trials[0]?.identity;
  const extensionCommit =
    options.job.trials[0]?.extensionCommit ?? "unknown";
  const minimumTrials = minimumTrialsPerTask(options.job);
  const observedDuration = options.job.trials.reduce(
    (total, trial) => total + trial.durationMs,
    0,
  );

  return {
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    scoreSpec: options.manifest.scoreSpec.id,
    suite: {
      id: options.manifest.id,
      name: "Terminal-Bench 2.1 Lite",
      version: options.manifest.version,
      split: "release",
      datasetHash: options.job.datasetHash,
    },
    subject: {
      bumblebeeCommit: extensionCommit,
      workspaceClean: extensionCommit !== "unknown",
      piVersion: identity?.agentVersion ?? "unknown",
    },
    environment: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hardwareProfile:
        `harbor-${options.job.environmentType}`,
    },
    ...(identity === undefined
      ? {}
      : {
          model: {
            provider: identity.modelProvider,
            id: identity.modelName,
            ...(identity.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: identity.thinkingLevel }),
          },
        }),
    budget: {
      timeoutMs: Math.max(1, observedDuration),
      concurrency: options.job.concurrency,
    },
    repetitions: Math.max(1, minimumTrials),
    metadata: {
      harborJobId: options.job.jobId,
      datasetReference: options.job.datasetReference,
      configSha256: options.job.provenance.configSha256,
      resultSha256: options.job.provenance.resultSha256,
      trialResultsSha256:
        options.job.provenance.trialResultsSha256,
      upstreamTrialCount: options.job.nTotalTrials,
      sourceTaskCount:
        options.manifest.dataset.sourceTaskCount,
      selectedTaskCount:
        options.manifest.dataset.expectedTaskCount,
      samplingFraction:
        options.manifest.dataset.samplingFraction,
      selectionMethod:
        options.manifest.dataset.selectionMethod,
    },
  };
}

function minimumTrialsPerTask(
  job: NormalizedTerminalBenchJob,
): number {
  const counts = new Map<string, number>();
  for (const trial of job.trials) {
    counts.set(
      trial.taskId,
      (counts.get(trial.taskId) ?? 0) + 1,
    );
  }
  return counts.size === 0
    ? 0
    : Math.min(...counts.values());
}

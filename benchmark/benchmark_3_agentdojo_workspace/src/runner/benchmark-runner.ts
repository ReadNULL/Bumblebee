import {
  EvaluationRunStore,
  type ArtifactReference,
  type EvaluationFailure,
  type StartEvaluationRunInput,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  AGENTDOJO_CONTRACT_VERSION,
  type AgentDojoAttackCase,
  type AgentDojoCleanCase,
  type AgentDojoInjectionUtilityCase,
  type AgentDojoManifest,
  type AgentDojoReport,
  type NormalizedAgentDojoRun,
} from "../contracts/index.js";
import { aggregateAgentDojo } from "../scoring/index.js";

export interface RunAgentDojoImportOptions {
  readonly manifest: AgentDojoManifest;
  readonly result: NormalizedAgentDojoRun;
  readonly outputDirectory: string;
  readonly hardwareProfile: string;
  readonly parentRunId?: string;
  readonly clock?: () => Date;
}

export async function runAgentDojoImport(
  options: RunAgentDojoImportOptions,
): Promise<AgentDojoReport> {
  const clock = options.clock ?? (() => new Date());
  const aggregation = aggregateAgentDojo(
    options.manifest,
    options.result,
  );
  const store = new EvaluationRunStore({
    outputDirectory: options.outputDirectory,
    clock,
  });
  const run = await store.startRun(createRunInput(options));
  const provenance = await run.recordJsonArtifact({
    relativePath: "agentdojo/provenance.json",
    kind: "verifier",
    mediaType: "application/json",
    value: {
      adapterRunId: options.result.adapterRunId,
      adapterVersion: options.result.adapterVersion,
      dataset: options.result.dataset,
      subject: options.result.subject,
      model: options.result.model,
      bridge: options.result.bridge,
      selection: options.result.selection,
      source: options.result.provenance,
    },
  });
  const traceArtifact = await run.recordJsonArtifact({
    relativePath: "agentdojo/pi-traces.json",
    kind: "trajectory",
    mediaType: "application/json",
    value: options.result.traces,
  });

  for (const result of options.result.cleanCases) {
    await recordCleanCase(
      run,
      options.result,
      result,
      [provenance, traceArtifact],
    );
  }
  for (const result of options.result.attackCases) {
    await recordAttackCase(
      run,
      options.result,
      result,
      [provenance, traceArtifact],
    );
  }
  for (const result of options.result.injectionUtilityCases) {
    await recordInjectionUtilityCase(
      run,
      options.result,
      result,
      [provenance, traceArtifact],
    );
  }
  if (options.result.status === "failed") {
    await run.recordTask({
      taskId: `adapter.${options.result.adapterRunId}`,
      trial: 1,
      status: "invalid",
      startedAt: options.result.startedAt,
      finishedAt: options.result.finishedAt,
      durationMs: options.result.durationMs,
      failure: options.result.failure as EvaluationFailure,
      artifacts: [provenance, traceArtifact],
      metadata: {
        phase: "adapter",
      },
    });
  }

  const report: AgentDojoReport = Object.freeze({
    contractVersion: AGENTDOJO_CONTRACT_VERSION,
    runId: run.manifest.runId,
    manifestId: options.manifest.id,
    manifestVersion: options.manifest.version,
    adapterRunId: options.result.adapterRunId,
    generatedAt: clock().toISOString(),
    datasetHash: options.result.dataset.contentSha256,
    subject: options.result.subject,
    model: options.result.model,
    cleanCaseCount: options.result.cleanCases.length,
    attackCaseCount: options.result.attackCases.length,
    componentScores: aggregation.componentScores,
    metrics: aggregation.metrics,
    gateEvaluation: aggregation.gateEvaluation,
    score: aggregation.score,
    provenance: options.result.provenance,
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
    ...(invalidRun
      ? {
          failure: {
            category: "infrastructure" as const,
            code: "INVALID_AGENTDOJO_IMPORT",
            message:
              "AgentDojo result did not satisfy the frozen validity gates",
            retryable: true,
          },
        }
      : {}),
  });

  return report;
}

async function recordCleanCase(
  run: Awaited<
    ReturnType<EvaluationRunStore["startRun"]>
  >,
  source: NormalizedAgentDojoRun,
  result: AgentDojoCleanCase,
  artifacts: readonly ArtifactReference[],
): Promise<void> {
  await run.recordTask({
    taskId: `clean.${result.userTaskId}`,
    trial: 1,
    status: result.utility ? "passed" : "failed",
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    durationMs: 0,
    reward: result.utility ? 1 : 0,
    metrics: { utility: result.utility ? 1 : 0 },
    ...(!result.utility
      ? {
          failure: {
            category: "model" as const,
            code: "AGENTDOJO_UTILITY_FAILED",
            message: "AgentDojo clean task utility check failed",
          },
        }
      : {}),
    artifacts,
    metadata: {
      phase: "clean",
      userTaskId: result.userTaskId,
      timingGranularity: "run-only",
    },
  });
}

async function recordAttackCase(
  run: Awaited<
    ReturnType<EvaluationRunStore["startRun"]>
  >,
  source: NormalizedAgentDojoRun,
  result: AgentDojoAttackCase,
  artifacts: readonly ArtifactReference[],
): Promise<void> {
  const passed = result.utility && result.security;
  await run.recordTask({
    taskId:
      `attack.${result.userTaskId}.${result.injectionTaskId}`,
    trial: 1,
    status: passed ? "passed" : "failed",
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    durationMs: 0,
    metrics: {
      utility: result.utility ? 1 : 0,
      security: result.security ? 1 : 0,
      targeted_attack_success: result.security ? 0 : 1,
    },
    ...(!passed
      ? {
          failure: attackFailure(result),
        }
      : {}),
    artifacts,
    metadata: {
      phase: "attack",
      userTaskId: result.userTaskId,
      injectionTaskId: result.injectionTaskId,
      timingGranularity: "run-only",
    },
  });
}

async function recordInjectionUtilityCase(
  run: Awaited<
    ReturnType<EvaluationRunStore["startRun"]>
  >,
  source: NormalizedAgentDojoRun,
  result: AgentDojoInjectionUtilityCase,
  artifacts: readonly ArtifactReference[],
): Promise<void> {
  await run.recordTask({
    taskId: `injection-utility.${result.injectionTaskId}`,
    trial: 1,
    status: result.utility ? "passed" : "failed",
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    durationMs: 0,
    metrics: { utility: result.utility ? 1 : 0 },
    ...(!result.utility
      ? {
          failure: {
            category: "model" as const,
            code: "AGENTDOJO_INJECTION_TASK_UNSOLVED",
            message:
              "Injection goal could not be completed when requested directly",
          },
        }
      : {}),
    artifacts,
    metadata: {
      phase: "injection-utility",
      injectionTaskId: result.injectionTaskId,
      timingGranularity: "run-only",
    },
  });
}

function attackFailure(
  result: AgentDojoAttackCase,
): EvaluationFailure {
  if (!result.utility && !result.security) {
    return {
      category: "model",
      code: "AGENTDOJO_UTILITY_AND_SECURITY_FAILED",
      message:
        "User utility failed and the targeted injection succeeded",
    };
  }
  if (!result.utility) {
    return {
      category: "model",
      code: "AGENTDOJO_ATTACK_UTILITY_FAILED",
      message: "User utility failed under prompt injection",
    };
  }
  return {
    category: "model",
    code: "AGENTDOJO_TARGETED_ATTACK_SUCCEEDED",
    message: "The targeted injection goal succeeded",
  };
}

function createRunInput(
  options: RunAgentDojoImportOptions,
): StartEvaluationRunInput {
  const observedDuration = Math.max(
    1,
    options.result.durationMs,
  );
  return {
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    scoreSpec: options.manifest.scoreSpec.id,
    suite: {
      id: options.manifest.id,
      name: "AgentDojo Workspace",
      version: options.manifest.version,
      split: "release",
      datasetHash: options.result.dataset.contentSha256,
    },
    subject: {
      bumblebeeCommit:
        options.result.subject.bumblebeeCommit ?? "baseline",
      workspaceClean: options.result.subject.workspaceClean,
      piVersion: options.result.subject.piVersion,
    },
    environment: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hardwareProfile: options.hardwareProfile,
    },
    model: {
      provider: options.result.model.provider,
      id: options.result.model.model,
      ...(options.result.model.thinkingLevel === undefined
        ? {}
        : {
            thinkingLevel:
              options.result.model.thinkingLevel,
          }),
    },
    budget: {
      timeoutMs: Math.max(
        observedDuration,
        options.manifest.bridge.taskTimeoutMs,
      ),
      concurrency: 1,
    },
    repetitions: 1,
    metadata: {
      adapterRunId: options.result.adapterRunId,
      adapterVersion: options.result.adapterVersion,
      agentProfile: options.result.subject.profile,
      approvalPolicy: options.result.bridge.approvalPolicy,
      attack: options.result.dataset.attack,
      benchmarkVersion:
        options.result.dataset.benchmarkVersion,
      sourceSha256:
        options.result.provenance.sourceSha256,
    },
  };
}

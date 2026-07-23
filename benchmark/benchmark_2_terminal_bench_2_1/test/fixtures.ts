import { readFileSync } from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  calibrateTerminalBenchBudget,
  normalizeHarborJob,
  parseTerminalBenchManifest,
  type HarborJobProvenance,
  type NormalizedTerminalBenchJob,
  type TerminalBenchBudgetManifest,
  type TerminalBenchManifest,
} from "../src/index.js";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPath = resolve(
  benchmarkRoot,
  "manifests/terminal-bench-2-1-v1.json",
);
const candidateExtension =
  "git:github.com/ReadNULL/Bumblebee@" +
  "0123456789abcdef0123456789abcdef01234567";

export interface FixtureJobOptions {
  readonly jobId?: string;
  readonly agentName?: "bumblebee-pi" | "pi-baseline";
  readonly costUsd?: number;
  readonly agentDurationMs?: number;
  readonly rewards?: readonly number[];
  readonly exceptionType?: string;
  readonly omitExtension?: boolean;
}

export function createTestManifest(): TerminalBenchManifest {
  const source = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as {
    dataset: {
      expectedTaskCount: number;
      minimumTrialsPerTask: number;
    };
    baseline: {
      minimumSamplesPerTask: number;
    };
    scoreSpec: {
      hardGates: Array<{
        id: string;
        threshold: number;
      }>;
    };
  };
  source.dataset.expectedTaskCount = 2;
  source.dataset.minimumTrialsPerTask = 2;
  source.baseline.minimumSamplesPerTask = 3;
  const repetitionGate = source.scoreSpec.hardGates.find(
    (gate) => gate.id === "trial_repetitions",
  );
  if (repetitionGate !== undefined) {
    repetitionGate.threshold = 2;
  }
  return parseTerminalBenchManifest(source);
}

export function createNormalizedFixtureJob(
  manifest: TerminalBenchManifest,
  options: FixtureJobOptions = {},
): NormalizedTerminalBenchJob {
  const raw = createRawFixtureJob(manifest, options);
  return normalizeHarborJob(
    raw.config,
    raw.result,
    provenance(options.jobId ?? "job-candidate-1"),
    manifest,
  );
}

export function createRawFixtureJob(
  manifest: TerminalBenchManifest,
  options: FixtureJobOptions = {},
) {
  const agentName = options.agentName ?? "bumblebee-pi";
  return {
    config: createRawConfig(
      manifest,
      options.jobId ?? "job-candidate-1",
    ),
    result: createRawResult(manifest, {
      ...options,
      agentName,
    }),
  };
}

export function createCalibratedBudget(
  manifest: TerminalBenchManifest,
): TerminalBenchBudgetManifest {
  const jobs = [1, 2, 3].map((index) =>
    createNormalizedFixtureJob(manifest, {
      jobId: `job-baseline-${index}`,
      agentName: "pi-baseline",
      costUsd: index,
      agentDurationMs: index * 1_000,
      omitExtension: true,
    })
  );
  return calibrateTerminalBenchBudget(
    manifest,
    jobs,
    () => new Date("2026-07-23T12:00:00.000Z"),
  );
}

export function getCandidateExtension(): string {
  return candidateExtension;
}

function createRawConfig(
  manifest: TerminalBenchManifest,
  jobId: string,
) {
  return {
    job_name: jobId,
    n_concurrent_trials: 2,
    environment: {
      type: "docker",
    },
    datasets: [
      {
        name: manifest.dataset.id,
        ref: "sha256:fixture-dataset",
      },
    ],
  };
}

function createRawResult(
  manifest: TerminalBenchManifest,
  options: FixtureJobOptions & {
    readonly agentName: "bumblebee-pi" | "pi-baseline";
  },
) {
  const jobId = options.jobId ?? "job-candidate-1";
  const taskIds = ["task-alpha", "task-beta"];
  const rewards = options.rewards ?? [1, 1, 1, 1];
  const trials = taskIds.flatMap((taskId, taskIndex) =>
    [0, 1].map((trialIndex) => {
      const index = taskIndex * 2 + trialIndex;
      const started = new Date(
        Date.parse("2026-07-23T10:00:00.000Z") +
          index * 10_000,
      );
      const agentStarted = new Date(started.getTime() + 100);
      const agentFinished = new Date(
        agentStarted.getTime() +
          (options.agentDurationMs ?? 2_000),
      );
      const finished = new Date(agentFinished.getTime() + 100);
      return {
        id: `${jobId}-${taskId}-${trialIndex}`,
        task_name: taskId,
        trial_name: `${taskId}__${trialIndex}`,
        trial_uri: `file:///jobs/${jobId}/${taskId}`,
        task_id: {
          org: "terminal-bench",
          name: taskId,
          ref: "fixture",
        },
        source: manifest.dataset.id,
        task_checksum: `checksum-${taskId}`,
        config: {
          task: {
            name: `terminal-bench/${taskId}`,
            ref: "fixture",
            source: manifest.dataset.id,
          },
          agent: {
            name: options.agentName,
            model_name: "openai/gpt-fixture",
            kwargs:
              options.agentName === "bumblebee-pi" &&
                !options.omitExtension
                ? {
                    bumblebee_extension: candidateExtension,
                    thinking: "high",
                  }
                : {
                    thinking: "high",
                  },
          },
          environment: {
            type: "docker",
          },
        },
        agent_info: {
          name: options.agentName,
          version: manifest.agents.piVersion,
          model_info: {
            provider: "openai",
            name: "gpt-fixture",
          },
        },
        agent_result: {
          n_input_tokens: 100 + index,
          n_cache_tokens: 10,
          n_output_tokens: 20,
          cost_usd: options.costUsd ?? 2,
        },
        verifier_result: {
          rewards: {
            [manifest.rewardKey]: rewards[index] ?? 1,
          },
        },
        ...(options.exceptionType === undefined || index !== 0
          ? {}
          : {
              exception_info: {
                exception_type: options.exceptionType,
                exception_message: "fixture error",
                exception_traceback: "fixture traceback",
                occurred_at: finished.toISOString(),
              },
            }),
        started_at: started.toISOString(),
        finished_at: finished.toISOString(),
        agent_execution: {
          started_at: agentStarted.toISOString(),
          finished_at: agentFinished.toISOString(),
        },
      };
    })
  );

  return {
    id: jobId,
    started_at: "2026-07-23T09:59:00.000Z",
    updated_at: "2026-07-23T10:02:00.000Z",
    finished_at: "2026-07-23T10:02:00.000Z",
    n_total_trials: trials.length,
    stats: {
      n_completed_trials: trials.length,
    },
    trial_results: trials,
  };
}

function provenance(jobId: string): HarborJobProvenance {
  return {
    configSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    trialResultsSha256: "c".repeat(64),
    sourceDirectoryName: jobId,
  };
}

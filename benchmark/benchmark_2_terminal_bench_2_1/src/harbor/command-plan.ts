import {
  invalid,
  type HarborRunMode,
  type HarborRunPlan,
  type TerminalBenchManifest,
} from "../contracts/index.js";
import { extractPinnedGitCommit } from "../importer/index.js";

const AGENT_MODULE =
  "benchmark.benchmark_2_terminal_bench_2_1." +
  "harbor_agent.pi_agent";
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface CreateHarborRunPlanOptions {
  readonly mode: HarborRunMode;
  readonly model: string;
  readonly environment: string;
  readonly concurrency: number;
  readonly jobName: string;
  readonly extensionSource?: string;
  readonly thinking?: string;
}

export function createHarborRunPlan(
  manifest: TerminalBenchManifest,
  options: CreateHarborRunPlanOptions,
): HarborRunPlan {
  assertModel(options.model);
  assertSimpleValue(options.environment, "environment");
  assertSimpleValue(options.jobName, "jobName");
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency <= 0
  ) {
    invalid("Harbor concurrency must be a positive integer");
  }

  const agentClass = options.mode === "baseline"
    ? "PinnedPi"
    : "BumblebeePi";
  const arguments_: string[] = [
    "run",
    "-d",
    manifest.dataset.id,
    "-a",
    `${AGENT_MODULE}:${agentClass}`,
    "-m",
    options.model,
    "-e",
    options.environment,
    "-k",
    String(manifest.dataset.minimumTrialsPerTask),
    "-n",
    String(options.concurrency),
    "--job-name",
    options.jobName,
  ];
  for (const task of manifest.dataset.selectedTasks) {
    arguments_.push("--include-task-name", task.id);
  }
  if (options.thinking !== undefined) {
    assertSimpleValue(options.thinking, "thinking");
    if (
      !THINKING_LEVELS.includes(
        options.thinking as (typeof THINKING_LEVELS)[number],
      )
    ) {
      invalid("thinking is not supported by the pinned Pi adapter");
    }
    arguments_.push("--ak", `thinking=${options.thinking}`);
  }
  if (options.mode === "candidate") {
    const extensionSource = options.extensionSource;
    if (
      extensionSource === undefined ||
      !extensionSource.startsWith(
        manifest.agents.extensionSourcePrefix,
      ) ||
      extractPinnedGitCommit(extensionSource) === undefined
    ) {
      invalid(
        "candidate run requires a commit-pinned git extension source",
      );
    }
    arguments_.push(
      "--ak",
      `bumblebee_extension=${extensionSource}`,
    );
  } else if (options.extensionSource !== undefined) {
    invalid("pi-baseline must not load the Bumblebee extension");
  }

  return Object.freeze({
    executable: "harbor",
    arguments: Object.freeze(arguments_),
    displayCommand: [
      "harbor",
      ...arguments_.map(quoteForShell),
    ].join(" "),
  });
}

function assertModel(model: string): void {
  const separator = model.indexOf("/");
  if (
    separator <= 0 ||
    separator === model.length - 1 ||
    /\s/u.test(model)
  ) {
    invalid("Harbor model must use provider/model format");
  }
}

function assertSimpleValue(value: string, field: string): void {
  if (
    value.trim().length === 0 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    invalid(`${field} contains an invalid value`, { field });
  }
}

function quoteForShell(value: string): string {
  if (/^[a-zA-Z0-9_./:@=+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

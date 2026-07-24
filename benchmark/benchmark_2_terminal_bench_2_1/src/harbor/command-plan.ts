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
const AGENT_SETUP_TIMEOUT_MULTIPLIER = "3";
const MAX_TRANSIENT_RETRIES = "2";
const TRANSIENT_RETRY_EXCEPTIONS = [
  "ApiOverloadedError",
  "ApiRateLimitError",
  "ApiInternalServerError",
  "NetworkConnectionError",
  "UnknownApiError",
] as const;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const BUMBLEBEE_PROFILES = [
  "pi-baseline",
  "permission-only",
  "full",
] as const;

export type BumblebeeBenchmarkProfile =
  (typeof BUMBLEBEE_PROFILES)[number];

export interface CreateHarborRunPlanOptions {
  readonly mode: HarborRunMode;
  readonly model: string;
  readonly environment: string;
  readonly concurrency: number;
  readonly jobName: string;
  readonly extensionSource?: string;
  readonly thinking?: string;
  readonly taskIds?: readonly string[];
  readonly repetitions?: number;
  readonly profile?: BumblebeeBenchmarkProfile;
}

export interface CreateHarborPreflightPlanOptions {
  readonly environment: string;
  readonly concurrency: number;
  readonly jobName: string;
  readonly taskIds?: readonly string[];
}

export function createHarborRunPlan(
  manifest: TerminalBenchManifest,
  options: CreateHarborRunPlanOptions,
): HarborRunPlan {
  assertModel(options.model);
  assertSimpleValue(options.environment, "environment");
  assertSimpleValue(options.jobName, "jobName");
  assertPositiveInteger(options.concurrency, "Harbor concurrency");
  const repetitions =
    options.repetitions ?? manifest.dataset.minimumTrialsPerTask;
  assertPositiveInteger(repetitions, "Harbor repetitions");
  const taskIds = resolveTaskIds(manifest, options.taskIds);

  const agentClass = options.mode === "baseline"
    ? "PinnedPi"
    : "BumblebeePi";
  const arguments_: string[] = [
    "-m",
    "harbor.cli.main",
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
    String(repetitions),
    "-n",
    String(options.concurrency),
    "--agent-setup-timeout-multiplier",
    AGENT_SETUP_TIMEOUT_MULTIPLIER,
    "--max-retries",
    MAX_TRANSIENT_RETRIES,
    "--job-name",
    options.jobName,
  ];
  for (const exception of TRANSIENT_RETRY_EXCEPTIONS) {
    arguments_.push("--retry-include", exception);
  }
  for (const taskId of taskIds) {
    arguments_.push("--include-task-name", taskId);
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
      "--ak",
      `bumblebee_profile=${resolveProfile(options.profile)}`,
    );
  } else if (
    options.extensionSource !== undefined ||
    options.profile !== undefined
  ) {
    invalid(
      "pi-baseline must not load or configure the Bumblebee extension",
    );
  }

  return createPlan(arguments_);
}

export function createHarborPreflightPlan(
  manifest: TerminalBenchManifest,
  options: CreateHarborPreflightPlanOptions,
): HarborRunPlan {
  assertSimpleValue(options.environment, "environment");
  assertSimpleValue(options.jobName, "jobName");
  assertPositiveInteger(options.concurrency, "Harbor concurrency");
  const arguments_: string[] = [
    "-m",
    "harbor.cli.main",
    "run",
    "-d",
    manifest.dataset.id,
    "-a",
    `${AGENT_MODULE}:VerifierPreflight`,
    "-e",
    options.environment,
    "-k",
    "1",
    "-n",
    String(options.concurrency),
    "--agent-setup-timeout-multiplier",
    AGENT_SETUP_TIMEOUT_MULTIPLIER,
    "--max-retries",
    MAX_TRANSIENT_RETRIES,
    "--job-name",
    options.jobName,
  ];
  for (const exception of TRANSIENT_RETRY_EXCEPTIONS) {
    arguments_.push("--retry-include", exception);
  }
  for (const taskId of resolveTaskIds(
    manifest,
    options.taskIds,
  )) {
    arguments_.push("--include-task-name", taskId);
  }
  return createPlan(arguments_);
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

function assertPositiveInteger(
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer`);
  }
}

function resolveTaskIds(
  manifest: TerminalBenchManifest,
  requested: readonly string[] | undefined,
): readonly string[] {
  const taskIds =
    requested ?? manifest.dataset.selectedTasks.map((task) => task.id);
  if (taskIds.length === 0) {
    invalid("Harbor task selection must not be empty");
  }
  const allowed = new Set(
    manifest.dataset.selectedTasks.map((task) => task.id),
  );
  const unique = new Set<string>();
  for (const taskId of taskIds) {
    assertSimpleValue(taskId, "taskId");
    if (!allowed.has(taskId)) {
      invalid("Harbor task selection is outside the frozen manifest", {
        taskId,
      });
    }
    if (unique.has(taskId)) {
      invalid("Harbor task selection contains a duplicate", {
        taskId,
      });
    }
    unique.add(taskId);
  }
  return Object.freeze([...taskIds]);
}

function resolveProfile(
  profile: BumblebeeBenchmarkProfile | undefined,
): BumblebeeBenchmarkProfile {
  const resolved = profile ?? "full";
  if (!BUMBLEBEE_PROFILES.includes(resolved)) {
    invalid("unsupported Bumblebee benchmark profile", {
      profile: resolved,
    });
  }
  return resolved;
}

function createPlan(arguments_: string[]): HarborRunPlan {
  return Object.freeze({
    executable: "python",
    arguments: Object.freeze(arguments_),
    displayCommand: [
      "python",
      ...arguments_.map(quoteForShell),
    ].join(" "),
  });
}

function quoteForShell(value: string): string {
  if (/^[a-zA-Z0-9_./:@=+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

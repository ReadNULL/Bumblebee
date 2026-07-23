import {
  invalid,
  type AgentDojoManifest,
  type AgentDojoRunPlan,
  type AgentDojoSubjectProfile,
} from "../contracts/index.js";

const RUNNER_MODULE =
  "benchmark.benchmark_3_agentdojo_workspace." +
  "agentdojo_bridge.run";
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface CreateAgentDojoRunPlanOptions {
  readonly profile: AgentDojoSubjectProfile;
  readonly pythonExecutable: string;
  readonly manifestPath: string;
  readonly provider: string;
  readonly model: string;
  readonly outputPath: string;
  readonly logDirectory: string;
  readonly bumblebeeCommit?: string;
  readonly workspaceClean?: boolean;
  readonly thinkingLevel?: string;
  readonly userTaskIds?: readonly string[];
  readonly injectionTaskIds?: readonly string[];
  readonly forceRerun?: boolean;
}

export function createAgentDojoRunPlan(
  manifest: AgentDojoManifest,
  options: CreateAgentDojoRunPlanOptions,
): AgentDojoRunPlan {
  assertSimple(options.pythonExecutable, "pythonExecutable");
  assertSimple(options.provider, "provider");
  assertSimple(options.model, "model");
  assertSimple(options.manifestPath, "manifestPath");
  assertSimple(options.outputPath, "outputPath");
  assertSimple(options.logDirectory, "logDirectory");
  assertThinkingLevel(options.thinkingLevel);
  assertUniqueIds(options.userTaskIds ?? [], "userTaskIds");
  assertUniqueIds(
    options.injectionTaskIds ?? [],
    "injectionTaskIds",
  );
  assertSubject(options, manifest);

  const arguments_: string[] = [
    "-m",
    RUNNER_MODULE,
    "--manifest",
    options.manifestPath,
    "--profile",
    options.profile,
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--output",
    options.outputPath,
    "--logdir",
    options.logDirectory,
  ];
  if (options.thinkingLevel !== undefined) {
    arguments_.push("--thinking", options.thinkingLevel);
  }
  if (options.profile === manifest.agents.candidate) {
    arguments_.push(
      "--bumblebee-commit",
      options.bumblebeeCommit as string,
      "--workspace-clean",
    );
  }
  for (const taskId of options.userTaskIds ?? []) {
    arguments_.push("--user-task", taskId);
  }
  for (const taskId of options.injectionTaskIds ?? []) {
    arguments_.push("--injection-task", taskId);
  }
  // Formal runs collect fresh traces; cached AgentDojo results are diagnostic.
  if (options.forceRerun !== false) {
    arguments_.push("--force-rerun");
  }

  return Object.freeze({
    executable: options.pythonExecutable,
    arguments: Object.freeze(arguments_),
    displayCommand: [
      quoteForShell(options.pythonExecutable),
      ...arguments_.map(quoteForShell),
    ].join(" "),
  });
}

function assertSubject(
  options: CreateAgentDojoRunPlanOptions,
  manifest: AgentDojoManifest,
): void {
  if (options.profile === manifest.agents.baseline) {
    if (
      options.bumblebeeCommit !== undefined ||
      options.workspaceClean === true
    ) {
      invalid(
        "pi-baseline must not claim a Bumblebee commit",
      );
    }
    return;
  }

  const commit = options.bumblebeeCommit;
  if (
    commit === undefined ||
    !/^[a-f0-9]{40,64}$/u.test(commit)
  ) {
    invalid(
      "bumblebee-full requires a full commit SHA",
    );
  }
  if (options.workspaceClean !== true) {
    invalid(
      "bumblebee-full requires an explicitly clean workspace",
    );
  }
}

function assertThinkingLevel(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (
    !THINKING_LEVELS.includes(
      value as (typeof THINKING_LEVELS)[number],
    )
  ) {
    invalid("unsupported pi thinking level", { value });
  }
}

function assertUniqueIds(
  values: readonly string[],
  field: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertSimple(value, field);
    if (seen.has(value)) {
      invalid(`${field} contains a duplicate`, { value });
    }
    seen.add(value);
  }
}

function assertSimple(value: string, field: string): void {
  if (
    value.trim().length === 0 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    invalid(`${field} contains an invalid value`);
  }
}

function quoteForShell(value: string): string {
  if (/^[a-zA-Z0-9_./:\\@=+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

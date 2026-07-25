import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../src/foundation/index.js";
import {
  calibrateTerminalBenchBudget,
  createHarborPreflightPlan,
  createHarborRunPlan,
  parseTerminalBenchBudgetManifest,
  parseTerminalBenchManifest,
  readHarborJob,
  runAssuranceDevelopmentSuite,
  runTerminalBenchImport,
  type AssuranceSuiteSplit,
  type HarborRunMode,
  type BumblebeeBenchmarkProfile,
  type NormalizedTerminalBenchJob,
  type TerminalBenchManifest,
} from "./index.js";

const BENCHMARK_ROOT =
  "benchmark/benchmark_2_terminal_bench_2_1";
const DEFAULT_MANIFEST_PATH =
  `${BENCHMARK_ROOT}/manifests/terminal-bench-2-1-lite-v1.json`;
const DEFAULT_EVALUATION_OUTPUT =
  `${BENCHMARK_ROOT}/.runtime/evaluation`;
const DEFAULT_BUDGET_OUTPUT =
  `${BENCHMARK_ROOT}/.runtime/baselines/pi-baseline-lite-v1.json`;

type CliCommand =
  | { readonly kind: "help" }
  | {
      readonly kind: "plan";
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
  | {
      readonly kind: "preflight";
      readonly environment: string;
      readonly concurrency: number;
      readonly jobName: string;
    }
  | {
      readonly kind: "audit-preflight";
      readonly jobDirectory: string;
    }
  | {
      readonly kind: "assurance";
      readonly split: AssuranceSuiteSplit | "all";
    }
  | {
      readonly kind: "calibrate";
      readonly jobDirectories: readonly string[];
      readonly outputPath: string;
    }
  | {
      readonly kind: "import";
      readonly jobDirectory: string;
      readonly outputDirectory: string;
      readonly budgetPath?: string;
      readonly parentRunId?: string;
    };

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const command = parseArguments(
    process.argv.slice(2),
    projectRoot,
  );
  if (command.kind === "help") {
    printHelp();
    return;
  }
  if (command.kind === "assurance") {
    const report = runAssuranceDevelopmentSuite(command.split);
    for (const result of report.results) {
      process.stdout.write(
        `${result.passed ? "PASS" : "FAIL"} ${result.id}: ${result.message}\n`,
      );
    }
    process.stdout.write(
      `assurance ${command.split}: ${report.passed}/${report.total} passed\n`,
    );
    process.exitCode = report.failed === 0 ? 0 : 2;
    return;
  }

  const manifest = await loadManifest(projectRoot);
  switch (command.kind) {
    case "plan": {
      const plan = createHarborRunPlan(manifest, command);
      process.stdout.write(`${plan.displayCommand}\n`);
      return;
    }
    case "preflight": {
      const plan = createHarborPreflightPlan(
        manifest,
        command,
      );
      process.stdout.write(`${plan.displayCommand}\n`);
      return;
    }
    case "audit-preflight": {
      const job = await readHarborJob(
        command.jobDirectory,
        manifest,
        { allowModelLessTrials: true },
      );
      const audit = auditPreflight(job, manifest);
      process.stdout.write(
        [
          `preflight: ${audit.status}`,
          `coverage: ${audit.coveredTasks}/${audit.expectedTasks}`,
          `verifier results: ${audit.rewardCount}/${audit.expectedTasks}`,
          ...(audit.failures.length === 0
            ? []
            : audit.failures.map((failure) => `- ${failure}`)),
          "",
        ].join("\n"),
      );
      process.exitCode = audit.status === "passed" ? 0 : 2;
      return;
    }
    case "calibrate": {
      const jobs = await Promise.all(
        command.jobDirectories.map((directory) =>
          readHarborJob(directory, manifest)
        ),
      );
      const budget = calibrateTerminalBenchBudget(
        manifest,
        jobs,
      );
      await writeJsonAtomic(command.outputPath, budget);
      process.stdout.write(
        [
          `baseline budget: ${command.outputPath}`,
          `dataset hash: ${budget.datasetHash}`,
          `source jobs: ${budget.sourceJobIds.join(", ")}`,
          "",
        ].join("\n"),
      );
      return;
    }
    case "import": {
      const [job, budget] = await Promise.all([
        readHarborJob(command.jobDirectory, manifest),
        command.budgetPath === undefined
          ? Promise.resolve(undefined)
          : loadBudget(command.budgetPath, manifest),
      ]);
      const report = await runTerminalBenchImport({
        manifest,
        job,
        outputDirectory: command.outputDirectory,
        ...(budget === undefined ? {} : { budget }),
        ...(command.parentRunId === undefined
          ? {}
          : { parentRunId: command.parentRunId }),
      });
      printReport(report, command.outputDirectory);
      process.exitCode =
        report.gateEvaluation.status === "qualified"
          ? 0
          : report.gateEvaluation.status === "not-qualified"
            ? 2
            : 3;
      return;
    }
  }
}

function parseArguments(
  arguments_: readonly string[],
  projectRoot: string,
): CliCommand {
  const command = arguments_[0];
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    return { kind: "help" };
  }
  const positional = arguments_.slice(1);
  if (
    positional.length > 0 &&
    !positional[0]?.startsWith("--")
  ) {
    return parsePositionalCommand(
      command,
      positional,
      projectRoot,
    );
  }
  const options = parseOptionMap(arguments_.slice(1));
  if (command === "plan") {
    assertKnownOptions(options, [
      "--mode",
      "--model",
      "--environment",
      "--concurrency",
      "--job-name",
      "--extension",
      "--thinking",
      "--tasks",
      "--repetitions",
      "--profile",
    ]);
    const mode = requireOption(options, "--mode");
    if (mode !== "baseline" && mode !== "candidate") {
      throw invalidArgument(
        "--mode must be baseline or candidate",
      );
    }
    const extensionSource = singleOption(
      options,
      "--extension",
    );
    const thinking = singleOption(options, "--thinking");
    const taskIds = parseTaskIds(
      singleOption(options, "--tasks"),
    );
    const repetitions = singleOption(
      options,
      "--repetitions",
    );
    const profile = singleOption(options, "--profile");
    return {
      kind: "plan",
      mode,
      model: requireOption(options, "--model"),
      environment:
        singleOption(options, "--environment") ?? "docker",
      concurrency: parsePositiveInteger(
        singleOption(options, "--concurrency") ?? "1",
        "--concurrency",
      ),
      jobName:
        singleOption(options, "--job-name") ??
        `tb21-${mode}`,
      ...(extensionSource === undefined
        ? {}
        : { extensionSource }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(taskIds === undefined ? {} : { taskIds }),
      ...(repetitions === undefined
        ? {}
        : {
            repetitions: parsePositiveInteger(
              repetitions,
              "--repetitions",
            ),
          }),
      ...(profile === undefined
        ? {}
        : { profile: parseFeatureProfile(profile) }),
    };
  }
  if (command === "preflight") {
    assertKnownOptions(options, [
      "--environment",
      "--concurrency",
      "--job-name",
    ]);
    return {
      kind: "preflight",
      environment:
        singleOption(options, "--environment") ?? "docker",
      concurrency: parsePositiveInteger(
        singleOption(options, "--concurrency") ?? "4",
        "--concurrency",
      ),
      jobName:
        singleOption(options, "--job-name") ??
        "tb21-verifier-preflight",
    };
  }
  if (command === "audit-preflight") {
    assertKnownOptions(options, ["--job"]);
    return {
      kind: "audit-preflight",
      jobDirectory: resolve(
        projectRoot,
        requireOption(options, "--job"),
      ),
    };
  }
  if (command === "assurance") {
    assertKnownOptions(options, ["--split"]);
    return {
      kind: "assurance",
      split: parseAssuranceSplit(
        singleOption(options, "--split") ?? "all",
      ),
    };
  }
  if (command === "calibrate") {
    assertKnownOptions(options, ["--job", "--output"]);
    const jobs = options.get("--job") ?? [];
    if (jobs.length === 0) {
      throw invalidArgument(
        "calibrate requires three --job directories",
      );
    }
    return {
      kind: "calibrate",
      jobDirectories: jobs.map((directory) =>
        resolve(projectRoot, directory)
      ),
      outputPath: resolve(
        projectRoot,
        singleOption(options, "--output") ??
          DEFAULT_BUDGET_OUTPUT,
      ),
    };
  }
  if (command === "import") {
    assertKnownOptions(options, [
      "--job",
      "--budget",
      "--output",
      "--parent-run-id",
    ]);
    const budgetPath = singleOption(options, "--budget");
    const parentRunId = singleOption(
      options,
      "--parent-run-id",
    );
    return {
      kind: "import",
      jobDirectory: resolve(
        projectRoot,
        requireOption(options, "--job"),
      ),
      outputDirectory: resolve(
        projectRoot,
        singleOption(options, "--output") ??
          DEFAULT_EVALUATION_OUTPUT,
      ),
      ...(budgetPath === undefined
        ? {}
        : { budgetPath: resolve(projectRoot, budgetPath) }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
  }
  throw invalidArgument(`unknown command: ${command}`);
}

function parsePositionalCommand(
  command: string,
  values: readonly string[],
  projectRoot: string,
): CliCommand {
  if (command === "plan") {
    const mode = values[0];
    if (mode !== "baseline" && mode !== "candidate") {
      throw invalidArgument(
        "plan mode must be baseline or candidate",
      );
    }
    const model = values[1];
    const environment = values[2];
    const concurrency = values[3];
    const jobName = values[4];
    if (
      model === undefined ||
      environment === undefined ||
      concurrency === undefined ||
      jobName === undefined
    ) {
      throw invalidArgument(
        "plan requires mode model environment concurrency jobName",
      );
    }
    const extensionSource = optionalPositional(values[5]);
    const thinking = optionalPositional(values[6]);
    const taskIds = parseTaskIds(
      optionalPositional(values[7]),
    );
    const repetitions = optionalPositional(values[8]);
    const profile = optionalPositional(values[9]);
    if (values.length > 10) {
      throw invalidArgument("plan received too many arguments");
    }
    return {
      kind: "plan",
      mode,
      model,
      environment,
      concurrency: parsePositiveInteger(
        concurrency,
        "concurrency",
      ),
      jobName,
      ...(extensionSource === undefined
        ? {}
        : { extensionSource }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(taskIds === undefined ? {} : { taskIds }),
      ...(repetitions === undefined
        ? {}
        : {
            repetitions: parsePositiveInteger(
              repetitions,
              "repetitions",
            ),
          }),
      ...(profile === undefined
        ? {}
        : { profile: parseFeatureProfile(profile) }),
    };
  }
  if (command === "preflight") {
    const environment = values[0];
    const concurrency = values[1];
    const jobName = values[2];
    if (
      environment === undefined ||
      concurrency === undefined ||
      jobName === undefined ||
      values.length > 3
    ) {
      throw invalidArgument(
        "preflight requires environment concurrency jobName",
      );
    }
    return {
      kind: "preflight",
      environment,
      concurrency: parsePositiveInteger(
        concurrency,
        "concurrency",
      ),
      jobName,
    };
  }
  if (command === "audit-preflight") {
    const jobDirectory = values[0];
    if (jobDirectory === undefined || values.length > 1) {
      throw invalidArgument(
        "audit-preflight requires a job directory",
      );
    }
    return {
      kind: "audit-preflight",
      jobDirectory: resolve(projectRoot, jobDirectory),
    };
  }
  if (command === "assurance") {
    if (values.length > 1) {
      throw invalidArgument(
        "assurance accepts at most one split",
      );
    }
    return {
      kind: "assurance",
      split: parseAssuranceSplit(values[0] ?? "all"),
    };
  }
  if (command === "calibrate") {
    if (values.length < 3 || values.length > 4) {
      throw invalidArgument(
        "calibrate requires job1 job2 job3 [output]",
      );
    }
    return {
      kind: "calibrate",
      jobDirectories: values.slice(0, 3).map((directory) =>
        resolve(projectRoot, directory)
      ),
      outputPath: resolve(
        projectRoot,
        values[3] ?? DEFAULT_BUDGET_OUTPUT,
      ),
    };
  }
  if (command === "import") {
    const jobDirectory = values[0];
    if (jobDirectory === undefined || values.length > 4) {
      throw invalidArgument(
        "import requires job [budget|-] [output|-] [parentRunId|-]",
      );
    }
    const budgetPath = optionalPositional(values[1]);
    const outputDirectory =
      optionalPositional(values[2]) ??
      DEFAULT_EVALUATION_OUTPUT;
    const parentRunId = optionalPositional(values[3]);
    return {
      kind: "import",
      jobDirectory: resolve(projectRoot, jobDirectory),
      outputDirectory: resolve(projectRoot, outputDirectory),
      ...(budgetPath === undefined
        ? {}
        : { budgetPath: resolve(projectRoot, budgetPath) }),
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
  }
  throw invalidArgument(`unknown command: ${command}`);
}

function optionalPositional(
  value: string | undefined,
): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

function parseOptionMap(
  arguments_: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      !option.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw invalidArgument(
        `expected --option value near ${option ?? "<end>"}`,
      );
    }
    const existing = values.get(option) ?? [];
    existing.push(value);
    values.set(option, existing);
  }
  return values;
}

function requireOption(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): string {
  const value = singleOption(options, name);
  if (value === undefined) {
    throw invalidArgument(`${name} is required`);
  }
  return value;
}

function assertKnownOptions(
  options: ReadonlyMap<string, readonly string[]>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = [...options.keys()].find(
    (option) => !allowedSet.has(option),
  );
  if (unknown !== undefined) {
    throw invalidArgument(`unknown option: ${unknown}`);
  }
}

function singleOption(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | undefined {
  const values = options.get(name);
  if (values === undefined) {
    return undefined;
  }
  if (values.length !== 1) {
    throw invalidArgument(`${name} may only be provided once`);
  }
  return values[0];
}

function parsePositiveInteger(
  value: string,
  name: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidArgument(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseTaskIds(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const taskIds = value.split(",").map((taskId) => taskId.trim());
  if (
    taskIds.length === 0 ||
    taskIds.some((taskId) => taskId.length === 0)
  ) {
    throw invalidArgument(
      "--tasks must be a comma-separated list of task IDs",
    );
  }
  return Object.freeze(taskIds);
}

function parseFeatureProfile(
  value: string,
): BumblebeeBenchmarkProfile {
  if (
    value !== "pi-baseline" &&
    value !== "permission-only" &&
    value !== "full"
  ) {
    throw invalidArgument(
      "profile must be pi-baseline, permission-only, or full",
    );
  }
  return value;
}

function parseAssuranceSplit(
  value: string,
): AssuranceSuiteSplit | "all" {
  if (
    value !== "dev" &&
    value !== "holdout" &&
    value !== "all"
  ) {
    throw invalidArgument(
      "assurance split must be dev, holdout, or all",
    );
  }
  return value;
}

async function loadManifest(
  projectRoot: string,
): Promise<TerminalBenchManifest> {
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  ) as { readonly name?: string };
  if (packageJson.name !== "bumblebee") {
    throw invalidArgument(
      "Benchmark 2 must run from the Bumblebee repository root",
    );
  }
  return parseTerminalBenchManifest(
    await readJson(join(projectRoot, DEFAULT_MANIFEST_PATH)),
  );
}

async function loadBudget(
  budgetPath: string,
  manifest: TerminalBenchManifest,
) {
  return parseTerminalBenchBudgetManifest(
    await readJson(budgetPath),
    manifest,
  );
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause: unknown) {
    throw new BumblebeeError(`${path} is not valid UTF-8 JSON`, {
      code: ERROR_CODES.INVALID_INPUT,
      cause,
    });
  }
}

async function writeJsonAtomic(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath =
    `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, outputPath);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "EEXIST"
    ) {
      throw new BumblebeeError(
        "baseline budget already exists and is immutable",
        {
          code: ERROR_CODES.CONFLICT,
          cause,
          context: { outputPath },
        },
      );
    }
    throw cause;
  } finally {
    await removeTemporaryFile(temporaryPath);
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (cause: unknown) {
    if (
      typeof cause !== "object" ||
      cause === null ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw cause;
    }
  }
}

function printReport(
  report: Awaited<ReturnType<typeof runTerminalBenchImport>>,
  outputDirectory: string,
): void {
  const score = report.score.score === null
    ? "N/A"
    : report.score.score.toFixed(2);
  process.stdout.write(
    [
      `Terminal-Bench Lite ${report.manifestVersion}`,
      `runId: ${report.runId}`,
      `Harbor job: ${report.harborJobId}`,
      `qualification: ${report.gateEvaluation.status}`,
      `TB score: ${score}`,
      `OfficialReward: ${report.componentScores.OfficialReward.toFixed(2)}`,
      `CostEfficiency: ${report.componentScores.CostEfficiency.toFixed(2)}`,
      `LatencyEfficiency: ${report.componentScores.LatencyEfficiency.toFixed(2)}`,
      `Stability: ${report.componentScores.Stability.toFixed(2)}`,
      `results: ${outputDirectory}`,
      "",
    ].join("\n"),
  );
}

function auditPreflight(
  job: NormalizedTerminalBenchJob,
  manifest: TerminalBenchManifest,
): {
  readonly coveredTasks: number;
  readonly expectedTasks: number;
  readonly failures: readonly string[];
  readonly rewardCount: number;
  readonly status: "passed" | "failed";
} {
  const expected = new Set(
    manifest.dataset.selectedTasks.map((task) => task.id),
  );
  const counts = new Map<string, number>();
  const failures: string[] = [];
  let rewardCount = 0;
  for (const trial of job.trials) {
    counts.set(
      trial.taskId,
      (counts.get(trial.taskId) ?? 0) + 1,
    );
    if (trial.reward !== undefined) {
      rewardCount += 1;
    } else {
      failures.push(`${trial.taskId}: verifier produced no reward`);
    }
    if (
      trial.failure?.category === "adapter" ||
      trial.failure?.category === "dataset" ||
      trial.failure?.category === "infrastructure"
    ) {
      failures.push(
        `${trial.taskId}: ${trial.failure.code} (${trial.failure.message})`,
      );
    }
  }
  for (const taskId of expected) {
    const count = counts.get(taskId) ?? 0;
    if (count !== 1) {
      failures.push(`${taskId}: expected 1 trial, observed ${count}`);
    }
  }
  for (const taskId of counts.keys()) {
    if (!expected.has(taskId)) {
      failures.push(`${taskId}: outside the frozen preflight set`);
    }
  }
  return Object.freeze({
    coveredTasks: [...expected].filter(
      (taskId) => counts.get(taskId) === 1,
    ).length,
    expectedTasks: expected.size,
    failures: Object.freeze(failures),
    rewardCount,
    status: failures.length === 0 ? "passed" : "failed",
  });
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run benchmark:2 -- <command> [options]",
      "",
      "Commands:",
      "  plan       Print a Harbor command without executing it",
      "  preflight  Print a 9-task, no-model verifier preflight",
      "  audit-preflight  Audit a completed preflight job",
      "  assurance  Run the task-assurance dev/holdout set",
      "  calibrate  Freeze efficiency budgets from exactly 3 baseline jobs",
      "  import     Normalize and score an existing candidate Harbor job",
      "",
      "Plan options:",
      "  --mode baseline|candidate",
      "  --model <provider/model>",
      "  --extension <git:host/repo@commit>  Required for candidate",
      "  --environment <name>                Default: docker",
      "  --concurrency <count>                Default: 1",
      "  --thinking <level>",
      "  --job-name <name>",
      "  --tasks <id,id,...>                  Frozen subset only",
      "  --repetitions <count>                Default: manifest value",
      "  --profile pi-baseline|permission-only|full",
      "",
      "Frozen selection:",
      "  9 representative tasks (10% of the 89-task source suite)",
      "  5 trials per task; 180 trials across 3 baselines + 1 candidate",
      "",
      "Calibrate options:",
      "  --job <directory>  Repeat exactly three times",
      "  --output <file>",
      "",
      "Import options:",
      "  --job <directory>",
      "  --budget <file>       Omit to record an explicit NQ run",
      "  --output <directory>",
      "  --parent-run-id <id>",
      "",
      "Positional form (recommended with npm on Windows):",
      "  plan <mode> <model> <env> <concurrency> <job> [extension|-] [thinking|-] [tasks|-] [repetitions|-] [profile|-]",
      "  preflight <env> <concurrency> <job>",
      "  audit-preflight <job>",
      "  assurance [dev|holdout|all]",
      "  calibrate <job1> <job2> <job3> [output]",
      "  import <job> [budget|-] [output|-] [parentRunId|-]",
      "",
    ].join("\n"),
  );
}

function invalidArgument(message: string): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
  });
}

void main().catch((cause: unknown) => {
  const error = normalizeError(cause, {
    message: "Terminal-Bench integration failed",
  });
  process.stderr.write(
    `Benchmark 2 failed [${error.code}]: ${error.message}\n`,
  );
  process.exitCode = 1;
});

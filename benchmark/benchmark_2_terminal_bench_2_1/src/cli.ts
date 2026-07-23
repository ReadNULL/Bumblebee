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
  createHarborRunPlan,
  parseTerminalBenchBudgetManifest,
  parseTerminalBenchManifest,
  readHarborJob,
  runTerminalBenchImport,
  type HarborRunMode,
  type TerminalBenchManifest,
} from "./index.js";

const BENCHMARK_ROOT =
  "benchmark/benchmark_2_terminal_bench_2_1";
const DEFAULT_MANIFEST_PATH =
  `${BENCHMARK_ROOT}/manifests/terminal-bench-2-1-v1.json`;
const DEFAULT_EVALUATION_OUTPUT =
  `${BENCHMARK_ROOT}/.runtime/evaluation`;
const DEFAULT_BUDGET_OUTPUT =
  `${BENCHMARK_ROOT}/.runtime/baselines/pi-baseline-v1.json`;

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

  const manifest = await loadManifest(projectRoot);
  switch (command.kind) {
    case "plan": {
      const plan = createHarborRunPlan(manifest, command);
      process.stdout.write(`${plan.displayCommand}\n`);
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
    if (values.length > 7) {
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
      `Terminal-Bench ${report.manifestVersion}`,
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

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run benchmark:2 -- <command> [options]",
      "",
      "Commands:",
      "  plan       Print a Harbor command without executing it",
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
      "  plan <mode> <model> <env> <concurrency> <job> [extension|-] [thinking|-]",
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

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
} from "../../../src/foundation/index.js";
import {
  createAgentDojoRunPlan,
  parseAgentDojoManifest,
  readAgentDojoResult,
  runAgentDojoImport,
  type AgentDojoManifest,
  type AgentDojoSubjectProfile,
} from "./index.js";

const BENCHMARK_ROOT =
  "benchmark/benchmark_3_agentdojo_workspace";
const DEFAULT_MANIFEST_PATH =
  `${BENCHMARK_ROOT}/manifests/agentdojo-workspace-v1.json`;
const DEFAULT_EVALUATION_OUTPUT =
  `${BENCHMARK_ROOT}/.runtime/evaluation`;

type CliCommand =
  | { readonly kind: "help" }
  | {
      readonly kind: "plan";
      readonly profile: AgentDojoSubjectProfile;
      readonly provider: string;
      readonly model: string;
      readonly pythonExecutable: string;
      readonly manifestPath: string;
      readonly outputPath: string;
      readonly logDirectory: string;
      readonly bumblebeeCommit?: string;
      readonly thinkingLevel?: string;
      readonly userTaskIds: readonly string[];
      readonly injectionTaskIds: readonly string[];
      readonly forceRerun: boolean;
    }
  | {
      readonly kind: "import";
      readonly resultPath: string;
      readonly outputDirectory: string;
      readonly hardwareProfile: string;
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
  if (command.kind === "plan") {
    const plan = createAgentDojoRunPlan(manifest, {
      profile: command.profile,
      pythonExecutable: command.pythonExecutable,
      manifestPath: command.manifestPath,
      provider: command.provider,
      model: command.model,
      outputPath: command.outputPath,
      logDirectory: command.logDirectory,
      ...(command.bumblebeeCommit === undefined
        ? {}
        : {
            bumblebeeCommit: command.bumblebeeCommit,
            workspaceClean: true,
          }),
      ...(command.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: command.thinkingLevel }),
      userTaskIds: command.userTaskIds,
      injectionTaskIds: command.injectionTaskIds,
      forceRerun: command.forceRerun,
    });
    process.stdout.write(`${plan.displayCommand}\n`);
    return;
  }

  const result = await readAgentDojoResult(
    command.resultPath,
    manifest,
  );
  const report = await runAgentDojoImport({
    manifest,
    result,
    outputDirectory: command.outputDirectory,
    hardwareProfile: command.hardwareProfile,
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
}

function parseArguments(
  arguments_: readonly string[],
  projectRoot: string,
): CliCommand {
  const command = arguments_[0];
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    return { kind: "help" };
  }
  const rest = arguments_.slice(1);
  if (rest[0] !== undefined && !rest[0].startsWith("--")) {
    return parsePositional(command, rest, projectRoot);
  }

  const options = parseOptionMap(rest);
  if (command === "plan") {
    assertKnownOptions(options, [
      "--profile",
      "--provider",
      "--model",
      "--python",
      "--manifest",
      "--output",
      "--logdir",
      "--commit",
      "--thinking",
      "--user-task",
      "--injection-task",
      "--force-rerun",
    ]);
    const profile = parseProfile(
      requireOption(options, "--profile"),
    );
    const commit = singleOption(options, "--commit");
    const thinking = singleOption(options, "--thinking");
    const defaultStem = profile === "pi-baseline"
      ? "pi-baseline"
      : "bumblebee-full";
    return {
      kind: "plan",
      profile,
      provider: requireOption(options, "--provider"),
      model: requireOption(options, "--model"),
      pythonExecutable:
        singleOption(options, "--python") ?? "python",
      manifestPath: resolve(
        projectRoot,
        singleOption(options, "--manifest") ??
          DEFAULT_MANIFEST_PATH,
      ),
      outputPath: resolve(
        projectRoot,
        singleOption(options, "--output") ??
          `${BENCHMARK_ROOT}/.runtime/raw/${defaultStem}.json`,
      ),
      logDirectory: resolve(
        projectRoot,
        singleOption(options, "--logdir") ??
          `${BENCHMARK_ROOT}/.runtime/agentdojo-logs/${defaultStem}`,
      ),
      ...(commit === undefined ? {} : { bumblebeeCommit: commit }),
      ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
      userTaskIds: options.get("--user-task") ?? [],
      injectionTaskIds:
        options.get("--injection-task") ?? [],
      forceRerun:
        parseBooleanOption(options, "--force-rerun") ?? true,
    };
  }
  if (command === "import") {
    assertKnownOptions(options, [
      "--result",
      "--output",
      "--hardware",
      "--parent-run-id",
    ]);
    const parentRunId = singleOption(
      options,
      "--parent-run-id",
    );
    return {
      kind: "import",
      resultPath: resolve(
        projectRoot,
        requireOption(options, "--result"),
      ),
      outputDirectory: resolve(
        projectRoot,
        singleOption(options, "--output") ??
          DEFAULT_EVALUATION_OUTPUT,
      ),
      hardwareProfile:
        singleOption(options, "--hardware") ??
        `${process.platform}-${process.arch}`,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
  }
  throw invalidArgument(`unknown command: ${command}`);
}

function parsePositional(
  command: string,
  values: readonly string[],
  projectRoot: string,
): CliCommand {
  if (command === "plan") {
    const profile = parseProfile(values[0]);
    const provider = values[1];
    const model = values[2];
    if (
      provider === undefined ||
      model === undefined ||
      values.length > 6
    ) {
      throw invalidArgument(
        "plan requires profile provider model [commit|-] [thinking|-] [python|-]",
      );
    }
    const commit = optionalPositional(values[3]);
    const thinking = optionalPositional(values[4]);
    const pythonExecutable =
      optionalPositional(values[5]) ?? "python";
    const stem = profile === "pi-baseline"
      ? "pi-baseline"
      : "bumblebee-full";
    return {
      kind: "plan",
      profile,
      provider,
      model,
      pythonExecutable,
      manifestPath: resolve(
        projectRoot,
        DEFAULT_MANIFEST_PATH,
      ),
      outputPath: resolve(
        projectRoot,
        `${BENCHMARK_ROOT}/.runtime/raw/${stem}.json`,
      ),
      logDirectory: resolve(
        projectRoot,
        `${BENCHMARK_ROOT}/.runtime/agentdojo-logs/${stem}`,
      ),
      ...(commit === undefined ? {} : { bumblebeeCommit: commit }),
      ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
      userTaskIds: [],
      injectionTaskIds: [],
      forceRerun: true,
    };
  }
  if (command === "import") {
    const resultPath = values[0];
    if (resultPath === undefined || values.length > 4) {
      throw invalidArgument(
        "import requires result [output|-] [hardware|-] [parentRunId|-]",
      );
    }
    const parentRunId = optionalPositional(values[3]);
    return {
      kind: "import",
      resultPath: resolve(projectRoot, resultPath),
      outputDirectory: resolve(
        projectRoot,
        optionalPositional(values[1]) ??
          DEFAULT_EVALUATION_OUTPUT,
      ),
      hardwareProfile:
        optionalPositional(values[2]) ??
        `${process.platform}-${process.arch}`,
      ...(parentRunId === undefined ? {} : { parentRunId }),
    };
  }
  throw invalidArgument(`unknown command: ${command}`);
}

function parseProfile(
  value: string | undefined,
): AgentDojoSubjectProfile {
  if (value !== "pi-baseline" && value !== "bumblebee-full") {
    throw invalidArgument(
      "profile must be pi-baseline or bumblebee-full",
    );
  }
  return value;
}

function parseOptionMap(
  values: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
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
    const existing = options.get(option) ?? [];
    existing.push(value);
    options.set(option, existing);
  }
  return options;
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

function parseBooleanOption(
  options: ReadonlyMap<string, readonly string[]>,
  name: string,
): boolean | undefined {
  const value = singleOption(options, name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    throw invalidArgument(`${name} must be true or false`);
  }
  return value === "true";
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

function optionalPositional(
  value: string | undefined,
): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

async function loadManifest(
  projectRoot: string,
): Promise<AgentDojoManifest> {
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  ) as { readonly name?: string };
  if (packageJson.name !== "bumblebee") {
    throw invalidArgument(
      "Benchmark 3 must run from the Bumblebee repository root",
    );
  }
  return parseAgentDojoManifest(
    JSON.parse(
      await readFile(
        join(projectRoot, DEFAULT_MANIFEST_PATH),
        "utf8",
      ),
    ) as unknown,
  );
}

function printReport(
  report: Awaited<ReturnType<typeof runAgentDojoImport>>,
  outputDirectory: string,
): void {
  const score = report.score.score === null
    ? "N/A"
    : report.score.score.toFixed(2);
  process.stdout.write(
    [
      `AgentDojo Workspace ${report.manifestVersion}`,
      `runId: ${report.runId}`,
      `adapter run: ${report.adapterRunId}`,
      `qualification: ${report.gateEvaluation.status}`,
      `AD score: ${score}`,
      `Utility: ${report.componentScores.Utility.toFixed(2)}`,
      `Utility under attack: ${report.componentScores.UtilityUnderAttack.toFixed(2)}`,
      `Attack resistance: ${report.componentScores.AttackResistance.toFixed(2)}`,
      `Targeted ASR: ${((report.metrics.targeted_asr ?? 0) * 100).toFixed(2)}%`,
      `results: ${outputDirectory}`,
      "",
    ].join("\n"),
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run benchmark:3 -- <command> [options]",
      "",
      "Commands:",
      "  plan    Print the isolated Python/pi command; does not run a model",
      "  import  Validate, record, and score an adapter result",
      "",
      "Plan options:",
      "  --profile pi-baseline|bumblebee-full",
      "  --provider <pi-provider>",
      "  --model <pi-model-id>",
      "  --commit <full-sha>             Required for bumblebee-full",
      "  --thinking <level>",
      "  --user-task <id>                Repeatable",
      "  --injection-task <id>           Repeatable",
      "  --python <executable>            Default: python",
      "  --manifest <file>",
      "  --output <file>",
      "  --logdir <directory>",
      "  --force-rerun true|false       Default: true; formal runs need fresh traces",
      "",
      "Import options:",
      "  --result <file>",
      "  --output <directory>",
      "  --hardware <profile>",
      "  --parent-run-id <id>",
      "",
      "Positional form (recommended with npm on Windows):",
      "  plan <profile> <provider> <model> [commit|-] [thinking|-] [python|-]",
      "  import <result> [output|-] [hardware|-] [parentRunId|-]",
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
    message: "AgentDojo integration failed",
  });
  process.stderr.write(
    `Benchmark 3 failed [${error.code}]: ${error.message}\n`,
  );
  process.exitCode = 1;
});

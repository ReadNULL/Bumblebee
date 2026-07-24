import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import {
  basename,
  join,
  resolve,
} from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../../src/foundation/index.js";
import type {
  HarborJobProvenance,
  NormalizedTerminalBenchJob,
  TerminalBenchManifest,
} from "../contracts/index.js";
import { normalizeHarborJob } from "./normalizer.js";

export async function readHarborJob(
  jobDirectory: string,
  manifest: TerminalBenchManifest,
): Promise<NormalizedTerminalBenchJob> {
  const directory = resolve(jobDirectory);
  const configPath = join(directory, "config.json");
  const resultPath = join(directory, "result.json");

  let configBytes: Buffer;
  let resultBytes: Buffer;
  try {
    [configBytes, resultBytes] = await Promise.all([
      readFile(configPath),
      readFile(resultPath),
    ]);
  } catch (cause: unknown) {
    throw new BumblebeeError(
      "Harbor job must contain readable config.json and result.json",
      {
        code: ERROR_CODES.INVALID_INPUT,
        cause,
        context: { sourceDirectoryName: basename(directory) },
      },
    );
  }

  const config = parseJson(configBytes, "Harbor config.json");
  const rootResult = parseJson(resultBytes, "Harbor result.json");
  const rawResult = await addFallbackTrialResults(
    directory,
    rootResult,
  );
  const provenance: HarborJobProvenance = {
    configSha256: sha256(configBytes),
    resultSha256: sha256(resultBytes),
    trialResultsSha256: hashTrialResults(rawResult),
    sourceDirectoryName: basename(directory),
  };
  const verifierInfrastructureTrials =
    await findVerifierInfrastructureTrials(directory);
  const result = addVerifierInfrastructureDiagnostics(
    rawResult,
    verifierInfrastructureTrials,
    manifest.rewardKey,
  );

  return normalizeHarborJob(
    config,
    result,
    provenance,
    manifest,
  );
}

async function addFallbackTrialResults(
  directory: string,
  value: unknown,
): Promise<unknown> {
  if (!isRecord(value)) {
    return value;
  }
  if (
    Array.isArray(value.trial_results) &&
    value.trial_results.length > 0
  ) {
    return value;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const trialResults: unknown[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const bytes = await readFile(
        join(directory, entry.name, "result.json"),
      );
      trialResults.push(
        parseJson(bytes, `${entry.name}/result.json`),
      );
    } catch (cause: unknown) {
      if (isMissingFileError(cause)) {
        continue;
      }
      throw cause;
    }
  }

  return {
    ...value,
    trial_results: trialResults,
  };
}

async function findVerifierInfrastructureTrials(
  directory: string,
): Promise<ReadonlySet<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const trialNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let output: string;
    try {
      output = await readFile(
        join(
          directory,
          entry.name,
          "verifier",
          "test-stdout.txt",
        ),
        "utf8",
      );
    } catch (cause: unknown) {
      if (isMissingFileError(cause)) {
        continue;
      }
      throw cause;
    }
    if (isVerifierBootstrapNetworkFailure(output)) {
      trialNames.add(entry.name);
    }
  }
  return trialNames;
}

function isVerifierBootstrapNetworkFailure(
  output: string,
): boolean {
  // Keep these signatures narrow: they come from the upstream test harness,
  // not from repository tests executed by the agent.
  return (
    output.includes(
      "Failed to download distribution due to network timeout",
    ) ||
    /curl: \(\d+\).*astral\.sh/u.test(output) ||
    /\/tests\/test\.sh: line \d+: uvx: command not found/u.test(
      output,
    )
  );
}

function addVerifierInfrastructureDiagnostics(
  value: unknown,
  trialNames: ReadonlySet<string>,
  rewardKey: string,
): unknown {
  if (
    trialNames.size === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.trial_results)
  ) {
    return value;
  }
  return {
    ...value,
    trial_results: value.trial_results.map((trial) =>
      addVerifierInfrastructureDiagnostic(
        trial,
        trialNames,
        rewardKey,
      )
    ),
  };
}

function addVerifierInfrastructureDiagnostic(
  value: unknown,
  trialNames: ReadonlySet<string>,
  rewardKey: string,
): unknown {
  if (
    !isRecord(value) ||
    typeof value.trial_name !== "string" ||
    !trialNames.has(value.trial_name) ||
    (
      value.exception_info !== undefined &&
      value.exception_info !== null
    ) ||
    !hasZeroReward(value, rewardKey)
  ) {
    return value;
  }
  return {
    ...value,
    exception_info: {
      exception_type: "VerifierInfrastructureError",
      exception_message:
        "Verifier dependency bootstrap failed due to a network error",
    },
  };
}

function hasZeroReward(
  trial: Readonly<Record<string, unknown>>,
  rewardKey: string,
): boolean {
  if (!isRecord(trial.verifier_result)) {
    return false;
  }
  const rewards = trial.verifier_result.rewards;
  return isRecord(rewards) && rewards[rewardKey] === 0;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause: unknown) {
    throw new BumblebeeError(`${label} is not valid UTF-8 JSON`, {
      code: ERROR_CODES.INVALID_INPUT,
      cause,
    });
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashTrialResults(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.trial_results)) {
    throw new BumblebeeError(
      "Harbor result does not contain trial_results",
      { code: ERROR_CODES.INVALID_INPUT },
    );
  }
  return createHash("sha256")
    .update(JSON.stringify(value.trial_results), "utf8")
    .digest("hex");
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isMissingFileError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

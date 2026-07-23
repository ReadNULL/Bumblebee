import {
  BumblebeeError,
  ERROR_CODES,
  isBumblebeeError,
} from "../../../../src/foundation/index.js";
import {
  assertIdentifier,
  assertScoreSpec,
  type ScoreSpec,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  BUMBLEBEE_BENCH_CONTRACT_VERSION,
  BUMBLEBEE_BENCH_DOMAINS,
  BUMBLEBEE_BENCH_PROFILES,
  type BumblebeeBenchDomain,
  type BumblebeeBenchDomainConfig,
  type BumblebeeBenchManifest,
  type BumblebeeBenchProfile,
  type BumblebeeBenchProfileConfig,
  type BumblebeeBenchScenarioConfig,
} from "./types.js";

const WEIGHT_EPSILON = 1e-9;

export function parseBumblebeeBenchManifest(
  value: unknown,
): BumblebeeBenchManifest {
  const source = requireRecord(value, "manifest");
  if (
    source.contractVersion !== BUMBLEBEE_BENCH_CONTRACT_VERSION
  ) {
    invalid("unsupported BumblebeeBench contract version");
  }

  const id = requireString(source.id, "manifest.id");
  const version = requireString(source.version, "manifest.version");
  const description = requireString(
    source.description,
    "manifest.description",
  );
  assertIdentifier(id, "manifest.id");
  assertIdentifier(version, "manifest.version");

  const profilesSource = requireRecord(
    source.profiles,
    "manifest.profiles",
  );
  const profiles = Object.fromEntries(
    BUMBLEBEE_BENCH_PROFILES.map((profile) => [
      profile,
      parseProfile(profilesSource[profile], profile),
    ]),
  ) as Record<BumblebeeBenchProfile, BumblebeeBenchProfileConfig>;

  const domainValues = requireArray(source.domains, "manifest.domains");
  const domains = domainValues.map(parseDomain);
  assertExactDomains(domains);

  const scoreSpec = requireRecord(
    source.scoreSpec,
    "manifest.scoreSpec",
  ) as unknown as ScoreSpec;
  try {
    assertScoreSpec(scoreSpec);
  } catch (cause: unknown) {
    if (isBumblebeeError(cause)) {
      throw cause;
    }
    invalid("manifest.scoreSpec is invalid", {
      errorName: cause instanceof Error ? cause.name : "UnknownError",
    });
  }
  if (scoreSpec.id !== id) {
    invalid("score spec id must match manifest id");
  }
  assertScoreComponents(domains, scoreSpec);

  return Object.freeze({
    contractVersion: BUMBLEBEE_BENCH_CONTRACT_VERSION,
    id,
    version,
    description,
    profiles: Object.freeze(profiles),
    domains: Object.freeze(domains),
    scoreSpec,
  });
}

function parseProfile(
  value: unknown,
  profile: BumblebeeBenchProfile,
): BumblebeeBenchProfileConfig {
  const source = requireRecord(value, `profiles.${profile}`);
  return Object.freeze({
    repetitions: requirePositiveInteger(
      source.repetitions,
      `profiles.${profile}.repetitions`,
    ),
  });
}

function parseDomain(
  value: unknown,
  index: number,
): BumblebeeBenchDomainConfig {
  const source = requireRecord(value, `domains[${index}]`);
  const id = requireString(source.id, `domains[${index}].id`);
  if (!BUMBLEBEE_BENCH_DOMAINS.includes(id as BumblebeeBenchDomain)) {
    invalid("manifest contains an unknown domain", { domain: id });
  }
  const weight = requireNumber(
    source.weight,
    `domains[${index}].weight`,
  );
  if (weight <= 0 || weight > 1) {
    invalid("domain weight must be greater than 0 and at most 1", {
      domain: id,
      weight,
    });
  }

  const scenarios = requireArray(
    source.scenarios,
    `domains[${index}].scenarios`,
  ).map((scenario, scenarioIndex) =>
    parseScenario(scenario, index, scenarioIndex),
  );
  if (scenarios.length === 0) {
    invalid("each benchmark domain must contain a scenario", {
      domain: id,
    });
  }

  return Object.freeze({
    id: id as BumblebeeBenchDomain,
    weight,
    scenarios: Object.freeze(scenarios),
  });
}

function parseScenario(
  value: unknown,
  domainIndex: number,
  scenarioIndex: number,
): BumblebeeBenchScenarioConfig {
  const field = `domains[${domainIndex}].scenarios[${scenarioIndex}]`;
  const source = requireRecord(value, field);
  const id = requireString(source.id, `${field}.id`);
  assertIdentifier(id, `${field}.id`);
  const sloMs = requirePositiveInteger(source.sloMs, `${field}.sloMs`);
  const timeoutMs = requirePositiveInteger(
    source.timeoutMs,
    `${field}.timeoutMs`,
  );
  if (timeoutMs <= sloMs) {
    invalid("scenario timeout must be greater than its SLO", {
      id,
      sloMs,
      timeoutMs,
    });
  }

  return Object.freeze({
    id,
    description: requireString(
      source.description,
      `${field}.description`,
    ),
    sloMs,
    timeoutMs,
  });
}

function assertExactDomains(
  domains: readonly BumblebeeBenchDomainConfig[],
): void {
  const ids = domains.map((domain) => domain.id);
  if (
    ids.length !== BUMBLEBEE_BENCH_DOMAINS.length ||
    new Set(ids).size !== ids.length ||
    BUMBLEBEE_BENCH_DOMAINS.some((domain) => !ids.includes(domain))
  ) {
    invalid("manifest must define every benchmark domain exactly once", {
      domains: ids,
    });
  }

  const scenarioIds = domains.flatMap((domain) =>
    domain.scenarios.map((scenario) => scenario.id),
  );
  if (new Set(scenarioIds).size !== scenarioIds.length) {
    invalid("manifest contains duplicate scenario ids");
  }

  const totalWeight = domains.reduce(
    (total, domain) => total + domain.weight,
    0,
  );
  if (Math.abs(totalWeight - 1) > WEIGHT_EPSILON) {
    invalid("domain weights must sum to 1", { totalWeight });
  }
}

function assertScoreComponents(
  domains: readonly BumblebeeBenchDomainConfig[],
  scoreSpec: ScoreSpec,
): void {
  if (scoreSpec.components.length !== domains.length) {
    invalid("score spec must contain one component per domain");
  }

  const components = new Map(
    scoreSpec.components.map((component) => [
      component.id,
      component.weight,
    ]),
  );
  for (const domain of domains) {
    if (components.get(domain.id) !== domain.weight) {
      invalid("score component does not match domain weight", {
        domain: domain.id,
      });
    }
  }
}

function requireRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    invalid(`${field} must be an object`, { field });
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array`, { field });
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`, { field });
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = requireNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) {
    invalid(`${field} must be a positive safe integer`, {
      field,
      value,
    });
  }
  return number;
}

function invalid(
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context,
  });
}

import {
  lstat,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import {
  ArtifactStore,
  assertArtifactReference,
  assertIdentifier,
  type ArtifactReference,
  type EvaluationRunStatus,
  type QualificationStatus,
} from "../../../benchmark_0_evaluation_core/src/index.js";
import {
  invalid,
  requireOneOf,
  requireRecord,
} from "../contracts/index.js";

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "invalid",
] as const;
const QUALIFICATION_STATUSES = [
  "qualified",
  "not-qualified",
  "invalid",
] as const;

export interface VerifiedRunArtifacts {
  readonly sourceDirectory: string;
  readonly artifactRoot: string;
  readonly runId: string;
  readonly manifestReference: ArtifactReference;
  readonly summaryReference: ArtifactReference;
  readonly ledgerStatus: EvaluationRunStatus;
  readonly ledgerQualification: QualificationStatus;
  readonly store: ArtifactStore;
}

export async function openVerifiedRunArtifacts(
  inputDirectory: string,
): Promise<VerifiedRunArtifacts> {
  const sourceDirectory = path.resolve(inputDirectory);
  const runId = path.basename(sourceDirectory);
  assertIdentifier(runId, "source run directory");
  const artifactRoot = path.dirname(sourceDirectory);
  const outputDirectory = path.dirname(artifactRoot);
  const ledgerPath = path.join(
    outputDirectory,
    "history",
    "runs.jsonl",
  );

  await assertNoSymbolicLinks(artifactRoot, sourceDirectory);
  await assertRegularFile(ledgerPath, "run ledger");
  const ledger = await readLedger(ledgerPath);
  const started = findSingleLedgerEntry(
    ledger,
    runId,
    "run_started",
  );
  const finished = findSingleLedgerEntry(
    ledger,
    runId,
    "run_finished",
  );
  const manifestReference = parseArtifactReference(
    started.manifestArtifact,
    "run_started.manifestArtifact",
  );
  const summaryReference = parseArtifactReference(
    finished.summaryArtifact,
    "run_finished.summaryArtifact",
  );
  assertExpectedReference(
    manifestReference,
    runId,
    `${runId}/manifest.json`,
    "manifest",
  );
  assertExpectedReference(
    summaryReference,
    runId,
    `${runId}/summary.json`,
    "summary",
  );

  const store = new ArtifactStore(artifactRoot);
  await verifyReference(store, artifactRoot, manifestReference);
  await verifyReference(store, artifactRoot, summaryReference);

  return Object.freeze({
    sourceDirectory,
    artifactRoot,
    runId,
    manifestReference,
    summaryReference,
    ledgerStatus: requireOneOf(
      finished.status,
      RUN_STATUSES,
      "run_finished.status",
    ),
    ledgerQualification: requireOneOf(
      finished.qualification,
      QUALIFICATION_STATUSES,
      "run_finished.qualification",
    ),
    store,
  });
}

export async function verifyTaskArtifactReferences(
  layout: VerifiedRunArtifacts,
  references: readonly ArtifactReference[],
  expectedCount: number,
  component: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const reference of references) {
    if (
      reference.runId !== layout.runId ||
      reference.kind !== "task-result" ||
      seen.has(reference.relativePath)
    ) {
      invalid("source task artifact reference is inconsistent", {
        component,
        relativePath: reference.relativePath,
      });
    }
    seen.add(reference.relativePath);
    await verifyReference(
      layout.store,
      layout.artifactRoot,
      reference,
    );
  }
  if (seen.size !== expectedCount) {
    invalid("source task artifact count does not match summary", {
      component,
      actual: seen.size,
      expected: expectedCount,
    });
  }
}

export function parseArtifactReference(
  value: unknown,
  field: string,
): ArtifactReference {
  const source = requireRecord(value, field);
  const reference = source as unknown as ArtifactReference;
  assertArtifactReference(reference);
  return Object.freeze({ ...reference });
}

export async function readJsonFile(
  filePath: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (cause: unknown) {
    invalid("source artifact contains invalid JSON", {
      path: filePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function readLedger(
  ledgerPath: string,
): Promise<readonly Record<string, unknown>[]> {
  const stats = await lstat(ledgerPath);
  if (stats.size > MAX_LEDGER_BYTES) {
    invalid("run ledger exceeds the scorecard import limit", {
      ledgerPath,
      bytes: stats.size,
    });
  }
  const text = await readFile(ledgerPath, "utf8");
  const entries: Record<string, unknown>[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      entries.push(
        requireRecord(
          JSON.parse(line) as unknown,
          `run ledger line ${index + 1}`,
        ),
      );
    } catch (cause: unknown) {
      invalid("run ledger contains invalid JSON", {
        line: index + 1,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return Object.freeze(entries);
}

function findSingleLedgerEntry(
  entries: readonly Record<string, unknown>[],
  runId: string,
  event: "run_started" | "run_finished",
): Record<string, unknown> {
  const matches = entries.filter(
    (entry) => entry.runId === runId && entry.event === event,
  );
  if (matches.length !== 1) {
    invalid("run ledger must contain exactly one lifecycle entry", {
      runId,
      event,
      count: matches.length,
    });
  }
  return matches[0] as Record<string, unknown>;
}

function assertExpectedReference(
  reference: ArtifactReference,
  runId: string,
  relativePath: string,
  kind: ArtifactReference["kind"],
): void {
  if (
    reference.runId !== runId ||
    reference.relativePath !== relativePath ||
    reference.kind !== kind
  ) {
    invalid("run ledger contains an unexpected artifact reference", {
      runId,
      relativePath: reference.relativePath,
    });
  }
}

async function verifyReference(
  store: ArtifactStore,
  artifactRoot: string,
  reference: ArtifactReference,
): Promise<void> {
  await assertNoSymbolicLinks(
    artifactRoot,
    path.join(
      artifactRoot,
      ...reference.relativePath.split("/"),
    ),
  );
  const verification = await store.verify(reference);
  if (!verification.valid) {
    invalid("source artifact failed integrity verification", {
      relativePath: reference.relativePath,
      reason: verification.reason,
    });
  }
}

async function assertNoSymbolicLinks(
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    invalid("source artifact path escapes its root", { target });
  }

  let current = root;
  const rootStats = await lstat(current);
  if (rootStats.isSymbolicLink()) {
    invalid("source artifact root must not be a symbolic link");
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      invalid("source artifact path contains a symbolic link", {
        path: current,
      });
    }
  }
}

async function assertRegularFile(
  filePath: string,
  label: string,
): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    invalid(`${label} must be a regular file`, { path: filePath });
  }
}

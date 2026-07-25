import {
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import {
  normalizeError,
  type JsonObject,
} from "../../../../src/foundation/index.js";
import {
  LightweightMemory,
  normalizeIdentityKey,
  type MemoryRecord,
} from "../../../../src/memory/index.js";
import type {
  LongMemEvalAnswerEvaluation,
  LongMemEvalCase,
  LongMemEvalCaseEvidence,
  LongMemEvalCaseMetrics,
  LongMemEvalCaseResult,
  LongMemEvalExpectedRecord,
  LongMemEvalProfile,
  LongMemEvalReader,
} from "../contracts/index.js";
import { evaluateLongMemEvalAnswer } from "../scoring/index.js";

export interface RunLongMemEvalCaseOptions {
  readonly case: LongMemEvalCase;
  readonly fixtureDirectory: string;
  readonly profile: LongMemEvalProfile;
  readonly trial: number;
  readonly reader?: LongMemEvalReader;
  readonly signal?: AbortSignal;
}

/** 重放显式记忆事件，并通过真实 LightweightMemory 完成检索和上下文构建。 */
export async function runLongMemEvalCase(
  options: RunLongMemEvalCaseOptions,
): Promise<LongMemEvalCaseResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const memoryRoot = path.join(options.fixtureDirectory, "memory");
  const workspacePaths = new Map(
    options.case.workspaces.map((workspace) => [
      workspace,
      path.join(options.fixtureDirectory, "workspaces", workspace),
    ]),
  );
  await Promise.all(
    [...workspacePaths.values()].map((workspace) =>
      mkdir(workspace, { recursive: true })
    ),
  );

  let clockValue = new Date(options.case.events[0]?.at ?? startedAt);
  let memory: LightweightMemory | undefined;
  let activeWorkspace: string | undefined;
  let operationChecksPassed = true;

  const activate = async (
    workspace: string,
    forceRestart = false,
  ): Promise<LightweightMemory> => {
    if (
      memory !== undefined &&
      activeWorkspace === workspace &&
      !forceRestart
    ) {
      return memory;
    }
    if (memory !== undefined) {
      await memory.dispose();
    }
    const workspacePath = workspacePaths.get(workspace);
    if (workspacePath === undefined) {
      throw new Error(`Unknown benchmark workspace: ${workspace}`);
    }
    memory = new LightweightMemory({
      rootDirectory: memoryRoot,
      clock: () => new Date(clockValue),
    });
    await memory.initialize({
      cwd: workspacePath,
      ...(options.signal === undefined
        ? {}
        : { signal: options.signal }),
    });
    activeWorkspace = workspace;
    return memory;
  };

  try {
    for (const event of options.case.events) {
      clockValue = new Date(event.at);
      const current = await activate(
        event.workspace,
        event.type === "compact" || event.type === "resume",
      );
      if (event.type === "compact" || event.type === "resume") {
        continue;
      }
      if (event.type === "upsert") {
        const result = await current.upsert(
          event.input,
          options.signal,
        );
        operationChecksPassed =
          operationChecksPassed &&
          result.status === event.expectedStatus;
        continue;
      }

      let observedCode: string | undefined;
      try {
        await current.upsert(event.input, options.signal);
      } catch (cause: unknown) {
        observedCode = normalizeError(cause).code;
      }
      operationChecksPassed =
        operationChecksPassed &&
        observedCode === event.expectedErrorCode;
    }

    const queryMemory = await activate(options.case.query.workspace);
    const retrieval = queryMemory.search(
      options.case.query.text,
      {
        scope: options.case.query.scope,
        limit: 5,
      },
      options.signal,
    );
    const retrievedKeys = retrieval.map((result) =>
      memoryReference(result.record)
    );
    const memoryContext = await queryMemory.buildPromptContext(
      options.case.query.text,
      {
        scope: options.case.query.scope,
        access: options.case.query.access,
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal }),
      },
    );
    const contextKeys = extractContextReferences(memoryContext);
    operationChecksPassed =
      operationChecksPassed && hasSingleMemoryFence(memoryContext);

    const stateCheck = await evaluateStateChecks(
      options.case,
      activate,
    );
    if (memory !== undefined) {
      await memory.dispose();
      memory = undefined;
      activeWorkspace = undefined;
    }
    const persistedText = await readAllText(memoryRoot);
    const updateForbiddenTerms =
      options.case.checks?.update?.forbiddenPersistedTerms ?? [];
    const updateForbiddenPassed = updateForbiddenTerms.every(
      (term) => !persistedText.includes(term),
    );
    const secretTerms =
      options.case.checks?.forbiddenPersistedTerms ?? [];
    const secretPersistedCount = secretTerms.filter(
      (term) => persistedText.includes(term),
    ).length;
    const stateChecksPassed =
      stateCheck.passed && updateForbiddenPassed;

    const forbiddenReferences = new Set(
      options.case.query.forbiddenKeys,
    );
    const leakedReferences = new Set(
      [...retrievedKeys, ...contextKeys].filter((reference) =>
        forbiddenReferences.has(reference)
      ),
    );
    const forbiddenContextTerms =
      options.case.checks?.isolation?.forbiddenContextTerms ?? [];
    const leakedContextTerms = forbiddenContextTerms.filter(
      (term) => memoryContext.includes(term),
    );
    const memoryScopeLeakCount =
      leakedReferences.size + leakedContextTerms.length;
    const readOnlyPolicyPassed =
      options.case.checks?.isolation?.requireReadOnlyPolicy !== true ||
      memoryContext.includes("read-only memory access");
    const isolationAccuracy =
      options.case.checks?.isolation === undefined
        ? undefined
        : memoryScopeLeakCount === 0 && readOnlyPolicyPassed
          ? 1
          : 0;

    const relevant = new Set(options.case.query.relevantKeys);
    const relevantRetrieved = new Set(
      retrievedKeys.filter((key) => relevant.has(key)),
    );
    const recallAt5 = relevant.size === 0
      ? undefined
      : relevantRetrieved.size / relevant.size;
    const precisionAt5 = relevant.size === 0
      ? undefined
      : relevantRetrieved.size /
        Math.max(1, retrievedKeys.length);

    const reader = options.reader === undefined
      ? undefined
      : await options.reader.answer({
          caseId: options.case.id,
          question: options.case.query.text,
          memoryContext,
          ...(options.signal === undefined
            ? {}
            : { signal: options.signal }),
        });
    const answerEvaluation = reader === undefined
      ? undefined
      : evaluateLongMemEvalAnswer(
          reader.answer,
          options.case.answer,
        );
    const metrics: LongMemEvalCaseMetrics = Object.freeze({
      ...(answerEvaluation === undefined
        ? {}
        : {
            qaAccuracy: answerEvaluation.correct ? 1 : 0,
            predictedAbstention: answerEvaluation.abstained,
          }),
      ...(recallAt5 === undefined ? {} : { recallAt5 }),
      ...(precisionAt5 === undefined ? {} : { precisionAt5 }),
      ...(options.case.checks?.update === undefined
        ? {}
        : {
            updateAccuracy:
              stateChecksPassed && operationChecksPassed ? 1 : 0,
          }),
      ...(isolationAccuracy === undefined
        ? {}
        : { isolationAccuracy }),
      expectedAbstention: options.case.answer.abstain,
    });
    const evidence: LongMemEvalCaseEvidence = Object.freeze({
      caseId: options.case.id,
      capability: options.case.capability,
      trial: options.trial,
      profile: options.profile,
      query: options.case.query.text,
      retrievedKeys: Object.freeze(retrievedKeys),
      memoryContext,
      answer: reader?.answer ?? null,
      answerEvaluation:
        answerEvaluation === undefined
          ? null
          : answerEvaluationToJson(answerEvaluation),
      operationChecksPassed,
      stateChecksPassed,
      memoryScopeLeakCount,
      secretPersistedCount,
    });

    return Object.freeze({
      caseId: options.case.id,
      capability: options.case.capability,
      trial: options.trial,
      profile: options.profile,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - started),
      status: "completed",
      metrics,
      evidence,
      ...(reader === undefined ? {} : { reader }),
    });
  } finally {
    if (memory !== undefined) {
      await memory.dispose();
    }
  }
}

async function evaluateStateChecks(
  testCase: LongMemEvalCase,
  activate: (
    workspace: string,
    forceRestart?: boolean,
  ) => Promise<LightweightMemory>,
): Promise<{ readonly passed: boolean }> {
  const expectedRecords = testCase.checks?.update?.records ?? [];
  let passed = true;
  for (const expected of expectedRecords) {
    const current = await activate(expected.workspace);
    const actual = current.list({ scope: expected.scope }).find(
      (record) =>
        normalizeIdentityKey(record.key) ===
        normalizeIdentityKey(expected.key),
    );
    passed = passed && matchesExpectedRecord(actual, expected);
  }
  return Object.freeze({ passed });
}

function matchesExpectedRecord(
  actual: MemoryRecord | undefined,
  expected: LongMemEvalExpectedRecord,
): boolean {
  return actual !== undefined &&
    actual.content === expected.content &&
    actual.revision === expected.revision &&
    actual.scope === expected.scope;
}

function memoryReference(record: MemoryRecord): string {
  return `${record.scope}:${normalizeIdentityKey(record.key)}`;
}

function extractContextReferences(context: string): readonly string[] {
  const references: string[] = [];
  for (const line of context.split(/\r?\n/u)) {
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(line) as {
        readonly key?: unknown;
        readonly scope?: unknown;
      };
      if (
        typeof value.key === "string" &&
        (value.scope === "global" || value.scope === "project")
      ) {
        references.push(
          `${value.scope}:${normalizeIdentityKey(value.key)}`,
        );
      }
    } catch {
      // A malformed context line is caught by the fence/check failures.
    }
  }
  return Object.freeze(references);
}

function hasSingleMemoryFence(context: string): boolean {
  if (!context.includes("<memory-context>")) {
    return true;
  }
  return countOccurrences(context, "<memory-context>") === 1 &&
    countOccurrences(context, "</memory-context>") === 1;
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1;
}

function answerEvaluationToJson(
  evaluation: LongMemEvalAnswerEvaluation,
): JsonObject {
  return {
    answered: evaluation.answered,
    abstained: evaluation.abstained,
    correct: evaluation.correct,
    missingGroups: evaluation.missingGroups,
    matchedForbiddenTerms: evaluation.matchedForbiddenTerms,
  };
}

async function readAllText(directory: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw cause;
  }

  const chunks: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(await readAllText(entryPath));
    } else if (entry.isFile()) {
      chunks.push(await readFile(entryPath, "utf8"));
    }
  }
  return chunks.join("\n");
}

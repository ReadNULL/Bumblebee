import {
  readFileSync,
} from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseLongMemEvalDataset,
  parseLongMemEvalManifest,
  type LongMemEvalCaseResult,
  type LongMemEvalDataset,
  type LongMemEvalManifest,
  type LongMemEvalProfile,
  type LongMemEvalReader,
} from "../src/index.js";

export const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const projectRoot = resolve(benchmarkRoot, "../..");

const manifestPath = resolve(
  benchmarkRoot,
  "manifests/longmemeval-bumblebee-v1.json",
);
const datasetPath = resolve(
  benchmarkRoot,
  "datasets/longmemeval-bumblebee-v1.json",
);

const CORRECT_ANSWERS = new Map<string, string>([
  ["information-global-preference-resume", "请使用中文回答。"],
  [
    "information-project-region-after-compaction",
    "这个项目部署在华东一区。",
  ],
  ["multi-session-package-install", "使用 npm，并执行 npm ci。"],
  [
    "multi-session-review-format",
    "保持简洁，并包含风险和验证两个部分。",
  ],
  ["knowledge-update-test-command", "执行 npm run test:ci。"],
  ["knowledge-update-indentation", "最新偏好是使用 2 个空格缩进。"],
  ["temporal-release-window", "相隔 7 天。"],
  [
    "temporal-review-before-release",
    "安全评审更早，相差 3 天。",
  ],
  [
    "abstention-unknown-database-port",
    "没有相关记忆，无法确定。",
  ],
  [
    "abstention-unrecorded-owner",
    "没有相关记忆，无法确定。",
  ],
  ["isolation-project-move", "没有相关记忆，无法确定。"],
  [
    "isolation-feishu-read-only-and-secret",
    "允许发到发布通知群。",
  ],
]);

export function loadRawManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as Record<string, unknown>;
}

export function loadRawDataset(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(datasetPath, "utf8"),
  ) as Record<string, unknown>;
}

export function createTestManifest(): LongMemEvalManifest {
  return parseLongMemEvalManifest(loadRawManifest());
}

export function createTestDataset(): LongMemEvalDataset {
  return parseLongMemEvalDataset(loadRawDataset());
}

export class CorrectMemoryReader implements LongMemEvalReader {
  readonly contexts = new Map<string, string>();

  async answer(input: {
    readonly caseId: string;
    readonly memoryContext: string;
  }) {
    this.contexts.set(input.caseId, input.memoryContext);
    const answer = CORRECT_ANSWERS.get(input.caseId);
    if (answer === undefined) {
      throw new Error(`Missing fixture answer for ${input.caseId}`);
    }
    return Object.freeze({
      answer,
      durationMs: 1,
      tokens: Object.freeze({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      costUsd: 0.001,
    });
  }
}

export function createPerfectResults(
  dataset: LongMemEvalDataset,
  profile: LongMemEvalProfile,
  repetitions: number,
): readonly LongMemEvalCaseResult[] {
  return Object.freeze(
    Array.from({ length: repetitions }, (_, index) => index + 1)
      .flatMap((trial) =>
        dataset.cases.map((testCase) => Object.freeze({
          caseId: testCase.id,
          capability: testCase.capability,
          trial,
          profile,
          startedAt: "2026-07-23T10:00:00.000Z",
          finishedAt: "2026-07-23T10:00:01.000Z",
          durationMs: 1_000,
          status: "completed" as const,
          metrics: Object.freeze({
            qaAccuracy: 1,
            ...(testCase.query.relevantKeys.length === 0
              ? {}
              : { recallAt5: 1, precisionAt5: 1 }),
            ...(testCase.checks?.update === undefined
              ? {}
              : { updateAccuracy: 1 }),
            ...(testCase.checks?.isolation === undefined
              ? {}
              : { isolationAccuracy: 1 }),
            expectedAbstention: testCase.answer.abstain,
            predictedAbstention: testCase.answer.abstain,
          }),
          evidence: Object.freeze({
            caseId: testCase.id,
            capability: testCase.capability,
            trial,
            profile,
            query: testCase.query.text,
            retrievedKeys: Object.freeze([
              ...testCase.query.relevantKeys,
            ]),
            memoryContext: "fixture",
            answer: CORRECT_ANSWERS.get(testCase.id) ?? "fixture",
            answerEvaluation: {
              answered: true,
              abstained: testCase.answer.abstain,
              correct: true,
              missingGroups: [],
              matchedForbiddenTerms: [],
            },
            operationChecksPassed: true,
            stateChecksPassed: true,
            memoryScopeLeakCount: 0,
            secretPersistedCount: 0,
          }),
          reader: Object.freeze({
            answer: CORRECT_ANSWERS.get(testCase.id) ?? "fixture",
            durationMs: 1,
            tokens: Object.freeze({
              input: 10,
              output: 5,
            }),
            costUsd: 0.001,
          }),
        }))
      ),
  );
}

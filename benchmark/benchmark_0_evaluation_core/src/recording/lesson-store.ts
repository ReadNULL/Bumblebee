import { join, resolve } from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  KeyedSerialQueue,
  sanitizeForLogging,
} from "../../../../src/foundation/index.js";
import {
  EVALUATION_CONTRACT_VERSION,
  assertIdentifier,
  assertLessonRevisionInput,
  type LessonRevision,
  type LessonRevisionInput,
} from "../contracts/index.js";
import {
  appendSanitizedJsonLine,
  readJsonLines,
} from "./json-lines.js";

export interface LessonStoreOptions {
  readonly outputDirectory: string;
  readonly clock?: () => Date;
}

/**
 * lesson 的 JSONL 是机器可读事实源；同一个 lesson 的每次结论变化都新增 revision。
 */
export class LessonStore {
  private readonly clock: () => Date;
  private readonly lessonDirectory: string;
  private readonly queue = new KeyedSerialQueue<string>();

  constructor(options: LessonStoreOptions) {
    if (options.outputDirectory.trim().length === 0) {
      throw new BumblebeeError(
        "lesson output directory must not be empty",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }

    this.lessonDirectory = join(
      resolve(options.outputDirectory),
      "history",
      "lessons",
    );
    this.clock = options.clock ?? (() => new Date());
  }

  append(input: LessonRevisionInput): Promise<LessonRevision> {
    assertLessonRevisionInput(input);

    return this.queue.enqueue(input.lessonId, async () => {
      const existing = await this.read(input.lessonId);
      const revision: LessonRevision = {
        ...input,
        contractVersion: EVALUATION_CONTRACT_VERSION,
        revision: existing.length + 1,
        recordedAt: this.clock().toISOString(),
      };
      const sanitized = sanitizeForLogging(revision, {
        maxDepth: 12,
        maxEntries: 1_000,
        maxStringLength: 20_000,
      }) as unknown as LessonRevision;

      await appendSanitizedJsonLine(
        this.getLessonPath(input.lessonId),
        sanitized,
      );
      return sanitized;
    });
  }

  getLatest(lessonId: string): Promise<LessonRevision | undefined> {
    assertIdentifier(lessonId, "lessonId");
    return this.queue.enqueue(lessonId, async () => {
      const revisions = await this.read(lessonId);
      return revisions.at(-1);
    });
  }

  getRevisions(lessonId: string): Promise<readonly LessonRevision[]> {
    assertIdentifier(lessonId, "lessonId");
    return this.queue.enqueue(lessonId, () => this.read(lessonId));
  }

  async renderMarkdown(lessonId: string): Promise<string> {
    const revisions = await this.getRevisions(lessonId);
    if (revisions.length === 0) {
      throw new BumblebeeError("lesson was not found", {
        code: ERROR_CODES.NOT_FOUND,
        context: { lessonId },
      });
    }

    const latest = revisions.at(-1) as LessonRevision;
    const sections = revisions.map((revision) =>
      renderRevision(revision),
    );
    return [
      `# ${latest.title}`,
      "",
      `- Lesson ID: \`${latest.lessonId}\``,
      `- 当前状态: \`${latest.status}\``,
      `- 分类: \`${latest.category}\``,
      "",
      ...sections,
      "",
    ].join("\n");
  }

  private async read(lessonId: string): Promise<LessonRevision[]> {
    const values = await readJsonLines(this.getLessonPath(lessonId));
    return values.map((value, index) => {
      if (
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
      ) {
        throw invalidStoredLesson(lessonId, index + 1);
      }

      const revision = value as unknown as LessonRevision;
      if (
        revision.contractVersion !== EVALUATION_CONTRACT_VERSION ||
        revision.lessonId !== lessonId ||
        revision.revision !== index + 1
      ) {
        throw invalidStoredLesson(lessonId, index + 1);
      }
      return revision;
    });
  }

  private getLessonPath(lessonId: string): string {
    return join(this.lessonDirectory, `${lessonId}.jsonl`);
  }
}

function renderRevision(revision: LessonRevision): string {
  const list = (values: readonly string[]): string =>
    values.length === 0
      ? "- 无"
      : values.map((value) => `- ${value}`).join("\n");

  return [
    `## Revision ${revision.revision}`,
    "",
    `- 记录时间: \`${revision.recordedAt}\``,
    `- 状态: \`${revision.status}\``,
    `- 证据运行: ${revision.evidenceRunIds
      .map((runId) => `\`${runId}\``)
      .join(", ")}`,
    "",
    "### 证据",
    "",
    revision.evidence,
    "",
    "### 根因假设",
    "",
    revision.hypothesis,
    "",
    "### 修改边界",
    "",
    revision.changeBoundary,
    "",
    "### 预期指标",
    "",
    list(revision.expectedMetrics),
    "",
    "### 风险",
    "",
    list(revision.risks),
    ...(revision.developmentResult === undefined
      ? []
      : ["", "### 开发集结果", "", revision.developmentResult]),
    ...(revision.holdoutResult === undefined
      ? []
      : ["", "### 保留集结果", "", revision.holdoutResult]),
  ].join("\n");
}

function invalidStoredLesson(
  lessonId: string,
  revision: number,
): BumblebeeError {
  return new BumblebeeError(
    "lesson history contains an invalid revision",
    {
      code: ERROR_CODES.INVALID_INPUT,
      context: { lessonId, revision },
    },
  );
}

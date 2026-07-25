import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LessonStore } from "../../src/index.js";
import { FIXED_TIME } from "../fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LessonStore", () => {
  it("preserves every revision and renders a human-readable history", async () => {
    const outputDirectory = await createTemporaryDirectory();
    const store = new LessonStore({
      outputDirectory,
      clock: () => new Date(FIXED_TIME),
    });
    const base = {
      lessonId: "lesson-permission",
      title: "权限误判需要最小边界修复",
      category: "bumblebee" as const,
      evidenceRunIds: ["run-before"],
      evidence: "token=secret-value; dangerous write was allowed",
      hypothesis: "路径规范化发生在匹配之后",
      changeBoundary: "只调整权限路径规范化",
      expectedMetrics: ["unsafe_action_count"],
      risks: ["合法符号链接可能被拒绝"],
    };

    await store.append({
      ...base,
      status: "proposed",
    });
    await store.append({
      ...base,
      status: "accepted",
      evidenceRunIds: ["run-before", "run-after"],
      developmentResult: "开发集不再出现错误允许",
      holdoutResult: "保留集保持通过",
      relatedCommit: "abc1234",
      verificationRunIds: ["run-after"],
    });

    const revisions = await store.getRevisions(base.lessonId);
    expect(revisions.map((revision) => revision.revision)).toEqual([
      1,
      2,
    ]);
    expect((await store.getLatest(base.lessonId))?.status).toBe(
      "accepted",
    );

    const markdown = await store.renderMarkdown(base.lessonId);
    expect(markdown).toContain("Revision 1");
    expect(markdown).toContain("Revision 2");
    expect(markdown).not.toContain("secret-value");

    const ledger = await readFile(
      join(
        outputDirectory,
        "history",
        "lessons",
        `${base.lessonId}.jsonl`,
      ),
      "utf8",
    );
    expect(ledger.trim().split(/\r?\n/u)).toHaveLength(2);
    expect(ledger).not.toContain("secret-value");
  });

  it("reports a missing lesson explicitly", async () => {
    const store = new LessonStore({
      outputDirectory: await createTemporaryDirectory(),
    });

    await expect(
      store.renderMarkdown("lesson-missing"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "bumblebee-benchmark-lessons-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

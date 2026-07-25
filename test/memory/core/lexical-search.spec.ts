import { describe, expect, it } from "vitest";

import {
  searchMemoryRecords,
  type MemoryRecord,
} from "../../../src/memory/index.js";

describe("searchMemoryRecords", () => {
  it("ranks key and keyword matches above incidental content matches", () => {
    const records = [
      createRecord({
        content: "The documentation mentions npm in an old migration note.",
        id: "mem_000000000000000000000001",
        key: "migration-note",
      }),
      createRecord({
        content: "Use pnpm for dependency installation.",
        id: "mem_000000000000000000000002",
        key: "package-manager",
        keywords: ["pnpm", "dependencies"],
      }),
    ];

    const results = searchMemoryRecords(records, "pnpm dependencies", 5);

    expect(results.map((item) => item.record.key)).toEqual([
      "package-manager",
    ]);
  });

  it("retrieves Chinese project conventions without a vector database", () => {
    const records = [
      createRecord({
        content: "测试代码统一放在 test 目录并按功能分组。",
        id: "mem_000000000000000000000003",
        key: "测试目录",
        keywords: ["测试", "目录"],
      }),
      createRecord({
        content: "项目使用 TypeScript。",
        id: "mem_000000000000000000000004",
        key: "编程语言",
      }),
    ];

    const results = searchMemoryRecords(records, "测试文件放在哪个目录", 5);

    expect(results[0]?.record.key).toBe("测试目录");
  });

  it("has no read-side mutation", () => {
    const record = createRecord({
      content: "Use pnpm.",
      id: "mem_000000000000000000000005",
      key: "package-manager",
    });
    const before = JSON.stringify(record);

    searchMemoryRecords([record], "pnpm", 5);

    expect(JSON.stringify(record)).toBe(before);
  });
});

function createRecord(
  overrides: Partial<MemoryRecord> &
    Pick<MemoryRecord, "content" | "id" | "key">,
): MemoryRecord {
  return Object.freeze({
    category: "convention",
    createdAt: "2026-07-23T00:00:00.000Z",
    keywords: Object.freeze([]),
    pinned: false,
    revision: 1,
    scope: "project",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  });
}

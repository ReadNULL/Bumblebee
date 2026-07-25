import {
  mkdtemp,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonMemoryRepository,
  LightweightMemory,
  type MemoryDocument,
} from "../../../src/memory/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("LightweightMemory", () => {
  it("upserts by normalized key and survives a restart", async () => {
    const fixture = await createFixture();
    const timestamps = [
      new Date("2026-07-23T00:00:00.000Z"),
      new Date("2026-07-23T00:01:00.000Z"),
    ];
    const memory = new LightweightMemory({
      clock: () => timestamps.shift() ?? new Date(),
      rootDirectory: fixture.root,
    });
    await memory.initialize({ cwd: fixture.workspace });

    const created = await memory.upsert({
      category: "preference",
      content: "Use npm.",
      key: "Package Manager",
      pinned: true,
      scope: "project",
    });
    const updated = await memory.upsert({
      category: "preference",
      content: "Use pnpm.",
      key: " package   manager ",
      keywords: ["dependencies"],
      pinned: true,
      scope: "project",
    });

    expect(created.status).toBe("created");
    expect(updated).toMatchObject({
      record: {
        content: "Use pnpm.",
        id: created.record.id,
        revision: 2,
      },
      status: "updated",
    });
    expect(memory.list({ scope: "project" })).toHaveLength(1);
    await memory.dispose();

    const restored = new LightweightMemory({
      rootDirectory: fixture.root,
    });
    await restored.initialize({ cwd: fixture.workspace });
    expect(restored.list({ scope: "project" })[0]).toMatchObject({
      content: "Use pnpm.",
      revision: 2,
    });
    await restored.dispose();
  });

  it("isolates project memory while sharing global memory", async () => {
    const fixture = await createFixture();
    const secondWorkspace = path.join(fixture.directory, "other-workspace");
    await mkdir(secondWorkspace);
    const first = new LightweightMemory({ rootDirectory: fixture.root });
    await first.initialize({ cwd: fixture.workspace });
    await first.upsert({
      category: "preference",
      content: "Keep answers concise.",
      key: "answer-style",
      scope: "global",
    });
    await first.upsert({
      category: "decision",
      content: "This repository uses npm.",
      key: "package-manager",
      scope: "project",
    });
    await first.dispose();

    const second = new LightweightMemory({ rootDirectory: fixture.root });
    await second.initialize({ cwd: secondWorkspace });

    expect(second.list({ scope: "global" })).toHaveLength(1);
    expect(second.list({ scope: "project" })).toHaveLength(0);
    await second.dispose();
  });

  it("combines pinned and query-relevant records in prompt context", async () => {
    const fixture = await createFixture();
    const memory = new LightweightMemory({ rootDirectory: fixture.root });
    await memory.initialize({ cwd: fixture.workspace });
    await memory.upsert({
      category: "preference",
      content: "Keep answers concise.",
      key: "answer-style",
      pinned: true,
      scope: "global",
    });
    await memory.upsert({
      category: "convention",
      content: "测试文件放在 test 目录。",
      key: "测试目录",
      keywords: ["测试"],
      scope: "project",
    });

    const context = await memory.buildPromptContext("测试代码放在哪里");

    expect(context).toContain("Keep answers concise.");
    expect(context).toContain("测试文件放在 test 目录。");
    await memory.dispose();
  });

  it("exposes only project memory to read-only channel context", async () => {
    const fixture = await createFixture();
    const memory = new LightweightMemory({ rootDirectory: fixture.root });
    await memory.initialize({ cwd: fixture.workspace });
    await memory.upsert({
      category: "preference",
      content: "My private global preference.",
      key: "private-preference",
      pinned: true,
      scope: "global",
    });
    await memory.upsert({
      category: "decision",
      content: "This project uses npm.",
      key: "package-manager",
      pinned: true,
      scope: "project",
    });

    const context = await memory.buildPromptContext("", {
      access: "read-only",
      scope: "project",
    });

    expect(context).toContain("This project uses npm.");
    expect(context).not.toContain("My private global preference.");
    expect(context).not.toContain("bumblebee_memory");
    expect(context).toContain("read-only memory access");
    await memory.dispose();
  });

  it("serializes concurrent updates to the same scoped key", async () => {
    const fixture = await createFixture();
    const timestamps = [
      new Date("2026-07-23T00:00:00.000Z"),
      new Date("2026-07-23T00:01:00.000Z"),
    ];
    const memory = new LightweightMemory({
      clock: () => timestamps.shift() ?? new Date(),
      rootDirectory: fixture.root,
    });
    await memory.initialize({ cwd: fixture.workspace });

    const [first, second] = await Promise.all([
      memory.upsert({
        category: "decision",
        content: "Use npm.",
        key: "package-manager",
        scope: "project",
      }),
      memory.upsert({
        category: "decision",
        content: "Use pnpm.",
        key: "package-manager",
        scope: "project",
      }),
    ]);

    expect(first.status).toBe("created");
    expect(second).toMatchObject({
      record: { content: "Use pnpm.", revision: 2 },
      status: "updated",
    });
    expect(memory.list({ scope: "project" })).toHaveLength(1);
    await memory.dispose();
  });

  it("does not publish a failed write into the in-memory snapshot", async () => {
    const fixture = await createFixture();
    const repository = new FailingSaveRepository();
    const memory = new LightweightMemory({
      repository,
      rootDirectory: fixture.root,
    });
    await memory.initialize({ cwd: fixture.workspace });

    await expect(
      memory.upsert({
        category: "fact",
        content: "This write will fail.",
        key: "failed-write",
        scope: "project",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNAVAILABLE });
    expect(memory.list({ scope: "project" })).toHaveLength(0);
    await memory.dispose();
  });

  it("enforces bounded capacity and supports explicit removal", async () => {
    const fixture = await createFixture();
    const memory = new LightweightMemory({
      maxRecordsPerScope: 1,
      rootDirectory: fixture.root,
    });
    await memory.initialize({ cwd: fixture.workspace });
    const created = await memory.upsert({
      category: "fact",
      content: "First.",
      key: "first",
      scope: "global",
    });

    await expect(
      memory.upsert({
        category: "fact",
        content: "Second.",
        key: "second",
        scope: "global",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
    await expect(
      memory.remove("global", created.record.id),
    ).resolves.toMatchObject({ status: "removed" });
    expect(memory.list({ scope: "global" })).toHaveLength(0);
    await memory.dispose();
  });

  it("rejects new operations after disposal", async () => {
    const fixture = await createFixture();
    const memory = new LightweightMemory({ rootDirectory: fixture.root });
    await memory.initialize({ cwd: fixture.workspace });
    await memory.dispose();

    expect(() => memory.list()).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.CANCELLED }),
    );
  });
});

class FailingSaveRepository extends JsonMemoryRepository {
  override async save(
    _filePath: string,
    _document: MemoryDocument,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
  }
}

async function createFixture(): Promise<{
  readonly directory: string;
  readonly root: string;
  readonly workspace: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "bumblebee-lightweight-memory-"),
  );
  temporaryDirectories.push(directory);
  const root = path.join(directory, "memory");
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  return { directory, root, workspace };
}

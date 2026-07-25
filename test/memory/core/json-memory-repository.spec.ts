import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  freezeDocument,
  freezeMemoryRecord,
  JsonMemoryRepository,
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

describe("JsonMemoryRepository", () => {
  it("atomically replaces an existing document and reloads it", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, "global.json");
    const repository = new JsonMemoryRepository();
    const first = freezeDocument([createRecord("first", 1)]);
    const second = freezeDocument([createRecord("second", 2)]);

    await repository.save(filePath, first);
    await repository.save(filePath, second);

    expect(await repository.load(filePath, "global")).toEqual(second);
    const entries = await readFile(filePath, "utf8");
    expect(entries).toContain('"content": "second"');
  });

  it("returns an empty document when the file does not exist", async () => {
    const directory = await createTemporaryDirectory();
    const repository = new JsonMemoryRepository();

    await expect(
      repository.load(path.join(directory, "missing.json"), "global"),
    ).resolves.toEqual({ records: [], version: 1 });
  });

  it("rejects malformed files instead of overwriting them", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, "global.json");
    const credential = "sk-proj-0123456789abcdef0123456789abcdef";
    const malformed = `{"secret":"${credential}"`;
    await writeFile(filePath, malformed, "utf8");
    const repository = new JsonMemoryRepository();

    const error = await repository.load(filePath, "global").catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      context: { failure: "invalid-json" },
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(await readFile(filePath, "utf8")).toBe(malformed);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "bumblebee-memory-repository-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createRecord(content: string, revision: number) {
  return freezeMemoryRecord({
    category: "fact",
    content,
    createdAt: "2026-07-23T00:00:00.000Z",
    id: "mem_000000000000000000000001",
    key: "example",
    keywords: [],
    pinned: false,
    revision,
    scope: "global",
    updatedAt: revision === 1
      ? "2026-07-23T00:00:00.000Z"
      : "2026-07-23T00:01:00.000Z",
  });
}

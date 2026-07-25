import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/index.js";
import { FIXED_TIME } from "../fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ArtifactStore", () => {
  it("writes sanitized immutable JSON and verifies its digest", async () => {
    const root = await createTemporaryDirectory();
    const store = new ArtifactStore(root, {
      clock: () => new Date(FIXED_TIME),
      idFactory: () => "artifact-fixture",
    });

    const reference = await store.writeJson({
      runId: "run-fixture",
      relativePath: "manifest.json",
      kind: "manifest",
      mediaType: "application/json",
      value: {
        apiKey: "should-not-survive",
        nested: { token: "also-secret" },
      },
    });
    const content = await readFile(
      join(root, ...reference.relativePath.split("/")),
      "utf8",
    );

    expect(content).not.toContain("should-not-survive");
    expect(content).not.toContain("also-secret");
    expect(content).toContain("[REDACTED]");
    await expect(store.verify(reference)).resolves.toMatchObject({
      valid: true,
      actualSha256: reference.sha256,
    });
  });

  it("refuses to overwrite an existing evidence path", async () => {
    const root = await createTemporaryDirectory();
    let nextId = 0;
    const store = new ArtifactStore(root, {
      idFactory: () => `artifact-${nextId += 1}`,
    });
    const input = {
      runId: "run-fixture",
      relativePath: "evidence.json",
      kind: "other" as const,
      mediaType: "application/json",
      value: { result: "first" },
    };

    await store.writeJson(input);
    await expect(store.writeJson(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects path traversal and absolute Windows paths", async () => {
    const store = new ArtifactStore(
      await createTemporaryDirectory(),
    );

    await expect(
      store.writeRaw({
        runId: "run-fixture",
        relativePath: "../outside.txt",
        kind: "other",
        mediaType: "text/plain",
        content: "unsafe",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      store.writeRaw({
        runId: "run-fixture",
        relativePath: "C:\\outside.txt",
        kind: "other",
        mediaType: "text/plain",
        content: "unsafe",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("detects evidence tampering after a raw artifact was recorded", async () => {
    const root = await createTemporaryDirectory();
    const store = new ArtifactStore(root);
    const reference = await store.writeRaw({
      runId: "run-fixture",
      relativePath: "trace.txt",
      kind: "trajectory",
      mediaType: "text/plain",
      content: "original",
    });

    await writeFile(
      join(root, ...reference.relativePath.split("/")),
      "tampered",
      "utf8",
    );

    await expect(store.verify(reference)).resolves.toMatchObject({
      valid: false,
      reason: "hash-mismatch",
    });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "bumblebee-benchmark-artifacts-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

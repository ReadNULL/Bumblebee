import {
  mkdir,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import {
  ERROR_CODES,
  normalizeError,
} from "../../../../src/foundation/index.js";
import {
  JsonMemoryRepository,
  LightweightMemory,
  type MemoryDocument,
} from "../../../../src/memory/index.js";
import type { ScenarioDefinition } from "../runner/index.js";

export const MEMORY_SCENARIOS: readonly ScenarioDefinition[] =
  Object.freeze([
    {
      id: "memory-update-persistence",
      domain: "MemoryCore",
      async run(context, probe) {
        const memoryRoot = path.join(
          context.fixtureDirectory,
          "memory",
        );
        const workspaceA = path.join(
          context.fixtureDirectory,
          "workspace-a",
        );
        const workspaceB = path.join(
          context.fixtureDirectory,
          "workspace-b",
        );
        await Promise.all([
          mkdir(workspaceA, { recursive: true }),
          mkdir(workspaceB, { recursive: true }),
        ]);

        const first = new LightweightMemory({
          rootDirectory: memoryRoot,
        });
        await first.initialize({
          cwd: workspaceA,
          signal: context.signal,
        });
        const created = await first.upsert({
          category: "decision",
          content: "Use npm.",
          key: "Package Manager",
          scope: "project",
        }, context.signal);
        const updated = await first.upsert({
          category: "decision",
          content: "Use pnpm.",
          key: " package   manager ",
          keywords: ["dependencies"],
          scope: "project",
        }, context.signal);
        await first.upsert({
          category: "preference",
          content: "Keep answers concise.",
          key: "answer-style",
          scope: "global",
        }, context.signal);
        await first.dispose();

        const otherProject = new LightweightMemory({
          rootDirectory: memoryRoot,
        });
        await otherProject.initialize({
          cwd: workspaceB,
          signal: context.signal,
        });
        const otherProjectRecords = otherProject.list({
          scope: "project",
        });
        const sharedGlobalRecords = otherProject.list({
          scope: "global",
        });
        await otherProject.dispose();

        const restored = new LightweightMemory({
          rootDirectory: memoryRoot,
        });
        await restored.initialize({
          cwd: workspaceA,
          signal: context.signal,
        });
        const restoredProject = restored.list({ scope: "project" });
        await restored.dispose();

        probe.check(
          "normalized-key-updates-in-place",
          created.record.id === updated.record.id &&
            updated.status === "updated" &&
            updated.record.revision === 2,
        );
        probe.check(
          "updated-value-survives-restart",
          restoredProject.length === 1 &&
            restoredProject[0]?.content === "Use pnpm.",
        );
        probe.check(
          "project-memory-isolated",
          otherProjectRecords.length === 0,
        );
        probe.check(
          "global-memory-shared",
          sharedGlobalRecords.length === 1,
        );
        probe.metric(
          "memory_scope_leak_count",
          otherProjectRecords.length,
        );
      },
    },
    {
      id: "memory-secret-scope",
      domain: "MemoryCore",
      async run(context, probe) {
        const workspace = path.join(
          context.fixtureDirectory,
          "workspace",
        );
        const memoryRoot = path.join(
          context.fixtureDirectory,
          "secret-memory",
        );
        await mkdir(workspace, { recursive: true });

        const memory = new LightweightMemory({
          rootDirectory: memoryRoot,
        });
        await memory.initialize({
          cwd: workspace,
          signal: context.signal,
        });
        let secretErrorCode: string | undefined;
        try {
          await memory.upsert({
            category: "fact",
            content:
              "-----BEGIN PRIVATE KEY-----\nbenchmark\n" +
              "-----END PRIVATE KEY-----",
            key: "credential",
            scope: "project",
          }, context.signal);
        } catch (cause: unknown) {
          secretErrorCode = normalizeError(cause).code;
        }
        const recordCountAfterSecret = memory.list({
          scope: "project",
        }).length;
        await memory.dispose();
        const persistedText = await readAllText(memoryRoot);
        const secretPersisted = persistedText.includes("PRIVATE KEY");

        const failing = new LightweightMemory({
          repository: new FailingSaveRepository(),
          rootDirectory: path.join(
            context.fixtureDirectory,
            "failing-memory",
          ),
        });
        await failing.initialize({
          cwd: workspace,
          signal: context.signal,
        });
        let failedWriteCode: string | undefined;
        try {
          await failing.upsert({
            category: "fact",
            content: "This write must roll back.",
            key: "failed-write",
            scope: "project",
          }, context.signal);
        } catch (cause: unknown) {
          failedWriteCode = normalizeError(cause).code;
        }
        const failedSnapshotCount = failing.list({
          scope: "project",
        }).length;
        await failing.dispose();

        probe.check(
          "secret-input-rejected",
          secretErrorCode === ERROR_CODES.INVALID_INPUT,
        );
        probe.check(
          "secret-not-published-in-memory",
          recordCountAfterSecret === 0,
        );
        probe.check(
          "secret-not-persisted-on-disk",
          !secretPersisted,
        );
        probe.check(
          "failed-write-rolls-back-snapshot",
          failedWriteCode === ERROR_CODES.UNAVAILABLE &&
            failedSnapshotCount === 0,
        );
        probe.metric(
          "secret_persisted_count",
          secretPersisted ? 1 : 0,
        );
      },
    },
  ]);

class FailingSaveRepository extends JsonMemoryRepository {
  override async save(
    _filePath: string,
    _document: MemoryDocument,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw Object.assign(new Error("benchmark disk failure"), {
      code: "EIO",
    });
  }
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

  const values: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      values.push(await readAllText(entryPath));
    } else if (entry.isFile()) {
      values.push(await readFile(entryPath, "utf8"));
    }
  }
  return values.join("\n");
}

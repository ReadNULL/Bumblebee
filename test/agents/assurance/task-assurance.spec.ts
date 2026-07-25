import { describe, expect, it } from "vitest";

import {
  ASSURANCE_CRITIC_MARKER,
  ASSURANCE_FOLLOW_UP_MARKER,
  TaskAssurance,
  extractTaskContract,
} from "../../../src/agents/index.js";

describe("TaskAssurance", () => {
  it("extracts literal contracts and recovery artifacts", () => {
    const contract = extractTaskContract([
      "Recover `/data/app.db` and `/data/app.db-wal`.",
      "SetValRequest must contain fields `key` and `value`.",
      "The final command must be `:wq`.",
    ].join("\n"));

    expect(contract.highRiskRecovery).toBe(true);
    expect(contract.repositoryWideCompatibility).toBe(false);
    expect(contract.artifacts).toEqual([
      "/data/app.db",
      "/data/app.db-wal",
    ]);
    expect(contract.items).toEqual(expect.arrayContaining([
      expect.stringContaining("SetValRequest"),
      "Literal contract: value",
      "Literal contract: :wq",
    ]));
  });

  it("does not let a smoke check erase an unresolved repository failure", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-1";
    assurance.beginTask(
      sessionId,
      "Update the extension. It must retain the public API and pass tests.",
    );
    completeTool(assurance, sessionId, {
      input: { path: "src/example.ts" },
      toolCallId: "write-1",
      toolName: "write",
    });
    completeTool(assurance, sessionId, {
      input: { command: "pytest -q" },
      isError: true,
      toolCallId: "test-1",
      toolName: "bash",
    });
    completeTool(assurance, sessionId, {
      input: { command: "python -c \"print('smoke ok')\"" },
      toolCallId: "smoke-1",
      toolName: "bash",
    });

    const review = assurance.reviewCompletion(sessionId);
    expect(review.shouldFollowUp).toBe(true);
    expect(review.followUpMessage).toContain("pytest");
    expect(
      assurance.getSnapshot(sessionId)?.unresolvedVerificationKeys,
    ).toEqual(["pytest:pytest -q"]);
    expect(
      assurance.reviewCompletion(sessionId).shouldFollowUp,
    ).toBe(false);
  });

  it("requires the failed verification scope to pass again", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-scope";
    assurance.beginTask(sessionId, "Update the implementation.");
    completeTool(assurance, sessionId, {
      input: { path: "src/example.py" },
      toolCallId: "edit-scope",
      toolName: "edit",
    });
    completeTool(assurance, sessionId, {
      input: { command: "pytest tests -q" },
      isError: true,
      toolCallId: "full-test",
      toolName: "bash",
    });
    completeTool(assurance, sessionId, {
      input: { command: "pytest tests/test_smoke.py -q" },
      toolCallId: "narrow-test",
      toolName: "bash",
    });

    expect(
      assurance.getSnapshot(sessionId)?.unresolvedVerificationKeys,
    ).toEqual(["pytest:pytest tests -q"]);

    completeTool(assurance, sessionId, {
      input: { command: "pytest   tests   -q" },
      toolCallId: "full-rerun",
      toolName: "bash",
    });
    expect(
      assurance.getSnapshot(sessionId)?.unresolvedVerificationKeys,
    ).toEqual([]);
  });

  it("preserves state across the bounded follow-up and records critic cost", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-2";
    assurance.beginTask(
      sessionId,
      "The result must keep field `value` and pass pytest.",
    );
    completeTool(assurance, sessionId, {
      input: { path: "schema.proto" },
      toolCallId: "edit-1",
      toolName: "edit",
    });
    expect(assurance.reviewCompletion(sessionId).shouldFollowUp)
      .toBe(true);

    assurance.beginTask(
      sessionId,
      `${ASSURANCE_FOLLOW_UP_MARKER}\nReview again.`,
    );
    completeTool(assurance, sessionId, {
      details: {
        status: "completed",
        usage: { costUsd: 0.0125 },
      },
      input: {
        task: `${ASSURANCE_CRITIC_MARKER} compare the schema`,
      },
      toolCallId: "critic-1",
      toolName: "delegate_task",
    });
    completeTool(assurance, sessionId, {
      input: { command: "pytest -q" },
      toolCallId: "test-2",
      toolName: "bash",
    });

    const snapshot = assurance.getSnapshot(sessionId);
    expect(snapshot).toMatchObject({
      criticCostUsd: 0.0125,
      criticRuns: 1,
      mutationObserved: true,
      successfulVerificationCount: 1,
    });
    expect(assurance.beforeTool(sessionId, {
      input: {
        task: `${ASSURANCE_CRITIC_MARKER} review the schema again`,
      },
      toolCallId: "critic-duplicate",
      toolName: "delegate_task",
    })).toMatchObject({ block: true });
    expect(assurance.reviewCompletion(sessionId).reasons).toEqual([]);
  });

  it("blocks recovery access until copy and hash evidence succeed", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-3";
    assurance.beginTask(
      sessionId,
      "Recover `/data/app.db` and `/data/app.db-wal` without changing the originals.",
    );

    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /data/app.db '.tables'" },
      toolCallId: "open-1",
      toolName: "bash",
    })).toMatchObject({ block: true });

    completeTool(assurance, sessionId, {
      input: {
        command:
          "cp /data/app.db /tmp/app.db.copy && " +
          "cp /data/app.db-wal /tmp/app.db-wal.copy",
      },
      toolCallId: "copy-1",
      toolName: "bash",
    });
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /data/app.db '.tables'" },
      toolCallId: "open-2",
      toolName: "bash",
    })).toMatchObject({ block: true });

    completeTool(assurance, sessionId, {
      input: {
        command:
          "shasum /data/app.db /data/app.db-wal " +
          "/tmp/app.db.copy /tmp/app.db-wal.copy",
      },
      toolCallId: "wrong-hash-1",
      toolName: "bash",
    });
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /data/app.db '.tables'" },
      toolCallId: "open-wrong-hash",
      toolName: "bash",
    })).toMatchObject({ block: true });

    completeTool(assurance, sessionId, {
      input: {
        command:
          "sha256sum /data/app.db /data/app.db-wal " +
          "/tmp/app.db.copy /tmp/app.db-wal.copy",
      },
      toolCallId: "hash-1",
      toolName: "bash",
    });
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /data/app.db '.tables'" },
      toolCallId: "open-3",
      toolName: "bash",
    })).toEqual({});
  });

  it("discovers recovery evidence before application readers open it", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-discovery";
    const policy = assurance.beginTask(
      sessionId,
      "Recover the corrupted database and WAL files in /app.",
    );
    expect(policy).toContain("First enumerate source evidence");

    completeTool(assurance, sessionId, {
      input: { command: "ls -la /app" },
      output: [
        "-rw-r--r-- 1 root root 8192 main.db",
        "-rw-r--r-- 1 root root 16512 main.db-wal",
      ].join("\n"),
      toolCallId: "list-evidence",
      toolName: "bash",
    });

    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /app/main.db '.tables'" },
      toolCallId: "open-discovered",
      toolName: "bash",
    })).toMatchObject({ block: true });

    completeTool(assurance, sessionId, {
      input: {
        command:
          "cp /app/main.db-wal /tmp/main.db-wal.copy && " +
          "sha256sum /app/main.db-wal /tmp/main.db-wal.copy",
      },
      toolCallId: "preserve-wal-only",
      toolName: "bash",
    });
    expect(assurance.beforeTool(sessionId, {
      input: {
        command:
          "cp /app/main.db /tmp/main.db.copy && rm /app/main.db",
      },
      toolCallId: "copy-then-delete",
      toolName: "bash",
    })).toMatchObject({ block: true });
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /app/domain.db '.tables'" },
      toolCallId: "open-unrelated-db",
      toolName: "bash",
    })).toEqual({});
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /app/main.db '.tables'" },
      toolCallId: "open-db-with-prefix-collision",
      toolName: "bash",
    })).toMatchObject({ block: true });

    completeTool(assurance, sessionId, {
      input: {
        command:
          "cp /app/main.db /tmp/main.db.copy && " +
          "sha256sum /app/main.db /tmp/main.db.copy",
      },
      toolCallId: "preserve-db",
      toolName: "bash",
    });
    expect(assurance.beforeTool(sessionId, {
      input: { command: "sqlite3 /app/main.db '.tables'" },
      toolCallId: "open-preserved-db",
      toolName: "bash",
    })).toEqual({});
  });

  it("requires an unrestricted post-change scan for compatibility migrations", () => {
    const assurance = new TaskAssurance();
    const sessionId = "session-compatibility";
    const policy = assurance.beginTask(
      sessionId,
      "Compile this package from source and make the repository compatible with the upgraded API.",
    );
    expect(policy).toContain(
      "Repository-wide compatibility mode is active",
    );

    completeTool(assurance, sessionId, {
      input: { path: "src/compat.py" },
      toolCallId: "compat-edit",
      toolName: "edit",
    });
    completeTool(assurance, sessionId, {
      input: {
        command:
          "grep -rn 'removed_api' src --include='*.py' --include='*.pyx'",
      },
      toolCallId: "restricted-scan",
      toolName: "bash",
    });
    completeTool(assurance, sessionId, {
      details: { usage: { costUsd: 0.001 } },
      input: {
        task:
          `${ASSURANCE_CRITIC_MARKER} review every source type`,
      },
      toolCallId: "compat-critic",
      toolName: "delegate_task",
    });
    completeTool(assurance, sessionId, {
      input: { command: "pytest -q" },
      toolCallId: "compat-test",
      toolName: "bash",
    });

    const incomplete = assurance.reviewCompletion(sessionId);
    expect(incomplete.reasons).toEqual([
      expect.stringContaining("recursive scan"),
    ]);
    expect(
      assurance.getSnapshot(sessionId)?.broadCompatibilityScanObserved,
    ).toBe(false);

    completeTool(assurance, sessionId, {
      input: {
        command:
          "rg 'removed_api|replacement_api' . -g '!build/**'",
      },
      toolCallId: "broad-scan",
      toolName: "bash",
    });
    expect(
      assurance.getSnapshot(sessionId)?.broadCompatibilityScanObserved,
    ).toBe(true);
    expect(assurance.reviewCompletion(sessionId).reasons).toEqual([]);
  });
});

function completeTool(
  assurance: TaskAssurance,
  sessionId: string,
  input: {
    readonly details?: unknown;
    readonly input: Readonly<Record<string, unknown>>;
    readonly isError?: boolean;
    readonly output?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  },
): void {
  const decision = assurance.beforeTool(sessionId, {
    input: input.input,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });
  expect(decision.block).not.toBe(true);
  assurance.afterTool(sessionId, {
    ...(input.details === undefined
      ? {}
      : { details: input.details }),
    isError: input.isError ?? false,
    ...(input.output === undefined ? {} : { output: input.output }),
    toolCallId: input.toolCallId,
  });
}

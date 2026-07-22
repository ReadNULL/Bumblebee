import { describe, expect, it, vi } from "vitest";

import {
  createSubAgentErrorResult,
  MAX_SUBAGENT_TASK_LENGTH,
  SubAgentRunner,
  type SubAgentExecutor,
} from "../../../src/agents/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/index.js";

describe("SubAgentRunner", () => {
  it("normalizes a task and returns bounded structured usage", async () => {
    const execute = vi.fn<SubAgentExecutor["execute"]>(async () => ({
      model: "provider/model",
      output: "  focused result  ",
      usage: {
        assistantTurns: 2,
        costUsd: 0.012,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    }));
    const runner = new SubAgentRunner({ execute });
    const signal = new AbortController().signal;

    const result = await runner.run(
      { cwd: " C:/workspace ", task: " inspect authentication " },
      signal,
    );

    expect(execute).toHaveBeenCalledWith({
      cwd: "C:/workspace",
      signal,
      task: "inspect authentication",
    });
    expect(result).toMatchObject({
      model: "provider/model",
      omittedOutputBytes: 0,
      output: "focused result",
      outputBytes: 14,
      status: "completed",
      truncated: false,
      usage: {
        assistantTurns: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.012,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
    });
  });

  it("truncates at a UTF-8 boundary without splitting a character", async () => {
    const runner = new SubAgentRunner(
      { execute: async () => ({ output: "你你你" }) },
      { maxOutputBytes: 7 },
    );

    const result = await runner.run(
      { cwd: "C:/workspace", task: "inspect" },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      omittedOutputBytes: 3,
      output: "你你",
      outputBytes: 6,
      truncated: true,
    });
  });

  it("rejects invalid input before invoking the executor", async () => {
    const execute = vi.fn<SubAgentExecutor["execute"]>();
    const runner = new SubAgentRunner({ execute });
    const signal = new AbortController().signal;

    await expect(
      runner.run({ cwd: "C:/workspace", task: " " }, signal),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    await expect(
      runner.run(
        {
          cwd: "C:/workspace",
          task: "x".repeat(MAX_SUBAGENT_TASK_LENGTH + 1),
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps timeout, cancellation, and safe failures to distinct results", () => {
    const timedOut = createSubAgentErrorResult(
      new BumblebeeError("deadline", { code: ERROR_CODES.TIMEOUT }),
      300_000,
    );
    const cancelled = createSubAgentErrorResult(
      new BumblebeeError("stop", { code: ERROR_CODES.CANCELLED }),
      300_000,
    );
    const failed = createSubAgentErrorResult(
      new BumblebeeError("internal secret", {
        code: ERROR_CODES.UNAVAILABLE,
        userMessage: "模型暂不可用。",
      }),
      300_000,
    );

    expect(timedOut).toMatchObject({
      status: "timed_out",
      timeoutMs: 300_000,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(failed).toMatchObject({
      message: "模型暂不可用。",
      status: "failed",
    });
    expect(JSON.stringify(failed)).not.toContain("internal secret");
  });
});

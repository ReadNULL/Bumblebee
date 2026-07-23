import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAgentDojoManifest,
  parseAgentDojoResult,
  type AgentDojoManifest,
  type AgentDojoSubjectProfile,
  type NormalizedAgentDojoRun,
} from "../src/index.js";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestPath = resolve(
  benchmarkRoot,
  "manifests/agentdojo-workspace-v1.json",
);
const candidateCommit =
  "0123456789abcdef0123456789abcdef01234567";

export interface RawResultOptions {
  readonly profile?: AgentDojoSubjectProfile;
  readonly status?: "completed" | "failed";
  readonly traceCount?: number;
}

export function loadRawManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as Record<string, unknown>;
}

export function createTestManifest(): AgentDojoManifest {
  return parseAgentDojoManifest(loadRawManifest());
}

export function createRawResult(
  manifest: AgentDojoManifest,
  options: RawResultOptions = {},
): Record<string, unknown> {
  const profile = options.profile ?? "bumblebee-full";
  const status = options.status ?? "completed";
  const cleanCases = [
    { userTaskId: "user_task_0", utility: true },
    { userTaskId: "user_task_1", utility: true },
  ];
  const attackCases = [
    {
      userTaskId: "user_task_0",
      injectionTaskId: "injection_task_0",
      utility: true,
      security: true,
    },
    {
      userTaskId: "user_task_0",
      injectionTaskId: "injection_task_1",
      utility: true,
      security: true,
    },
    {
      userTaskId: "user_task_1",
      injectionTaskId: "injection_task_0",
      utility: false,
      security: true,
    },
    {
      userTaskId: "user_task_1",
      injectionTaskId: "injection_task_1",
      utility: false,
      security: false,
    },
  ];
  const injectionUtilityCases = [
    { injectionTaskId: "injection_task_0", utility: true },
    { injectionTaskId: "injection_task_1", utility: true },
  ];
  const expectedTraceCount =
    cleanCases.length +
    attackCases.length +
    injectionUtilityCases.length;
  const traceCount = options.traceCount ?? expectedTraceCount;
  const subject = profile === "bumblebee-full"
    ? {
        profile,
        piVersion: manifest.agents.piVersion,
        bumblebeeCommit: candidateCommit,
        extensionSource:
          manifest.agents.extensionSourcePrefix + candidateCommit,
        workspaceClean: true,
      }
    : {
        profile,
        piVersion: manifest.agents.piVersion,
        workspaceClean: false,
      };

  return {
    contractVersion: 1,
    adapterRunId: "adapter-fixture-1",
    adapterVersion: "1.0.0",
    status,
    startedAt: "2026-07-23T10:00:00.000Z",
    finishedAt: "2026-07-23T10:00:08.000Z",
    durationMs: 8_000,
    dataset: {
      package: manifest.dataset.package,
      packageVersion: manifest.dataset.packageVersion,
      benchmarkVersion: manifest.dataset.benchmarkVersion,
      suite: manifest.dataset.suite,
      attack: manifest.dataset.attack,
      contentSha256: "a".repeat(64),
      userTaskCount: 40,
      injectionTaskCount: 27,
      toolCount: 20,
    },
    subject,
    model: {
      provider: "openai",
      model: "gpt-fixture",
      thinkingLevel: "high",
    },
    bridge: {
      protocolVersion: manifest.bridge.protocolVersion,
      approvalPolicy: manifest.bridge.approvalPolicy,
      systemPromptSha256: createHash("sha256")
        .update(manifest.bridge.systemPrompt, "utf8")
        .digest("hex"),
      maxResponseBytes: manifest.bridge.maxResponseBytes,
    },
    selection: {
      userTaskIds: ["user_task_0", "user_task_1"],
      injectionTaskIds: [
        "injection_task_0",
        "injection_task_1",
      ],
    },
    cleanCases: status === "completed" ? cleanCases : [],
    attackCases: status === "completed" ? attackCases : [],
    injectionUtilityCases:
      status === "completed" ? injectionUtilityCases : [],
    traces: status === "completed"
      ? Array.from(
          { length: traceCount },
          (_, index) => createTrace(index),
        )
      : [],
    ...(status === "failed"
      ? {
          failure: {
            category: "adapter",
            code: "AGENTDOJO_ADAPTER_FAILED",
            message: "fixture adapter failure\nwith diagnostics",
            retryable: true,
          },
        }
      : {}),
  };
}

export function createNormalizedResult(
  manifest: AgentDojoManifest,
  options: RawResultOptions = {},
): NormalizedAgentDojoRun {
  return parseAgentDojoResult(
    createRawResult(manifest, options),
    manifest,
    {
      sourceSha256: "f".repeat(64),
      sourceFileName: "fixture-result.json",
    },
  );
}

export function getCandidateCommit(): string {
  return candidateCommit;
}

function createTrace(index: number) {
  const started = new Date(
    Date.parse("2026-07-23T10:00:00.000Z") +
      index * 1_000,
  );
  const finished = new Date(started.getTime() + 500);
  return {
    invocationId: `invocation-${index}`,
    querySha256: index.toString(16).padStart(64, "0"),
    status: "completed",
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: 500,
    toolCallCount: index % 3,
    permissionPromptCount: index % 2,
    tokens: {
      input: 100 + index,
      output: 20 + index,
      cacheRead: 10,
    },
    costUsd: 0.01,
  };
}

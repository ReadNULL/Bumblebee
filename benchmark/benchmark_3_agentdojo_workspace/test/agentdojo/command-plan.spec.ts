import { describe, expect, it } from "vitest";

import { createAgentDojoRunPlan } from "../../src/index.js";
import {
  createTestManifest,
  getCandidateCommit,
} from "../fixtures.js";

describe("AgentDojo command planner", () => {
  it("pins candidate source and requests fresh traces", () => {
    const manifest = createTestManifest();
    const plan = createAgentDojoRunPlan(manifest, {
      profile: "bumblebee-full",
      pythonExecutable: "C:\\Python 3\\python.exe",
      manifestPath: "D:\\repo\\manifest.json",
      provider: "openai",
      model: "gpt-fixture",
      outputPath: "D:\\repo\\candidate.json",
      logDirectory: "D:\\repo\\logs",
      bumblebeeCommit: getCandidateCommit(),
      workspaceClean: true,
      thinkingLevel: "high",
      userTaskIds: ["user_task_0"],
      injectionTaskIds: ["injection_task_0"],
    });

    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--profile",
        "bumblebee-full",
        "--bumblebee-commit",
        getCandidateCommit(),
        "--workspace-clean",
        "--force-rerun",
      ]),
    );
    expect(plan.displayCommand).toContain(
      "'C:\\Python 3\\python.exe'",
    );
  });

  it("keeps the pi baseline free of Bumblebee identity", () => {
    const manifest = createTestManifest();
    const plan = createAgentDojoRunPlan(manifest, {
      profile: "pi-baseline",
      pythonExecutable: "python",
      manifestPath: "manifest.json",
      provider: "openai",
      model: "gpt-fixture",
      outputPath: "baseline.json",
      logDirectory: "logs",
    });

    expect(plan.arguments).not.toContain("--bumblebee-commit");
    expect(plan.arguments).toContain("--force-rerun");
  });

  it("rejects an unpinned or dirty candidate", () => {
    const manifest = createTestManifest();
    const base = {
      profile: "bumblebee-full" as const,
      pythonExecutable: "python",
      manifestPath: "manifest.json",
      provider: "openai",
      model: "gpt-fixture",
      outputPath: "candidate.json",
      logDirectory: "logs",
    };

    expect(() =>
      createAgentDojoRunPlan(manifest, {
        ...base,
        bumblebeeCommit: "abc",
        workspaceClean: true,
      })
    ).toThrow(/full commit SHA/u);
    expect(() =>
      createAgentDojoRunPlan(manifest, {
        ...base,
        bumblebeeCommit: getCandidateCommit(),
        workspaceClean: false,
      })
    ).toThrow(/clean workspace/u);
  });

  it("rejects duplicate task selections", () => {
    const manifest = createTestManifest();

    expect(() =>
      createAgentDojoRunPlan(manifest, {
        profile: "pi-baseline",
        pythonExecutable: "python",
        manifestPath: "manifest.json",
        provider: "openai",
        model: "gpt-fixture",
        outputPath: "baseline.json",
        logDirectory: "logs",
        userTaskIds: ["user_task_0", "user_task_0"],
      })
    ).toThrow(/duplicate/u);
  });
});

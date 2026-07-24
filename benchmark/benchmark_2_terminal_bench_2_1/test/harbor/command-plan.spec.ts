import { describe, expect, it } from "vitest";

import {
  createHarborPreflightPlan,
  createHarborRunPlan,
} from "../../src/index.js";
import {
  createTestManifest,
  getCandidateExtension,
} from "../fixtures.js";

describe("Harbor command plan", () => {
  it("builds a manifest-sized baseline without Bumblebee", () => {
    const plan = createHarborRunPlan(createTestManifest(), {
      mode: "baseline",
      model: "openai/gpt-fixture",
      environment: "docker",
      concurrency: 2,
      jobName: "tb21-baseline",
    });

    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pi_agent:PinnedPi$/u),
      ]),
    );
    expect(plan.executable).toBe("python");
    expect(plan.arguments.slice(0, 2)).toEqual([
      "-m",
      "harbor.cli.main",
    ]);
    expect(
      valueAfter(
        plan.arguments,
        "--agent-setup-timeout-multiplier",
      ),
    ).toBe("3");
    expect(valueAfter(plan.arguments, "--max-retries")).toBe(
      "2",
    );
    expect(valuesAfter(plan.arguments, "--retry-include"))
      .toEqual([
        "ApiOverloadedError",
        "ApiRateLimitError",
        "ApiInternalServerError",
        "NetworkConnectionError",
        "UnknownApiError",
      ]);
    expect(plan.displayCommand).toMatch(
      /^python -m harbor\.cli\.main run /u,
    );
    expect(plan.arguments).toContain("2");
    const selectedTasks = createTestManifest().dataset.selectedTasks;
    expect(
      valuesAfter(plan.arguments, "--include-task-name"),
    ).toEqual(selectedTasks.map((task) => task.id));
    expect(plan.displayCommand).not.toContain(
      "bumblebee_extension",
    );
  });

  it("requires and passes a commit-pinned candidate extension", () => {
    const extensionSource = getCandidateExtension();
    const plan = createHarborRunPlan(createTestManifest(), {
      mode: "candidate",
      model: "openai/gpt-fixture",
      environment: "docker",
      concurrency: 1,
      jobName: "tb21-candidate",
      extensionSource,
      thinking: "high",
    });

    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/pi_agent:BumblebeePi$/u),
      ]),
    );
    expect(plan.arguments).toContain(
      `bumblebee_extension=${extensionSource}`,
    );
    expect(plan.arguments).toContain("bumblebee_profile=full");
    expect(plan.arguments).toContain("thinking=high");
  });

  it("builds a frozen task subset with an explicit profile", () => {
    const extensionSource = getCandidateExtension();
    const plan = createHarborRunPlan(createTestManifest(), {
      mode: "candidate",
      model: "openai/gpt-fixture",
      environment: "docker",
      concurrency: 4,
      jobName: "tb21-targeted",
      extensionSource,
      profile: "permission-only",
      repetitions: 3,
      taskIds: ["task-alpha"],
    });

    expect(valueAfter(plan.arguments, "-k")).toBe("3");
    expect(
      valuesAfter(plan.arguments, "--include-task-name"),
    ).toEqual(["task-alpha"]);
    expect(plan.arguments).toContain(
      "bumblebee_profile=permission-only",
    );
  });

  it("builds a no-model verifier preflight for every frozen task", () => {
    const manifest = createTestManifest();
    const plan = createHarborPreflightPlan(manifest, {
      environment: "docker",
      concurrency: 4,
      jobName: "tb21-preflight",
    });

    expect(
      plan.arguments.some((value) =>
        /pi_agent:VerifierPreflight$/u.test(value)
      ),
    ).toBe(true);
    expect(valueAfter(plan.arguments, "-k")).toBe("1");
    expect(valueAfter(plan.arguments, "-n")).toBe("4");
    expect(valuesAfter(plan.arguments, "-m")).toEqual([
      "harbor.cli.main",
    ]);
    expect(
      valuesAfter(plan.arguments, "--include-task-name"),
    ).toEqual(
      manifest.dataset.selectedTasks.map((task) => task.id),
    );
  });

  it("rejects a targeted task outside the frozen manifest", () => {
    expect(() =>
      createHarborRunPlan(createTestManifest(), {
        mode: "baseline",
        model: "openai/gpt-fixture",
        environment: "docker",
        concurrency: 1,
        jobName: "tb21-invalid-subset",
        taskIds: ["not-in-manifest"],
      })
    ).toThrow(/outside the frozen manifest/u);
  });

  it("rejects a moving branch as candidate identity", () => {
    expect(() =>
      createHarborRunPlan(createTestManifest(), {
        mode: "candidate",
        model: "openai/gpt-fixture",
        environment: "docker",
        concurrency: 1,
        jobName: "tb21-candidate",
        extensionSource:
          "git:github.com/ReadNULL/Bumblebee@main",
      })
    ).toThrow(/commit-pinned/u);
  });

  it("rejects a pinned commit from a different repository", () => {
    expect(() =>
      createHarborRunPlan(createTestManifest(), {
        mode: "candidate",
        model: "openai/gpt-fixture",
        environment: "docker",
        concurrency: 1,
        jobName: "tb21-candidate",
        extensionSource:
          "git:github.com/example/Bumblebee@" +
          "0123456789abcdef0123456789abcdef01234567",
      })
    ).toThrow(/commit-pinned/u);
  });
});

function valuesAfter(
  values: readonly string[],
  option: string,
): string[] {
  return values.flatMap((value, index) =>
    value === option && values[index + 1] !== undefined
      ? [values[index + 1] as string]
      : []
  );
}

function valueAfter(
  values: readonly string[],
  option: string,
): string | undefined {
  const index = values.indexOf(option);
  return index < 0 ? undefined : values[index + 1];
}

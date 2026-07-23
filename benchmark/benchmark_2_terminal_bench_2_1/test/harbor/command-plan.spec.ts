import { describe, expect, it } from "vitest";

import { createHarborRunPlan } from "../../src/index.js";
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
    expect(plan.arguments).toContain("2");
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
    expect(plan.arguments).toContain("thinking=high");
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

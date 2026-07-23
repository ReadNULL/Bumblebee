import { describe, expect, it } from "vitest";

import { parseAgentDojoManifest } from "../../src/index.js";
import {
  createTestManifest,
  loadRawManifest,
} from "../fixtures.js";

describe("AgentDojo manifest", () => {
  it("loads the frozen Workspace contract", () => {
    const manifest = createTestManifest();

    expect(manifest.dataset).toMatchObject({
      package: "agentdojo",
      packageVersion: "0.1.35",
      benchmarkVersion: "v1.2.2",
      suite: "workspace",
      attack: "important_instructions",
    });
    expect(manifest.bridge.approvalPolicy).toBe("allow-once");
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("rejects score-weight drift", () => {
    const raw = loadRawManifest();
    const scoreSpec = raw.scoreSpec as {
      components: Array<{ id: string; weight: number }>;
    };
    scoreSpec.components[0]!.weight = 0.3;
    scoreSpec.components[1]!.weight = 0.3;

    expect(() => parseAgentDojoManifest(raw)).toThrow(
      /component is not frozen/u,
    );
  });

  it("rejects bridge-policy drift", () => {
    const raw = loadRawManifest();
    const bridge = raw.bridge as Record<string, unknown>;
    bridge.protocolVersion = 2;

    expect(() => parseAgentDojoManifest(raw)).toThrow(
      /protocolVersion must be 1/u,
    );
  });

  it("rejects hard-gate drift", () => {
    const raw = loadRawManifest();
    const scoreSpec = raw.scoreSpec as {
      hardGates: Array<{ id: string; threshold: number }>;
    };
    const capabilityGate = scoreSpec.hardGates.find(
      (gate) => gate.id === "injection_goal_capability",
    );
    capabilityGate!.threshold = 0;

    expect(() => parseAgentDojoManifest(raw)).toThrow(
      /hard gate is not frozen/u,
    );
  });
});

import { describe, expect, it } from "vitest";

import { parseAgentDojoResult } from "../../src/index.js";
import {
  createRawResult,
  createTestManifest,
} from "../fixtures.js";

const provenance = {
  sourceSha256: "f".repeat(64),
  sourceFileName: "fixture-result.json",
};

describe("AgentDojo result importer", () => {
  it("normalizes a complete result and preserves provenance", () => {
    const manifest = createTestManifest();
    const result = parseAgentDojoResult(
      createRawResult(manifest),
      manifest,
      provenance,
    );

    expect(result.attackCases).toHaveLength(4);
    expect(result.traces).toHaveLength(8);
    expect(result.provenance).toEqual(provenance);
  });

  it("rejects duplicate and incomplete attack matrices", () => {
    const manifest = createTestManifest();
    const duplicate = createRawResult(manifest);
    const duplicateCases = duplicate.attackCases as Array<
      Record<string, unknown>
    >;
    duplicateCases[1] = { ...duplicateCases[0] };

    expect(() =>
      parseAgentDojoResult(duplicate, manifest, provenance)
    ).toThrow(/duplicate entries/u);

    const incomplete = createRawResult(manifest);
    const incompleteCases = incomplete.attackCases as unknown[];
    incompleteCases.pop();
    expect(() =>
      parseAgentDojoResult(incomplete, manifest, provenance)
    ).toThrow(/Cartesian product/u);
  });

  it("rejects contradictory completion and trace states", () => {
    const manifest = createTestManifest();
    const completedWithFailure = createRawResult(manifest);
    completedWithFailure.failure = {
      category: "adapter",
      code: "UNEXPECTED",
      message: "failure",
    };
    expect(() =>
      parseAgentDojoResult(
        completedWithFailure,
        manifest,
        provenance,
      )
    ).toThrow(/must not have failure/u);

    const failedTrace = createRawResult(manifest);
    const traces = failedTrace.traces as Array<
      Record<string, unknown>
    >;
    traces[0]!.status = "failed";
    expect(() =>
      parseAgentDojoResult(failedTrace, manifest, provenance)
    ).toThrow(/failed without a failure/u);
  });

  it("accepts failed adapter envelopes with multiline diagnostics", () => {
    const manifest = createTestManifest();
    const result = parseAgentDojoResult(
      createRawResult(manifest, { status: "failed" }),
      manifest,
      provenance,
    );

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("\n");
  });
});

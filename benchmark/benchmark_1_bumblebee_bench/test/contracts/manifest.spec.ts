import { describe, expect, it } from "vitest";

import {
  parseBumblebeeBenchManifest,
} from "../../src/index.js";
import { loadFixtureManifest } from "../fixtures.js";

describe("BumblebeeBench manifest", () => {
  it("freezes six domains, twelve scenarios, and both profiles", async () => {
    const manifest = await loadFixtureManifest();

    expect(manifest.domains).toHaveLength(6);
    expect(
      manifest.domains.flatMap((domain) => domain.scenarios),
    ).toHaveLength(12);
    expect(manifest.profiles).toEqual({
      smoke: { repetitions: 1 },
      full: { repetitions: 30 },
    });
    expect(
      manifest.domains.reduce(
        (total, domain) => total + domain.weight,
        0,
      ),
    ).toBeCloseTo(1);
  });

  it("rejects a manifest whose domain weights were changed in isolation", async () => {
    const manifest = await loadFixtureManifest();
    const mutable = {
      ...manifest,
      domains: manifest.domains.map((domain, index) =>
        index === 0 ? { ...domain, weight: 0.1 } : domain
      ),
    };

    expect(() => parseBumblebeeBenchManifest(mutable)).toThrow(
      /weights must sum to 1/u,
    );
  });

  it("rejects duplicate scenario ids", async () => {
    const manifest = await loadFixtureManifest();
    const duplicateId = manifest.domains[0]!.scenarios[0]!.id;
    const mutable = {
      ...manifest,
      domains: manifest.domains.map((domain, domainIndex) => ({
        ...domain,
        scenarios: domain.scenarios.map((scenario, scenarioIndex) =>
          domainIndex === 1 && scenarioIndex === 0
            ? { ...scenario, id: duplicateId }
            : scenario
        ),
      })),
    };

    expect(() => parseBumblebeeBenchManifest(mutable)).toThrow(
      /duplicate scenario ids/u,
    );
  });

  it("normalizes malformed score specs instead of leaking TypeError", async () => {
    const manifest = await loadFixtureManifest();
    const mutable = {
      ...manifest,
      scoreSpec: {
        ...manifest.scoreSpec,
        components: [null],
      },
    };

    expect(() => parseBumblebeeBenchManifest(mutable)).toThrow(
      /manifest\.scoreSpec is invalid/u,
    );
  });
});

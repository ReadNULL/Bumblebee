import { describe, expect, it } from "vitest";

import {
  resolveBumblebeeFeatureProfile,
} from "../../src/config/index.js";

describe("resolveBumblebeeFeatureProfile", () => {
  it("keeps full as the production default", () => {
    expect(resolveBumblebeeFeatureProfile(undefined)).toEqual({
      name: "full",
      features: {
        assurance: true,
        channels: true,
        memory: true,
        permission: true,
        subagent: true,
      },
    });
  });

  it("provides reproducible baseline and permission-only ablations", () => {
    expect(
      resolveBumblebeeFeatureProfile("pi-baseline").features,
    ).toEqual({
      assurance: false,
      channels: false,
      memory: false,
      permission: false,
      subagent: false,
    });
    expect(
      resolveBumblebeeFeatureProfile("permission-only").features,
    ).toEqual({
      assurance: true,
      channels: false,
      memory: false,
      permission: true,
      subagent: false,
    });
  });

  it("rejects unknown profiles instead of silently changing features", () => {
    expect(() =>
      resolveBumblebeeFeatureProfile("memory-only")
    ).toThrow("must be one of");
  });
});

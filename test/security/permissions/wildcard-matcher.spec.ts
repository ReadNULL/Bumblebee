import { describe, expect, it } from "vitest";

import { matchesPermissionPattern } from "../../../src/security/index.js";

describe("matchesPermissionPattern", () => {
  it("supports permission wildcards without interpreting shell syntax", () => {
    expect(
      matchesPermissionPattern("src/*.ts", "src/index.ts", {
        caseSensitive: true,
      }),
    ).toBe(true);
    expect(
      matchesPermissionPattern("src/*.ts", "src/nested/index.ts", {
        caseSensitive: true,
      }),
    ).toBe(false);
    expect(
      matchesPermissionPattern("src/**", "src/nested/index.ts", {
        caseSensitive: true,
      }),
    ).toBe(true);
  });

  it("honors the intent case-sensitivity setting", () => {
    expect(
      matchesPermissionPattern("README.?D", "readme.md", {
        caseSensitive: false,
      }),
    ).toBe(true);
    expect(
      matchesPermissionPattern("README.?D", "readme.md", {
        caseSensitive: true,
      }),
    ).toBe(false);
  });
});

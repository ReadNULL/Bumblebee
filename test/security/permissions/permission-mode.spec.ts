import { describe, expect, it } from "vitest";

import {
  formatPermissionMode,
  hasPermission,
  mergePermissionModes,
  PERMISSION_MODES,
  removePermissionMode,
} from "../../../src/security/index.js";

describe("permission mode", () => {
  it("checks and formats Linux-like capability bits", () => {
    expect(hasPermission(PERMISSION_MODES.READ_WRITE, PERMISSION_MODES.READ))
      .toBe(true);
    expect(hasPermission(PERMISSION_MODES.READ, PERMISSION_MODES.WRITE))
      .toBe(false);
    expect(formatPermissionMode(PERMISSION_MODES.READ_WRITE)).toBe("rw-");
  });

  it("merges and removes capabilities without changing the resource", () => {
    const merged = mergePermissionModes(
      PERMISSION_MODES.READ,
      PERMISSION_MODES.WRITE,
    );

    expect(merged).toBe(PERMISSION_MODES.READ_WRITE);
    expect(removePermissionMode(merged, PERMISSION_MODES.READ))
      .toBe(PERMISSION_MODES.WRITE);
  });
});

import { describe, expect, it } from "vitest";

import {
  runAssuranceDevelopmentSuite,
} from "../../src/index.js";

describe("task assurance development suite", () => {
  it("passes the development split", () => {
    const report = runAssuranceDevelopmentSuite("dev");

    expect(report.total).toBe(4);
    expect(report.failed).toBe(0);
  });

  it("passes the untouched holdout split", () => {
    const report = runAssuranceDevelopmentSuite("holdout");

    expect(report.total).toBe(4);
    expect(report.failed).toBe(0);
  });
});

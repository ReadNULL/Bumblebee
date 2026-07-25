import { describe, expect, it } from "vitest";

import {
  throwIfAborted,
} from "../../../src/foundation/cancellation/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../../src/foundation/errors/index.js";

describe("throwIfAborted", () => {
  it("does nothing for an active or missing signal", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it("normalizes an arbitrary abort reason as CANCELLED", () => {
    const controller = new AbortController();
    controller.abort("user requested stop");

    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BumblebeeError);
    expect(caught).toMatchObject({
      code: ERROR_CODES.CANCELLED,
      cause: "user requested stop",
    });
  });

  it("preserves an existing BumblebeeError reason", () => {
    const reason = new BumblebeeError("outer deadline reached", {
      code: ERROR_CODES.TIMEOUT,
    });
    const controller = new AbortController();
    controller.abort(reason);

    let caught: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(reason);
  });
});

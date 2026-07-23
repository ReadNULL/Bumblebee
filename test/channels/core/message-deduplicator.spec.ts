import { describe, expect, it } from "vitest";

import {
  MessageDeduplicator,
} from "../../../src/channels/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

describe("MessageDeduplicator", () => {
  it("blocks duplicates during processing and until the TTL expires", () => {
    let now = 1_000;
    const deduplicator = new MessageDeduplicator({
      clock: () => now,
      ttlMs: 100,
    });

    const lease = deduplicator.tryAcquire("feishu:message-1");
    expect(lease).toBeDefined();
    expect(deduplicator.inFlightCount).toBe(1);
    expect(deduplicator.tryAcquire("feishu:message-1")).toBeUndefined();

    lease?.commit();
    expect(deduplicator.inFlightCount).toBe(0);
    now = 1_099;
    expect(deduplicator.tryAcquire("feishu:message-1")).toBeUndefined();

    now = 1_100;
    const nextLease = deduplicator.tryAcquire("feishu:message-1");
    expect(nextLease).toBeDefined();
    nextLease?.release();
    expect(deduplicator.size).toBe(0);
  });

  it("releases failed work so a platform retry can run", () => {
    const deduplicator = new MessageDeduplicator();
    const lease = deduplicator.tryAcquire("message-1");

    lease?.release();
    lease?.commit();
    expect(deduplicator.tryAcquire("message-1")).toBeDefined();
  });

  it("evicts completed entries but never evicts in-flight work", () => {
    const deduplicator = new MessageDeduplicator({ capacity: 2 });
    deduplicator.tryAcquire("completed")?.commit();
    const firstActive = deduplicator.tryAcquire("active-1");

    const secondActive = deduplicator.tryAcquire("active-2");
    expect(secondActive).toBeDefined();
    expect(deduplicator.tryAcquire("active-2")).toBeUndefined();

    expect(() => deduplicator.tryAcquire("active-3")).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.UNAVAILABLE,
        retryable: true,
      }),
    );
    firstActive?.release();
    secondActive?.release();
  });
});

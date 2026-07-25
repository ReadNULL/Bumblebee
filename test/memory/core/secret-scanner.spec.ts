import { describe, expect, it } from "vitest";

import {
  assertNoPersistedSecret,
  normalizeMemoryInput,
} from "../../../src/memory/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

describe("memory secret scanner", () => {
  it.each([
    "-----BEGIN PRIVATE KEY-----",
    "api_key=abcdefghijklmnop",
    "postgres://user:password@localhost/db",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
  ])("rejects high-confidence credential shape: %s", (content) => {
    expect(() => assertNoPersistedSecret([content])).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        userMessage:
          "记忆内容疑似包含密钥、令牌或密码，已拒绝持久化。",
      }),
    );
  });

  it("allows security guidance that does not contain a credential value", () => {
    expect(() =>
      normalizeMemoryInput({
        category: "convention",
        content: "Read API_KEY from the process environment.",
        key: "credential-policy",
        keywords: ["security", "environment"],
        scope: "project",
      })
    ).not.toThrow();
  });
});

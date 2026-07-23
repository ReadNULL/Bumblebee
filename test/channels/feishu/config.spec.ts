import { describe, expect, it } from "vitest";

import {
  FEISHU_ALLOWED_SENDER_IDS_ENV,
  FEISHU_APP_ID_ENV,
  FEISHU_APP_SECRET_ENV,
  FEISHU_ENABLED_ENV,
  isFeishuSenderAllowed,
  loadFeishuConfig,
} from "../../../src/channels/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

const VALID_ENVIRONMENT = {
  [FEISHU_ALLOWED_SENDER_IDS_ENV]: "ou_owner, ou_teammate,ou_owner",
  [FEISHU_APP_ID_ENV]: "cli_0123456789abcdef",
  [FEISHU_APP_SECRET_ENV]: "secret-value",
  [FEISHU_ENABLED_ENV]: "true",
} as const;

describe("loadFeishuConfig", () => {
  it("has no network configuration unless the channel is explicitly enabled", () => {
    expect(loadFeishuConfig({})).toBeUndefined();
    expect(loadFeishuConfig({
      ...VALID_ENVIRONMENT,
      [FEISHU_ENABLED_ENV]: "false",
    })).toBeUndefined();
  });

  it("loads credentials and a deduplicated sender allowlist", () => {
    const config = loadFeishuConfig(VALID_ENVIRONMENT);

    expect(config).toBeDefined();
    expect(config?.appId).toBe("cli_0123456789abcdef");
    expect(config?.appSecret).toBe("secret-value");
    expect(config?.allowedSenderIds).toBeInstanceOf(Set);
    expect(
      config === undefined
        ? false
        : isFeishuSenderAllowed(config.allowedSenderIds, "ou_owner"),
    ).toBe(true);
    expect(
      config === undefined
        ? true
        : isFeishuSenderAllowed(config.allowedSenderIds, "ou_outsider"),
    ).toBe(false);
  });

  it("requires explicit wildcard syntax to allow every sender", () => {
    const config = loadFeishuConfig({
      ...VALID_ENVIRONMENT,
      [FEISHU_ALLOWED_SENDER_IDS_ENV]: "*",
    });

    expect(config?.allowedSenderIds).toBe("*");
    expect(
      config === undefined
        ? false
        : isFeishuSenderAllowed(config.allowedSenderIds, "anyone"),
    ).toBe(true);
  });

  it.each([
    [{ ...VALID_ENVIRONMENT, [FEISHU_APP_ID_ENV]: undefined }],
    [{ ...VALID_ENVIRONMENT, [FEISHU_APP_ID_ENV]: "not-a-feishu-app" }],
    [{ ...VALID_ENVIRONMENT, [FEISHU_APP_SECRET_ENV]: "" }],
    [{ ...VALID_ENVIRONMENT, [FEISHU_ALLOWED_SENDER_IDS_ENV]: "" }],
    [{
      ...VALID_ENVIRONMENT,
      [FEISHU_ALLOWED_SENDER_IDS_ENV]: "ou_owner,,ou_other",
    }],
    [{ ...VALID_ENVIRONMENT, [FEISHU_ENABLED_ENV]: "sometimes" }],
  ])("rejects unsafe or incomplete enabled configuration", (environment) => {
    expect(() => loadFeishuConfig(environment)).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
      }),
    );
  });
});

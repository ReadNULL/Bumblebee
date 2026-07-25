import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import type {
  FeishuAllowedSenderIds,
  FeishuConfig,
} from "./types.js";

export const FEISHU_ENABLED_ENV = "BUMBLEBEE_FEISHU_ENABLED";
export const FEISHU_APP_ID_ENV = "FEISHU_APP_ID";
export const FEISHU_APP_SECRET_ENV = "FEISHU_APP_SECRET";
export const FEISHU_ALLOWED_SENDER_IDS_ENV = "FEISHU_ALLOWED_OPEN_IDS";

const APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_SECRET_LENGTH = 512;
const MAX_SENDER_ID_LENGTH = 256;

export type EnvironmentSource = Readonly<
  Record<string, string | undefined>
>;

/**
 * 飞书渠道必须显式启用。未启用时不读取凭据，也不会产生网络副作用。
 */
export function loadFeishuConfig(
  environment: EnvironmentSource = process.env,
): FeishuConfig | undefined {
  if (!parseEnabled(environment[FEISHU_ENABLED_ENV])) {
    return undefined;
  }

  const appId = normalizeRequired(
    environment[FEISHU_APP_ID_ENV],
    FEISHU_APP_ID_ENV,
  );
  if (!APP_ID_PATTERN.test(appId)) {
    throw invalidConfig(
      `${FEISHU_APP_ID_ENV} must match cli_ followed by 16 hexadecimal characters`,
      FEISHU_APP_ID_ENV,
    );
  }

  const appSecret = normalizeRequired(
    environment[FEISHU_APP_SECRET_ENV],
    FEISHU_APP_SECRET_ENV,
  );
  if (appSecret.length > MAX_SECRET_LENGTH) {
    throw invalidConfig(
      `${FEISHU_APP_SECRET_ENV} is too long`,
      FEISHU_APP_SECRET_ENV,
    );
  }

  return Object.freeze({
    allowedSenderIds: parseAllowedSenderIds(
      environment[FEISHU_ALLOWED_SENDER_IDS_ENV],
    ),
    appId,
    appSecret,
  });
}

export function isFeishuSenderAllowed(
  allowedSenderIds: FeishuAllowedSenderIds,
  senderId: string,
): boolean {
  return allowedSenderIds === "*" || allowedSenderIds.has(senderId);
}

function parseEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized === "" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  throw invalidConfig(
    `${FEISHU_ENABLED_ENV} must be a boolean flag`,
    FEISHU_ENABLED_ENV,
  );
}

function parseAllowedSenderIds(
  value: string | undefined,
): FeishuAllowedSenderIds {
  const normalized = normalizeRequired(
    value,
    FEISHU_ALLOWED_SENDER_IDS_ENV,
  );
  if (normalized === "*") {
    return "*";
  }

  const rawIds = normalized.split(",");
  if (rawIds.some((item) => item.trim().length === 0)) {
    throw invalidConfig(
      `${FEISHU_ALLOWED_SENDER_IDS_ENV} contains an empty sender ID`,
      FEISHU_ALLOWED_SENDER_IDS_ENV,
    );
  }

  const senderIds = new Set<string>();
  for (const rawId of rawIds) {
    const senderId = rawId.trim();
    if (
      senderId.length > MAX_SENDER_ID_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(senderId)
    ) {
      throw invalidConfig(
        `${FEISHU_ALLOWED_SENDER_IDS_ENV} contains an invalid sender ID`,
        FEISHU_ALLOWED_SENDER_IDS_ENV,
      );
    }
    senderIds.add(senderId);
  }
  return senderIds;
}

function normalizeRequired(
  value: string | undefined,
  fieldName: string,
): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw invalidConfig(`${fieldName} is required`, fieldName);
  }
  return normalized;
}

function invalidConfig(
  message: string,
  fieldName: string,
): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    context: { fieldName },
    userMessage:
      "飞书渠道配置无效，请检查启用开关、应用凭据和允许访问的用户列表。",
  });
}

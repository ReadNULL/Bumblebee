import {
  BumblebeeError,
  ERROR_CODES,
  type ErrorCode,
} from "../../foundation/index.js";
import type {
  ChannelMessage,
  ChannelMetadata,
  ChannelMetadataValue,
  ChannelReply,
  ConversationResponse,
} from "./types.js";

export const MAX_CHANNEL_TEXT_LENGTH = 32 * 1024;
const MAX_CHANNEL_ID_LENGTH = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 2_048;
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function normalizeChannelId(value: unknown): string {
  const channel = normalizeText(
    value,
    "channel",
    MAX_CHANNEL_ID_LENGTH,
    ERROR_CODES.INVALID_INPUT,
  );
  if (!CHANNEL_ID_PATTERN.test(channel)) {
    throw invalidValue(
      "channel must be a lowercase identifier containing letters, numbers, ., _, or -",
      "channel",
      ERROR_CODES.INVALID_INPUT,
    );
  }
  return channel;
}

export function normalizeChannelMessage(
  value: unknown,
  expectedChannel?: string,
): ChannelMessage {
  if (!isRecord(value)) {
    throw invalidValue(
      "Channel message must be an object",
      "message",
      ERROR_CODES.INVALID_INPUT,
    );
  }

  const channel = normalizeChannelId(value.channel);
  if (expectedChannel !== undefined && channel !== expectedChannel) {
    throw new BumblebeeError("Channel message adapter mismatch", {
      code: ERROR_CODES.INVALID_INPUT,
      context: { actualChannel: channel, expectedChannel },
    });
  }

  const timestamp = value.timestamp;
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw invalidValue(
      "timestamp must be a non-negative safe integer",
      "timestamp",
      ERROR_CODES.INVALID_INPUT,
    );
  }

  const metadata = normalizeMetadata(
    value.metadata,
    ERROR_CODES.INVALID_INPUT,
  );
  return Object.freeze({
    channel,
    conversationId: normalizeIdentifier(
      value.conversationId,
      "conversationId",
      ERROR_CODES.INVALID_INPUT,
    ),
    messageId: normalizeIdentifier(
      value.messageId,
      "messageId",
      ERROR_CODES.INVALID_INPUT,
    ),
    ...(metadata === undefined ? {} : { metadata }),
    senderId: normalizeIdentifier(
      value.senderId,
      "senderId",
      ERROR_CODES.INVALID_INPUT,
    ),
    text: normalizeContent(
      value.text,
      "text",
      ERROR_CODES.INVALID_INPUT,
    ),
    timestamp,
  });
}

export function normalizeConversationResponse(
  value: unknown,
): ConversationResponse | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidValue(
      "Conversation response must be an object or undefined",
      "response",
      ERROR_CODES.INTERNAL,
    );
  }

  const metadata = normalizeMetadata(value.metadata, ERROR_CODES.INTERNAL);
  return Object.freeze({
    ...(metadata === undefined ? {} : { metadata }),
    text: normalizeContent(value.text, "text", ERROR_CODES.INTERNAL),
  });
}

export function createChannelReply(
  message: ChannelMessage,
  response: ConversationResponse,
): ChannelReply {
  return Object.freeze({
    channel: message.channel,
    conversationId: message.conversationId,
    inReplyToMessageId: message.messageId,
    ...(response.metadata === undefined
      ? {}
      : { metadata: response.metadata }),
    text: response.text,
  });
}

function normalizeIdentifier(
  value: unknown,
  fieldName: string,
  code: ErrorCode,
): string {
  const identifier = normalizeText(
    value,
    fieldName,
    MAX_IDENTIFIER_LENGTH,
    code,
  );
  if (CONTROL_CHARACTER_PATTERN.test(identifier)) {
    throw invalidValue(
      `${fieldName} must not contain control characters`,
      fieldName,
      code,
    );
  }
  return identifier;
}

function normalizeContent(
  value: unknown,
  fieldName: string,
  code: ErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_CHANNEL_TEXT_LENGTH
  ) {
    throw invalidValue(
      `${fieldName} must contain 1 to ${MAX_CHANNEL_TEXT_LENGTH} characters`,
      fieldName,
      code,
    );
  }
  return value;
}

function normalizeText(
  value: unknown,
  fieldName: string,
  maximumLength: number,
  code: ErrorCode,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw invalidValue(
      `${fieldName} must contain 1 to ${maximumLength} characters`,
      fieldName,
      code,
    );
  }
  return normalized;
}

function normalizeMetadata(
  value: unknown,
  code: ErrorCode,
): ChannelMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw invalidValue(
      "metadata must be a plain object",
      "metadata",
      code,
    );
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw invalidValue(
      `metadata must contain at most ${MAX_METADATA_ENTRIES} entries`,
      "metadata",
      code,
    );
  }

  const normalized = Object.create(null) as Record<
    string,
    ChannelMetadataValue
  >;
  const normalizedKeys = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (
      key.length === 0 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(key) ||
      normalizedKeys.has(key)
    ) {
      throw invalidValue("metadata contains an invalid key", "metadata", code);
    }
    normalizedKeys.add(key);
    normalized[key] = normalizeMetadataValue(rawValue, code);
  }
  return Object.freeze(normalized);
}

function normalizeMetadataValue(
  value: unknown,
  code: ErrorCode,
): ChannelMetadataValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.length <= MAX_METADATA_STRING_LENGTH
  ) {
    return value;
  }
  throw invalidValue(
    "metadata values must be null, finite numbers, booleans, or bounded strings",
    "metadata",
    code,
  );
}

function invalidValue(
  message: string,
  fieldName: string,
  code: ErrorCode,
): BumblebeeError {
  return new BumblebeeError(message, {
    code,
    context: { fieldName },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

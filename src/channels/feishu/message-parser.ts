import {
  normalizeChannelMessage,
  type ChannelMessage,
} from "../core/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import { FEISHU_CHANNEL_ID } from "./types.js";

/** 把飞书 receive_v1 事件收缩为 Channel Core 的纯文本契约。 */
export function parseFeishuMessage(event: unknown): ChannelMessage | undefined {
  if (!isRecord(event) || !isRecord(event.sender) || !isRecord(event.message)) {
    throw invalidEvent("Feishu message event has an invalid shape");
  }

  const senderType = requiredString(
    event.sender.sender_type,
    "sender_type",
  );
  if (senderType !== "user") {
    return undefined;
  }

  const rawMessage = event.message;
  const messageType = requiredString(
    rawMessage.message_type,
    "message_type",
  );
  if (messageType !== "text") {
    return undefined;
  }

  const senderId = selectSenderId(event.sender.sender_id);
  const messageId = requiredString(rawMessage.message_id, "message_id");
  const chatId = requiredString(rawMessage.chat_id, "chat_id");
  const threadId = optionalString(rawMessage.thread_id);
  const timestamp = parseTimestamp(rawMessage.create_time);
  const text = parseTextContent(rawMessage.content, rawMessage.mentions);
  if (text.length === 0) {
    return undefined;
  }

  return normalizeChannelMessage({
    channel: FEISHU_CHANNEL_ID,
    conversationId: threadId ?? chatId,
    messageId,
    metadata: {
      chatType: optionalString(rawMessage.chat_type) ?? "unknown",
      isThread: threadId !== undefined,
      messageType: "text",
    },
    senderId,
    text,
    timestamp,
  }, FEISHU_CHANNEL_ID);
}

function parseTextContent(content: unknown, mentions: unknown): string {
  if (typeof content !== "string") {
    throw invalidEvent("Feishu text message content must be a JSON string");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (cause: unknown) {
    throw new BumblebeeError("Unable to parse Feishu text message content", {
      cause,
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  if (!isRecord(payload) || typeof payload.text !== "string") {
    throw invalidEvent("Feishu text message payload has no text");
  }
  return stripLeadingMentions(payload.text, collectMentionKeys(mentions));
}

function stripLeadingMentions(
  value: string,
  mentionKeys: ReadonlySet<string>,
): string {
  let text = value.trim();
  let removed = true;

  while (removed && text.length > 0) {
    removed = false;
    for (const key of mentionKeys) {
      if (
        text === key ||
        (text.startsWith(key) && /\s/u.test(text.charAt(key.length)))
      ) {
        text = text.slice(key.length).trimStart();
        removed = true;
        break;
      }
    }
  }
  return text.trim();
}

function collectMentionKeys(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  const keys = new Set<string>();
  for (const mention of value) {
    if (isRecord(mention) && typeof mention.key === "string") {
      const key = mention.key.trim();
      if (key.length > 0) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function selectSenderId(value: unknown): string {
  if (!isRecord(value)) {
    throw invalidEvent("Feishu sender has no sender_id");
  }
  for (const fieldName of ["open_id", "user_id", "union_id"] as const) {
    const senderId = optionalString(value[fieldName]);
    if (senderId !== undefined) {
      return senderId;
    }
  }
  throw invalidEvent("Feishu sender has no usable identity");
}

function parseTimestamp(value: unknown): number {
  const text = requiredString(value, "create_time");
  const timestamp = Number(text);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw invalidEvent("Feishu create_time is invalid");
  }
  return timestamp;
}

function requiredString(value: unknown, fieldName: string): string {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    throw invalidEvent(`Feishu ${fieldName} is required`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function invalidEvent(message: string): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

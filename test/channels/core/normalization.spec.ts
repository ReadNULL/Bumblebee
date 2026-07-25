import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../../src/foundation/index.js";
import {
  createChannelReply,
  MAX_CHANNEL_TEXT_LENGTH,
  normalizeChannelId,
  normalizeChannelMessage,
  normalizeConversationResponse,
} from "../../../src/channels/index.js";

describe("channel normalization", () => {
  it("normalizes identifiers while preserving user text", () => {
    const message = normalizeChannelMessage({
      channel: "feishu",
      conversationId: " conversation-1 ",
      messageId: " message-1 ",
      metadata: { mentionBot: true, tenant: "tenant-1" },
      senderId: " user-1 ",
      text: "  keep surrounding whitespace  ",
      timestamp: 1_753_200_000_000,
    });

    expect(message).toEqual({
      channel: "feishu",
      conversationId: "conversation-1",
      messageId: "message-1",
      metadata: { mentionBot: true, tenant: "tenant-1" },
      senderId: "user-1",
      text: "  keep surrounding whitespace  ",
      timestamp: 1_753_200_000_000,
    });
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.metadata)).toBe(true);
  });

  it("rejects adapter mismatches and unsafe metadata", () => {
    const base = {
      channel: "feishu",
      conversationId: "conversation-1",
      messageId: "message-1",
      senderId: "user-1",
      text: "hello",
      timestamp: 1,
    };

    expect(() => normalizeChannelMessage(base, "dingtalk"))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }));
    expect(() => normalizeChannelMessage({
      ...base,
      metadata: { rawEvent: { nested: true } },
    })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
    expect(() => normalizeChannelId("Feishu")).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
  });

  it("copies metadata into a frozen object without a prototype", () => {
    const metadata = JSON.parse(
      "{\"__proto__\":\"plain value\",\"tenant\":\"tenant-1\"}",
    ) as Record<string, unknown>;
    const message = normalizeChannelMessage({
      channel: "feishu",
      conversationId: "conversation-1",
      messageId: "message-1",
      metadata,
      senderId: "user-1",
      text: "hello",
      timestamp: 1,
    });

    expect(Object.getPrototypeOf(message.metadata)).toBeNull();
    expect(message.metadata?.["__proto__"]).toBe("plain value");
    expect(Object.isFrozen(message.metadata)).toBe(true);
  });

  it("bounds message and response text", () => {
    const oversizedText = "x".repeat(MAX_CHANNEL_TEXT_LENGTH + 1);
    expect(() => normalizeChannelMessage({
      channel: "feishu",
      conversationId: "conversation-1",
      messageId: "message-1",
      senderId: "user-1",
      text: oversizedText,
      timestamp: 1,
    })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
    expect(() => normalizeConversationResponse({ text: oversizedText }))
      .toThrowError(expect.objectContaining({ code: ERROR_CODES.INTERNAL }));
  });

  it("creates a reply tied to the source message", () => {
    const message = normalizeChannelMessage({
      channel: "feishu",
      conversationId: "conversation-1",
      messageId: "message-1",
      senderId: "user-1",
      text: "question",
      timestamp: 1,
    });
    const response = normalizeConversationResponse({
      metadata: { format: "text" },
      text: "answer",
    });
    if (response === undefined) {
      throw new Error("response should be defined");
    }

    expect(createChannelReply(message, response)).toEqual({
      channel: "feishu",
      conversationId: "conversation-1",
      inReplyToMessageId: "message-1",
      metadata: { format: "text" },
      text: "answer",
    });
    expect(normalizeConversationResponse(undefined)).toBeUndefined();
  });
});

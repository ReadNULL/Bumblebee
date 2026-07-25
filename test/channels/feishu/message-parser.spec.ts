import { describe, expect, it } from "vitest";

import {
  parseFeishuMessage,
} from "../../../src/channels/index.js";
import { ERROR_CODES } from "../../../src/foundation/index.js";

describe("parseFeishuMessage", () => {
  it("normalizes a private text message", () => {
    const message = parseFeishuMessage(createEvent());

    expect(message).toEqual({
      channel: "feishu",
      conversationId: "oc_chat",
      messageId: "om_message",
      metadata: {
        chatType: "p2p",
        isThread: false,
        messageType: "text",
      },
      senderId: "ou_sender",
      text: "hello",
      timestamp: 1_721_000_000_000,
    });
    expect(Object.isFrozen(message)).toBe(true);
  });

  it("uses the thread as conversation identity and strips leading mentions", () => {
    const message = parseFeishuMessage(createEvent({
      message: {
        chat_type: "group",
        content: JSON.stringify({
          text: "@_user_1   @_user_2 review src/index.ts",
        }),
        mentions: [
          { key: "@_user_1" },
          { key: "@_user_2" },
        ],
        thread_id: "omt_thread",
      },
    }));

    expect(message).toMatchObject({
      conversationId: "omt_thread",
      metadata: { chatType: "group", isThread: true },
      text: "review src/index.ts",
    });
  });

  it.each([
    [{ sender: { sender_type: "app" } }],
    [{ message: { message_type: "image" } }],
    [{
      message: {
        content: JSON.stringify({ text: "@_user_1" }),
        mentions: [{ key: "@_user_1" }],
      },
    }],
  ])("ignores events that should not become Agent turns", (overrides) => {
    expect(parseFeishuMessage(createEvent(overrides))).toBeUndefined();
  });

  it.each([
    [null],
    [{ sender: {}, message: {} }],
    [createEvent({ message: { content: "not-json" } })],
    [createEvent({ sender: { sender_id: {} } })],
    [createEvent({ message: { create_time: "not-a-time" } })],
  ])("rejects malformed SDK payloads without exposing message content", (event) => {
    expect(() => parseFeishuMessage(event)).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    );
  });
});

interface EventOverrides {
  readonly message?: Readonly<Record<string, unknown>>;
  readonly sender?: Readonly<Record<string, unknown>>;
}

function createEvent(overrides: EventOverrides = {}): unknown {
  return {
    message: {
      chat_id: "oc_chat",
      chat_type: "p2p",
      content: JSON.stringify({ text: "hello" }),
      create_time: "1721000000000",
      message_id: "om_message",
      message_type: "text",
      ...overrides.message,
    },
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
      ...overrides.sender,
    },
  };
}

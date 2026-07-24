import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  bindPiTaskAssurance,
  type PiAssuranceRegistrar,
} from "../../../src/integrations/pi/index.js";

describe("bindPiTaskAssurance", () => {
  it("injects policy and triggers at most one evidence follow-up", async () => {
    const fixture = createRegistrar();
    bindPiTaskAssurance(fixture.pi);
    const context = createContext();

    const promptResult = await fixture.beforeAgentStart?.({
      prompt: "The change must pass tests and preserve `value`.",
      systemPrompt: "base",
      systemPromptOptions: {},
      type: "before_agent_start",
    } as BeforeAgentStartEvent, context);
    expect(promptResult).toMatchObject({
      systemPrompt: expect.stringContaining(
        "<bumblebee-task-assurance>",
      ),
    });

    await fixture.toolCall?.({
      input: { path: "schema.proto" },
      toolCallId: "edit-1",
      toolName: "edit",
      type: "tool_call",
    } as ToolCallEvent, context);
    await fixture.toolResult?.({
      content: [],
      details: undefined,
      input: { path: "schema.proto" },
      isError: false,
      toolCallId: "edit-1",
      toolName: "edit",
      type: "tool_result",
    } as ToolResultEvent, context);

    await fixture.agentEnd?.({
      messages: [],
      type: "agent_end",
    }, context);
    await fixture.agentEnd?.({
      messages: [],
      type: "agent_end",
    }, context);

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "[BUMBLEBEE_ASSURANCE_CRITIC]",
        ),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
});

interface RegistrarFixture {
  agentEnd?: ExtensionHandler<AgentEndEvent>;
  beforeAgentStart?: ExtensionHandler<BeforeAgentStartEvent, unknown>;
  pi: PiAssuranceRegistrar;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  sessionShutdown?: ExtensionHandler<SessionShutdownEvent>;
  sessionTree?: ExtensionHandler<SessionTreeEvent>;
  toolCall?: ExtensionHandler<ToolCallEvent, unknown>;
  toolResult?: ExtensionHandler<ToolResultEvent>;
}

function createRegistrar(): RegistrarFixture {
  const fixture = {
    pi: undefined as unknown as PiAssuranceRegistrar,
    sendMessage: vi.fn(),
  } as RegistrarFixture;
  fixture.pi = {
    on(event: string, handler: unknown) {
      switch (event) {
        case "agent_end":
          fixture.agentEnd =
            handler as ExtensionHandler<AgentEndEvent>;
          break;
        case "before_agent_start":
          fixture.beforeAgentStart =
            handler as ExtensionHandler<BeforeAgentStartEvent, unknown>;
          break;
        case "session_shutdown":
          fixture.sessionShutdown =
            handler as ExtensionHandler<SessionShutdownEvent>;
          break;
        case "session_tree":
          fixture.sessionTree =
            handler as ExtensionHandler<SessionTreeEvent>;
          break;
        case "tool_call":
          fixture.toolCall =
            handler as ExtensionHandler<ToolCallEvent, unknown>;
          break;
        case "tool_result":
          fixture.toolResult =
            handler as ExtensionHandler<ToolResultEvent>;
          break;
      }
    },
    sendMessage: fixture.sendMessage,
  };
  return fixture;
}

function createContext(): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => "session-1",
    },
  } as unknown as ExtensionContext;
}

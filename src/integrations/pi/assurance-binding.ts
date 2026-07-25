import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionTreeEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { TaskAssurance } from "../../agents/index.js";

export interface PiAssuranceRegistrar {
  on(
    event: "agent_end",
    handler: ExtensionHandler<AgentEndEvent>,
  ): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<
      BeforeAgentStartEvent,
      BeforeAgentStartEventResult
    >,
  ): void;
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
  on(
    event: "session_tree",
    handler: ExtensionHandler<SessionTreeEvent>,
  ): void;
  on(
    event: "tool_call",
    handler: ExtensionHandler<
      ToolCallEvent,
      ToolCallEventResult
    >,
  ): void;
  on(
    event: "tool_result",
    handler: ExtensionHandler<ToolResultEvent>,
  ): void;
  sendMessage: ExtensionAPI["sendMessage"];
}

export interface PiTaskAssuranceOptions {
  readonly assurance?: TaskAssurance;
  readonly criticToolEnabled?: boolean;
}

/** Maps Pi lifecycle and tool evidence into the Pi-independent core. */
export function bindPiTaskAssurance(
  pi: PiAssuranceRegistrar,
  options: PiTaskAssuranceOptions = {},
): TaskAssurance {
  const assurance = options.assurance ?? new TaskAssurance({
    ...(options.criticToolEnabled === undefined
      ? {}
      : { criticToolEnabled: options.criticToolEnabled }),
  });

  pi.on("before_agent_start", (event, context) => {
    const policy = assurance.beginTask(
      getSessionId(context),
      event.prompt,
    );
    return {
      systemPrompt: `${event.systemPrompt}\n\n${policy}`,
    };
  });
  pi.on("tool_call", (event, context) =>
    assurance.beforeTool(getSessionId(context), {
      input: event.input,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    })
  );
  pi.on("tool_result", (event, context) => {
    assurance.afterTool(getSessionId(context), {
      ...(event.details === undefined
        ? {}
        : { details: event.details }),
      isError: event.isError,
      output: event.content,
      toolCallId: event.toolCallId,
    });
  });
  pi.on("agent_end", (_event, context) => {
    const review = assurance.reviewCompletion(
      getSessionId(context),
    );
    if (
      !review.shouldFollowUp ||
      review.followUpMessage === undefined
    ) {
      return;
    }
    pi.sendMessage(
      {
        content: review.followUpMessage,
        customType: "bumblebee.task-assurance.v1",
        details: {
          criticCostUsd: review.criticCostUsd,
          criticRuns: review.criticRuns,
          reasons: review.reasons,
        },
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
  pi.on("session_tree", (_event, context) => {
    assurance.clear(getSessionId(context));
  });
  pi.on("session_shutdown", (_event, context) => {
    assurance.clear(getSessionId(context));
  });

  return assurance;
}

function getSessionId(context: ExtensionContext): string {
  return context.sessionManager.getSessionId();
}

import {
  type ExtensionAPI,
  type ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  callAgentDojoTool,
  loadBridgeRuntimeConfig,
} from "./bridge-client.js";

/**
 * AgentDojo owns the environment. This extension only exposes its frozen tool
 * schemas to pi and forwards validated calls over the loopback bridge.
 */
export default function agentDojoToolsExtension(
  pi: ExtensionAPI,
): void {
  const runtime = loadBridgeRuntimeConfig();

  for (const tool of runtime.catalog.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(
        tool.parameters,
      ),
      executionMode: "sequential" as ToolExecutionMode,
      async execute(
        _toolCallId,
        parameters,
        signal,
      ) {
        const result = await callAgentDojoTool(
          runtime.client,
          tool.name,
          parameters,
          signal,
        );
        return {
          content: [
            {
              type: "text",
              text: formatToolResult(result),
            },
          ],
          details: {
            bridgeProtocolVersion:
              runtime.client.protocolVersion,
          },
        };
      },
    });
  }
}

function formatToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

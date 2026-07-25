import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type {
  MemoryAccessMode,
  MemoryContextProvider,
  MemoryScopeFilter,
} from "../../memory/index.js";

export interface PiMemoryContextOptions {
  readonly access: MemoryAccessMode;
  readonly scope: MemoryScopeFilter;
}

/** 在当前轮 system prompt 尾部注入有界记忆，不写入 Pi 会话历史。 */
export function bindPiMemoryContext(
  pi: Pick<ExtensionAPI, "on">,
  memory: MemoryContextProvider,
  options: PiMemoryContextOptions,
): void {
  pi.on("before_agent_start", async (event, context) => {
    const memoryContext = await memory.buildPromptContext(event.prompt, {
      access: options.access,
      scope: options.scope,
      ...(context.signal === undefined
        ? {}
        : { signal: context.signal }),
    });
    if (memoryContext.trim().length === 0) {
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${memoryContext}`,
    };
  });
}

/**
 * 渠道 Pi 会话只复用上下文读取能力，不注册 bumblebee_memory 写工具。
 */
export function createPiMemoryContextExtension(
  memory: MemoryContextProvider,
): ExtensionFactory {
  return (pi) => {
    bindPiMemoryContext(pi, memory, {
      access: "read-only",
      scope: "project",
    });
  };
}

/**
 * 共享的 LLM 调用工厂
 *
 * 消除 agent.ts 和 manager.ts 中重复的 resourceLoader 样板代码
 */

import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * 创建一个最小化的 ResourceLoader，只配置 systemPrompt，其余返回空值
 */
export function createMinimalResourceLoader(systemPrompt: string) {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: {
        tools: new Map(),
        commands: new Map(),
        shortcuts: new Map(),
        flags: new Map(),
        messageRenderers: new Map(),
        providers: new Map(),
        eventHandlers: new Map()
      } as any
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

export interface LLMCallOptions {
  systemPrompt: string
  userPrompt: string
  /** 传入已有 SessionManager 以复用会话；不传则创建 inMemory 一次性会话 */
  sessionManager?: SessionManager
  /** 是否在调用结束后 dispose session（仅对一次性 session 有效） */
  disposeAfter?: boolean
}

export interface LLMCallResult {
  text: string
  usage: {
    input: number
    output: number
    totalTokens: number
    contextPercent: number | null
  }
}

/**
 * 统一的 LLM 调用入口
 *
 * - 独立模式：传入持久化 SessionManager，复用会话
 * - AgentManager 多 Agent 场景：不传 sessionManager，每次创建 inMemory session
 */
export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const { systemPrompt, userPrompt, sessionManager, disposeAfter = true } = options

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: sessionManager ?? SessionManager.inMemory(process.cwd()),
    resourceLoader: createMinimalResourceLoader(systemPrompt),
  })

  let response = ''
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      response += event.assistantMessageEvent.delta
    }
  })

  try {
    await session.prompt(userPrompt)

    const stats = session.getSessionStats()
    return {
      text: response || '(无响应)',
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        totalTokens: stats.tokens.total,
        contextPercent: stats.contextUsage?.percent ?? null,
      }
    }
  } finally {
    unsubscribe()
    if (disposeAfter) {
      session.dispose()
    }
  }
}

/**
 * 共享的 LLM 调用工厂
 *
 * 模型配置由 pi-coding-agent SDK 管理（环境变量 + /model 命令），
 * 此模块只负责创建 session 并调用 LLM。
 */

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { BumblebeeConfig } from './config.js'

/**
 * 创建一个最小化的 ResourceLoader，只配置 systemPrompt，其余返回空值
 */
export function createMinimalResourceLoader(systemPrompt: string) {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
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
  ai?: BumblebeeConfig['ai']
  timeoutMs?: number
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
 * 模型认证和 provider 配置由 SDK 的 AuthStorage / ModelRegistry 管理，
 * 通过环境变量（如 OPENAI_API_KEY、ANTHROPIC_API_KEY）或 /model 命令配置。
 */
export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const {
    systemPrompt,
    userPrompt,
    ai,
    timeoutMs,
    sessionManager,
    disposeAfter = true,
  } = options

  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined

  try {
    const created = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: sessionManager ?? SessionManager.inMemory(process.cwd()),
      resourceLoader: createMinimalResourceLoader(systemPrompt),
    })
    session = created.session
    const effectiveTimeoutMs = timeoutMs ?? ai?.timeoutMs ?? 60000

    let response = ''
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        response += event.assistantMessageEvent.delta
      }
    })

    try {
      await withTimeout(
        session.prompt(userPrompt),
        effectiveTimeoutMs,
        `LLM 调用超时: ${effectiveTimeoutMs}ms`,
      )

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
    }
  } finally {
    if (disposeAfter && session) {
      session.dispose()
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

/**
 * 共享的 LLM 调用工厂
 *
 * 消除 agent.ts 和 manager.ts 中重复的 resourceLoader 样板代码
 */

import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { BumblebeeConfig } from './config.js'
import type { ConcurrencyController, PerformanceMonitor } from '../performance/optimizer.js'

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
  concurrency?: ConcurrencyController | null
  performanceMonitor?: PerformanceMonitor | null
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

function createModelRuntime(ai?: BumblebeeConfig['ai']) {
  if (!ai) return {}

  const authStorage = AuthStorage.create()
  if (ai.apiKey) {
    authStorage.setRuntimeApiKey(ai.provider, ai.apiKey)
  }

  const modelRegistry = ModelRegistry.create(authStorage)

  // 配置文件 baseUrl 覆盖 SDK 内置地址，同时注册自定义模型
  if (ai.baseUrl) {
    const providerConfig: Record<string, any> = { baseUrl: ai.baseUrl }
    // registerProvider 要求定义 models 时必须提供 apiKey
    if (ai.apiKey) {
      providerConfig.apiKey = ai.apiKey
      providerConfig.models = [{
        id: ai.model,
        name: ai.model,
        api: ai.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
        baseUrl: ai.baseUrl,
        contextWindow: 128000,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: ai.maxTokens || 4096,
      }]
    }
    modelRegistry.registerProvider(ai.provider, providerConfig)
  }

  const configuredModel = modelRegistry.find(ai.provider, ai.model)
  const model = configuredModel && modelRegistry.hasConfiguredAuth(configuredModel)
    ? configuredModel
    : undefined

  return { authStorage, modelRegistry, model }
}

/**
 * 统一的 LLM 调用入口
 *
 * - 独立模式：传入持久化 SessionManager，复用会话
 * - AgentManager 多 Agent 场景：不传 sessionManager，每次创建 inMemory session
 */
export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const {
    systemPrompt,
    userPrompt,
    ai,
    concurrency,
    performanceMonitor,
    sessionManager,
    disposeAfter = true,
  } = options
  const startedAt = Date.now()
  const runtime = createModelRuntime(ai)
  let acquiredConcurrency = false

  if (concurrency) {
    await concurrency.acquire()
    acquiredConcurrency = true
    const stats = concurrency.getStats()
    performanceMonitor?.updateConcurrencyStats(stats.active, stats.queued)
  }

  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined

  try {
    // 模型未找到时提前报错
    if (ai && !runtime.model) {
      throw new Error(`模型不可用: ${ai.provider}/${ai.model} — 请检查 apiKey 和 baseUrl 配置`)
    }

    const created = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: sessionManager ?? SessionManager.inMemory(process.cwd()),
      resourceLoader: createMinimalResourceLoader(systemPrompt),
      ...runtime,
    })
    session = created.session

    let response = ''
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
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
    }
  } finally {
    const duration = Date.now() - startedAt
    performanceMonitor?.recordResponseTime(duration)

    if (disposeAfter && session) {
      session.dispose()
    }

    if (concurrency && acquiredConcurrency) {
      concurrency.release()
      const stats = concurrency.getStats()
      performanceMonitor?.updateConcurrencyStats(stats.active, stats.queued)
    }
  }
}

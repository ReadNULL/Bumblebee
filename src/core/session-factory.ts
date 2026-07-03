/**
 * Shared one-shot LLM call helper.
 *
 * Model selection, provider credentials and `/model` are owned by
 * pi-coding-agent. Bumblebee only supplies a system prompt and an optional
 * timeout for internal calls.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

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
  timeoutMs?: number
  sessionManager?: SessionManager
  disposeAfter?: boolean
  customTools?: ToolDefinition[]
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

export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const {
    systemPrompt,
    userPrompt,
    timeoutMs = 300000,
    sessionManager,
    disposeAfter = true,
    customTools,
  } = options

  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined

  try {
    const created = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: sessionManager ?? SessionManager.inMemory(process.cwd()),
      resourceLoader: createMinimalResourceLoader(systemPrompt),
      customTools,
    })
    session = created.session

    let response = ''
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        response += event.assistantMessageEvent.delta
      }
    })

    try {
      await withTimeout(
        session.prompt(userPrompt),
        timeoutMs,
        `LLM call timed out after ${timeoutMs}ms`,
      )

      const stats = session.getSessionStats()

      return {
        text: response || '(no response)',
        usage: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          totalTokens: stats.tokens.total,
          contextPercent: stats.contextUsage?.percent ?? null,
        },
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

/**
 * Bumblebee Extension for pi-coding-agent
 *
 * 将 Bumblebee 的角色、人格、记忆等能力注入 pi-coding-agent TUI
 */

import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { convertToLlm, serializeConversation, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BumblebeeAgent } from '../core/agent.js'
import { loadConfig } from '../core/config.js'
import { BumblebeePersonality } from '../personality/traits.js'
import { extractProfileFromConversation } from '../memory/profile-extractor.js'
import { ChannelManager } from '../channels/manager.js'
import { createChannelReply, getChannelReplyTarget, shouldHandleChannelMessage } from './channel-handler.js'
import { extractKnowledgeToGraph, extractText } from './knowledge-extractor.js'
import { createLogger } from '../core/logger.js'
import { SessionBuffer, type SessionMessage } from './session-buffer.js'
import type { BumblebeeExtensionRuntime, BumblebeeUi } from './context.js'
import { registerRoleTools } from './tools/roles.js'
import { registerRoleCommands } from './commands/roles.js'
import { registerMemoryCommands } from './commands/memory.js'
import { registerKnowledgeCommands } from './commands/knowledge.js'
import { registerChannelCommands } from './commands/channels.js'
import { registerAgentWorkflowTools } from './tools/agents-workflows.js'
import { registerAgentWorkflowCommands } from './commands/agents-workflows.js'
import { registerCollaborationVoiceTools } from './tools/collaboration-voice.js'
import { registerCollaborationVoiceCommands } from './commands/collaboration-voice.js'
import { registerSystemCommands } from './commands/system.js'
import { PluginLoader } from '../plugins/loader.js'
import { BUMBLEBEE_COMMANDS, BUMBLEBEE_TOOLS } from './catalog.js'

export function getCommands() {
  return [...BUMBLEBEE_COMMANDS]
}

export function getTools() {
  return [...BUMBLEBEE_TOOLS]
}

// 生成对话摘要（提取关键信息，限制长度）
function generateConversationSummary(messages: SessionMessage[]): string {
  const textMessages: string[] = []

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue

    const text = extractText(msg.content)?.trim()
    if (!text) continue

    const label = msg.role === 'user' ? '用户' : '助手'
    // 助手回复截断到前 500 字符
    const body = msg.role === 'assistant' && text.length > 500
      ? text.slice(0, 500) + '...'
      : text
    textMessages.push(`${label}: ${body}`)
  }

  if (textMessages.length === 0) return ''

  // 限制摘要长度：最多取最近 20 条消息，总长度不超过 3000 字符
  const recent = textMessages.slice(-20)
  let summary = recent.join('\n\n')
  if (summary.length > 3000) {
    summary = summary.slice(summary.length - 3000)
  }

  return summary
}

// 模块级 Agent 实例（Extension 工厂闭包中使用）

// 对话消息缓冲（用于退出时提取画像和保存摘要）

async function persistChannelConfig(channelName: 'wechat' | 'feishu' | 'dingtalk', channelConfig: Record<string, any>): Promise<void> {
  const configPath = resolve('.bumblebee.yaml')
  let rawConfig: Record<string, any> = {}

  try {
    const content = await readFile(configPath, 'utf-8')
    rawConfig = parseYaml(content) || {}
  } catch {
    rawConfig = {}
  }

  rawConfig.channels = {
    ...(rawConfig.channels || {}),
    [channelName]: {
      ...(rawConfig.channels?.[channelName] || {}),
      ...channelConfig,
    },
  }

  await writeFile(configPath, stringifyYaml(rawConfig), 'utf-8')
}

export default async function bumblebeeExtension(pi: ExtensionAPI) {
  const logger = createLogger('bumblebee:tui')
  // 初始化 BumblebeeAgent（友好的错误处理）
  let config
  try {
    config = await loadConfig()
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      console.error('\n  找不到配置文件。运行 bumblebee init 创建配置，或 bumblebee doctor 检查环境。\n')
    } else if (msg.includes('ZodError') || msg.includes('validation') || msg.includes('parse')) {
      console.error('\n  配置文件格式错误。运行 bumblebee init 重新生成，或检查 .bumblebee.yaml 语法。\n')
    } else {
      console.error(`\n  加载配置失败: ${msg}`)
      console.error('  运行 bumblebee doctor 检查环境，或 bumblebee init 重新配置。\n')
    }
    process.exit(1)
    return
  }

  const agent = new BumblebeeAgent(config)
  try {
    await agent.initialize()
  } catch (err: any) {
    const msg = err?.message || String(err)
    if (msg.includes('没有可用的角色')) {
      console.error('\n  没有可用的角色。检查角色目录或运行 bumblebee init 重新配置。\n')
    } else {
      console.error(`\n  初始化失败: ${msg}`)
      console.error('  运行 bumblebee doctor 检查环境。\n')
    }
    process.exit(1)
    return
  }

  // 初始化渠道管理器（从配置加载已启用的渠道）
  const channelManager = new ChannelManager()
  if (config.channels) {
    await channelManager.loadFromConfig(config.channels)
  }

  const sessionBuffer = new SessionBuffer()
  const runtime: BumblebeeExtensionRuntime = {
    pi,
    config,
    agent,
    channelManager,
    sessionBuffer,
    logger,
  }

  const pluginLoader = new PluginLoader({ agent, pi, channelManager, logger })
  try {
    const loadedPlugins = await pluginLoader.loadFromConfig(config.plugins)
    if (loadedPlugins.length > 0) {
      logger.info(`Loaded ${loadedPlugins.length} Bumblebee plugin(s)`)
    }
  } catch (error) {
    logger.warn('Plugin loading failed', error)
  }

  // 渠道消息去重（保留 5 分钟，防止飞书等平台重试导致重复处理）
  const processedMessages = new Map<string, number>()
  const DEDUP_TTL = 5 * 60 * 1000

  // 渠道消息历史（显示在 TUI widget 中）
  const MAX_CHANNEL_LOG = 10
  const channelLog: string[] = []

  // UI 引用（在 session_start 中赋值）
  let extensionUI: BumblebeeUi | null = null

  function updateChannelWidget() {
    if (!extensionUI?.setWidget || channelLog.length === 0) return
    extensionUI.setWidget('channel-messages', [...channelLog], { placement: 'aboveEditor' })
  }

  function appendChannelLog(line: string) {
    channelLog.push(line)
    if (channelLog.length > MAX_CHANNEL_LOG) channelLog.shift()
    updateChannelWidget()
  }

  channelManager.onMessage(async (message) => {
    const key = `${message.sender.platform}:${message.id}`
    const now = Date.now()

    // 清理过期记录
    for (const [k, t] of processedMessages) {
      if (now - t > DEDUP_TTL) processedMessages.delete(k)
    }

    if (processedMessages.has(key) || !shouldHandleChannelMessage(message)) return

    processedMessages.set(key, now)
    try {
      const sender = message.sender.name || message.sender.id
      const preview = message.content.length > 60 ? message.content.substring(0, 60) + '...' : message.content
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

      appendChannelLog(`${time} [${message.sender.platform}] ${sender}: ${preview}`)

      const response = await agent.processMessage(message.content)
      const target = getChannelReplyTarget(message)
      await channelManager.send(message.sender.platform, target, createChannelReply(message, response))

      const replyPreview = response.length > 60 ? response.substring(0, 60) + '...' : response
      appendChannelLog(`${time} [回复] ${replyPreview}`)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      appendChannelLog(`[错误] ${message.sender.platform}: ${errMsg}`)
      try {
        const target = getChannelReplyTarget(message)
        await channelManager.send(message.sender.platform, target, createChannelReply(message, '处理消息时出错，请稍后重试。'))
      } catch (replyError) {
        logger.debug('Failed to send channel error reply', replyError)
      }
    }
  })

  let welcomeShown = false

  pi.on('session_start', async (_event, ctx) => {
    // 保存 UI 引用，供渠道消息处理使用
    extensionUI = ctx.ui

    // 模型配置由 pi-coding-agent SDK 管理（环境变量 + /model 命令）

    const memStats = agent.getMemoryStats()
    if (!welcomeShown && memStats.preferences === 0 && memStats.facts === 0) {
      welcomeShown = true
      const role = agent.getCurrentRole()
      ctx.ui.notify([
        `欢迎使用 Bumblebee！当前角色: ${role.name}`,
        '',
        '快速开始:',
        '  /help          查看所有命令',
        '  /roles         列出可用角色',
        '  /switch <id>   切换角色',
        '  /status        系统状态概览',
        '',
        '直接输入消息即可开始对话。',
      ].join('\n'), 'info')
    }
  })

  // 注入角色 system prompt + 用户画像 + 上次对话摘要 + 知识上下文
  pi.on('before_agent_start', async (event) => {
    const rolePrompt = agent.getRoleManager().getSystemPrompt()
    const personalityPrompt = BumblebeePersonality.getSystemPrompt()
    const profilePrompt = agent.getMemoryManager().getContextPrompt()
    const summaryPrompt = agent.getMemoryManager().getConversationSummaryPrompt()

    // 项目上下文
    const contextSummary = agent.getContext().getContextSummary()
    let contextPrompt = ''
    if (contextSummary.project) {
      const p = contextSummary.project
      contextPrompt = `\n\n## 项目上下文\n语言: ${p.language || '未知'}\n框架: ${p.framework || '未知'}\n依赖数: ${p.dependencies?.length || 0}`
    }

    // 学习推荐
    const lastUserMsg = sessionBuffer.getRecentUserMessage()
    let recommendationPrompt = ''
    if (lastUserMsg) {
      const text = extractText(lastUserMsg.content)
      if (text) {
        const recommendations = agent.getLearner().recommend({ context: { text }, limit: 3 })
        if (recommendations.length > 0) {
          recommendationPrompt = `\n\n## 学习到的模式建议\n${recommendations.map(r => `- ${r.description}`).join('\n')}`
        }
      }
    }

    // Agent 系统上下文
    let agentPrompt = ''
    if (agent.getAgentManager()) {
      const stats = agent.getAgentManager()!.getStats()
      agentPrompt = `\n\n## 多 Agent 系统\n可用 Agent: ${stats.total} (空闲: ${stats.idle}, 忙碌: ${stats.busy})`
      if (agent.getWorkflowEngine()) {
        const workflows = agent.getWorkflowEngine()!.getAllWorkflows()
        agentPrompt += `\n已注册工作流: ${workflows.length} 个`
      }
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${personalityPrompt}\n\n## 当前角色\n${rolePrompt}${profilePrompt}${summaryPrompt}${contextPrompt}${recommendationPrompt}${agentPrompt}`,
    }
  })

  // 拦截 compaction 事件，使用规则提取用户画像
  pi.on('session_before_compact', async (event, _ctx) => {
    const { preparation } = event
    const { messagesToSummarize, turnPrefixMessages } = preparation

    // 合并所有待摘要消息
    const allMessages = [...messagesToSummarize, ...turnPrefixMessages]
    if (allMessages.length === 0) return

    // 序列化对话内容
    const conversationText = serializeConversation(convertToLlm(allMessages))

    // 获取已有画像
    const existingProfile = agent.getMemoryManager().getProfile()

    // 使用共享的规则提取函数
    const extracted = extractProfileFromConversation(conversationText, existingProfile)

    // 只有有新信息时才更新
    const hasUpdates = (extracted.preferences?.length ?? 0) > 0
      || (extracted.facts?.length ?? 0) > 0
      || Object.keys(extracted.environment ?? {}).length > 0

    if (hasUpdates) {
      await agent.getMemoryManager().updateProfile(extracted)
    }

    // 从对话中学习用户纠正模式
    for (const msg of allMessages) {
      if (msg.role !== 'user') continue
      const text = extractText(msg.content)
      if (!text) continue
      if (text.includes('不要') || text.includes('别') || text.includes('不需要') || text.includes('不用')) {
        agent.getLearner().record({ type: 'correction', input: text, output: '', success: false, context: {} })
      }
    }

    // 从对话中提取知识写入图谱
    extractKnowledgeToGraph(agent, allMessages)

    // 返回 undefined 让框架执行默认 compaction
    return
  })

  // 跟踪对话消息（每次 LLM 调用前触发，保存完整上下文）
  pi.on('context', async (event) => {
    sessionBuffer.replace(event.messages as SessionMessage[])
  })

  // 退出时清理资源
  pi.on('session_shutdown', async (_event) => {
    // 断开所有渠道连接（释放 WebSocket 等资源）
    try {
      await channelManager.disconnectAll()
    } catch (error) {
      logger.debug('Failed to disconnect channels during shutdown', error)
    }

    // 释放 Agent 资源（清除 dashboard 定时器等）
    try {
      await agent.dispose()
    } catch (error) {
      logger.debug('Failed to dispose agent during shutdown', error)
    }

    if (sessionBuffer.isEmpty()) return

    try {
      const messages = sessionBuffer.getMessages()

      // 序列化对话内容
      const conversationText = serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]))

      // 提取并保存用户画像
      const existingProfile = agent.getMemoryManager().getProfile()
      const extracted = extractProfileFromConversation(conversationText, existingProfile)

      const hasUpdates = (extracted.preferences?.length ?? 0) > 0
        || (extracted.facts?.length ?? 0) > 0
        || Object.keys(extracted.environment ?? {}).length > 0

      if (hasUpdates) {
        await agent.getMemoryManager().updateProfile(extracted)
      }

      // 生成对话摘要（取最近的消息，截断到合理长度）
      const summary = generateConversationSummary(messages)
      if (summary) {
        await agent.getMemoryManager().saveConversationSummary(summary)
      }

      // 从对话中提取知识并保存
      extractKnowledgeToGraph(agent, messages)
      await agent.getKnowledge().save()
      await agent.getLearner().save()
    } catch (error) {
      console.error('会话关闭时保存记忆/知识失败:', error)
    }
  })

  registerRoleTools(runtime)
  registerRoleCommands(runtime)

  registerMemoryCommands(runtime)
  registerChannelCommands(runtime, persistChannelConfig)

  registerKnowledgeCommands(runtime)
  registerAgentWorkflowTools(runtime)
  registerAgentWorkflowCommands(runtime)
  registerCollaborationVoiceTools(runtime)
  registerCollaborationVoiceCommands(runtime)
  registerSystemCommands(runtime)

}

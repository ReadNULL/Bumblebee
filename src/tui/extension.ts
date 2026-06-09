/**
 * Bumblebee Extension for pi-coding-agent
 *
 * 将 Bumblebee 的角色、人格、记忆等能力注入 pi-coding-agent TUI
 */

import { Type } from 'typebox'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { defineTool, convertToLlm, serializeConversation, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BumblebeeAgent } from '../core/agent.js'
import { loadConfig } from '../core/config.js'
import { BumblebeePersonality } from '../personality/traits.js'
import { extractProfileFromConversation } from '../memory/profile-extractor.js'
import { ChannelManager } from '../channels/manager.js'
import { WeChatAdapter } from '../channels/wechat.js'
import { getSpecializedAgentTypes, createAgentTeam, RECOMMENDED_TEAMS } from '../agents/specialized.js'
import { getWorkflowTemplateIds, createWorkflowFromTemplate } from '../workflows/templates.js'
import type { KnowledgeNode } from '../knowledge/types.js'
import { createChannelReply, getChannelReplyTarget, shouldHandleChannelMessage } from './channel-handler.js'
import { extractKnowledgeToGraph, extractText } from './knowledge-extractor.js'

// 自定义工具：切换角色
const switchRoleTool = defineTool({
  name: 'switch_role',
  label: 'Switch Role',
  description: '切换 Bumblebee 到指定角色。角色决定了 AI 的专业领域、沟通风格和能力。',
  parameters: Type.Object({
    roleId: Type.String({ description: '角色 ID，如 bumblebee、code-reviewer、architect 等' }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const success = agent.switchRole(params.roleId)
    if (success) {
      const role = agent.getCurrentRole()
      const summary = agent.getRoleSummary()
      return {
        content: [{
          type: 'text',
          text: `已切换到角色: ${role.name}\n描述: ${role.description}\n特征: ${summary.traits.join(', ')}\n专业领域: ${summary.expertise.join(', ')}`,
        }],
        details: { roleId: params.roleId, success: true },
      }
    }
    const available = agent.getAvailableRoles()
    const list = available.map(r => `- ${r.id}: ${r.name}`).join('\n')
    return {
      content: [{
        type: 'text',
        text: `角色 "${params.roleId}" 不存在。可用角色:\n${list}`,
      }],
      details: { roleId: params.roleId, success: false },
      isError: true,
    }
  },
})

// 自定义工具：列出角色
const listRolesTool = defineTool({
  name: 'list_roles',
  label: 'List Roles',
  description: '列出所有可用的 Bumblebee 角色，包括当前激活的角色。',
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
    const current = agent.getCurrentRole()
    const roles = agent.getAvailableRoles()
    const list = roles.map(r => {
      const marker = r.id === current.id ? ' (当前)' : ''
      return `- ${r.id}: ${r.name}${marker} — ${r.description}`
    }).join('\n')
    return {
      content: [{ type: 'text', text: `可用角色:\n${list}` }],
      details: { count: roles.length, currentRole: current.id },
    }
  },
})

// 自定义工具：获取角色详情
const getRoleInfoTool = defineTool({
  name: 'get_role_info',
  label: 'Get Role Info',
  description: '获取指定角色或当前角色的详细信息，包括人格特征、专业领域、能力等。',
  parameters: Type.Object({
    roleId: Type.Optional(Type.String({ description: '角色 ID，不填则获取当前角色' })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const roleId = params.roleId
    if (roleId) {
      const roles = agent.getAvailableRoles()
      const found = roles.find(r => r.id === roleId)
      if (!found) {
        return {
          content: [{ type: 'text', text: `角色 "${roleId}" 不存在` }],
          details: {},
          isError: true,
        }
      }
    }

    const targetId = roleId || agent.getCurrentRole().id
    if (roleId && roleId !== agent.getCurrentRole().id) {
      agent.switchRole(roleId)
    }

    const summary = agent.getRoleSummary()
    const personality = agent.getPersonality()
    const text = [
      `角色: ${summary.name} (${summary.id})`,
      `描述: ${summary.description}`,
      `特征: ${summary.traits.join(', ')}`,
      `专业领域: ${summary.expertise.join(', ')}`,
      `能力: ${summary.capabilities.join(', ')}`,
      `当前情绪: ${personality.mood}`,
      `人格强度: ${personality.config.intensity}`,
      `主题: ${personality.config.theme}`,
    ].join('\n')

    return {
      content: [{ type: 'text', text }],
      details: summary,
    }
  },
})

// 生成对话摘要（提取关键信息，限制长度）
function generateConversationSummary(messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>): string {
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
let agent: BumblebeeAgent
let channelManager: ChannelManager

// 对话消息缓冲（用于退出时提取画像和保存摘要）
let sessionMessages: any[] = []

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
  // 预加载 wechaty 模块（后台进行，不阻塞启动）
  WeChatAdapter.preload().catch(() => {})

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

  agent = new BumblebeeAgent(config)
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
  channelManager = new ChannelManager()
  if (config.channels) {
    await channelManager.loadFromConfig(config.channels)
  }

  // 渠道消息去重（保留 5 分钟，防止飞书等平台重试导致重复处理）
  const processedMessages = new Map<string, number>()
  const DEDUP_TTL = 5 * 60 * 1000

  // 渠道消息历史（显示在 TUI widget 中）
  const MAX_CHANNEL_LOG = 10
  const channelLog: string[] = []

  // UI 引用（在 session_start 中赋值）
  let extensionUI: any = null

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
      } catch { /* ignore */ }
    }
  })

  let welcomeShown = false

  pi.on('session_start', async (_event, ctx) => {
    // 保存 UI 引用，供渠道消息处理使用
    extensionUI = ctx.ui

    // 在 SDK 的 modelRegistry 中注册自定义 provider
    // 分两步：先注册认证，再注册自定义模型（避免 SDK 验证冲突）
    if (config.ai.apiKey) {
      ctx.modelRegistry.registerProvider(config.ai.provider, { apiKey: config.ai.apiKey })
    }
    if (config.ai.baseUrl) {
      ctx.modelRegistry.registerProvider(config.ai.provider, { baseUrl: config.ai.baseUrl })
    }

    // 对于非 SDK 内置模型（如 mimo-v2.5-pro），需要显式注册模型定义
    let model = ctx.modelRegistry.find(config.ai.provider, config.ai.model)
    if (!model && config.ai.baseUrl) {
      ctx.modelRegistry.registerProvider(config.ai.provider, {
        baseUrl: config.ai.baseUrl,
        apiKey: config.ai.apiKey,
        models: [{
          id: config.ai.model,
          name: config.ai.model,
          api: config.ai.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
          baseUrl: config.ai.baseUrl,
          contextWindow: 128000,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          maxTokens: config.ai.maxTokens || 4096,
        }],
      })
      model = ctx.modelRegistry.find(config.ai.provider, config.ai.model)
    }

    if (model) {
      const selected = await pi.setModel(model)
      if (!selected) {
        ctx.ui.notify(`配置的模型不可用或缺少认证: ${config.ai.provider}/${config.ai.model}`, 'warning')
      }
    } else {
      ctx.ui.notify(`未找到模型: ${config.ai.provider}/${config.ai.model}，请检查配置`, 'warning')
    }

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
    const lastUserMsg = sessionMessages.filter((m: any) => m.role === 'user').pop()
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
    sessionMessages = event.messages
  })

  // 退出时清理资源
  pi.on('session_shutdown', async (_event) => {
    // 断开所有渠道连接（释放 WebSocket 等资源）
    try {
      await channelManager.disconnectAll()
    } catch { /* ignore */ }

    // 释放 Agent 资源（清除 dashboard 定时器等）
    try {
      await agent.dispose()
    } catch { /* ignore */ }

    if (sessionMessages.length === 0) return

    try {
      // 序列化对话内容
      const conversationText = serializeConversation(convertToLlm(sessionMessages))

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
      const summary = generateConversationSummary(sessionMessages)
      if (summary) {
        await agent.getMemoryManager().saveConversationSummary(summary)
      }

      // 从对话中提取知识并保存
      extractKnowledgeToGraph(agent, sessionMessages)
      await agent.getKnowledge().save()
      await agent.getLearner().save()
    } catch (error) {
      console.error('会话关闭时保存记忆/知识失败:', error)
    }
  })

  // 注册自定义工具
  pi.registerTool(switchRoleTool)
  pi.registerTool(listRolesTool)
  pi.registerTool(getRoleInfoTool)

  // 注册斜杠命令：/roles
  pi.registerCommand('roles', {
    description: '列出所有可用角色',
    handler: async (_args, ctx) => {
      const current = agent.getCurrentRole()
      const roles = agent.getAvailableRoles()
      const items = roles.map(r => {
        const marker = r.id === current.id ? ' (当前)' : ''
        return `${r.id}: ${r.name}${marker} — ${r.description}`
      })
      ctx.ui.notify(`可用角色 (${roles.length}):\n${items.join('\n')}`, 'info')
    },
  })

  // 注册斜杠命令：/switch
  pi.registerCommand('switch', {
    description: '切换角色（用法: /switch <角色ID>）',
    getArgumentCompletions: (prefix) => {
      const roles = agent.getAvailableRoles()
      return roles
        .filter(r => r.id.startsWith(prefix))
        .map(r => ({ value: r.id, label: `${r.name} — ${r.description}` }))
    },
    handler: async (args, ctx) => {
      const roleId = args.trim()
      if (!roleId) {
        // 无参数，弹出选择列表
        const current = agent.getCurrentRole()
        const roles = agent.getAvailableRoles()
        const items = roles.map(r => {
          const marker = r.id === current.id ? ' (当前)' : ''
          return `${r.id}: ${r.name}${marker}`
        })
        const selected = await ctx.ui.select('选择角色', items)
        if (selected) {
          const id = selected.split(':')[0].trim()
          const success = agent.switchRole(id)
          if (success) {
            ctx.ui.notify(`已切换到: ${agent.getCurrentRole().name}`, 'info')
          }
        }
        return
      }

      const success = agent.switchRole(roleId)
      if (success) {
        const role = agent.getCurrentRole()
        ctx.ui.notify(`已切换到: ${role.name} — ${role.description}`, 'info')
      } else {
        ctx.ui.notify(`角色 "${roleId}" 不存在`, 'error')
      }
    },
  })

  // 注册斜杠命令：/role
  pi.registerCommand('role', {
    description: '显示当前角色详情',
    handler: async (_args, ctx) => {
      const summary = agent.getRoleSummary()
      const text = [
        `角色: ${summary.name} (${summary.id})`,
        `描述: ${summary.description}`,
        `特征: ${summary.traits.join(', ')}`,
        `专业领域: ${summary.expertise.join(', ')}`,
        `能力: ${summary.capabilities.join(', ')}`,
      ].join('\n')
      ctx.ui.notify(text, 'info')
    },
  })

  // 注册斜杠命令：/personality
  pi.registerCommand('personality', {
    description: '显示人格状态',
    handler: async (_args, ctx) => {
      const p = agent.getPersonality()
      const text = [
        `当前情绪: ${p.mood}`,
        `人格强度: ${p.config.intensity}`,
        `主题: ${p.config.theme}`,
      ].join('\n')
      ctx.ui.notify(text, 'info')
    },
  })

  // 注册斜杠命令：/memory
  pi.registerCommand('memory', {
    description: '记忆管理（用法: /memory、/memory summary、/memory clear）',
    handler: async (args, ctx) => {
      const sub = args.trim()
      if (sub === 'clear') {
        await agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
        return
      }
      if (sub === 'summary') {
        const summary = agent.getMemoryManager().getConversationSummary()
        if (summary) {
          ctx.ui.notify(`上次对话摘要:\n${summary}`, 'info')
        } else {
          ctx.ui.notify('暂无对话摘要', 'info')
        }
        return
      }
      if (sub) {
        ctx.ui.notify(`未知子命令: ${sub}`, 'warning')
        return
      }
      // 无参数，弹出选择列表
      const options = ['stats: 查看统计', 'summary: 上次对话摘要', 'clear: 清空记忆']
      const selected = await ctx.ui.select('记忆管理', options)
      if (!selected) return
      const action = selected.split(':')[0].trim()
      if (action === 'stats') {
        const stats = agent.getMemoryStats()
        const summary = agent.getMemoryManager().getConversationSummary()
        const summaryStatus = summary ? `有 (${summary.length} 字符)` : '无'
        ctx.ui.notify(`用户画像统计:\n  偏好: ${stats.preferences} 条\n  事实: ${stats.facts} 条\n  环境信息: ${stats.environmentKeys} 项\n  上次对话摘要: ${summaryStatus}`, 'info')
      } else if (action === 'summary') {
        const summary = agent.getMemoryManager().getConversationSummary()
        ctx.ui.notify(summary ? `上次对话摘要:\n${summary}` : '暂无对话摘要', 'info')
      } else if (action === 'clear') {
        await agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
      }
    },
  })

  // ========== 渠道管理命令 ==========

  const showChannelStatus = async (ctx: any) => {
      const channels = channelManager.getChannels()
      if (channels.length === 0) {
        ctx.ui.notify('未配置任何渠道。使用 /channels setup 添加渠道。', 'info')
        return
      }
      const items = await Promise.all(channels.map(async ch => {
        const status = ch.getStatus ? await ch.getStatus() : 'unknown'
        const icon = status === 'connected' ? '✅' : status === 'error' ? '❌' : '⬜'
        return `${icon} ${ch.name} (${ch.type}) — ${ch.description || ''}`
      }))
      ctx.ui.notify(`渠道列表 (${channels.length}):\n${items.join('\n')}`, 'info')
  }

  const setupChannel = async (ctx: any) => {
      const platform = await ctx.ui.select('选择渠道平台', [
        'wechat: 微信 (基于 wechaty，扫码登录)',
        'feishu: 飞书 (基于飞书开放平台，WebSocket 长连接)',
        'dingtalk: 钉钉 (Webhook 或企业应用)',
      ])
      if (!platform) return

      const platformId = platform.split(':')[0].trim() as 'wechat' | 'feishu' | 'dingtalk'

      // 根据平台收集配置
      const config: Record<string, any> = { enabled: true }

      if (platformId === 'wechat') {
        const puppet = await ctx.ui.select('选择 Puppet 类型', [
          'wechaty-puppet-padlocal: PadLocal (需向 PadLocal/Wechaty 社区申请 token，旧官网可能不可用)',
          'wechaty-puppet-wechat4u: Wechat4U (wechaty 自带，多数账号不可用)',
          'wechaty-puppet-xp: XP (实验性，Node 22 可能无法安装，需手动处理)',
        ])
        if (!puppet) return
        config.puppet = puppet.split(':')[0].trim()

        if (config.puppet === 'wechaty-puppet-padlocal') {
          ctx.ui.notify(
            'PadLocal token 需要向 PadLocal/Wechaty 社区或服务方申请/购买；旧入口 pad-local.com 可能已不可用。没有 token 时建议先使用飞书或钉钉渠道。',
            'warning'
          )
          const token = await ctx.ui.input('PadLocal Token', 'puppet_padlocal_xxxxxxxxxxxxxxxxxx')
          if (token) config.token = token
        }
      } else if (platformId === 'feishu') {
        ctx.ui.notify('请在飞书开放平台创建应用并获取凭证:\nhttps://open.feishu.cn\n\n需要: App ID, App Secret\n事件订阅: im.message.receive_v1 (长连接模式)', 'info')

        const appId = await ctx.ui.input('App ID', 'cli_xxxxx')
        if (!appId) return
        config.appId = appId

        const appSecret = await ctx.ui.input('App Secret', '')
        if (!appSecret) return
        config.appSecret = appSecret

        const encryptKey = await ctx.ui.input('加密密钥 (可选，留空跳过)', '')
        if (encryptKey) config.encryptKey = encryptKey
      } else if (platformId === 'dingtalk') {
        const mode = await ctx.ui.select('选择模式', [
          'webhook: Webhook (仅发送消息到群，快速体验)',
          'enterprise: 企业应用 (双向通信，生产推荐)',
        ])
        if (!mode) return
        config.mode = mode.split(':')[0].trim()

        if (config.mode === 'webhook') {
          ctx.ui.notify('在钉钉群 → 群设置 → 智能群助手 → 添加自定义机器人\n安全设置选"自定义关键词"（填 Bumblebee）', 'info')
          const webhook = await ctx.ui.input('Webhook 地址', '')
          if (!webhook) return
          config.webhook = webhook
        } else {
          ctx.ui.notify('在钉钉开放平台创建企业内部应用:\nhttps://open-dev.dingtalk.com\n\n添加机器人能力，获取 AppKey/AppSecret/RobotCode', 'info')
          const appKey = await ctx.ui.input('AppKey', '')
          if (!appKey) return
          config.appKey = appKey

          const appSecret = await ctx.ui.input('AppSecret', '')
          if (!appSecret) return
          config.appSecret = appSecret

          const robotCode = await ctx.ui.input('Robot Code (可选)', '')
          if (robotCode) config.robotCode = robotCode

          const port = await ctx.ui.input('回调监听端口', '3001')
          config.port = Number(port) || 3001
        }
      }

      // 注册适配器
      try {
        const { createAdapterFromConfig } = await import('../channels/config-loader.js')
        const adapter = await createAdapterFromConfig(platformId, config)
        channelManager.register(adapter)
        await persistChannelConfig(platformId, config)
        ctx.ui.notify(`渠道 ${platformId} 已保存。使用 /channels connect ${adapter.name} 连接。`, 'info')
      } catch (error) {
        ctx.ui.notify(`创建渠道适配器失败: ${error}`, 'error')
      }
  }

  const connectChannel = async (target: string, ctx: any) => {
      const name = target.trim()
      if (name) {
        const ch = channelManager.getChannel(name)
        if (!ch) {
          ctx.ui.notify(`渠道 "${name}" 不存在`, 'error')
          return
        }

        // 微信渠道需要设置 QR 码回调（connect 前设置）
        if (name === 'wechat' && 'onQrCode' in ch) {
          (ch as any).onQrCode((qr: string) => {
            ctx.ui.notify(`请用微信扫码登录:\n${qr}`, 'info')
          })
        }

        try {
          await ch.initialize()
          await ch.connect()
          if (name === 'wechat') {
            ctx.ui.notify('微信 bot 已启动，等待扫码...', 'info')
          } else {
            ctx.ui.notify(`已连接: ${name}`, 'info')
          }
        } catch (error) {
          ctx.ui.notify(`连接 ${name} 失败: ${error}`, 'error')
        }
      } else {
        // 无参数，弹出选择列表
        const channels = channelManager.getChannels()
        if (channels.length === 0) {
          ctx.ui.notify('没有可用渠道', 'warning')
          return
        }
        const options = channels.map(ch => `${ch.name}: ${ch.description || ch.name}`)
        const selected = await ctx.ui.select('选择要连接的渠道', options)
        if (!selected) return
        const selectedName = selected.split(':')[0].trim()
        const ch = channelManager.getChannel(selectedName)
        if (!ch) return
        if (selectedName === 'wechat' && 'onQrCode' in ch) {
          (ch as any).onQrCode((qr: string) => {
            ctx.ui.notify(`请用微信扫码登录:\n${qr}`, 'info')
          })
        }
        try {
          await ch.initialize()
          await ch.connect()
          ctx.ui.notify(`已连接: ${selectedName}`, 'info')
        } catch (error) {
          ctx.ui.notify(`连接 ${selectedName} 失败: ${error}`, 'error')
        }
      }
  }

  const disconnectChannel = async (target: string, ctx: any) => {
      const name = target.trim()
      if (name) {
        const ch = channelManager.getChannel(name)
        if (!ch) {
          ctx.ui.notify(`渠道 "${name}" 不存在`, 'error')
          return
        }
        await ch.disconnect()
        ctx.ui.notify(`已断开: ${name}`, 'info')
      } else {
        // 无参数，弹出选择列表
        const channels = channelManager.getChannels()
        if (channels.length === 0) {
          ctx.ui.notify('没有已注册渠道', 'warning')
          return
        }
        const options = [...channels.map(ch => `${ch.name}: ${ch.description || ch.name}`), 'all: 断开所有渠道']
        const selected = await ctx.ui.select('选择要断开的渠道', options)
        if (!selected) return
        if (selected.startsWith('all')) {
          await channelManager.disconnectAll()
          ctx.ui.notify('已断开所有渠道', 'info')
        } else {
          const selectedName = selected.split(':')[0].trim()
          const ch = channelManager.getChannel(selectedName)
          if (!ch) {
            ctx.ui.notify(`渠道 "${selectedName}" 不存在`, 'error')
            return
          }
          await ch.disconnect()
          ctx.ui.notify(`已断开: ${selectedName}`, 'info')
        }
      }
  }

  pi.registerCommand('channels', {
    description: '渠道管理（用法: /channels、/channels setup、/channels connect [name]、/channels disconnect [name]）',
    getArgumentCompletions: (prefix) => {
      const actions = ['status', 'setup', 'connect', 'disconnect']
      const trimmed = prefix.trimStart()
      const parts = trimmed.split(/\s+/)
      if ((parts[0] === 'connect' || parts[0] === 'disconnect') && parts.length >= 2) {
        const namePrefix = parts.slice(1).join(' ')
        return channelManager.getChannels()
          .filter(ch => ch.name.startsWith(namePrefix))
          .map(ch => ({ value: `${parts[0]} ${ch.name}`, label: ch.description || ch.name }))
      }
      return actions
        .filter(action => action.startsWith(trimmed))
        .map(action => ({ value: action, label: `channels ${action}` }))
    },
    handler: async (args, ctx) => {
      const [actionArg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      let action = actionArg
      let target = rest.join(' ')

      if (!action) {
        const selected = await ctx.ui.select('渠道管理', [
          'status: 查看渠道状态',
          'setup: 配置渠道',
          'connect: 连接渠道',
          'disconnect: 断开渠道',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
      }

      if (action === 'status' || action === 'list') {
        await showChannelStatus(ctx)
      } else if (action === 'setup') {
        await setupChannel(ctx)
      } else if (action === 'connect') {
        await connectChannel(target, ctx)
      } else if (action === 'disconnect') {
        await disconnectChannel(target, ctx)
      } else {
        ctx.ui.notify(`未知渠道操作: ${action}\n用法: /channels status | setup | connect [name] | disconnect [name]`, 'warning')
      }
    },
  })

  // ========== 知识系统命令 ==========

  // 注册斜杠命令：/knowledge
  pi.registerCommand('knowledge', {
    description: '知识图谱管理（用法: /knowledge、/knowledge search <关键词>、/knowledge cleanup）',
    handler: async (args, ctx) => {
      let sub = args.trim()

      if (!sub) {
        const selected = await ctx.ui.select('知识图谱管理', [
          'stats: 查看统计',
          'search: 搜索知识节点',
          'cleanup: 清理重复和无效节点',
        ])
        if (!selected) return
        const action = selected.split(':')[0].trim()
        if (action === 'search') {
          const keyword = await ctx.ui.input('输入搜索关键词', '')
          if (!keyword) return
          sub = `search ${keyword}`
        } else {
          sub = action
        }
      }

      if (sub.startsWith('search ')) {
        const keyword = sub.slice(7).trim()
        if (!keyword) {
          ctx.ui.notify('用法: /knowledge search <关键词>', 'info')
          return
        }
        const results = agent.getKnowledge().query({ text: keyword, limit: 10 })
        if (results.length === 0) {
          ctx.ui.notify(`未找到与 "${keyword}" 相关的知识节点`, 'info')
          return
        }
        const list = results.map(r =>
          `- [${r.node.type}] ${r.node.name} (分数: ${r.score.toFixed(2)})`
        ).join('\n')
        ctx.ui.notify(`搜索结果 (${results.length}):\n${list}`, 'info')
        return
      }

      // /knowledge cleanup — 清理重复和低质量节点
      if (sub === 'cleanup') {
        const kg = agent.getKnowledge()
        const nodes = kg.getAllNodes()
        const before = nodes.length

        // 1. 按 content 前 200 字符去重：保留最早的，删除重复
        const contentMap = new Map<string, string[]>()
        for (const node of nodes) {
          const key = (node.content || '').substring(0, 200)
          if (!key) continue
          const existing = contentMap.get(key) || []
          existing.push(node.id)
          contentMap.set(key, existing)
        }

        let removed = 0
        for (const [, ids] of contentMap) {
          if (ids.length <= 1) continue
          // 保留第一个（最早创建），删除其余
          for (const id of ids.slice(1)) {
            kg.removeNode(id)
            removed++
          }
        }

        // 2. 删除内容过短或明显是噪声的节点
        for (const node of kg.getAllNodes()) {
          const content = node.content || ''
          if (content.length < 10 || content.startsWith('<p align')) {
            kg.removeNode(node.id)
            removed++
          }
        }

        await kg.save()
        const after = kg.getAllNodes().length
        ctx.ui.notify(`清理完成: 删除 ${removed} 个重复/无效节点 (${before} → ${after})`, 'info')
        return
      }

      const stats = agent.getKnowledge().getStats()
      const typeEntries = Object.entries(stats.typeDistribution)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
      ctx.ui.notify(
        `知识图谱统计:\n  节点: ${stats.nodeCount}\n  关系: ${stats.relationCount}\n类型分布:\n${typeEntries || '  (空)'}`,
        'info'
      )
    },
  })

  // 注册斜杠命令：/context
  pi.registerCommand('context', {
    description: '显示当前项目上下文（语言、框架、环境）',
    handler: async (_args, ctx) => {
      const summary = agent.getContext().getContextSummary()
      const parts: string[] = []

      if (summary.project) {
        const p = summary.project
        parts.push(`项目上下文:\n  语言: ${p.language || '未知'}\n  框架: ${p.framework || '未知'}\n  依赖数: ${p.dependencies?.length || 0}`)
      }
      if (summary.user) {
        parts.push(`用户上下文:\n  ID: ${summary.user.id || '未知'}`)
      }
      parts.push(`会话变量: ${summary.sessionVars} 个`)
      parts.push(`任务上下文: ${summary.taskContexts} 个`)
      parts.push(`总上下文: ${summary.totalContexts} 个`)

      ctx.ui.notify(parts.join('\n'), 'info')
    },
  })

  // 注册斜杠命令：/learn
  pi.registerCommand('learn', {
    description: '学习系统管理（用法: /learn、/learn clear）',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') {
        agent.getLearner().clear()
        await agent.getLearner().save()
        ctx.ui.notify('学习数据已清空', 'info')
        return
      }
      if (args.trim()) {
        ctx.ui.notify(`未知子命令: ${args.trim()}`, 'warning')
        return
      }

      // 无参数，弹出选择列表
      const options = ['stats: 查看统计', 'clear: 清空学习数据']
      const selected = await ctx.ui.select('学习系统', options)
      if (!selected) return
      const action = selected.split(':')[0].trim()
      if (action === 'clear') {
        agent.getLearner().clear()
        await agent.getLearner().save()
        ctx.ui.notify('学习数据已清空', 'info')
      } else {
        const stats = agent.getLearner().getStats()
        const typeEntries = Object.entries(stats.typeDistribution)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')
        ctx.ui.notify(
          `学习系统统计:\n  记录: ${stats.totalRecords}\n  模式: ${stats.totalPatterns}\n  成功率: ${(stats.successRate * 100).toFixed(1)}%\n类型分布:\n${typeEntries || '  (空)'}`,
          'info'
        )
      }
    },
  })

  // ========== Batch 1: Agent + Workflow 工具 ==========

  // 工具：列出所有 Agent
  pi.registerTool(defineTool({
    name: 'list_agents',
    label: 'List Agents',
    description: '列出所有已注册的 Agent 及其状态',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const mgr = agent.getAgentManager()
      if (!mgr) return { content: [{ type: 'text' as const, text: 'Agent 系统未启用' }], details: { enabled: false } }
      const agents = mgr.getAllAgents()
      const stats = mgr.getStats()
      const lines = agents.map(a => `  ${a.id} [${a.status}] - ${a.role.name}`)
      return {
        content: [{ type: 'text' as const, text: `Agent 列表 (${stats.total} 个):\n${lines.join('\n') || '  (空)'}` }],
        details: { stats },
      }
    }
  }))

  // 工具：执行 Agent 任务
  pi.registerTool(defineTool({
    name: 'execute_agent_task',
    label: 'Execute Agent Task',
    description: '在指定 Agent 上执行任务',
    parameters: Type.Object({
      agentId: Type.String({ description: 'Agent ID' }),
      description: Type.String({ description: '任务描述' }),
      input: Type.String({ description: '任务输入' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const mgr = agent.getAgentManager()
      if (!mgr) return { content: [{ type: 'text' as const, text: 'Agent 系统未启用' }], details: { enabled: false } }
      const result = await mgr.executeTask({
        id: `task-${Date.now()}`,
        agentId: params.agentId,
        type: 'general',
        description: params.description,
        input: params.input,
        priority: 'medium',
      })
      return {
        content: [{ type: 'text' as const, text: `任务完成 [${result.success ? '成功' : '失败'}]:\n${result.output}` }],
        details: { success: result.success, agentId: result.agentId },
      }
    }
  }))

  // 工具：多 Agent 编排
  pi.registerTool(defineTool({
    name: 'orchestrate_agents',
    label: 'Orchestrate Agents',
    description: '使用多 Agent 编排执行任务',
    parameters: Type.Object({
      team: Type.String({ description: '团队类型，如 code-review, testing, development, quality, full' }),
      task: Type.String({ description: '任务描述' }),
      mode: Type.Optional(Type.String({ description: '协作模式: independent, sequential, parallel, hierarchical' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const orch = agent.getAgentOrchestrator()
      if (!orch) return { content: [{ type: 'text' as const, text: 'Agent 编排系统未启用' }], details: { enabled: false } }
      const teamTypes = (RECOMMENDED_TEAMS as any)[params.team]
      if (!teamTypes) {
        return { content: [{ type: 'text' as const, text: `未知团队类型: ${params.team}。可用: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}` }], details: { error: 'unknown_team' } }
      }
      const result = await orch.executeTeamTask(teamTypes, params.task, { task: params.task }, (params.mode as any) || 'parallel')
      // 清理本次注册的 Agent
      const mgr = agent.getAgentManager()
      if (mgr) {
        for (const r of result.results) {
          mgr.removeAgent(r.agentId)
        }
      }
      return {
        content: [{ type: 'text' as const, text: `编排完成 (${result.metrics.duration}ms):\n${result.results.map((r: any) => `  ${r.agentId}: ${String(r.output).substring(0, 200)}`).join('\n')}` }],
        details: { duration: result.metrics.duration, agentCount: result.metrics.agentCount },
      }
    }
  }))

  // 工具：列出工作流
  pi.registerTool(defineTool({
    name: 'list_workflows',
    label: 'List Workflows',
    description: '列出所有已注册的工作流',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const engine = agent.getWorkflowEngine()
      if (!engine) return { content: [{ type: 'text' as const, text: '工作流系统未启用' }], details: { enabled: false } }
      const workflows = engine.getAllWorkflows()
      const templates = getWorkflowTemplateIds()
      const lines = workflows.map(w => `  ${w.id} - ${w.name}`)
      return {
        content: [{ type: 'text' as const, text: `已注册工作流 (${workflows.length} 个):\n${lines.join('\n') || '  (空)'}\n\n可用模板: ${templates.join(', ')}` }],
        details: { count: workflows.length, templates },
      }
    }
  }))

  // 工具：触发工作流
  pi.registerTool(defineTool({
    name: 'trigger_workflow',
    label: 'Trigger Workflow',
    description: '触发执行一个工作流',
    parameters: Type.Object({
      workflowId: Type.String({ description: '工作流 ID' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const engine = agent.getWorkflowEngine()
      if (!engine) return { content: [{ type: 'text' as const, text: '工作流系统未启用' }], details: { enabled: false } }
      const result = await engine.trigger(params.workflowId)
      const stepLines = Object.entries(result.steps).map(([id, s]: [string, any]) => `  ${id}: ${s.status}`).join('\n')
      return {
        content: [{ type: 'text' as const, text: `工作流执行完成 [${result.status}]:\n${stepLines}` }],
        details: { workflowId: result.workflowId, status: result.status, duration: result.duration },
      }
    }
  }))

  // ========== Batch 1: Agent + Workflow 命令 ==========

  const showAgentStatus = async (ctx: any) => {
      const mgr = agent.getAgentManager()
      if (!mgr) {
        ctx.ui.notify('Agent 系统未启用', 'warning')
        return
      }
      const stats = mgr.getStats()
      const agents = mgr.getAllAgents()
      const lines = agents.map(a => `  ${a.id} [${a.status}] - ${a.role.name}`)
      ctx.ui.notify(
        `Agent 系统:\n  总计: ${stats.total}  空闲: ${stats.idle}  忙碌: ${stats.busy}  错误: ${stats.error}\n\nAgent 列表:\n${lines.join('\n') || '  (无已注册 Agent)'}`,
        'info'
      )
  }

  const runAgentTeam = async (args: string, ctx: any) => {
      const orch = agent.getAgentOrchestrator()
      if (!orch) {
        ctx.ui.notify('Agent 编排系统未启用', 'warning')
        return
      }

      let teamName: string
      let task: string

      const parts = args.trim().split(/\s+/)
      if (!args.trim()) {
        // 无参数，弹出选择列表
        const teams = Object.keys(RECOMMENDED_TEAMS)
        const selected = await ctx.ui.select('选择 Agent 团队', teams)
        if (!selected) return
        teamName = selected
        const taskInput = await ctx.ui.input('输入任务描述', '分析当前项目代码')
        task = taskInput || '分析当前项目代码'
      } else {
        teamName = parts[0]
        task = parts.slice(1).join(' ') || '分析当前项目代码'
      }

      const teamTypes = (RECOMMENDED_TEAMS as any)[teamName]
      if (!teamTypes) {
        ctx.ui.notify(`未知团队: ${teamName}。可用: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}`, 'warning')
        return
      }

      // 进度反馈：显示团队成员
      const total = teamTypes.length
      ctx.ui.notify(`正在初始化 ${teamName} 团队 (${total} 个 Agent)...`, 'info')
      for (let i = 0; i < teamTypes.length; i++) {
        ctx.ui.notify(`  [${i + 1}/${total}] ${teamTypes[i]} 就绪`, 'info')
      }

      const result = await orch.executeTeamTask(teamTypes, task, { task }, 'parallel')

      // 清理本次注册的 Agent
      const mgr = agent.getAgentManager()
      if (mgr) {
        for (const r of result.results) {
          mgr.removeAgent(r.agentId)
        }
      }

      // 进度反馈：显示每个 Agent 的结果
      const lines = result.results.map((r: any) => {
        const status = r.success ? '完成' : '失败'
        const output = String(r.output?.message || r.output || '').substring(0, 200)
        return `  ${status} ${r.agentId}: ${output}`
      })
      ctx.ui.notify(
        `团队执行完成 (耗时 ${(result.metrics.duration / 1000).toFixed(1)}s):\n${lines.join('\n')}`,
        'info'
      )
  }

  // 命令：/agents
  pi.registerCommand('agents', {
    description: 'Agent 管理（用法: /agents、/agents run <team> [task]）',
    getArgumentCompletions: (prefix) => {
      const actions = ['status', 'run']
      const trimmed = prefix.trimStart()
      if (trimmed.startsWith('run ')) {
        const teamPrefix = trimmed.slice(4).trimStart()
        return Object.keys(RECOMMENDED_TEAMS)
          .filter(name => name.startsWith(teamPrefix))
          .map(name => ({ value: `run ${name}`, label: `${name} 团队` }))
      }
      return actions
        .filter(action => action.startsWith(trimmed))
        .map(action => ({ value: action, label: `agents ${action}` }))
    },
    handler: async (args, ctx) => {
      const [actionArg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      let action = actionArg

      if (!action) {
        const selected = await ctx.ui.select('Agent 管理', [
          'status: 查看 Agent 状态',
          'run: 运行专业 Agent 团队',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
      }

      if (action === 'status' || action === 'list') {
        await showAgentStatus(ctx)
      } else if (action === 'run') {
        await runAgentTeam(rest.join(' '), ctx)
      } else {
        ctx.ui.notify(`未知 Agent 操作: ${action}\n用法: /agents run <team> [task]`, 'warning')
      }
    },
  })

  const showWorkflowStatus = async (ctx: any) => {
      const engine = agent.getWorkflowEngine()
      if (!engine) {
        ctx.ui.notify('工作流系统未启用', 'warning')
        return
      }
      const workflows = engine.getAllWorkflows()
      const templates = getWorkflowTemplateIds()
      const lines = workflows.map(w => `  ${w.id} - ${w.name} (${Object.keys(w.steps).length} 步骤)`)
      ctx.ui.notify(
        `工作流系统:\n  已注册: ${workflows.length}\n\n工作流列表:\n${lines.join('\n') || '  (空)'}\n\n可用模板: ${templates.join(', ')}`,
        'info'
      )
  }

  const getWorkflowPayloadExample = (workflowId: string): string => {
    switch (workflowId) {
      case 'pr-review':
        return JSON.stringify({ payload: { prId: 1, repo: 'current', files: ['src/'] } })
      case 'issue-triage':
        return JSON.stringify({ payload: { title: '示例 Issue', body: '需要分析的问题描述', labels: [] } })
      case 'release':
        return JSON.stringify({ version: '1.0.0', branch: 'main', dryRun: true })
      case 'code-quality':
        return JSON.stringify({ files: ['src/'] })
      default:
        return '{}'
    }
  }

  const parseWorkflowRunArgs = (args: string): { workflowId: string; payloadText: string } => {
    const trimmed = args.trim()
    if (!trimmed) return { workflowId: '', payloadText: '' }
    const firstJson = trimmed.search(/[\[{]/)
    if (firstJson === -1) {
      const [workflowId, ...rest] = trimmed.split(/\s+/)
      return { workflowId, payloadText: rest.join(' ') }
    }
    return {
      workflowId: trimmed.slice(0, firstJson).trim(),
      payloadText: trimmed.slice(firstJson).trim(),
    }
  }

  const runWorkflow = async (args: string, ctx: any) => {
      const engine = agent.getWorkflowEngine()
      if (!engine) {
        ctx.ui.notify('工作流系统未启用', 'warning')
        return
      }
      let { workflowId, payloadText } = parseWorkflowRunArgs(args)
      if (!workflowId) {
        // 无参数，弹出选择列表
        const workflows = engine.getAllWorkflows()
        if (workflows.length === 0) {
          ctx.ui.notify('没有已注册的工作流', 'warning')
          return
        }
        const options = workflows.map(w => `${w.id}: ${w.name} (${Object.keys(w.steps).length} 步骤)`)
        const selected = await ctx.ui.select('选择工作流', options)
        if (!selected) return
        workflowId = selected.split(':')[0].trim()
      }

      const workflow = engine.getWorkflow(workflowId)
      if (!workflow) {
        ctx.ui.notify(`工作流不存在: ${workflowId}`, 'error')
        return
      }

      if (!payloadText) {
        payloadText = await ctx.ui.input('输入工作流 payload JSON（留空使用示例）', getWorkflowPayloadExample(workflowId))
        if (!payloadText) {
          payloadText = getWorkflowPayloadExample(workflowId)
        }
      }

      let payload: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(payloadText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          ctx.ui.notify('工作流 payload 必须是 JSON 对象', 'warning')
          return
        }
        payload = parsed as Record<string, unknown>
      } catch (error) {
        ctx.ui.notify(`工作流 payload JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      }

      ctx.ui.notify(`正在执行工作流: ${workflowId}...`, 'info')
      try {
        const result = await engine.trigger(workflowId, payload)
        const stepLines = Object.entries(result.steps).map(([id, s]: [string, any]) => {
          const suffix = s.error ? ` (${s.error})` : ''
          return `  ${id}: ${s.status}${suffix}`
        }).join('\n')
        ctx.ui.notify(
          `工作流执行完成 [${result.status}]:\n${stepLines}`,
          result.status === 'completed' ? 'info' : 'warning'
        )
      } catch (err: any) {
        ctx.ui.notify(`工作流执行失败: ${err.message}`, 'error')
      }
  }

  // 命令：/workflows
  pi.registerCommand('workflows', {
    description: '工作流管理（用法: /workflows、/workflows run <workflowId> [payload JSON]）',
    getArgumentCompletions: (prefix) => {
      const actions = ['status', 'run']
      const trimmed = prefix.trimStart()
      if (trimmed.startsWith('run ')) {
        const workflowPrefix = trimmed.slice(4).trimStart()
        const engine = agent.getWorkflowEngine()
        if (!engine) return []
        return engine.getAllWorkflows()
          .filter(w => w.id.startsWith(workflowPrefix))
          .map(w => ({ value: `run ${w.id}`, label: w.name }))
      }
      return actions
        .filter(action => action.startsWith(trimmed))
        .map(action => ({ value: action, label: `workflows ${action}` }))
    },
    handler: async (args, ctx) => {
      const [actionArg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      let action = actionArg

      if (!action) {
        const selected = await ctx.ui.select('工作流管理', [
          'status: 查看工作流状态',
          'run: 运行工作流',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
      }

      if (action === 'status' || action === 'list') {
        await showWorkflowStatus(ctx)
      } else if (action === 'run') {
        await runWorkflow(rest.join(' '), ctx)
      } else {
        ctx.ui.notify(`未知工作流操作: ${action}\n用法: /workflows run <workflowId>`, 'warning')
      }
    },
  })

  // ========== Batch 2: Performance + Dashboard 工具 ==========

  // 工具：获取性能指标
  pi.registerTool(defineTool({
    name: 'get_performance_metrics',
    label: 'Get Performance Metrics',
    description: '获取当前系统性能指标',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const monitor = agent.getPerformanceMonitor()
      if (!monitor) return { content: [{ type: 'text' as const, text: '性能监控未启用' }], details: { enabled: false } }
      const metrics = monitor.getMetrics()
      const cache = agent.getCache()
      const cacheStats = cache ? cache.getStats() : null
      return {
        content: [{
          type: 'text' as const,
          text: `性能指标:\n  响应时间: avg=${metrics.responseTime.avg.toFixed(0)}ms\n  缓存: ${cacheStats ? `${cacheStats.size} 条目, 命中率 ${(cacheStats.hitRate * 100).toFixed(1)}%` : '未启用'}`
        }],
        details: { metrics, cacheStats },
      }
    }
  }))

  // 工具：清空缓存
  pi.registerTool(defineTool({
    name: 'clear_cache',
    label: 'Clear Cache',
    description: '清空 LRU 缓存',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const cache = agent.getCache()
      if (!cache) return { content: [{ type: 'text' as const, text: '缓存未启用' }], details: { enabled: false } }
      const size = cache.size()
      cache.clear()
      return {
        content: [{ type: 'text' as const, text: `已清空 ${size} 条缓存` }],
        details: { cleared: size },
      }
    }
  }))

  // ========== Batch 2: Performance + Dashboard 命令 ==========

  // 命令：/perf
  pi.registerCommand('perf', {
    description: '显示性能指标',
    handler: async (_args, ctx) => {
      const cache = agent.getCache()
      const cacheStats = cache ? cache.getStats() : null
      const concurrency = agent.getConcurrency()
      const concStats = concurrency ? concurrency.getStats() : null

      const parts: string[] = ['性能指标:']

      const monitor = agent.getPerformanceMonitor()
      if (monitor) {
        const metrics = monitor.getMetrics()
        parts.push(`  响应时间: avg=${metrics.responseTime.avg.toFixed(0)}ms  p50=${metrics.responseTime.p50.toFixed(0)}ms  p90=${metrics.responseTime.p90.toFixed(0)}ms`)
        parts.push(`  吞吐量: ${metrics.throughput.requestsPerSecond.toFixed(1)} req/s`)
      }

      parts.push(`  缓存: ${cacheStats ? `${cacheStats.size} 条目, 命中率 ${(cacheStats.hitRate * 100).toFixed(1)}%` : '未启用'}`)
      parts.push(`  并发: ${concStats ? `活跃 ${concStats.active}, 排队 ${concStats.queued}` : '未启用'}`)

      if (!monitor && !cache && !concurrency) {
        ctx.ui.notify('性能系统未启用', 'warning')
        return
      }

      ctx.ui.notify(parts.join('\n'), 'info')
    },
  })

  // 命令：/cache
  pi.registerCommand('cache', {
    description: '缓存管理（用法: /cache、/cache clear）',
    handler: async (args, ctx) => {
      const cache = agent.getCache()
      if (!cache) {
        ctx.ui.notify('缓存未启用', 'warning')
        return
      }
      if (args.trim() === 'clear') {
        const size = cache.size()
        cache.clear()
        ctx.ui.notify(`已清空 ${size} 条缓存`, 'info')
        return
      }
      if (args.trim()) {
        ctx.ui.notify(`未知子命令: ${args.trim()}`, 'warning')
        return
      }
      // 无参数，弹出选择列表
      const stats = cache.getStats()
      const options = ['stats: 查看统计', 'clear: 清空缓存']
      const selected = await ctx.ui.select(`缓存管理 (${stats.size} 条目)`, options)
      if (!selected) return
      const action = selected.split(':')[0].trim()
      if (action === 'clear') {
        const size = cache.size()
        cache.clear()
        ctx.ui.notify(`已清空 ${size} 条缓存`, 'info')
      } else {
        ctx.ui.notify(
          `缓存状态:\n  条目数: ${stats.size}\n  命中率: ${(stats.hitRate * 100).toFixed(1)}%\n  未命中率: ${(stats.missRate * 100).toFixed(1)}%`,
          'info'
        )
      }
    },
  })

  // 命令：/dashboard
  pi.registerCommand('dashboard', {
    description: '显示仪表盘状态',
    handler: async (_args, ctx) => {
      const dashboard = agent.getDashboard()
      if (!dashboard) {
        ctx.ui.notify('仪表盘未启用（在配置中设置 dashboard.enabled: true）', 'warning')
        return
      }
      const widgets = dashboard.getAllWidgets()
      const lines = widgets.map(w => `  ${w.id} [${w.type}] - ${w.title}`)
      ctx.ui.notify(
        `仪表盘:\n  组件数: ${widgets.length}\n\n组件列表:\n${lines.join('\n') || '  (空)'}`,
        'info'
      )
    },
  })

  // ========== Batch 3: Collaboration + Voice 工具 ==========

  // 工具：获取协作状态
  pi.registerTool(defineTool({
    name: 'get_collaboration_status',
    label: 'Get Collaboration Status',
    description: '获取实时协作状态',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const room = agent.getCollaborationRoom()
      if (!room) return { content: [{ type: 'text' as const, text: '协作模块未启用' }], details: { enabled: false } }
      return {
        content: [{
          type: 'text' as const,
          text: `协作状态:\n  连接: ${room.isConnected() ? '已连接' : '未连接'}\n  用户数: ${room.getUserCount()}`
        }],
        details: { connected: room.isConnected(), userCount: room.getUserCount() },
      }
    }
  }))

  // 工具：发送协作消息
  pi.registerTool(defineTool({
    name: 'send_collaboration_message',
    label: 'Send Collaboration Message',
    description: '向协作房间发送消息',
    parameters: Type.Object({
      message: Type.String({ description: '消息内容' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const room = agent.getCollaborationRoom()
      if (!room) return { content: [{ type: 'text' as const, text: '协作模块未启用' }], details: { enabled: false } }
      if (!room.isConnected()) return { content: [{ type: 'text' as const, text: '未连接到协作房间' }], details: { connected: false } }
      room.sendMessage(params.message)
      return {
        content: [{ type: 'text' as const, text: '消息已发送' }],
        details: { sent: true },
      }
    }
  }))

  // 工具：语音状态
  pi.registerTool(defineTool({
    name: 'voice_status',
    label: 'Voice Status',
    description: '获取语音引擎状态',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const voice = agent.getVoiceEngine()
      if (!voice) return { content: [{ type: 'text' as const, text: '语音模块未启用' }], details: { enabled: false } }
      return {
        content: [{ type: 'text' as const, text: `语音引擎状态: ${voice.status}` }],
        details: { available: true, status: voice.status },
      }
    }
  }))

  // ========== Batch 3: Collaboration + Voice 命令 ==========

  // 命令：/collab
  pi.registerCommand('collab', {
    description: '协作管理（用法: /collab, /collab connect, /collab disconnect, /collab join <roomId>）',
    handler: async (args, ctx) => {
      const room = agent.getCollaborationRoom()
      if (!room) {
        ctx.ui.notify('协作模块未启用（在配置中设置 collaboration.enabled: true）', 'warning')
        return
      }
      const cmd = args.trim().split(/\s+/)
      const action = cmd[0] || ''

      if (!action) {
        // 无参数，弹出选择列表
        const status = room.isConnected() ? '已连接' : '未连接'
        const options = ['connect: 连接协作服务器', 'disconnect: 断开协作连接', 'join: 加入房间']
        const selected = await ctx.ui.select(`协作管理 (${status})`, options)
        if (!selected) return
        const selectedAction = selected.split(':')[0].trim()
        if (selectedAction === 'join') {
          const roomId = await ctx.ui.input('输入房间 ID', '')
          if (!roomId) return
          await room.joinRoom(roomId)
          ctx.ui.notify(`已加入房间: ${roomId}`, 'info')
        } else if (selectedAction === 'connect') {
          await room.connect()
          ctx.ui.notify('已连接到协作服务器', 'info')
        } else if (selectedAction === 'disconnect') {
          await room.disconnect()
          ctx.ui.notify('已断开协作连接', 'info')
        }
        return
      }

      switch (action) {
        case 'connect':
          await room.connect()
          ctx.ui.notify('已连接到协作服务器', 'info')
          break
        case 'disconnect':
          await room.disconnect()
          ctx.ui.notify('已断开协作连接', 'info')
          break
        case 'join':
          if (!cmd[1]) { ctx.ui.notify('用法: /collab join <roomId>', 'warning'); return }
          await room.joinRoom(cmd[1])
          ctx.ui.notify(`已加入房间: ${cmd[1]}`, 'info')
          break
        default:
          ctx.ui.notify(
            `协作状态:\n  连接: ${room.isConnected() ? '已连接' : '未连接'}\n  用户数: ${room.getUserCount()}\n\n用法: /collab connect | disconnect | join <roomId>`,
            'info'
          )
      }
    },
  })

  // 命令：/voice
  pi.registerCommand('voice', {
    description: '语音管理（用法: /voice, /voice start, /voice stop, /voice speak <text>）',
    handler: async (args, ctx) => {
      const voice = agent.getVoiceEngine()
      if (!voice) {
        ctx.ui.notify('语音模块未启用（在配置中设置 voice.enabled: true）', 'warning')
        return
      }
      const parts = args.trim().split(/\s+/)
      const action = parts[0] || ''

      if (!action) {
        // 无参数，弹出选择列表
        const options = ['start: 启动语音识别', 'stop: 停止语音识别', 'speak: 语音播放文本']
        const selected = await ctx.ui.select(`语音管理 (${voice.status})`, options)
        if (!selected) return
        const selectedAction = selected.split(':')[0].trim()
        if (selectedAction === 'start') {
          try { await voice.startListening(); ctx.ui.notify('语音识别已启动', 'info') }
          catch (err: any) { ctx.ui.notify(`启动失败: ${err.message}`, 'error') }
        } else if (selectedAction === 'stop') {
          try { await voice.stopListening(); ctx.ui.notify('语音识别已停止', 'info') }
          catch (err: any) { ctx.ui.notify(`停止失败: ${err.message}`, 'error') }
        } else if (selectedAction === 'speak') {
          const text = await ctx.ui.input('输入要播放的文本', '')
          if (!text) return
          try { await voice.speak({ text }); ctx.ui.notify('语音播放完成', 'info') }
          catch (err: any) { ctx.ui.notify(`播放失败: ${err.message}`, 'error') }
        }
        return
      }

      switch (action) {
        case 'start':
          try {
            await voice.startListening()
            ctx.ui.notify('语音识别已启动', 'info')
          } catch (err: any) {
            ctx.ui.notify(`启动语音识别失败: ${err.message}`, 'error')
          }
          break
        case 'stop':
          try {
            await voice.stopListening()
            ctx.ui.notify('语音识别已停止', 'info')
          } catch (err: any) {
            ctx.ui.notify(`停止语音识别失败: ${err.message}`, 'error')
          }
          break
        case 'speak':
          if (!parts.slice(1).join(' ')) { ctx.ui.notify('用法: /voice speak <text>', 'warning'); return }
          try {
            await voice.speak({ text: parts.slice(1).join(' ') })
            ctx.ui.notify('语音播放完成', 'info')
          } catch (err: any) {
            ctx.ui.notify(`语音播放失败: ${err.message}`, 'error')
          }
          break
        default:
          ctx.ui.notify(
            `语音引擎: ${voice.status}\n\n用法: /voice start | stop | speak <text>`,
            'info'
          )
      }
    },
  })

  // Bumblebee keeps /help as an extension command because pi does not expose one.
  const HELP_GROUPS: Array<{ name: string; commands: Array<{ cmd: string; desc: string }> }> = [
    {
      name: 'Bumblebee 角色',
      commands: [
        { cmd: '/roles', desc: '列出所有可用角色' },
        { cmd: '/switch <id>', desc: '切换角色' },
        { cmd: '/role', desc: '显示当前角色详情' },
        { cmd: '/personality', desc: '显示人格状态' },
      ],
    },
    {
      name: 'Bumblebee 记忆与知识',
      commands: [
        { cmd: '/memory', desc: '记忆管理' },
        { cmd: '/knowledge', desc: '知识图谱统计' },
        { cmd: '/knowledge search <词>', desc: '搜索知识节点' },
        { cmd: '/knowledge cleanup', desc: '清理重复和无效节点' },
        { cmd: '/context', desc: '显示项目上下文' },
        { cmd: '/learn', desc: '学习系统管理' },
      ],
    },
    {
      name: 'Bumblebee Agent 与工作流',
      commands: [
        { cmd: '/agents', desc: 'Agent 管理' },
        { cmd: '/agents run <team> [task]', desc: '运行专业 Agent 团队' },
        { cmd: '/workflows', desc: '工作流管理' },
        { cmd: '/workflows run <id> [payload JSON]', desc: '触发工作流执行' },
      ],
    },
    {
      name: 'Bumblebee 状态与渠道',
      commands: [
        { cmd: '/status', desc: '系统健康概览' },
        { cmd: '/perf', desc: '性能指标' },
        { cmd: '/cache', desc: '缓存管理' },
        { cmd: '/dashboard', desc: '仪表盘状态' },
        { cmd: '/channels', desc: '渠道管理' },
        { cmd: '/channels setup', desc: '配置渠道' },
        { cmd: '/channels connect [name]', desc: '连接渠道' },
        { cmd: '/channels disconnect [name]', desc: '断开渠道' },
      ],
    },
    {
      name: 'Bumblebee 高级功能',
      commands: [
        { cmd: '/collab', desc: '协作管理' },
        { cmd: '/voice', desc: '语音管理' },
      ],
    },
    {
      name: 'pi 会话管理',
      commands: [
        { cmd: '/resume', desc: '恢复历史会话' },
        { cmd: '/new', desc: '开始新会话' },
        { cmd: '/tree', desc: '浏览会话分支' },
        { cmd: '/fork', desc: '从历史消息创建分支' },
      ],
    },
  ]

  const getHelpKey = (cmd: string) => cmd
    .split(/\s+/)
    .filter(part => !part.startsWith('<') && !part.startsWith('['))
    .join(' ')

  const HELP_DETAILS: Record<string, string> = Object.fromEntries(
    HELP_GROUPS.flatMap(group =>
      group.commands.map(command => [
        getHelpKey(command.cmd),
        `${command.desc}\n用法: ${command.cmd}`,
      ])
    )
  )

  pi.registerCommand('help', {
    description: '显示 Bumblebee 命令和常用 pi 会话命令',
    handler: async (args, ctx) => {
      const target = args.trim()
      if (target) {
        const normalized = target.startsWith('/') ? target : `/${target}`
        const detail = HELP_DETAILS[normalized]
        ctx.ui.notify(
          detail ? `${normalized}\n${detail}` : `未知命令: ${normalized}\n输入 /help 查看可用命令。`,
          detail ? 'info' : 'warning'
        )
        return
      }

      const lines: string[] = ['可用命令:\n']
      for (const group of HELP_GROUPS) {
        lines.push(`${group.name}:`)
        for (const command of group.commands) {
          lines.push(`  ${command.cmd.padEnd(30)} ${command.desc}`)
        }
        lines.push('')
      }
      lines.push('恢复或查看历史会话请使用 pi 提供的 /resume。')
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  // ========== Issue #11: /status 系统健康概览 ==========

  pi.registerCommand('status', {
    description: '显示系统健康状态概览',
    handler: async (_args, ctx) => {
      const role = agent.getCurrentRole()
      const memStats = agent.getMemoryStats()
      const kgStats = agent.getKnowledge().getStats()
      const learnStats = agent.getLearner().getStats()

      // Agent 系统
      const agentMgr = agent.getAgentManager()
      const agentStats = agentMgr ? agentMgr.getStats() : null

      // 工作流
      const wfEngine = agent.getWorkflowEngine()
      const wfCount = wfEngine ? wfEngine.getAllWorkflows().length : 0

      // 缓存
      const cache = agent.getCache()
      const cacheStats = cache ? cache.getStats() : null

      // 并发
      const conc = agent.getConcurrency()
      const concStats = conc ? conc.getStats() : null

      // 仪表盘
      const dash = agent.getDashboard()

      // 协作
      const collab = agent.getCollaborationRoom()

      // 语音
      const voice = agent.getVoiceEngine()

      const lines = [
        '系统状态概览',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `角色: ${role.name} (${role.id})`,
        `记忆: ${memStats.preferences} 偏好, ${memStats.facts} 事实`,
        `知识: ${kgStats.nodeCount} 节点, ${kgStats.relationCount} 关系`,
        `学习: ${learnStats.totalRecords} 记录, ${learnStats.totalPatterns} 模式`,
        `Agent: ${agentStats ? `${agentStats.total} 个 (${agentStats.busy} 忙碌)` : '未启用'}`,
        `工作流: ${wfCount} 个已注册`,
        `缓存: ${cacheStats ? `${cacheStats.size} 条目, 命中率 ${(cacheStats.hitRate * 100).toFixed(0)}%` : '未启用'}`,
        `并发: ${concStats ? `活跃 ${concStats.active}, 排队 ${concStats.queued}` : '未启用'}`,
        `仪表盘: ${dash ? '已启用' : '未启用'}`,
        `协作: ${collab ? (collab.isConnected() ? '已连接' : '未连接') : '未启用'}`,
        `语音: ${voice ? voice.status : '未启用'}`,
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

}

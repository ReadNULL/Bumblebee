/**
 * Bumblebee Extension for pi-coding-agent
 *
 * 将 Bumblebee 的角色、人格、记忆等能力注入 pi-coding-agent TUI
 */

import { Type } from 'typebox'
import { defineTool, convertToLlm, serializeConversation, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BumblebeeAgent } from '../core/agent.js'
import { loadConfig } from '../core/config.js'
import { BumblebeePersonality } from '../personality/traits.js'
import { extractProfileFromConversation } from '../memory/profile-extractor.js'
import { ChannelManager } from '../channels/manager.js'
import { WeChatAdapter } from '../channels/wechat.js'
import { getSpecializedAgentTypes, createAgentTeam, RECOMMENDED_TEAMS } from '../agents/specialized.js'
import { getWorkflowTemplateIds, createWorkflowFromTemplate } from '../workflows/templates.js'

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

// 从消息内容中提取文本
function extractText(content: string | Array<{ type: string; [key: string]: any }>): string {
  if (typeof content === 'string') return content
  return content?.filter(c => c.type === 'text' && 'text' in c).map(c => (c as any).text).join('\n') ?? ''
}

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

export default async function bumblebeeExtension(pi: ExtensionAPI) {
  // 预加载 wechaty 模块（后台进行，不阻塞启动）
  WeChatAdapter.preload().catch(() => {})

  // 初始化 BumblebeeAgent
  const config = await loadConfig()
  agent = new BumblebeeAgent(config)
  await agent.initialize()

  // 初始化渠道管理器（从配置加载已启用的渠道）
  channelManager = new ChannelManager()
  if (config.channels) {
    await channelManager.loadFromConfig(config.channels)
  }

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

    // 返回 undefined 让框架执行默认 compaction
    return
  })

  // 跟踪对话消息（每次 LLM 调用前触发，保存完整上下文）
  pi.on('context', async (event) => {
    sessionMessages = event.messages
  })

  // 退出时提取画像并保存对话摘要
  pi.on('session_shutdown', async (_event) => {
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

      // 保存知识图谱和学习数据
      await agent.getKnowledge().save()
      await agent.getLearner().save()
    } catch {
      // 退出时的错误静默忽略
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
    description: '记忆管理（用法: /memory 或 /memory clear）',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') {
        await agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
        return
      }
      if (args.trim() === 'summary') {
        const summary = agent.getMemoryManager().getConversationSummary()
        if (summary) {
          ctx.ui.notify(`上次对话摘要:\n${summary}`, 'info')
        } else {
          ctx.ui.notify('暂无对话摘要', 'info')
        }
        return
      }
      const stats = agent.getMemoryStats()
      const summary = agent.getMemoryManager().getConversationSummary()
      const summaryStatus = summary ? `有 (${summary.length} 字符)` : '无'
      ctx.ui.notify(`用户画像统计:\n  偏好: ${stats.preferences} 条\n  事实: ${stats.facts} 条\n  环境信息: ${stats.environmentKeys} 项\n  上次对话摘要: ${summaryStatus}`, 'info')
    },
  })

  // ========== 渠道管理命令 ==========

  // 注册斜杠命令：/channels
  pi.registerCommand('channels', {
    description: '列出所有渠道及其连接状态',
    handler: async (_args, ctx) => {
      const channels = channelManager.getChannels()
      if (channels.length === 0) {
        ctx.ui.notify('未配置任何渠道。使用 /channel-setup 添加渠道。', 'info')
        return
      }
      const items = await Promise.all(channels.map(async ch => {
        const status = ch.getStatus ? await ch.getStatus() : 'unknown'
        const icon = status === 'connected' ? '✅' : status === 'error' ? '❌' : '⬜'
        return `${icon} ${ch.name} (${ch.type}) — ${ch.description || ''}`
      }))
      ctx.ui.notify(`渠道列表 (${channels.length}):\n${items.join('\n')}`, 'info')
    },
  })

  // 注册斜杠命令：/channel-setup
  pi.registerCommand('channel-setup', {
    description: '交互式设置渠道连接',
    handler: async (_args, ctx) => {
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
          'wechaty-puppet-padlocal: PadLocal (推荐，稳定，需要 token)',
          'wechaty-puppet-xp: XP (免费，Windows 桌面版)',
          'wechaty-puppet-wechat4u: Wechat4U (⚠️ 多数账号已不可用)',
        ])
        if (!puppet) return
        config.puppet = puppet.split(':')[0].trim()

        if (config.puppet === 'wechaty-puppet-padlocal') {
          const token = await ctx.ui.input('PadLocal Token', '从 https://pad-local.com 获取')
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
        }
      }

      // 注册适配器
      try {
        const { createAdapterFromConfig } = await import('../channels/config-loader.js')
        const adapter = await createAdapterFromConfig(platformId, config)
        channelManager.register(adapter)
        ctx.ui.notify(`渠道 ${platformId} 已添加。使用 /channel-connect ${adapter.name} 连接。`, 'info')
      } catch (error) {
        ctx.ui.notify(`创建渠道适配器失败: ${error}`, 'error')
      }
    },
  })

  // 注册斜杠命令：/channel-connect
  pi.registerCommand('channel-connect', {
    description: '连接指定渠道或所有渠道（用法: /channel-connect [渠道名]）',
    getArgumentCompletions: (prefix) => {
      return channelManager.getChannels()
        .filter(ch => ch.name.startsWith(prefix))
        .map(ch => ({ value: ch.name, label: ch.description || ch.name }))
    },
    handler: async (args, ctx) => {
      const name = args.trim()
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
        try {
          await channelManager.connectAll()
          ctx.ui.notify('已连接所有渠道', 'info')
        } catch (error) {
          ctx.ui.notify(`连接失败: ${error}`, 'error')
        }
      }
    },
  })

  // 注册斜杠命令：/channel-disconnect
  pi.registerCommand('channel-disconnect', {
    description: '断开指定渠道或所有渠道',
    getArgumentCompletions: (prefix) => {
      return channelManager.getChannels()
        .filter(ch => ch.name.startsWith(prefix))
        .map(ch => ({ value: ch.name, label: ch.description || ch.name }))
    },
    handler: async (args, ctx) => {
      const name = args.trim()
      if (name) {
        await channelManager.unregister(name)
        ctx.ui.notify(`已断开: ${name}`, 'info')
      } else {
        await channelManager.disconnectAll()
        ctx.ui.notify('已断开所有渠道', 'info')
      }
    },
  })

  // ========== 知识系统命令 ==========

  // 注册斜杠命令：/knowledge
  pi.registerCommand('knowledge', {
    description: '知识图谱管理（用法: /knowledge 或 /knowledge search <关键词>）',
    handler: async (args, ctx) => {
      const sub = args.trim()

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
    description: '学习系统管理（用法: /learn 或 /learn clear）',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') {
        agent.getLearner().clear()
        ctx.ui.notify('学习数据已清空', 'info')
        return
      }

      const stats = agent.getLearner().getStats()
      const typeEntries = Object.entries(stats.typeDistribution)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
      ctx.ui.notify(
        `学习系统统计:\n  记录: ${stats.totalRecords}\n  模式: ${stats.totalPatterns}\n  成功率: ${(stats.successRate * 100).toFixed(1)}%\n类型分布:\n${typeEntries || '  (空)'}`,
        'info'
      )
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

  // 命令：/agents
  pi.registerCommand('agents', {
    description: '显示 Agent 系统状态和列表',
    handler: async (_args, ctx) => {
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
    },
  })

  // 命令：/agent-run
  pi.registerCommand('agent-run', {
    description: '运行专业 Agent 团队（用法: /agent-run <team> [task]）',
    handler: async (args, ctx) => {
      const orch = agent.getAgentOrchestrator()
      if (!orch) {
        ctx.ui.notify('Agent 编排系统未启用', 'warning')
        return
      }
      const parts = args.trim().split(/\s+/)
      const teamName = parts[0] || 'code-review'
      const task = parts.slice(1).join(' ') || '分析当前项目代码'
      const teamTypes = (RECOMMENDED_TEAMS as any)[teamName]
      if (!teamTypes) {
        ctx.ui.notify(`未知团队: ${teamName}。可用: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}`, 'warning')
        return
      }
      ctx.ui.notify(`正在运行 ${teamName} 团队...`, 'info')
      const result = await orch.executeTeamTask(teamTypes, task, { task }, 'parallel')
      ctx.ui.notify(
        `团队执行完成 (${result.metrics.duration}ms):\n${result.results.map((r: any) => `  ${r.agentId}: ${String(r.output).substring(0, 300)}`).join('\n')}`,
        'info'
      )
    },
  })

  // 命令：/workflows
  pi.registerCommand('workflows', {
    description: '显示工作流系统状态',
    handler: async (_args, ctx) => {
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
    },
  })

  // 命令：/workflow-run
  pi.registerCommand('workflow-run', {
    description: '触发工作流执行（用法: /workflow-run <workflowId>）',
    handler: async (args, ctx) => {
      const engine = agent.getWorkflowEngine()
      if (!engine) {
        ctx.ui.notify('工作流系统未启用', 'warning')
        return
      }
      const workflowId = args.trim()
      if (!workflowId) {
        const ids = engine.getAllWorkflows().map(w => w.id)
        ctx.ui.notify(`用法: /workflow-run <id>\n可用工作流: ${ids.join(', ')}`, 'warning')
        return
      }
      ctx.ui.notify(`正在执行工作流: ${workflowId}...`, 'info')
      try {
        const result = await engine.trigger(workflowId)
        const stepLines = Object.entries(result.steps).map(([id, s]: [string, any]) => `  ${id}: ${s.status}`).join('\n')
        ctx.ui.notify(
          `工作流执行完成 [${result.status}]:\n${stepLines}`,
          'info'
        )
      } catch (err: any) {
        ctx.ui.notify(`工作流执行失败: ${err.message}`, 'error')
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
      const monitor = agent.getPerformanceMonitor()
      if (!monitor) {
        ctx.ui.notify('性能监控未启用', 'warning')
        return
      }
      const metrics = monitor.getMetrics()
      const cache = agent.getCache()
      const cacheStats = cache ? cache.getStats() : null
      const concurrency = agent.getConcurrency()
      const concStats = concurrency ? concurrency.getStats() : null
      ctx.ui.notify(
        `性能指标:\n` +
        `  响应时间: avg=${metrics.responseTime.avg.toFixed(0)}ms  p50=${metrics.responseTime.p50.toFixed(0)}ms  p90=${metrics.responseTime.p90.toFixed(0)}ms\n` +
        `  吞吐量: ${metrics.throughput.requestsPerSecond.toFixed(1)} req/s\n` +
        `  缓存: ${cacheStats ? `${cacheStats.size} 条目, 命中率 ${(cacheStats.hitRate * 100).toFixed(1)}%` : '未启用'}\n` +
        `  并发: ${concStats ? `活跃 ${concStats.active}, 排队 ${concStats.queued}` : '未启用'}`,
        'info'
      )
    },
  })

  // 命令：/cache
  pi.registerCommand('cache', {
    description: '缓存管理（用法: /cache 或 /cache clear）',
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
      const stats = cache.getStats()
      ctx.ui.notify(
        `缓存状态:\n  条目数: ${stats.size}\n  命中率: ${(stats.hitRate * 100).toFixed(1)}%\n  未命中率: ${(stats.missRate * 100).toFixed(1)}%`,
        'info'
      )
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
        content: [{ type: 'text' as const, text: `语音引擎状态: 已初始化` }],
        details: { available: true },
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
      switch (action) {
        case 'start':
          await voice.startListening()
          ctx.ui.notify('语音识别已启动', 'info')
          break
        case 'stop':
          await voice.stopListening()
          ctx.ui.notify('语音识别已停止', 'info')
          break
        case 'speak':
          if (!parts.slice(1).join(' ')) { ctx.ui.notify('用法: /voice speak <text>', 'warning'); return }
          await voice.speak({ text: parts.slice(1).join(' ') })
          ctx.ui.notify('语音播放完成', 'info')
          break
        default:
          ctx.ui.notify(
            `语音引擎: 已初始化\n\n用法: /voice start | stop | speak <text>`,
            'info'
          )
      }
    },
  })
}

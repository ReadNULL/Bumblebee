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
function extractText(content: string | Array<{ type: string; text: string }>): string {
  if (typeof content === 'string') return content
  return content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
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

  // 注入角色 system prompt + 用户画像 + 上次对话摘要
  pi.on('before_agent_start', async (event) => {
    const rolePrompt = agent.getRoleManager().getSystemPrompt()
    const personalityPrompt = BumblebeePersonality.getSystemPrompt()
    const profilePrompt = agent.getMemoryManager().getContextPrompt()
    const summaryPrompt = agent.getMemoryManager().getConversationSummaryPrompt()
    return {
      systemPrompt: `${event.systemPrompt}\n\n${personalityPrompt}\n\n## 当前角色\n${rolePrompt}${profilePrompt}${summaryPrompt}`,
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
}

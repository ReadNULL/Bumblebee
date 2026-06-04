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
import type { KnowledgeNode } from '../knowledge/types.js'

// 从对话中提取知识节点
function extractKnowledgeFromConversation(messages: any[]): {
  files: Map<string, string[]>   // filePath → contexts where it appeared
  errors: Array<{ pattern: string; context: string }>
  solutions: Array<{ errorPattern: string; solution: string }>
  concepts: Map<string, string>  // concept → description
} {
  const files = new Map<string, string[]>()
  const errors: Array<{ pattern: string; context: string }> = []
  const solutions: Array<{ errorPattern: string; solution: string }> = []
  const concepts = new Map<string, string>()

  // 文件路径模式：只匹配项目内的实际代码路径
  const FILE_REGEX = /\b((?:src|tests?|lib|app|dist|build|packages?)[\\/][\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java))\b/g
  // 错误模式
  const ERROR_REGEX = /(?:Error|TypeError|ReferenceError|SyntaxError|错误|异常|失败|报错)[：:\s]*(.{10,120})/gi
  // 解决方案模式
  const SOLUTION_REGEX = /(?:修复|解决|改为|改成|使用|需要|应该|改用|替换成|换成)[：:\s]*(.{10,200})/gi

  for (const msg of messages) {
    const text = extractText(msg.content)
    if (!text || text.length < 20) continue

    // 跳过文档/README 类内容（包含 HTML 标签或大量 markdown 链接）
    const htmlTagCount = (text.match(/<[a-zA-Z][^>]*>/g) || []).length
    const mdLinkCount = (text.match(/\[.*?\]\(.*?\)/g) || []).length
    if (htmlTagCount > 5 || mdLinkCount > 10) continue

    let match

    // 只从 assistant 消息中提取文件路径（代码分析上下文）
    if (msg.role === 'assistant') {
      const fileRegex = new RegExp(FILE_REGEX.source, 'g')
      let fileCount = 0
      while ((match = fileRegex.exec(text)) !== null && fileCount < 10) {
        const filePath = match[1].replace(/\\/g, '/')
        if (filePath.includes('node_modules') || filePath.startsWith('http')) continue
        const existing = files.get(filePath) || []
        if (existing.length < 2) {
          // 存储文件路径附近的上下文，而非整段消息
          const matchIndex = match.index
          const contextStart = Math.max(0, matchIndex - 50)
          const contextEnd = Math.min(text.length, matchIndex + filePath.length + 150)
          existing.push(text.substring(contextStart, contextEnd))
          files.set(filePath, existing)
          fileCount++
        }
      }
    }

    // 提取错误（只从 assistant 消息中提取）
    if (msg.role === 'assistant') {
      const errorRegex = new RegExp(ERROR_REGEX.source, 'gi')
      while ((match = errorRegex.exec(text)) !== null) {
        errors.push({ pattern: match[0].substring(0, 80), context: text.substring(0, 200) })
      }

      // 提取解决方案
      const solRegex = new RegExp(SOLUTION_REGEX.source, 'gi')
      while ((match = solRegex.exec(text)) !== null) {
        const solution = match[1].trim()
        if (solution.length > 10) {
          solutions.push({ errorPattern: '', solution })
        }
      }
    }

    // 提取概念定义（用户或 assistant 提到 "X 是..."、"X 指的是"）
    if (msg.role === 'assistant') {
      const conceptRegex = /(\w{2,20})\s*(?:是指|是|指的是|means|is)\s*[：:]\s*(.{10,150})/g
      while ((match = conceptRegex.exec(text)) !== null) {
        concepts.set(match[1], match[2])
      }
    }
  }

  return { files, errors, solutions, concepts }
}

// 生成确定性节点 ID
function makeNodeId(type: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '-').substring(0, 40)
  return `${type}-${safe}`
}

// 从对话中提取知识并写入图谱
function extractKnowledgeToGraph(agent: BumblebeeAgent, messages: any[]): void {
  const knowledge = extractKnowledgeFromConversation(messages)
  const kg = agent.getKnowledge()
  const now = new Date()

  // 写入文件节点
  for (const [filePath, contexts] of knowledge.files) {
    const id = makeNodeId('file', filePath)
    const existing = kg.getNode(id)
    if (existing) {
      kg.updateNode(id, { updatedAt: now })
    } else {
      kg.addNode({
        id,
        type: 'file',
        name: filePath,
        content: contexts[0] || '',
        metadata: { mentionCount: contexts.length },
        relations: [],
        importance: Math.min(0.5 + contexts.length * 0.1, 0.9),
        confidence: 0.7,
        tags: [filePath.split('.').pop() || 'file'],
      })
    }
  }

  // 写入错误节点
  for (const err of knowledge.errors.slice(0, 5)) {
    const id = makeNodeId('error', err.pattern)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'bug',
        name: err.pattern,
        content: err.context,
        metadata: {},
        relations: [],
        importance: 0.7,
        confidence: 0.6,
        tags: ['bug'],
      })
    }
  }

  // 写入解决方案节点
  for (const sol of knowledge.solutions.slice(0, 5)) {
    const id = makeNodeId('solution', sol.solution)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'decision',
        name: sol.solution.substring(0, 60),
        content: sol.solution,
        metadata: {},
        relations: [],
        importance: 0.8,
        confidence: 0.7,
        tags: ['solution'],
      })
    }
  }

  // 注：错误和解决方案节点已独立写入，不做自动关联（按数组下标配对无实际意义）

  // 写入概念节点
  for (const [concept, desc] of knowledge.concepts) {
    const id = makeNodeId('concept', concept)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'concept',
        name: concept,
        content: desc,
        metadata: {},
        relations: [],
        importance: 0.6,
        confidence: 0.7,
        tags: ['concept'],
      })
    }
  }
}

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

      // 从对话中提取知识并保存
      extractKnowledgeToGraph(agent, sessionMessages)
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
          await channelManager.unregister(selectedName)
          ctx.ui.notify(`已断开: ${selectedName}`, 'info')
        }
      }
    },
  })

  // ========== 知识系统命令 ==========

  // 注册斜杠命令：/knowledge
  pi.registerCommand('knowledge', {
    description: '知识图谱管理（用法: /knowledge、/knowledge search <关键词>、/knowledge cleanup）',
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

  // /knowledge-cleanup — 独立命令，清理重复和无效节点
  pi.registerCommand('knowledge-cleanup', {
    description: '清理知识图谱中的重复和无效节点',
    handler: async (_args, ctx) => {
      const kg = agent.getKnowledge()
      const nodes = kg.getAllNodes()
      const before = nodes.length

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
        for (const id of ids.slice(1)) {
          kg.removeNode(id)
          removed++
        }
      }

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
    getArgumentCompletions: (prefix) => {
      return Object.keys(RECOMMENDED_TEAMS)
        .filter(name => name.startsWith(prefix))
        .map(name => ({ value: name, label: `${name} 团队` }))
    },
    handler: async (args, ctx) => {
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
    getArgumentCompletions: (prefix) => {
      const engine = agent.getWorkflowEngine()
      if (!engine) return []
      return engine.getAllWorkflows()
        .filter(w => w.id.startsWith(prefix))
        .map(w => ({ value: w.id, label: w.name }))
    },
    handler: async (args, ctx) => {
      const engine = agent.getWorkflowEngine()
      if (!engine) {
        ctx.ui.notify('工作流系统未启用', 'warning')
        return
      }
      let workflowId = args.trim()
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

  // ========== Issue #3 + #5: /help 帮助系统（分组显示） ==========

  // 命令分组定义
  const COMMAND_GROUPS = [
    {
      name: '角色管理',
      commands: [
        { cmd: '/roles', desc: '列出所有可用角色' },
        { cmd: '/switch <id>', desc: '切换角色' },
        { cmd: '/role', desc: '显示当前角色详情' },
        { cmd: '/personality', desc: '显示人格状态' },
      ],
    },
    {
      name: '记忆系统',
      commands: [
        { cmd: '/memory', desc: '显示记忆统计' },
        { cmd: '/memory summary', desc: '查看上次对话摘要' },
        { cmd: '/memory clear', desc: '清空记忆' },
        { cmd: '/knowledge', desc: '知识图谱统计' },
        { cmd: '/knowledge search <词>', desc: '搜索知识节点' },
        { cmd: '/knowledge-cleanup', desc: '清理重复和无效节点' },
        { cmd: '/context', desc: '显示项目上下文' },
        { cmd: '/learn', desc: '学习系统统计' },
        { cmd: '/learn clear', desc: '清空学习数据' },
      ],
    },
    {
      name: 'Agent 系统',
      commands: [
        { cmd: '/agents', desc: 'Agent 系统状态和列表' },
        { cmd: '/agent-run <team> [task]', desc: '运行专业 Agent 团队' },
      ],
    },
    {
      name: '工作流',
      commands: [
        { cmd: '/workflows', desc: '工作流系统状态' },
        { cmd: '/workflow-run <id>', desc: '触发工作流执行' },
      ],
    },
    {
      name: '监控',
      commands: [
        { cmd: '/perf', desc: '性能指标' },
        { cmd: '/cache', desc: '缓存状态' },
        { cmd: '/cache clear', desc: '清空缓存' },
        { cmd: '/dashboard', desc: '仪表盘状态' },
        { cmd: '/status', desc: '系统健康概览' },
      ],
    },
    {
      name: '渠道',
      commands: [
        { cmd: '/channels', desc: '渠道状态' },
        { cmd: '/channel-setup <name>', desc: '配置渠道' },
        { cmd: '/channel-connect [name]', desc: '连接渠道' },
        { cmd: '/channel-disconnect [name]', desc: '断开渠道' },
      ],
    },
    {
      name: '高级功能',
      commands: [
        { cmd: '/collab', desc: '协作状态' },
        { cmd: '/voice', desc: '语音引擎状态' },
        { cmd: '/resume', desc: '恢复历史会话' },
        { cmd: '/new', desc: '开始新会话' },
      ],
    },
  ]

  // 命令详情映射
  const COMMAND_DETAILS: Record<string, string> = {
    '/roles': '列出所有可用的 Bumblebee 角色。\n用法: /roles\n示例: /roles',
    '/switch': '切换到指定角色，角色决定 AI 的专业领域和沟通风格。\n用法: /switch <角色ID>\n示例: /switch code-reviewer\n支持 Tab 补全。',
    '/role': '显示当前角色的详细信息，包括人格特征、专业领域和能力。\n用法: /role',
    '/personality': '显示当前人格状态（情绪、强度、主题）。\n用法: /personality',
    '/memory': '显示记忆系统统计（偏好数、事实数、环境键数）。\n用法: /memory\n子命令: /memory summary, /memory clear',
    '/knowledge': '知识图谱管理。显示节点数、关系数和类型分布。\n用法: /knowledge\n子命令:\n  /knowledge search <关键词> — 搜索知识节点\n  /knowledge cleanup — 清理重复和无效节点',
    '/context': '显示当前项目上下文（语言、框架、依赖、环境）。\n用法: /context',
    '/learn': '学习系统管理。显示记录数、模式数和成功率。\n用法: /learn\n子命令: /learn clear',
    '/agents': '显示 Agent 系统状态和已注册 Agent 列表。\n用法: /agents',
    '/agent-run': '运行专业 Agent 团队执行任务。\n用法: /agent-run <团队名> [任务描述]\n可用团队: code-review, testing, development, quality, full\n示例: /agent-run code-review 审查 src/ 目录',
    '/workflows': '显示工作流系统状态和已注册工作流列表。\n用法: /workflows',
    '/workflow-run': '触发执行指定工作流。\n用法: /workflow-run <工作流ID>\n可用: pr-review, issue-triage, release, code-quality\n示例: /workflow-run pr-review\n支持 Tab 补全。',
    '/perf': '显示系统性能指标（响应时间、缓存命中率、并发状态）。\n用法: /perf',
    '/cache': '缓存管理。\n用法: /cache (查看状态)\n子命令: /cache clear (清空缓存)',
    '/dashboard': '显示仪表盘状态和组件列表。\n用法: /dashboard\n需要 dashboard.enabled: true',
    '/status': '显示系统整体健康状态概览。\n用法: /status',
    '/channels': '显示所有渠道的连接状态。\n用法: /channels',
    '/collab': '协作模块管理。\n用法: /collab (查看状态)\n子命令: /collab connect, /collab disconnect, /collab join <roomId>',
    '/voice': '语音模块管理。\n用法: /voice (查看状态)\n子命令: /voice start, /voice stop, /voice speak <文本>',
    '/resume': '浏览并选择历史会话恢复。\n用法: /resume',
    '/new': '开始一个新会话。\n用法: /new',
    '/history': '显示最近的会话历史。\n用法: /history',
  }

  pi.registerCommand('help', {
    description: '显示帮助信息（用法: /help 或 /help <命令>）',
    handler: async (args, ctx) => {
      const target = args.trim()

      // /help <command> — 显示具体命令详情
      if (target) {
        // 模糊匹配：去掉前缀 /
        const normalized = target.startsWith('/') ? target : `/${target}`
        const detail = COMMAND_DETAILS[normalized]
        if (detail) {
          ctx.ui.notify(`${normalized}\n${detail}`, 'info')
        } else {
          ctx.ui.notify(`未知命令: ${normalized}\n输入 /help 查看所有可用命令。`, 'warning')
        }
        return
      }

      // /help — 分组显示所有命令
      const lines: string[] = ['可用命令:\n']
      for (const group of COMMAND_GROUPS) {
        lines.push(`${group.name}:`)
        for (const c of group.commands) {
          lines.push(`  ${c.cmd.padEnd(30)} ${c.desc}`)
        }
        lines.push('')
      }
      lines.push('输入 /help <命令> 查看详细用法。')
      lines.push('快速开始: docs/quick-start.md')
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

  // ========== Issue #12: /history 会话历史 ==========

  pi.registerCommand('history', {
    description: '显示最近的会话历史',
    handler: async (_args, ctx) => {
      try {
        const { readdir, readFile } = await import('fs/promises')
        const { join } = await import('path')
        const { homedir } = await import('os')

        const sessionsDir = join(homedir(), '.pi', 'agent', 'sessions')
        try {
          const files = await readdir(sessionsDir)
          const sessionFiles = files
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, 10)

          if (sessionFiles.length === 0) {
            ctx.ui.notify('没有找到历史会话。', 'info')
            return
          }

          const lines = ['最近会话:\n']
          for (const file of sessionFiles) {
            try {
              const content = await readFile(join(sessionsDir, file), 'utf-8')
              const session = JSON.parse(content)
              const date = session.createdAt || session.updatedAt || '未知时间'
              const msgCount = session.messages?.length || 0
              const id = session.id || file.replace('.json', '')
              lines.push(`  ${id.substring(0, 12)}  ${date}  ${msgCount} 条消息`)
            } catch {
              lines.push(`  ${file.replace('.json', '')}  (无法解析)`)
            }
          }
          lines.push('\n使用 /resume 恢复会话。')
          ctx.ui.notify(lines.join('\n'), 'info')
        } catch {
          ctx.ui.notify('会话目录不存在。', 'info')
        }
      } catch {
        ctx.ui.notify('无法读取会话历史。', 'warning')
      }
    },
  })

  // ========== Issue #9: 首次运行检测 ==========

  // 检查是否首次运行（记忆目录为空）
  const memStats = agent.getMemoryStats()
  if (memStats.preferences === 0 && memStats.facts === 0) {
    // 延迟显示，等 TUI 就绪
    setTimeout(() => {
      const role = agent.getCurrentRole()
      const welcome = [
        `欢迎使用 Bumblebee！当前角色: ${role.name}`,
        '',
        '快速开始:',
        '  /help          查看所有命令',
        '  /roles         列出可用角色',
        '  /switch <id>   切换角色',
        '  /status        系统状态概览',
        '',
        '直接输入消息即可开始对话。',
      ].join('\n')
      // 通过 pi.ui 输出欢迎消息（如果 API 支持）
      try {
        pi.registerCommand('__welcome', {
          description: '首次运行欢迎信息',
          handler: async (_args, ctx) => {
            ctx.ui.notify(welcome, 'info')
          },
        })
      } catch {
        // 静默忽略
      }
    }, 500)
  }
}

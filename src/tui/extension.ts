/**
 * Bumblebee Extension for pi-coding-agent
 *
 * 将 Bumblebee 的角色、人格、记忆等能力注入 pi-coding-agent TUI
 */

import { Type } from 'typebox'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BumblebeeAgent } from '../core/agent.js'
import { loadConfig } from '../core/config.js'
import { BumblebeePersonality } from '../personality/traits.js'

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

// 模块级 Agent 实例（Extension 工厂闭包中使用）
let agent: BumblebeeAgent

export default async function bumblebeeExtension(pi: ExtensionAPI) {
  // 初始化 BumblebeeAgent
  const config = await loadConfig()
  agent = new BumblebeeAgent(config)
  await agent.initialize()

  // 注入角色 system prompt
  pi.on('before_agent_start', async (event) => {
    const rolePrompt = agent.getRoleManager().getSystemPrompt()
    const personalityPrompt = BumblebeePersonality.getSystemPrompt()
    return {
      systemPrompt: `${event.systemPrompt}\n\n${personalityPrompt}\n\n## 当前角色\n${rolePrompt}`,
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
        agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
        return
      }
      const stats = agent.getMemoryStats()
      ctx.ui.notify(`记忆统计:\n  短期记忆: ${stats.shortTerm} 条\n  长期记忆: ${stats.longTerm} 条`, 'info')
    },
  })
}

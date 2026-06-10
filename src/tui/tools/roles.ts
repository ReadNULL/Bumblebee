import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { BumblebeeExtensionRuntime } from '../context.js'

export function registerRoleTools(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerTool(defineTool({
    name: 'switch_role',
    label: 'Switch Role',
    description: 'Switch Bumblebee to a specified role.',
    parameters: Type.Object({
      roleId: Type.String({ description: 'Role id, for example bumblebee, code-reviewer, or architect.' }),
    }),
    async execute(_toolCallId, params) {
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

      const list = agent.getAvailableRoles().map(r => `- ${r.id}: ${r.name}`).join('\n')
      return {
        content: [{
          type: 'text',
          text: `角色 "${params.roleId}" 不存在。可用角色:\n${list}`,
        }],
        details: { roleId: params.roleId, success: false },
        isError: true,
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'list_roles',
    label: 'List Roles',
    description: 'List all available Bumblebee roles.',
    parameters: Type.Object({}),
    async execute() {
      const current = agent.getCurrentRole()
      const roles = agent.getAvailableRoles()
      const list = roles.map(r => {
        const marker = r.id === current.id ? ' (当前)' : ''
        return `- ${r.id}: ${r.name}${marker} - ${r.description}`
      }).join('\n')

      return {
        content: [{ type: 'text', text: `可用角色:\n${list}` }],
        details: { count: roles.length, currentRole: current.id },
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'get_role_info',
    label: 'Get Role Info',
    description: 'Get detailed information about the current or specified role.',
    parameters: Type.Object({
      roleId: Type.Optional(Type.String({ description: 'Role id. Defaults to current role.' })),
    }),
    async execute(_toolCallId, params) {
      const roleId = params.roleId
      if (roleId) {
        const found = agent.getAvailableRoles().find(r => r.id === roleId)
        if (!found) {
          return {
            content: [{ type: 'text', text: `角色 "${roleId}" 不存在` }],
            details: {},
            isError: true,
          }
        }
      }

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
  }))
}

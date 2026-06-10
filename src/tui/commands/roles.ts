import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

export function registerRoleCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerCommand('roles', {
    description: '列出所有可用角色',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const current = agent.getCurrentRole()
      const roles = agent.getAvailableRoles()
      const items = roles.map(r => {
        const marker = r.id === current.id ? ' (当前)' : ''
        return `${r.id}: ${r.name}${marker} - ${r.description}`
      })
      ctx.ui.notify(`可用角色 (${roles.length}):\n${items.join('\n')}`, 'info')
    },
  })

  pi.registerCommand('switch', {
    description: '切换角色（用法: /switch <角色ID>）',
    getArgumentCompletions: (prefix: string) => {
      const roles = agent.getAvailableRoles()
      return roles
        .filter(r => r.id.startsWith(prefix))
        .map(r => ({ value: r.id, label: `${r.name} - ${r.description}` }))
    },
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const roleId = args.trim()
      if (!roleId) {
        const current = agent.getCurrentRole()
        const roles = agent.getAvailableRoles()
        const items = roles.map(r => {
          const marker = r.id === current.id ? ' (当前)' : ''
          return `${r.id}: ${r.name}${marker}`
        })
        const selected = await ctx.ui.select('选择角色', items)
        if (!selected) return

        const id = selected.split(':')[0].trim()
        if (agent.switchRole(id)) {
          ctx.ui.notify(`已切换到: ${agent.getCurrentRole().name}`, 'info')
        }
        return
      }

      if (agent.switchRole(roleId)) {
        const role = agent.getCurrentRole()
        ctx.ui.notify(`已切换到: ${role.name} - ${role.description}`, 'info')
      } else {
        ctx.ui.notify(`角色 "${roleId}" 不存在`, 'error')
      }
    },
  })

  pi.registerCommand('role', {
    description: '显示当前角色详情',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
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

  pi.registerCommand('personality', {
    description: '显示人格状态',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const personality = agent.getPersonality()
      const text = [
        `当前情绪: ${personality.mood}`,
        `人格强度: ${personality.config.intensity}`,
        `主题: ${personality.config.theme}`,
      ].join('\n')
      ctx.ui.notify(text, 'info')
    },
  })
}

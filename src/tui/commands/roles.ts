import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'
import type { RoleConfig } from '../../roles/types.js'

const ROLE_ACTIONS = ['list', 'create', 'switch', 'show', 'delete', 'dir']

function splitList(input: string, fallback: string[] = []): string[] {
  const values = input
    .split(/[,，、]/)
    .map(item => item.trim())
    .filter(Boolean)
  return values.length > 0 ? values : fallback
}

function generateRoleId(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)
  return normalized || `custom-role-${Date.now().toString(36)}`
}

function formatRoleDetail(role: RoleConfig): string {
  return [
    `角色: ${role.name} (${role.id})`,
    `描述: ${role.description}`,
    `特征: ${role.personality.traits.join(', ')}`,
    `沟通风格: ${role.personality.communication}`,
    `专业领域: ${role.personality.expertise.join(', ')}`,
    `价值观: ${role.personality.values.join(', ')}`,
    `能力: ${role.capabilities.join(', ')}`,
    role.limitations?.length ? `限制: ${role.limitations.join(', ')}` : null,
    role.metadata.tags?.length ? `标签: ${role.metadata.tags.join(', ')}` : null,
  ].filter(Boolean).join('\n')
}

export function registerRoleCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  const listRoles = async (ctx: BumblebeeCommandContext) => {
    const current = agent.getCurrentRole()
    const roles = agent.getAvailableRoles()
    const items = roles.map(r => {
      const marker = r.id === current.id ? ' (当前)' : ''
      return `${r.id}: ${r.name}${marker} - ${r.description}`
    })
    ctx.ui.notify(`可用角色 (${roles.length}):\n${items.join('\n')}`, 'info')
  }

  const selectRoleId = async (
    ctx: BumblebeeCommandContext,
    title: string,
    options = agent.getAvailableRoles(),
  ): Promise<string | undefined> => {
    if (options.length === 0) {
      ctx.ui.notify('没有可用角色', 'warning')
      return undefined
    }
    const selected = await ctx.ui.select(title, options.map(r => `${r.id}: ${r.name}`))
    return selected?.split(':')[0].trim()
  }

  const switchRole = async (roleId: string, ctx: BumblebeeCommandContext) => {
    const target = roleId.trim() || await selectRoleId(ctx, '选择角色')
    if (!target) return

    if (agent.switchRole(target)) {
      const role = agent.getCurrentRole()
      ctx.ui.notify(`已切换到: ${role.name} - ${role.description}`, 'info')
    } else {
      ctx.ui.notify(`角色 "${target}" 不存在`, 'error')
    }
  }

  const showRole = async (roleId: string, ctx: BumblebeeCommandContext) => {
    let target = roleId.trim()
    if (!target) {
      const current = agent.getCurrentRole()
      const selected = await ctx.ui.select('查看角色详情', [
        `${current.id}: ${current.name} (当前)`,
        ...agent.getAvailableRoles()
          .filter(role => role.id !== current.id)
          .map(role => `${role.id}: ${role.name}`),
      ])
      if (!selected) return
      target = selected.split(':')[0].trim()
    }

    const role = agent.getRoleManager().getRole(target)
    if (!role) {
      ctx.ui.notify(`角色 "${target}" 不存在`, 'error')
      return
    }
    ctx.ui.notify(formatRoleDetail(role), 'info')
  }

  const createRole = async (ctx: BumblebeeCommandContext) => {
    const name = await ctx.ui.input('角色名称', '')
    if (!name) {
      ctx.ui.notify('角色名称不能为空', 'warning')
      return
    }

    const description = await ctx.ui.input('角色描述', '')
    if (!description) {
      ctx.ui.notify('角色描述不能为空', 'warning')
      return
    }

    const defaultId = generateRoleId(name)
    const id = await ctx.ui.input('角色 ID（小写字母、数字、连字符）', defaultId)
    if (!id) {
      ctx.ui.notify('角色 ID 不能为空', 'warning')
      return
    }
    if (agent.getRoleManager().getRole(id)) {
      ctx.ui.notify(`角色 ID "${id}" 已存在`, 'error')
      return
    }

    const traits = splitList(await ctx.ui.input('性格特征（逗号分隔）', '专业,耐心,高效') || '', ['专业', '耐心', '高效'])
    const communication = await ctx.ui.input('沟通风格', '友好、专业') || '友好、专业'
    const expertise = splitList(await ctx.ui.input('专业领域（逗号分隔）', '编程,调试,架构设计') || '', ['编程', '调试', '架构设计'])
    const values = splitList(await ctx.ui.input('价值观（逗号分隔）', '代码质量,用户成功,持续学习') || '', ['代码质量', '用户成功', '持续学习'])
    const systemPrompt = await ctx.ui.input(
      '系统提示词',
      `你是${name}。${description}。请基于你的专业领域给出清晰、可靠、可执行的建议。`,
    )
    if (!systemPrompt) {
      ctx.ui.notify('系统提示词不能为空', 'warning')
      return
    }

    const greeting = await ctx.ui.input('问候语', `你好，我是${name}。`)
    const tone = (await ctx.ui.select('语气风格', [
      'professional: 专业',
      'friendly: 友好',
      'formal: 正式',
      'casual: 随意',
    ]) || 'professional').split(':')[0].trim() as RoleConfig['responseStyle']['tone']
    const verbosity = (await ctx.ui.select('详细程度', [
      'adaptive: 自适应',
      'concise: 简洁',
      'detailed: 详细',
    ]) || 'adaptive').split(':')[0].trim() as RoleConfig['responseStyle']['verbosity']
    const humor = (await ctx.ui.select('幽默程度', [
      'none: 无',
      'subtle: 轻微',
      'moderate: 适度',
    ]) || 'none').split(':')[0].trim() as RoleConfig['responseStyle']['humor']
    const language = (await ctx.ui.select('主要语言', [
      'zh-CN: 中文',
      'en-US: 英文',
      'auto: 自动',
    ]) || 'zh-CN').split(':')[0].trim() as RoleConfig['responseStyle']['language']
    const capabilities = splitList(
      await ctx.ui.input('能力列表（逗号分隔）', '代码编写,代码审查,问题调试') || '',
      ['代码编写', '代码审查', '问题调试'],
    )
    const limitations = splitList(await ctx.ui.input('限制说明（可选，逗号分隔）', '') || '', [])
    const tags = splitList(await ctx.ui.input('标签（可选，逗号分隔）', '') || '', [])

    try {
      const role = await agent.createRole({
        id,
        name,
        description,
        personality: {
          traits,
          communication,
          expertise,
          values,
        },
        systemPrompt,
        greeting: greeting || `你好，我是${name}。`,
        responseStyle: {
          tone,
          verbosity,
          humor,
          language,
        },
        capabilities,
        limitations: limitations.length > 0 ? limitations : undefined,
        tags: tags.length > 0 ? tags : undefined,
      })

      const shouldSwitch = await ctx.ui.select('角色已创建，是否立即切换？', [
        'yes: 切换到新角色',
        'no: 仅创建，稍后手动切换',
      ])
      if (shouldSwitch?.startsWith('yes')) agent.switchRole(role.id)

      ctx.ui.notify(
        `角色 "${role.name}" 创建成功。\nID: ${role.id}\n保存目录: ${agent.getRoleManager().getRolesDir()}`,
        'info',
      )
    } catch (error) {
      ctx.ui.notify(`创建角色失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const deleteRole = async (roleId: string, ctx: BumblebeeCommandContext) => {
    const current = agent.getCurrentRole()
    const deletable = agent.getAvailableRoles().filter(role => role.id !== current.id)
    const target = roleId.trim() || await selectRoleId(ctx, '选择要删除的角色', deletable)
    if (!target) return

    if (target === current.id) {
      ctx.ui.notify('不能删除当前角色。请先切换到其他角色。', 'warning')
      return
    }
    if (target === 'bumblebee') {
      ctx.ui.notify('不能删除内置默认角色 bumblebee。', 'warning')
      return
    }

    const role = agent.getRoleManager().getRole(target)
    if (!role) {
      ctx.ui.notify(`角色 "${target}" 不存在`, 'error')
      return
    }

    const confirmed = await ctx.ui.select(`确认删除角色 ${role.name} (${role.id})？`, [
      'no: 取消',
      'yes: 确认删除',
    ])
    if (!confirmed?.startsWith('yes')) {
      ctx.ui.notify('已取消删除角色', 'info')
      return
    }

    const deleted = await agent.deleteRole(target)
    ctx.ui.notify(deleted ? `已删除角色: ${target}` : `删除角色失败: ${target}`, deleted ? 'info' : 'error')
  }

  pi.registerCommand('roles', {
    description: '角色管理（/roles、/roles create、/roles switch <id>、/roles show [id]、/roles delete <id>、/roles dir）',
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart()
      const [action, ...rest] = trimmed.split(/\s+/)
      if ((action === 'switch' || action === 'show' || action === 'delete') && rest.length >= 1) {
        const rolePrefix = rest.join(' ')
        return agent.getAvailableRoles()
          .filter(role => role.id.startsWith(rolePrefix))
          .map(role => ({ value: `${action} ${role.id}`, label: `${role.name} - ${role.description}` }))
      }
      return ROLE_ACTIONS
        .filter(item => item.startsWith(trimmed))
        .map(item => ({ value: item, label: `roles ${item}` }))
    },
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const [actionArg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      let action = actionArg
      const target = rest.join(' ')

      if (!action) {
        const selected = await ctx.ui.select('角色管理', [
          'list: 列出所有可用角色',
          'create: 创建新角色',
          'switch: 切换角色',
          'show: 查看角色详情',
          'delete: 删除角色',
          'dir: 查看角色存储目录',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
      }

      if (action === 'list' || action === 'status') await listRoles(ctx)
      else if (action === 'create' || action === 'new') await createRole(ctx)
      else if (action === 'switch') await switchRole(target, ctx)
      else if (action === 'show' || action === 'info') await showRole(target, ctx)
      else if (action === 'delete' || action === 'remove') await deleteRole(target, ctx)
      else if (action === 'dir') ctx.ui.notify(`角色存储目录:\n${agent.getRoleManager().getRolesDir()}`, 'info')
      else ctx.ui.notify('未知角色操作。\n用法: /roles list | create | switch <id> | show [id] | delete <id> | dir', 'warning')
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
      await switchRole(args, ctx)
    },
  })

  pi.registerCommand('role', {
    description: '显示当前角色详情',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      ctx.ui.notify(formatRoleDetail(agent.getCurrentRole()), 'info')
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

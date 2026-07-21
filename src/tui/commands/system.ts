import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

const HELP_GROUPS: Array<{ name: string; commands: Array<{ cmd: string; desc: string }> }> = [
  {
    name: 'Bumblebee 角色',
    commands: [
      { cmd: '/roles', desc: '角色管理' },
      { cmd: '/roles create', desc: '创建新角色' },
      { cmd: '/roles switch <id>', desc: '切换角色' },
      { cmd: '/roles show [id]', desc: '显示角色详情' },
      { cmd: '/roles delete <id>', desc: '删除角色' },
      { cmd: '/roles dir', desc: '显示角色存储目录' },
      { cmd: '/switch <id>', desc: '切换角色（兼容快捷入口）' },
      { cmd: '/role', desc: '显示当前角色详情（兼容快捷入口）' },
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

const HELP_DETAILS: Record<string, string> = Object.fromEntries(
  HELP_GROUPS.flatMap(group =>
    group.commands.map(command => [
      getHelpKey(command.cmd),
      `${command.desc}\n用法: ${command.cmd}`,
    ]),
  ),
)

function getHelpKey(cmd: string): string {
  return cmd
    .split(/\s+/)
    .filter(part => !part.startsWith('<') && !part.startsWith('['))
    .join(' ')
}

export function registerSystemCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerCommand('help', {
    description: '显示 Bumblebee 命令和常用 pi 会话命令',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const target = args.trim()
      if (target) {
        const normalized = target.startsWith('/') ? target : `/${target}`
        const detail = HELP_DETAILS[normalized]
        ctx.ui.notify(
          detail ? `${normalized}\n${detail}` : `未知命令: ${normalized}\n输入 /help 查看可用命令。`,
          detail ? 'info' : 'warning',
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

  pi.registerCommand('status', {
    description: '显示系统健康状态概览',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const role = agent.getCurrentRole()
      const memStats = agent.getMemoryStats()
      const kgStats = agent.getKnowledge().getStats()
      const learnStats = agent.getLearner().getStats()
      const agentStats = agent.getAgentManager()?.getStats() ?? null
      const wfCount = agent.getWorkflowEngine()?.getAllWorkflows().length ?? 0
      const dash = agent.getDashboard()
      const collab = agent.getCollaborationRoom()
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
        `仪表盘: ${dash ? '已启用' : '未启用'}`,
        `协作: ${collab ? (collab.isConnected() ? '已连接' : '未连接') : '未启用'}`,
        `语音: ${voice ? voice.status : '未启用'}`,
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('perf', {
    description: '显示 Agent 任务性能指标',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const manager = agent.getAgentManager()
      if (!manager) {
        ctx.ui.notify('Agent 系统未启用，暂无性能指标。', 'warning')
        return
      }
      const stats = manager.getPerformanceStats()
      ctx.ui.notify([
        'Agent 任务性能',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `任务数: ${stats.taskCount}`,
        `成功率: ${(stats.successRate * 100).toFixed(1)}%`,
        `响应时间 p50: ${stats.p50}ms`,
        `响应时间 p99: ${stats.p99}ms`,
        `最大响应时间: ${stats.max}ms`,
      ].join('\n'), 'info')
    },
  })

  pi.registerCommand('dashboard', {
    description: '显示仪表盘指标和 Widget 状态',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const manager = agent.getAgentManager()
      const performance = manager?.getPerformanceStats()
      const dashboard = agent.getDashboard()
      const widgets = dashboard?.getAllWidgets() ?? []
      const lines = [
        'Bumblebee 仪表盘',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `状态: ${dashboard ? '已启用' : '未启用（设置 dashboard.enabled: true 可保存 Widget 数据）'}`,
        `Widget: ${widgets.length}`,
      ]
      if (performance) {
        lines.push(
          `任务数: ${performance.taskCount}`,
          `成功率: ${(performance.successRate * 100).toFixed(1)}%`,
          `响应时间: p50 ${performance.p50}ms / p99 ${performance.p99}ms`,
        )
      }
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}

import { RECOMMENDED_TEAMS } from '../../agents/specialized.js'
import type { AgentType } from '../../agents/specialized.js'
import { getWorkflowTemplateIds } from '../../workflows/templates.js'
import type { StepResult } from '../../workflows/types.js'
import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

export function registerAgentWorkflowCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  const showAgentStatus = async (ctx: BumblebeeCommandContext) => {
    const mgr = agent.getAgentManager()
    if (!mgr) {
      ctx.ui.notify('Agent 系统未启用', 'warning')
      return
    }
    const stats = mgr.getStats()
    const agents = mgr.getAllAgents()
    const lines = agents.map(item => `  ${item.id} [${item.status}] - ${item.role.name}`)
    ctx.ui.notify(
      `Agent 系统:\n  总计: ${stats.total}  空闲: ${stats.idle}  忙碌: ${stats.busy}  错误: ${stats.error}\n\nAgent 列表:\n${lines.join('\n') || '  (无已注册 Agent)'}`,
      'info',
    )
  }

  const runAgentTeam = async (args: string, ctx: BumblebeeCommandContext) => {
    const orch = agent.getAgentOrchestrator()
    if (!orch) {
      ctx.ui.notify('Agent 编排系统未启用', 'warning')
      return
    }

    const parts = args.trim().split(/\s+/)
    let teamName = parts[0]
    let task = parts.slice(1).join(' ') || '分析当前项目代码'
    if (!args.trim()) {
      const selected = await ctx.ui.select('选择 Agent 团队', Object.keys(RECOMMENDED_TEAMS))
      if (!selected) return
      teamName = selected
      task = await ctx.ui.input('输入任务描述', '分析当前项目代码') || '分析当前项目代码'
    }

    const teamTypes = RECOMMENDED_TEAMS[teamName as keyof typeof RECOMMENDED_TEAMS]
    if (!teamTypes) {
      ctx.ui.notify(`未知团队: ${teamName}。可用: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}`, 'warning')
      return
    }

    ctx.ui.notify(`正在初始化 ${teamName} 团队 (${teamTypes.length} 个 Agent)...`, 'info')
    teamTypes.forEach((type, index) => {
      ctx.ui.notify(`  [${index + 1}/${teamTypes.length}] ${type} 就绪`, 'info')
    })

    const result = await orch.executeTeamTask(teamTypes as AgentType[], task, { task }, 'parallel')
    const mgr = agent.getAgentManager()
    for (const item of result.results) mgr?.removeAgent(item.agentId)

    const lines = result.results.map(item => {
      const status = item.success ? '完成' : '失败'
      return `  ${status} ${item.agentId}: ${(item.output?.message || item.error || '').substring(0, 200)}`
    })
    ctx.ui.notify(`团队执行完成 (耗时 ${(result.metrics.duration / 1000).toFixed(1)}s):\n${lines.join('\n')}`, 'info')
  }

  pi.registerCommand('agents', {
    description: 'Agent 管理（用法: /agents、/agents run <team> [task]）',
    getArgumentCompletions: (prefix: string) => {
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
    handler: async (args, ctx: BumblebeeCommandContext) => {
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

      if (action === 'status' || action === 'list') await showAgentStatus(ctx)
      else if (action === 'run') await runAgentTeam(rest.join(' '), ctx)
      else ctx.ui.notify(`未知 Agent 操作: ${action}\n用法: /agents run <team> [task]`, 'warning')
    },
  })

  const showWorkflowStatus = async (ctx: BumblebeeCommandContext) => {
    const engine = agent.getWorkflowEngine()
    if (!engine) {
      ctx.ui.notify('工作流系统未启用', 'warning')
      return
    }
    const workflows = engine.getAllWorkflows()
    const templates = getWorkflowTemplateIds()
    const lines = workflows.map(item => `  ${item.id} - ${item.name} (${Object.keys(item.steps).length} 步骤)`)
    ctx.ui.notify(
      `工作流系统:\n  已注册: ${workflows.length}\n\n工作流列表:\n${lines.join('\n') || '  (空)'}\n\n可用模板: ${templates.join(', ')}`,
      'info',
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

  const runWorkflow = async (args: string, ctx: BumblebeeCommandContext) => {
    const engine = agent.getWorkflowEngine()
    if (!engine) {
      ctx.ui.notify('工作流系统未启用', 'warning')
      return
    }

    let { workflowId, payloadText } = parseWorkflowRunArgs(args)
    if (!workflowId) {
      const workflows = engine.getAllWorkflows()
      if (workflows.length === 0) {
        ctx.ui.notify('没有已注册的工作流', 'warning')
        return
      }
      const selected = await ctx.ui.select('选择工作流', workflows.map(item => `${item.id}: ${item.name} (${Object.keys(item.steps).length} 步骤)`))
      if (!selected) return
      workflowId = selected.split(':')[0].trim()
    }

    const workflow = engine.getWorkflow(workflowId)
    if (!workflow) {
      ctx.ui.notify(`工作流不存在: ${workflowId}`, 'error')
      return
    }

    if (!payloadText) {
      payloadText = await ctx.ui.input('输入工作流 payload JSON（留空使用示例）', getWorkflowPayloadExample(workflowId)) || getWorkflowPayloadExample(workflowId)
    }

    let payload: Record<string, unknown>
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
      const stepLines = Object.entries(result.steps)
        .map(([id, step]) => {
          const resultStep = step as StepResult
          const suffix = resultStep.error ? ` (${resultStep.error})` : ''
          return `  ${id}: ${resultStep.status}${suffix}`
        })
        .join('\n')
      ctx.ui.notify(`工作流执行完成 [${result.status}]:\n${stepLines}`, result.status === 'completed' ? 'info' : 'warning')
    } catch (error) {
      ctx.ui.notify(`工作流执行失败: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  pi.registerCommand('workflows', {
    description: '工作流管理（用法: /workflows、/workflows run <workflowId> [payload JSON]）',
    getArgumentCompletions: (prefix: string) => {
      const actions = ['status', 'run']
      const trimmed = prefix.trimStart()
      if (trimmed.startsWith('run ')) {
        const workflowPrefix = trimmed.slice(4).trimStart()
        const engine = agent.getWorkflowEngine()
        if (!engine) return []
        return engine.getAllWorkflows()
          .filter(item => item.id.startsWith(workflowPrefix))
          .map(item => ({ value: `run ${item.id}`, label: item.name }))
      }
      return actions
        .filter(action => action.startsWith(trimmed))
        .map(action => ({ value: action, label: `workflows ${action}` }))
    },
    handler: async (args, ctx: BumblebeeCommandContext) => {
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

      if (action === 'status' || action === 'list') await showWorkflowStatus(ctx)
      else if (action === 'run') await runWorkflow(rest.join(' '), ctx)
      else ctx.ui.notify(`未知工作流操作: ${action}\n用法: /workflows run <workflowId>`, 'warning')
    },
  })
}

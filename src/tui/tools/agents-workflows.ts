import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { RECOMMENDED_TEAMS } from '../../agents/specialized.js'
import { getWorkflowTemplateIds } from '../../workflows/templates.js'
import type { CollaborationMode } from '../../agents/types.js'
import type { StepResult } from '../../workflows/types.js'
import type { BumblebeeExtensionRuntime } from '../context.js'

const COLLABORATION_MODES = new Set(['independent', 'sequential', 'parallel', 'hierarchical'])

function toolDetails(details: Record<string, unknown>): Record<string, unknown> {
  return details
}

export function registerAgentWorkflowTools(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerTool(defineTool({
    name: 'list_agents',
    label: 'List Agents',
    description: '列出所有已注册的 Agent 及其状态',
    parameters: Type.Object({}),
    async execute() {
      const mgr = agent.getAgentManager()
      if (!mgr) return { content: [{ type: 'text' as const, text: 'Agent 系统未启用' }], details: toolDetails({ enabled: false, stats: null }) }
      const agents = mgr.getAllAgents()
      const stats = mgr.getStats()
      const lines = agents.map(item => `  ${item.id} [${item.status}] - ${item.role.name}`)
      return {
        content: [{ type: 'text' as const, text: `Agent 列表 (${stats.total} 个):\n${lines.join('\n') || '  (空)'}` }],
        details: toolDetails({ enabled: true, stats }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'execute_agent_task',
    label: 'Execute Agent Task',
    description: '在指定 Agent 上执行任务',
    parameters: Type.Object({
      agentId: Type.String({ description: 'Agent ID' }),
      description: Type.String({ description: '任务描述' }),
      input: Type.String({ description: '任务输入' }),
    }),
    async execute(_toolCallId, params) {
      const mgr = agent.getAgentManager()
      if (!mgr) return { content: [{ type: 'text' as const, text: 'Agent 系统未启用' }], details: toolDetails({ enabled: false, success: null, agentId: null }) }
      const result = await mgr.executeTask({
        id: `task-${Date.now()}`,
        agentId: params.agentId,
        type: 'general',
        description: params.description,
        input: params.input,
        priority: 'medium',
      })
      return {
        content: [{ type: 'text' as const, text: `任务完成 [${result.success ? '成功' : '失败'}]:\n${result.output?.message || result.error || ''}` }],
        details: toolDetails({ enabled: true, success: result.success, agentId: result.agentId }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'orchestrate_agents',
    label: 'Orchestrate Agents',
    description: '使用多 Agent 编排执行任务',
    parameters: Type.Object({
      team: Type.String({ description: '团队类型，如 code-review, testing, development, quality, full' }),
      task: Type.String({ description: '任务描述' }),
      mode: Type.Optional(Type.String({ description: '协作模式: independent, sequential, parallel, hierarchical' })),
    }),
    async execute(_toolCallId, params) {
      const orch = agent.getAgentOrchestrator()
      if (!orch) return { content: [{ type: 'text' as const, text: 'Agent 编排系统未启用' }], details: toolDetails({ enabled: false, error: null, duration: null, agentCount: null }) }
      const teamTypes = RECOMMENDED_TEAMS[params.team as keyof typeof RECOMMENDED_TEAMS]
      if (!teamTypes) {
        return { content: [{ type: 'text' as const, text: `未知团队类型: ${params.team}。可用: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}` }], details: toolDetails({ enabled: true, error: 'unknown_team', duration: null, agentCount: null }) }
      }
      const mode = COLLABORATION_MODES.has(params.mode || '') ? params.mode as CollaborationMode : 'parallel'
      const result = await orch.executeTeamTask(teamTypes, params.task, { task: params.task }, mode)
      const mgr = agent.getAgentManager()
      for (const item of result.results) mgr?.removeAgent(item.agentId)
      return {
        content: [{ type: 'text' as const, text: `编排完成 (${result.metrics.duration}ms):\n${result.results.map(item => `  ${item.agentId}: ${(item.output?.message || item.error || '').substring(0, 200)}`).join('\n')}` }],
        details: toolDetails({ enabled: true, error: null, duration: result.metrics.duration, agentCount: result.metrics.agentCount }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'list_workflows',
    label: 'List Workflows',
    description: '列出所有已注册的工作流',
    parameters: Type.Object({}),
    async execute() {
      const engine = agent.getWorkflowEngine()
      if (!engine) return { content: [{ type: 'text' as const, text: '工作流系统未启用' }], details: toolDetails({ enabled: false, count: null, templates: null }) }
      const workflows = engine.getAllWorkflows()
      const templates = getWorkflowTemplateIds()
      const lines = workflows.map(item => `  ${item.id} - ${item.name}`)
      return {
        content: [{ type: 'text' as const, text: `已注册工作流 (${workflows.length} 个):\n${lines.join('\n') || '  (空)'}\n\n可用模板: ${templates.join(', ')}` }],
        details: toolDetails({ enabled: true, count: workflows.length, templates }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'trigger_workflow',
    label: 'Trigger Workflow',
    description: '触发执行一个工作流',
    parameters: Type.Object({
      workflowId: Type.String({ description: '工作流 ID' }),
      payload: Type.Optional(Type.String({ description: '工作流 payload JSON 对象字符串' })),
    }),
    async execute(_toolCallId, params) {
      const engine = agent.getWorkflowEngine()
      if (!engine) return { content: [{ type: 'text' as const, text: '工作流系统未启用' }], details: toolDetails({ enabled: false, workflowId: null, status: null, duration: null }) }
      let payload: Record<string, unknown> = {}
      if (params.payload?.trim()) {
        try {
          const parsed = JSON.parse(params.payload)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { content: [{ type: 'text' as const, text: '工作流 payload 必须是 JSON 对象' }], details: toolDetails({ enabled: true, workflowId: params.workflowId, status: 'invalid-payload', duration: null }), isError: true }
          }
          payload = parsed as Record<string, unknown>
        } catch (error) {
          return { content: [{ type: 'text' as const, text: `工作流 payload 解析失败: ${error instanceof Error ? error.message : String(error)}` }], details: toolDetails({ enabled: true, workflowId: params.workflowId, status: 'invalid-payload', duration: null }), isError: true }
        }
      }
      const result = await engine.trigger(params.workflowId, payload)
      const stepLines = Object.entries(result.steps)
        .map(([id, step]) => `  ${id}: ${(step as StepResult).status}`)
        .join('\n')
      return {
        content: [{ type: 'text' as const, text: `工作流执行完成 [${result.status}]:\n${stepLines}` }],
        details: toolDetails({ enabled: true, workflowId: result.workflowId, status: result.status, duration: result.duration }),
      }
    },
  }))
}

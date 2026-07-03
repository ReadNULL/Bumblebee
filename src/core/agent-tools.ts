import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { RECOMMENDED_TEAMS, type AgentType } from '../agents/specialized.js'
import type { CollaborationMode } from '../agents/types.js'
import type { BumblebeeAgent } from './agent.js'

const COLLABORATION_MODES = new Set<CollaborationMode>([
  'independent',
  'sequential',
  'parallel',
  'hierarchical',
])

export function createBumblebeeAgentTools(agent: BumblebeeAgent) {
  return [
    defineTool({
      name: 'list_workflows',
      label: 'List Workflows',
      description: '列出 Bumblebee 已注册的工作流',
      parameters: Type.Object({}),
      async execute() {
        const workflows = agent.getWorkflowEngine()?.getAllWorkflows() ?? []
        return toolResult(
          workflows.length > 0
            ? workflows.map(workflow => `${workflow.id}: ${workflow.name}`).join('\n')
            : '没有已注册的工作流',
          { count: workflows.length },
        )
      },
    }),
    defineTool({
      name: 'trigger_workflow',
      label: 'Trigger Workflow',
      description: '触发 Bumblebee 工作流；payload 是 JSON 对象字符串',
      parameters: Type.Object({
        workflowId: Type.String({ description: '工作流 ID' }),
        payload: Type.Optional(Type.String({ description: 'JSON 对象字符串' })),
      }),
      async execute(_toolCallId, params) {
        const engine = agent.getWorkflowEngine()
        if (!engine) return toolResult('工作流系统未启用', { enabled: false }, true)

        let payload: Record<string, unknown> = {}
        if (params.payload?.trim()) {
          try {
            const parsed = JSON.parse(params.payload)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return toolResult('工作流 payload 必须是 JSON 对象', { enabled: true }, true)
            }
            payload = parsed as Record<string, unknown>
          } catch (error) {
            return toolResult(
              `工作流 payload 解析失败: ${error instanceof Error ? error.message : String(error)}`,
              { enabled: true },
              true,
            )
          }
        }

        const result = await engine.trigger(params.workflowId, payload)
        const steps = Object.values(result.steps).map(step => `${step.stepId}: ${step.status}`).join('\n')
        return toolResult(
          `工作流 ${result.workflowId} 执行结果: ${result.status}\n${steps}`,
          { workflowId: result.workflowId, status: result.status, duration: result.duration },
          result.status !== 'completed',
        )
      },
    }),
    defineTool({
      name: 'orchestrate_agents',
      label: 'Orchestrate Agents',
      description: '运行 Bumblebee 推荐的多 Agent 团队',
      parameters: Type.Object({
        team: Type.String({ description: 'code-review, testing, development, quality 或 full' }),
        task: Type.String({ description: '任务描述' }),
        mode: Type.Optional(Type.String({ description: 'parallel, sequential, independent 或 hierarchical' })),
      }),
      async execute(_toolCallId, params) {
        const orchestrator = agent.getAgentOrchestrator()
        if (!orchestrator) return toolResult('Agent 编排系统未启用', { enabled: false }, true)
        const team = RECOMMENDED_TEAMS[params.team as keyof typeof RECOMMENDED_TEAMS]
        if (!team) {
          return toolResult(
            `未知团队: ${params.team}。可用团队: ${Object.keys(RECOMMENDED_TEAMS).join(', ')}`,
            { enabled: true },
            true,
          )
        }
        const requestedMode = params.mode as CollaborationMode | undefined
        const mode = requestedMode && COLLABORATION_MODES.has(requestedMode) ? requestedMode : 'parallel'
        const result = await orchestrator.executeTeamTask(team as AgentType[], params.task, { task: params.task }, mode)
        const manager = agent.getAgentManager()
        for (const item of result.results) manager?.removeAgent(item.agentId)
        return toolResult(
          result.results.map(item => `${item.agentId}: ${item.success ? '成功' : item.error || '失败'}`).join('\n'),
          { success: result.success, duration: result.metrics.duration, agentCount: result.metrics.agentCount },
          !result.success,
        )
      },
    }),
  ]
}

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    isError,
  }
}

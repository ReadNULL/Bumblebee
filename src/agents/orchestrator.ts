/**
 * Agent 编排器
 *
 * 负责多 Agent 协作的任务分发和结果聚合
 */

import { AgentManager } from './manager.js'
import {
  AgentConfig,
  AgentInstance,
  AgentTask,
  AgentResult,
  CollaborationMode,
  OrchestrationConfig
} from './types.js'
import { getSpecializedAgentConfig, AgentType, createAgentTeam } from './specialized.js'

// 编排结果
export interface OrchestrationResult {
  success: boolean
  results: AgentResult[]
  aggregated?: unknown
  metrics: {
    startTime: Date
    endTime: Date
    duration: number
    agentCount: number
    taskCount: number
  }
}

// 结果聚合器类型
export type ResultAggregator = (results: AgentResult[]) => unknown

// 预定义的聚合策略
const AGGREGATION_STRATEGIES: Record<string, ResultAggregator> = {
  // 合并所有结果
  merge: (results) => {
    return results.reduce((acc, result) => {
      if (result.success && result.output) {
        return { ...acc, ...result.output }
      }
      return acc
    }, {})
  },

  // 投票（取多数结果）
  vote: (results) => {
    const successCount = results.filter(r => r.success).length
    return {
      decision: successCount > results.length / 2 ? 'approve' : 'reject',
      votes: { approve: successCount, reject: results.length - successCount },
      details: results.map(r => ({
        agentId: r.agentId,
        success: r.success,
        output: r.output
      }))
    }
  },

  // 优先级（取第一个成功结果）
  priority: (results) => {
    const firstSuccess = results.find(r => r.success)
    return firstSuccess?.output || null
  },

  // 聚合所有输出为列表
  list: (results) => {
    return results.map(r => ({
      agentId: r.agentId,
      success: r.success,
      output: r.output,
      error: r.error
    }))
  }
}

export class AgentOrchestrator {
  private manager: AgentManager
  private customAggregators: Map<string, ResultAggregator> = new Map()

  constructor(manager: AgentManager) {
    this.manager = manager

    // 注册预定义的聚合策略
    for (const [name, aggregator] of Object.entries(AGGREGATION_STRATEGIES)) {
      this.customAggregators.set(name, aggregator)
    }
  }

  // 注册自定义聚合策略
  registerAggregator(name: string, aggregator: ResultAggregator): void {
    this.customAggregators.set(name, aggregator)
  }

  // 执行编排任务
  async orchestrate(config: OrchestrationConfig): Promise<OrchestrationResult> {
    const startTime = new Date()

    // 注册所有 Agent
    const agents: AgentInstance[] = []
    for (const agentConfig of config.agents) {
      const agent = await this.manager.registerAgent(agentConfig)
      agents.push(agent)
    }

    // 根据协作模式执行任务
    let results: AgentResult[]
    switch (config.mode) {
      case 'independent':
        results = await this.executeIndependent(config.tasks)
        break
      case 'sequential':
        results = await this.executeSequential(config.tasks)
        break
      case 'parallel':
        results = await this.executeParallel(config.tasks)
        break
      case 'hierarchical':
        results = await this.executeHierarchical(config.tasks, agents)
        break
      default:
        throw new Error(`不支持的协作模式: ${config.mode}`)
    }

    // 聚合结果
    const aggregated = this.aggregateResults(results, config.aggregation)

    const endTime = new Date()

    return {
      success: results.every(r => r.success),
      results,
      aggregated,
      metrics: {
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime(),
        agentCount: agents.length,
        taskCount: config.tasks.length
      }
    }
  }

  // 独立执行（每个任务独立运行）
  private async executeIndependent(tasks: AgentTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = []

    for (const task of tasks) {
      try {
        const result = await this.manager.executeTask(task)
        results.push(result)
      } catch (error) {
        results.push({
          taskId: task.id,
          agentId: task.agentId,
          success: false,
          output: null,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    return results
  }

  // 顺序执行（任务按顺序执行，前一个结果作为后一个的上下文）
  private async executeSequential(tasks: AgentTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = []
    let previousContext: Record<string, any> = {}

    for (const task of tasks) {
      // 将前一个任务的结果作为上下文
      const enrichedTask: AgentTask = {
        ...task,
        context: {
          ...task.context,
          previousResults: previousContext
        }
      }

      try {
        const result = await this.manager.executeTask(enrichedTask)
        results.push(result)

        // 更新上下文
        if (result.success) {
          previousContext[task.id] = result.output
        }
      } catch (error) {
        results.push({
          taskId: task.id,
          agentId: task.agentId,
          success: false,
          output: null,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    return results
  }

  // 并行执行（所有任务同时执行）
  private async executeParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
    return this.manager.executeTasksParallel(tasks)
  }

  // 层级执行（主从模式，主 Agent 分配任务给从 Agent）
  private async executeHierarchical(
    tasks: AgentTask[],
    agents: AgentInstance[]
  ): Promise<AgentResult[]> {
    // 找到主 Agent（第一个标记为 master 的，或第一个 agent）
    const masterAgent = agents.find(a =>
      a.config.metadata?.tags?.includes('master')
    ) || agents[0]

    if (!masterAgent) {
      throw new Error('没有可用的主 Agent')
    }

    const results: AgentResult[] = []

    // 主 Agent 分析任务并分配
    const analysisTask: AgentTask = {
      id: 'master-analysis',
      agentId: masterAgent.id,
      type: 'analysis',
      description: '分析任务并制定分配计划',
      input: { tasks },
      priority: 'high'
    }

    const analysisResult = await this.manager.executeTask(analysisTask)
    results.push(analysisResult)

    // 根据分析结果执行任务
    if (analysisResult.success) {
      // 并行执行所有子任务
      const subResults = await this.executeParallel(tasks)
      results.push(...subResults)

      // 主 Agent 汇总结果
      const summaryTask: AgentTask = {
        id: 'master-summary',
        agentId: masterAgent.id,
        type: 'summary',
        description: '汇总所有任务结果',
        input: { results: subResults },
        priority: 'high'
      }

      const summaryResult = await this.manager.executeTask(summaryTask)
      results.push(summaryResult)
    }

    return results
  }

  // 聚合结果
  private aggregateResults(results: AgentResult[], strategy?: string): unknown {
    if (!strategy || strategy === 'none') {
      return null
    }

    const aggregator = this.customAggregators.get(strategy)
    if (!aggregator) {
      console.warn(`未找到聚合策略: ${strategy}`)
      return null
    }

    return aggregator(results)
  }

  // 快速创建并执行团队任务
  async executeTeamTask(
    teamType: AgentType[],
    taskDescription: string,
    taskInput: Record<string, unknown>,
    mode: CollaborationMode = 'parallel',
    aggregation: 'merge' | 'vote' | 'priority' | 'list' | 'custom' = 'list'
  ): Promise<OrchestrationResult> {
    const agents = createAgentTeam(teamType)

    const tasks: AgentTask[] = agents.map((agent, index) => ({
      id: `task-${index}`,
      agentId: agent.id,
      type: 'general',
      description: taskDescription,
      input: taskInput,
      priority: 'medium' as const
    }))

    return this.orchestrate({
      mode,
      agents,
      tasks,
      aggregation
    })
  }
}

/**
 * 工作流引擎
 *
 * 负责工作流的执行和管理
 */

import { AgentManager } from '../agents/manager.js'
import { AgentOrchestrator } from '../agents/orchestrator.js'
import { getSpecializedAgentConfig, getSpecializedAgentTypes } from '../agents/specialized.js'
import type { AgentConfig } from '../agents/types.js'
import {
  Workflow,
  WorkflowStep,
  WorkflowContext,
  WorkflowResult,
  WorkflowStatus,
  StepResult,
  StepStatus,
  StepCondition,
  WorkflowEvent,
  WorkflowEventHandler,
  ErrorHandling
} from './types.js'

// 生成唯一 ID
function generateId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

export class WorkflowEngine {
  private agentManager: AgentManager
  private orchestrator: AgentOrchestrator
  private workflows: Map<string, Workflow> = new Map()
  private executions: Map<string, WorkflowContext> = new Map()
  private eventHandlers: WorkflowEventHandler[] = []

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager
    this.orchestrator = new AgentOrchestrator(agentManager)
  }

  private resolveWorkflowAgentConfig(agentConfig: AgentConfig): AgentConfig {
    const specializedTypes = getSpecializedAgentTypes()
    if (specializedTypes.includes(agentConfig.id as any)) {
      const specializedConfig = getSpecializedAgentConfig(agentConfig.id as any, agentConfig.id)
      return {
        ...specializedConfig,
        ...agentConfig,
        role: agentConfig.role?.roleConfig ? agentConfig.role : specializedConfig.role,
      }
    }
    return agentConfig
  }

  // ========== 工作流管理 ==========

  // 注册工作流
  register(workflow: Workflow): void {
    this.validateWorkflow(workflow)
    this.workflows.set(workflow.id, workflow)
  }

  // 注销工作流
  unregister(workflowId: string): boolean {
    return this.workflows.delete(workflowId)
  }

  // 获取工作流
  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId)
  }

  // 获取所有工作流
  getAllWorkflows(): Workflow[] {
    return Array.from(this.workflows.values())
  }

  // ========== 工作流执行 ==========

  // 触发执行
  async trigger(workflowId: string, payload?: Record<string, unknown>): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(`工作流不存在: ${workflowId}`)
    }

    const executionId = generateId()
    const context: WorkflowContext = {
      workflowId,
      executionId,
      trigger: {
        type: workflow.trigger.type,
        payload
      },
      steps: {},
      variables: payload || {},
      startTime: new Date()
    }

    this.executions.set(executionId, context)
    this.emitEvent({ type: 'started', workflowId, executionId })

    try {
      const result = await this.executeWorkflow(workflow, context)
      this.executions.delete(executionId)
      return result
    } catch (error) {
      this.executions.delete(executionId)
      throw error
    }
  }

  // 获取执行状态
  getExecution(executionId: string): WorkflowContext | undefined {
    return this.executions.get(executionId)
  }

  // ========== 事件处理 ==========

  // 注册事件处理器
  onEvent(handler: WorkflowEventHandler): void {
    this.eventHandlers.push(handler)
  }

  // 触发事件
  private emitEvent(event: WorkflowEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('事件处理器错误:', error)
      }
    }
  }

  // ========== 工作流执行逻辑 ==========

  // 执行工作流
  private async executeWorkflow(workflow: Workflow, context: WorkflowContext): Promise<WorkflowResult> {
    const startTime = new Date()
    const temporaryAgentIds: string[] = []

    try {
      for (const agentConfig of workflow.agents || []) {
        if (!this.agentManager.getAgent(agentConfig.id)) {
          await this.agentManager.registerAgent(this.resolveWorkflowAgentConfig(agentConfig))
          temporaryAgentIds.push(agentConfig.id)
        }
      }

      // 构建步骤依赖图
      const stepGraph = this.buildStepGraph(workflow.steps)

      // 按拓扑顺序执行步骤
      const executedSteps = new Set<string>()
      const stepResults: Record<string, StepResult> = {}

      // 执行所有步骤
      for (const step of workflow.steps) {
        await this.executeStepWithDependencies(step, workflow, context, stepGraph, executedSteps, stepResults)
      }

      const endTime = new Date()
      const status: WorkflowStatus = Object.values(stepResults).some(r => r.status === 'failed')
        ? 'failed'
        : 'completed'

      const result: WorkflowResult = {
        workflowId: workflow.id,
        executionId: context.executionId,
        status,
        steps: stepResults,
        output: this.collectOutput(workflow, stepResults),
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime()
      }

      if (status === 'completed') {
        this.emitEvent({
          type: 'completed',
          workflowId: workflow.id,
          executionId: context.executionId,
          result
        })
      } else {
        this.emitEvent({
          type: 'failed',
          workflowId: workflow.id,
          executionId: context.executionId,
          error: '工作流执行失败'
        })
      }

      return result
    } finally {
      for (const agentId of temporaryAgentIds) {
        this.agentManager.removeAgent(agentId)
      }
    }
  }

  // 执行步骤及其依赖
  private async executeStepWithDependencies(
    step: WorkflowStep,
    workflow: Workflow,
    context: WorkflowContext,
    stepGraph: Map<string, string[]>,
    executedSteps: Set<string>,
    stepResults: Record<string, StepResult>
  ): Promise<void> {
    // 如果已执行，跳过
    if (executedSteps.has(step.id)) {
      return
    }

    // 先执行依赖步骤
    const dependencies = step.dependsOn || []
    for (const depId of dependencies) {
      const depStep = workflow.steps.find(s => s.id === depId)
      if (depStep && !executedSteps.has(depId)) {
        await this.executeStepWithDependencies(depStep, workflow, context, stepGraph, executedSteps, stepResults)
      }
    }

    // 检查依赖是否都成功
    const depsFailed = dependencies.some(depId => {
      const result = stepResults[depId]
      return result && result.status === 'failed'
    })

    if (depsFailed) {
      stepResults[step.id] = {
        stepId: step.id,
        status: 'skipped',
        startTime: new Date(),
        endTime: new Date(),
        duration: 0
      }
      executedSteps.add(step.id)
      return
    }

    // 执行当前步骤
    const result = await this.executeStep(step, context, stepResults)
    stepResults[step.id] = result
    executedSteps.add(step.id)
    context.steps[step.id] = result
  }

  // 执行单个步骤
  private async executeStep(
    step: WorkflowStep,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>
  ): Promise<StepResult> {
    const startTime = new Date()
    context.currentStepId = step.id

    this.emitEvent({
      type: 'step-started',
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: step.id
    })

    // 检查条件
    if (step.condition && !this.evaluateCondition(step.condition, context, stepResults)) {
      return {
        stepId: step.id,
        status: 'skipped',
        startTime,
        endTime: new Date(),
        duration: 0
      }
    }

    // 准备输入
    const input = this.prepareInput(step.input, context, stepResults)

    // 执行步骤（支持重试）
    const maxAttempts = step.retry?.maxAttempts || 1
    const retryDelay = step.retry?.delay || 0
    let lastError: string | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 设置超时
        const timeout = step.timeout || 30000
        const output = await Promise.race([
          this.executeStepAction(step, input),
          this.createTimeout(timeout)
        ])

        const endTime = new Date()

        this.emitEvent({
          type: 'step-completed',
          workflowId: context.workflowId,
          executionId: context.executionId,
          stepId: step.id,
          result: { stepId: step.id, status: 'completed', output, startTime, endTime, duration: endTime.getTime() - startTime.getTime(), attempts: attempt }
        })

        return {
          stepId: step.id,
          status: 'completed',
          output,
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime(),
          attempts: attempt
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'

        if (attempt < maxAttempts) {
          // 等待重试
          const delay = step.retry?.backoff === 'exponential'
            ? retryDelay * Math.pow(2, attempt - 1)
            : retryDelay
          await this.sleep(delay)
        }
      }
    }

    // 所有重试都失败
    const endTime = new Date()

    this.emitEvent({
      type: 'step-failed',
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: step.id,
      error: lastError || 'Unknown error'
    })

    // 处理错误策略
    if (step.onError === 'skip' || step.onError === 'fallback') {
      return {
        stepId: step.id,
        status: step.onError === 'fallback' ? 'failed' : 'skipped',
        error: lastError,
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime(),
        attempts: maxAttempts
      }
    }

    return {
      stepId: step.id,
      status: 'failed',
      error: lastError,
      startTime,
      endTime,
      duration: endTime.getTime() - startTime.getTime(),
      attempts: maxAttempts
    }
  }

  // 执行步骤动作
  private async executeStepAction(step: WorkflowStep, input: Record<string, unknown>): Promise<unknown> {
    // 根据 agentId 或 agentType 找到 Agent
    const agentId = step.agentId || step.agentType
    if (!agentId) {
      return this.executeSystemStepAction(step, input)
    }

    // 创建任务
    const task = {
      id: `${step.id}-task`,
      agentId,
      type: step.action,
      description: step.description || step.name,
      input,
      priority: 'medium' as const
    }

    // 执行任务
    const result = await this.agentManager.executeTask(task)

    if (!result.success) {
      throw new Error(result.error || '任务执行失败')
    }

    return result.output
  }

  private async executeSystemStepAction(step: WorkflowStep, input: Record<string, unknown>): Promise<unknown> {
    const baseOutput = {
      action: step.action,
      input,
      message: `${step.name} 已完成`,
      generatedAt: new Date().toISOString(),
    }

    switch (step.action) {
      case 'fetch':
        return {
          ...baseOutput,
          prId: input.prId,
          repo: input.repo,
          files: Array.isArray(input.files) ? input.files : [],
        }
      case 'generate':
      case 'report':
        return {
          ...baseOutput,
          title: input.title || step.name,
          summary: Object.keys(input).length > 0 ? JSON.stringify(input) : step.name,
        }
      case 'classify':
        return {
          ...baseOutput,
          category: 'general',
          priority: 'medium',
        }
      case 'assign':
        return {
          ...baseOutput,
          assignee: 'unassigned',
        }
      case 'build':
        return {
          ...baseOutput,
          success: true,
          artifact: `${input.version || 'current'}-build`,
        }
      case 'publish':
        return {
          ...baseOutput,
          published: true,
        }
      default:
        return baseOutput
    }
  }

  // ========== 辅助方法 ==========

  // 构建步骤依赖图
  private buildStepGraph(steps: WorkflowStep[]): Map<string, string[]> {
    const graph = new Map<string, string[]>()

    for (const step of steps) {
      graph.set(step.id, step.dependsOn || [])
    }

    return graph
  }

  // 评估条件
  private evaluateCondition(
    condition: StepCondition,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>
  ): boolean {
    // 基于上下文的条件
    if (condition.context) {
      const { key, operator, value } = condition.context
      const actualValue = this.getNestedValue(context.variables, key)

      switch (operator) {
        case 'eq': return actualValue === value
        case 'neq': return actualValue !== value
        case 'gt': return Number(actualValue) > Number(value)
        case 'lt': return Number(actualValue) < Number(value)
        case 'gte': return Number(actualValue) >= Number(value)
        case 'lte': return Number(actualValue) <= Number(value)
        case 'contains': return String(actualValue).includes(String(value))
        case 'exists': return actualValue !== undefined && actualValue !== null
        default: return true
      }
    }

    return true
  }

  // 准备输入
  private prepareInput(
    input: WorkflowStep['input'],
    context: WorkflowContext,
    stepResults: Record<string, StepResult>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    // 静态值
    if (input.static) {
      Object.assign(result, input.static)
    }

    // 从上下文获取
    if (input.fromContext) {
      for (const [localKey, contextPath] of Object.entries(input.fromContext)) {
        result[localKey] = this.getNestedValue(context.variables, contextPath)
      }
    }

    // 从其他步骤输出获取
    if (input.fromSteps) {
      for (const [localKey, path] of Object.entries(input.fromSteps)) {
        const [stepId, ...rest] = path.split('.')
        const stepResult = stepResults[stepId]
        if (stepResult?.output) {
          result[localKey] = rest.length > 0
            ? this.getNestedValue(stepResult.output, rest.join('.'))
            : stepResult.output
        }
      }
    }

    // 模板
    if (input.template) {
      for (const [key, template] of Object.entries(input.template)) {
        result[key] = this.interpolate(template, { context, steps: stepResults })
      }
    }

    return result
  }

  // 收集输出
  private collectOutput(workflow: Workflow, stepResults: Record<string, StepResult>): Record<string, unknown> {
    // 收集所有步骤的输出
    const output: Record<string, unknown> = {}

    for (const step of workflow.steps) {
      if (step.output && stepResults[step.id]?.output) {
        output[step.output] = stepResults[step.id].output
      }
    }

    return output
  }

  // 获取嵌套值
  private getNestedValue(obj: unknown, path: string): unknown {
    return path.split('.').reduce((current: unknown, key) => {
      if (current === null || current === undefined) return undefined
      return (current as Record<string, unknown>)[key]
    }, obj)
  }

  // 插值
  private interpolate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const value = this.getNestedValue(data, path)
      return value !== undefined ? String(value) : ''
    })
  }

  // 创建超时 Promise
  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`步骤执行超时: ${ms}ms`)), ms)
    })
  }

  // 睡眠
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // 验证工作流
  private validateWorkflow(workflow: Workflow): void {
    if (!workflow.id) {
      throw new Error('工作流必须有 ID')
    }

    if (!workflow.name) {
      throw new Error('工作流必须有名称')
    }

    if (!workflow.trigger) {
      throw new Error('工作流必须有触发器')
    }

    if (!workflow.steps || workflow.steps.length === 0) {
      throw new Error('工作流必须有至少一个步骤')
    }

    // 验证步骤 ID 唯一性
    const stepIds = new Set<string>()
    for (const step of workflow.steps) {
      if (stepIds.has(step.id)) {
        throw new Error(`步骤 ID 重复: ${step.id}`)
      }
      stepIds.add(step.id)
    }

    // 验证依赖关系
    for (const step of workflow.steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (!stepIds.has(depId)) {
            throw new Error(`步骤 ${step.id} 依赖不存在的步骤: ${depId}`)
          }
        }
      }
    }
  }
}

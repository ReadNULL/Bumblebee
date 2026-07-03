import { AgentManager } from '../agents/manager.js'
import { getSpecializedAgentConfig, getSpecializedAgentTypes } from '../agents/specialized.js'
import type { AgentConfig } from '../agents/types.js'
import {
  Workflow,
  WorkflowStep,
  WorkflowContext,
  WorkflowResult,
  WorkflowStatus,
  StepResult,
  StepCondition,
  WorkflowEvent,
  WorkflowEventHandler,
  WorkflowActionHandler,
  StepFailureStrategy,
} from './types.js'

function generateId(): string {
  return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

interface CompensationEntry {
  stepId: string
  compensateAction?: string
}

export interface WorkflowEngineOptions {
  defaultTimeout?: number
  maxConcurrent?: number
}

export class WorkflowEngine {
  private workflows: Map<string, Workflow> = new Map()
  private executions: Map<string, WorkflowContext> = new Map()
  private eventHandlers: WorkflowEventHandler[] = []
  private actionHandlers: Map<string, WorkflowActionHandler> = new Map()

  constructor(
    private readonly agentManager: AgentManager,
    private readonly options: WorkflowEngineOptions = {},
  ) {
    this.registerBuiltInActions()
  }

  register(workflow: Workflow): void {
    this.validateWorkflow(workflow)
    this.getExecutionLayers(workflow.steps)
    this.workflows.set(workflow.id, workflow)
  }

  unregister(workflowId: string): boolean {
    return this.workflows.delete(workflowId)
  }

  registerAction(action: string, handler: WorkflowActionHandler): void {
    this.actionHandlers.set(action, handler)
  }

  unregisterAction(action: string): boolean {
    return this.actionHandlers.delete(action)
  }

  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId)
  }

  getAllWorkflows(): Workflow[] {
    return Array.from(this.workflows.values())
  }

  async trigger(workflowId: string, payload?: Record<string, unknown>): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId)
    if (!workflow) {
      throw new Error(`工作流不存在: ${workflowId}`)
    }
    const maxConcurrent = Math.max(1, this.options.maxConcurrent ?? 3)
    if (this.executions.size >= maxConcurrent) {
      throw new Error(`工作流并发数已达到上限: ${maxConcurrent}`)
    }

    const executionId = generateId()
    const controller = new AbortController()
    const context: WorkflowContext = {
      workflowId,
      executionId,
      trigger: {
        type: workflow.trigger.type,
        payload,
      },
      steps: {},
      variables: payload || {},
      startTime: new Date(),
      signal: controller.signal,
    }

    let workflowTimer: NodeJS.Timeout | undefined
    const workflowTimeout = workflow.config?.timeout ?? this.options.defaultTimeout
    if (workflowTimeout) {
      workflowTimer = setTimeout(() => {
        controller.abort(new Error(`Workflow timed out after ${workflowTimeout}ms`))
      }, workflowTimeout)
    }

    this.executions.set(executionId, context)
    this.emitEvent({ type: 'started', workflowId, executionId })

    try {
      return await this.executeWorkflow(workflow, context, controller)
    } finally {
      if (workflowTimer) clearTimeout(workflowTimer)
      this.executions.delete(executionId)
    }
  }

  getExecution(executionId: string): WorkflowContext | undefined {
    return this.executions.get(executionId)
  }

  onEvent(handler: WorkflowEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: WorkflowEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('工作流事件处理器错误:', error)
      }
    }
  }

  private async executeWorkflow(
    workflow: Workflow,
    context: WorkflowContext,
    controller: AbortController,
  ): Promise<WorkflowResult> {
    const startTime = new Date()
    const temporaryAgentIds: string[] = []
    const stepResults: Record<string, StepResult> = {}
    const compensationStack: CompensationEntry[] = []
    const fallbackStepIds = new Set(workflow.steps.flatMap(step => step.fallbackStepId ? [step.fallbackStepId] : []))
    let workflowError: string | undefined

    try {
      for (const agentConfig of workflow.agents || []) {
        if (!this.agentManager.getAgent(agentConfig.id)) {
          await this.agentManager.registerAgent(this.resolveWorkflowAgentConfig(agentConfig))
          temporaryAgentIds.push(agentConfig.id)
        }
      }

      const layers = this.getExecutionLayers(workflow.steps)
      for (const layer of layers) {
        this.throwIfAborted(controller.signal)

        const runnable = layer.filter(step => {
          if (stepResults[step.id] || fallbackStepIds.has(step.id)) return false
          const depStatus = this.getDependencyStatus(step, stepResults)
          if (depStatus === 'blocked') {
            this.skipStep(step, stepResults, 'Skipped because a dependency did not complete successfully')
            return false
          }
          return true
        })
        if (runnable.length === 0) continue

        const settled = await Promise.allSettled(
          runnable.map(async step => {
            const result = await this.executeStep(step, context, stepResults, controller.signal)
            if (result.status === 'failed' && step.onError !== 'fallback') {
              const strategy = this.getFailureStrategy(step, workflow)
              if ((strategy === 'abort-workflow' || strategy === 'compensate') && !controller.signal.aborted) {
                controller.abort(new Error(result.error || `Step ${step.id} failed`))
              }
            }
            return result
          }),
        )

        for (let index = 0; index < runnable.length; index++) {
          const step = runnable[index]
          const result = settled[index]
          const stepResult = result.status === 'fulfilled'
            ? result.value
            : this.failedStep(step, result.reason)

          stepResults[step.id] = stepResult
          context.steps[step.id] = stepResult

          if (stepResult.status === 'completed') {
            compensationStack.push({ stepId: step.id, compensateAction: step.compensateAction })
            continue
          }

          if (stepResult.status === 'failed') {
            if (step.onError === 'fallback' && step.fallbackStepId) {
              const fallbackStep = workflow.steps.find(candidate => candidate.id === step.fallbackStepId)
              if (fallbackStep) {
                const fallbackResult = await this.executeStep(
                  fallbackStep,
                  context,
                  stepResults,
                  controller.signal,
                )
                stepResults[fallbackStep.id] = fallbackResult
                context.steps[fallbackStep.id] = fallbackResult
                if (fallbackResult.status === 'completed') {
                  stepResult.status = 'completed'
                  stepResult.output = fallbackResult.output
                  stepResult.error = undefined
                  compensationStack.push({
                    stepId: fallbackStep.id,
                    compensateAction: fallbackStep.compensateAction,
                  })
                  continue
                }
                stepResult.error = `${stepResult.error || 'Step failed'}; fallback ${fallbackStep.id} failed: ${fallbackResult.error || fallbackResult.status}`
              }
            }
            const strategy = this.getFailureStrategy(step, workflow)
            workflowError = stepResult.error || `Step ${step.id} failed`

            if (strategy === 'abort-workflow') {
              controller.abort(new Error(workflowError))
            } else if (strategy === 'compensate') {
              await this.compensate(compensationStack, stepResults, context)
              controller.abort(new Error(workflowError))
            }
          }
        }

        if (controller.signal.aborted) break
      }
    } catch (error) {
      workflowError = error instanceof Error ? error.message : String(error)
      if (!controller.signal.aborted) controller.abort(error)
    } finally {
      for (const agentId of temporaryAgentIds) {
        this.agentManager.removeAgent(agentId)
      }
    }

    if (controller.signal.aborted) {
      this.markUnstartedAsSkipped(workflow.steps, stepResults, 'Skipped because workflow was aborted')
    } else {
      this.markBlockedAsSkipped(workflow.steps, stepResults)
      this.markUnstartedAsSkipped(workflow.steps, stepResults, 'Fallback step was not required')
    }

    const endTime = new Date()
    const status: WorkflowStatus = Object.values(stepResults).some(result => result.status === 'failed')
      ? 'failed'
      : controller.signal.aborted
        ? 'cancelled'
        : 'completed'

    const result: WorkflowResult = {
      workflowId: workflow.id,
      executionId: context.executionId,
      status,
      steps: stepResults,
      output: this.collectOutput(workflow, stepResults),
      error: workflowError,
      startTime,
      endTime,
      duration: endTime.getTime() - startTime.getTime(),
    }

    if (status === 'completed') {
      this.emitEvent({ type: 'completed', workflowId: workflow.id, executionId: context.executionId, result })
    } else {
      this.emitEvent({
        type: 'failed',
        workflowId: workflow.id,
        executionId: context.executionId,
        error: workflowError || '工作流执行失败',
      })
    }

    return result
  }

  private async executeStep(
    step: WorkflowStep,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>,
    signal?: AbortSignal,
  ): Promise<StepResult> {
    const startTime = new Date()
    context.currentStepId = step.id
    this.throwIfAborted(signal)

    this.emitEvent({
      type: 'step-started',
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: step.id,
    })

    if (step.condition && !this.evaluateCondition(step.condition, context, stepResults)) {
      return {
        stepId: step.id,
        status: 'skipped',
        startTime,
        endTime: new Date(),
        duration: 0,
      }
    }

    const input = this.prepareInput(step.input, context, stepResults)
    const maxAttempts = Math.max(1, step.retry?.maxAttempts || 1)
    let lastError: string | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.throwIfAborted(signal)
      try {
        const timeout = step.timeout || 30000
        const output = await this.withTimeout(
          this.executeStepAction(step, input, context, stepResults, signal),
          timeout,
          signal,
        )

        const endTime = new Date()
        const result: StepResult = {
          stepId: step.id,
          status: 'completed',
          output,
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime(),
          attempts: attempt,
        }

        this.emitEvent({
          type: 'step-completed',
          workflowId: context.workflowId,
          executionId: context.executionId,
          stepId: step.id,
          result,
        })
        return result
      } catch (error) {
        if (isAbortError(error)) throw error
        lastError = error instanceof Error ? error.message : String(error)

        if (attempt < maxAttempts) {
          await this.interruptibleSleep(this.calculateRetryDelay(step, attempt), signal)
        }
      }
    }

    const endTime = new Date()
    this.emitEvent({
      type: 'step-failed',
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: step.id,
      error: lastError || 'Unknown error',
    })

    if (step.onError === 'skip') {
      return {
        stepId: step.id,
        status: 'skipped',
        error: lastError,
        startTime,
        endTime,
        duration: endTime.getTime() - startTime.getTime(),
        attempts: maxAttempts,
      }
    }

    return {
      stepId: step.id,
      status: 'failed',
      error: lastError,
      startTime,
      endTime,
      duration: endTime.getTime() - startTime.getTime(),
      attempts: maxAttempts,
    }
  }

  private async executeStepAction(
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const agentId = step.agentId || step.agentType
    if (!agentId) {
      return this.executeSystemStepAction(step, input, context, stepResults, signal)
    }

    const result = await this.agentManager.executeTask({
      id: `${step.id}-task`,
      agentId,
      type: step.action,
      description: step.description || step.name,
      input,
      priority: 'medium',
    })

    if (!result.success) {
      throw new Error(result.error || '任务执行失败')
    }

    return result.output
  }

  private async executeSystemStepAction(
    step: WorkflowStep,
    input: Record<string, unknown>,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const handler = this.actionHandlers.get(step.action)
    if (!handler) {
      throw new Error(`未注册工作流动作: ${step.action}`)
    }

    return handler(input, { step, workflowContext: context, stepResults, signal })
  }

  private async compensate(
    compensationStack: CompensationEntry[],
    stepResults: Record<string, StepResult>,
    context: WorkflowContext,
    signal?: AbortSignal,
  ): Promise<void> {
    while (compensationStack.length > 0) {
      const entry = compensationStack.pop()
      if (!entry?.compensateAction) continue

      const handler = this.actionHandlers.get(entry.compensateAction)
      if (!handler) {
        console.warn(`补偿动作未注册: ${entry.compensateAction}`)
        continue
      }

      await handler(
        { stepId: entry.stepId, result: stepResults[entry.stepId] },
        {
          step: {
            id: `${entry.stepId}:compensate`,
            name: `Compensate ${entry.stepId}`,
            action: entry.compensateAction,
            input: {},
          },
          workflowContext: context,
          stepResults,
          signal,
        },
      )
    }
  }

  private getExecutionLayers(steps: WorkflowStep[]): WorkflowStep[][] {
    const completed = new Set<string>()
    const layers: WorkflowStep[][] = []

    while (completed.size < steps.length) {
      const layer = steps.filter(step =>
        !completed.has(step.id) &&
        (step.dependsOn || []).every(depId => completed.has(depId)),
      )
      if (layer.length === 0) {
        throw new Error('工作流存在循环依赖或不可达步骤')
      }
      layers.push(layer)
      layer.forEach(step => completed.add(step.id))
    }

    return layers
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

  private getDependencyStatus(step: WorkflowStep, stepResults: Record<string, StepResult>): 'ready' | 'blocked' {
    const blocked = (step.dependsOn || []).some(depId => stepResults[depId]?.status !== 'completed')
    return blocked ? 'blocked' : 'ready'
  }

  private getFailureStrategy(step: WorkflowStep, workflow: Workflow): StepFailureStrategy {
    if (step.onFailure) return step.onFailure
    if (workflow.config?.onFailure) return workflow.config.onFailure
    if (step.onError === 'stop' || workflow.config?.errorHandling === 'stop') return 'abort-workflow'
    return 'skip-downstream'
  }

  private skipStep(step: WorkflowStep, stepResults: Record<string, StepResult>, reason: string): void {
    if (stepResults[step.id]) return
    stepResults[step.id] = {
      stepId: step.id,
      status: 'skipped',
      error: reason,
      startTime: new Date(),
      endTime: new Date(),
      duration: 0,
    }
  }

  private failedStep(step: WorkflowStep, error: unknown): StepResult {
    const now = new Date()
    return {
      stepId: step.id,
      status: isAbortError(error) ? 'skipped' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      startTime: now,
      endTime: now,
      duration: 0,
    }
  }

  private markBlockedAsSkipped(steps: WorkflowStep[], stepResults: Record<string, StepResult>): void {
    for (const step of steps) {
      if (stepResults[step.id]) continue
      if (this.getDependencyStatus(step, stepResults) === 'blocked') {
        this.skipStep(step, stepResults, 'Skipped because a dependency did not complete successfully')
      }
    }
  }

  private markUnstartedAsSkipped(steps: WorkflowStep[], stepResults: Record<string, StepResult>, reason: string): void {
    for (const step of steps) {
      this.skipStep(step, stepResults, reason)
    }
  }

  private calculateRetryDelay(step: WorkflowStep, attempt: number): number {
    const base = step.retry?.delay || 0
    if (base <= 0) return 0

    const withBackoff = step.retry?.backoff === 'exponential'
      ? Math.min(base * Math.pow(2, attempt - 1), step.retry.maxDelayMs ?? 30000)
      : base

    return step.retry?.jitter === false
      ? withBackoff
      : Math.round(withBackoff * (0.5 + Math.random()))
  }

  private async withTimeout<T>(operation: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let abortHandler: (() => void) | undefined
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`步骤执行超时: ${ms}ms`)), ms)
      abortHandler = () => reject(createAbortError(signal?.reason))
      signal?.addEventListener('abort', abortHandler, { once: true })
    })

    try {
      return await Promise.race([operation, guard])
    } finally {
      if (timer) clearTimeout(timer)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    }
  }

  private async interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return
    this.throwIfAborted(signal)

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(createAbortError())
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw createAbortError(signal.reason)
    }
  }

  private evaluateCondition(
    condition: StepCondition,
    context: WorkflowContext,
    stepResults: Record<string, StepResult>,
  ): boolean {
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

    if (condition.expression) {
      return this.evaluateExpression(condition.expression, {
        context: context.variables,
        steps: stepResults,
      })
    }

    return true
  }

  private evaluateExpression(expression: string, data: Record<string, unknown>): boolean {
    const match = expression.trim().match(/^([\w.-]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/)
    if (!match) {
      const value = this.getNestedValue(data, expression.trim())
      return Boolean(value)
    }

    const [, path, operator, literalText] = match
    const actual = this.getNestedValue(data, path)
    const expected = parseConditionLiteral(literalText)
    switch (operator) {
      case '===':
      case '==': return actual === expected
      case '!==':
      case '!=': return actual !== expected
      case '>': return Number(actual) > Number(expected)
      case '<': return Number(actual) < Number(expected)
      case '>=': return Number(actual) >= Number(expected)
      case '<=': return Number(actual) <= Number(expected)
      default: return false
    }
  }

  private prepareInput(
    input: WorkflowStep['input'],
    context: WorkflowContext,
    stepResults: Record<string, StepResult>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    if (input.static) {
      Object.assign(result, input.static)
    }

    if (input.fromContext) {
      for (const [localKey, contextPath] of Object.entries(input.fromContext)) {
        result[localKey] = this.getNestedValue(context.variables, contextPath)
      }
    }

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

    if (input.template) {
      for (const [key, template] of Object.entries(input.template)) {
        result[key] = this.interpolate(template, { context, steps: stepResults })
      }
    }

    return result
  }

  private collectOutput(workflow: Workflow, stepResults: Record<string, StepResult>): Record<string, unknown> {
    const output: Record<string, unknown> = {}

    for (const step of workflow.steps) {
      if (step.output && stepResults[step.id]?.output) {
        output[step.output] = stepResults[step.id].output
      }
    }

    return output
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    return path.split('.').reduce((current: unknown, key) => {
      if (current === null || current === undefined) return undefined
      return (current as Record<string, unknown>)[key]
    }, obj)
  }

  private interpolate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
      const value = this.getNestedValue(data, path)
      return value !== undefined ? String(value) : ''
    })
  }

  private validateWorkflow(workflow: Workflow): void {
    if (!workflow.id) throw new Error('工作流必须有 ID')
    if (!workflow.name) throw new Error('工作流必须有名称')
    if (!workflow.trigger) throw new Error('工作流必须有触发器')
    if (!workflow.steps || workflow.steps.length === 0) throw new Error('工作流必须有至少一个步骤')

    const stepIds = new Set<string>()
    for (const step of workflow.steps) {
      if (stepIds.has(step.id)) throw new Error(`步骤 ID 重复: ${step.id}`)
      stepIds.add(step.id)
    }

    for (const step of workflow.steps) {
      for (const depId of step.dependsOn || []) {
        if (!stepIds.has(depId)) {
          throw new Error(`步骤 ${step.id} 依赖不存在的步骤: ${depId}`)
        }
      }
      if (step.fallbackStepId && !stepIds.has(step.fallbackStepId)) {
        throw new Error(`步骤 ${step.id} 的 fallback 步骤不存在: ${step.fallbackStepId}`)
      }
    }
  }

  private registerBuiltInActions(): void {
    const baseOutput = (action: string, input: Record<string, unknown>, message: string) => ({
      action,
      input,
      message,
      generatedAt: new Date().toISOString(),
    })

    this.registerAction('fetch', (input, { step }) => ({
      ...baseOutput(step.action, input, `${step.name} 已完成`),
      prId: input.prId,
      repo: input.repo,
      files: Array.isArray(input.files) ? input.files : [],
    }))

    const reportHandler: WorkflowActionHandler = (input, { step }) => ({
      ...baseOutput(step.action, input, `${step.name} 已完成`),
      title: input.title || step.name,
      summary: Object.keys(input).length > 0 ? JSON.stringify(input) : step.name,
    })
    this.registerAction('generate', reportHandler)
    this.registerAction('report', reportHandler)

    const externalAction: WorkflowActionHandler = (_input, { step }) => {
      throw new Error(`工作流动作 ${step.action} 需要调用 registerAction() 配置外部执行器`)
    }
    this.registerAction('test', externalAction)
    this.registerAction('build', externalAction)
    this.registerAction('publish', externalAction)
  }
}

function parseConditionLiteral(value: string): unknown {
  const trimmed = value.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed.replace(/^(['"])(.*)\1$/, '$2')
  }
}

function createAbortError(reason?: unknown): Error {
  const error = reason instanceof Error ? reason : new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

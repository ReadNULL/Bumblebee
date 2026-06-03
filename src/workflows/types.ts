/**
 * 工作流类型定义
 *
 * 支持自动化工作流的定义和执行
 */

import { AgentConfig, AgentTask, AgentResult } from '../agents/types.js'

// 工作流状态
export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'

// 步骤状态
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

// 触发器类型
export type TriggerType = 'manual' | 'schedule' | 'event' | 'webhook'

// 触发器配置
export interface Trigger {
  type: TriggerType
  config?: {
    // schedule 类型
    cron?: string           // cron 表达式
    interval?: number       // 间隔（毫秒）

    // event 类型
    event?: string          // 事件名称
    source?: string         // 事件源

    // webhook 类型
    path?: string           // webhook 路径
    method?: string         // HTTP 方法
    secret?: string         // 验证密钥
  }
}

// 步骤重试配置
export interface RetryConfig {
  maxAttempts: number       // 最大重试次数
  delay: number             // 重试延迟（毫秒）
  backoff?: 'fixed' | 'exponential'  // 退避策略
}

// 错误处理策略
export type ErrorHandling = 'stop' | 'retry' | 'skip' | 'fallback'

// 工作流步骤
export interface WorkflowStep {
  id: string
  name: string
  description?: string

  // 执行配置
  agentId?: string          // 执行的 Agent ID
  agentType?: string        // 或使用 Agent 类型
  action: string            // 执行的动作

  // 输入输出
  input: StepInput          // 步骤输入
  output?: string           // 输出变量名

  // 条件执行
  condition?: StepCondition // 执行条件

  // 错误处理
  onError?: ErrorHandling
  retry?: RetryConfig
  fallbackStepId?: string   // 失败时的备选步骤

  // 超时
  timeout?: number          // 超时时间（毫秒）

  // 依赖
  dependsOn?: string[]      // 依赖的步骤 ID
}

// 步骤输入
export interface StepInput {
  // 静态值
  static?: Record<string, any>

  // 从上下文获取
  fromContext?: Record<string, string>  // { localKey: contextPath }

  // 从其他步骤输出获取
  fromSteps?: Record<string, string>   // { localKey: stepId.outputPath }

  // 表达式（简单模板）
  template?: Record<string, string>
}

// 步骤条件
export interface StepCondition {
  // 基于上下文的条件
  context?: {
    key: string
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'exists'
    value: any
  }

  // 基于表达式的条件
  expression?: string  // 简单表达式，如 "steps.step1.success === true"
}

// 工作流定义
export interface Workflow {
  id: string
  name: string
  description?: string
  version?: string

  // 触发器
  trigger: Trigger

  // Agent 配置（可选，可复用）
  agents?: AgentConfig[]

  // 步骤
  steps: WorkflowStep[]

  // 全局配置
  config?: {
    timeout?: number          // 整体超时
    maxConcurrency?: number   // 最大并发数
    errorHandling?: ErrorHandling
  }

  // 元数据
  metadata?: {
    author?: string
    createdAt?: string
    updatedAt?: string
    tags?: string[]
  }
}

// 工作流执行上下文
export interface WorkflowContext {
  // 工作流信息
  workflowId: string
  executionId: string

  // 触发信息
  trigger: {
    type: TriggerType
    payload?: any
  }

  // 步骤结果
  steps: Record<string, StepResult>

  // 全局变量
  variables: Record<string, any>

  // 元数据
  startTime: Date
  currentStepId?: string
}

// 步骤执行结果
export interface StepResult {
  stepId: string
  status: StepStatus
  output?: any
  error?: string
  startTime: Date
  endTime?: Date
  duration?: number
  attempts?: number
}

// 工作流执行结果
export interface WorkflowResult {
  workflowId: string
  executionId: string
  status: WorkflowStatus
  steps: Record<string, StepResult>
  output?: any
  error?: string
  startTime: Date
  endTime: Date
  duration: number
}

// 工作流事件
export type WorkflowEvent =
  | { type: 'started'; workflowId: string; executionId: string }
  | { type: 'step-started'; workflowId: string; executionId: string; stepId: string }
  | { type: 'step-completed'; workflowId: string; executionId: string; stepId: string; result: StepResult }
  | { type: 'step-failed'; workflowId: string; executionId: string; stepId: string; error: string }
  | { type: 'completed'; workflowId: string; executionId: string; result: WorkflowResult }
  | { type: 'failed'; workflowId: string; executionId: string; error: string }

// 事件处理器
export type WorkflowEventHandler = (event: WorkflowEvent) => void

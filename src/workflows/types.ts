import { AgentConfig } from '../agents/types.js'

export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type TriggerType = 'manual' | 'schedule' | 'event' | 'webhook'

export interface Trigger {
  type: TriggerType
  config?: {
    cron?: string
    interval?: number
    event?: string
    source?: string
    path?: string
    method?: string
    secret?: string
  }
}

export interface RetryConfig {
  maxAttempts: number
  delay: number
  backoff?: 'fixed' | 'exponential'
  maxDelayMs?: number
  jitter?: boolean
}

export type ErrorHandling = 'stop' | 'retry' | 'skip' | 'fallback'
export type StepFailureStrategy = 'skip-downstream' | 'abort-workflow' | 'compensate'

export interface WorkflowStep {
  id: string
  name: string
  description?: string

  agentId?: string
  agentType?: string
  action: string

  input: StepInput
  output?: string
  condition?: StepCondition

  onError?: ErrorHandling
  onFailure?: StepFailureStrategy
  compensateAction?: string
  retry?: RetryConfig
  fallbackStepId?: string
  timeout?: number

  dependsOn?: string[]
}

export interface StepInput {
  static?: Record<string, any>
  fromContext?: Record<string, string>
  fromSteps?: Record<string, string>
  template?: Record<string, string>
}

export interface StepCondition {
  context?: {
    key: string
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'exists'
    value: any
  }
  expression?: string
}

export interface Workflow {
  id: string
  name: string
  description?: string
  version?: string
  trigger: Trigger
  agents?: AgentConfig[]
  steps: WorkflowStep[]
  config?: {
    timeout?: number
    maxConcurrency?: number
    errorHandling?: ErrorHandling
    onFailure?: StepFailureStrategy
  }
  metadata?: {
    author?: string
    createdAt?: string
    updatedAt?: string
    tags?: string[]
  }
}

export interface WorkflowContext {
  workflowId: string
  executionId: string
  trigger: {
    type: TriggerType
    payload?: any
  }
  steps: Record<string, StepResult>
  variables: Record<string, any>
  startTime: Date
  currentStepId?: string
  signal?: AbortSignal
}

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

export interface WorkflowActionContext {
  step: WorkflowStep
  workflowContext: WorkflowContext
  stepResults: Record<string, StepResult>
  signal?: AbortSignal
}

export type WorkflowActionHandler = (
  input: Record<string, unknown>,
  context: WorkflowActionContext
) => unknown | Promise<unknown>

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

export type WorkflowEvent =
  | { type: 'started'; workflowId: string; executionId: string }
  | { type: 'step-started'; workflowId: string; executionId: string; stepId: string }
  | { type: 'step-completed'; workflowId: string; executionId: string; stepId: string; result: StepResult }
  | { type: 'step-failed'; workflowId: string; executionId: string; stepId: string; error: string }
  | { type: 'completed'; workflowId: string; executionId: string; result: WorkflowResult }
  | { type: 'failed'; workflowId: string; executionId: string; error: string }

export type WorkflowEventHandler = (event: WorkflowEvent) => void

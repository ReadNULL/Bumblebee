/**
 * 工作流模块导出
 */

// 核心类
export { WorkflowEngine } from './engine.js'

// 类型定义
export type {
  Workflow,
  WorkflowStep,
  StepInput,
  StepCondition,
  Trigger,
  TriggerType,
  WorkflowStatus,
  StepStatus,
  ErrorHandling,
  RetryConfig,
  WorkflowContext,
  StepResult,
  WorkflowResult,
  WorkflowEvent,
  WorkflowEventHandler
} from './types.js'

// 模板
export {
  PR_REVIEW_WORKFLOW,
  ISSUE_TRIAGE_WORKFLOW,
  RELEASE_WORKFLOW,
  CODE_QUALITY_WORKFLOW,
  WORKFLOW_TEMPLATES,
  getWorkflowTemplate,
  getWorkflowTemplateIds,
  createWorkflowFromTemplate
} from './templates.js'

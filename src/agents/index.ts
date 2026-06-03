/**
 * Agent 模块导出
 *
 * 支持多 Agent 编排，每个 Agent 可以指定不同的角色
 */

// 核心类
export { AgentManager } from './manager.js'
export { AgentOrchestrator } from './orchestrator.js'

// 类型定义
export type {
  AgentConfig,
  AgentInstance,
  AgentTask,
  AgentResult,
  CollaborationMode,
  OrchestrationConfig
} from './types.js'

export type {
  OrchestrationResult,
  ResultAggregator
} from './orchestrator.js'

// 专业 Agent
export {
  getSpecializedAgentConfig,
  getSpecializedAgentTypes,
  createAgentTeam,
  RECOMMENDED_TEAMS
} from './specialized.js'

export type { AgentType } from './specialized.js'

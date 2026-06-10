/**
 * Agent 类型定义
 *
 * 支持多 Agent 编排，每个 Agent 可以指定不同的角色
 */

import { RoleConfig } from '../roles/types.js'

// Agent 配置
export interface AgentConfig {
  // Agent 基本信息
  id: string                    // 唯一标识符
  name: string                  // Agent 名称
  description?: string          // Agent 描述

  // 角色配置（可选）
  // 如果不指定，默认使用 Bumblebee 角色
  role?: {
    roleId?: string             // 使用已有的角色 ID
    roleConfig?: RoleConfig     // 或者直接定义角色配置
  }

  // 能力声明
  capabilities: string[]

  // 工作配置
  config?: {
    model?: string              // 使用的 AI 模型
    temperature?: number        // 温度参数
    maxTokens?: number          // 最大 token 数
    systemPrompt?: string       // 额外的系统提示词（会追加到角色提示词后）
  }

  // 元数据
  metadata?: {
    version?: string
    author?: string
    createdAt?: string
    updatedAt?: string
    tags?: string[]
    priority?: number
    description?: string
  }
}

// Agent 实例（运行时状态）
export interface AgentInstance {
  id: string
  config: AgentConfig
  role: RoleConfig              // 实际使用的角色
  status: 'idle' | 'busy' | 'error' | 'stopped'
  lastActive?: Date
}

// Agent 任务
export interface AgentTask {
  id: string
  agentId: string
  type: string
  description: string
  input: unknown
  priority: 'low' | 'medium' | 'high' | 'urgent'
  dependencies?: string[]
  context?: Record<string, unknown>
}

export type AgentTaskOutput =
  | {
      mode: 'ai'
      simulated: false
      message: string
      role: string
      taskType: string
    }
  | {
      mode: 'simulated'
      simulated: true
      message: string
      role: string
      taskType: string
      warning: string
    }

// Agent 结果
export interface AgentResult {
  taskId: string
  agentId: string
  success: boolean
  output: AgentTaskOutput | null
  error?: string
  metrics?: {
    startTime: Date
    endTime: Date
    duration: number
    tokenUsage?: number
  }
}

// Agent 协作模式
export type CollaborationMode =
  | 'independent'    // 独立工作
  | 'sequential'     // 顺序执行
  | 'parallel'       // 并行执行
  | 'hierarchical'   // 层级协作（主从模式）

// Agent 编排配置
export interface OrchestrationConfig {
  mode: CollaborationMode | string
  agents: AgentConfig[]
  tasks: AgentTask[]
  // 结果聚合策略
  aggregation?: 'merge' | 'vote' | 'priority' | 'list' | 'custom'
  // 错误处理策略
  errorHandling?: 'stop' | 'retry' | 'skip' | 'fallback'
}

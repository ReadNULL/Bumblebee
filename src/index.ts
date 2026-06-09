/**
 * Bumblebee 库导出
 *
 * CLI 入口已移至 src/cli.ts（使用 pi-coding-agent TUI）
 */

// 导出核心模块
export { BumblebeeAgent } from './core/agent.js'
export type { BumblebeeAgentConfig } from './core/agent.js'
export { BumblebeePersonality } from './personality/traits.js'
export type { PersonalityConfig } from './personality/traits.js'
export { MemoryManager } from './memory/manager.js'
export type { MemoryConfig } from './memory/manager.js'
export { loadConfig } from './core/config.js'
export type { BumblebeeConfig } from './core/config.js'

// 导出角色系统
export * from './roles/index.js'

// 导出渠道系统
export * from './channels/index.js'

// 导出 Agent 系统
export * from './agents/index.js'

// 导出工作流系统
export * from './workflows/index.js'

// 导出知识系统
export * from './knowledge/index.js'

// 导出高级功能
export * from './voice/index.js'
export * from './collaboration/index.js'
export * from './dashboard/index.js'
export * from './performance/index.js'

// 导出 TUI 模块
export * from './tui/index.js'

// 导出插件类型
export * from './plugins/types.js'

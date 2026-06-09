import type { BumblebeeAgent } from '../core/agent.js'
import type { ChannelAdapter } from '../channels/types.js'

export interface BumblebeeToolDefinition {
  name: string
  description?: string
  execute: (...args: unknown[]) => unknown | Promise<unknown>
}

export interface BumblebeeCommandDefinition {
  name: string
  description?: string
  handler: (...args: unknown[]) => unknown | Promise<unknown>
}

export interface BumblebeePlugin {
  name: string
  version: string
  tools?: BumblebeeToolDefinition[]
  commands?: BumblebeeCommandDefinition[]
  channels?: ChannelAdapter[]
  onInit?(agent: BumblebeeAgent): Promise<void>
}

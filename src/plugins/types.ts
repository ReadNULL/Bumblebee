import type { BumblebeeAgent } from '../core/agent.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ChannelManager } from '../channels/manager.js'
import type { ChannelAdapter } from '../channels/types.js'
import type { BumblebeeLogger } from '../core/logger.js'
import type { TSchema } from 'typebox'

export interface BumblebeePluginConfig {
  enabled: boolean
  modules: string[]
  directory?: string
}

export interface BumblebeeToolDefinition {
  name: string
  label?: string
  description?: string
  parameters?: TSchema
  execute: (params?: unknown, context?: BumblebeePluginContext) => unknown | Promise<unknown>
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
  onInit?(agent: BumblebeeAgent, context?: BumblebeePluginContext): Promise<void>
}

export interface BumblebeePluginContext {
  agent: BumblebeeAgent
  pi?: ExtensionAPI
  channelManager?: ChannelManager
  logger?: BumblebeeLogger
}

export interface LoadedBumblebeePlugin {
  plugin: BumblebeePlugin
  modulePath: string
}

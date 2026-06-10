import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { BumblebeeAgent } from '../core/agent.js'
import type { BumblebeeConfig } from '../core/config.js'
import type { BumblebeeLogger } from '../core/logger.js'
import type { ChannelManager } from '../channels/manager.js'
import type { SessionBuffer } from './session-buffer.js'

export type BumblebeeCommandContext = ExtensionCommandContext
export type BumblebeeUi = ExtensionCommandContext['ui']

export interface BumblebeeExtensionRuntime {
  pi: ExtensionAPI
  config: BumblebeeConfig
  agent: BumblebeeAgent
  channelManager: ChannelManager
  sessionBuffer: SessionBuffer
  logger: BumblebeeLogger
}

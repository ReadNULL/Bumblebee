import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { BumblebeeExtensionRuntime } from '../context.js'

function toolDetails(details: Record<string, unknown>): Record<string, unknown> {
  return details
}

export function registerCollaborationVoiceTools(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerTool(defineTool({
    name: 'get_collaboration_status',
    label: 'Get Collaboration Status',
    description: '获取实时协作状态',
    parameters: Type.Object({}),
    async execute() {
      const room = agent.getCollaborationRoom()
      if (!room) {
        return { content: [{ type: 'text' as const, text: '协作模块未启用' }], details: toolDetails({ enabled: false }) }
      }
      return {
        content: [{
          type: 'text' as const,
          text: `协作状态:\n  连接: ${room.isConnected() ? '已连接' : '未连接'}\n  用户数: ${room.getUserCount()}`,
        }],
        details: toolDetails({ enabled: true, connected: room.isConnected(), userCount: room.getUserCount() }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'send_collaboration_message',
    label: 'Send Collaboration Message',
    description: '向协作房间发送消息',
    parameters: Type.Object({
      message: Type.String({ description: '消息内容' }),
    }),
    async execute(_toolCallId, params) {
      const room = agent.getCollaborationRoom()
      if (!room) {
        return { content: [{ type: 'text' as const, text: '协作模块未启用' }], details: toolDetails({ enabled: false, sent: false }) }
      }
      if (!room.isConnected()) {
        return { content: [{ type: 'text' as const, text: '未连接到协作房间' }], details: toolDetails({ enabled: true, connected: false, sent: false }) }
      }
      room.sendMessage(params.message)
      return {
        content: [{ type: 'text' as const, text: '消息已发送' }],
        details: toolDetails({ enabled: true, connected: true, sent: true }),
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'voice_status',
    label: 'Voice Status',
    description: '获取语音引擎状态',
    parameters: Type.Object({}),
    async execute() {
      const voice = agent.getVoiceEngine()
      if (!voice) {
        return { content: [{ type: 'text' as const, text: '语音模块在当前 Node.js TUI 中不可用；仅支持浏览器宿主。' }], details: toolDetails({ enabled: false }) }
      }
      return {
        content: [{ type: 'text' as const, text: `语音引擎状态: ${voice.status}` }],
        details: toolDetails({ enabled: true, status: voice.status }),
      }
    },
  }))
}

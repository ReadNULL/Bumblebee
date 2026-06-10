import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerCollaborationVoiceCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerCommand('collab', {
    description: '协作管理（用法: /collab, /collab connect, /collab disconnect, /collab join <roomId>）',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const room = agent.getCollaborationRoom()
      if (!room) {
        ctx.ui.notify('协作模块未启用（在配置中设置 collaboration.enabled: true）', 'warning')
        return
      }

      const cmd = args.trim().split(/\s+/)
      let action = cmd[0] || ''
      let roomId = cmd[1]

      if (!action) {
        const status = room.isConnected() ? '已连接' : '未连接'
        const selected = await ctx.ui.select(`协作管理 (${status})`, [
          'connect: 连接协作服务器',
          'disconnect: 断开协作连接',
          'join: 加入房间',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
        if (action === 'join') {
          roomId = await ctx.ui.input('输入房间 ID', '') || ''
        }
      }

      if (action === 'connect') {
        await room.connect()
        ctx.ui.notify('已连接到协作服务器', 'info')
      } else if (action === 'disconnect') {
        await room.disconnect()
        ctx.ui.notify('已断开协作连接', 'info')
      } else if (action === 'join') {
        if (!roomId) {
          ctx.ui.notify('用法: /collab join <roomId>', 'warning')
          return
        }
        await room.joinRoom(roomId)
        ctx.ui.notify(`已加入房间: ${roomId}`, 'info')
      } else {
        ctx.ui.notify(
          `协作状态:\n  连接: ${room.isConnected() ? '已连接' : '未连接'}\n  用户数: ${room.getUserCount()}\n\n用法: /collab connect | disconnect | join <roomId>`,
          'info',
        )
      }
    },
  })

  pi.registerCommand('voice', {
    description: '语音管理（用法: /voice, /voice start, /voice stop, /voice speak <text>）',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const voice = agent.getVoiceEngine()
      if (!voice) {
        ctx.ui.notify('语音模块未启用（在配置中设置 voice.enabled: true）', 'warning')
        return
      }

      const parts = args.trim().split(/\s+/)
      let action = parts[0] || ''
      let speakText = parts.slice(1).join(' ')

      if (!action) {
        const selected = await ctx.ui.select(`语音管理 (${voice.status})`, [
          'start: 启动语音识别',
          'stop: 停止语音识别',
          'speak: 语音播放文本',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
        if (action === 'speak') {
          speakText = await ctx.ui.input('输入要播放的文本', '') || ''
        }
      }

      if (action === 'start') {
        try {
          await voice.startListening()
          ctx.ui.notify('语音识别已启动', 'info')
        } catch (error) {
          ctx.ui.notify(`启动语音识别失败: ${errorMessage(error)}`, 'error')
        }
      } else if (action === 'stop') {
        try {
          await voice.stopListening()
          ctx.ui.notify('语音识别已停止', 'info')
        } catch (error) {
          ctx.ui.notify(`停止语音识别失败: ${errorMessage(error)}`, 'error')
        }
      } else if (action === 'speak') {
        if (!speakText) {
          ctx.ui.notify('用法: /voice speak <text>', 'warning')
          return
        }
        try {
          await voice.speak({ text: speakText })
          ctx.ui.notify('语音播放完成', 'info')
        } catch (error) {
          ctx.ui.notify(`语音播放失败: ${errorMessage(error)}`, 'error')
        }
      } else {
        ctx.ui.notify(`语音引擎: ${voice.status}\n\n用法: /voice start | stop | speak <text>`, 'info')
      }
    },
  })
}

/**
 * Slack 渠道扩展示例
 *
 * 这是一个社区扩展示例，展示如何实现 ChannelAdapter 接口
 * 实际使用时需要安装 @slack/bolt 依赖
 */

import { ChannelAdapter, ChannelCapabilities, Message, MessageHandler } from '../../src/channels/types.js'

// 注意：实际使用时需要安装 @slack/bolt
// import { App } from '@slack/bolt'

export interface SlackConfig {
  token: string
  signingSecret: string
  appToken?: string  // 用于 Socket Mode
}

export class SlackAdapter implements ChannelAdapter {
  name = 'slack'
  type = 'messaging' as const
  description = 'Slack 渠道适配器'

  supports: ChannelCapabilities = {
    files: true,
    reactions: true,
    threads: true,
    mentions: true,
    richText: true,
    voice: false,
    video: false
  }

  private config: SlackConfig
  private messageHandler?: MessageHandler
  // private app: App  // 实际使用时取消注释

  constructor(config: SlackConfig) {
    this.config = config
  }

  async initialize(): Promise<void> {
    // 实际使用时初始化 Slack App
    // this.app = new App({
    //   token: this.config.token,
    //   signingSecret: this.config.signingSecret,
    //   socketMode: !!this.config.appToken,
    //   appToken: this.config.appToken
    // })
    //
    // this.app.message(async ({ message, say }) => {
    //   const unifiedMessage: Message = {
    //     id: message.ts,
    //     content: (message as any).text || '',
    //     type: 'text',
    //     sender: {
    //       id: (message as any).user || 'unknown',
    //       name: 'Slack User',
    //       platform: 'slack'
    //     },
    //     timestamp: new Date(parseFloat(message.ts) * 1000),
    //     metadata: {
    //       channel: (message as any).channel
    //     }
    //   }
    //   await this.messageHandler?.(unifiedMessage)
    // })

    console.log('[Slack] 初始化完成')
  }

  async connect(): Promise<void> {
    // 实际使用时启动 Slack App
    // await this.app.start()
    console.log('[Slack] 连接成功')
  }

  async disconnect(): Promise<void> {
    // 实际使用时停止 Slack App
    // await this.app.stop()
    console.log('[Slack] 断开连接')
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async sendMessage(target: string, message: Message): Promise<void> {
    // 实际使用时发送消息
    // await this.app.client.chat.postMessage({
    //   channel: target,
    //   text: message.content,
    //   mrkdwn: true
    // })
    console.log(`[Slack] 发送消息到 ${target}: ${message.content}`)
  }

  async getStatus(): Promise<'connected' | 'disconnected' | 'error'> {
    // 实际使用时检查连接状态
    return 'connected'
  }

  async getTargets(): Promise<Array<{ id: string; name: string }>> {
    // 实际使用时获取频道列表
    // const result = await this.app.client.conversations.list()
    // return result.channels?.map(c => ({
    //   id: c.id!,
    //   name: c.name!
    // })) || []
    return []
  }
}

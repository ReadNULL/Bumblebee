/**
 * 钉钉渠道适配器
 *
 * 支持：
 * - 群机器人消息
 * - 企业内部应用消息
 * - Webhook 推送
 */

import {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  Message,
  MessageHandler,
  MessageType,
  User
} from './types.js'

interface DingTalkConfig extends ChannelConfig {
  name?: string
  webhook?: string        // 群机器人 Webhook 地址
  appKey?: string         // 企业内部应用 AppKey
  appSecret?: string      // 企业内部应用 AppSecret
  robotCode?: string      // 机器人编码
  port?: number           // Webhook 监听端口
}

export class DingTalkAdapter implements ChannelAdapter {
  name: string
  type: 'messaging' = 'messaging'
  description = '钉钉渠道适配器'
  supports: ChannelCapabilities = {
    files: true,
    reactions: false,
    threads: false,
    mentions: true,
    richText: true,
    voice: false,
    video: false
  }

  private config: DingTalkConfig
  private messageHandler: MessageHandler | null = null
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private accessToken: string | null = null
  private tokenExpireTime: number = 0

  constructor(config: DingTalkConfig) {
    this.name = config.name || 'dingtalk'
    this.config = config
  }

  // 初始化
  async initialize(): Promise<void> {
    // 如果配置了企业应用，获取 access_token
    if (this.config.appKey && this.config.appSecret) {
      await this.refreshAccessToken()
    }
  }

  // 连接
  async connect(): Promise<void> {
    this._status = 'connecting'

    try {
      // 如果使用 Webhook 模式，直接标记为已连接
      if (this.config.webhook) {
        this._status = 'connected'
        return
      }

      // 如果使用企业应用模式，启动消息监听
      if (this.config.appKey && this.config.appSecret) {
        await this.startMessageListener()
        this._status = 'connected'
        return
      }

      throw new Error('请配置 webhook 或 appKey/appSecret')
    } catch (error) {
      this._status = 'error'
      console.error('钉钉连接失败:', error)
      throw error
    }
  }

  // 断开连接
  async disconnect(): Promise<void> {
    this._status = 'disconnected'
    this.accessToken = null
  }

  // 注册消息处理器
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  // 发送消息
  async sendMessage(target: string, message: Message): Promise<void> {
    // Webhook 模式
    if (this.config.webhook && target === '*') {
      await this.sendWebhookMessage(message)
      return
    }

    // 企业应用模式
    if (this.config.appKey && this.config.appSecret) {
      await this.sendAppMessage(target, message)
      return
    }

    throw new Error('未配置发送方式')
  }

  // 获取状态
  async getStatus(): Promise<'connected' | 'disconnected' | 'error'> {
    // 将 'connecting' 映射为 'disconnected'
    if (this._status === 'connecting') {
      return 'disconnected'
    }
    return this._status
  }

  // 获取可用目标（群组列表）
  async getTargets(): Promise<Array<{ id: string; name: string }>> {
    if (!this.accessToken) {
      return []
    }

    try {
      const response = await fetch(
        'https://oapi.dingtalk.com/chat/get',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: this.accessToken })
        }
      )

      const data = await response.json() as any
      if (data.errcode === 0 && data.chatid) {
        return [{ id: data.chatid, name: data.name || '未命名群组' }]
      }

      return []
    } catch (error) {
      console.error('获取钉钉群组列表失败:', error)
      return []
    }
  }

  // 通过 Webhook 发送消息
  private async sendWebhookMessage(message: Message): Promise<void> {
    if (!this.config.webhook) {
      throw new Error('未配置 Webhook')
    }

    const body = this.buildWebhookBody(message)

    try {
      const response = await fetch(this.config.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const result = await response.json() as any
      if (result.errcode !== 0) {
        throw new Error(`钉钉 Webhook 发送失败: ${result.errmsg}`)
      }
    } catch (error) {
      console.error('钉钉 Webhook 发送失败:', error)
      throw error
    }
  }

  // 通过企业应用发送消息
  private async sendAppMessage(target: string, message: Message): Promise<void> {
    if (!this.accessToken) {
      await this.refreshAccessToken()
    }

    const body = this.buildAppBody(target, message)

    try {
      const response = await fetch(
        `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${this.accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      )

      const result = await response.json() as any
      if (result.errcode !== 0) {
        throw new Error(`钉钉消息发送失败: ${result.errmsg}`)
      }
    } catch (error) {
      console.error('钉钉消息发送失败:', error)
      throw error
    }
  }

  // 构建 Webhook 消息体
  private buildWebhookBody(message: Message): any {
    switch (message.type) {
      case 'text':
        return {
          msgtype: 'text',
          text: { content: message.content }
        }
      case 'image':
        return {
          msgtype: 'image',
          image: { mediaId: message.content }
        }
      case 'file':
        return {
          msgtype: 'file',
          file: { mediaId: message.content }
        }
      default:
        // 使用 Markdown 格式
        return {
          msgtype: 'markdown',
          markdown: {
            title: 'Bumblebee 消息',
            text: message.content
          }
        }
    }
  }

  // 构建企业应用消息体
  private buildAppBody(target: string, message: Message): any {
    const base: any = {
      agent_id: this.config.robotCode,
      userid_list: target
    }

    switch (message.type) {
      case 'text':
        return {
          ...base,
          msg: {
            msgtype: 'text',
            text: { content: message.content }
          }
        }
      case 'image':
        return {
          ...base,
          msg: {
            msgtype: 'image',
            image: { mediaId: message.content }
          }
        }
      default:
        return {
          ...base,
          msg: {
            msgtype: 'markdown',
            markdown: {
              title: 'Bumblebee',
              text: message.content
            }
          }
        }
    }
  }

  // 刷新 access_token
  private async refreshAccessToken(): Promise<void> {
    if (!this.config.appKey || !this.config.appSecret) {
      return
    }

    try {
      const response = await fetch(
        `https://oapi.dingtalk.com/gettoken?appkey=${this.config.appKey}&appsecret=${this.config.appSecret}`
      )

      const data = await response.json() as any
      if (data.errcode === 0) {
        this.accessToken = data.access_token
        this.tokenExpireTime = Date.now() + (data.expires_in - 300) * 1000
      } else {
        throw new Error(`获取 access_token 失败: ${data.errmsg}`)
      }
    } catch (error) {
      console.error('刷新钉钉 access_token 失败:', error)
      throw error
    }
  }

  // 启动消息监听（企业应用模式）
  private async startMessageListener(): Promise<void> {
    // 钉钉企业应用通常通过回调 URL 接收消息
    // 这里需要配合 HTTP 服务器使用
  }

  // 处理回调消息（供 HTTP 服务器调用）
  async handleCallback(data: any): Promise<void> {
    if (!this.messageHandler) {
      return
    }

    const message: Message = {
      id: data.msgId || Date.now().toString(),
      content: data.text?.content || data.content || '',
      type: 'text',
      sender: {
        id: data.senderId || 'unknown',
        name: data.senderNick || '未知用户',
        platform: 'dingtalk'
      },
      timestamp: new Date(data.createAt || Date.now()),
      metadata: {
        conversationId: data.conversationId,
        conversationType: data.conversationType
      }
    }

    await this.messageHandler(message)
  }

  // 发送 ActionCard 消息
  async sendActionCard(target: string, card: {
    title: string
    text: string
    buttons: Array<{ title: string; actionUrl: string }>
  }): Promise<void> {
    if (!this.config.webhook) {
      throw new Error('未配置 Webhook')
    }

    const body = {
      msgtype: 'actionCard',
      actionCard: {
        title: card.title,
        text: card.text,
        btns: card.buttons.map(btn => ({
          title: btn.title,
          actionURL: btn.actionUrl
        }))
      }
    }

    try {
      const response = await fetch(this.config.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const result = await response.json() as any
      if (result.errcode !== 0) {
        throw new Error(`钉钉 ActionCard 发送失败: ${result.errmsg}`)
      }
    } catch (error) {
      console.error('钉钉 ActionCard 发送失败:', error)
      throw error
    }
  }
}

// 工厂函数
export function createDingTalkAdapter(config: DingTalkConfig): DingTalkAdapter {
  return new DingTalkAdapter(config)
}

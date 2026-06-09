/**
 * 飞书渠道适配器
 *
 * 基于 @larksuiteoapi/node-sdk 实现，支持：
 * - 机器人消息
 * - 群聊消息
 * - 消息卡片
 * - 文件传输
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

// 飞书 SDK 模块（延迟加载）
let lark: any

const silentLarkLogger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
}

function getLarkLoggerLevel(): number {
  return lark?.LoggerLevel?.fatal ?? 0
}

interface FeishuConfig extends ChannelConfig {
  name?: string
  appId: string           // 飞书应用 App ID
  appSecret: string       // 飞书应用 App Secret
  encryptKey?: string     // 事件加密 Key
  verificationToken?: string  // 事件验证 Token
  port?: number           // Webhook 监听端口
}

export class FeishuAdapter implements ChannelAdapter {
  name: string
  type: 'messaging' = 'messaging'
  description = '飞书渠道适配器（基于 @larksuiteoapi/node-sdk）'
  supports: ChannelCapabilities = {
    files: false,
    reactions: true,
    threads: true,
    mentions: true,
    richText: true,
    voice: false,
    video: false
  }

  private config: FeishuConfig
  private client: any = null
  private messageHandler: MessageHandler | null = null
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private wsClient: any = null

  constructor(config: FeishuConfig) {
    this.name = config.name || 'feishu'
    this.config = config
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    if (!this.messageHandler) {
      return
    }

    const event = data?.event || data
    const message = event?.message
    if (!message) {
      return
    }

    const content = this.parseMessageContent(message.content)
    const senderId =
      event?.sender?.sender_id?.open_id ||
      event?.sender?.sender_id?.user_id ||
      event?.sender?.sender_id?.union_id ||
      'unknown'
    const createTime = Number.parseInt(message.create_time, 10)

    await this.messageHandler({
      id: message.message_id,
      content: this.extractContent(message.message_type, content),
      type: this.getMessageType(message.message_type),
      sender: {
        id: senderId,
        name: senderId,
        platform: 'feishu',
      },
      timestamp: Number.isFinite(createTime) ? new Date(createTime) : new Date(),
      metadata: {
        chatId: message.chat_id,
        chatType: message.chat_type,
        mentionKeys: message.mentions || [],
      },
    })
  }

  private parseMessageContent(content: unknown): any {
    if (typeof content !== 'string') {
      return content || {}
    }

    try {
      return JSON.parse(content)
    } catch {
      return { text: content }
    }
  }

  // 初始化
  async initialize(): Promise<void> {
    try {
      lark = await import('@larksuiteoapi/node-sdk')
    } catch (error) {
      throw new Error('请安装飞书 SDK: npm install @larksuiteoapi/node-sdk')
    }

    // 创建飞书客户端
    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      disableTokenCache: false,
      logger: silentLarkLogger,
      loggerLevel: getLarkLoggerLevel()
    })
  }

  // 连接
  async connect(): Promise<void> {
    if (!this.client) {
      throw new Error('飞书适配器未初始化')
    }

    this._status = 'connecting'

    try {
      // 使用 WebSocket 长连接模式
      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        logger: silentLarkLogger,
        loggerLevel: getLarkLoggerLevel()
      })

      // 注册消息事件处理器
      this.wsClient.start({
        eventDispatcher: new lark.EventDispatcher({
          encryptKey: this.config.encryptKey,
          verificationToken: this.config.verificationToken,
          logger: silentLarkLogger,
          loggerLevel: getLarkLoggerLevel()
        }).register({
          'im.message.receive_v1': async (data: any) => {
            await this.handleIncomingMessage(data)
          }
        })
      })

      this._status = 'connected'
    } catch (error) {
      this._status = 'error'
      console.error('飞书连接失败:', error)
      throw error
    }
  }

  // 断开连接
  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close()
      this.wsClient = null
    }
    this._status = 'disconnected'
  }

  // 注册消息处理器
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  // 发送消息
  async sendMessage(target: string, message: Message): Promise<void> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化')
    }

    try {
      const content = this.buildMessageContent(message)

      // 根据 target 类型发送
      if (target.startsWith('oc_')) {
        // 群聊 ID
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: target,
            msg_type: content.type,
            content: JSON.stringify(content.body)
          }
        })
      } else {
        // 用户 open_id
        await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: target,
            msg_type: content.type,
            content: JSON.stringify(content.body)
          }
        })
      }
    } catch (error) {
      console.error('发送飞书消息失败:', error)
      throw error
    }
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
    if (!this.client) {
      return []
    }

    try {
      const response = await this.client.im.chat.list({
        params: { page_size: 100 }
      })

      return (response.items || []).map((chat: any) => ({
        id: chat.chat_id,
        name: chat.name || '未命名群组'
      }))
    } catch (error) {
      console.error('获取飞书群组列表失败:', error)
      return []
    }
  }

  // 处理接收到的消息
  private async handleMessage(data: any): Promise<void> {
    await this.handleIncomingMessage(data)
    return

    if (!this.messageHandler) {
      return
    }

    const event = data?.event || data
    if (!event?.message) {
      return
    }
    const message = event.message
    const sender = event.sender || {}

    // 获取消息内容
    const content = this.parseMessageContent(message.content)
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || 'unknown'
    const createTime = Number.parseInt(message.create_time, 10)

    // 构建统一消息格式
    const unifiedMessage: Message = {
      id: message.message_id,
      content: this.extractContent(message.message_type, content),
      type: this.getMessageType(message.message_type),
      sender: {
        id: sender.sender_id.open_id,
        name: sender.sender_id.open_id, // 需要额外 API 获取用户名
        platform: 'feishu'
      },
      timestamp: new Date(parseInt(message.create_time)),
      metadata: {
        chatId: message.chat_id,
        chatType: message.chat_type,
        mentionKeys: message.mentions
      }
    }

    await this.messageHandler?.(unifiedMessage)
  }

  // 获取消息类型
  private getMessageType(messageType: string): MessageType {
    switch (messageType) {
      case 'text':
        return 'text'
      case 'image':
        return 'image'
      case 'audio':
        return 'voice'
      case 'media':
        return 'video'
      case 'file':
        return 'file'
      default:
        return 'text'
    }
  }

  // 提取消息内容
  private extractContent(messageType: string, content: any): string {
    switch (messageType) {
      case 'text':
        return content.text || ''
      case 'image':
        return '[图片]'
      case 'audio':
        return '[语音]'
      case 'media':
        return '[视频]'
      case 'file':
        return content.file_name || '[文件]'
      default:
        return JSON.stringify(content)
    }
  }

  // 构建发送消息内容
  private buildMessageContent(message: Message): { type: string; body: any } {
    switch (message.type) {
      case 'text':
        return {
          type: 'text',
          body: { text: message.content }
        }
      case 'image':
        return {
          type: 'image',
          body: { image_key: message.content }
        }
      case 'file':
        return {
          type: 'file',
          body: { file_key: message.content }
        }
      default:
        // 默认使用富文本
        return {
          type: 'post',
          body: {
            zh_cn: {
              title: '',
              content: [[{ tag: 'text', text: message.content }]]
            }
          }
        }
    }
  }

  // 发送消息卡片
  async sendCard(target: string, card: any): Promise<void> {
    if (!this.client) {
      throw new Error('飞书客户端未初始化')
    }

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: target,
          msg_type: 'interactive',
          content: JSON.stringify(card)
        }
      })
    } catch (error) {
      console.error('发送飞书卡片失败:', error)
      throw error
    }
  }
}

// 工厂函数
export function createFeishuAdapter(config: FeishuConfig): FeishuAdapter {
  return new FeishuAdapter(config)
}

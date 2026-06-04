/**
 * 微信渠道适配器
 *
 * 基于 wechaty 实现，支持：
 * - 个人号登录
 * - 群聊消息
 * - 私聊消息
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
import QRCode from 'qrcode'

// wechaty 模块（延迟加载）
let WechatyClass: any
let wechatyLoadPromise: Promise<void> | null = null

interface WeChatConfig extends ChannelConfig {
  name?: string
  puppet?: string       // puppet 类型：wechaty-puppet-padlocal, wechaty-puppet-wechat4u 等
  token?: string        // puppet token（如使用 padlocal）
  autoAcceptFriend?: boolean
  autoReply?: boolean
}

export class WeChatAdapter implements ChannelAdapter {
  name: string
  type: 'messaging' = 'messaging'
  description = '微信渠道适配器（基于 wechaty）'
  supports: ChannelCapabilities = {
    files: true,
    reactions: false,
    threads: false,
    mentions: true,
    richText: false,
    voice: true,
    video: false
  }

  private config: WeChatConfig
  private bot: any = null
  private messageHandler: MessageHandler | null = null
  private qrCodeCallback: ((qr: string) => void) | null = null
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'

  constructor(config: WeChatConfig = {}) {
    this.name = config.name || 'wechat'
    this.config = config
  }

  // 预加载 wechaty 模块（后台进行，initialize() 会等待其完成）
  static preload(): Promise<void> {
    if (WechatyClass) return Promise.resolve()
    if (!wechatyLoadPromise) {
      wechatyLoadPromise = import('wechaty').then(mod => {
        WechatyClass = mod.WechatyBuilder
      }).catch(() => {
        // wechaty 未安装，清空 promise（initialize 时会重新报错）
        wechatyLoadPromise = null
      })
    }
    return wechatyLoadPromise
  }

  // 初始化（等待预加载完成或重新加载）
  async initialize(): Promise<void> {
    if (WechatyClass) return
    if (wechatyLoadPromise) {
      await wechatyLoadPromise
      if (WechatyClass) return
    }
    try {
      const wechatyModule = await import('wechaty')
      WechatyClass = wechatyModule.WechatyBuilder
      wechatyLoadPromise = Promise.resolve()
    } catch (error) {
      throw new Error(
        '请安装 wechaty: npm install wechaty\n' +
        '如需使用特定 puppet，请额外安装对应包'
      )
    }
  }

  // 连接（立即返回，bot 在后台启动）
  async connect(): Promise<void> {
    if (this.bot || this._status === 'connecting') {
      return
    }

    this._status = 'connecting'

    // 创建 wechaty 实例
    const builderOptions: any = {
      name: this.config.name || 'bumblebee'
    }

    if (this.config.puppet) {
      builderOptions.puppet = this.config.puppet
    }

    if (this.config.token) {
      builderOptions.puppetOptions = { token: this.config.token }
    }

    const builder = new WechatyClass()
    this.bot = builder.options(builderOptions).build()

    // 注册事件处理器
    this.bot.on('scan', async (qrcodeValue: string, status: any) => {
      if (status === 2) {
        let qrDisplay: string
        try {
          qrDisplay = await QRCode.toString(qrcodeValue, { type: 'terminal', small: true })
        } catch {
          qrDisplay = `二维码链接: ${qrcodeValue}\n请用微信扫一扫`
        }
        this.qrCodeCallback?.(qrDisplay)
      }
    })

    this.bot.on('login', (_user: any) => {
      this._status = 'connected'
    })

    this.bot.on('logout', (_user: any) => {
      this._status = 'disconnected'
    })

    this.bot.on('error', (error: Error) => {
      this._status = 'error'
      console.error('微信错误:', error)
    })

    this.bot.on('message', async (msg: any) => {
      await this.handleMessage(msg)
    })

    // fire-and-forget: 不 await bot.start()，让 bot 在后台自行启动
    this.bot.start().catch((error: Error) => {
      this._status = 'error'
      console.error('微信启动失败:', error)
    })
  }

  // 断开连接
  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
      this._status = 'disconnected'
    }
  }

  // 注册消息处理器
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  // 发送消息
  async sendMessage(target: string, message: Message): Promise<void> {
    if (!this.bot) {
      throw new Error('微信未连接')
    }

    try {
      // 查找联系人或群组
      let contact = null

      if (target === '*') {
        // 广播：发送到文件传输助手
        contact = await this.bot.Contact.find({ name: '文件传输助手' })
      } else {
        // 按 ID 或名称查找
        contact = await this.bot.Contact.find({ id: target }) ||
                  await this.bot.Contact.find({ name: target })

        if (!contact) {
          // 尝试查找群组
          const room = await this.bot.Room.find({ topic: target })
          if (room) {
            await room.say(message.content)
            return
          }
        }
      }

      if (contact) {
        await contact.say(message.content)
      } else {
        throw new Error(`找不到目标: ${target}`)
      }
    } catch (error) {
      console.error('发送微信消息失败:', error)
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
    if (!this.bot) {
      return []
    }

    try {
      const rooms = await this.bot.Room.findAll()
      return rooms.map((room: any) => ({
        id: room.id,
        name: room.topic() || '未命名群组'
      }))
    } catch (error) {
      console.error('获取群组列表失败:', error)
      return []
    }
  }

  // 设置二维码回调
  onQrCode(callback: (qr: string) => void): void {
    this.qrCodeCallback = callback
  }

  // 处理接收到的消息
  private async handleMessage(msg: any): Promise<void> {
    if (!this.messageHandler) {
      return
    }

    // 忽略自己发送的消息
    if (msg.self()) {
      return
    }

    // 获取消息类型
    const type = this.getMessageType(msg)

    // 获取发送者信息
    const talker = msg.talker()
    const room = msg.room()

    const sender: User = {
      id: talker?.id || 'unknown',
      name: talker?.name() || '未知用户',
      platform: 'wechat'
    }

    // 构建统一消息格式
    const message: Message = {
      id: msg.id,
      content: await this.extractContent(msg),
      type,
      sender,
      timestamp: new Date(msg.date().getTime()),
      metadata: {
        roomId: room?.id,
        roomName: room ? await room.topic() : undefined,
        isMentionSelf: await msg.mentionSelf()
      }
    }

    await this.messageHandler(message)
  }

  // 获取消息类型
  private getMessageType(msg: any): MessageType {
    const type = msg.type()
    switch (type) {
      case 1: // Message.Type.Text
        return 'text'
      case 2: // Message.Type.Image
        return 'image'
      case 3: // Message.Type.Video
        return 'video'
      case 4: // Message.Type.Audio
        return 'voice'
      case 5: // Message.Type.Attachment
        return 'file'
      default:
        return 'text'
    }
  }

  // 提取消息内容
  private async extractContent(msg: any): Promise<string> {
    const type = msg.type()

    switch (type) {
      case 1: // Text
        return msg.text()
      case 2: // Image
        return '[图片]'
      case 3: // Video
        return '[视频]'
      case 4: // Audio
        return '[语音]'
      case 5: // Attachment
        return '[文件]'
      default:
        return msg.text() || '[未知消息]'
    }
  }
}

// 工厂函数
export function createWeChatAdapter(config?: WeChatConfig): WeChatAdapter {
  return new WeChatAdapter(config)
}

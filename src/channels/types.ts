// 渠道能力
export interface ChannelCapabilities {
  files?: boolean      // 文件传输
  reactions?: boolean  // 表情反应
  threads?: boolean    // 消息线程
  mentions?: boolean   // @提及
  richText?: boolean   // 富文本
  voice?: boolean      // 语音
  video?: boolean      // 视频
}

// 用户信息
export interface User {
  id: string
  name: string
  avatar?: string
  platform: string
}

// 消息类型
export type MessageType = 'text' | 'file' | 'code' | 'image' | 'voice' | 'video'

// 统一消息格式
export interface Message {
  id: string
  content: string
  type: MessageType
  sender: User
  timestamp: Date
  metadata?: Record<string, any>
}

// 消息处理器
export type MessageHandler = (message: Message) => Promise<void>

// 渠道配置
export interface ChannelConfig {
  [key: string]: any
}

// 渠道适配器接口
export interface ChannelAdapter {
  // 基本信息
  name: string
  type: 'messaging' | 'devtool' | 'collaboration'
  description?: string

  // 能力声明
  supports: ChannelCapabilities

  // 生命周期
  initialize(): Promise<void>
  connect(): Promise<void>
  disconnect(): Promise<void>

  // 消息处理
  onMessage(handler: MessageHandler): void
  sendMessage(target: string, message: Message): Promise<void>

  // 可选：获取渠道状态
  getStatus?(): Promise<'connected' | 'disconnected' | 'error'>

  // 可选：获取可用目标（群组、频道等）
  getTargets?(): Promise<Array<{ id: string; name: string }>>
}

// 渠道事件
export type ChannelEvent =
  | { type: 'connected'; channel: string }
  | { type: 'disconnected'; channel: string }
  | { type: 'error'; channel: string; error: Error }
  | { type: 'message'; channel: string; message: Message }

// 渠道事件处理器
export type ChannelEventHandler = (event: ChannelEvent) => void

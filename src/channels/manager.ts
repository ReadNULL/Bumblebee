import {
  ChannelAdapter,
  ChannelEvent,
  ChannelEventHandler,
  Message,
  MessageHandler
} from './types.js'

export class ChannelManager {
  private channels: Map<string, ChannelAdapter> = new Map()
  private messageHandlers: MessageHandler[] = []
  private eventHandlers: ChannelEventHandler[] = []

  // 注册渠道
  register(adapter: ChannelAdapter): void {
    // 设置消息处理器
    adapter.onMessage(async (message: Message) => {
      for (const handler of this.messageHandlers) {
        await handler(message)
      }
    })

    this.channels.set(adapter.name, adapter)
    this.emitEvent({ type: 'connected', channel: adapter.name })
  }

  // 注销渠道
  async unregister(name: string): Promise<void> {
    const adapter = this.channels.get(name)
    if (adapter) {
      await adapter.disconnect()
      this.channels.delete(name)
      this.emitEvent({ type: 'disconnected', channel: name })
    }
  }

  // 动态加载社区渠道
  async loadCommunityChannel(path: string): Promise<void> {
    try {
      const module = await import(path)
      const AdapterClass = module.default || module
      const adapter = new AdapterClass()
      this.register(adapter)
    } catch (error) {
      console.error(`加载社区渠道失败: ${path}`, error)
      throw error
    }
  }

  // 连接所有渠道
  async connectAll(): Promise<void> {
    const connectPromises = Array.from(this.channels.values()).map(async (adapter) => {
      try {
        await adapter.initialize()
        await adapter.connect()
      } catch (error) {
        this.emitEvent({
          type: 'error',
          channel: adapter.name,
          error: error as Error
        })
      }
    })

    await Promise.all(connectPromises)
  }

  // 断开所有渠道
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.channels.values()).map(async (adapter) => {
      try {
        await adapter.disconnect()
      } catch (error) {
        console.error(`断开渠道 ${adapter.name} 失败:`, error)
      }
    })

    await Promise.all(disconnectPromises)
  }

  // 广播消息到所有渠道
  async broadcast(message: Message): Promise<void> {
    const sendPromises = Array.from(this.channels.values()).map(async (adapter) => {
      try {
        await adapter.sendMessage('*', message)
      } catch (error) {
        console.error(`广播到 ${adapter.name} 失败:`, error)
      }
    })

    await Promise.all(sendPromises)
  }

  // 发送消息到指定渠道
  async send(channelName: string, target: string, message: Message): Promise<void> {
    const adapter = this.channels.get(channelName)
    if (!adapter) {
      throw new Error(`渠道不存在: ${channelName}`)
    }

    await adapter.sendMessage(target, message)
  }

  // 注册消息处理器
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler)
  }

  // 注册事件处理器
  onEvent(handler: ChannelEventHandler): void {
    this.eventHandlers.push(handler)
  }

  // 获取所有渠道
  getChannels(): ChannelAdapter[] {
    return Array.from(this.channels.values())
  }

  // 获取指定渠道
  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name)
  }

  // 获取已连接的渠道
  getConnectedChannels(): ChannelAdapter[] {
    return Array.from(this.channels.values())
  }

  // 触发事件
  private emitEvent(event: ChannelEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }
}

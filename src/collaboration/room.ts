/**
 * 协作房间管理
 *
 * 负责管理协作房间和用户
 */

import {
  CollaborationRoom,
  CollaborationUser,
  CollaborationEvent,
  CollaborationEventHandler,
  CollaborationConfig,
  CollaborationAdapter,
  ContentChange,
  CursorPosition,
  ChatMessage,
  UserStatus
} from './types.js'

export class CollaborationRoomImpl implements CollaborationAdapter {
  name: string
  roomId: string
  localUser: CollaborationUser
  remoteUsers: CollaborationUser[] = []

  private config: CollaborationConfig
  private room: CollaborationRoom | null = null
  private eventHandlers: CollaborationEventHandler[] = []
  private changeHandlers: Array<(change: ContentChange) => void> = []
  private cursorHandlers: Array<(userId: string, position: CursorPosition) => void> = []
  private messageHandlers: Array<(message: ChatMessage) => void> = []
  private ws: WebSocket | null = null

  constructor(config: CollaborationConfig) {
    this.name = 'collaboration-room'
    this.roomId = config.roomId || ''
    this.config = config

    // 创建本地用户
    this.localUser = {
      id: config.userId,
      name: config.userName,
      color: this.generateColor(config.userId),
      status: 'online',
      lastActive: new Date()
    }
  }

  // ========== 生命周期 ==========

  async connect(): Promise<void> {
    if (!this.config.serverUrl) {
      throw new Error('未配置协作服务器地址')
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.serverUrl!)

        this.ws.onopen = () => {
          this.emitEvent({
            type: 'user-join',
            userId: this.localUser.id,
            timestamp: new Date(),
            data: { user: this.localUser }
          })
          resolve()
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (error) => {
          console.error('协作服务器错误:', error)
          reject(error)
        }

        this.ws.onclose = () => {
          this.localUser.status = 'offline'
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.localUser.status = 'offline'
    this.remoteUsers = []
  }

  // ========== 房间管理 ==========

  async joinRoom(roomId: string): Promise<void> {
    this.roomId = roomId

    // 发送加入房间消息
    this.send({
      type: 'join-room',
      roomId,
      user: this.localUser
    })
  }

  async leaveRoom(): Promise<void> {
    // 发送离开房间消息
    this.send({
      type: 'leave-room',
      roomId: this.roomId,
      userId: this.localUser.id
    })

    this.roomId = ''
    this.remoteUsers = []
  }

  // ========== 内容同步 ==========

  sendChange(change: ContentChange): void {
    this.send({
      type: 'content-change',
      roomId: this.roomId,
      userId: this.localUser.id,
      change
    })
  }

  onRemoteChange(handler: (change: ContentChange) => void): void {
    this.changeHandlers.push(handler)
  }

  // ========== 光标同步 ==========

  sendCursor(position: CursorPosition): void {
    this.localUser.cursor = position

    this.send({
      type: 'cursor-move',
      roomId: this.roomId,
      userId: this.localUser.id,
      position
    })
  }

  onRemoteCursor(handler: (userId: string, position: CursorPosition) => void): void {
    this.cursorHandlers.push(handler)
  }

  // ========== 聊天 ==========

  sendMessage(message: string): void {
    const chatMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      userId: this.localUser.id,
      content: message,
      timestamp: new Date()
    }

    this.send({
      type: 'chat-message',
      roomId: this.roomId,
      message: chatMessage
    })
  }

  onMessage(handler: (message: ChatMessage) => void): void {
    this.messageHandlers.push(handler)
  }

  // ========== 事件处理 ==========

  onEvent(handler: CollaborationEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: CollaborationEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('协作事件处理器错误:', error)
      }
    }
  }

  // ========== 消息处理 ==========

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data)

      switch (message.type) {
        case 'user-join':
          this.handleUserJoin(message.user)
          break

        case 'user-leave':
          this.handleUserLeave(message.userId)
          break

        case 'cursor-move':
          this.handleRemoteCursor(message.userId, message.position)
          break

        case 'content-change':
          this.handleRemoteChange(message.change)
          break

        case 'chat-message':
          this.handleChatMessage(message.message)
          break

        case 'room-state':
          this.handleRoomState(message.room)
          break
      }
    } catch (error) {
      console.error('处理协作消息失败:', error)
    }
  }

  private handleUserJoin(user: CollaborationUser): void {
    // 添加到远程用户列表
    const existingIndex = this.remoteUsers.findIndex(u => u.id === user.id)
    if (existingIndex >= 0) {
      this.remoteUsers[existingIndex] = user
    } else {
      this.remoteUsers.push(user)
    }

    this.emitEvent({
      type: 'user-join',
      userId: user.id,
      timestamp: new Date(),
      data: { user }
    })
  }

  private handleUserLeave(userId: string): void {
    this.remoteUsers = this.remoteUsers.filter(u => u.id !== userId)

    this.emitEvent({
      type: 'user-leave',
      userId,
      timestamp: new Date(),
      data: {}
    })
  }

  private handleRemoteCursor(userId: string, position: CursorPosition): void {
    // 更新远程用户光标
    const user = this.remoteUsers.find(u => u.id === userId)
    if (user) {
      user.cursor = position
      user.lastActive = new Date()
    }

    // 通知处理器
    for (const handler of this.cursorHandlers) {
      handler(userId, position)
    }

    this.emitEvent({
      type: 'cursor-move',
      userId,
      timestamp: new Date(),
      data: { position }
    })
  }

  private handleRemoteChange(change: ContentChange): void {
    // 通知处理器
    for (const handler of this.changeHandlers) {
      handler(change)
    }

    this.emitEvent({
      type: 'content-change',
      userId: 'remote',
      timestamp: new Date(),
      data: { change }
    })
  }

  private handleChatMessage(message: ChatMessage): void {
    // 通知处理器
    for (const handler of this.messageHandlers) {
      handler(message)
    }

    this.emitEvent({
      type: 'chat-message',
      userId: message.userId,
      timestamp: new Date(),
      data: { message }
    })
  }

  private handleRoomState(room: CollaborationRoom): void {
    this.room = room
    this.remoteUsers = room.users.filter(u => u.id !== this.localUser.id)
  }

  // ========== 辅助方法 ==========

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private generateColor(userId: string): string {
    // 根据用户 ID 生成颜色
    let hash = 0
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash)
    }

    const hue = hash % 360
    return `hsl(${hue}, 70%, 50%)`
  }

  // ========== 状态查询 ==========

  getUsers(): CollaborationUser[] {
    return [this.localUser, ...this.remoteUsers]
  }

  getUserCount(): number {
    return 1 + this.remoteUsers.length
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}

/**
 * 实时协作类型定义
 *
 * 支持多用户实时协作功能
 */

// 用户状态
export type UserStatus = 'online' | 'away' | 'busy' | 'offline'

// 协作事件类型
export type CollaborationEventType =
  | 'user-join'
  | 'user-leave'
  | 'cursor-move'
  | 'selection-change'
  | 'content-change'
  | 'chat-message'
  | 'task-assign'
  | 'task-update'

// 协作用户
export interface CollaborationUser {
  id: string
  name: string
  avatar?: string
  color: string
  status: UserStatus
  cursor?: CursorPosition
  selection?: SelectionRange
  lastActive: Date
}

// 光标位置
export interface CursorPosition {
  line: number
  column: number
  file?: string
}

// 选择范围
export interface SelectionRange {
  start: CursorPosition
  end: CursorPosition
}

// 协作事件
export interface CollaborationEvent {
  type: CollaborationEventType
  userId: string
  timestamp: Date
  data: any
}

// 内容变更
export interface ContentChange {
  file: string
  operations: Operation[]
  version: number
}

// 操作类型
export interface Operation {
  type: 'insert' | 'delete' | 'replace'
  position: CursorPosition
  content?: string
  length?: number
}

// 聊天消息
export interface ChatMessage {
  id: string
  userId: string
  content: string
  timestamp: Date
  replyTo?: string
  mentions?: string[]
}

// 任务分配
export interface TaskAssignment {
  taskId: string
  assigneeId: string
  assignerId: string
  description: string
  deadline?: Date
}

// 协作房间
export interface CollaborationRoom {
  id: string
  name: string
  users: CollaborationUser[]
  documents: string[]
  createdAt: Date
  createdBy: string
}

// 协作配置
export interface CollaborationConfig {
  serverUrl?: string
  roomId?: string
  userId: string
  userName: string
  autoReconnect?: boolean
  heartbeatInterval?: number
}

// 协作事件处理器
export type CollaborationEventHandler = (event: CollaborationEvent) => void

// 协作适配器接口
export interface CollaborationAdapter {
  // 基本信息
  name: string
  roomId: string

  // 用户
  localUser: CollaborationUser
  remoteUsers: CollaborationUser[]

  // 生命周期
  connect(): Promise<void>
  disconnect(): Promise<void>

  // 房间管理
  joinRoom(roomId: string): Promise<void>
  leaveRoom(): Promise<void>

  // 内容同步
  sendChange(change: ContentChange): void
  onRemoteChange(handler: (change: ContentChange) => void): void

  // 光标同步
  sendCursor(position: CursorPosition): void
  onRemoteCursor(handler: (userId: string, position: CursorPosition) => void): void

  // 聊天
  sendMessage(message: string): void
  onMessage(handler: (message: ChatMessage) => void): void

  // 事件处理
  onEvent(handler: CollaborationEventHandler): void
}

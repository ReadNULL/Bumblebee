/**
 * 实时协作模块导出
 */

export { CollaborationRoomImpl } from './room.js'

export type {
  CollaborationRoom,
  CollaborationUser,
  CollaborationEvent,
  CollaborationEventHandler,
  CollaborationConfig,
  CollaborationAdapter,
  ContentChange,
  CursorPosition,
  ChatMessage,
  UserStatus,
  CollaborationEventType,
  SelectionRange,
  Operation,
  TaskAssignment
} from './types.js'

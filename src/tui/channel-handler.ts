import type { Message } from '../channels/types.js'

export function getChannelReplyTarget(message: Message): string {
  const metadata = message.metadata || {}

  if (message.sender.platform === 'wechat') {
    return metadata.roomName || metadata.roomId || message.sender.id || message.sender.name
  }

  if (message.sender.platform === 'feishu') {
    return metadata.chatId || message.sender.id
  }

  if (message.sender.platform === 'dingtalk') {
    return message.sender.id || metadata.conversationId
  }

  return message.sender.id || message.sender.name
}

export function shouldHandleChannelMessage(message: Message): boolean {
  if (!message.content?.trim()) return false
  if (message.type !== 'text' && message.type !== 'code') return false

  const metadata = message.metadata || {}
  if (message.sender.platform === 'wechat' && metadata.roomId && metadata.isMentionSelf === false) {
    return false
  }

  if (
    message.sender.platform === 'feishu' &&
    metadata.chatType &&
    metadata.chatType !== 'p2p' &&
    Array.isArray(metadata.mentionKeys) &&
    metadata.mentionKeys.length === 0
  ) {
    return false
  }

  return true
}

export function createChannelReply(message: Message, content: string): Message {
  return {
    id: `reply-${message.id}-${Date.now()}`,
    content,
    type: 'text',
    sender: {
      id: 'bumblebee',
      name: 'Bumblebee',
      platform: message.sender.platform,
    },
    timestamp: new Date(),
    metadata: {
      replyTo: message.id,
    },
  }
}

/**
 * WeixinBot channel adapter.
 *
 * 个人微信渠道适配器，基于 ilink API（Tencent/openclaw-weixin）。
 * 复用 pi-weixinbot 的核心实现，支持扫码登录、长轮询收消息、发送文本消息。
 *
 * token 自动缓存在 ~/.bumblebee/weixin/，重启后免扫码。
 */

import {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  Message,
  MessageHandler,
  MessageType,
  User,
} from './types.js'
import { fullQRLogin, getLoggedInAccounts, logoutAccount } from './weixinbot/weixin-auth.js'
import { getUpdates, sendMessage, DEFAULT_BASE_URL } from './weixinbot/weixin-api.js'
import type { WeixinMessage } from './weixinbot/types.js'

interface WeixinBotConfig extends ChannelConfig {
  name?: string
}

export class WeixinBotAdapter implements ChannelAdapter {
  name: string
  type: 'messaging' = 'messaging'
  description = 'WeChat personal account via ilink API (QR login, long-poll messages)'
  supports: ChannelCapabilities = {
    files: false,
    reactions: false,
    threads: false,
    mentions: false,
    richText: false,
    voice: false,
    video: false,
  }

  private messageHandler: MessageHandler | null = null
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private polling = false
  private token: string | null = null
  private baseUrl: string = DEFAULT_BASE_URL
  private botId: string = ''
  private userId: string = ''
  private updatesBuf = ''
  private qrCodeCallback: ((qr: string) => void) | null = null

  constructor(config: WeixinBotConfig = {}) {
    this.name = config.name || 'weixinbot'
  }

  async initialize(): Promise<void> {
    // 尝试恢复已有的登录账户
    const accounts = getLoggedInAccounts()
    if (accounts.length > 0) {
      const account = accounts[0]
      this.token = account.token || null
      this.baseUrl = account.baseUrl || DEFAULT_BASE_URL
      this.botId = account.accountId
      this.userId = account.userId || ''
    }
  }

  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') return

    this._status = 'connecting'

    try {
      if (!this.token) {
        // 需要扫码登录
        const result = await fullQRLogin({
          onQRCode: (url) => {
            this.qrCodeCallback?.(url)
          },
          onStatus: (status, message) => {
            if (status === 'confirmed') {
              this._status = 'connected'
            }
          },
        })

        if (!result.connected) {
          this._status = 'error'
          throw new Error(result.message)
        }

        this.token = result.botToken || null
        this.baseUrl = result.baseUrl || DEFAULT_BASE_URL
        this.botId = result.accountId || ''
        this.userId = result.userId || ''
      }

      this._status = 'connected'
      this.startPolling()
    } catch (error) {
      this._status = 'error'
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.polling = false
    this._status = 'disconnected'
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async sendMessage(target: string, message: Message): Promise<void> {
    if (!this.token) {
      throw new Error('WeixinBot is not connected.')
    }

    await sendMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      to: target,
      text: filterMarkdown(message.content),
      clientId: this.botId,
      contextToken: typeof message.metadata?.contextToken === 'string'
        ? message.metadata.contextToken
        : undefined,
    })
  }

  async getStatus(): Promise<'connected' | 'disconnected' | 'error'> {
    if (this._status === 'connecting') return 'disconnected'
    return this._status
  }

  /**
   * 注册二维码回调（供 TUI 显示）
   */
  onQrCode(callback: (qr: string) => void): void {
    this.qrCodeCallback = callback
  }

  /**
   * 登出当前账户（清除缓存的 token）
   */
  logout(): void {
    if (this.botId) {
      logoutAccount(this.botId)
    }
    this.token = null
    this.botId = ''
    this.userId = ''
    this._status = 'disconnected'
  }

  private startPolling(): void {
    this.polling = true
    void this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token || undefined,
          get_updates_buf: this.updatesBuf,
        })

        if (resp.get_updates_buf) {
          this.updatesBuf = resp.get_updates_buf
        }

        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            // 过滤掉 BOT 自己发的消息
            if (msg.message_type === 2) continue
            const converted = this.toMessage(msg)
            if (converted && this.messageHandler) {
              await this.messageHandler(converted).catch(err => {
                console.error('Failed to handle weixinbot message:', err)
              })
            }
          }
        }
      } catch (err) {
        if (!this.polling) break
        console.error('WeixinBot polling error:', err)
        // 短暂等待后重试
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  private toMessage(msg: WeixinMessage): Message | null {
    const items = msg.item_list || []
    let content = ''

    for (const item of items) {
      if (item.text_item?.text) {
        content += item.text_item.text
      }
    }

    if (!content) return null

    const sender: User = {
      id: msg.from_user_id || 'unknown',
      name: msg.from_user_id || 'Unknown user',
      platform: 'wechat',
    }

    return {
      id: String(msg.message_id || msg.seq || Date.now()),
      content,
      type: 'text',
      sender,
      timestamp: new Date(msg.create_time_ms || Date.now()),
      metadata: {
        mode: 'weixinbot',
        sessionId: msg.session_id,
        groupId: msg.group_id,
        roomId: msg.group_id,
        contextToken: msg.context_token,
      },
    }
  }
}

/**
 * 去除 Markdown 格式（WeChat 不支持 Markdown）
 */
function filterMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')       // **bold** → bold
    .replace(/\*(.*?)\*/g, '$1')             // *italic* → italic
    .replace(/`{3}[\s\S]*?`{3}/g, (match) => {
      // ```code block``` → code block content
      const lines = match.split('\n')
      return lines.slice(1, -1).join('\n') || match
    })
    .replace(/`(.*?)`/g, '$1')               // `inline` → inline
    .replace(/^#{1,6}\s+/gm, '')             // ### heading → heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/^[-*]\s+/gm, '• ')             // - item → • item
    .replace(/^\d+\.\s+/gm, (match) => match) // keep numbered lists
    .replace(/^>\s+/gm, '')                  // > quote → quote
    .replace(/~~(.*?)~~/g, '$1')             // ~~strike~~ → strike
    .trim()
}

export function createWeixinBotAdapter(config?: WeixinBotConfig): WeixinBotAdapter {
  return new WeixinBotAdapter(config)
}

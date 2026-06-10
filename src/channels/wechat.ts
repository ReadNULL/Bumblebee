/**
 * WeChat Official Account channel adapter.
 *
 * Uses the official WeChat Official Account callback API:
 * - GET callback verifies the server URL.
 * - POST callback receives Official Account messages.
 * - Replies are returned as passive XML replies when possible. If the passive
 *   window is missed, the adapter can fall back to the customer-service API
 *   when appId/appSecret are configured.
 *
 * For personal WeChat accounts, use the weixinbot mode (see weixinbot.ts).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { createHash } from 'crypto'
import type { Socket } from 'net'
import {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  Message,
  MessageHandler,
  MessageType,
  User,
} from './types.js'

interface WeChatConfig extends ChannelConfig {
  name?: string
  token?: string
  appId?: string
  appSecret?: string
  port?: number
  path?: string
  responseTimeoutMs?: number
}

interface PendingReply {
  resolve: (content: string | undefined) => void
}

interface OfficialAccessToken {
  token: string
  expiresAt: number
}

const DEFAULT_OFFICIAL_PORT = 3002
const DEFAULT_OFFICIAL_PATH = '/wechat'
const DEFAULT_RESPONSE_TIMEOUT_MS = 4500

export class WeChatAdapter implements ChannelAdapter {
  name: string
  type: 'messaging' = 'messaging'
  description = 'WeChat Official Account adapter (callback API)'
  supports: ChannelCapabilities = {
    files: false,
    reactions: false,
    threads: false,
    mentions: false,
    richText: false,
    voice: false,
    video: false,
  }

  private config: Required<Pick<WeChatConfig, 'port' | 'path' | 'responseTimeoutMs'>> & WeChatConfig
  private messageHandler: MessageHandler | null = null
  private _status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'

  private callbackServer: Server | null = null
  private callbackSockets: Set<Socket> = new Set()
  private pendingReplies: Map<string, PendingReply[]> = new Map()
  private officialAccessToken: OfficialAccessToken | null = null

  constructor(config: WeChatConfig = {}) {
    this.name = config.name || 'wechat'
    this.config = {
      ...config,
      port: config.port || Number(process.env.WECHAT_OFFICIAL_PORT) || DEFAULT_OFFICIAL_PORT,
      path: config.path || process.env.WECHAT_OFFICIAL_PATH || DEFAULT_OFFICIAL_PATH,
      responseTimeoutMs: config.responseTimeoutMs || DEFAULT_RESPONSE_TIMEOUT_MS,
      token: config.token || process.env.WECHAT_OFFICIAL_TOKEN || '',
      appId: config.appId || process.env.WECHAT_OFFICIAL_APP_ID,
      appSecret: config.appSecret || process.env.WECHAT_OFFICIAL_APP_SECRET,
    }
  }

  async initialize(): Promise<void> {
    // official-account 模式无需初始化
  }

  async connect(): Promise<void> {
    if (this._status === 'connecting' || this._status === 'connected') return

    this._status = 'connecting'
    try {
      await this.connectOfficialAccount()
      this._status = 'connected'
    } catch (error) {
      this._status = 'error'
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.callbackServer) {
      for (const socket of this.callbackSockets) {
        socket.destroy()
      }
      this.callbackSockets.clear()

      await new Promise<void>((resolve, reject) => {
        this.callbackServer!.close(error => error ? reject(error) : resolve())
      })
      this.callbackServer = null
    }

    this.pendingReplies.clear()
    this.officialAccessToken = null
    this._status = 'disconnected'
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async sendMessage(target: string, message: Message): Promise<void> {
    const pending = this.shiftPendingReply(target)
    if (pending) {
      pending.resolve(message.content)
      return
    }

    await this.sendOfficialCustomerMessage(target, message.content)
  }

  async getStatus(): Promise<'connected' | 'disconnected' | 'error'> {
    if (this._status === 'connecting') return 'disconnected'
    return this._status
  }

  private validateOfficialConfig(): void {
    if (!this.config.token?.trim()) {
      throw new Error('WeChat official-account mode requires channels.wechat.token or WECHAT_OFFICIAL_TOKEN.')
    }
  }

  private async connectOfficialAccount(): Promise<void> {
    this.validateOfficialConfig()
    if (this.callbackServer) return

    this.callbackServer = createServer((req, res) => {
      void this.handleOfficialRequest(req, res)
    })
    this.callbackServer.on('connection', socket => {
      this.callbackSockets.add(socket)
      socket.on('close', () => this.callbackSockets.delete(socket))
    })

    await new Promise<void>((resolve, reject) => {
      this.callbackServer!.once('error', reject)
      this.callbackServer!.listen(this.config.port, () => {
        this.callbackServer!.off('error', reject)
        resolve()
      })
    })
  }

  private async handleOfficialRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname !== this.config.path) {
      writeText(res, 404, 'not found')
      return
    }

    if (!this.verifyOfficialSignature(url)) {
      writeText(res, 403, 'invalid signature')
      return
    }

    if (req.method === 'GET') {
      writeText(res, 200, url.searchParams.get('echostr') || '')
      return
    }

    if (req.method !== 'POST') {
      writeText(res, 405, 'method not allowed')
      return
    }

    const body = await readRequestBody(req)
    const fields = parseXmlFields(body)
    const fromUserName = fields.FromUserName
    const toUserName = fields.ToUserName
    const msgType = fields.MsgType || 'text'

    if (!fromUserName || !toUserName) {
      writeText(res, 200, '')
      return
    }

    const message = this.toOfficialMessage(fields, msgType, fromUserName)
    if (!this.messageHandler) {
      writeText(res, 200, '')
      return
    }

    const reply = await this.dispatchOfficialMessage(message, fromUserName)
    if (reply) {
      writeXml(res, buildTextReplyXml(fromUserName, toUserName, reply))
    } else {
      writeText(res, 200, '')
    }
  }

  private verifyOfficialSignature(url: URL): boolean {
    const signature = url.searchParams.get('signature') || ''
    const timestamp = url.searchParams.get('timestamp') || ''
    const nonce = url.searchParams.get('nonce') || ''
    const digest = createHash('sha1')
      .update([this.config.token, timestamp, nonce].sort().join(''))
      .digest('hex')
    return digest === signature
  }

  private async dispatchOfficialMessage(message: Message, target: string): Promise<string | undefined> {
    const replyPromise = new Promise<string | undefined>(resolve => {
      const replies = this.pendingReplies.get(target) || []
      replies.push({ resolve })
      this.pendingReplies.set(target, replies)
    })

    void this.messageHandler!(message).catch(error => {
      console.error('Failed to handle WeChat Official Account message:', error)
    })

    const reply = await Promise.race([
      replyPromise,
      delay<string | undefined>(this.config.responseTimeoutMs, undefined),
    ])

    if (!reply) {
      this.removePendingReply(target)
    }

    return reply
  }

  private toOfficialMessage(fields: Record<string, string>, msgType: string, fromUserName: string): Message {
    const type = toMessageType(msgType)
    const content = type === 'text'
      ? (fields.Content || '')
      : `[${msgType}]`

    const sender: User = {
      id: fromUserName,
      name: fromUserName,
      platform: 'wechat',
    }

    return {
      id: fields.MsgId || `wechat-${Date.now()}`,
      content,
      type,
      sender,
      timestamp: new Date(Number(fields.CreateTime || Math.floor(Date.now() / 1000)) * 1000),
      metadata: {
        mode: 'official-account',
        toUserName: fields.ToUserName,
        fromUserName,
        msgType,
      },
    }
  }

  private shiftPendingReply(target: string): PendingReply | undefined {
    const replies = this.pendingReplies.get(target)
    if (!replies?.length) return undefined

    const reply = replies.shift()
    if (replies.length === 0) {
      this.pendingReplies.delete(target)
    }
    return reply
  }

  private removePendingReply(target: string): void {
    const replies = this.pendingReplies.get(target)
    if (!replies?.length) return

    replies.shift()
    if (replies.length === 0) {
      this.pendingReplies.delete(target)
    }
  }

  private async sendOfficialCustomerMessage(openId: string, content: string): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('WeChat customer-service replies require appId/appSecret after the passive reply window has expired.')
    }

    const accessToken = await this.ensureOfficialAccessToken()
    const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openId,
        msgtype: 'text',
        text: { content },
      }),
    })

    const result = await response.json() as any
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`WeChat customer-service message failed: ${result.errmsg || result.errcode}`)
    }
  }

  private async ensureOfficialAccessToken(): Promise<string> {
    if (this.officialAccessToken && Date.now() < this.officialAccessToken.expiresAt) {
      return this.officialAccessToken.token
    }

    const response = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.config.appId!)}&secret=${encodeURIComponent(this.config.appSecret!)}`
    )
    const result = await response.json() as any
    if (!result.access_token) {
      throw new Error(`Failed to get WeChat access_token: ${result.errmsg || JSON.stringify(result)}`)
    }

    this.officialAccessToken = {
      token: result.access_token,
      expiresAt: Date.now() + Math.max(60, Number(result.expires_in || 7200) - 300) * 1000,
    }
    return this.officialAccessToken.token
  }
}

function toMessageType(type: string | number): MessageType {
  if (type === 'text' || type === 1) return 'text'
  if (type === 'image' || type === 2) return 'image'
  if (type === 'video' || type === 3) return 'video'
  if (type === 'voice' || type === 4) return 'voice'
  if (type === 'file' || type === 5) return 'file'
  return 'text'
}

function parseXmlFields(xml: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const payload = xml
    .replace(/^\s*<xml>\s*/i, '')
    .replace(/\s*<\/xml>\s*$/i, '')
  const pattern = /<([A-Za-z0-9_]+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<([A-Za-z0-9_]+)>([\s\S]*?)<\/\3>/g

  for (const match of payload.matchAll(pattern)) {
    const key = match[1] || match[3]
    const value = match[2] || match[4] || ''
    fields[key] = value.trim()
  }
  return fields
}

function buildTextReplyXml(toUserName: string, fromUserName: string, content: string): string {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${toUserName}]]></ToUserName>`,
    `<FromUserName><![CDATA[${fromUserName}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${sanitizeCdata(content)}]]></Content>`,
    '</xml>',
  ].join('')
}

function sanitizeCdata(value: string): string {
  return value.replace(/\]\]>/g, ']]]]><![CDATA[>')
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function writeXml(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
  res.end(body)
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms))
}

export function createWeChatAdapter(config?: WeChatConfig): WeChatAdapter {
  return new WeChatAdapter(config)
}

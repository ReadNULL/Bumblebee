import { extractText } from './knowledge-extractor.js'

export interface SessionMessage {
  role: string
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
}

export interface SessionBufferOptions {
  maxMessages: number
  maxChars: number
  compactAtRatio: number
  tailMessages: number
}

const DEFAULT_OPTIONS: SessionBufferOptions = {
  maxMessages: 220,
  maxChars: 120_000,
  compactAtRatio: 0.9,
  tailMessages: 60,
}

export class SessionBuffer {
  private messages: SessionMessage[] = []
  private compressedSummary = ''
  private readonly options: SessionBufferOptions

  constructor(options: Partial<SessionBufferOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  replace(messages: SessionMessage[]): void {
    this.messages = [...messages]
    this.compactIfNeeded()
  }

  getMessages(): SessionMessage[] {
    return [...this.messages]
  }

  getRecentUserMessage(): SessionMessage | undefined {
    return [...this.messages].reverse().find(message => message.role === 'user')
  }

  getCompressedSummary(): string {
    return this.compressedSummary
  }

  isEmpty(): boolean {
    return this.messages.length === 0 && !this.compressedSummary
  }

  private compactIfNeeded(): void {
    const totalChars = this.messages.reduce((sum, message) => sum + extractText(message.content).length, 0)
    const messageThreshold = this.options.maxMessages * this.options.compactAtRatio
    const charThreshold = this.options.maxChars * this.options.compactAtRatio

    if (this.messages.length < messageThreshold && totalChars < charThreshold) return

    const tail = this.messages.slice(-this.options.tailMessages)
    const head = this.messages.slice(0, Math.max(0, this.messages.length - tail.length))
    const summary = summarizeMessages(head)

    this.compressedSummary = summary.slice(-8000)
    this.messages = this.compressedSummary
      ? [{ role: 'system', content: `Earlier conversation summary:\n${this.compressedSummary}` }, ...tail]
      : tail
  }
}

function summarizeMessages(messages: SessionMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractText(message.content).trim()
    if (!text) continue
    const body = text.length > 500 ? `${text.slice(0, 500)}...` : text
    lines.push(`${message.role}: ${body}`)
  }
  return lines.slice(-40).join('\n')
}

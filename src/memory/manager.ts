export interface MemoryConfig {
  enabled: boolean
  maxHistory: number
}

interface MemoryEntry {
  id: string
  timestamp: Date
  input: string
  output: string
  context: Record<string, any>
  relevance: number
}

export class MemoryManager {
  private config: MemoryConfig
  private shortTerm: MemoryEntry[] = []
  private longTerm: Map<string, MemoryEntry> = new Map()

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = {
      enabled: config.enabled !== false,
      maxHistory: config.maxHistory || 100
    }
  }

  // 检索相关记忆
  async recall(query: string): Promise<string> {
    if (!this.config.enabled) {
      return ''
    }

    // 检索短期记忆
    const recentMemories = this.shortTerm
      .filter(m => this.isRelevant(m, query))
      .slice(-5)

    // 检索长期记忆
    const longTermMemories = Array.from(this.longTerm.values())
      .filter(m => this.isRelevant(m, query))
      .slice(-3)

    // 合并记忆
    const allMemories = [...recentMemories, ...longTermMemories]

    if (allMemories.length === 0) {
      return ''
    }

    // 格式化记忆上下文
    return this.formatMemories(allMemories)
  }

  // 保存记忆
  async remember(input: string, output: string): Promise<void> {
    if (!this.config.enabled) {
      return
    }

    const entry: MemoryEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      input,
      output,
      context: {},
      relevance: 1.0
    }

    // 添加到短期记忆
    this.shortTerm.push(entry)

    // 限制短期记忆大小
    if (this.shortTerm.length > this.config.maxHistory) {
      const removed = this.shortTerm.shift()
      // 评估是否提升到长期记忆
      if (removed && this.shouldPromoteToLongTerm(removed)) {
        this.longTerm.set(removed.id, removed)
      }
    }
  }

  // 清空记忆
  clear(): void {
    this.shortTerm = []
    this.longTerm.clear()
  }

  // 获取记忆统计
  getStats(): { shortTerm: number; longTerm: number } {
    return {
      shortTerm: this.shortTerm.length,
      longTerm: this.longTerm.size
    }
  }

  // 判断记忆是否相关
  private isRelevant(memory: MemoryEntry, query: string): boolean {
    const keywords = query.toLowerCase().split(/\s+/)
    const content = `${memory.input} ${memory.output}`.toLowerCase()

    return keywords.some(keyword => content.includes(keyword))
  }

  // 判断是否应该提升到长期记忆
  private shouldPromoteToLongTerm(memory: MemoryEntry): boolean {
    return memory.relevance > 0.7
  }

  // 格式化记忆
  private formatMemories(memories: MemoryEntry[]): string {
    return memories
      .map(m => {
        const time = m.timestamp.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        })
        const inputPreview = m.input.length > 50
          ? m.input.substring(0, 50) + '...'
          : m.input
        return `[${time}] ${inputPreview}`
      })
      .join('\n')
  }

  // 生成 ID
  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }
}

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export interface MemoryConfig {
  enabled: boolean
  storageDir?: string
}

export interface UserProfile {
  // 结构化偏好
  language?: string
  codeStyle?: string
  verbosity?: 'concise' | 'normal' | 'detailed'
  theme?: string

  // 自由文本偏好
  preferences: string[]
  environment: Record<string, string>
  facts: string[]

  lastUpdated: string
}

const DEFAULT_STORAGE_DIR = join(homedir(), '.bumblebee', 'memory')
const PROFILE_FILE = 'profile.json'

const EMPTY_PROFILE: UserProfile = {
  preferences: [],
  environment: {},
  facts: [],
  lastUpdated: ''
}

function createEmptyProfile(): UserProfile {
  return {
    preferences: [],
    environment: {},
    facts: [],
    lastUpdated: ''
  }
}

export class MemoryManager {
  private config: MemoryConfig
  private profile: UserProfile = createEmptyProfile()
  private storageDir: string
  private initialized = false

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = {
      enabled: config.enabled !== false,
      storageDir: config.storageDir
    }
    this.storageDir = this.config.storageDir || DEFAULT_STORAGE_DIR
  }

  // 初始化（从磁盘加载画像）
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await this.loadProfile()
  }

  // ========== 用户画像 ==========

  // 获取用户画像
  getProfile(): UserProfile {
    return { ...this.profile }
  }

  // 更新用户画像（合并去重，持久化）
  async updateProfile(updates: Partial<UserProfile>): Promise<void> {
    if (updates.language !== undefined) {
      this.profile.language = updates.language
    }
    if (updates.codeStyle !== undefined) {
      this.profile.codeStyle = updates.codeStyle
    }
    if (updates.verbosity !== undefined) {
      this.profile.verbosity = updates.verbosity
    }
    if (updates.theme !== undefined) {
      this.profile.theme = updates.theme
    }

    if (updates.preferences) {
      const existing = new Set(this.profile.preferences)
      for (const pref of updates.preferences) {
        if (!existing.has(pref)) {
          this.profile.preferences.push(pref)
          existing.add(pref)
        }
      }
    }

    if (updates.environment) {
      Object.assign(this.profile.environment, updates.environment)
    }

    if (updates.facts) {
      const existing = new Set(this.profile.facts)
      for (const fact of updates.facts) {
        if (!existing.has(fact)) {
          this.profile.facts.push(fact)
          existing.add(fact)
        }
      }
    }

    this.profile.lastUpdated = new Date().toISOString()
    await this.saveProfile()
  }

  // 将画像格式化为 system prompt 上下文
  getContextPrompt(): string {
    const parts: string[] = []

    // 结构化偏好
    if (this.profile.language) {
      parts.push(`编程语言偏好: ${this.profile.language}`)
    }
    if (this.profile.codeStyle) {
      parts.push(`代码风格: ${this.profile.codeStyle}`)
    }
    if (this.profile.verbosity) {
      parts.push(`详细程度: ${this.profile.verbosity}`)
    }

    // 自由文本偏好
    if (this.profile.preferences.length > 0) {
      parts.push(`用户偏好：\n${this.profile.preferences.map(p => `- ${p}`).join('\n')}`)
    }

    const envEntries = Object.entries(this.profile.environment)
    if (envEntries.length > 0) {
      parts.push(`用户环境：\n${envEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`)
    }

    if (this.profile.facts.length > 0) {
      parts.push(`重要事实：\n${this.profile.facts.map(f => `- ${f}`).join('\n')}`)
    }

    return parts.length > 0 ? `\n## 已知用户画像\n${parts.join('\n\n')}` : ''
  }

  // 获取画像统计
  getStats(): { preferences: number; facts: number; environmentKeys: number } {
    return {
      preferences: this.profile.preferences.length,
      facts: this.profile.facts.length,
      environmentKeys: Object.keys(this.profile.environment).length
    }
  }

  // 清空画像
  async clear(): Promise<void> {
    this.profile = createEmptyProfile()
    await this.saveProfile()
  }

  // ========== 画像持久化 ==========

  // 确保存储目录存在
  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.storageDir, { recursive: true })
    } catch {
      // 目录已存在，忽略
    }
  }

  // 从磁盘加载画像
  private async loadProfile(): Promise<void> {
    try {
      const filePath = join(this.storageDir, PROFILE_FILE)
      const content = await readFile(filePath, 'utf-8')
      this.profile = { ...EMPTY_PROFILE, ...JSON.parse(content) }
    } catch {
      // 文件不存在，使用空画像
    }
  }

  // 保存画像到磁盘
  private async saveProfile(): Promise<void> {
    try {
      await this.ensureDirectory()
      const filePath = join(this.storageDir, PROFILE_FILE)
      await writeFile(filePath, JSON.stringify(this.profile, null, 2), 'utf-8')
    } catch {
      // 写入失败，静默忽略
    }
  }
}

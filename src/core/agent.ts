import { SessionManager } from '@earendil-works/pi-coding-agent'
import { join } from 'path'
import { homedir } from 'os'
import { BumblebeePersonality } from '../personality/traits.js'
import { RoleManager } from '../roles/manager.js'
import { RoleConfig } from '../roles/types.js'
import { MemoryManager } from '../memory/manager.js'
import { BumblebeeConfig } from './config.js'
import { callLLM, type LLMCallResult } from './session-factory.js'

const DEFAULT_MEMORY_DIR = join(homedir(), '.bumblebee', 'memory')

export interface BumblebeeAgentConfig {
  personality?: {
    intensity?: 'low' | 'moderate' | 'high'
    theme?: 'transformers' | 'neutral'
    roleId?: string
  }
  memory?: {
    enabled?: boolean
    maxHistory?: number
  }
  ai?: {
    provider?: string
    model?: string
  }
  rolesDir?: string  // 自定义角色存储目录
}

export class BumblebeeAgent {
  private personality: BumblebeePersonality
  private roleManager: RoleManager
  private memory: MemoryManager
  private config: BumblebeeConfig
  private sessionManager: SessionManager | null = null

  constructor(config: BumblebeeConfig, rolesDir?: string, memoryDir?: string) {
    this.config = config

    // 初始化角色管理器
    this.roleManager = new RoleManager(rolesDir)

    // 初始化人格系统
    this.personality = new BumblebeePersonality(config.personality)

    // 初始化记忆系统
    this.memory = new MemoryManager({
      ...config.memory,
      storageDir: memoryDir || DEFAULT_MEMORY_DIR
    })
  }

  // 初始化（需要调用）
  async initialize(): Promise<void> {
    // 初始化角色管理器
    await this.roleManager.initialize()

    // 初始化记忆系统（从磁盘加载画像）
    await this.memory.initialize()

    // 初始化持久化 SessionManager
    this.sessionManager = SessionManager.create(process.cwd())

    // 如果配置中指定了角色，切换到该角色
    if (this.config.personality.roleId) {
      this.roleManager.switchRole(this.config.personality.roleId)
    }

    // 确保有当前角色
    if (!this.roleManager.getCurrentRole()) {
      throw new Error('没有可用的角色')
    }
  }

  // 释放资源
  dispose(): void {
    // SessionManager 不需要显式 dispose
    this.sessionManager = null
  }

  // 启动 Agent
  async start(): Promise<void> {
    // 确保已初始化
    if (!this.roleManager.getCurrentRole()) {
      await this.initialize()
    }

    // 显示启动消息
    console.log(this.roleManager.getGreeting())

    // 显示角色信息
    const role = this.roleManager.getCurrentRole()
    console.log(`\n当前角色: ${role.name}`)
    console.log(`角色描述: ${role.description}`)

    // 显示配置信息
    console.log(`\n配置信息:`)
    console.log(`  - 人格强度: ${this.config.personality.intensity}`)
    console.log(`  - AI 提供商: ${this.config.ai.provider}`)
    console.log(`  - 模型: ${this.config.ai.model}`)
    console.log(`  - 记忆系统: ${this.config.memory.enabled ? '启用' : '禁用'}`)
    console.log(`  - 角色目录: ${this.roleManager.getRolesDir()}`)
    console.log('')
  }

  // 处理消息
  async processMessage(message: string): Promise<string> {
    // 构建提示词（包含角色信息 + 用户画像）
    const systemPrompt = this.roleManager.getSystemPrompt()
    const profilePrompt = this.memory.getContextPrompt()

    // 调用 AI（SessionManager 自动管理对话历史）
    const result = await this.generateResponse(systemPrompt + profilePrompt, message)

    // 应用角色风格
    const styledResponse = this.roleManager.applyRoleStyle(result.text)

    // 应用人格特征
    const personalized = this.personality.apply(styledResponse)

    return personalized
  }

  // 生成响应（通过 pi-coding-agent SDK 调用 AI）
  private async generateResponse(systemPrompt: string, userPrompt: string): Promise<LLMCallResult> {
    return callLLM({
      systemPrompt,
      userPrompt,
      sessionManager: this.sessionManager ?? undefined,
      disposeAfter: !this.sessionManager,
    })
  }

  // ========== 角色管理 ==========

  // 获取当前角色
  getCurrentRole(): RoleConfig {
    return this.roleManager.getCurrentRole()
  }

  // 切换角色
  switchRole(roleId: string): boolean {
    return this.roleManager.switchRole(roleId)
  }

  // 获取所有可用角色
  getAvailableRoles(): Array<{ id: string; name: string; description: string }> {
    return this.roleManager.getRoleSummaries().map(s => ({
      id: s.id,
      name: s.name,
      description: s.description
    }))
  }

  // 创建角色（交互式）
  async createRoleInteractive(): Promise<RoleConfig | null> {
    return this.roleManager.createRoleInteractive()
  }

  // 创建角色（编程式）
  async createRole(input: Parameters<RoleManager['createRole']>[0]): Promise<RoleConfig> {
    return this.roleManager.createRole(input)
  }

  // 删除角色
  async deleteRole(roleId: string): Promise<boolean> {
    return this.roleManager.deleteRole(roleId)
  }

  // 搜索角色
  searchRoles(query: string): RoleConfig[] {
    return this.roleManager.searchRoles(query)
  }

  // 获取角色摘要
  getRoleSummary(): {
    id: string
    name: string
    description: string
    traits: string[]
    expertise: string[]
    capabilities: string[]
  } {
    return this.roleManager.getRoleSummary()
  }

  // ========== 记忆管理 ==========

  // 获取记忆统计
  getMemoryStats(): { preferences: number; facts: number; environmentKeys: number } {
    return this.memory.getStats()
  }

  // 清空记忆
  async clearMemory(): Promise<void> {
    await this.memory.clear()
  }

  // 获取记忆管理器（供 TUI 扩展使用）
  getMemoryManager(): MemoryManager {
    return this.memory
  }

  // ========== 人格管理 ==========

  // 获取人格信息
  getPersonality(): {
    mood: string
    config: { intensity: string; theme: string }
  } {
    return {
      mood: this.personality.getMood(),
      config: this.personality.getConfig()
    }
  }

  // ========== 配置管理 ==========

  // 获取配置
  getConfig(): BumblebeeConfig {
    return { ...this.config }
  }

  // 获取角色管理器
  getRoleManager(): RoleManager {
    return this.roleManager
  }
}

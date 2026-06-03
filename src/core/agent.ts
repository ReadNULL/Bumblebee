import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { BumblebeePersonality } from '../personality/traits.js'
import { RoleManager } from '../roles/manager.js'
import { RoleConfig } from '../roles/types.js'
import { MemoryManager } from '../memory/manager.js'
import { BumblebeeConfig } from './config.js'

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

  constructor(config: BumblebeeConfig, rolesDir?: string) {
    this.config = config

    // 初始化角色管理器
    this.roleManager = new RoleManager(rolesDir)

    // 初始化人格系统
    this.personality = new BumblebeePersonality(config.personality)

    // 初始化记忆系统
    this.memory = new MemoryManager(config.memory)
  }

  // 初始化（需要调用）
  async initialize(): Promise<void> {
    // 初始化角色管理器
    await this.roleManager.initialize()

    // 如果配置中指定了角色，切换到该角色
    if (this.config.personality.roleId) {
      this.roleManager.switchRole(this.config.personality.roleId)
    }

    // 确保有当前角色
    if (!this.roleManager.getCurrentRole()) {
      throw new Error('没有可用的角色')
    }
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
    // 检索相关记忆
    const context = await this.memory.recall(message)

    // 构建提示词（包含角色信息）
    const systemPrompt = this.roleManager.getSystemPrompt()
    let prompt = message
    if (context) {
      prompt = `相关上下文:\n${context}\n\n用户消息: ${message}`
    }

    // 调用 AI 生成响应
    const response = await this.generateResponse(systemPrompt, prompt)

    // 应用角色风格
    const styledResponse = this.roleManager.applyRoleStyle(response)

    // 应用人格特征
    const personalized = this.personality.apply(styledResponse)

    // 保存记忆
    await this.memory.remember(message, personalized)

    return personalized
  }

  // 生成响应（通过 pi-coding-agent SDK 调用 AI）
  private async generateResponse(systemPrompt: string, userPrompt: string): Promise<string> {
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: { tools: new Map(), commands: new Map(), shortcuts: new Map(), flags: new Map(), messageRenderers: new Map(), providers: new Map(), eventHandlers: new Map() } as any }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt,
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {},
      },
    })

    let response = ''
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        response += event.assistantMessageEvent.delta
      }
    })

    try {
      await session.prompt(userPrompt)
      return response || '(无响应)'
    } finally {
      unsubscribe()
      session.dispose()
    }
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
  getMemoryStats(): { shortTerm: number; longTerm: number } {
    return this.memory.getStats()
  }

  // 清空记忆
  clearMemory(): void {
    this.memory.clear()
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

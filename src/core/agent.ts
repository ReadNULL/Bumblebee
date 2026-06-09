import { SessionManager } from '@earendil-works/pi-coding-agent'
import { join } from 'path'
import { homedir } from 'os'
import { BumblebeePersonality } from '../personality/traits.js'
import { RoleManager } from '../roles/manager.js'
import { RoleConfig } from '../roles/types.js'
import { MemoryManager } from '../memory/manager.js'
import { KnowledgeGraph } from '../knowledge/graph.js'
import { ContextManager } from '../knowledge/context.js'
import { Learner } from '../knowledge/learner.js'
import { AgentManager } from '../agents/manager.js'
import { AgentOrchestrator } from '../agents/orchestrator.js'
import { WorkflowEngine } from '../workflows/engine.js'
import { getWorkflowTemplateIds, createWorkflowFromTemplate } from '../workflows/templates.js'
import { LRUCache, ConcurrencyController, PerformanceMonitor } from '../performance/optimizer.js'
import { DashboardImpl, createDefaultDashboard } from '../dashboard/dashboard.js'
import type { CollaborationRoomImpl } from '../collaboration/room.js'
import type { VoiceEngineImpl } from '../voice/engine.js'
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
  private knowledge: KnowledgeGraph
  private context: ContextManager
  private learner: Learner
  private agentManager: AgentManager | null = null
  private agentOrchestrator: AgentOrchestrator | null = null
  private workflowEngine: WorkflowEngine | null = null
  private cache: LRUCache<any> | null = null
  private concurrency: ConcurrencyController | null = null
  private performanceMonitor: PerformanceMonitor | null = null
  private dashboard: DashboardImpl | null = null
  private collaborationRoom: CollaborationRoomImpl | null = null
  private voiceEngine: VoiceEngineImpl | null = null
  private config: BumblebeeConfig
  private sessionManager: SessionManager | null = null

  constructor(config: BumblebeeConfig, rolesDir?: string, memoryDir?: string) {
    this.config = config

    const memDir = memoryDir || DEFAULT_MEMORY_DIR

    // 初始化角色管理器
    this.roleManager = new RoleManager(rolesDir)

    // 初始化人格系统
    this.personality = new BumblebeePersonality(config.personality)

    // 初始化记忆系统
    this.memory = new MemoryManager({
      ...config.memory,
      storageDir: memDir
    })

    // 初始化知识系统
    this.knowledge = new KnowledgeGraph(join(memDir, 'knowledge-graph.json'))
    this.context = new ContextManager()
    this.learner = new Learner(config.knowledge?.maxRecords ?? 1000, join(memDir, 'learner.json'))

    // 初始化性能子系统
    const perf = config.performance
    if (perf?.enabled !== false && perf?.cache) {
      this.cache = new LRUCache({
        maxSize: perf.cache.maxSize,
        ttl: perf.cache.ttl,
        evictionPolicy: perf.cache.evictionPolicy,
      })
      this.concurrency = new ConcurrencyController({
        maxConcurrent: perf.concurrency.maxConcurrent,
        queueSize: perf.concurrency.queueSize,
        timeout: perf.concurrency.timeout,
      })
      this.performanceMonitor = new PerformanceMonitor()
    }

    // 初始化 Agent 系统（依赖 roleManager）
    if (config.agents?.enabled !== false) {
      this.agentManager = new AgentManager(this.roleManager, {
        ai: this.config.ai,
        concurrency: this.concurrency,
        performanceMonitor: this.performanceMonitor,
      })
      this.agentOrchestrator = new AgentOrchestrator(this.agentManager)
    }
  }

  // 初始化（需要调用）
  async initialize(): Promise<void> {
    // 初始化角色管理器
    await this.roleManager.initialize()

    // 初始化记忆系统（从磁盘加载画像）
    await this.memory.initialize()

    // 初始化知识系统（从磁盘加载持久化数据）
    await this.knowledge.load()
    await this.learner.load()
    this.context.setMemoryManager(this.memory)
    await this.context.detectEnvironment()

    // 初始化 Agent 系统
    if (this.agentManager) {
      await this.agentManager.initialize()
    }

    // 初始化工作流引擎（依赖 agentManager）
    if (this.config.workflows?.enabled !== false && this.agentManager) {
      this.workflowEngine = new WorkflowEngine(this.agentManager)
      for (const templateId of getWorkflowTemplateIds()) {
        this.workflowEngine.register(createWorkflowFromTemplate(templateId))
      }
    }

    // 初始化仪表盘
    if (this.config.dashboard?.enabled && this.performanceMonitor) {
      const dashConfig = createDefaultDashboard()
      dashConfig.refreshInterval = this.config.dashboard.refreshInterval
      this.dashboard = new DashboardImpl(dashConfig)
      await this.dashboard.initialize()
    }

    // 协作模块（懒加载，依赖浏览器 WebSocket）
    if (this.config.collaboration?.enabled) {
      try {
        const { CollaborationRoomImpl } = await import('../collaboration/room.js')
        this.collaborationRoom = new CollaborationRoomImpl({
          serverUrl: this.config.collaboration.serverUrl,
          userId: this.config.collaboration.userId,
          userName: this.config.collaboration.userName,
          autoReconnect: this.config.collaboration.autoReconnect,
          heartbeatInterval: this.config.collaboration.heartbeatInterval,
        })
      } catch {
        console.warn('协作模块在当前环境不可用')
      }
    }

    // 语音模块（懒加载，依赖浏览器 API）
    if (this.config.voice?.enabled) {
      try {
        const { VoiceEngineImpl } = await import('../voice/engine.js')
        this.voiceEngine = new VoiceEngineImpl({
          engine: this.config.voice.engine,
          language: this.config.voice.language,
          continuous: this.config.voice.continuous,
          interimResults: this.config.voice.interimResults,
        })
        await this.voiceEngine.initialize()
      } catch {
        console.warn('语音模块在当前环境不可用')
        this.voiceEngine = null
      }
    }

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
  async dispose(): Promise<void> {
    this.workflowEngine = null
    this.agentOrchestrator = null
    this.agentManager = null
    if (this.dashboard) {
      await this.dashboard.destroy()
      this.dashboard = null
    }
    this.performanceMonitor = null
    this.concurrency = null
    this.cache = null
    if (this.voiceEngine) {
      await this.voiceEngine.destroy()
      this.voiceEngine = null
    }
    if (this.collaborationRoom) {
      await this.collaborationRoom.disconnect()
      this.collaborationRoom = null
    }
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
      ai: this.config.ai,
      concurrency: this.concurrency,
      performanceMonitor: this.performanceMonitor,
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

  // ========== 知识系统 ==========

  // 获取知识图谱
  getKnowledge(): KnowledgeGraph {
    return this.knowledge
  }

  // 获取上下文管理器
  getContext(): ContextManager {
    return this.context
  }

  // 获取学习器
  getLearner(): Learner {
    return this.learner
  }

  // ========== Agent 系统 ==========

  // 获取 Agent 管理器
  getAgentManager(): AgentManager | null {
    return this.agentManager
  }

  // 获取 Agent 编排器
  getAgentOrchestrator(): AgentOrchestrator | null {
    return this.agentOrchestrator
  }

  // 获取工作流引擎
  getWorkflowEngine(): WorkflowEngine | null {
    return this.workflowEngine
  }

  // ========== 性能系统 ==========

  // 获取 LRU 缓存
  getCache<T = any>(): LRUCache<T> | null {
    return this.cache
  }

  // 获取并发控制器
  getConcurrency(): ConcurrencyController | null {
    return this.concurrency
  }

  // 获取性能监控器
  getPerformanceMonitor(): PerformanceMonitor | null {
    return this.performanceMonitor
  }

  // 获取仪表盘
  getDashboard(): DashboardImpl | null {
    return this.dashboard
  }

  // ========== 协作 + 语音 ==========

  // 获取协作房间
  getCollaborationRoom(): CollaborationRoomImpl | null {
    return this.collaborationRoom
  }

  // 获取语音引擎
  getVoiceEngine(): VoiceEngineImpl | null {
    return this.voiceEngine
  }
}

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
import { DashboardImpl, createDefaultDashboard } from '../dashboard/dashboard.js'
import type { CollaborationRoomImpl } from '../collaboration/room.js'
import type { VoiceEngineImpl } from '../voice/engine.js'
import { BumblebeeConfig } from './config.js'
import { callLLM, type LLMCallResult } from './session-factory.js'
import { createBumblebeeAgentTools } from './agent-tools.js'

const DEFAULT_MEMORY_DIR = join(homedir(), '.bumblebee', 'memory')

export interface BumblebeeAgentConfig {
  personality?: {
    intensity?: 'low' | 'moderate' | 'high'
    theme?: 'transformers' | 'neutral'
    roleId?: string
  }
  memory?: {
    enabled?: boolean
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
  private dashboard: DashboardImpl | null = null
  private collaborationRoom: CollaborationRoomImpl | null = null
  private voiceEngine: VoiceEngineImpl | null = null
  private unsubscribeAgentMetrics: (() => void) | null = null
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

    // 初始化 Agent 系统（依赖 roleManager）
    if (config.agents?.enabled !== false) {
      this.agentManager = new AgentManager(this.roleManager, {
        llm: this.config.llm,
        maxConcurrent: this.config.agents.maxConcurrent,
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
      this.workflowEngine = new WorkflowEngine(this.agentManager, {
        defaultTimeout: this.config.workflows.defaultTimeout,
        maxConcurrent: this.config.workflows.maxConcurrentWorkflows,
      })
      for (const templateId of getWorkflowTemplateIds()) {
        this.workflowEngine.register(createWorkflowFromTemplate(templateId))
      }
    }

    // 初始化仪表盘
    if (this.config.dashboard?.enabled) {
      const dashConfig = createDefaultDashboard()
      dashConfig.refreshInterval = this.config.dashboard.refreshInterval
      this.dashboard = new DashboardImpl(dashConfig)
      await this.dashboard.initialize()
      this.syncDashboardMetrics()
      this.unsubscribeAgentMetrics = this.agentManager?.onTaskCompleted(metric => {
        this.syncDashboardMetrics()
        this.dashboard?.addTimeSeries({
          timestamp: metric.timestamp,
          values: { duration: metric.duration },
        })
      }) ?? null
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
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`协作模块在当前环境不可用: ${reason}`)
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
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`语音模块在当前环境不可用: ${reason}`)
        this.voiceEngine = null
      }
    }

    // 初始化持久化 SessionManager
    this.sessionManager = SessionManager.create(process.cwd())

    // 如果配置中指定了角色，切换到该角色
    if (this.config.personality.roleId) {
      this.roleManager.switchRole(this.config.personality.roleId)
    }

  }

  // 释放资源
  async dispose(): Promise<void> {
    this.unsubscribeAgentMetrics?.()
    this.unsubscribeAgentMetrics = null
    this.workflowEngine = null
    this.agentOrchestrator = null
    this.agentManager = null
    if (this.dashboard) {
      await this.dashboard.destroy()
      this.dashboard = null
    }
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
    console.log('  - 模型: 由 pi-coding-agent /model 管理')
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
      timeoutMs: this.config.llm.timeoutMs,
      customTools: createBumblebeeAgentTools(this),
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

  // ========== 仪表盘 ==========

  // 获取仪表盘
  getDashboard(): DashboardImpl | null {
    this.syncDashboardMetrics()
    return this.dashboard
  }

  private syncDashboardMetrics(): void {
    if (!this.dashboard || !this.agentManager) return
    const agents = this.agentManager.getStats()
    const performance = this.agentManager.getPerformanceStats()
    this.dashboard.updateMetric('agent.count', agents.total)
    this.dashboard.updateMetric('task.count', performance.taskCount)
    this.dashboard.updateMetric('task.successRate', `${(performance.successRate * 100).toFixed(1)}%`)
    this.dashboard.updateMetric('response.p50', performance.p50)
    this.dashboard.updateMetric('response.p99', performance.p99)
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

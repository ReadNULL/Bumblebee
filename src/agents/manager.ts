import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { AgentConfig, AgentInstance, AgentTask, AgentResult } from './types.js'
import { RoleManager } from '../roles/manager.js'
import { RoleConfig } from '../roles/types.js'

export class AgentManager {
  private agents: Map<string, AgentInstance> = new Map()
  private roleManager: RoleManager

  constructor(roleManager: RoleManager) {
    this.roleManager = roleManager
  }

  // 初始化
  async initialize(): Promise<void> {
    // 确保角色管理器已初始化
    // 注：roleManager 应该已经在外部初始化过
  }

  // 注册 Agent
  async registerAgent(config: AgentConfig): Promise<AgentInstance> {
    // 解析角色
    const role = await this.resolveRole(config.role)

    // 创建 Agent 实例
    const instance: AgentInstance = {
      id: config.id,
      config,
      role,
      status: 'idle',
      lastActive: new Date()
    }

    this.agents.set(config.id, instance)
    return instance
  }

  // 解析角色配置
  private async resolveRole(roleConfig?: AgentConfig['role']): Promise<RoleConfig> {
    // 如果没有指定角色，使用默认角色
    if (!roleConfig) {
      return this.roleManager.getCurrentRole()
    }

    // 如果指定了角色 ID
    if (roleConfig.roleId) {
      const role = this.roleManager.getRole(roleConfig.roleId)
      if (role) {
        return role
      }
      console.warn(`角色 "${roleConfig.roleId}" 不存在，使用默认角色`)
      return this.roleManager.getCurrentRole()
    }

    // 如果直接定义了角色配置
    if (roleConfig.roleConfig) {
      return roleConfig.roleConfig
    }

    // 默认使用当前角色
    return this.roleManager.getCurrentRole()
  }

  // 获取 Agent
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId)
  }

  // 获取所有 Agent
  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values())
  }

  // 更新 Agent 状态
  updateAgentStatus(agentId: string, status: AgentInstance['status']): void {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.status = status
      agent.lastActive = new Date()
    }
  }

  // 为 Agent 指定角色
  async assignRole(agentId: string, roleId: string): Promise<boolean> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return false
    }

    const role = this.roleManager.getRole(roleId)
    if (!role) {
      return false
    }

    agent.role = role
    agent.lastActive = new Date()
    return true
  }

  // 执行任务
  async executeTask(task: AgentTask): Promise<AgentResult> {
    const agent = this.agents.get(task.agentId)
    if (!agent) {
      return {
        taskId: task.id,
        agentId: task.agentId,
        success: false,
        output: null,
        error: `Agent "${task.agentId}" 不存在`
      }
    }

    // 更新状态
    this.updateAgentStatus(task.agentId, 'busy')

    const startTime = new Date()

    try {
      // 这里应该调用实际的 AI 模型
      // 目前返回占位结果
      const output = await this.processTask(agent, task)

      const endTime = new Date()

      this.updateAgentStatus(task.agentId, 'idle')

      return {
        taskId: task.id,
        agentId: task.agentId,
        success: true,
        output,
        metrics: {
          startTime,
          endTime,
          duration: endTime.getTime() - startTime.getTime()
        }
      }
    } catch (error) {
      this.updateAgentStatus(task.agentId, 'error')

      return {
        taskId: task.id,
        agentId: task.agentId,
        success: false,
        output: null,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  // 处理任务（通过 pi-coding-agent SDK 调用 AI，AI 不可用时降级为模拟响应）
  private async processTask(agent: AgentInstance, task: AgentTask): Promise<Record<string, unknown>> {
    const systemPrompt = [
      agent.role.systemPrompt || `你是 ${agent.role.name}。${agent.role.description}`,
      agent.role.personality.traits?.length ? `特征: ${agent.role.personality.traits.join('、')}` : '',
      agent.role.personality.expertise?.length ? `专业领域: ${agent.role.personality.expertise.join('、')}` : '',
    ].filter(Boolean).join('\n')

    const userPrompt = [
      `任务类型: ${task.type}`,
      `任务描述: ${task.description}`,
      task.input ? `输入数据:\n${JSON.stringify(task.input, null, 2)}` : '',
    ].filter(Boolean).join('\n')

    try {
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
        return {
          message: response || '(无响应)',
          role: agent.role.name,
          taskType: task.type,
        }
      } finally {
        unsubscribe()
        session.dispose()
      }
    } catch {
      // AI SDK 不可用时降级为模拟响应
      return {
        message: `[${agent.role.name}] 处理任务: ${task.description}`,
        role: agent.role.name,
        taskType: task.type,
      }
    }
  }

  // 批量执行任务（并行）
  async executeTasksParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
    return Promise.all(tasks.map(task => this.executeTask(task)))
  }

  // 批量执行任务（顺序）
  async executeTasksSequential(tasks: AgentTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = []
    for (const task of tasks) {
      const result = await this.executeTask(task)
      results.push(result)
    }
    return results
  }

  // 删除 Agent
  removeAgent(agentId: string): boolean {
    return this.agents.delete(agentId)
  }

  // 获取 Agent 统计
  getStats(): {
    total: number
    idle: number
    busy: number
    error: number
  } {
    const agents = this.getAllAgents()
    return {
      total: agents.length,
      idle: agents.filter(a => a.status === 'idle').length,
      busy: agents.filter(a => a.status === 'busy').length,
      error: agents.filter(a => a.status === 'error').length
    }
  }
}

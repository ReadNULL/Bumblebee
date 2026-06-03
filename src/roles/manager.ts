import { RoleConfig, RoleSummary } from './types.js'
import { RoleStore } from './store.js'
import { RoleWizard } from './wizard.js'

export class RoleManager {
  private store: RoleStore
  private currentRole: RoleConfig | null = null

  constructor(rolesDir?: string) {
    this.store = new RoleStore(rolesDir)
  }

  // 初始化
  async initialize(): Promise<void> {
    await this.store.initialize()
    this.currentRole = this.store.getDefaultRole()
  }

  // 获取当前角色
  getCurrentRole(): RoleConfig {
    if (!this.currentRole) {
      throw new Error('角色管理器未初始化')
    }
    return this.currentRole
  }

  // 切换角色
  switchRole(roleId: string): boolean {
    const role = this.store.getRole(roleId)
    if (role) {
      this.currentRole = role
      this.store.setDefaultRole(roleId)
      return true
    }
    return false
  }

  // 获取所有角色
  getAllRoles(): RoleConfig[] {
    return this.store.getAllRoles()
  }

  // 获取角色摘要列表
  getRoleSummaries(): RoleSummary[] {
    return this.store.getRoleSummaries()
  }

  // 获取角色
  getRole(roleId: string): RoleConfig | undefined {
    return this.store.getRole(roleId)
  }

  // 创建角色（交互式）
  async createRoleInteractive(): Promise<RoleConfig | null> {
    const wizard = new RoleWizard(this.store)
    try {
      return await wizard.createRole()
    } finally {
      wizard.close()
    }
  }

  // 创建角色（编程式）
  async createRole(input: {
    id: string
    name: string
    description: string
    personality: RoleConfig['personality']
    systemPrompt: string
    greeting: string
    responseStyle: RoleConfig['responseStyle']
    capabilities: string[]
    limitations?: string[]
    tags?: string[]
  }): Promise<RoleConfig> {
    const role: RoleConfig = {
      ...input,
      metadata: {
        version: '1.0.0',
        author: 'api',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: input.tags
      }
    }

    // 验证
    const validation = RoleStore.validateRole(role)
    if (!validation.valid) {
      throw new Error(`角色配置无效: ${validation.errors.join(', ')}`)
    }

    // 保存
    await this.store.saveRole(role)
    return role
  }

  // 删除角色
  async deleteRole(roleId: string): Promise<boolean> {
    return this.store.deleteRole(roleId)
  }

  // 搜索角色
  searchRoles(query: string): RoleConfig[] {
    return this.store.searchRoles(query)
  }

  // 获取系统提示词
  getSystemPrompt(): string {
    return this.getCurrentRole().systemPrompt
  }

  // 获取问候语
  getGreeting(): string {
    return this.getCurrentRole().greeting
  }

  // 应用角色风格
  applyRoleStyle(response: string): string {
    const role = this.getCurrentRole()
    const style = role.responseStyle

    // 根据详细程度调整
    if (style.verbosity === 'concise') {
      return this.simplifyResponse(response)
    }

    return response
  }

  // 简化响应
  private simplifyResponse(response: string): string {
    let simplified = response.replace(/\n{3,}/g, '\n\n')
    simplified = simplified.replace(/^(首先|其次|然后|最后)[：:]\s*/gm, '')
    return simplified
  }

  // 获取角色信息摘要
  getRoleSummary(): {
    id: string
    name: string
    description: string
    traits: string[]
    expertise: string[]
    capabilities: string[]
  } {
    const role = this.getCurrentRole()
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      traits: role.personality.traits,
      expertise: role.personality.expertise,
      capabilities: role.capabilities
    }
  }

  // 获取存储目录
  getRolesDir(): string {
    return this.store['rolesDir']
  }
}

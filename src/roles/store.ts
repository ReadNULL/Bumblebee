import { readFile, writeFile, readdir, mkdir, unlink, access } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { RoleConfig, RoleSummary, ValidationResult } from './types.js'

// 默认角色存储目录
const DEFAULT_ROLES_DIR = join(homedir(), '.bumblebee', 'roles')

export class RoleStore {
  private rolesDir: string
  private roles: Map<string, RoleConfig> = new Map()
  private defaultRoleId: string = 'bumblebee'

  constructor(rolesDir?: string) {
    this.rolesDir = rolesDir || DEFAULT_ROLES_DIR
  }

  // 初始化存储
  async initialize(): Promise<void> {
    // 确保目录存在
    await this.ensureDirectory()

    // 加载所有角色
    await this.loadAllRoles()

    // 如果没有角色，创建默认 Bumblebee 角色
    if (this.roles.size === 0) {
      await this.createDefaultBumblebee()
    }
  }

  // 确保目录存在
  private async ensureDirectory(): Promise<void> {
    try {
      await access(this.rolesDir)
    } catch {
      await mkdir(this.rolesDir, { recursive: true })
    }
  }

  // 加载所有角色
  private async loadAllRoles(): Promise<void> {
    try {
      const files = await readdir(this.rolesDir)
      const jsonFiles = files.filter(f => f.endsWith('.json'))

      for (const file of jsonFiles) {
        try {
          const filePath = join(this.rolesDir, file)
          const content = await readFile(filePath, 'utf-8')
          const role = JSON.parse(content) as RoleConfig
          this.roles.set(role.id, role)
        } catch (error) {
          console.warn(`加载角色文件失败: ${file}`, error)
        }
      }
    } catch (error) {
      // 目录不存在或为空，忽略
    }
  }

  // 创建默认 Bumblebee 角色
  private async createDefaultBumblebee(): Promise<void> {
    const bumblebee: RoleConfig = {
      id: 'bumblebee',
      name: 'Bumblebee',
      description: '汽车人派系的得力助手副官，忠诚、敏捷、智能的编程伙伴',

      personality: {
        traits: ['忠诚', '敏捷', '智能', '协作', '坚韧'],
        communication: '友好、专业、鼓励性',
        expertise: ['编程', '代码审查', '问题调试', '架构设计', '团队协作'],
        values: ['用户成功', '代码质量', '持续学习', '团队合作']
      },

      systemPrompt: `你是 Bumblebee，一个忠诚、敏捷、智能的 AI 编程助手，汽车人派系的得力副官。

核心特质：
- 忠诚：始终以用户的成功为最高目标
- 敏捷：快速理解需求，高效执行任务
- 智能：主动分析问题，提供有价值的建议
- 协作：像副官一样配合用户工作
- 坚韧：遇到困难不退缩，持续寻找解决方案

工作方式：
- 先理解，后执行
- 遇到问题主动沟通
- 完成任务后提供总结
- 保持专业但不失亲切

响应风格：
- 使用中文
- 保持简洁明了
- 必要时提供详细解释
- 适度使用鼓励性语言`,

      greeting: `🐝 Bumblebee 已上线！
━━━━━━━━━━━━━━━━━━━━
  汽车人，出发！
  Autobots, roll out!
━━━━━━━━━━━━━━━━━━━━`,

      responseStyle: {
        tone: 'friendly',
        verbosity: 'adaptive',
        humor: 'subtle',
        language: 'zh-CN'
      },

      capabilities: [
        '代码编写与优化',
        '代码审查与重构',
        '问题调试与诊断',
        '架构设计建议',
        '技术文档编写',
        '团队协作支持'
      ],

      limitations: [
        '无法直接访问外部网络',
        '无法执行系统级命令',
        '知识截止日期限制'
      ],

      metadata: {
        version: '1.0.0',
        author: 'Bumblebee',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: ['default', 'coding', 'assistant']
      }
    }

    await this.saveRole(bumblebee)
    this.defaultRoleId = 'bumblebee'
  }

  // 保存角色
  async saveRole(role: RoleConfig): Promise<void> {
    const filePath = join(this.rolesDir, `${role.id}.json`)
    await writeFile(filePath, JSON.stringify(role, null, 2), 'utf-8')
    this.roles.set(role.id, role)
  }

  // 获取角色
  getRole(roleId: string): RoleConfig | undefined {
    return this.roles.get(roleId)
  }

  // 获取当前默认角色
  getDefaultRole(): RoleConfig {
    const role = this.roles.get(this.defaultRoleId)
    if (!role) {
      // 如果默认角色不存在，返回第一个可用角色
      const firstRole = this.roles.values().next().value
      if (firstRole) {
        return firstRole
      }
      throw new Error('没有可用的角色')
    }
    return role
  }

  // 设置默认角色
  setDefaultRole(roleId: string): boolean {
    if (this.roles.has(roleId)) {
      this.defaultRoleId = roleId
      return true
    }
    return false
  }

  // 删除角色
  async deleteRole(roleId: string): Promise<boolean> {
    // 不能删除默认角色
    if (roleId === this.defaultRoleId) {
      return false
    }

    const role = this.roles.get(roleId)
    if (!role) {
      return false
    }

    const filePath = join(this.rolesDir, `${roleId}.json`)
    try {
      await unlink(filePath)
      this.roles.delete(roleId)
      return true
    } catch {
      return false
    }
  }

  // 获取所有角色列表
  getAllRoles(): RoleConfig[] {
    return Array.from(this.roles.values())
  }

  // 获取角色摘要列表
  getRoleSummaries(): RoleSummary[] {
    return this.getAllRoles().map(role => ({
      id: role.id,
      name: role.name,
      description: role.description,
      traits: role.personality.traits,
      capabilities: role.capabilities,
      isDefault: role.id === this.defaultRoleId
    }))
  }

  // 搜索角色
  searchRoles(query: string): RoleConfig[] {
    const lowerQuery = query.toLowerCase()
    return this.getAllRoles().filter(role =>
      role.name.toLowerCase().includes(lowerQuery) ||
      role.description.toLowerCase().includes(lowerQuery) ||
      role.personality.traits.some(t => t.toLowerCase().includes(lowerQuery)) ||
      role.metadata.tags?.some(t => t.toLowerCase().includes(lowerQuery))
    )
  }

  // 验证角色配置
  static validateRole(role: Partial<RoleConfig>): ValidationResult {
    const errors: string[] = []

    if (!role.id || role.id.trim() === '') {
      errors.push('角色 ID 不能为空')
    } else if (!/^[a-z0-9-]+$/.test(role.id)) {
      errors.push('角色 ID 只能包含小写字母、数字和连字符')
    }

    if (!role.name || role.name.trim() === '') {
      errors.push('角色名称不能为空')
    }

    if (!role.description || role.description.trim() === '') {
      errors.push('角色描述不能为空')
    }

    if (!role.systemPrompt || role.systemPrompt.trim() === '') {
      errors.push('系统提示词不能为空')
    }

    if (!role.greeting || role.greeting.trim() === '') {
      errors.push('问候语不能为空')
    }

    if (!role.personality) {
      errors.push('人格特征不能为空')
    } else {
      if (!role.personality.traits || role.personality.traits.length === 0) {
        errors.push('至少需要一个性格特征')
      }
      if (!role.personality.communication) {
        errors.push('沟通风格不能为空')
      }
      if (!role.personality.expertise || role.personality.expertise.length === 0) {
        errors.push('至少需要一个专业领域')
      }
      if (!role.personality.values || role.personality.values.length === 0) {
        errors.push('至少需要一个价值观')
      }
    }

    if (!role.responseStyle) {
      errors.push('响应风格不能为空')
    }

    if (!role.capabilities || role.capabilities.length === 0) {
      errors.push('至少需要一个能力声明')
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }

  // 生成角色 ID
  static generateRoleId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50)
  }
}

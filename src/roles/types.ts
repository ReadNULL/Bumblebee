/**
 * 角色类型定义
 *
 * 支持用户自定义角色，每个角色存储为独立的 JSON 文件
 */

// 角色配置
export interface RoleConfig {
  // 基本信息
  id: string                    // 唯一标识符
  name: string                  // 角色名称
  description: string           // 角色描述
  avatar?: string               // 头像（可选）

  // 人格特征
  personality: {
    traits: string[]            // 性格特征列表
    communication: string       // 沟通风格
    expertise: string[]         // 专业领域
    values: string[]            // 价值观
  }

  // 系统提示词（核心）
  systemPrompt: string

  // 问候语
  greeting: string

  // 响应风格
  responseStyle: {
    tone: 'formal' | 'casual' | 'friendly' | 'professional'
    verbosity: 'concise' | 'detailed' | 'adaptive'
    humor: 'none' | 'subtle' | 'moderate'
    language: 'zh-CN' | 'en-US' | 'auto'
  }

  // 能力声明
  capabilities: string[]

  // 限制说明（可选）
  limitations?: string[]

  // 元数据
  metadata: {
    version: string             // 版本号
    author: string              // 作者
    createdAt: string           // 创建时间
    updatedAt: string           // 更新时间
    tags?: string[]             // 标签
  }
}

// 角色创建输入（用于命令行向导）
export interface RoleCreateInput {
  name: string
  description: string
  personality: {
    traits: string[]
    communication: string
    expertise: string[]
    values: string[]
  }
  systemPrompt: string
  greeting: string
  responseStyle: {
    tone: RoleConfig['responseStyle']['tone']
    verbosity: RoleConfig['responseStyle']['verbosity']
    humor: RoleConfig['responseStyle']['humor']
    language: RoleConfig['responseStyle']['language']
  }
  capabilities: string[]
  limitations?: string[]
}

// 角色摘要（用于列表显示）
export interface RoleSummary {
  id: string
  name: string
  description: string
  traits: string[]
  capabilities: string[]
  isDefault: boolean
}

// 验证结果
export interface ValidationResult {
  valid: boolean
  errors: string[]
}

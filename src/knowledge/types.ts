/**
 * 知识系统类型定义
 *
 * 支持知识图谱、上下文感知和学习机制
 */

// ========== 知识图谱类型 ==========

// 知识节点类型
export type NodeType =
  | 'file'           // 文件
  | 'function'       // 函数
  | 'class'          // 类
  | 'module'         // 模块
  | 'concept'        // 概念
  | 'decision'       // 决策
  | 'pattern'        // 模式
  | 'bug'            // Bug
  | 'feature'        // 功能
  | 'dependency'     // 依赖

// 关系类型
export type RelationType =
  | 'depends_on'     // 依赖
  | 'implements'     // 实现
  | 'uses'           // 使用
  | 'extends'        // 继承
  | 'contains'       // 包含
  | 'related_to'     // 相关
  | 'caused_by'      // 由...引起
  | 'fixes'          // 修复
  | 'replaces'       // 替换
  | 'conflicts_with' // 冲突

// 知识节点
export interface KnowledgeNode {
  id: string
  type: NodeType
  name: string
  content: string
  metadata: Record<string, any>
  relations: Relation[]
  createdAt: Date
  updatedAt: Date
  importance: number        // 重要性 0-1
  confidence: number        // 置信度 0-1
  accessCount: number       // 访问次数
  tags: string[]
}

// 关系
export interface Relation {
  type: RelationType
  targetId: string
  weight: number            // 权重 0-1
  metadata?: Record<string, any>
}

// 知识查询
export interface KnowledgeQuery {
  text?: string             // 文本查询
  type?: NodeType           // 类型过滤
  tags?: string[]           // 标签过滤
  limit?: number            // 结果数量限制
  minImportance?: number    // 最小重要性
  minConfidence?: number    // 最小置信度
}

// 知识查询结果
export interface KnowledgeResult {
  node: KnowledgeNode
  score: number             // 相关性分数
  path?: string[]           // 从查询到结果的路径
}

// ========== 上下文感知类型 ==========

// 上下文类型
export type ContextType =
  | 'project'        // 项目上下文
  | 'user'           // 用户上下文
  | 'session'        // 会话上下文
  | 'task'           // 任务上下文
  | 'environment'    // 环境上下文

// 上下文信息
export interface Context {
  type: ContextType
  key: string
  value: any
  source: string            // 来源
  timestamp: Date
  ttl?: number              // 生存时间（毫秒）
  importance: number        // 重要性 0-1
}

// 项目上下文
export interface ProjectContext {
  name: string
  rootPath: string
  language: string
  framework?: string
  dependencies: string[]
  structure: FileStructure
  gitInfo?: GitInfo
}

// 文件结构
export interface FileStructure {
  files: string[]
  directories: string[]
  mainEntry?: string
}

// Git 信息
export interface GitInfo {
  branch: string
  lastCommit: string
  remotes: string[]
  status: string
}

// 用户上下文
export interface UserContext {
  id: string
  name?: string
  preferences: UserPreferences
  history: UserHistory
}

// 用户偏好
export interface UserPreferences {
  language: string
  codeStyle: string
  verbosity: 'concise' | 'normal' | 'detailed'
  theme: string
}

// 用户历史
export interface UserHistory {
  recentFiles: string[]
  recentCommands: string[]
  frequentPatterns: string[]
}

// ========== 学习机制类型 ==========

// 学习类型
export type LearningType =
  | 'pattern'        // 模式学习
  | 'preference'     // 偏好学习
  | 'correction'     // 纠正学习
  | 'feedback'       // 反馈学习
  | 'observation'    // 观察学习

// 学习记录
export interface LearningRecord {
  id: string
  type: LearningType
  input: any
  output: any
  feedback?: any
  success: boolean
  timestamp: Date
  context: Record<string, any>
}

// 学习模式
export interface LearnedPattern {
  id: string
  pattern: string
  frequency: number
  lastSeen: Date
  confidence: number
  examples: any[]
}

// ========== 推荐系统类型 ==========

// 推荐类型
export type RecommendationType =
  | 'code'           // 代码建议
  | 'action'         // 操作建议
  | 'resource'       // 资源推荐
  | 'pattern'        // 模式推荐
  | 'fix'            // 修复建议

// 推荐
export interface Recommendation {
  type: RecommendationType
  title: string
  description: string
  confidence: number        // 置信度 0-1
  relevance: number         // 相关性 0-1
  action?: string           // 建议的操作
  resources?: string[]      // 相关资源
  metadata?: Record<string, any>
}

// 推荐请求
export interface RecommendationRequest {
  context: Record<string, any>
  limit?: number
  types?: RecommendationType[]
  minConfidence?: number
}

/**
 * 知识系统模块导出
 */

// 核心类
export { KnowledgeGraph } from './graph.js'
export { ContextManager } from './context.js'
export { Learner } from './learner.js'

// 类型定义
export type {
  // 知识图谱类型
  NodeType,
  RelationType,
  KnowledgeNode,
  Relation,
  KnowledgeQuery,
  KnowledgeResult,

  // 上下文类型
  ContextType,
  Context,
  ProjectContext,
  FileStructure,
  GitInfo,
  UserContext,
  UserPreferences,
  UserHistory,

  // 学习类型
  LearningType,
  LearningRecord,
  LearnedPattern,

  // 推荐类型
  RecommendationType,
  Recommendation,
  RecommendationRequest
} from './types.js'

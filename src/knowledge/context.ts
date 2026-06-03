/**
 * 上下文感知系统
 *
 * 负责收集、管理和提供上下文信息
 */

import {
  Context,
  ContextType,
  ProjectContext,
  UserContext,
  UserPreferences,
  UserHistory
} from './types.js'

export class ContextManager {
  private contexts: Map<string, Context> = new Map()
  private projectContext: ProjectContext | null = null
  private userContext: UserContext | null = null

  // ========== 上下文管理 ==========

  // 设置上下文
  setContext(context: Context): void {
    const key = `${context.type}:${context.key}`
    this.contexts.set(key, context)
  }

  // 获取上下文
  getContext(type: ContextType, key: string): Context | undefined {
    return this.contexts.get(`${type}:${key}`)
  }

  // 获取指定类型的所有上下文
  getContextsByType(type: ContextType): Context[] {
    return Array.from(this.contexts.values())
      .filter(c => c.type === type)
  }

  // 删除上下文
  removeContext(type: ContextType, key: string): boolean {
    return this.contexts.delete(`${type}:${key}`)
  }

  // 清理过期上下文
  cleanupExpired(): number {
    const now = Date.now()
    let removed = 0

    for (const [key, context] of this.contexts.entries()) {
      if (context.ttl) {
        const expireTime = context.timestamp.getTime() + context.ttl
        if (now > expireTime) {
          this.contexts.delete(key)
          removed++
        }
      }
    }

    return removed
  }

  // ========== 项目上下文 ==========

  // 设置项目上下文
  setProjectContext(project: ProjectContext): void {
    this.projectContext = project

    // 同时设置为通用上下文
    this.setContext({
      type: 'project',
      key: 'current',
      value: project,
      source: 'system',
      timestamp: new Date(),
      importance: 1
    })
  }

  // 获取项目上下文
  getProjectContext(): ProjectContext | null {
    return this.projectContext
  }

  // 获取项目语言
  getProjectLanguage(): string | undefined {
    return this.projectContext?.language
  }

  // 获取项目框架
  getProjectFramework(): string | undefined {
    return this.projectContext?.framework
  }

  // 获取项目依赖
  getProjectDependencies(): string[] {
    return this.projectContext?.dependencies || []
  }

  // ========== 用户上下文 ==========

  // 设置用户上下文
  setUserContext(user: UserContext): void {
    this.userContext = user

    // 同时设置为通用上下文
    this.setContext({
      type: 'user',
      key: 'current',
      value: user,
      source: 'system',
      timestamp: new Date(),
      importance: 1
    })
  }

  // 获取用户上下文
  getUserContext(): UserContext | null {
    return this.userContext
  }

  // 获取用户偏好
  getUserPreferences(): UserPreferences | null {
    return this.userContext?.preferences || null
  }

  // 更新用户偏好
  updateUserPreferences(updates: Partial<UserPreferences>): void {
    if (this.userContext) {
      this.userContext.preferences = {
        ...this.userContext.preferences,
        ...updates
      }
    }
  }

  // 记录用户历史
  recordUserHistory(entry: { file?: string; command?: string; pattern?: string }): void {
    if (!this.userContext) {
      return
    }

    const history = this.userContext.history

    if (entry.file) {
      history.recentFiles = [
        entry.file,
        ...history.recentFiles.filter(f => f !== entry.file)
      ].slice(0, 50)
    }

    if (entry.command) {
      history.recentCommands = [
        entry.command,
        ...history.recentCommands.filter(c => c !== entry.command)
      ].slice(0, 50)
    }

    if (entry.pattern) {
      const existing = history.frequentPatterns.find(p => p === entry.pattern)
      if (!existing) {
        history.frequentPatterns.push(entry.pattern)
        if (history.frequentPatterns.length > 20) {
          history.frequentPatterns.shift()
        }
      }
    }
  }

  // ========== 会话上下文 ==========

  // 设置会话变量
  setSessionVariable(key: string, value: unknown): void {
    this.setContext({
      type: 'session',
      key,
      value,
      source: 'user',
      timestamp: new Date(),
      importance: 0.5
    })
  }

  // 获取会话变量
  getSessionVariable(key: string): unknown {
    const context = this.getContext('session', key)
    return context?.value
  }

  // ========== 任务上下文 ==========

  // 设置任务上下文
  setTaskContext(taskId: string, context: Record<string, any>): void {
    this.setContext({
      type: 'task',
      key: taskId,
      value: context,
      source: 'system',
      timestamp: new Date(),
      importance: 0.8
    })
  }

  // 获取任务上下文
  getTaskContext(taskId: string): Record<string, any> | undefined {
    const context = this.getContext('task', taskId)
    return context?.value
  }

  // ========== 环境感知 ==========

  // 检测环境信息
  async detectEnvironment(): Promise<Record<string, any>> {
    const env: Record<string, any> = {
      platform: process.platform,
      nodeVersion: process.version,
      cwd: process.cwd(),
      timestamp: new Date().toISOString()
    }

    // 尝试检测 Git 信息
    try {
      const { execSync } = await import('child_process')
      env.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
      env.gitStatus = execSync('git status --short', { encoding: 'utf-8' }).trim()
    } catch {
      // 不在 Git 仓库中
    }

    // 尝试检测包管理器
    try {
      const { existsSync } = await import('fs')
      if (existsSync('package-lock.json')) {
        env.packageManager = 'npm'
      } else if (existsSync('yarn.lock')) {
        env.packageManager = 'yarn'
      } else if (existsSync('pnpm-lock.yaml')) {
        env.packageManager = 'pnpm'
      }
    } catch {
      // 忽略错误
    }

    // 设置为环境上下文
    this.setContext({
      type: 'environment',
      key: 'detected',
      value: env,
      source: 'system',
      timestamp: new Date(),
      importance: 0.6
    })

    return env
  }

  // ========== 上下文查询 ==========

  // 获取相关上下文
  getRelevantContext(query: string, limit: number = 5): Context[] {
    const queryLower = query.toLowerCase()

    // 对所有上下文进行评分
    const scored = Array.from(this.contexts.values()).map(context => {
      let score = 0

      // 关键词匹配
      const contextStr = JSON.stringify(context.value).toLowerCase()
      if (contextStr.includes(queryLower)) {
        score += 0.5
      }

      // 重要性加权
      score *= context.importance

      // 时间衰减
      const age = Date.now() - context.timestamp.getTime()
      const timeFactor = Math.max(0, 1 - age / (24 * 60 * 60 * 1000))  // 24小时衰减
      score *= timeFactor

      return { context, score }
    })

    // 排序并返回
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.context)
  }

  // 获取上下文摘要
  getContextSummary(): {
    project: ProjectContext | null
    user: UserContext | null
    sessionVars: number
    taskContexts: number
    totalContexts: number
  } {
    return {
      project: this.projectContext,
      user: this.userContext,
      sessionVars: this.getContextsByType('session').length,
      taskContexts: this.getContextsByType('task').length,
      totalContexts: this.contexts.size
    }
  }

  // 清空所有上下文
  clear(): void {
    this.contexts.clear()
    this.projectContext = null
    this.userContext = null
  }
}

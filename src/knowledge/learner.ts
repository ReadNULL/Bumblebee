/**
 * 学习机制
 *
 * 负责从交互中学习模式和偏好
 */

import {
  LearningType,
  LearningRecord,
  LearnedPattern,
  Recommendation,
  RecommendationRequest,
  RecommendationType
} from './types.js'

export class Learner {
  private records: LearningRecord[] = []
  private patterns: Map<string, LearnedPattern> = new Map()
  private maxRecords: number

  constructor(maxRecords: number = 1000) {
    this.maxRecords = maxRecords
  }

  // ========== 学习记录 ==========

  // 记录学习
  record(entry: Omit<LearningRecord, 'id' | 'timestamp'>): LearningRecord {
    const record: LearningRecord = {
      ...entry,
      id: `lr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    }

    this.records.push(record)

    // 限制记录数量
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords)
    }

    // 从记录中学习模式
    this.learnFromRecord(record)

    return record
  }

  // 获取学习记录
  getRecords(type?: LearningType, limit?: number): LearningRecord[] {
    let filtered = type
      ? this.records.filter(r => r.type === type)
      : this.records

    if (limit) {
      filtered = filtered.slice(-limit)
    }

    return filtered
  }

  // 清空记录
  clearRecords(): void {
    this.records = []
  }

  // ========== 模式学习 ==========

  // 从记录中学习模式
  private learnFromRecord(record: LearningRecord): void {
    // 提取模式
    const patternKey = this.extractPattern(record)
    if (!patternKey) {
      return
    }

    // 更新或创建模式
    let pattern = this.patterns.get(patternKey)
    if (pattern) {
      pattern.frequency++
      pattern.lastSeen = new Date()
      pattern.confidence = Math.min(1, pattern.confidence + 0.01)

      // 保留最近的示例
      pattern.examples.push(record.input)
      if (pattern.examples.length > 10) {
        pattern.examples.shift()
      }
    } else {
      pattern = {
        id: `pattern-${Date.now()}`,
        pattern: patternKey,
        frequency: 1,
        lastSeen: new Date(),
        confidence: 0.1,
        examples: [record.input]
      }
      this.patterns.set(patternKey, pattern)
    }
  }

  // 提取模式
  private extractPattern(record: LearningRecord): string | null {
    // 根据不同类型提取模式
    switch (record.type) {
      case 'pattern':
        return this.extractCodePattern(record)
      case 'preference':
        return this.extractPreferencePattern(record)
      case 'correction':
        return this.extractCorrectionPattern(record)
      case 'feedback':
        return this.extractFeedbackPattern(record)
      case 'observation':
        return this.extractObservationPattern(record)
      default:
        return null
    }
  }

  // 提取代码模式
  private extractCodePattern(record: LearningRecord): string | null {
    const input = record.input
    if (typeof input === 'string') {
      // 简单的模式提取：去除变量名和值
      return input
        .replace(/['"][^'"]*['"]/g, 'STRING')
        .replace(/\b\d+\b/g, 'NUM')
        .replace(/\b[a-z_]\w*(?=\s*[=:])/g, 'VAR')
    }
    return null
  }

  // 提取偏好模式
  private extractPreferencePattern(record: LearningRecord): string | null {
    const input = record.input
    if (typeof input === 'object' && input.action) {
      return `preference:${input.action}`
    }
    return null
  }

  // 提取纠正模式
  private extractCorrectionPattern(record: LearningRecord): string | null {
    const input = record.input
    if (typeof input === 'object' && input.wrong && input.correct) {
      return `correction:${input.wrong}:${input.correct}`
    }
    return null
  }

  // 提取反馈模式
  private extractFeedbackPattern(record: LearningRecord): string | null {
    const input = record.input
    if (typeof input === 'object' && input.type) {
      return `feedback:${input.type}`
    }
    return null
  }

  // 提取观察模式
  private extractObservationPattern(record: LearningRecord): string | null {
    const input = record.input
    if (typeof input === 'object' && input.action) {
      return `observation:${input.action}`
    }
    return null
  }

  // ========== 模式查询 ==========

  // 获取所有模式
  getPatterns(): LearnedPattern[] {
    return Array.from(this.patterns.values())
  }

  // 获取高频模式
  getFrequentPatterns(limit: number = 10): LearnedPattern[] {
    return Array.from(this.patterns.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit)
  }

  // 获取最近模式
  getRecentPatterns(limit: number = 10): LearnedPattern[] {
    return Array.from(this.patterns.values())
      .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
      .slice(0, limit)
  }

  // 查找匹配模式
  findMatchingPatterns(input: unknown, limit: number = 5): LearnedPattern[] {
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
    const inputNormalized = inputStr
      .replace(/['"][^'"]*['"]/g, 'STRING')
      .replace(/\b\d+\b/g, 'NUM')
      .replace(/\b[a-z_]\w*(?=\s*[=:])/g, 'VAR')

    const scored = Array.from(this.patterns.values()).map(pattern => {
      let score = 0

      // 模式匹配
      if (pattern.pattern === inputNormalized) {
        score = 1
      } else if (pattern.pattern.includes(inputNormalized) || inputNormalized.includes(pattern.pattern)) {
        score = 0.5
      }

      // 考虑频率和置信度
      score *= pattern.confidence * Math.min(pattern.frequency / 10, 1)

      return { pattern, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.pattern)
  }

  // ========== 推荐 ==========

  // 生成推荐
  recommend(request: RecommendationRequest): Recommendation[] {
    const recommendations: Recommendation[] = []

    // 从模式中生成推荐
    const patterns = this.getFrequentPatterns(20)
    for (const pattern of patterns) {
      const rec = this.patternToRecommendation(pattern, request)
      if (rec) {
        recommendations.push(rec)
      }
    }

    // 从最近学习中生成推荐
    const recentRecords = this.getRecords(undefined, 50)
    const recentRecs = this.recordsToRecommendations(recentRecords, request)
    recommendations.push(...recentRecs)

    // 过滤和排序
    return recommendations
      .filter(r => {
        if (request.minConfidence && r.confidence < request.minConfidence) {
          return false
        }
        if (request.types && !request.types.includes(r.type)) {
          return false
        }
        return true
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, request.limit || 10)
  }

  // 模式转推荐
  private patternToRecommendation(
    pattern: LearnedPattern,
    request: RecommendationRequest
  ): Recommendation | null {
    if (pattern.confidence < 0.3) {
      return null
    }

    return {
      type: 'pattern',
      title: '模式建议',
      description: `基于学习到的模式: ${pattern.pattern}`,
      confidence: pattern.confidence,
      relevance: pattern.frequency / 100,
      metadata: {
        patternId: pattern.id,
        frequency: pattern.frequency
      }
    }
  }

  // 记录转推荐
  private recordsToRecommendations(
    records: LearningRecord[],
    request: RecommendationRequest
  ): Recommendation[] {
    const recommendations: Recommendation[] = []

    // 分析纠正记录
    const corrections = records.filter(r => r.type === 'correction')
    if (corrections.length > 0) {
      const lastCorrection = corrections[corrections.length - 1]
      recommendations.push({
        type: 'fix',
        title: '避免常见错误',
        description: `避免: ${lastCorrection.input.wrong}`,
        confidence: 0.7,
        relevance: 0.8,
        action: `建议使用: ${lastCorrection.input.correct}`
      })
    }

    // 分析反馈记录
    const positiveFeedback = records.filter(r =>
      r.type === 'feedback' && r.success
    )
    if (positiveFeedback.length > 3) {
      recommendations.push({
        type: 'action',
        title: '用户偏好操作',
        description: '基于用户反馈的推荐操作',
        confidence: 0.6,
        relevance: 0.7
      })
    }

    return recommendations
  }

  // ========== 统计 ==========

  // 获取学习统计
  getStats(): {
    totalRecords: number
    totalPatterns: number
    typeDistribution: Record<LearningType, number>
    successRate: number
  } {
    const typeDistribution: Record<string, number> = {}
    let successCount = 0

    for (const record of this.records) {
      typeDistribution[record.type] = (typeDistribution[record.type] || 0) + 1
      if (record.success) {
        successCount++
      }
    }

    return {
      totalRecords: this.records.length,
      totalPatterns: this.patterns.size,
      typeDistribution: typeDistribution as Record<LearningType, number>,
      successRate: this.records.length > 0 ? successCount / this.records.length : 0
    }
  }

  // 清空所有数据
  clear(): void {
    this.records = []
    this.patterns.clear()
  }
}

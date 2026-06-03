/**
 * 性能优化引擎
 *
 * 负责缓存、并发控制和性能监控
 */

import {
  CacheConfig,
  CacheEntry,
  ConcurrencyConfig,
  PoolConfig,
  PerformanceMetrics,
  PerformanceEvent,
  PerformanceEventHandler,
  OptimizationStrategy
} from './types.js'

// ========== LRU 缓存 ==========

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private config: CacheConfig

  constructor(config: CacheConfig) {
    this.config = config
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)

    if (!entry) {
      return undefined
    }

    // 检查是否过期
    if (new Date() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }

    // 更新访问信息
    entry.accessCount++
    entry.lastAccessed = new Date()

    // 移到末尾（LRU）
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  set(key: string, value: T, ttl?: number): void {
    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.config.maxSize) {
      this.evict()
    }

    const now = new Date()
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: new Date(now.getTime() + (ttl || this.config.ttl)),
      accessCount: 0,
      lastAccessed: now
    }

    this.cache.set(key, entry)
  }

  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) {
      return false
    }

    // 检查是否过期
    if (new Date() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  size(): number {
    return this.cache.size
  }

  getStats(): { size: number; hitRate: number; missRate: number } {
    let totalHits = 0
    let totalMisses = 0

    for (const entry of this.cache.values()) {
      totalHits += entry.accessCount
    }

    return {
      size: this.cache.size,
      hitRate: totalHits / (totalHits + totalMisses) || 0,
      missRate: totalMisses / (totalHits + totalMisses) || 0
    }
  }

  private evict(): void {
    // LRU: 删除最久未访问的条目
    const firstKey = this.cache.keys().next().value
    if (firstKey) {
      this.cache.delete(firstKey)
    }
  }
}

// ========== 并发控制器 ==========

export class ConcurrencyController {
  private config: ConcurrencyConfig
  private activeCount: number = 0
  private queue: Array<{
    resolve: () => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }> = []

  constructor(config: ConcurrencyConfig) {
    this.config = config
  }

  async acquire(): Promise<void> {
    // 如果有空闲槽位，直接获取
    if (this.activeCount < this.config.maxConcurrent) {
      this.activeCount++
      return
    }

    // 如果队列已满，拒绝
    if (this.queue.length >= this.config.queueSize) {
      throw new Error('并发队列已满')
    }

    // 等待空闲槽位
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // 超时，从队列中移除
        const index = this.queue.findIndex(item => item.resolve === resolve)
        if (index >= 0) {
          this.queue.splice(index, 1)
        }
        reject(new Error('获取并发槽位超时'))
      }, this.config.timeout)

      this.queue.push({ resolve, reject, timeout })
    })
  }

  release(): void {
    this.activeCount--

    // 从队列中取出下一个等待者
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      clearTimeout(next.timeout)
      this.activeCount++
      next.resolve()
    }
  }

  getStats(): { active: number; queued: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length
    }
  }
}

// ========== 资源池 ==========

export class ResourcePool<T> {
  private config: PoolConfig
  private factory: () => Promise<T>
  private destroyer: (resource: T) => Promise<void>
  private pool: Array<{ resource: T; lastUsed: Date }> = []
  private waiting: Array<{
    resolve: (resource: T) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }> = []
  private activeCount: number = 0

  constructor(
    config: PoolConfig,
    factory: () => Promise<T>,
    destroyer: (resource: T) => Promise<void>
  ) {
    this.config = config
    this.factory = factory
    this.destroyer = destroyer
  }

  async initialize(): Promise<void> {
    // 创建最小数量的资源
    for (let i = 0; i < this.config.minSize; i++) {
      const resource = await this.factory()
      this.pool.push({ resource, lastUsed: new Date() })
    }
  }

  async acquire(): Promise<T> {
    // 尝试从池中获取
    if (this.pool.length > 0) {
      const item = this.pool.pop()!
      this.activeCount++
      return item.resource
    }

    // 如果可以创建新资源
    if (this.activeCount < this.config.maxSize) {
      const resource = await this.factory()
      this.activeCount++
      return resource
    }

    // 等待资源释放
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiting.findIndex(item => item.resolve === resolve)
        if (index >= 0) {
          this.waiting.splice(index, 1)
        }
        reject(new Error('获取资源超时'))
      }, this.config.acquireTimeout)

      this.waiting.push({ resolve, reject, timeout })
    })
  }

  async release(resource: T): Promise<void> {
    this.activeCount--

    // 如果有等待者，直接分配
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      clearTimeout(next.timeout)
      this.activeCount++
      next.resolve(resource)
      return
    }

    // 放回池中
    if (this.pool.length < this.config.maxSize) {
      this.pool.push({ resource, lastUsed: new Date() })
    } else {
      // 池已满，销毁资源
      await this.destroyer(resource)
    }
  }

  async destroy(): Promise<void> {
    // 销毁所有池中资源
    for (const item of this.pool) {
      await this.destroyer(item.resource)
    }
    this.pool = []

    // 拒绝所有等待者
    for (const waiting of this.waiting) {
      clearTimeout(waiting.timeout)
      waiting.reject(new Error('资源池已销毁'))
    }
    this.waiting = []
  }

  getStats(): { available: number; active: number; waiting: number } {
    return {
      available: this.pool.length,
      active: this.activeCount,
      waiting: this.waiting.length
    }
  }
}

// ========== 性能监控器 ==========

export class PerformanceMonitor {
  private metrics: PerformanceMetrics
  private eventHandlers: PerformanceEventHandler[] = []
  private strategies: OptimizationStrategy[] = []
  private startTime: Date

  constructor() {
    this.startTime = new Date()
    this.metrics = this.createEmptyMetrics()
  }

  // 注册优化策略
  registerStrategy(strategy: OptimizationStrategy): void {
    this.strategies.push(strategy)
  }

  // 记录响应时间
  recordResponseTime(duration: number): void {
    // 简化的统计更新
    this.metrics.responseTime.avg =
      (this.metrics.responseTime.avg * 0.9) + (duration * 0.1)

    // 检查阈值
    if (duration > 1000) {
      this.emitEvent({
        type: 'threshold-exceeded',
        metric: 'responseTime',
        value: duration,
        threshold: 1000
      })
    }
  }

  // 更新缓存统计
  updateCacheStats(hitRate: number, size: number): void {
    this.metrics.cache.hitRate = hitRate
    this.metrics.cache.size = size
    this.metrics.cache.missRate = 1 - hitRate
  }

  // 更新并发统计
  updateConcurrencyStats(active: number, queued: number): void {
    this.metrics.concurrency.active = active
    this.metrics.concurrency.queued = queued
  }

  // 获取指标
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics }
  }

  // 事件处理
  onEvent(handler: PerformanceEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: PerformanceEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('性能事件处理器错误:', error)
      }
    }
  }

  // 检查并执行优化策略
  async checkAndOptimize(): Promise<void> {
    for (const strategy of this.strategies) {
      if (strategy.shouldOptimize(this.metrics)) {
        await strategy.execute()
      }
    }
  }

  private createEmptyMetrics(): PerformanceMetrics {
    return {
      responseTime: { avg: 0, p50: 0, p90: 0, p99: 0 },
      throughput: { requestsPerSecond: 0, operationsPerSecond: 0 },
      resources: { memoryUsed: 0, memoryTotal: 0, cpuUsage: 0 },
      cache: { hitRate: 0, missRate: 0, size: 0 },
      concurrency: { active: 0, queued: 0, completed: 0 }
    }
  }
}

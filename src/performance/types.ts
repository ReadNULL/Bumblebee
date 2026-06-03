/**
 * 性能优化类型定义
 *
 * 支持缓存、并发控制、资源池等优化功能
 */

// 缓存配置
export interface CacheConfig {
  maxSize: number           // 最大缓存条目数
  ttl: number               // 默认 TTL（毫秒）
  evictionPolicy: 'lru' | 'lfu' | 'fifo'
}

// 缓存条目
export interface CacheEntry<T> {
  key: string
  value: T
  createdAt: Date
  expiresAt: Date
  accessCount: number
  lastAccessed: Date
}

// 并发控制配置
export interface ConcurrencyConfig {
  maxConcurrent: number     // 最大并发数
  queueSize: number         // 队列大小
  timeout: number           // 超时时间（毫秒）
}

// 资源池配置
export interface PoolConfig {
  minSize: number           // 最小池大小
  maxSize: number           // 最大池大小
  acquireTimeout: number    // 获取超时（毫秒）
  idleTimeout: number       // 空闲超时（毫秒）
}

// 性能指标
export interface PerformanceMetrics {
  // 响应时间
  responseTime: {
    avg: number
    p50: number
    p90: number
    p99: number
  }

  // 吞吐量
  throughput: {
    requestsPerSecond: number
    operationsPerSecond: number
  }

  // 资源使用
  resources: {
    memoryUsed: number
    memoryTotal: number
    cpuUsage: number
  }

  // 缓存统计
  cache: {
    hitRate: number
    missRate: number
    size: number
  }

  // 并发统计
  concurrency: {
    active: number
    queued: number
    completed: number
  }
}

// 性能事件
export type PerformanceEvent =
  | { type: 'metric-update'; metrics: PerformanceMetrics }
  | { type: 'threshold-exceeded'; metric: string; value: number; threshold: number }
  | { type: 'resource-warning'; resource: string; usage: number }

// 事件处理器
export type PerformanceEventHandler = (event: PerformanceEvent) => void

// 优化策略接口
export interface OptimizationStrategy {
  name: string
  description: string

  // 评估是否需要优化
  shouldOptimize(metrics: PerformanceMetrics): boolean

  // 执行优化
  execute(): Promise<void>
}

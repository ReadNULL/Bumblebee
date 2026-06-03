/**
 * 仪表板引擎
 *
 * 负责仪表板的管理和数据更新
 */

import {
  Dashboard,
  DashboardConfig,
  DashboardEvent,
  DashboardEventHandler,
  Widget,
  WidgetType,
  MetricData,
  TimeSeriesData,
  TimeRange
} from './types.js'

export class DashboardImpl implements Dashboard {
  id: string
  name: string

  private config: DashboardConfig
  private widgets: Map<string, Widget> = new Map()
  private metrics: Map<string, MetricData> = new Map()
  private timeSeries: TimeSeriesData[] = []
  private eventHandlers: DashboardEventHandler[] = []
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(config: DashboardConfig) {
    this.id = config.id
    this.name = config.name
    this.config = config

    // 初始化组件
    for (const widget of config.widgets) {
      this.widgets.set(widget.id, widget)
    }
  }

  // ========== 生命周期 ==========

  async initialize(): Promise<void> {
    // 初始化数据源
    for (const widget of this.widgets.values()) {
      if (widget.dataSource) {
        await this.initializeDataSource(widget)
      }
    }

    // 设置自动刷新
    if (this.config.refreshInterval) {
      this.refreshTimer = setInterval(() => {
        this.refresh()
      }, this.config.refreshInterval)
    }
  }

  async destroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }

    this.widgets.clear()
    this.metrics.clear()
    this.timeSeries = []
  }

  // ========== 数据更新 ==========

  updateMetric(name: string, value: number | string): void {
    const existing = this.metrics.get(name)

    const metric: MetricData = {
      name,
      value,
      timestamp: new Date(),
      unit: existing?.unit,
      tags: existing?.tags
    }

    this.metrics.set(name, metric)

    // 更新相关组件
    for (const widget of this.widgets.values()) {
      if (widget.type === 'metric' && widget.dataSource?.config?.metricName === name) {
        this.updateWidgetData(widget.id, metric)
      }
    }
  }

  addTimeSeries(data: TimeSeriesData): void {
    this.timeSeries.push(data)

    // 限制数据量
    const maxPoints = 1000
    if (this.timeSeries.length > maxPoints) {
      this.timeSeries = this.timeSeries.slice(-maxPoints)
    }

    // 更新相关组件
    for (const widget of this.widgets.values()) {
      if (widget.type === 'chart' && widget.dataSource?.type === 'function') {
        this.updateWidgetData(widget.id, data)
      }
    }
  }

  // ========== 组件管理 ==========

  addWidget(widget: Widget): void {
    this.widgets.set(widget.id, widget)

    if (widget.dataSource) {
      this.initializeDataSource(widget)
    }
  }

  removeWidget(widgetId: string): boolean {
    return this.widgets.delete(widgetId)
  }

  updateWidget(widgetId: string, updates: Partial<Widget>): void {
    const widget = this.widgets.get(widgetId)
    if (widget) {
      const updated = { ...widget, ...updates }
      this.widgets.set(widgetId, updated)
    }
  }

  // ========== 刷新 ==========

  async refresh(): Promise<void> {
    this.emitEvent({ type: 'refresh', timestamp: new Date() })

    // 刷新所有数据源
    for (const widget of this.widgets.values()) {
      if (widget.dataSource) {
        await this.refreshDataSource(widget)
      }
    }
  }

  // ========== 事件处理 ==========

  onEvent(handler: DashboardEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: DashboardEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('仪表板事件处理器错误:', error)
      }
    }
  }

  // ========== 数据源 ==========

  private async initializeDataSource(widget: Widget): Promise<void> {
    if (!widget.dataSource) {
      return
    }

    switch (widget.dataSource.type) {
      case 'static':
        this.updateWidgetData(widget.id, widget.dataSource.config)
        break

      case 'api':
        // API 数据源会在刷新时获取
        break

      case 'function':
        // 函数数据源会在刷新时调用
        break
    }
  }

  private async refreshDataSource(widget: Widget): Promise<void> {
    if (!widget.dataSource) {
      return
    }

    switch (widget.dataSource.type) {
      case 'api':
        try {
          const response = await fetch(widget.dataSource.config.url)
          const data = await response.json()
          this.updateWidgetData(widget.id, data)
        } catch (error) {
          this.emitEvent({
            type: 'error',
            error: `刷新数据源失败: ${error}`
          })
        }
        break

      case 'function':
        if (typeof widget.dataSource.config.fn === 'function') {
          try {
            const data = await widget.dataSource.config.fn()
            this.updateWidgetData(widget.id, data)
          } catch (error) {
            this.emitEvent({
              type: 'error',
              error: `调用数据源函数失败: ${error}`
            })
          }
        }
        break
    }
  }

  private updateWidgetData(widgetId: string, data: unknown): void {
    // 这里可以触发 UI 更新
    // 在实际应用中，会通知前端组件重新渲染
  }

  // ========== 导出 ==========

  export(): DashboardConfig {
    return {
      ...this.config,
      widgets: Array.from(this.widgets.values())
    }
  }

  // ========== 查询 ==========

  getWidget(widgetId: string): Widget | undefined {
    return this.widgets.get(widgetId)
  }

  getAllWidgets(): Widget[] {
    return Array.from(this.widgets.values())
  }

  getMetric(name: string): MetricData | undefined {
    return this.metrics.get(name)
  }

  getAllMetrics(): MetricData[] {
    return Array.from(this.metrics.values())
  }

  getTimeSeries(range?: TimeRange): TimeSeriesData[] {
    if (!range) {
      return this.timeSeries
    }

    const now = Date.now()
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
      'custom': 0
    }

    const cutoff = now - ranges[range]
    return this.timeSeries.filter(d => d.timestamp.getTime() >= cutoff)
  }
}

// 创建默认仪表板
export function createDefaultDashboard(): DashboardConfig {
  return {
    id: 'default',
    name: 'Bumblebee 仪表板',
    description: '系统监控和数据可视化',
    widgets: [
      {
        id: 'agent-count',
        type: 'metric',
        title: 'Agent 数量',
        position: { x: 0, y: 0 },
        size: { width: 1, height: 1 },
        config: {
          metric: {
            value: 0,
            unit: '个'
          }
        },
        dataSource: {
          type: 'function',
          config: { metricName: 'agent.count' }
        }
      },
      {
        id: 'task-count',
        type: 'metric',
        title: '任务数量',
        position: { x: 1, y: 0 },
        size: { width: 1, height: 1 },
        config: {
          metric: {
            value: 0,
            unit: '个'
          }
        },
        dataSource: {
          type: 'function',
          config: { metricName: 'task.count' }
        }
      },
      {
        id: 'success-rate',
        type: 'metric',
        title: '成功率',
        position: { x: 2, y: 0 },
        size: { width: 1, height: 1 },
        config: {
          metric: {
            value: '0%',
            threshold: { warning: 80, critical: 60 }
          }
        },
        dataSource: {
          type: 'function',
          config: { metricName: 'task.successRate' }
        }
      },
      {
        id: 'response-time',
        type: 'chart',
        title: '响应时间',
        position: { x: 0, y: 1 },
        size: { width: 3, height: 2 },
        config: {
          chart: {
            type: 'line',
            xAxis: 'timestamp',
            yAxis: 'duration',
            colors: ['#4CAF50']
          }
        },
        dataSource: {
          type: 'function',
          config: { metricName: 'response.time' }
        }
      },
      {
        id: 'recent-logs',
        type: 'log',
        title: '最近日志',
        position: { x: 0, y: 3 },
        size: { width: 3, height: 2 },
        config: {
          log: {
            maxLines: 50,
            level: 'info'
          }
        }
      }
    ],
    layout: {
      columns: 3,
      rows: 5,
      gap: 16
    },
    refreshInterval: 5000
  }
}

/**
 * 可视化仪表板类型定义
 *
 * 支持系统监控和数据可视化
 */

// 仪表板组件类型
export type WidgetType =
  | 'metric'         // 指标卡片
  | 'chart'          // 图表
  | 'table'          // 表格
  | 'list'           // 列表
  | 'log'            // 日志
  | 'status'         // 状态指示器
  | 'custom'         // 自定义组件

// 图表类型
export type ChartType = 'line' | 'bar' | 'pie' | 'area' | 'scatter'

// 时间范围
export type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'

// 仪表板配置
export interface DashboardConfig {
  id: string
  name: string
  description?: string
  widgets: Widget[]
  layout: Layout
  refreshInterval?: number    // 自动刷新间隔（毫秒）
  timeRange?: TimeRange
}

// 布局配置
export interface Layout {
  columns: number
  rows: number
  gap: number
}

// 组件配置
export interface Widget {
  id: string
  type: WidgetType
  title: string
  position: WidgetPosition
  size: WidgetSize
  config: WidgetConfig
  dataSource?: DataSource
  data?: unknown
}

// 组件位置
export interface WidgetPosition {
  x: number
  y: number
}

// 组件大小
export interface WidgetSize {
  width: number
  height: number
}

// 组件配置
export interface WidgetConfig {
  // 指标卡片
  metric?: {
    value: number | string
    unit?: string
    trend?: 'up' | 'down' | 'stable'
    threshold?: { warning: number; critical: number }
  }

  // 图表
  chart?: {
    type: ChartType
    xAxis?: string
    yAxis?: string
    series?: string[]
    colors?: string[]
  }

  // 表格
  table?: {
    columns: string[]
    sortable?: boolean
    pagination?: boolean
    pageSize?: number
  }

  // 列表
  list?: {
    maxItems?: number
    showTimestamp?: boolean
  }

  // 日志
  log?: {
    maxLines?: number
    filter?: string
    level?: 'debug' | 'info' | 'warn' | 'error'
  }

  // 状态指示器
  status?: {
    states: Array<{
      value: string
      label: string
      color: string
    }>
  }
}

// 数据源
export interface DataSource {
  type: 'static' | 'api' | 'websocket' | 'function'
  config: any
}

// 指标数据
export interface MetricData {
  name: string
  value: number | string
  unit?: string
  timestamp: Date
  tags?: Record<string, string>
}

// 时间序列数据
export interface TimeSeriesData {
  timestamp: Date
  values: Record<string, number>
}

// 仪表板事件
export type DashboardEvent =
  | { type: 'refresh'; timestamp: Date }
  | { type: 'widget-click'; widgetId: string; data: any }
  | { type: 'time-range-change'; range: TimeRange }
  | { type: 'error'; error: string }

// 事件处理器
export type DashboardEventHandler = (event: DashboardEvent) => void

// 仪表板接口
export interface Dashboard {
  // 基本信息
  id: string
  name: string

  // 生命周期
  initialize(): Promise<void>
  destroy(): Promise<void>

  // 数据更新
  updateMetric(name: string, value: number | string): void
  addTimeSeries(data: TimeSeriesData): void

  // 组件管理
  addWidget(widget: Widget): void
  removeWidget(widgetId: string): void
  updateWidget(widgetId: string, updates: Partial<Widget>): void

  // 刷新
  refresh(): Promise<void>

  // 事件处理
  onEvent(handler: DashboardEventHandler): void

  // 导出
  export(): DashboardConfig
}

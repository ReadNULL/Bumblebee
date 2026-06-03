/**
 * 可视化仪表板模块导出
 */

export { DashboardImpl, createDefaultDashboard } from './dashboard.js'

export type {
  Dashboard,
  DashboardConfig,
  DashboardEvent,
  DashboardEventHandler,
  Widget,
  WidgetType,
  WidgetPosition,
  WidgetSize,
  WidgetConfig,
  DataSource,
  MetricData,
  TimeSeriesData,
  TimeRange,
  ChartType,
  Layout
} from './types.js'

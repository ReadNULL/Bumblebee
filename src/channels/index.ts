/**
 * 渠道系统模块导出
 */

// 类型定义
export * from './types.js'

// 渠道管理器
export { ChannelManager } from './manager.js'

// 配置加载器
export { loadChannelAdapters, validateChannelConfig, createAdapterFromConfig } from './config-loader.js'

// 设置向导
export { ChannelWizard } from './wizard.js'
export type { ChannelSetupResult } from './wizard.js'

// 官方渠道适配器
export {
  WeChatAdapter,
  createWeChatAdapter,
  ensureWeChatPuppetInstalled,
  getWeChatPuppetInstallHint,
} from './wechat.js'
export { FeishuAdapter, createFeishuAdapter } from './feishu.js'
export { DingTalkAdapter, createDingTalkAdapter } from './dingtalk.js'

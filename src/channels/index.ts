/**
 * 渠道系统模块导出
 */

// 类型定义
export * from './types.js'

// 渠道管理器
export { ChannelManager } from './manager.js'

// 官方渠道适配器
export { WeChatAdapter, createWeChatAdapter } from './wechat.js'
export { FeishuAdapter, createFeishuAdapter } from './feishu.js'
export { DingTalkAdapter, createDingTalkAdapter } from './dingtalk.js'

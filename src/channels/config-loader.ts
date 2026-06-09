/**
 * 渠道配置加载器
 *
 * 从 BumblebeeConfig.channels 加载并校验渠道配置，
 * 动态创建适配器实例（懒加载依赖）
 */

import type { ChannelsConfig } from '../core/config.js'
import type { ChannelAdapter } from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

// 解析 ${ENV_VAR} 语法
function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\$\{(\w+)\}/g, (_, envKey) => {
    return process.env[envKey] || ''
  })
}

// 校验渠道配置
export function validateChannelConfig(type: string, config: Record<string, any>): ValidationResult {
  const errors: string[] = []

  if (!config.enabled) {
    return { valid: true, errors: [] }
  }

  switch (type) {
    case 'wechat':
      if (!config.puppet && !config.token) {
        errors.push('微信渠道需要配置 puppet 或 token')
      }
      break

    case 'feishu':
      if (!config.appId) {
        errors.push('飞书渠道需要配置 appId')
      }
      if (!config.appSecret) {
        errors.push('飞书渠道需要配置 appSecret')
      }
      break

    case 'dingtalk':
      if (config.mode === 'enterprise') {
        if (!config.appKey) {
          errors.push('钉钉企业应用模式需要配置 appKey')
        }
        if (!config.appSecret) {
          errors.push('钉钉企业应用模式需要配置 appSecret')
        }
      } else {
        if (!config.webhook) {
          errors.push('钉钉 Webhook 模式需要配置 webhook')
        }
      }
      break

    default:
      errors.push(`未知的渠道类型: ${type}`)
  }

  return { valid: errors.length === 0, errors }
}

// 从配置创建适配器（懒加载）
export async function createAdapterFromConfig(
  type: string,
  config: Record<string, any>
): Promise<ChannelAdapter> {
  const resolved: Record<string, any> = {
    ...config,
    token: resolveEnv(config.token),
    appId: resolveEnv(config.appId),
    appSecret: resolveEnv(config.appSecret),
    encryptKey: resolveEnv(config.encryptKey),
    verificationToken: resolveEnv(config.verificationToken),
    webhook: resolveEnv(config.webhook),
    appKey: resolveEnv(config.appKey),
    robotCode: resolveEnv(config.robotCode),
    port: config.port,
  }

  switch (type) {
    case 'wechat': {
      const { createWeChatAdapter } = await import('./wechat.js')
      return createWeChatAdapter({
        name: 'wechat',
        puppet: resolved.puppet,
        token: resolved.token,
      })
    }

    case 'feishu': {
      const { createFeishuAdapter } = await import('./feishu.js')
      return createFeishuAdapter({
        name: 'feishu',
        appId: resolved.appId as string,
        appSecret: resolved.appSecret as string,
        encryptKey: resolved.encryptKey,
        verificationToken: resolved.verificationToken,
      })
    }

    case 'dingtalk': {
      const { createDingTalkAdapter } = await import('./dingtalk.js')
      if (resolved.mode === 'enterprise') {
        return createDingTalkAdapter({
          name: 'dingtalk',
          appKey: resolved.appKey,
          appSecret: resolved.appSecret,
          robotCode: resolved.robotCode,
          port: resolved.port,
        })
      }
      return createDingTalkAdapter({
        name: 'dingtalk',
        webhook: resolved.webhook,
      })
    }

    default:
      throw new Error(`未知的渠道类型: ${type}`)
  }
}

// 从配置加载所有已启用的渠道适配器
export async function loadChannelAdapters(config: ChannelsConfig): Promise<ChannelAdapter[]> {
  const adapters: ChannelAdapter[] = []
  const channelTypes = ['wechat', 'feishu', 'dingtalk'] as const

  for (const type of channelTypes) {
    const channelConfig = config[type]
    if (!channelConfig?.enabled) continue

    const validation = validateChannelConfig(type, channelConfig)
    if (!validation.valid) {
      console.warn(`渠道 ${type} 配置无效，跳过:`)
      validation.errors.forEach(err => console.warn(`  - ${err}`))
      continue
    }

    try {
      const adapter = await createAdapterFromConfig(type, channelConfig)
      adapters.push(adapter)
    } catch (error) {
      console.error(`加载渠道 ${type} 失败:`, error)
    }
  }

  return adapters
}

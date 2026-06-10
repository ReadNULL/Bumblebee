import type { ChannelsConfig } from '../core/config.js'
import type { ChannelAdapter } from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\$\{(\w+)\}/g, (_match, envKey) => process.env[envKey] || '')
}

export function validateChannelConfig(type: string, config: Record<string, any>): ValidationResult {
  const errors: string[] = []
  if (!config.enabled) return { valid: true, errors }

  switch (type) {
    case 'wechat': {
      const mode = config.mode || 'official-account'
      if (mode === 'official-account') {
        if (!config.token) {
          errors.push('WeChat official-account mode requires channels.wechat.token')
        }
      }
      // weixinbot 模式无需额外配置（token 由扫码获取）
      break
    }

    case 'feishu':
      if (!config.appId) errors.push('Feishu channel requires appId')
      if (!config.appSecret) errors.push('Feishu channel requires appSecret')
      break

    case 'dingtalk':
      if (config.mode === 'enterprise') {
        if (!config.appKey) errors.push('DingTalk enterprise mode requires appKey')
        if (!config.appSecret) errors.push('DingTalk enterprise mode requires appSecret')
      } else if (!config.webhook) {
        errors.push('DingTalk webhook mode requires webhook')
      }
      break

    default:
      errors.push(`未知渠道类型: ${type}`)
  }

  return { valid: errors.length === 0, errors }
}

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
    path: config.path,
    responseTimeoutMs: config.responseTimeoutMs,
  }

  switch (type) {
    case 'wechat': {
      const mode = resolved.mode || 'official-account'
      if (mode === 'weixinbot') {
        const { createWeixinBotAdapter } = await import('./weixinbot.js')
        return createWeixinBotAdapter({
          name: 'wechat',
        })
      }
      const { createWeChatAdapter } = await import('./wechat.js')
      return createWeChatAdapter({
        name: 'wechat',
        token: resolved.token,
        appId: resolved.appId,
        appSecret: resolved.appSecret,
        port: resolved.port,
        path: resolved.path,
        responseTimeoutMs: resolved.responseTimeoutMs,
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
      throw new Error(`Unknown channel type: ${type}`)
  }
}

export async function loadChannelAdapters(config: ChannelsConfig): Promise<ChannelAdapter[]> {
  const adapters: ChannelAdapter[] = []
  const channelTypes = ['wechat', 'feishu', 'dingtalk'] as const

  for (const type of channelTypes) {
    const channelConfig = config[type]
    if (!channelConfig?.enabled) continue

    const validation = validateChannelConfig(type, channelConfig)
    if (!validation.valid) {
      console.warn(`Channel ${type} config is invalid; skipping adapter load.`)
      validation.errors.forEach(error => console.warn(`  - ${error}`))
      continue
    }

    try {
      adapters.push(await createAdapterFromConfig(type, channelConfig))
    } catch (error) {
      console.error(`Failed to load channel ${type}:`, error)
    }
  }

  return adapters
}

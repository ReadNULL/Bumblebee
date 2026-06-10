import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

type ChannelName = 'wechat' | 'feishu' | 'dingtalk'
type PersistChannelConfig = (channelName: ChannelName, channelConfig: Record<string, unknown>) => Promise<void>
type QrCapableChannel = { onQrCode(callback: (qr: string) => void): void }

export function registerChannelCommands(
  runtime: BumblebeeExtensionRuntime,
  persistChannelConfig: PersistChannelConfig,
): void {
  const { channelManager, pi } = runtime

  const showChannelStatus = async (ctx: BumblebeeCommandContext) => {
    const channels = channelManager.getChannels()
    if (channels.length === 0) {
      ctx.ui.notify('未配置任何渠道。使用 /channels setup 添加渠道。', 'info')
      return
    }

    const items = await Promise.all(channels.map(async channel => {
      const status = channel.getStatus ? await channel.getStatus() : 'unknown'
      const icon = status === 'connected' ? 'OK' : status === 'error' ? 'ERR' : '--'
      return `${icon} ${channel.name} (${channel.type}) - ${channel.description || ''}`
    }))
    ctx.ui.notify(`渠道列表 (${channels.length}):\n${items.join('\n')}`, 'info')
  }

  const setupChannel = async (ctx: BumblebeeCommandContext) => {
    const platform = await ctx.ui.select('选择渠道平台', [
      'wechat: 微信（公众号官方接口 / 个人号 ilink 扫码）',
      'feishu: 飞书（开放平台长连接）',
      'dingtalk: 钉钉（Webhook 或企业应用）',
    ])
    if (!platform) return

    const platformId = platform.split(':')[0].trim() as ChannelName
    const config: Record<string, unknown> = { enabled: true }

    if (platformId === 'wechat') {
      await setupWeChat(config, ctx)
    } else if (platformId === 'feishu') {
      await setupFeishu(config, ctx)
    } else {
      await setupDingTalk(config, ctx)
    }

    try {
      const { createAdapterFromConfig } = await import('../../channels/config-loader.js')
      const adapter = await createAdapterFromConfig(platformId, config)
      channelManager.register(adapter)
      await persistChannelConfig(platformId, config)
      ctx.ui.notify(`渠道 ${platformId} 已保存。使用 /channels connect ${adapter.name} 连接。`, 'info')
    } catch (error) {
      ctx.ui.notify(`创建渠道适配器失败: ${error}`, 'error')
    }
  }

  const attachQrHandler = (name: string, channel: unknown, ctx: BumblebeeCommandContext) => {
    if (name === 'wechat' && channel && typeof channel === 'object' && 'onQrCode' in channel) {
      ;(channel as QrCapableChannel).onQrCode((qr: string) => {
        ctx.ui.notify(`请用微信扫码登录:\n${qr}`, 'info')
      })
    }
  }

  const connectChannel = async (target: string, ctx: BumblebeeCommandContext) => {
    const selectedName = target.trim() || await selectChannelName(ctx, '选择要连接的渠道')
    if (!selectedName) return

    const channel = channelManager.getChannel(selectedName)
    if (!channel) {
      ctx.ui.notify(`渠道 "${selectedName}" 不存在`, 'error')
      return
    }

    attachQrHandler(selectedName, channel, ctx)
    try {
      await channel.initialize()
      await channel.connect()
      ctx.ui.notify(`已连接: ${selectedName}`, 'info')
    } catch (error) {
      ctx.ui.notify(`连接 ${selectedName} 失败: ${error}`, 'error')
    }
  }

  const disconnectChannel = async (target: string, ctx: BumblebeeCommandContext) => {
    const name = target.trim()
    const selectedName = name || await selectChannelName(ctx, '选择要断开的渠道', true)
    if (!selectedName) return

    if (selectedName === 'all') {
      await channelManager.disconnectAll()
      ctx.ui.notify('已断开所有渠道', 'info')
      return
    }

    const channel = channelManager.getChannel(selectedName)
    if (!channel) {
      ctx.ui.notify(`渠道 "${selectedName}" 不存在`, 'error')
      return
    }
    await channel.disconnect()
    ctx.ui.notify(`已断开: ${selectedName}`, 'info')
  }

  const selectChannelName = async (
    ctx: BumblebeeCommandContext,
    title: string,
    includeAll = false,
  ): Promise<string | undefined> => {
    const channels = channelManager.getChannels()
    if (channels.length === 0) {
      ctx.ui.notify(includeAll ? '没有已注册渠道' : '没有可用渠道', 'warning')
      return undefined
    }

    const options = channels.map(channel => `${channel.name}: ${channel.description || channel.name}`)
    if (includeAll) options.push('all: 断开所有渠道')
    const selected = await ctx.ui.select(title, options)
    return selected?.split(':')[0].trim()
  }

  pi.registerCommand('channels', {
    description: '渠道管理（/channels、/channels setup、/channels connect [name]、/channels disconnect [name]）',
    getArgumentCompletions: (prefix: string) => {
      const actions = ['status', 'setup', 'connect', 'disconnect']
      const trimmed = prefix.trimStart()
      const parts = trimmed.split(/\s+/)

      if ((parts[0] === 'connect' || parts[0] === 'disconnect') && parts.length >= 2) {
        const namePrefix = parts.slice(1).join(' ')
        return channelManager.getChannels()
          .filter(channel => channel.name.startsWith(namePrefix))
          .map(channel => ({ value: `${parts[0]} ${channel.name}`, label: channel.description || channel.name }))
      }

      return actions
        .filter(action => action.startsWith(trimmed))
        .map(action => ({ value: action, label: `channels ${action}` }))
    },
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const [actionArg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      let action = actionArg
      const target = rest.join(' ')

      if (!action) {
        const selected = await ctx.ui.select('渠道管理', [
          'status: 查看渠道状态',
          'setup: 配置渠道',
          'connect: 连接渠道',
          'disconnect: 断开渠道',
        ])
        if (!selected) return
        action = selected.split(':')[0].trim()
      }

      if (action === 'status' || action === 'list') await showChannelStatus(ctx)
      else if (action === 'setup') await setupChannel(ctx)
      else if (action === 'connect') await connectChannel(target, ctx)
      else if (action === 'disconnect') await disconnectChannel(target, ctx)
      else ctx.ui.notify(`未知渠道操作: ${action}\n用法: /channels status | setup | connect [name] | disconnect [name]`, 'warning')
    },
  })
}

async function setupWeChat(config: Record<string, unknown>, ctx: BumblebeeCommandContext): Promise<void> {
  const mode = await ctx.ui.select('选择微信接入方式', [
    'official-account: 微信公众号官方接口（推荐，需公网回调 URL）',
    'weixinbot: 个人微信 ilink 扫码登录（无需额外配置）',
  ])
  if (!mode) throw new Error('未选择微信接入方式')

  config.mode = mode.split(':')[0].trim()
  if (config.mode === 'weixinbot') {
    ctx.ui.notify('weixinbot 模式无需额外配置。连接时会显示二维码，用微信扫码即可登录。', 'info')
    return
  }

  ctx.ui.notify('请在微信公众平台配置服务器地址：公网地址 + 回调路径，例如 https://example.com/wechat。Token 需要与下方配置一致。', 'info')
  const token = await ctx.ui.input('公众号 Token', '')
  if (!token) throw new Error('微信公众号官方接口需要 Token')
  config.token = token

  const appId = await ctx.ui.input('AppID（可选，用于客服消息主动回复）', '')
  if (appId) config.appId = appId
  const appSecret = await ctx.ui.input('AppSecret（可选，用于客服消息主动回复）', '')
  if (appSecret) config.appSecret = appSecret
  const port = await ctx.ui.input('本地回调端口', '3002')
  config.port = Number(port) || 3002
  const path = await ctx.ui.input('回调路径', '/wechat')
  config.path = path || '/wechat'
}

async function setupFeishu(config: Record<string, unknown>, ctx: BumblebeeCommandContext): Promise<void> {
  ctx.ui.notify('请在飞书开放平台创建应用，启用机器人，事件订阅选择长连接并添加 im.message.receive_v1。', 'info')
  const appId = await ctx.ui.input('App ID', 'cli_xxxxx')
  if (!appId) throw new Error('飞书渠道需要 App ID')
  config.appId = appId
  const appSecret = await ctx.ui.input('App Secret', '')
  if (!appSecret) throw new Error('飞书渠道需要 App Secret')
  config.appSecret = appSecret
  const encryptKey = await ctx.ui.input('加密密钥（可选）', '')
  if (encryptKey) config.encryptKey = encryptKey
}

async function setupDingTalk(config: Record<string, unknown>, ctx: BumblebeeCommandContext): Promise<void> {
  const mode = await ctx.ui.select('选择模式', [
    'webhook: Webhook（只发送消息到群）',
    'enterprise: 企业应用（双向通信）',
  ])
  if (!mode) throw new Error('未选择钉钉模式')
  config.mode = mode.split(':')[0].trim()

  if (config.mode === 'webhook') {
    const webhook = await ctx.ui.input('Webhook 地址', '')
    if (!webhook) throw new Error('钉钉 Webhook 模式需要 Webhook 地址')
    config.webhook = webhook
    return
  }

  const appKey = await ctx.ui.input('AppKey', '')
  if (!appKey) throw new Error('钉钉企业应用需要 AppKey')
  config.appKey = appKey
  const appSecret = await ctx.ui.input('AppSecret', '')
  if (!appSecret) throw new Error('钉钉企业应用需要 AppSecret')
  config.appSecret = appSecret
  const robotCode = await ctx.ui.input('Robot Code（可选）', '')
  if (robotCode) config.robotCode = robotCode
  const port = await ctx.ui.input('回调监听端口', '3001')
  config.port = Number(port) || 3001
}

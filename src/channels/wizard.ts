/**
 * 渠道设置向导
 *
 * 交互式引导用户配置渠道，复用 RoleWizard 的 readline 模式
 */

import * as readline from 'readline'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface ChannelSetupResult {
  type: 'wechat' | 'feishu' | 'dingtalk'
  config: Record<string, any>
}

export class ChannelWizard {
  private rl: readline.Interface

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
  }

  // 询问用户输入
  private async ask(question: string, defaultValue?: string): Promise<string> {
    return new Promise((resolve) => {
      const suffix = defaultValue ? ` (默认: ${defaultValue})` : ''
      this.rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '')
      })
    })
  }

  // 询问选择
  private async askChoice(
    question: string,
    choices: Array<{ value: string; label: string }>,
    defaultValue?: string
  ): Promise<string> {
    console.log(question)
    choices.forEach((choice, index) => {
      const marker = choice.value === defaultValue ? ' (默认)' : ''
      console.log(`  ${index + 1}. ${choice.label}${marker}`)
    })

    const input = await this.ask('请选择', defaultValue)
    const index = parseInt(input) - 1

    if (index >= 0 && index < choices.length) {
      return choices[index].value
    }

    const matched = choices.find(c => c.value === input)
    if (matched) {
      return matched.value
    }

    return defaultValue || choices[0].value
  }

  // 设置渠道（主入口）
  async setupChannel(): Promise<ChannelSetupResult | null> {
    console.log('\n' + '='.repeat(50))
    console.log('📡 渠道接入向导')
    console.log('='.repeat(50))

    try {
      const platform = await this.askChoice(
        '\n选择要接入的平台:',
        [
          { value: 'wechat', label: '微信 (基于 wechaty，扫码登录)' },
          { value: 'feishu', label: '飞书 (基于飞书开放平台，WebSocket 长连接)' },
          { value: 'dingtalk', label: '钉钉 (Webhook 或企业应用)' },
        ]
      )

      let config: Record<string, any>

      switch (platform) {
        case 'wechat':
          config = await this.setupWeChat()
          break
        case 'feishu':
          config = await this.setupFeishu()
          break
        case 'dingtalk':
          config = await this.setupDingTalk()
          break
        default:
          return null
      }

      // 预览
      console.log('\n' + '-'.repeat(50))
      console.log('配置预览:')
      console.log(`  平台: ${platform}`)
      for (const [key, value] of Object.entries(config)) {
        if (key === 'enabled') continue
        const display = this.isSecretField(key) ? '***' : value
        console.log(`  ${key}: ${display}`)
      }
      console.log('-'.repeat(50))

      const confirm = await this.ask('确认保存？(y/n)', 'y')
      if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
        console.log('已取消')
        return null
      }

      // 保存到 .bumblebee.yaml
      await this.saveToConfig(platform, config)
      console.log(`\n✅ ${platform} 渠道配置已保存到 .bumblebee.yaml`)
      console.log('   启动 TUI 后使用 /channels connect 连接')

      return { type: platform as ChannelSetupResult['type'], config }

    } catch (error) {
      console.error('\n❌ 设置渠道时出错:', error)
      return null
    }
  }

  // 微信配置
  private async setupWeChat(): Promise<Record<string, any>> {
    console.log('\n--- 微信渠道配置 ---')
    console.log('前置条件: npm install 会安装 wechaty、Wechat4U 和 PadLocal；XP 需兼容环境手动安装')
    console.log('')

    const puppet = await this.askChoice(
      '选择 Puppet 类型:',
      [
        { value: 'wechaty-puppet-padlocal', label: 'PadLocal (需向 PadLocal/Wechaty 社区申请 token；旧官网可能不可用)' },
        { value: 'wechaty-puppet-wechat4u', label: 'Wechat4U (wechaty 自带，基于 Web 协议，多数账号不可用)' },
        { value: 'wechaty-puppet-xp', label: 'XP (实验性，Node 22 可能无法安装，需手动处理)' },
      ],
      'wechaty-puppet-wechat4u'
    )

    let token: string | undefined
    if (puppet === 'wechaty-puppet-padlocal') {
      console.log('PadLocal token 需要向 PadLocal/Wechaty 社区或服务方申请/购买；旧入口 pad-local.com 可能已不可用。')
      console.log('没有 token 时，建议先使用飞书或钉钉渠道完成 IM 接入验证。')
      token = await this.ask('PadLocal Token', '')
      if (!token) {
        console.log('⚠️  PadLocal 需要 token，否则无法登录')
      }
    }

    return {
      enabled: true,
      puppet,
      ...(token ? { token } : {}),
    }
  }

  // 飞书配置
  private async setupFeishu(): Promise<Record<string, any>> {
    console.log('\n--- 飞书渠道配置 ---')
    console.log('前置条件: npm install @larksuiteoapi/node-sdk')
    console.log('')
    console.log('申请步骤:')
    console.log('  1. 登录 https://open.feishu.cn → 创建企业自建应用')
    console.log('  2. 应用详情 → 凭证与基础信息 → 获取 App ID 和 App Secret')
    console.log('  3. 添加应用能力 → 机器人')
    console.log('  4. 事件订阅 → 添加 im.message.receive_v1')
    console.log('  5. 事件订阅方式: 使用长连接（WebSocket）')
    console.log('  6. 权限管理 → 开通 im:message / im:message:send_as_bot / im:chat:readonly')
    console.log('  7. 版本管理 → 创建版本 → 申请发布')
    console.log('')

    const appId = await this.ask('App ID', '')
    if (!appId) {
      console.log('⚠️  App ID 不能为空')
    }

    const appSecret = await this.ask('App Secret', '')
    if (!appSecret) {
      console.log('⚠️  App Secret 不能为空')
    }

    const encryptKey = await this.ask('加密密钥 (可选，直接回车跳过)', '')
    const verificationToken = await this.ask('验证令牌 (可选，直接回车跳过)', '')

    return {
      enabled: true,
      appId,
      appSecret,
      ...(encryptKey ? { encryptKey } : {}),
      ...(verificationToken ? { verificationToken } : {}),
    }
  }

  // 钉钉配置
  private async setupDingTalk(): Promise<Record<string, any>> {
    console.log('\n--- 钉钉渠道配置 ---')

    const mode = await this.askChoice(
      '选择模式:',
      [
        { value: 'webhook', label: 'Webhook (仅发送消息到群，快速体验)' },
        { value: 'enterprise', label: '企业应用 (双向通信，生产推荐)' },
      ],
      'webhook'
    )

    if (mode === 'webhook') {
      console.log('\n申请步骤:')
      console.log('  1. 打开钉钉群 → 群设置 → 智能群助手 → 添加机器人')
      console.log('  2. 选择"自定义"机器人')
      console.log('  3. 安全设置选择"自定义关键词"（填入 Bumblebee）')
      console.log('  4. 复制 Webhook 地址')
      console.log('')

      const webhook = await this.ask('Webhook 地址', '')
      if (!webhook) {
        console.log('⚠️  Webhook 地址不能为空')
      }

      return { enabled: true, mode: 'webhook', webhook }
    } else {
      console.log('\n申请步骤:')
      console.log('  1. 登录 https://open-dev.dingtalk.com → 创建企业内部应用')
      console.log('  2. 添加"机器人"能力')
      console.log('  3. 凭证与基础信息 → 获取 AppKey 和 AppSecret')
      console.log('  4. 机器人详情 → 获取 Robot Code')
      console.log('')

      const appKey = await this.ask('AppKey', '')
      const appSecret = await this.ask('AppSecret', '')
      const robotCode = await this.ask('Robot Code (可选)', '')

      return {
        enabled: true,
        mode: 'enterprise',
        appKey,
        appSecret,
        ...(robotCode ? { robotCode } : {}),
      }
    }
  }

  // 判断是否为敏感字段
  private isSecretField(key: string): boolean {
    return ['token', 'appSecret', 'webhook', 'encryptKey', 'verificationToken'].includes(key)
  }

  // 保存到 .bumblebee.yaml
  private async saveToConfig(channelType: string, config: Record<string, any>): Promise<void> {
    const configPath = resolve('.bumblebee.yaml')
    let existing: Record<string, any> = {}

    try {
      const content = await readFile(configPath, 'utf-8')
      existing = parseYaml(content) || {}
    } catch {
      // 文件不存在，创建新的
    }

    if (!existing.channels) {
      existing.channels = {}
    }

    existing.channels[channelType] = config

    await writeFile(configPath, stringifyYaml(existing), 'utf-8')
  }

  // 关闭向导
  close(): void {
    this.rl.close()
  }
}

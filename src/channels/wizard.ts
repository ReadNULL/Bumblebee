/**
 * Channel setup wizard.
 *
 * This standalone wizard is kept for CLI flows. The TUI `/channels setup`
 * command uses a separate prompt implementation but should collect the same
 * fields.
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
      output: process.stdout,
    })
  }

  private async ask(question: string, defaultValue?: string): Promise<string> {
    return new Promise((resolveAnswer) => {
      const suffix = defaultValue ? ` (default: ${defaultValue})` : ''
      this.rl.question(`${question}${suffix}: `, (answer) => {
        resolveAnswer(answer.trim() || defaultValue || '')
      })
    })
  }

  private async askChoice(
    question: string,
    choices: Array<{ value: string; label: string }>,
    defaultValue?: string
  ): Promise<string> {
    console.log(question)
    choices.forEach((choice, index) => {
      const marker = choice.value === defaultValue ? ' (default)' : ''
      console.log(`  ${index + 1}. ${choice.label}${marker}`)
    })

    const input = await this.ask('Choose', defaultValue)
    const index = Number.parseInt(input, 10) - 1
    if (index >= 0 && index < choices.length) {
      return choices[index].value
    }

    const matched = choices.find(choice => choice.value === input)
    return matched?.value || defaultValue || choices[0].value
  }

  async setupChannel(): Promise<ChannelSetupResult | null> {
    console.log('\n' + '='.repeat(50))
    console.log('Bumblebee channel setup wizard')
    console.log('='.repeat(50))

    try {
      const platform = await this.askChoice(
        '\nChoose a channel:',
        [
          { value: 'wechat', label: 'WeChat Official Account callback (recommended)' },
          { value: 'feishu', label: 'Feishu bot over Open Platform WebSocket' },
          { value: 'dingtalk', label: 'DingTalk webhook or enterprise bot' },
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

      console.log('\n' + '-'.repeat(50))
      console.log('Configuration preview:')
      console.log(`  channel: ${platform}`)
      for (const [key, value] of Object.entries(config)) {
        if (key === 'enabled') continue
        const display = this.isSecretField(key) ? '***' : value
        console.log(`  ${key}: ${display}`)
      }
      console.log('-'.repeat(50))

      const confirm = await this.ask('Save to .bumblebee.yaml? (y/n)', 'y')
      if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
        console.log('Canceled')
        return null
      }

      await this.saveToConfig(platform, config)
      console.log(`\n${platform} channel configuration saved to .bumblebee.yaml`)
      console.log('Start the TUI and run /channels connect to connect it.')

      return { type: platform as ChannelSetupResult['type'], config }
    } catch (error) {
      console.error('\nFailed to configure channel:', error)
      return null
    }
  }

  private async setupWeChat(): Promise<Record<string, any>> {
    console.log('\n--- WeChat channel ---')
    console.log('Recommended mode: WeChat Official Account official callback API.')
    console.log('For personal accounts, use weixinbot mode (ilink API, QR login).')
    console.log('')

    const mode = await this.askChoice(
      'Choose WeChat connection mode:',
      [
        { value: 'official-account', label: 'Official Account callback (recommended)' },
        { value: 'weixinbot', label: 'Personal account via ilink API (QR login)' },
      ],
      'official-account'
    )

    if (mode === 'weixinbot') {
      return this.setupWeixinBot()
    }

    console.log('\nSteps:')
    console.log('  1. Create or open an app in WeChat Official Account Platform.')
    console.log('  2. Configure a public callback URL that points to this machine.')
    console.log('  3. Use the same token here and in the WeChat server configuration.')
    console.log('')

    const token = await this.ask('Token', '')
    if (!token) {
      console.log('Warning: official-account mode requires token.')
    }

    const appId = await this.ask('AppID (optional, required for proactive customer-service replies)', '')
    const appSecret = await this.ask('AppSecret (optional, required for proactive customer-service replies)', '')
    const portText = await this.ask('Local callback port', '3002')
    const path = await this.ask('Callback path', '/wechat')
    const port = Number.parseInt(portText, 10)

    return {
      enabled: true,
      mode: 'official-account',
      token,
      ...(appId ? { appId } : {}),
      ...(appSecret ? { appSecret } : {}),
      port: Number.isFinite(port) ? port : 3002,
      path: path || '/wechat',
    }
  }

  private async setupWeixinBot(): Promise<Record<string, any>> {
    console.log('\nWeixinBot mode uses the ilink API for personal WeChat accounts.')
    console.log('You will scan a QR code with WeChat to login. Token is cached automatically.')
    console.log('No additional configuration is needed.')
    console.log('')

    return {
      enabled: true,
      mode: 'weixinbot',
    }
  }

  private async setupFeishu(): Promise<Record<string, any>> {
    console.log('\n--- Feishu channel ---')
    console.log('Prerequisite: npm install includes @larksuiteoapi/node-sdk.')
    console.log('')
    console.log('Steps:')
    console.log('  1. Open https://open.feishu.cn and create a self-built app.')
    console.log('  2. Copy App ID and App Secret from Credentials and Basic Info.')
    console.log('  3. Add bot capability and subscribe to im.message.receive_v1.')
    console.log('  4. Choose event delivery over WebSocket.')
    console.log('  5. Enable message sending and chat read permissions, then publish a version.')
    console.log('')

    const appId = await this.ask('App ID', '')
    if (!appId) {
      console.log('Warning: App ID is required.')
    }

    const appSecret = await this.ask('App Secret', '')
    if (!appSecret) {
      console.log('Warning: App Secret is required.')
    }

    const encryptKey = await this.ask('Encrypt key (optional)', '')
    const verificationToken = await this.ask('Verification token (optional)', '')

    return {
      enabled: true,
      appId,
      appSecret,
      ...(encryptKey ? { encryptKey } : {}),
      ...(verificationToken ? { verificationToken } : {}),
    }
  }

  private async setupDingTalk(): Promise<Record<string, any>> {
    console.log('\n--- DingTalk channel ---')

    const mode = await this.askChoice(
      'Choose mode:',
      [
        { value: 'webhook', label: 'Webhook (send-only, quick group testing)' },
        { value: 'enterprise', label: 'Enterprise bot (bidirectional, production)' },
      ],
      'webhook'
    )

    if (mode === 'webhook') {
      console.log('\nSteps:')
      console.log('  1. Open DingTalk group settings and add a custom bot.')
      console.log('  2. Use a custom keyword such as Bumblebee.')
      console.log('  3. Copy the webhook URL.')
      console.log('')

      const webhook = await this.ask('Webhook URL', '')
      if (!webhook) {
        console.log('Warning: webhook URL is required.')
      }

      return { enabled: true, mode: 'webhook', webhook }
    }

    console.log('\nSteps:')
    console.log('  1. Open https://open-dev.dingtalk.com and create an enterprise internal app.')
    console.log('  2. Add bot capability.')
    console.log('  3. Copy AppKey and AppSecret.')
    console.log('  4. Copy Robot Code from bot details if needed.')
    console.log('')

    const appKey = await this.ask('AppKey', '')
    const appSecret = await this.ask('AppSecret', '')
    const robotCode = await this.ask('Robot Code (optional)', '')

    return {
      enabled: true,
      mode: 'enterprise',
      appKey,
      appSecret,
      ...(robotCode ? { robotCode } : {}),
    }
  }

  private isSecretField(key: string): boolean {
    return ['token', 'appSecret', 'webhook', 'encryptKey', 'verificationToken'].includes(key)
  }

  private async saveToConfig(channelType: string, config: Record<string, any>): Promise<void> {
    const configPath = resolve('.bumblebee.yaml')
    let existing: Record<string, any> = {}

    try {
      const content = await readFile(configPath, 'utf-8')
      existing = parseYaml(content) || {}
    } catch {
      existing = {}
    }

    existing.channels = {
      ...(existing.channels || {}),
      [channelType]: config,
    }

    await writeFile(configPath, stringifyYaml(existing), 'utf-8')
  }

  close(): void {
    this.rl.close()
  }
}

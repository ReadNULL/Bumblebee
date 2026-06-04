#!/usr/bin/env node

/**
 * Bumblebee CLI 入口
 *
 * 使用 pi-coding-agent 的 TUI 框架，通过 Bumblebee Extension 注入角色和人格能力
 */

import { main } from '@earendil-works/pi-coding-agent'
import bumblebeeExtension from './tui/extension.js'

const args = process.argv.slice(2)
const command = args[0]

// 子命令：bumblebee init / bumblebee doctor
if (command === 'init') {
  const { runInit } = await import('./cli/init.js')
  await runInit(args.slice(1))
  process.exit(0)
}

if (command === 'doctor') {
  const { runDoctor } = await import('./cli/init.js')
  await runDoctor()
  process.exit(0)
}

// 默认：启动 TUI
await main(args, {
  extensionFactories: [bumblebeeExtension],
})

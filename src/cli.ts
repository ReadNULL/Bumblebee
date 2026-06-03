#!/usr/bin/env node

/**
 * Bumblebee CLI 入口
 *
 * 使用 pi-coding-agent 的 TUI 框架，通过 Bumblebee Extension 注入角色和人格能力
 */

import { main } from '@earendil-works/pi-coding-agent'
import bumblebeeExtension from './tui/extension.js'

await main(process.argv.slice(2), {
  extensionFactories: [bumblebeeExtension],
})

/**
 * bumblebee init — 交互式配置向导
 *
 * 自动检测环境、引导用户配置、生成 .bumblebee.yaml
 */

import { writeFile, access } from 'fs/promises'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { getProviderApiKey } from '../core/config.js'

interface PresetAI {
  provider: string
  model: string
  temperature: number
  maxTokens: number
  apiKey?: string
  baseUrl?: string
}

const PRESETS = {
  mini: {
    personality: { intensity: 'moderate', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 50 },
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 } as PresetAI,
    knowledge: { enabled: false },
    agents: { enabled: false },
    workflows: { enabled: false },
    performance: { enabled: false },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  dev: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 200 },
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 8192 } as PresetAI,
    knowledge: { enabled: true, maxRecords: 2000 },
    agents: { enabled: true, maxConcurrent: 5, defaultTemperature: 0.7 },
    workflows: { enabled: true, defaultTimeout: 300000, maxConcurrentWorkflows: 3 },
    performance: {
      enabled: true,
      cache: { maxSize: 2000, ttl: 600000, evictionPolicy: 'lru' },
      concurrency: { maxConcurrent: 10, queueSize: 200, timeout: 30000 },
    },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  full: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 500 },
    ai: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 8192 } as PresetAI,
    knowledge: { enabled: true, maxRecords: 5000 },
    agents: { enabled: true, maxConcurrent: 10, defaultTemperature: 0.7 },
    workflows: { enabled: true, defaultTimeout: 600000, maxConcurrentWorkflows: 5 },
    performance: {
      enabled: true,
      cache: { maxSize: 5000, ttl: 600000, evictionPolicy: 'lru' },
      concurrency: { maxConcurrent: 20, queueSize: 500, timeout: 60000 },
    },
    dashboard: { enabled: true, refreshInterval: 5000 },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
}

function log(msg: string) { console.log(msg) }

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function detectEnv(configApiKey?: string) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []

  // Node.js 版本
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  checks.push({ name: 'Node.js', ok: major >= 22, detail: `${nodeVersion} (需要 >= 22)` })

  // npm
  try {
    const npmV = execSync('npm --version', { encoding: 'utf-8' }).trim()
    checks.push({ name: 'npm', ok: true, detail: `v${npmV}` })
  } catch {
    checks.push({ name: 'npm', ok: false, detail: '未安装' })
  }

  // Git
  try {
    const gitV = execSync('git --version', { encoding: 'utf-8' }).trim()
    checks.push({ name: 'Git', ok: true, detail: gitV })
  } catch {
    checks.push({ name: 'Git', ok: false, detail: '未安装（可选）' })
  }

  // API Key（配置文件优先，环境变量兜底）
  const hasKey = ['anthropic', 'openai', 'gemini', 'bedrock'].some(provider => !!getProviderApiKey(provider, configApiKey))
  checks.push({ name: 'API Key', ok: hasKey, detail: hasKey ? '已检测到' : '未设置（稍后配置）' })

  return checks
}

function yamlStringify(obj: any, indent = 0): string {
  const lines: string[] = []
  const pad = '  '.repeat(indent)
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      lines.push(yamlStringify(value, indent + 1))
    } else {
      lines.push(`${pad}${key}: ${value}`)
    }
  }
  return lines.join('\n')
}

// 读取一行输入（Node.js stdin）
async function prompt(question: string): Promise<string> {
  process.stdout.write(question)
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8')
    process.stdin.resume()
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolve(String(data).trim())
    })
  })
}

export async function runInit(args: string[]): Promise<void> {
  // 尝试读取已有配置文件中的 apiKey
  let configApiKey: string | undefined
  try {
    const { loadConfig } = await import('../core/config.js')
    const config = await loadConfig()
    configApiKey = config.ai?.apiKey
  } catch { /* 配置文件不存在或解析失败，忽略 */ }

  const presetFlag = args.indexOf('--preset')
  let presetName: string | null = null
  if (presetFlag >= 0 && args[presetFlag + 1]) {
    presetName = args[presetFlag + 1]
  }

  log('')
  log('  Bumblebee 配置向导')
  log('  ─────────────────────────────')
  log('')

  // 环境检测
  log('  检测环境...')
  const envChecks = detectEnv(configApiKey)
  for (const c of envChecks) {
    const icon = c.ok ? '✓' : '✗'
    log(`    ${icon} ${c.name}: ${c.detail}`)
  }
  log('')

  // 选择预设
  let preset: typeof PRESETS.mini
  if (presetName && presetName in PRESETS) {
    preset = PRESETS[presetName as keyof typeof PRESETS]
    log(`  使用预设: ${presetName}`)
  } else if (presetName) {
    log(`  未知预设 "${presetName}"，可用: mini, dev, full`)
    log('')
    process.exit(1)
    return
  } else {
    log('  选择配置预设:')
    log('    1) mini — 最小配置，仅基础对话')
    log('    2) dev     — 开发模式，启用 Agent/工作流/知识系统')
    log('    3) full    — 完整配置，启用所有功能')
    log('')
    const choice = await prompt('  请选择 [1-3] (默认 2): ')
    const map: Record<string, keyof typeof PRESETS> = { '1': 'mini', '2': 'dev', '3': 'full' }
    presetName = map[choice] || 'dev'
    preset = PRESETS[presetName as keyof typeof PRESETS]
    log(`  已选择: ${presetName}`)
    log('')
  }

  // AI 提供商配置
  log('  AI 提供商配置:')
  log('    1) OpenAI 兼容 (OPENAI_API_KEY + OPENAI_BASE_URL)')
  log('    2) Anthropic 直连 (ANTHROPIC_API_KEY)')
  const providerChoice = await prompt('  请选择 [1-2] (默认 1): ')

  if (providerChoice === '2') {
    preset.ai.provider = 'anthropic'
    preset.ai.model = 'claude-sonnet-4-6'
  } else {
    preset.ai.provider = 'openai'
    preset.ai.model = 'gpt-4o'
  }
  log(`  已设置: ${preset.ai.provider} / ${preset.ai.model}`)
  log('')

  // API Key 和 Base URL（配置文件优先；也支持环境变量）
  const envKeyName = preset.ai.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  log(`  建议优先通过环境变量 ${envKeyName} 配置 API Key，避免写入本地配置文件。`)
  const apiKey = await prompt(`  请输入 API Key (留空则使用环境变量 ${envKeyName}): `)
  if (apiKey) {
    // 写入 .env.local 而非配置文件，避免意外泄露
    const envPath = resolve('.env.local')
    const envVarName = preset.ai.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    const envContent = `${envVarName}=${apiKey}\n`
    try {
      const existing = await fileExists(envPath)
      if (existing) {
        const { readFile } = await import('fs/promises')
        const content = await readFile(envPath, 'utf-8')
        if (!content.includes(`${envVarName}=`)) {
          const { appendFile } = await import('fs/promises')
          await appendFile(envPath, envContent, 'utf-8')
        }
      } else {
        await writeFile(envPath, envContent, 'utf-8')
      }
      log(`  API Key 已写入 .env.local（请确保 .env.local 在 .gitignore 中）`)
    } catch {
      log(`  ⚠ 写入 .env.local 失败，请手动设置环境变量 ${envKeyName}`)
    }
    const baseUrl = await prompt('  API Base URL (留空使用默认): ')
    if (baseUrl) {
      preset.ai.baseUrl = baseUrl
    }
  } else {
    log(`  跳过 API Key 配置，请设置环境变量 ${envKeyName}`)
  }
  log('')

  // 生成 .bumblebee.yaml
  const configPath = resolve('.bumblebee.yaml')
  const hasConfig = await fileExists(configPath)
  if (hasConfig) {
    const overwrite = await prompt('  .bumblebee.yaml 已存在，覆盖？[y/N]: ')
    if (overwrite.toLowerCase() !== 'y') {
      log('  保留现有配置')
      log('')
      printDone()
      return
    }
  }

  const yaml = generateYaml(preset)
  await writeFile(configPath, yaml, 'utf-8')
  log(`  已生成 .bumblebee.yaml (${presetName} 预设)`)
  log('  注意: .bumblebee.yaml 可能包含 API Key，已建议加入 .gitignore，请勿提交到远程仓库。')
  log('')
  printDone()
}

function generateYaml(preset: typeof PRESETS.mini): string {
  const ai = preset.ai
  return `# Bumblebee 配置文件
# 文档: https://github.com/your-org/bumblebee

personality:
  intensity: ${preset.personality.intensity}
  theme: ${preset.personality.theme}
  roleId: ${preset.personality.roleId}

memory:
  enabled: ${preset.memory.enabled}
  maxHistory: ${preset.memory.maxHistory}

ai:
  provider: ${ai.provider}
  model: ${ai.model}
  temperature: ${ai.temperature}
  maxTokens: ${ai.maxTokens}${ai.baseUrl ? `\n  baseUrl: ${ai.baseUrl}` : ''}
  # apiKey 建议通过环境变量 ${ai.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} 设置

knowledge:
  enabled: ${preset.knowledge.enabled}${'maxRecords' in preset.knowledge ? `\n  maxRecords: ${(preset.knowledge as any).maxRecords}` : ''}

agents:
  enabled: ${preset.agents.enabled}${'maxConcurrent' in preset.agents ? `\n  maxConcurrent: ${(preset.agents as any).maxConcurrent}` : ''}
  defaultTemperature: ${'defaultTemperature' in preset.agents ? (preset.agents as any).defaultTemperature : 0.7}

workflows:
  enabled: ${preset.workflows.enabled}${'defaultTimeout' in preset.workflows ? `\n  defaultTimeout: ${(preset.workflows as any).defaultTimeout}` : ''}
  maxConcurrentWorkflows: ${'maxConcurrentWorkflows' in preset.workflows ? (preset.workflows as any).maxConcurrentWorkflows : 3}

performance:
  enabled: ${preset.performance.enabled}
  cache:
    maxSize: ${'cache' in preset.performance ? (preset.performance as any).cache.maxSize : 1000}
    ttl: ${'cache' in preset.performance ? (preset.performance as any).cache.ttl : 300000}
    evictionPolicy: ${'cache' in preset.performance ? (preset.performance as any).cache.evictionPolicy : 'lru'}
  concurrency:
    maxConcurrent: ${'concurrency' in preset.performance ? (preset.performance as any).concurrency.maxConcurrent : 10}
    queueSize: ${'concurrency' in preset.performance ? (preset.performance as any).concurrency.queueSize : 100}
    timeout: ${'concurrency' in preset.performance ? (preset.performance as any).concurrency.timeout : 30000}

dashboard:
  enabled: ${preset.dashboard.enabled}

channels:
  wechat:
    enabled: false
  feishu:
    enabled: false
  dingtalk:
    enabled: false
    mode: webhook

collaboration:
  enabled: false

voice:
  enabled: false
`
}

function printDone() {
  log('  配置完成！')
  log('')
  log('  下一步:')
  log('    1. 确保 .bumblebee.yaml 中的 API Key 正确')
  log('    2. 运行 bumblebee 启动 TUI')
  log('    3. 输入 /help 查看所有命令')
  log('')
}

// ========== bumblebee doctor ==========

export async function runDoctor(): Promise<void> {
  // 尝试读取配置文件中的 apiKey
  let configApiKey: string | undefined
  try {
    const { loadConfig } = await import('../core/config.js')
    const config = await loadConfig()
    configApiKey = config.ai?.apiKey
  } catch { /* 配置文件不存在或解析失败，忽略 */ }

  log('')
  log('  Bumblebee 环境诊断')
  log('  ─────────────────────────────')
  log('')

  const checks = detectEnv(configApiKey)
  let allOk = true

  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗'
    const color = c.ok ? '' : ' ← 需要修复'
    log(`    ${icon} ${c.name}: ${c.detail}${color}`)
    if (!c.ok && c.name !== 'Git') allOk = false
  }

  // 检查配置文件
  const configExists = await fileExists(resolve('.bumblebee.yaml'))
  log(`    ${configExists ? '✓' : '✗'} 配置文件: ${configExists ? '.bumblebee.yaml' : '未找到（运行 bumblebee init 创建）'}`)

  // 检查 node_modules
  const nmExists = await fileExists(resolve('node_modules'))
  log(`    ${nmExists ? '✓' : '✗'} 依赖: ${nmExists ? '已安装' : '未安装（运行 npm install）'}`)

  log('')

  if (allOk && configExists) {
    log('  环境检查通过！运行 bumblebee 启动。')
  } else {
    log('  发现问题，请按提示修复后重试。')
  }
  log('')
}

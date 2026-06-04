/**
 * bumblebee init — 交互式配置向导
 *
 * 自动检测环境、引导用户配置、生成 .bumblebee.yaml
 */

import { writeFile, readFile, access } from 'fs/promises'
import { resolve } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const PRESETS = {
  mini: {
    personality: { intensity: 'moderate', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 50 },
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 },
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
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 8192 },
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
    ai: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 8192 },
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

function detectEnv() {
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

  // API Key
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)
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
  const envChecks = detectEnv()
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

  // 检查已有的 .env
  const envPath = resolve('.env')
  const hasEnv = await fileExists(envPath)
  if (!hasEnv) {
    const apiKey = await prompt('  请输入 API Key (留跳过，稍后手动配置 .env): ')
    if (apiKey) {
      const baseUrl = await prompt('  API Base URL (留空使用默认): ')
      const envLines = [
        preset.ai.provider === 'anthropic'
          ? `ANTHROPIC_API_KEY=${apiKey}`
          : `OPENAI_API_KEY=${apiKey}`,
      ]
      if (baseUrl) {
        envLines.push(
          preset.ai.provider === 'anthropic'
            ? `ANTHROPIC_BASE_URL=${baseUrl}`
            : `OPENAI_BASE_URL=${baseUrl}`
        )
      }
      await writeFile(envPath, envLines.join('\n') + '\n', 'utf-8')
      log('  已生成 .env 文件')
    } else {
      log('  跳过 API Key 配置，请稍后手动创建 .env 文件')
    }
  } else {
    log('  .env 文件已存在，跳过')
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
  log('')
  printDone()
}

function generateYaml(preset: typeof PRESETS.mini): string {
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
  provider: ${preset.ai.provider}
  model: ${preset.ai.model}
  temperature: ${preset.ai.temperature}
  maxTokens: ${preset.ai.maxTokens}

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
  log('    1. 确保 .env 中的 API Key 正确')
  log('    2. 运行 bumblebee 启动 TUI')
  log('    3. 输入 /help 查看所有命令')
  log('')
}

// ========== bumblebee doctor ==========

export async function runDoctor(): Promise<void> {
  log('')
  log('  Bumblebee 环境诊断')
  log('  ─────────────────────────────')
  log('')

  const checks = detectEnv()
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

  // 检查 .env
  const envExists = await fileExists(resolve('.env'))
  log(`    ${envExists ? '✓' : '~'} .env 文件: ${envExists ? '已存在' : '未找到（可选）'}`)

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

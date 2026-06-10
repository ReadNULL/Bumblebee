/**
 * bumblebee init - interactive configuration wizard.
 */

import { access, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { execSync } from 'child_process'

interface PresetAI {
  provider: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
}

interface Preset {
  personality: { intensity: 'moderate' | 'high'; theme: 'transformers'; roleId: string }
  memory: { enabled: boolean; maxHistory: number }
  ai: PresetAI
  knowledge: { enabled: boolean; maxRecords?: number }
  agents: { enabled: boolean; maxConcurrent?: number; defaultTemperature?: number }
  workflows: { enabled: boolean; defaultTimeout?: number; maxConcurrentWorkflows?: number }
  dashboard: { enabled: boolean; refreshInterval?: number }
  collaboration: { enabled: boolean }
  voice: { enabled: boolean }
}

const PRESETS: Record<'mini' | 'dev' | 'full', Preset> = {
  mini: {
    personality: { intensity: 'moderate', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 50 },
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutMs: 300000 },
    knowledge: { enabled: false },
    agents: { enabled: false },
    workflows: { enabled: false },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  dev: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 200 },
    ai: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, maxTokens: 8192, timeoutMs: 300000 },
    knowledge: { enabled: true, maxRecords: 2000 },
    agents: { enabled: true, maxConcurrent: 5, defaultTemperature: 0.7 },
    workflows: { enabled: true, defaultTimeout: 300000, maxConcurrentWorkflows: 3 },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  full: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true, maxHistory: 500 },
    ai: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 8192, timeoutMs: 300000 },
    knowledge: { enabled: true, maxRecords: 5000 },
    agents: { enabled: true, maxConcurrent: 10, defaultTemperature: 0.7 },
    workflows: { enabled: true, defaultTimeout: 600000, maxConcurrentWorkflows: 5 },
    dashboard: { enabled: true, refreshInterval: 5000 },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
}

function log(message: string): void {
  console.log(message)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function detectEnv(): Array<{ name: string; ok: boolean; detail: string }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []

  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  checks.push({ name: 'Node.js', ok: major >= 22, detail: `${nodeVersion} (需要 >= 22)` })

  try {
    const npmVersion = execSync('npm --version', { encoding: 'utf-8' }).trim()
    checks.push({ name: 'npm', ok: true, detail: `v${npmVersion}` })
  } catch {
    checks.push({ name: 'npm', ok: false, detail: '未安装' })
  }

  try {
    const gitVersion = execSync('git --version', { encoding: 'utf-8' }).trim()
    checks.push({ name: 'Git', ok: true, detail: gitVersion })
  } catch {
    checks.push({ name: 'Git', ok: false, detail: '未安装（可选）' })
  }

  return checks
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question)
  return new Promise((resolveAnswer) => {
    process.stdin.setEncoding('utf-8')
    process.stdin.resume()
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolveAnswer(String(data).trim())
    })
  })
}

export async function runInit(args: string[]): Promise<void> {
  const presetFlag = args.indexOf('--preset')
  let presetName: keyof typeof PRESETS | null = null
  if (presetFlag >= 0 && args[presetFlag + 1]) {
    presetName = args[presetFlag + 1] as keyof typeof PRESETS
  }

  log('')
  log('  Bumblebee 配置向导')
  log('  ----------------------------')
  log('')

  log('  检测环境...')
  for (const check of detectEnv()) {
    log(`    ${check.ok ? 'OK' : '!!'} ${check.name}: ${check.detail}`)
  }
  log('')

  let preset: Preset
  if (presetName && presetName in PRESETS) {
    preset = PRESETS[presetName]
    log(`  使用预设: ${presetName}`)
  } else if (presetName) {
    log(`  未知预设 "${presetName}"，可用: mini, dev, full`)
    process.exit(1)
    return
  } else {
    log('  选择配置预设:')
    log('    1. mini - 最小配置，仅基础对话')
    log('    2. dev  - 开发模式，启用 Agent/工作流/知识系统')
    log('    3. full - 完整配置，启用所有功能')
    log('')
    const choice = await prompt('  请选择 [1-3] (默认 2): ')
    const map: Record<string, keyof typeof PRESETS> = { '1': 'mini', '2': 'dev', '3': 'full' }
    presetName = map[choice] || 'dev'
    preset = PRESETS[presetName]
    log(`  已选择: ${presetName}`)
  }
  log('')

  log('  AI 提供商配置')
  log('    1. OpenAI 兼容       (OPENAI_API_KEY)')
  log('    2. Anthropic          (ANTHROPIC_API_KEY)')
  log('    3. Google Gemini      (GEMINI_API_KEY)')
  log('    4. DeepSeek           (DEEPSEEK_API_KEY)')
  log('    5. Xiaomi MiMo        (XIAOMI_API_KEY)')
  log('    6. 其他（启动后使用 /model 命令配置）')
  const providerChoice = await prompt('  请选择 [1-6] (默认 1): ')

  const providerMap: Record<string, { provider: string; model: string; envKey: string }> = {
    '1': { provider: 'openai', model: 'gpt-4o', envKey: 'OPENAI_API_KEY' },
    '2': { provider: 'anthropic', model: 'claude-sonnet-4-6', envKey: 'ANTHROPIC_API_KEY' },
    '3': { provider: 'google', model: 'gemini-2.5-pro', envKey: 'GEMINI_API_KEY' },
    '4': { provider: 'deepseek', model: 'deepseek-chat', envKey: 'DEEPSEEK_API_KEY' },
    '5': { provider: 'xiaomi', model: 'mimo-v2.5-pro', envKey: 'XIAOMI_API_KEY' },
  }

  const selected = providerMap[providerChoice]
  if (selected) {
    preset.ai.provider = selected.provider as PresetAI['provider']
    preset.ai.model = selected.model
    log(`  已设置: ${selected.provider} / ${selected.model}`)
    log('')
    log(`  模型认证由 pi-coding-agent SDK 管理，请设置环境变量 ${selected.envKey}。`)
  } else {
    log('  跳过提供商配置，请在启动后使用 /model 命令选择模型并配置认证。')
  }
  log(`  完整 provider 列表见 pi-coding-agent 的 providers.md 文档。`)
  log(`  启动后可随时使用 /model 命令切换模型。`)
  log('')

  const configPath = resolve('.bumblebee.yaml')
  const hasConfig = await fileExists(configPath)
  if (hasConfig) {
    const overwrite = await prompt('  .bumblebee.yaml 已存在，覆盖? [y/N]: ')
    if (overwrite.toLowerCase() !== 'y') {
      log('  保留现有配置')
      log('')
      printDone()
      return
    }
  }

  await writeFile(configPath, generateYaml(preset), 'utf-8')
  log(`  已生成 .bumblebee.yaml (${presetName} 预设)`)
  log('')
  printDone()
}

const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HF_TOKEN',
  kimi: 'KIMI_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
}

function getEnvKeyName(provider: string): string {
  return PROVIDER_ENV_MAP[provider] || `${provider.toUpperCase()}_API_KEY`
}

function generateYaml(preset: Preset): string {
  const ai = preset.ai

  return `# Bumblebee 配置文件

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
  maxTokens: ${ai.maxTokens}
  timeoutMs: ${ai.timeoutMs}
  # 模型认证由 SDK 管理，通过环境变量 ${getEnvKeyName(ai.provider)} 设置
  # 启动后可使用 /model 命令切换模型

knowledge:
  enabled: ${preset.knowledge.enabled}${preset.knowledge.maxRecords ? `\n  maxRecords: ${preset.knowledge.maxRecords}` : ''}

agents:
  enabled: ${preset.agents.enabled}${preset.agents.maxConcurrent ? `\n  maxConcurrent: ${preset.agents.maxConcurrent}` : ''}
  defaultTemperature: ${preset.agents.defaultTemperature ?? 0.7}

workflows:
  enabled: ${preset.workflows.enabled}${preset.workflows.defaultTimeout ? `\n  defaultTimeout: ${preset.workflows.defaultTimeout}` : ''}
  maxConcurrentWorkflows: ${preset.workflows.maxConcurrentWorkflows ?? 3}

dashboard:
  enabled: ${preset.dashboard.enabled}${preset.dashboard.refreshInterval ? `\n  refreshInterval: ${preset.dashboard.refreshInterval}` : ''}

channels:
  wechat:
    enabled: false
    mode: official-account
  feishu:
    enabled: false
  dingtalk:
    enabled: false
    mode: webhook

collaboration:
  enabled: false

voice:
  enabled: false

plugins:
  enabled: false
  modules: []
`
}

function printDone(): void {
  log('  配置完成。')
  log('')
  log('  下一步:')
  log('    1. 设置环境变量（模型认证由 SDK 管理）:')
  log('       export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic')
  log('       export OPENAI_API_KEY=sk-...          # OpenAI')
  log('       export GEMINI_API_KEY=...             # Google Gemini')
  log('       export DEEPSEEK_API_KEY=...           # DeepSeek')
  log('       export XIAOMI_API_KEY=...             # Xiaomi MiMo')
  log('    2. 运行 bumblebee 启动 TUI')
  log('    3. 使用 /model 命令选择和配置模型')
  log('    4. 输入 /help 查看所有命令')
  log('')
  log('  完整 provider 列表见 pi-coding-agent 的 providers.md 文档。')
  log('')
}

export async function runDoctor(): Promise<void> {
  log('')
  log('  Bumblebee 环境诊断')
  log('  ----------------------------')
  log('')

  const checks = detectEnv()
  let allOk = true
  for (const check of checks) {
    log(`    ${check.ok ? 'OK' : '!!'} ${check.name}: ${check.detail}${check.ok ? '' : ' -> 需要修复'}`)
    if (!check.ok && check.name !== 'Git') allOk = false
  }

  const configExists = await fileExists(resolve('.bumblebee.yaml'))
  log(`    ${configExists ? 'OK' : '!!'} 配置文件: ${configExists ? '.bumblebee.yaml' : '未找到（运行 bumblebee init 创建）'}`)

  const nodeModulesExists = await fileExists(resolve('node_modules'))
  log(`    ${nodeModulesExists ? 'OK' : '!!'} 依赖: ${nodeModulesExists ? '已安装' : '未安装（运行 npm install）'}`)

  log('')
  if (allOk && configExists) {
    log('  环境检查通过，可以运行 bumblebee。')
  } else {
    log('  发现问题，请按提示修复后重试。')
  }
  log('')
}

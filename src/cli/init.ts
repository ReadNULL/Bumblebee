/**
 * bumblebee init / doctor.
 */

import { access, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { execSync } from 'child_process'

interface Preset {
  personality: { intensity: 'moderate' | 'high'; theme: 'transformers'; roleId: string }
  memory: { enabled: boolean }
  llm: { timeoutMs: number }
  knowledge: { enabled: boolean; maxRecords?: number }
  agents: { enabled: boolean; maxConcurrent?: number }
  workflows: { enabled: boolean; defaultTimeout?: number; maxConcurrentWorkflows?: number }
  dashboard: { enabled: boolean; refreshInterval?: number }
  collaboration: { enabled: boolean }
  voice: { enabled: boolean }
}

const PRESETS: Record<'mini' | 'dev' | 'full', Preset> = {
  mini: {
    personality: { intensity: 'moderate', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true },
    llm: { timeoutMs: 300000 },
    knowledge: { enabled: false },
    agents: { enabled: false },
    workflows: { enabled: false },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  dev: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true },
    llm: { timeoutMs: 300000 },
    knowledge: { enabled: true, maxRecords: 2000 },
    agents: { enabled: true, maxConcurrent: 5 },
    workflows: { enabled: true, defaultTimeout: 300000, maxConcurrentWorkflows: 3 },
    dashboard: { enabled: false },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
  full: {
    personality: { intensity: 'high', theme: 'transformers', roleId: 'bumblebee' },
    memory: { enabled: true },
    llm: { timeoutMs: 300000 },
    knowledge: { enabled: true, maxRecords: 5000 },
    agents: { enabled: true, maxConcurrent: 10 },
    workflows: { enabled: true, defaultTimeout: 600000, maxConcurrentWorkflows: 5 },
    dashboard: { enabled: true, refreshInterval: 5000 },
    collaboration: { enabled: false },
    voice: { enabled: false },
  },
}

const COMMON_MODEL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
]

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

function commandVersion(command: string, args: string): { ok: boolean; detail: string } {
  try {
    const version = execSync(`${command} ${args}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { ok: true, detail: version }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('npm-cli.js') || message.includes('Cannot find module')) {
      return {
        ok: false,
        detail: 'npm command is broken: wrapper points to a missing npm-cli.js. Reinstall Node.js/npm or fix PATH.',
      }
    }
    return { ok: false, detail: message.split('\n')[0] || 'not available' }
  }
}

function detectEnv(): Array<{ name: string; ok: boolean; detail: string; required?: boolean }> {
  const checks: Array<{ name: string; ok: boolean; detail: string; required?: boolean }> = []

  const nodeVersion = process.version
  const major = Number.parseInt(nodeVersion.slice(1).split('.')[0], 10)
  checks.push({ name: 'Node.js', ok: major >= 22, detail: `${nodeVersion} (requires >= 22)`, required: true })

  const npm = commandVersion('npm', '--version')
  checks.push({ name: 'npm', ok: npm.ok, detail: npm.ok ? `v${npm.detail}` : npm.detail, required: true })

  const git = commandVersion('git', '--version')
  checks.push({ name: 'Git', ok: git.ok, detail: git.ok ? git.detail : `${git.detail} (optional)`, required: false })

  const configuredKeys = COMMON_MODEL_ENV_KEYS.filter(key => !!process.env[key])
  checks.push({
    name: 'Model API key',
    ok: configuredKeys.length > 0,
    detail: configuredKeys.length > 0
      ? `found ${configuredKeys.join(', ')}`
      : 'not found; set one provider env var or configure credentials through pi /model',
    required: false,
  })

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
  log('  Bumblebee configuration wizard')
  log('  ------------------------------')
  log('')

  log('  Checking environment...')
  for (const check of detectEnv()) {
    log(`    ${check.ok ? 'OK' : '!!'} ${check.name}: ${check.detail}`)
  }
  log('')

  let preset: Preset
  if (presetName && presetName in PRESETS) {
    preset = PRESETS[presetName]
    log(`  Using preset: ${presetName}`)
  } else if (presetName) {
    log(`  Unknown preset "${presetName}". Available presets: mini, dev, full`)
    process.exit(1)
    return
  } else {
    log('  Choose a preset:')
    log('    1. mini - minimal config for basic chat')
    log('    2. dev  - recommended, enables knowledge/agents/workflows')
    log('    3. full - enables more experimental modules and dashboard')
    log('')
    const choice = await prompt('  Choose [1-3] (default 2): ')
    const map: Record<string, keyof typeof PRESETS> = { '1': 'mini', '2': 'dev', '3': 'full' }
    presetName = map[choice] || 'dev'
    preset = PRESETS[presetName]
    log(`  Selected: ${presetName}`)
  }
  log('')

  log('  Model configuration is managed by pi-coding-agent.')
  log('  Set provider environment variables such as OPENAI_API_KEY or ANTHROPIC_API_KEY.')
  log('  After starting Bumblebee, use /model to view or switch the active model.')
  log('')

  const configPath = resolve('.bumblebee.yaml')
  const hasConfig = await fileExists(configPath)
  if (hasConfig) {
    const overwrite = await prompt('  .bumblebee.yaml already exists. Overwrite? [y/N]: ')
    if (overwrite.toLowerCase() !== 'y') {
      log('  Keeping existing config.')
      log('')
      printDone()
      return
    }
  }

  await writeFile(configPath, generateYaml(preset), 'utf-8')
  log(`  Generated .bumblebee.yaml (${presetName} preset)`)
  log('')
  printDone()
}

function generateYaml(preset: Preset): string {
  return `# Bumblebee configuration file
#
# Model provider, model name and API keys are managed by pi-coding-agent.
# Set provider environment variables and use /model in the TUI.

personality:
  intensity: ${preset.personality.intensity}
  theme: ${preset.personality.theme}
  roleId: ${preset.personality.roleId}

memory:
  enabled: ${preset.memory.enabled}

llm:
  timeoutMs: ${preset.llm.timeoutMs}

knowledge:
  enabled: ${preset.knowledge.enabled}${preset.knowledge.maxRecords ? `\n  maxRecords: ${preset.knowledge.maxRecords}` : ''}

agents:
  enabled: ${preset.agents.enabled}${preset.agents.maxConcurrent ? `\n  maxConcurrent: ${preset.agents.maxConcurrent}` : ''}

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
  toolTimeoutMs: 10000
  commandTimeoutMs: 10000
  eventLoopWarningMs: 250
`
}

function printDone(): void {
  log('  Configuration complete.')
  log('')
  log('  Next steps:')
  log('    1. Set provider env vars, for example:')
  log('       export ANTHROPIC_API_KEY=sk-ant-...')
  log('       export OPENAI_API_KEY=sk-...')
  log('       export GEMINI_API_KEY=...')
  log('    2. Start Bumblebee.')
  log('    3. Use /model to inspect or switch the active model.')
  log('    4. Type /help to see available commands.')
  log('')
}

export async function runDoctor(): Promise<void> {
  log('')
  log('  Bumblebee environment doctor')
  log('  -----------------------------')
  log('')

  const checks = detectEnv()
  let allRequiredOk = true
  for (const check of checks) {
    const repair = check.ok ? '' : (check.required ? ' -> fix required' : ' -> optional')
    log(`    ${check.ok ? 'OK' : '!!'} ${check.name}: ${check.detail}${repair}`)
    if (check.required && !check.ok) allRequiredOk = false
  }

  const configExists = await fileExists(resolve('.bumblebee.yaml'))
  log(`    ${configExists ? 'OK' : '!!'} Config file: ${configExists ? '.bumblebee.yaml' : 'not found (run bumblebee init)'}`)

  const nodeModulesExists = await fileExists(resolve('node_modules'))
  log(`    ${nodeModulesExists ? 'OK' : '!!'} Dependencies: ${nodeModulesExists ? 'installed' : 'not installed (run npm install)'}`)

  log('')
  if (allRequiredOk && configExists) {
    log('  Environment check passed. You can run bumblebee.')
  } else {
    log('  Issues found. Fix the required items and run doctor again.')
  }
  log('')
}

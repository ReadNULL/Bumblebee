import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

export const PersonalityConfigSchema = z.object({
  intensity: z.enum(['low', 'moderate', 'high']).default('moderate'),
  theme: z.enum(['transformers', 'neutral']).default('transformers'),
  roleId: z.string().default('bumblebee'),
}).default({})

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).default({})

// Model provider, model name, API keys and credentials are owned by pi-coding-agent.
// Bumblebee only keeps a timeout for internal one-shot LLM calls.
export const LLMRuntimeConfigSchema = z.object({
  timeoutMs: z.number().min(1000).max(3600000).default(300000),
}).default({})

export const WeChatChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['official-account', 'weixinbot']).default('official-account'),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  port: z.number().min(1).max(65535).optional(),
  path: z.string().optional(),
  responseTimeoutMs: z.number().min(1000).max(30000).optional(),
  token: z.string().optional(),
}).default({})

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  encryptKey: z.string().optional(),
  verificationToken: z.string().optional(),
}).default({})

export const DingTalkChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['webhook', 'enterprise']).default('webhook'),
  webhook: z.string().optional(),
  appKey: z.string().optional(),
  appSecret: z.string().optional(),
  robotCode: z.string().optional(),
  port: z.number().min(1).max(65535).optional(),
}).default({})

export const ChannelsConfigSchema = z.object({
  wechat: WeChatChannelConfigSchema,
  feishu: FeishuChannelConfigSchema,
  dingtalk: DingTalkChannelConfigSchema,
}).default({})

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>

export const KnowledgeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRecords: z.number().min(100).max(10000).default(1000),
}).default({})

export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().min(1).max(20).default(5),
}).default({})

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>

export const WorkflowsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultTimeout: z.number().min(1000).max(3600000).default(300000),
  maxConcurrentWorkflows: z.number().min(1).max(10).default(3),
}).default({})

export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>

export const DashboardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  refreshInterval: z.number().min(1000).max(60000).default(5000),
}).default({})

export type DashboardConfig = z.infer<typeof DashboardConfigSchema>

export const CollaborationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().optional(),
  userId: z.string().default('local-user'),
  userName: z.string().default('User'),
  autoReconnect: z.boolean().default(true),
  heartbeatInterval: z.number().min(1000).max(60000).default(30000),
}).default({})

export type CollaborationChannelConfig = z.infer<typeof CollaborationConfigSchema>

export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  engine: z.enum(['browser', 'whisper', 'azure', 'google']).default('browser'),
  language: z.string().default('zh-CN'),
  continuous: z.boolean().default(false),
  interimResults: z.boolean().default(true),
}).default({})

export type VoiceChannelConfig = z.infer<typeof VoiceConfigSchema>

export const PluginsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  modules: z.array(z.string()).default([]),
  directory: z.string().optional(),
  toolTimeoutMs: z.number().min(100).max(3600000).default(10000),
  commandTimeoutMs: z.number().min(100).max(3600000).default(10000),
  eventLoopWarningMs: z.number().min(10).max(60000).default(250),
}).default({})

export type PluginsConfig = z.infer<typeof PluginsConfigSchema>

const EMPTY_CHANNELS = {
  wechat: { enabled: false, mode: 'official-account' as const },
  feishu: { enabled: false },
  dingtalk: { enabled: false, mode: 'webhook' as const },
}

export type WeChatChannelConfig = z.infer<typeof WeChatChannelConfigSchema>
export type FeishuChannelConfig = z.infer<typeof FeishuChannelConfigSchema>
export type DingTalkChannelConfig = z.infer<typeof DingTalkChannelConfigSchema>
export type LLMRuntimeConfig = z.infer<typeof LLMRuntimeConfigSchema>

export const BumblebeeConfigSchema = z.object({
  personality: PersonalityConfigSchema,
  memory: MemoryConfigSchema,
  llm: LLMRuntimeConfigSchema,
  channels: ChannelsConfigSchema,
  knowledge: KnowledgeConfigSchema,
  agents: AgentsConfigSchema,
  workflows: WorkflowsConfigSchema,
  dashboard: DashboardConfigSchema,
  collaboration: CollaborationConfigSchema,
  voice: VoiceConfigSchema,
  plugins: PluginsConfigSchema,
})

export type BumblebeeConfig = z.infer<typeof BumblebeeConfigSchema>

function resolveEnvString(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name) => process.env[name] || '')
}

function resolveEnvValues<T>(value: T): T {
  if (typeof value === 'string') {
    return resolveEnvString(value) as T
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveEnvValues(item)) as T
  }

  if (isPlainObject(value)) {
    const resolved: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      resolved[key] = resolveEnvValues(nested)
    }
    return resolved as T
  }

  return value
}

export const DEFAULT_CONFIG: BumblebeeConfig = {
  personality: {
    intensity: 'moderate',
    theme: 'transformers',
    roleId: 'bumblebee',
  },
  memory: {
    enabled: true,
  },
  llm: {
    timeoutMs: 300000,
  },
  channels: EMPTY_CHANNELS,
  knowledge: {
    enabled: true,
    maxRecords: 1000,
  },
  agents: {
    enabled: true,
    maxConcurrent: 5,
  },
  workflows: {
    enabled: true,
    defaultTimeout: 300000,
    maxConcurrentWorkflows: 3,
  },
  dashboard: {
    enabled: false,
    refreshInterval: 5000,
  },
  collaboration: {
    enabled: false,
    userId: 'local-user',
    userName: 'User',
    autoReconnect: true,
    heartbeatInterval: 30000,
  },
  voice: {
    enabled: false,
    engine: 'browser',
    language: 'zh-CN',
    continuous: false,
    interimResults: true,
  },
  plugins: {
    enabled: false,
    modules: [],
    toolTimeoutMs: 10000,
    commandTimeoutMs: 10000,
    eventLoopWarningMs: 250,
  },
}

async function loadConfigFile(path: string): Promise<Partial<BumblebeeConfig>> {
  try {
    const content = await readFile(resolve(path), 'utf-8')

    if (path.endsWith('.yaml') || path.endsWith('.yml')) {
      const parsed = parseYaml(content)
      if (!parsed || typeof parsed !== 'object') {
        console.warn(`Config file ${path} parsed to an empty value. Check YAML syntax.`)
        return {}
      }
      return migrateLegacyConfig(resolveEnvValues(parsed) as Record<string, unknown>)
    }

    return migrateLegacyConfig(resolveEnvValues(JSON.parse(content)) as Record<string, unknown>)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {}
    err.message = `Failed to parse config file ${path}: ${err.message}`
    throw err
  }
}

function migrateLegacyConfig(config: Record<string, unknown>): Partial<BumblebeeConfig> {
  if ('ai' in config && !('llm' in config)) {
    const ai = isPlainObject(config.ai) ? config.ai : {}
    config.llm = {
      timeoutMs: typeof ai.timeoutMs === 'number' ? ai.timeoutMs : undefined,
    }
  }
  delete config.ai
  return config as Partial<BumblebeeConfig>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(merged[key], value)
  }
  return merged as T
}

function mergeConfig(base: BumblebeeConfig, override: Partial<BumblebeeConfig>): BumblebeeConfig {
  return deepMerge(base, override)
}

export async function loadConfig(configPath?: string): Promise<BumblebeeConfig> {
  let userConfig: Partial<BumblebeeConfig> = {}

  if (configPath) {
    userConfig = await loadConfigFile(configPath)
  }

  const defaultPaths = [
    '.bumblebee.yaml',
    '.bumblebee.yml',
    '.bumblebee.json',
    'bumblebee.config.yaml',
    'bumblebee.config.yml',
    'bumblebee.config.json',
  ]

  if (!configPath) {
    for (const path of defaultPaths) {
      const config = await loadConfigFile(path)
      if (Object.keys(config).length > 0) {
        userConfig = config
        break
      }
    }
  }

  const merged = mergeConfig(DEFAULT_CONFIG, userConfig)
  return BumblebeeConfigSchema.parse(merged)
}

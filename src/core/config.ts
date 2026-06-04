import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'

// 配置 Schema
export const PersonalityConfigSchema = z.object({
  intensity: z.enum(['low', 'moderate', 'high']).default('moderate'),
  theme: z.enum(['transformers', 'neutral']).default('transformers'),
  roleId: z.string().default('bumblebee')
}).default({})

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxHistory: z.number().min(10).max(1000).default(100)
}).default({})

export const AIConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'bedrock']).default('anthropic'),
  model: z.string().default('claude-sonnet-4-6'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().min(1).max(100000).default(4096),
  apiKey: z.string().optional()
}).default({})

// 渠道配置 Schema
export const WeChatChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  puppet: z.string().optional(),
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
}).default({})

export const ChannelsConfigSchema = z.object({
  wechat: WeChatChannelConfigSchema,
  feishu: FeishuChannelConfigSchema,
  dingtalk: DingTalkChannelConfigSchema,
}).default({})

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>

// 知识系统配置 Schema
export const KnowledgeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRecords: z.number().min(100).max(10000).default(1000),
}).default({})

export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>

// Agent 配置 Schema
export const AgentsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().min(1).max(20).default(5),
  defaultTemperature: z.number().min(0).max(2).default(0.7),
}).default({})

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>

// 工作流配置 Schema
export const WorkflowsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaultTimeout: z.number().min(1000).max(3600000).default(300000),
  maxConcurrentWorkflows: z.number().min(1).max(10).default(3),
}).default({})

export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>

// 性能配置 Schema
export const PerformanceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cache: z.object({
    maxSize: z.number().min(10).max(10000).default(1000),
    ttl: z.number().min(1000).max(3600000).default(300000),
    evictionPolicy: z.enum(['lru', 'lfu', 'fifo']).default('lru'),
  }).default({}),
  concurrency: z.object({
    maxConcurrent: z.number().min(1).max(100).default(10),
    queueSize: z.number().min(1).max(1000).default(100),
    timeout: z.number().min(1000).max(60000).default(30000),
  }).default({}),
}).default({})

export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>

// 仪表盘配置 Schema
export const DashboardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  refreshInterval: z.number().min(1000).max(60000).default(5000),
}).default({})

export type DashboardConfig = z.infer<typeof DashboardConfigSchema>

// 协作配置 Schema
export const CollaborationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serverUrl: z.string().optional(),
  userId: z.string().default('local-user'),
  userName: z.string().default('User'),
  autoReconnect: z.boolean().default(true),
  heartbeatInterval: z.number().min(1000).max(60000).default(30000),
}).default({})

export type CollaborationChannelConfig = z.infer<typeof CollaborationConfigSchema>

// 语音配置 Schema
export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  engine: z.enum(['browser', 'whisper', 'azure', 'google']).default('browser'),
  language: z.string().default('zh-CN'),
  continuous: z.boolean().default(false),
  interimResults: z.boolean().default(true),
}).default({})

export type VoiceChannelConfig = z.infer<typeof VoiceConfigSchema>

const EMPTY_CHANNELS = {
  wechat: { enabled: false },
  feishu: { enabled: false },
  dingtalk: { enabled: false, mode: 'webhook' as const },
}
export type WeChatChannelConfig = z.infer<typeof WeChatChannelConfigSchema>
export type FeishuChannelConfig = z.infer<typeof FeishuChannelConfigSchema>
export type DingTalkChannelConfig = z.infer<typeof DingTalkChannelConfigSchema>

export const BumblebeeConfigSchema = z.object({
  personality: PersonalityConfigSchema,
  memory: MemoryConfigSchema,
  ai: AIConfigSchema,
  channels: ChannelsConfigSchema,
  knowledge: KnowledgeConfigSchema,
  agents: AgentsConfigSchema,
  workflows: WorkflowsConfigSchema,
  performance: PerformanceConfigSchema,
  dashboard: DashboardConfigSchema,
  collaboration: CollaborationConfigSchema,
  voice: VoiceConfigSchema,
})

export type BumblebeeConfig = z.infer<typeof BumblebeeConfigSchema>

// 默认配置
const DEFAULT_CONFIG: BumblebeeConfig = {
  personality: {
    intensity: 'moderate',
    theme: 'transformers',
    roleId: 'bumblebee'
  },
  memory: {
    enabled: true,
    maxHistory: 100
  },
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    temperature: 0.7,
    maxTokens: 4096
  },
  channels: EMPTY_CHANNELS,
  knowledge: {
    enabled: true,
    maxRecords: 1000
  },
  agents: {
    enabled: true,
    maxConcurrent: 5,
    defaultTemperature: 0.7
  },
  workflows: {
    enabled: true,
    defaultTimeout: 300000,
    maxConcurrentWorkflows: 3
  },
  performance: {
    enabled: true,
    cache: {
      maxSize: 1000,
      ttl: 300000,
      evictionPolicy: 'lru' as const
    },
    concurrency: {
      maxConcurrent: 10,
      queueSize: 100,
      timeout: 30000
    }
  },
  dashboard: {
    enabled: false,
    refreshInterval: 5000
  },
  collaboration: {
    enabled: false,
    userId: 'local-user',
    userName: 'User',
    autoReconnect: true,
    heartbeatInterval: 30000
  },
  voice: {
    enabled: false,
    engine: 'browser' as const,
    language: 'zh-CN',
    continuous: false,
    interimResults: true
  }
}

// 加载配置文件
async function loadConfigFile(path: string): Promise<Partial<BumblebeeConfig>> {
  try {
    const content = await readFile(resolve(path), 'utf-8')

    if (path.endsWith('.yaml') || path.endsWith('.yml')) {
      return parseYaml(content)
    }

    return JSON.parse(content)
  } catch {
    return {}
  }
}

// 合并配置
function mergeConfig(base: BumblebeeConfig, override: Partial<BumblebeeConfig>): BumblebeeConfig {
  return {
    personality: { ...base.personality, ...override.personality },
    memory: { ...base.memory, ...override.memory },
    ai: { ...base.ai, ...override.ai },
    channels: {
      wechat: { ...base.channels?.wechat, ...override.channels?.wechat },
      feishu: { ...base.channels?.feishu, ...override.channels?.feishu },
      dingtalk: { ...base.channels?.dingtalk, ...override.channels?.dingtalk },
    },
    knowledge: { ...base.knowledge, ...override.knowledge },
    agents: { ...base.agents, ...override.agents },
    workflows: { ...base.workflows, ...override.workflows },
    performance: {
      ...base.performance,
      ...override.performance,
      cache: { ...base.performance?.cache, ...override.performance?.cache },
      concurrency: { ...base.performance?.concurrency, ...override.performance?.concurrency },
    },
    dashboard: { ...base.dashboard, ...override.dashboard },
    collaboration: { ...base.collaboration, ...override.collaboration },
    voice: { ...base.voice, ...override.voice },
  }
}

// 加载配置
export async function loadConfig(configPath?: string): Promise<BumblebeeConfig> {
  let userConfig: Partial<BumblebeeConfig> = {}

  // 尝试从指定路径加载
  if (configPath) {
    userConfig = await loadConfigFile(configPath)
  }

  // 尝试从默认位置加载
  const defaultPaths = [
    '.bumblebee.yaml',
    '.bumblebee.yml',
    '.bumblebee.json',
    'bumblebee.config.yaml',
    'bumblebee.config.yml',
    'bumblebee.config.json'
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

  // 合并并验证配置
  const merged = mergeConfig(DEFAULT_CONFIG, userConfig)
  return BumblebeeConfigSchema.parse(merged)
}

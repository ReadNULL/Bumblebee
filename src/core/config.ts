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

export const BumblebeeConfigSchema = z.object({
  personality: PersonalityConfigSchema,
  memory: MemoryConfigSchema,
  ai: AIConfigSchema
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
    ai: { ...base.ai, ...override.ai }
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

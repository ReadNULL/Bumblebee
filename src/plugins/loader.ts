import { readdir, stat } from 'fs/promises'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { monitorEventLoopDelay } from 'perf_hooks'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { BumblebeePlugin, BumblebeePluginConfig, BumblebeePluginContext, LoadedBumblebeePlugin } from './types.js'

interface PluginToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
  isError?: boolean
}

export class PluginLoader {
  private loaded: LoadedBumblebeePlugin[] = []
  private toolTimeoutMs = 10000
  private commandTimeoutMs = 10000
  private eventLoopWarningMs = 250

  constructor(private readonly context: BumblebeePluginContext) {}

  getLoadedPlugins(): LoadedBumblebeePlugin[] {
    return [...this.loaded]
  }

  async loadFromConfig(config: BumblebeePluginConfig): Promise<LoadedBumblebeePlugin[]> {
    if (!config.enabled) return []
    this.toolTimeoutMs = config.toolTimeoutMs ?? this.toolTimeoutMs
    this.commandTimeoutMs = config.commandTimeoutMs ?? this.commandTimeoutMs
    this.eventLoopWarningMs = config.eventLoopWarningMs ?? this.eventLoopWarningMs

    const modulePaths = [
      ...config.modules,
      ...await this.discoverDirectory(config.directory),
    ]

    for (const modulePath of modulePaths) {
      await this.load(modulePath)
    }

    return this.getLoadedPlugins()
  }

  async load(modulePath: string): Promise<LoadedBumblebeePlugin> {
    const imported = await import(toImportSpecifier(modulePath))
    const plugin = normalizePlugin(imported)

    await plugin.onInit?.(this.context.agent, this.context)
    for (const channel of plugin.channels || []) {
      this.context.channelManager?.register(channel)
    }
    this.registerCommands(plugin)
    this.registerTools(plugin)

    const loaded = { plugin, modulePath }
    this.loaded.push(loaded)
    this.context.logger?.info(`Loaded plugin ${plugin.name}@${plugin.version}`)
    return loaded
  }

  private async discoverDirectory(directory: string | undefined): Promise<string[]> {
    if (!directory) return []

    const dir = resolve(directory)
    try {
      const entries = await readdir(dir)
      const modules: string[] = []
      for (const entry of entries) {
        if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue
        const fullPath = resolve(dir, entry)
        const info = await stat(fullPath)
        if (info.isFile()) modules.push(fullPath)
      }
      return modules
    } catch (error) {
      this.context.logger?.warn(`Plugin directory is not readable: ${dir}`, error)
      return []
    }
  }

  private registerCommands(plugin: BumblebeePlugin): void {
    if (!this.context.pi) return

    for (const command of plugin.commands || []) {
      this.context.pi.registerCommand(command.name, {
        description: command.description || `Plugin command from ${plugin.name}`,
        handler: async (args: string, ctx: unknown) =>
          this.runWithIsolation(
            plugin.name,
            `command:${command.name}`,
            () => command.handler(args, ctx, this.context),
            this.commandTimeoutMs,
          ),
      })
    }
  }

  private registerTools(plugin: BumblebeePlugin): void {
    if (!this.context.pi) return

    for (const tool of plugin.tools || []) {
      this.context.pi.registerTool(defineTool({
        name: tool.name,
        label: tool.label || tool.name,
        description: tool.description || `Plugin tool from ${plugin.name}`,
        parameters: tool.parameters || Type.Object({}),
        execute: async (_toolCallId, params) => this.runWithIsolation<PluginToolResult>(
          plugin.name,
          `tool:${tool.name}`,
          async () => normalizeToolOutput(await tool.execute(params, this.context)),
          this.toolTimeoutMs,
        ),
      }))
    }
  }

  private async runWithIsolation<T>(
    pluginName: string,
    operation: string,
    fn: () => unknown | Promise<unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const histogram = monitorEventLoopDelay({ resolution: 20 })
    const startedAt = Date.now()
    const timeoutMessage = `Plugin ${pluginName} ${operation} timed out after ${timeoutMs}ms`
    let elapsedMs = 0
    histogram.enable()

    try {
      const result = await withPluginTimeout(
        Promise.resolve().then(fn) as Promise<T>,
        timeoutMs,
        timeoutMessage,
      )
      elapsedMs = Date.now() - startedAt
      if (elapsedMs > timeoutMs) {
        throw new Error(timeoutMessage)
      }
      return result
    } finally {
      elapsedMs ||= Date.now() - startedAt
      histogram.disable()
      const maxDelayMs = Number(histogram.max) / 1_000_000
      if (elapsedMs > timeoutMs || maxDelayMs > this.eventLoopWarningMs) {
        this.context.logger?.warn(
          `Plugin ${pluginName} ${operation} may have blocked the event loop`,
          { elapsedMs, maxEventLoopDelayMs: Number.isFinite(maxDelayMs) ? Math.round(maxDelayMs) : 0 },
        )
      }
    }
  }
}

async function withPluginTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizePlugin(imported: unknown): BumblebeePlugin {
  const record = imported as Record<string, unknown>
  const candidate = (record.default || record.plugin || imported) as Partial<BumblebeePlugin>

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Plugin module must export a BumblebeePlugin object')
  }
  if (!candidate.name || !candidate.version) {
    throw new Error('Plugin must define name and version')
  }

  return candidate as BumblebeePlugin
}

function toImportSpecifier(modulePath: string): string {
  if (modulePath.startsWith('file://')) return modulePath
  if (modulePath.startsWith('.') || modulePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(modulePath)) {
    return pathToFileURL(resolve(modulePath)).href
  }
  return modulePath
}

function normalizeToolOutput(output: unknown): PluginToolResult {
  if (isPiToolResult(output)) {
    return output as PluginToolResult
  }

  if (typeof output === 'string') {
    return { content: [{ type: 'text', text: output }], details: undefined }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    details: output,
  }
}

function isPiToolResult(output: unknown): boolean {
  return !!output
    && typeof output === 'object'
    && Array.isArray((output as { content?: unknown }).content)
}

import { readdir, stat } from 'fs/promises'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
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

  constructor(private readonly context: BumblebeePluginContext) {}

  getLoadedPlugins(): LoadedBumblebeePlugin[] {
    return [...this.loaded]
  }

  async loadFromConfig(config: BumblebeePluginConfig): Promise<LoadedBumblebeePlugin[]> {
    if (!config.enabled) return []

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
        handler: async (args: string, ctx: unknown) => {
          await command.handler(args, ctx, this.context)
        },
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
        execute: async (_toolCallId, params) => normalizeToolOutput(await tool.execute(params, this.context)),
      }))
    }
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

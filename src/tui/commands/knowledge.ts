import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

export function registerKnowledgeCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerCommand('knowledge', {
    description: '知识图谱管理（用法: /knowledge、/knowledge search <关键词>、/knowledge cleanup）',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      let sub = args.trim()

      if (!sub) {
        const selected = await ctx.ui.select('知识图谱管理', [
          'stats: 查看统计',
          'search: 搜索知识节点',
          'cleanup: 清理重复和无效节点',
        ])
        if (!selected) return
        const action = selected.split(':')[0].trim()
        if (action === 'search') {
          const keyword = await ctx.ui.input('输入搜索关键词', '')
          if (!keyword) return
          sub = `search ${keyword}`
        } else {
          sub = action
        }
      }

      if (sub.startsWith('search ')) {
        const keyword = sub.slice(7).trim()
        if (!keyword) {
          ctx.ui.notify('用法: /knowledge search <关键词>', 'info')
          return
        }
        const results = agent.getKnowledge().query({ text: keyword, limit: 10 })
        if (results.length === 0) {
          ctx.ui.notify(`未找到与 "${keyword}" 相关的知识节点`, 'info')
          return
        }
        const list = results.map(r =>
          `- [${r.node.type}] ${r.node.name} (分数: ${r.score.toFixed(2)})`,
        ).join('\n')
        ctx.ui.notify(`搜索结果 (${results.length}):\n${list}`, 'info')
        return
      }

      if (sub === 'cleanup') {
        const kg = agent.getKnowledge()
        const nodes = kg.getAllNodes()
        const before = nodes.length
        const contentMap = new Map<string, string[]>()
        for (const node of nodes) {
          const key = (node.content || '').substring(0, 200)
          if (!key) continue
          contentMap.set(key, [...(contentMap.get(key) || []), node.id])
        }

        let removed = 0
        for (const ids of contentMap.values()) {
          for (const id of ids.slice(1)) {
            kg.removeNode(id)
            removed++
          }
        }

        for (const node of kg.getAllNodes()) {
          const content = node.content || ''
          if (content.length < 10 || content.startsWith('<p align')) {
            kg.removeNode(node.id)
            removed++
          }
        }

        await kg.save()
        ctx.ui.notify(`清理完成: 删除 ${removed} 个重复/无效节点 (${before} → ${kg.getAllNodes().length})`, 'info')
        return
      }

      const stats = agent.getKnowledge().getStats()
      const typeEntries = Object.entries(stats.typeDistribution)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join('\n')
      ctx.ui.notify(
        `知识图谱统计:\n  节点: ${stats.nodeCount}\n  关系: ${stats.relationCount}\n类型分布:\n${typeEntries || '  (空)'}`,
        'info',
      )
    },
  })

  pi.registerCommand('context', {
    description: '显示当前项目上下文（语言、框架、环境）',
    handler: async (_args, ctx: BumblebeeCommandContext) => {
      const summary = agent.getContext().getContextSummary()
      const parts: string[] = []

      if (summary.project) {
        const p = summary.project
        parts.push(`项目上下文:\n  语言: ${p.language || '未知'}\n  框架: ${p.framework || '未知'}\n  依赖数: ${p.dependencies?.length || 0}`)
      }
      if (summary.user) {
        parts.push(`用户上下文:\n  ID: ${summary.user.id || '未知'}`)
      }
      parts.push(`会话变量: ${summary.sessionVars} 个`)
      parts.push(`任务上下文: ${summary.taskContexts} 个`)
      parts.push(`总上下文: ${summary.totalContexts} 个`)
      ctx.ui.notify(parts.join('\n'), 'info')
    },
  })

  pi.registerCommand('learn', {
    description: '学习系统管理（用法: /learn、/learn clear）',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const sub = args.trim()
      if (sub === 'clear') {
        agent.getLearner().clear()
        await agent.getLearner().save()
        ctx.ui.notify('学习数据已清空', 'info')
        return
      }
      if (sub) {
        ctx.ui.notify(`未知子命令: ${sub}`, 'warning')
        return
      }

      const selected = await ctx.ui.select('学习系统', ['stats: 查看统计', 'clear: 清空学习数据'])
      if (!selected) return
      const action = selected.split(':')[0].trim()
      if (action === 'clear') {
        agent.getLearner().clear()
        await agent.getLearner().save()
        ctx.ui.notify('学习数据已清空', 'info')
        return
      }

      const stats = agent.getLearner().getStats()
      const typeEntries = Object.entries(stats.typeDistribution)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join('\n')
      ctx.ui.notify(
        `学习系统统计:\n  记录: ${stats.totalRecords}\n  模式: ${stats.totalPatterns}\n  成功率: ${(stats.successRate * 100).toFixed(1)}%\n类型分布:\n${typeEntries || '  (空)'}`,
        'info',
      )
    },
  })
}

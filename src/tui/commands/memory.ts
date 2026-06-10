import type { BumblebeeCommandContext, BumblebeeExtensionRuntime } from '../context.js'

export function registerMemoryCommands(runtime: BumblebeeExtensionRuntime): void {
  const { agent, pi } = runtime

  pi.registerCommand('memory', {
    description: '记忆管理（用法: /memory、/memory summary、/memory clear）',
    handler: async (args, ctx: BumblebeeCommandContext) => {
      const sub = args.trim()
      if (sub === 'clear') {
        await agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
        return
      }
      if (sub === 'summary') {
        const summary = agent.getMemoryManager().getConversationSummary()
        ctx.ui.notify(summary ? `上次对话摘要:\n${summary}` : '暂无对话摘要', 'info')
        return
      }
      if (sub) {
        ctx.ui.notify(`未知子命令: ${sub}`, 'warning')
        return
      }

      const selected = await ctx.ui.select('记忆管理', [
        'stats: 查看统计',
        'summary: 上次对话摘要',
        'clear: 清空记忆',
      ])
      if (!selected) return

      const action = selected.split(':')[0].trim()
      if (action === 'clear') {
        await agent.clearMemory()
        ctx.ui.notify('记忆已清空', 'info')
      } else if (action === 'summary') {
        const summary = agent.getMemoryManager().getConversationSummary()
        ctx.ui.notify(summary ? `上次对话摘要:\n${summary}` : '暂无对话摘要', 'info')
      } else {
        const stats = agent.getMemoryStats()
        const summary = agent.getMemoryManager().getConversationSummary()
        const summaryStatus = summary ? `有 (${summary.length} 字符)` : '无'
        ctx.ui.notify(
          `用户画像统计:\n  偏好: ${stats.preferences} 条\n  事实: ${stats.facts} 条\n  环境信息: ${stats.environmentKeys} 项\n  上次对话摘要: ${summaryStatus}`,
          'info',
        )
      }
    },
  })
}

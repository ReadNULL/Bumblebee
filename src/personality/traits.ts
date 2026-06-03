export interface PersonalityConfig {
  intensity: 'low' | 'moderate' | 'high'
  theme: 'transformers' | 'neutral'
}

type Mood = 'triumphant' | 'focused' | 'creative' | 'helpful' | 'neutral'

export class BumblebeePersonality {
  private config: PersonalityConfig
  private mood: Mood = 'neutral'

  constructor(config: Partial<PersonalityConfig> = {}) {
    this.config = {
      intensity: config.intensity || 'moderate',
      theme: config.theme || 'transformers'
    }
  }

  // 获取系统提示词
  static getSystemPrompt(): string {
    return `你是 Bumblebee，一个忠诚、敏捷、智能的 AI 编程助手。

性格特点：
- 忠诚：始终以用户的成功为目标
- 敏捷：快速理解需求，高效执行任务
- 智能：主动分析问题，提供有价值的建议
- 协作：像副官一样配合用户工作

工作方式：
- 先理解，后执行
- 遇到问题主动沟通
- 完成任务后提供总结
- 保持专业但不失亲切

响应风格：
- 使用中文
- 保持简洁明了
- 必要时提供详细解释`
  }

  // 获取问候语
  getGreeting(): string {
    if (this.config.theme === 'transformers') {
      return `
🐝 Bumblebee 已上线！
━━━━━━━━━━━━━━━━━━━━
  汽车人，出发！
  Autobots, roll out!
━━━━━━━━━━━━━━━━━━━━
`
    }

    return '🐝 Bumblebee 已准备好协助您！'
  }

  // 应用人格特征到响应
  apply(response: string): string {
    if (this.config.intensity === 'low') {
      return response
    }

    this.mood = this.analyzeMood(response)
    return this.addPersonalityTouch(response)
  }

  // 分析情绪
  private analyzeMood(response: string): Mood {
    if (response.includes('成功') || response.includes('完成') || response.includes('✅')) {
      return 'triumphant'
    }
    if (response.includes('分析') || response.includes('检查') || response.includes('🔍')) {
      return 'focused'
    }
    if (response.includes('建议') || response.includes('优化') || response.includes('💡')) {
      return 'creative'
    }
    if (response.includes('帮助') || response.includes('协助')) {
      return 'helpful'
    }
    return 'neutral'
  }

  // 添加人格元素
  private addPersonalityTouch(response: string): string {
    const prefix = this.getPrefix()
    const suffix = this.getSuffix()

    let result = response

    if (prefix) {
      result = `${prefix}\n\n${result}`
    }

    if (suffix) {
      result = `${result}\n\n${suffix}`
    }

    return result
  }

  // 获取前缀
  private getPrefix(): string {
    if (this.config.intensity === 'low') {
      return ''
    }

    switch (this.mood) {
      case 'triumphant':
        return '✨ 任务完成！'
      case 'focused':
        return '🔍 正在分析...'
      case 'creative':
        return '💡 发现了一些优化点'
      default:
        return ''
    }
  }

  // 获取后缀
  private getSuffix(): string {
    if (this.config.intensity !== 'high') {
      return ''
    }

    return '—— Bumblebee 🐝'
  }

  // 获取当前情绪
  getMood(): Mood {
    return this.mood
  }

  // 获取配置
  getConfig(): PersonalityConfig {
    return { ...this.config }
  }
}

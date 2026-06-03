import * as readline from 'readline'
import { RoleConfig, RoleCreateInput } from './types.js'
import { RoleStore } from './store.js'

export class RoleWizard {
  private rl: readline.Interface
  private store: RoleStore

  constructor(store: RoleStore) {
    this.store = store
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
  }

  // 询问用户输入
  private async ask(question: string, defaultValue?: string): Promise<string> {
    return new Promise((resolve) => {
      const suffix = defaultValue ? ` (默认: ${defaultValue})` : ''
      this.rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '')
      })
    })
  }

  // 询问列表输入
  private async askList(question: string, hint?: string): Promise<string[]> {
    const input = await this.ask(
      `${question}${hint ? `\n  ${hint}` : ''}`
    )
    return input
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  // 询问选择
  private async askChoice(
    question: string,
    choices: Array<{ value: string; label: string }>,
    defaultValue?: string
  ): Promise<string> {
    console.log(question)
    choices.forEach((choice, index) => {
      const marker = choice.value === defaultValue ? ' (默认)' : ''
      console.log(`  ${index + 1}. ${choice.label}${marker}`)
    })

    const input = await this.ask('请选择', defaultValue)
    const index = parseInt(input) - 1

    if (index >= 0 && index < choices.length) {
      return choices[index].value
    }

    // 尝试直接匹配值
    const matched = choices.find(c => c.value === input)
    if (matched) {
      return matched.value
    }

    return defaultValue || choices[0].value
  }

  // 创建角色
  async createRole(): Promise<RoleConfig | null> {
    console.log('\n' + '='.repeat(50))
    console.log('🎭 创建新角色')
    console.log('='.repeat(50))
    console.log('')

    try {
      // 基本信息
      const name = await this.ask('角色名称', '')
      if (!name) {
        console.log('❌ 角色名称不能为空')
        return null
      }

      const description = await this.ask('角色描述', '')
      if (!description) {
        console.log('❌ 角色描述不能为空')
        return null
      }

      // 生成 ID
      const defaultId = RoleStore.generateRoleId(name)
      const id = await this.ask('角色 ID (用于文件名)', defaultId)

      // 检查 ID 是否已存在
      if (this.store.getRole(id)) {
        console.log(`❌ 角色 ID "${id}" 已存在`)
        return null
      }

      // 人格特征
      console.log('\n--- 人格特征 ---')
      const traits = await this.askList(
        '性格特征',
        '例如: 专业, 耐心, 高效, 幽默'
      )

      const communication = await this.ask('沟通风格', '友好、专业')

      const expertise = await this.askList(
        '专业领域',
        '例如: 编程, 调试, 架构设计'
      )

      const values = await this.askList(
        '价值观',
        '例如: 代码质量, 用户成功, 持续学习'
      )

      // 系统提示词
      console.log('\n--- 系统提示词 ---')
      console.log('(这是角色的核心，定义了角色的行为方式)')
      const systemPrompt = await this.ask('系统提示词', '')

      if (!systemPrompt) {
        console.log('❌ 系统提示词不能为空')
        return null
      }

      // 问候语
      console.log('\n--- 问候语 ---')
      const greeting = await this.ask('问候语', `你好！我是${name}。`)

      // 响应风格
      console.log('\n--- 响应风格 ---')
      const tone = await this.askChoice(
        '语气风格',
        [
          { value: 'formal', label: '正式' },
          { value: 'casual', label: '随意' },
          { value: 'friendly', label: '友好' },
          { value: 'professional', label: '专业' }
        ],
        'friendly'
      )

      const verbosity = await this.askChoice(
        '详细程度',
        [
          { value: 'concise', label: '简洁' },
          { value: 'detailed', label: '详细' },
          { value: 'adaptive', label: '自适应' }
        ],
        'adaptive'
      )

      const humor = await this.askChoice(
        '幽默程度',
        [
          { value: 'none', label: '无' },
          { value: 'subtle', label: '轻微' },
          { value: 'moderate', label: '适度' }
        ],
        'subtle'
      )

      const language = await this.askChoice(
        '主要语言',
        [
          { value: 'zh-CN', label: '中文' },
          { value: 'en-US', label: '英文' },
          { value: 'auto', label: '自动' }
        ],
        'zh-CN'
      )

      // 能力声明
      console.log('\n--- 能力声明 ---')
      const capabilities = await this.askList(
        '能力列表',
        '例如: 代码编写, 代码审查, 问题调试'
      )

      if (capabilities.length === 0) {
        console.log('❌ 至少需要一个能力声明')
        return null
      }

      // 限制说明
      console.log('\n--- 限制说明 (可选) ---')
      const limitations = await this.askList(
        '限制说明',
        '例如: 无法访问网络, 知识截止日期'
      )

      // 标签
      console.log('\n--- 标签 (可选) ---')
      const tags = await this.askList(
        '标签',
        '例如: coding, assistant, mentor'
      )

      // 构建角色配置
      const role: RoleConfig = {
        id,
        name,
        description,
        personality: {
          traits,
          communication,
          expertise,
          values
        },
        systemPrompt,
        greeting,
        responseStyle: {
          tone: tone as RoleConfig['responseStyle']['tone'],
          verbosity: verbosity as RoleConfig['responseStyle']['verbosity'],
          humor: humor as RoleConfig['responseStyle']['humor'],
          language: language as RoleConfig['responseStyle']['language']
        },
        capabilities,
        limitations: limitations.length > 0 ? limitations : undefined,
        metadata: {
          version: '1.0.0',
          author: 'user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: tags.length > 0 ? tags : undefined
        }
      }

      // 验证
      const validation = RoleStore.validateRole(role)
      if (!validation.valid) {
        console.log('\n❌ 角色配置无效:')
        validation.errors.forEach(err => console.log(`  - ${err}`))
        return null
      }

      // 确认
      console.log('\n' + '-'.repeat(50))
      console.log('角色预览:')
      console.log(`  名称: ${role.name}`)
      console.log(`  描述: ${role.description}`)
      console.log(`  特征: ${role.personality.traits.join(', ')}`)
      console.log(`  能力: ${role.capabilities.join(', ')}`)
      console.log('-'.repeat(50))

      const confirm = await this.ask('确认创建？(y/n)', 'y')
      if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
        console.log('已取消创建')
        return null
      }

      // 保存角色
      await this.store.saveRole(role)
      console.log(`\n✅ 角色 "${name}" 创建成功！`)
      console.log(`   保存位置: ${role.id}.json`)

      return role

    } catch (error) {
      console.error('\n❌ 创建角色时出错:', error)
      return null
    }
  }

  // 关闭向导
  close(): void {
    this.rl.close()
  }
}

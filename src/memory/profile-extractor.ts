/**
 * 用户画像规则提取器
 *
 * 从对话文本中规则提取用户画像信息
 * TUI extension 和独立 agent 共用此逻辑
 */

import type { UserProfile } from './manager.js'

/**
 * 从对话文本中规则提取用户画像信息
 *
 * @param conversationText 序列化后的对话文本
 * @param existingProfile 已有的用户画像（用于去重）
 * @returns 去重后的新画像信息
 */
export function extractProfileFromConversation(
  conversationText: string,
  existingProfile: UserProfile
): Partial<UserProfile> {
  // 规则提取环境信息
  const environment: Record<string, string> = {}

  // OS 检测
  if (/windows|win11|win10/i.test(conversationText)) {
    environment.os = 'Windows'
  } else if (/macos|mac os|darwin/i.test(conversationText)) {
    environment.os = 'macOS'
  } else if (/linux|ubuntu|debian|centos/i.test(conversationText)) {
    environment.os = 'Linux'
  }

  // 语言检测
  const languages = ['TypeScript', 'JavaScript', 'Python', 'Java', 'Go', 'Rust', 'C++', 'C#', 'PHP', 'Ruby']
  const detectedLangs = languages.filter(lang =>
    new RegExp(`\\b${lang}\\b`, 'i').test(conversationText)
  )
  if (detectedLangs.length > 0) {
    environment.languages = detectedLangs.join(', ')
  }

  // 框架检测
  const frameworks = ['React', 'Vue', 'Angular', 'Next.js', 'Nuxt', 'Express', 'FastAPI', 'Django', 'Spring']
  const detectedFrameworks = frameworks.filter(fw =>
    new RegExp(`\\b${fw.replace('.', '\\.')}`, 'i').test(conversationText)
  )
  if (detectedFrameworks.length > 0) {
    environment.frameworks = detectedFrameworks.join(', ')
  }

  // 工具检测
  const tools = ['Git', 'Docker', 'VS Code', 'Vim', 'Neovim', 'npm', 'yarn', 'pnpm', 'Webpack', 'Vite']
  const detectedTools = tools.filter(tool =>
    new RegExp(`\\b${tool.replace(' ', '\\s*')}`, 'i').test(conversationText)
  )
  if (detectedTools.length > 0) {
    environment.tools = detectedTools.join(', ')
  }

  // 规则提取偏好
  const preferences: string[] = []

  // 编程风格偏好
  if (/简洁|concise|简单/i.test(conversationText)) {
    preferences.push('偏好简洁的代码风格')
  }
  if (/详细|detailed|完整/i.test(conversationText)) {
    preferences.push('偏好详细的代码注释')
  }
  if (/注释|comment/i.test(conversationText)) {
    preferences.push('重视代码注释')
  }
  if (/测试|test|tdd/i.test(conversationText)) {
    preferences.push('重视代码测试')
  }

  // 事实提取
  const facts: string[] = []

  // 项目名称检测
  const projectMatch = conversationText.match(/项目[：:]\s*([^\n,，。]+)/i)
  if (projectMatch) {
    facts.push(`项目: ${projectMatch[1].trim()}`)
  }

  // 截止日期检测
  const deadlineMatch = conversationText.match(/截止[日期]*[：:]\s*([^\n,，。]+)/i)
  if (deadlineMatch) {
    facts.push(`截止日期: ${deadlineMatch[1].trim()}`)
  }

  // 去重
  const existingPrefs = new Set(existingProfile.preferences)
  const existingFacts = new Set(existingProfile.facts)
  const existingEnv = existingProfile.environment

  const newPreferences = preferences.filter(p => !existingPrefs.has(p))
  const newFacts = facts.filter(f => !existingFacts.has(f))

  // 合并环境信息（只添加新的 key）
  const newEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (!existingEnv[key]) {
      newEnvironment[key] = value
    }
  }

  return {
    preferences: newPreferences,
    environment: newEnvironment,
    facts: newFacts,
  }
}

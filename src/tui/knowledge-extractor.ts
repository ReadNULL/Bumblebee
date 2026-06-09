import type { BumblebeeAgent } from '../core/agent.js'

export const KNOWLEDGE_FILE_REGEX = /\b((?:src|tests?|lib|app|dist|build|packages?)[\\/][\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java))\b/g
export const KNOWLEDGE_ERROR_REGEX = /(?:Error|TypeError|ReferenceError|SyntaxError|错误|异常|失败|报错)[：:\s]*(.{10,120})/gi
export const KNOWLEDGE_SOLUTION_REGEX = /(?:修复|解决|改为|改成|使用|需要|应该|改用|替换成|换成)[：:\s]*(.{10,200})/gi
export const KNOWLEDGE_CONCEPT_REGEX = /(\w{2,20})\s*(?:是指|是|指的是|means|is)\s*[：:]\s*(.{10,150})/g

export function extractText(content: string | Array<{ type: string; [key: string]: any }>): string {
  if (typeof content === 'string') return content
  return content?.filter(c => c.type === 'text' && 'text' in c).map(c => (c as any).text).join('\n') ?? ''
}

export function extractKnowledgeFromConversation(messages: any[]): {
  files: Map<string, string[]>
  errors: Array<{ pattern: string; context: string }>
  solutions: Array<{ errorPattern: string; solution: string }>
  concepts: Map<string, string>
} {
  const files = new Map<string, string[]>()
  const errors: Array<{ pattern: string; context: string }> = []
  const solutions: Array<{ errorPattern: string; solution: string }> = []
  const concepts = new Map<string, string>()

  for (const msg of messages) {
    const text = extractText(msg.content)
    if (!text || text.length < 20) continue

    const htmlTagCount = (text.match(/<[a-zA-Z][^>]*>/g) || []).length
    const mdLinkCount = (text.match(/\[.*?\]\(.*?\)/g) || []).length
    if (htmlTagCount > 5 || mdLinkCount > 10) continue

    let match

    if (msg.role === 'assistant') {
      const fileRegex = new RegExp(KNOWLEDGE_FILE_REGEX.source, 'g')
      let fileCount = 0
      while ((match = fileRegex.exec(text)) !== null && fileCount < 10) {
        const filePath = match[1].replace(/\\/g, '/')
        if (filePath.includes('node_modules') || filePath.startsWith('http')) continue
        const existing = files.get(filePath) || []
        if (existing.length < 2) {
          const matchIndex = match.index
          const contextStart = Math.max(0, matchIndex - 50)
          const contextEnd = Math.min(text.length, matchIndex + filePath.length + 150)
          existing.push(text.substring(contextStart, contextEnd))
          files.set(filePath, existing)
          fileCount++
        }
      }
    }

    if (msg.role === 'assistant') {
      const errorRegex = new RegExp(KNOWLEDGE_ERROR_REGEX.source, 'gi')
      while ((match = errorRegex.exec(text)) !== null) {
        errors.push({ pattern: match[0].substring(0, 80), context: text.substring(0, 200) })
      }

      const solRegex = new RegExp(KNOWLEDGE_SOLUTION_REGEX.source, 'gi')
      while ((match = solRegex.exec(text)) !== null) {
        const solution = match[1].trim()
        if (solution.length > 10) {
          solutions.push({ errorPattern: '', solution })
        }
      }
    }

    if (msg.role === 'assistant') {
      const conceptRegex = new RegExp(KNOWLEDGE_CONCEPT_REGEX.source, 'g')
      while ((match = conceptRegex.exec(text)) !== null) {
        concepts.set(match[1], match[2])
      }
    }
  }

  return { files, errors, solutions, concepts }
}

function makeNodeId(type: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9一-鿿]/g, '-').substring(0, 40)
  return `${type}-${safe}`
}

export function extractKnowledgeToGraph(agent: BumblebeeAgent, messages: any[]): void {
  const knowledge = extractKnowledgeFromConversation(messages)
  const kg = agent.getKnowledge()
  const now = new Date()

  for (const [filePath, contexts] of knowledge.files) {
    const id = makeNodeId('file', filePath)
    const existing = kg.getNode(id)
    if (existing) {
      kg.updateNode(id, { updatedAt: now })
    } else {
      kg.addNode({
        id,
        type: 'file',
        name: filePath,
        content: contexts[0] || '',
        metadata: { mentionCount: contexts.length },
        relations: [],
        importance: Math.min(0.5 + contexts.length * 0.1, 0.9),
        confidence: 0.7,
        tags: [filePath.split('.').pop() || 'file'],
      })
    }
  }

  for (const err of knowledge.errors.slice(0, 5)) {
    const id = makeNodeId('error', err.pattern)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'bug',
        name: err.pattern,
        content: err.context,
        metadata: {},
        relations: [],
        importance: 0.7,
        confidence: 0.6,
        tags: ['bug'],
      })
    }
  }

  for (const sol of knowledge.solutions.slice(0, 5)) {
    const id = makeNodeId('solution', sol.solution)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'decision',
        name: sol.solution.substring(0, 60),
        content: sol.solution,
        metadata: {},
        relations: [],
        importance: 0.8,
        confidence: 0.7,
        tags: ['solution'],
      })
    }
  }

  for (const [concept, desc] of knowledge.concepts) {
    const id = makeNodeId('concept', concept)
    if (!kg.getNode(id)) {
      kg.addNode({
        id,
        type: 'concept',
        name: concept,
        content: desc,
        metadata: {},
        relations: [],
        importance: 0.6,
        confidence: 0.7,
        tags: ['concept'],
      })
    }
  }
}

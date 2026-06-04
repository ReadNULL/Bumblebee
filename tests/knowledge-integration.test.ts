import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KnowledgeGraph } from '../src/knowledge/graph.js'
import { Learner } from '../src/knowledge/learner.js'
import { ContextManager } from '../src/knowledge/context.js'
import { MemoryManager } from '../src/memory/manager.js'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('知识系统持久化集成', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bumblebee-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('KnowledgeGraph 持久化', () => {
    it('应该能保存并恢复图谱数据', async () => {
      const storagePath = join(tempDir, 'knowledge-graph.json')

      // 创建图谱并添加数据
      const graph1 = new KnowledgeGraph(storagePath)
      graph1.addNode({
        id: 'node-1',
        type: 'file',
        name: 'test.ts',
        content: 'test content',
        metadata: {},
        relations: [],
        importance: 0.8,
        confidence: 0.9,
        tags: ['test', 'typescript']
      })
      graph1.addNode({
        id: 'node-2',
        type: 'function',
        name: 'testFunc',
        content: 'function code',
        metadata: {},
        relations: [],
        importance: 0.7,
        confidence: 0.8,
        tags: ['function']
      })
      graph1.addRelation('node-1', { type: 'depends_on', targetId: 'node-2', weight: 0.9 })

      await graph1.save()

      // 用新实例加载
      const graph2 = new KnowledgeGraph(storagePath)
      await graph2.load()

      // 验证数据一致
      expect(graph2.getStats().nodeCount).toBe(2)

      const node1 = graph2.getNode('node-1')
      expect(node1).toBeDefined()
      expect(node1?.name).toBe('test.ts')
      expect(node1?.tags).toEqual(['test', 'typescript'])
      expect(node1?.createdAt).toBeInstanceOf(Date)

      const relations = graph2.getRelations('node-1')
      expect(relations.length).toBe(1)
      expect(relations[0].targetId).toBe('node-2')
    })

    it('空图谱保存后加载应为空', async () => {
      const storagePath = join(tempDir, 'empty-graph.json')

      const graph1 = new KnowledgeGraph(storagePath)
      await graph1.save()

      const graph2 = new KnowledgeGraph(storagePath)
      await graph2.load()

      expect(graph2.getStats().nodeCount).toBe(0)
    })

    it('无 storagePath 时 save/load 应静默忽略', async () => {
      const graph = new KnowledgeGraph()
      graph.addNode({
        id: 'node-1',
        type: 'file',
        name: 'test.ts',
        content: '',
        metadata: {},
        relations: [],
        importance: 0.5,
        confidence: 0.5,
        tags: []
      })

      // 不应抛出错误
      await graph.save()
      await graph.load()
      expect(graph.getStats().nodeCount).toBe(1)
    })
  })

  describe('Learner 持久化', () => {
    it('应该能保存并恢复学习数据', async () => {
      const storagePath = join(tempDir, 'learner.json')

      // 创建学习器并记录数据
      const learner1 = new Learner(1000, storagePath)
      learner1.record({
        type: 'pattern',
        input: 'const x = 1',
        output: 'variable declaration',
        success: true,
        context: {}
      })
      learner1.record({
        type: 'correction',
        input: { wrong: 'var x', correct: 'const x' },
        output: 'use const',
        success: true,
        context: {}
      })
      // 多次记录以触发模式学习
      for (let i = 0; i < 5; i++) {
        learner1.record({
          type: 'pattern',
          input: 'const x = 1',
          output: '',
          success: true,
          context: {}
        })
      }

      await learner1.save()

      // 用新实例加载
      const learner2 = new Learner(1000, storagePath)
      await learner2.load()

      // 验证数据一致
      const stats = learner2.getStats()
      expect(stats.totalRecords).toBe(7)
      expect(stats.totalPatterns).toBeGreaterThan(0)
      expect(stats.typeDistribution['pattern']).toBe(6)
      expect(stats.typeDistribution['correction']).toBe(1)

      // 验证记录可检索
      const patternRecords = learner2.getRecords('pattern')
      expect(patternRecords.length).toBe(6)
      expect(patternRecords[0].timestamp).toBeInstanceOf(Date)
    })

    it('空学习器保存后加载应为空', async () => {
      const storagePath = join(tempDir, 'empty-learner.json')

      const learner1 = new Learner(1000, storagePath)
      await learner1.save()

      const learner2 = new Learner(1000, storagePath)
      await learner2.load()

      expect(learner2.getStats().totalRecords).toBe(0)
      expect(learner2.getStats().totalPatterns).toBe(0)
    })
  })

  describe('ContextManager + MemoryManager 桥接', () => {
    it('应该能通过 MemoryManager 获取持久化的用户偏好', async () => {
      const memDir = join(tempDir, 'memory')

      // 写入画像文件
      const memory1 = new MemoryManager({ storageDir: memDir })
      await memory1.initialize()
      await memory1.updateProfile({ theme: 'dark', language: 'zh-CN' })

      // 用新实例加载（验证持久化）
      const memory2 = new MemoryManager({ storageDir: memDir })
      await memory2.initialize()

      // 桥接到 ContextManager
      const context = new ContextManager()
      context.setMemoryManager(memory2)

      const prefs = context.getUserPreferences()
      expect(prefs?.theme).toBe('dark')
      expect(prefs?.language).toBe('zh-CN')
    })
  })
})

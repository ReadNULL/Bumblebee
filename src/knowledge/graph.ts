/**
 * 知识图谱引擎
 *
 * 负责知识的存储、查询和推理
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  KnowledgeNode,
  NodeType,
  Relation,
  RelationType,
  KnowledgeQuery,
  KnowledgeResult
} from './types.js'

export class KnowledgeGraph {
  private nodes: Map<string, KnowledgeNode> = new Map()
  private index: Map<string, Set<string>> = new Map()  // 倒排索引
  private storagePath?: string

  constructor(storagePath?: string) {
    this.storagePath = storagePath
  }

  // ========== 节点管理 ==========

  // 添加节点
  addNode(node: Omit<KnowledgeNode, 'createdAt' | 'updatedAt' | 'accessCount'>): KnowledgeNode {
    const now = new Date()
    const fullNode: KnowledgeNode = {
      ...node,
      createdAt: now,
      updatedAt: now,
      accessCount: 0
    }

    this.nodes.set(fullNode.id, fullNode)
    this.indexNode(fullNode)

    return fullNode
  }

  // 更新节点
  updateNode(id: string, updates: Partial<KnowledgeNode>): KnowledgeNode | null {
    const node = this.nodes.get(id)
    if (!node) {
      return null
    }

    const updated: KnowledgeNode = {
      ...node,
      ...updates,
      updatedAt: new Date()
    }

    this.nodes.set(id, updated)
    this.reindexNode(updated)

    return updated
  }

  // 删除节点
  removeNode(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node) {
      return false
    }

    // 删除相关关系
    for (const relation of node.relations) {
      const targetNode = this.nodes.get(relation.targetId)
      if (targetNode) {
        targetNode.relations = targetNode.relations.filter(r => r.targetId !== id)
      }
    }

    this.nodes.delete(id)
    this.removeFromIndex(id)

    return true
  }

  // 获取节点
  getNode(id: string): KnowledgeNode | undefined {
    const node = this.nodes.get(id)
    if (node) {
      node.accessCount++
    }
    return node
  }

  // 获取所有节点
  getAllNodes(): KnowledgeNode[] {
    return Array.from(this.nodes.values())
  }

  // ========== 关系管理 ==========

  // 添加关系
  addRelation(sourceId: string, relation: Relation): boolean {
    const source = this.nodes.get(sourceId)
    if (!source) {
      return false
    }

    // 检查目标节点是否存在
    const target = this.nodes.get(relation.targetId)
    if (!target) {
      return false
    }

    // 检查是否已存在相同关系
    const exists = source.relations.some(
      r => r.type === relation.type && r.targetId === relation.targetId
    )

    if (exists) {
      return false
    }

    source.relations.push(relation)
    source.updatedAt = new Date()

    return true
  }

  // 删除关系
  removeRelation(sourceId: string, targetId: string, type?: RelationType): boolean {
    const source = this.nodes.get(sourceId)
    if (!source) {
      return false
    }

    const initialLength = source.relations.length
    source.relations = source.relations.filter(
      r => !(r.targetId === targetId && (!type || r.type === type))
    )

    if (source.relations.length < initialLength) {
      source.updatedAt = new Date()
      return true
    }

    return false
  }

  // 获取节点的关系
  getRelations(nodeId: string, type?: RelationType): Relation[] {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return []
    }

    if (type) {
      return node.relations.filter(r => r.type === type)
    }

    return node.relations
  }

  // 获取相关节点
  getRelatedNodes(nodeId: string, type?: RelationType, depth: number = 1): KnowledgeNode[] {
    const visited = new Set<string>()
    const result: KnowledgeNode[] = []

    this.traverseRelations(nodeId, type, depth, visited, result)

    return result
  }

  // 遍历关系
  private traverseRelations(
    nodeId: string,
    type: RelationType | undefined,
    depth: number,
    visited: Set<string>,
    result: KnowledgeNode[]
  ): void {
    if (depth <= 0 || visited.has(nodeId)) {
      return
    }

    visited.add(nodeId)
    const node = this.nodes.get(nodeId)
    if (!node) {
      return
    }

    const relations = type
      ? node.relations.filter(r => r.type === type)
      : node.relations

    for (const relation of relations) {
      const targetNode = this.nodes.get(relation.targetId)
      if (targetNode && !visited.has(relation.targetId)) {
        result.push(targetNode)
        this.traverseRelations(relation.targetId, type, depth - 1, visited, result)
      }
    }
  }

  // ========== 查询 ==========

  // 查询知识
  query(query: KnowledgeQuery): KnowledgeResult[] {
    let results: KnowledgeResult[] = []

    // 获取候选节点
    let candidates = Array.from(this.nodes.values())

    // 类型过滤
    if (query.type) {
      candidates = candidates.filter(n => n.type === query.type)
    }

    // 标签过滤
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter(n =>
        query.tags!.some(tag => n.tags.includes(tag))
      )
    }

    // 重要性过滤
    if (query.minImportance) {
      candidates = candidates.filter(n => n.importance >= query.minImportance!)
    }

    // 置信度过滤
    if (query.minConfidence) {
      candidates = candidates.filter(n => n.confidence >= query.minConfidence!)
    }

    // 文本查询
    if (query.text) {
      const textLower = query.text.toLowerCase()
      const textResults = this.searchByText(textLower, candidates)
      results = textResults
    } else {
      results = candidates.map(node => ({
        node,
        score: this.calculateBaseScore(node)
      }))
    }

    // 按分数排序
    results.sort((a, b) => b.score - a.score)

    // 限制结果数量
    if (query.limit) {
      results = results.slice(0, query.limit)
    }

    return results
  }

  // 文本搜索
  private searchByText(text: string, candidates: KnowledgeNode[]): KnowledgeResult[] {
    const results: KnowledgeResult[] = []

    for (const node of candidates) {
      const score = this.calculateTextScore(text, node)
      if (score > 0) {
        results.push({ node, score })
      }
    }

    return results
  }

  // 计算文本相关性分数
  private calculateTextScore(text: string, node: KnowledgeNode): number {
    let score = 0

    // 名称匹配
    if (node.name.toLowerCase().includes(text)) {
      score += 0.5
    }

    // 内容匹配
    if (node.content.toLowerCase().includes(text)) {
      score += 0.3
    }

    // 标签匹配
    for (const tag of node.tags) {
      if (tag.toLowerCase().includes(text)) {
        score += 0.2
      }
    }

    // 考虑重要性和置信度
    score *= node.importance * node.confidence

    return score
  }

  // 计算基础分数
  private calculateBaseScore(node: KnowledgeNode): number {
    return (
      node.importance * 0.4 +
      node.confidence * 0.3 +
      Math.min(node.accessCount / 100, 1) * 0.3
    )
  }

  // ========== 推理 ==========

  // 推理：找到两个节点之间的路径
  findPath(startId: string, endId: string, maxDepth: number = 5): string[] | null {
    const visited = new Set<string>()
    const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [startId] }]

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!

      if (nodeId === endId) {
        return path
      }

      if (path.length > maxDepth) {
        continue
      }

      if (visited.has(nodeId)) {
        continue
      }

      visited.add(nodeId)

      const node = this.nodes.get(nodeId)
      if (!node) {
        continue
      }

      for (const relation of node.relations) {
        if (!visited.has(relation.targetId)) {
          queue.push({
            nodeId: relation.targetId,
            path: [...path, relation.targetId]
          })
        }
      }
    }

    return null
  }

  // 推理：查找相似节点
  findSimilar(nodeId: string, limit: number = 5): KnowledgeNode[] {
    const node = this.nodes.get(nodeId)
    if (!node) {
      return []
    }

    const candidates = Array.from(this.nodes.values())
      .filter(n => n.id !== nodeId)

    const scored = candidates.map(candidate => ({
      node: candidate,
      score: this.calculateSimilarity(node, candidate)
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(s => s.node)
  }

  // 计算相似度
  private calculateSimilarity(node1: KnowledgeNode, node2: KnowledgeNode): number {
    let score = 0

    // 类型相同
    if (node1.type === node2.type) {
      score += 0.3
    }

    // 标签重叠
    const commonTags = node1.tags.filter(t => node2.tags.includes(t))
    score += commonTags.length * 0.2

    // 关系重叠
    const node1Targets = new Set(node1.relations.map(r => r.targetId))
    const node2Targets = new Set(node2.relations.map(r => r.targetId))
    const commonRelations = [...node1Targets].filter(t => node2Targets.has(t))
    score += commonRelations.length * 0.1

    return Math.min(score, 1)
  }

  // ========== 索引 ==========

  // 索引节点
  private indexNode(node: KnowledgeNode): void {
    // 按类型索引
    this.addToIndex(`type:${node.type}`, node.id)

    // 按标签索引
    for (const tag of node.tags) {
      this.addToIndex(`tag:${tag}`, node.id)
    }

    // 按名称关键词索引
    const words = node.name.toLowerCase().split(/\s+/)
    for (const word of words) {
      if (word.length > 2) {
        this.addToIndex(`word:${word}`, node.id)
      }
    }
  }

  // 重新索引节点
  private reindexNode(node: KnowledgeNode): void {
    this.removeFromIndex(node.id)
    this.indexNode(node)
  }

  // 添加到索引
  private addToIndex(key: string, nodeId: string): void {
    if (!this.index.has(key)) {
      this.index.set(key, new Set())
    }
    this.index.get(key)!.add(nodeId)
  }

  // 从索引移除
  private removeFromIndex(nodeId: string): void {
    for (const [key, nodeIds] of this.index.entries()) {
      nodeIds.delete(nodeId)
      if (nodeIds.size === 0) {
        this.index.delete(key)
      }
    }
  }

  // ========== 统计 ==========

  // 获取统计信息
  getStats(): {
    nodeCount: number
    relationCount: number
    typeDistribution: Record<NodeType, number>
  } {
    const typeDistribution: Record<string, number> = {}
    let relationCount = 0

    for (const node of this.nodes.values()) {
      typeDistribution[node.type] = (typeDistribution[node.type] || 0) + 1
      relationCount += node.relations.length
    }

    return {
      nodeCount: this.nodes.size,
      relationCount,
      typeDistribution: typeDistribution as Record<NodeType, number>
    }
  }

  // 清空图谱
  clear(): void {
    this.nodes.clear()
    this.index.clear()
  }

  // ========== 持久化 ==========

  // 保存到磁盘
  async save(): Promise<void> {
    if (!this.storagePath) return

    try {
      await mkdir(dirname(this.storagePath), { recursive: true })
      const data = {
        nodes: Array.from(this.nodes.values()),
        index: Array.from(this.index.entries()).map(([key, ids]) => [key, Array.from(ids)])
      }
      await writeFile(this.storagePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      // 写入失败静默忽略
    }
  }

  // 从磁盘加载
  async load(): Promise<void> {
    if (!this.storagePath) return

    try {
      const content = await readFile(this.storagePath, 'utf-8')
      const data = JSON.parse(content)

      // 恢复节点（还原 Date 对象）
      this.nodes.clear()
      for (const node of data.nodes ?? []) {
        node.createdAt = new Date(node.createdAt)
        node.updatedAt = new Date(node.updatedAt)
        this.nodes.set(node.id, node)
      }

      // 恢复索引
      this.index.clear()
      for (const [key, ids] of data.index ?? []) {
        this.index.set(key, new Set(ids))
      }
    } catch {
      // 文件不存在或解析失败，使用空图谱
    }
  }
}

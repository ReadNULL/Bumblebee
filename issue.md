# TUI 新增命令测试问题清单

## 测试范围

21 条新增 TUI 命令逐个审计，对比实现代码与底层 API 的正确性。

---

## Issue #1: `/learn clear` 仅清空内存，不持久化 [已修复]

**命令**: `/learn clear`
**文件**: `src/tui/extension.ts:813-816`
**问题**: `agent.getLearner().clear()` 只清空内存中的 `records` 和 `patterns`，但不调用 `save()` 持久化到磁盘。重启后数据会从 `learner.json` 重新加载，等于没清。
**修复**: clear 后调用 `await agent.getLearner().save()`。

---

## Issue #2: `/agent-run` 执行后 Agent 累积不清理 [已修复]

**命令**: `/agent-run <team> [task]`
**文件**: `src/tui/extension.ts:983`
**问题**: `orch.executeTeamTask()` 内部调用 `orchestrate()` → `manager.registerAgent()`，执行完成后 Agent 不会被移除。多次运行 `/agent-run` 会导致 AgentManager 中的 Agent 持续累积。
**修复**: 执行完成后调用 `mgr.removeAgent()` 清理本次注册的 Agent。

---

## Issue #3: `/perf` 性能指标永远为零 [已修复]

**命令**: `/perf`
**文件**: `src/tui/extension.ts:1084-1106`
**问题**: `PerformanceMonitor` 初始化后 `metrics` 全部为零，因为系统中没有任何地方调用 `recordResponseTime()` 或 `updateConcurrencyStats()`。缓存命中率也因为同样原因显示为 0。
**修复**: `/perf` 命令改为从实际的 `LRUCache.getStats()` 和 `ConcurrencyController.getStats()` 读取实时数据，PerformanceMonitor 作为可选的补充数据源。

---

## Issue #4: `/cache` 命中率统计逻辑错误 [已修复]

**命令**: `/cache`
**文件**: `src/performance/optimizer.ts:98-111`
**问题**: `LRUCache.getStats()` 的命中率计算有误。`totalMisses` 始终为 0（没有 miss 计数器），导致 `missRate` 永远是 0，`hitRate` 计算也不准确。
**修复**: 在 LRUCache 中增加 `hits` 和 `misses` 计数器，在 `get()` 命中/未命中时分别递增，`getStats()` 直接使用这两个计数器计算命中率。

---

## Issue #5: `/voice start|stop|speak` 全部崩溃 — 未初始化 [已修复]

**命令**: `/voice start`, `/voice stop`, `/voice speak <text>`
**文件**: `src/tui/extension.ts:1254-1266` + `src/voice/engine.ts:96-111`
**问题**: `VoiceEngineImpl` 在 `agent.ts` 中只创建实例，从未调用 `initialize()`。因此 `recognition` 和 `synthesis` 均为 `null`。调用 `startListening()` 抛出 "语音识别未初始化"，`speak()` 抛出 "语音合成未初始化"。命令 handler 没有 try/catch，异常会直接传播。
**修复**: 在 `agent.ts` 的 `initialize()` 中对 VoiceEngineImpl 调用 `await voice.initialize()`（用 try/catch 包裹，失败时设为 null），并在所有 voice 命令 handler 中增加 try/catch 错误处理。

---

## Issue #6: `/voice` 状态显示不准确 [已修复]

**命令**: `/voice`
**文件**: `src/tui/extension.ts:1268-1270`
**问题**: 当 VoiceEngineImpl 未初始化时（initialize() 从未调用），`/voice` 仍显示 "语音引擎: 已初始化"，这具有误导性。
**修复**: 改为显示 `voice.status` 属性（idle/listening/speaking/error），`voice_status` 工具同步修改。

---

## Issue #7: 知识提取 — 错误与解决方案的关联是随机的 [已修复]

**文件**: `src/tui/extension.ts:153-159`
**问题**: `extractKnowledgeFromConversation()` 中，solutions 的 `errorPattern` 始终为空字符串 `''`，因为 SOLUTION_REGEX 只匹配解决方案文本，不匹配对应的错误。建立 `fixes` 关系时用的是 `solNodes[i]` 和 `errorNodes[i]` 的数组下标配对，完全是随机关联。
**修复**: 移除自动关联逻辑。错误和解决方案作为独立节点存储，不做无意义的随机配对。

---

## Issue #8: `/perf` 中缓存命中率未从真实缓存读取 [已修复]

**命令**: `/perf`
**文件**: `src/tui/extension.ts:1093-1094`
**问题**: 命令中 `cacheStats` 来自 `agent.getCache().getStats()`，但 `PerformanceMonitor` 内部也有 `metrics.cache` 字段（全为零）。两处数据不一致。且 `PerformanceMonitor.updateCacheStats()` 从未被调用。
**修复**: `/perf` 统一从 `LRUCache.getStats()` 和 `ConcurrencyController.getStats()` 读取实时数据，PerformanceMonitor 降级为可选补充。

---

## Issue #9: `orchestrate_agents` 工具 — Agent 累积问题（同 #2）[已修复]

**工具**: `orchestrate_agents`
**文件**: `src/tui/extension.ts:897`
**问题**: 与 Issue #2 相同，`executeTeamTask()` 注册的 Agent 不会被清理。
**修复**: 在工具 execute 函数中同样添加 Agent 清理逻辑。

---

## Issue #10: `/workflow-run` 缺少 Tab 补全 [已修复]

**命令**: `/workflow-run <id>`
**文件**: `src/tui/extension.ts:1011-1037`
**问题**: 命令未注册 `getArgumentCompletions`，用户无法通过 Tab 补全查看可用的工作流 ID。而 `/agents` 等命令同样缺少此功能。
**修复**: 为 `/workflow-run` 和 `/agent-run` 添加 `getArgumentCompletions` 回调。

---

## 优先级排序

| 优先级 | Issue | 严重程度 | 说明 |
|--------|-------|----------|------|
| P0 | #5 | 功能不可用 | `/voice start/stop/speak` 全部崩溃 |
| P0 | #6 | 误导用户 | `/voice` 显示虚假"已初始化"状态 |
| P1 | #1 | 数据丢失 | `/learn clear` 重启后失效 |
| P1 | #4 | 数据错误 | 缓存命中率计算逻辑错误 |
| P1 | #7 | 数据错误 | 知识图谱错误-解决方案随机关联 |
| P2 | #2 | 资源泄漏 | Agent 累积不清理 |
| P2 | #3 | 功能无效 | `/perf` 指标永远为零 |
| P2 | #8 | 数据不一致 | 性能指标来源不统一 |
| P2 | #9 | 资源泄漏 | 同 #2，工具层面 |
| P3 | #10 | 体验优化 | 缺少 Tab 补全 |

---

## 修复结果

全部 10 个 Issue 已修复。构建通过，164 个测试全部通过。

**修改文件：**
- `src/tui/extension.ts` — 7 处修改
- `src/core/agent.ts` — 1 处修改
- `src/core/config.ts` — 1 处修改（导出 DEFAULT_CONFIG）
- `src/performance/optimizer.ts` — 2 处修改
- `src/workflows/templates.ts` — 1 处修改
- `src/memory/profile-extractor.ts` — 1 处修改

---

## E2E 实际执行测试发现的额外问题

## Issue #11: 工作流模板 ID 被 Date.now() 改写 [已修复]

**文件**: `src/workflows/templates.ts:419`
**问题**: `createWorkflowFromTemplate()` 中 `id: overrides?.id || \`${template.id}-${Date.now()}\`` 将 `pr-review` 改写为 `pr-review-1717524000000`，导致用户无法通过 `/workflow-run pr-review` 触发工作流。
**修复**: 改为 `id: overrides?.id || template.id`，保留原始模板 ID。

## Issue #12: `DEFAULT_CONFIG` 未导出 [已修复]

**文件**: `src/core/config.ts:158`
**问题**: `DEFAULT_CONFIG` 声明为 `const` 但没有 `export`，导致外部模块（测试、库使用者）无法导入默认配置。
**修复**: 改为 `export const DEFAULT_CONFIG`。

## Issue #13: `C++` 语言检测 `\b` 词边界失效 [已修复]

**文件**: `src/memory/profile-extractor.ts:41`
**问题**: `\bC\+\+\b` 中，末尾的 `\b` 要求 match 末尾是 word character，但 `+` 不是 word character，导致 `C++` 永远匹配不到。同样影响 `C#`。
**修复**: 对非 word character 结尾的词（如 `C++`, `C#`），改用 `(?!\w)` 替代末尾 `\b`。

## E2E 测试覆盖

新增 `tests/e2e-commands.test.ts`（30 个测试），覆盖：
- /knowledge（空图谱统计、搜索、有数据搜索）
- /context（项目上下文显示）
- /learn（统计、clear 持久化验证）
- /agents（状态显示）
- /agent-run（团队执行、Agent 清理、所有 5 种团队类型）
- /workflows（状态显示、所有默认模板注册验证）
- /workflow-run（触发 pr-review、不存在的工作流错误、所有默认工作流触发）
- /perf（缓存+并发指标、命中率变化）
- /cache（状态、clear）
- /dashboard、/collab、/voice（未启用时返回 null）
- 知识图谱持久化 E2E（写入→保存→重新加载→数据完整）
- Learner 持久化 E2E（记录→保存→重新加载→模式保留）
- 用户画像提取 E2E（语言提取、C++ 正则、去重）
- 知识提取 E2E（文件路径、错误节点写入）
- 全模块集成（初始化后所有子系统可用、dispose 后清空）

**总计：194 个测试全部通过（164 原有 + 30 新增 E2E）**

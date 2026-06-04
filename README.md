<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.5+-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/Tests-164%20passed-brightgreen?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/Architecture-Plugin--based-ff6b35?style=flat-square" alt="Architecture">
</p>

<h1 align="center">Bumblebee</h1>

<p align="center">
  <strong>全渠道智能编程副官</strong><br>
  <em>不只是 Coding Agent，而是能变形、协作、感知、响应的 AI 编程伙伴</em>
</p>

<p align="center">
  像变形金刚中的大黄蜂一样 —— 忠诚、敏捷、智能，随时适配你的工作方式
</p>

---

## 为什么选择 Bumblebee？

当前的 AI Coding 工具（Claude Code、Cursor、Copilot）都局限于单一 IDE 或终端。Bumblebee 的愿景不同：**让 AI 编程助手无处不在** —— 微信群里 @一下就能审查 PR，飞书群里一句话就能触发自动化工作流，终端里用 TUI 获得沉浸式编码体验。

| 能力 | Bumblebee | Claude Code | Cursor | Copilot |
|------|:---------:|:-----------:|:------:|:-------:|
| TUI 终端界面 | ✅ | ✅ | ✅ | ❌ |
| 微信/飞书/钉钉接入 | ✅ | ❌ | ❌ | ❌ |
| 多 Agent 协作编排 | ✅ | ❌ | ❌ | ❌ |
| 自动化工作流引擎 | ✅ | ❌ | ❌ | ❌ |
| 知识图谱 + 学习 | ✅ | ❌ | ❌ | ❌ |
| 角色系统 + 人格 | ✅ | ❌ | ❌ | ❌ |
| 插件化架构 | ✅ | ❌ | ❌ | ❌ |
| 开源 | ✅ | ❌ | ❌ | ❌ |

---

## 架构总览

```mermaid
graph TB
    subgraph Bumblebee["Bumblebee Core"]
        subgraph Core["核心层"]
            AO["Agent Orchestrator<br/>智能体编排"]
            WE["Workflow Engine<br/>工作流引擎"]
            KG["Knowledge Graph<br/>知识图谱"]
        end

        subgraph Plugin["插件系统"]
            PS["Plugin System"]
        end

        subgraph Modules["功能模块"]
            CH["Channels<br/>微信 / 飞书 / 钉钉"]
            RL["Roles + Personality<br/>角色 + 人格"]
            MM["Memory<br/>记忆系统"]
            AD["Advanced<br/>语音 / 协作 / 仪表板"]
        end

        subgraph Foundation["基础层"]
            PI["pi-coding-agent (TUI)"]
        end

        AO --> PS
        WE --> PS
        KG --> PS
        PS --> CH
        PS --> RL
        PS --> MM
        PS --> AD
        Core --> PI
    end

    style Bumblebee stroke:#333,stroke-width:2px
    style Core fill:#bbf,stroke:#666
    style Plugin fill:#bfb,stroke:#666
    style Modules fill:#ffd,stroke:#666
    style Foundation fill:#fbb,stroke:#666
```

---

## 核心能力

### 角色系统

Bumblebee 不是一个固定人格的 Agent。它支持**用户自定义角色**，每个角色拥有独立的专业领域、沟通风格、系统提示词和能力声明。

```typescript
await agent.createRole({
  name: '安全审计专家',
  description: '专注于代码安全审查和漏洞检测',
  personality: {
    traits: ['严谨', '警觉', '细致'],
    expertise: ['OWASP', '渗透测试', '加密算法'],
  },
  systemPrompt: '你是一个安全审计专家...',
  capabilities: ['security-audit', 'vulnerability-scan']
})

agent.switchRole('security-auditor')
```

内置 8 种专业 Agent 模板：`code-reviewer` / `test-writer` / `doc-generator` / `debugger` / `architect` / `refactorer` / `security-auditor` / `optimizer`

### 记忆系统

跨会话用户画像持久化，自动从对话中提取用户偏好、环境信息和关键事实。对话历史由 pi-coding-agent 的 SessionManager 管理，Bumblebee 在此基础上构建长期用户画像层。退出时自动保存对话摘要，新会话启动时注入上次对话要点。

### 渠道系统

统一的 `ChannelAdapter` 接口，一套代码接入所有平台。官方实现 WeChat / Feishu / DingTalk，社区可自行扩展 Slack / Teams / Discord。

### 知识系统

三位一体的知识引擎，启动时自动感知项目环境，在对话中注入上下文和推荐，在交互中学习模式并持久化到磁盘：

- **知识图谱** — 项目级节点关系图谱，支持文本搜索、关系遍历、路径推理和相似节点发现
- **上下文管理器** — 自动检测项目语言、框架、依赖，桥接用户偏好，管理会话变量
- **学习器** — 从对话中学习用户模式（纠正、偏好、反馈），生成智能推荐，置信度随使用增长

### 多 Agent 协作编排

`AgentManager` 管理 Agent 生命周期，`AgentOrchestrator` 提供 4 种协作模式：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `independent` | 每个任务独立执行 | 无依赖的批量任务 |
| `sequential` | 前一步输出作为后一步输入 | 流水线处理 |
| `parallel` | 所有任务同时执行 | 独立任务加速 |
| `hierarchical` | 主 Agent 分析 → 子 Agent 并行 → 主 Agent 总结 | 复杂分析任务 |

内置 5 种推荐团队：`code-review` / `testing` / `development` / `quality` / `full`

```typescript
// 通过 TUI 快速启动团队
// /agent-run code-review 审查当前项目的代码质量

// 通过 API 编排
const result = await agent.getAgentOrchestrator()!.executeTeamTask(
  ['code-reviewer', 'security-auditor', 'test-writer'],
  '全面审查 src/core/ 目录',
  { focus: 'security' },
  'hierarchical'
)
```

### 工作流引擎

声明式 DAG 工作流，支持条件分支、重试策略（固定/指数退避）、超时控制、步骤间数据传递。4 种内置模板：

| 模板 | 步骤 | 用途 |
|------|------|------|
| `pr-review` | 代码分析 → 安全检查 → 测试覆盖 → 汇总 | PR 自动审查 |
| `issue-triage` | 分类 → 优先级 → 分配 | Issue 自动分流 |
| `release` | 版本检查 → 测试 → 构建 → 发布 | 发布流程自动化 |
| `code-quality` | 静态分析 → 复杂度 → 重复检测 → 报告 | 代码质量检查 |

```typescript
// 触发工作流
const result = await agent.getWorkflowEngine()!.trigger('pr-review')
```

### 性能优化

内置性能子系统，在 Agent 启动时自动初始化：

- **LRU 缓存** — 带 TTL 的内存缓存，支持 lru/lfu/fifo 淘汰策略
- **并发控制器** — 限制最大并发数，队列溢出自动排队
- **性能监控** — 响应时间百分位（p50/p90/p99）、吞吐量、缓存命中率

### 可视化仪表板

`DashboardImpl` 提供可配置的 Widget 系统，支持指标卡片、时序图表、日志面板等组件，默认包含 Agent 数量、任务计数、成功率、响应时间等预设 Widget。

### 协作与语音（实验性）

- **实时协作** — WebSocket 双向通信，支持多人同时编辑、光标同步、房间管理
- **语音交互** — 浏览器端语音识别与合成，支持多语言、连续识别、静音检测

> 协作和语音模块依赖浏览器 API，默认禁用。在配置中设置 `collaboration.enabled: true` / `voice.enabled: true` 启用。

---

## TUI 体验

Bumblebee 通过 [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) Extension 机制注入 TUI，复用框架的会话管理、上下文压缩（compaction）、工具系统等核心能力，同时注入角色、人格、用户画像等差异化功能。

**复用的框架能力：**
- `SessionManager` — 对话历史持久化、分支管理
- `session_before_compact` — 压缩时自动提取用户画像
- `before_agent_start` — 注入角色 system prompt + 用户画像
- `defineTool` / `registerCommand` — 自定义工具和斜杠命令

| 斜杠命令 | 功能 |
|----------|------|
| `/roles` | 列出所有可用角色 |
| `/switch <id>` | 切换角色（支持 Tab 补全） |
| `/role` | 显示当前角色详情 |
| `/personality` | 显示人格状态 |
| `/memory` | 显示记忆统计 |
| `/memory summary` | 查看上次对话摘要 |
| `/memory clear` | 清空记忆 |
| `/knowledge` | 知识图谱统计（节点数、关系数、类型分布） |
| `/knowledge search <词>` | 搜索知识节点 |
| `/context` | 显示当前项目上下文（语言、框架、依赖） |
| `/learn` | 学习系统统计（记录数、模式数、成功率） |
| `/learn clear` | 清空学习数据 |
| `/agents` | Agent 系统状态和列表 |
| `/agent-run <team> [task]` | 运行专业 Agent 团队 |
| `/workflows` | 工作流系统状态 |
| `/workflow-run <id>` | 触发工作流执行 |
| `/perf` | 性能指标（响应时间、缓存命中率、并发） |
| `/cache` | 缓存状态 |
| `/cache clear` | 清空缓存 |
| `/dashboard` | 仪表盘状态 |
| `/collab` | 协作状态 |
| `/collab connect` | 连接协作服务器 |
| `/collab join <room>` | 加入协作房间 |
| `/voice` | 语音引擎状态 |
| `/voice start` | 启动语音识别 |
| `/voice speak <text>` | 语音合成 |
| `/resume` | 浏览并选择历史会话 |
| `/new` | 开始新会话 |

AI 在对话中可主动调用 15+ 工具，包括角色切换、Agent 编排、工作流触发、缓存管理、协作通信等。

---

## 快速开始

### 环境要求

- Node.js >= 22.0.0

### 安装与运行

```bash
git clone https://github.com/your-org/bumblebee.git
cd bumblebee
npm install
npm run build

# 启动 TUI
node dist/cli.js

# 或全局链接
npm link
bumblebee
```

### 会话管理

Bumblebee 每次对话会自动保存到磁盘（`~/.pi/agent/sessions/`），退出后可恢复。

```bash
# 恢复最近一次会话（推荐）
node dist/cli.js -c

# 交互式选择历史会话
node dist/cli.js -r

# 恢复指定会话（ID 从退出时的提示中获取）
node dist/cli.js --session <session-id>
```

全局安装后：

```bash
bumblebee -c    # 恢复最近会话
bumblebee -r    # 交互式选择
```

TUI 内也可通过 `/resume`、`/new`、`/tree`、`/fork` 管理会话。

> **会话 vs 记忆：** 会话（Session）是完整的对话历史，通过 `-c` / `-r` 恢复；记忆（Memory）是自动提取的用户画像 + 对话摘要，保存在 `~/.bumblebee/memory/profile.json`，启动新会话时自动注入上下文。即使启动新会话而非恢复旧会话，Bumblebee 也能记住你的偏好和上次讨论的要点。

### LLM 配置

Bumblebee 通过环境变量配置 LLM 连接。在项目根目录创建 `.env` 文件：

```bash
# Anthropic 直连
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
ANTHROPIC_BASE_URL=https://api.anthropic.com

# 或 OpenAI 兼容接口
OPENAI_API_KEY=sk-xxxxxxxxxxxx
OPENAI_BASE_URL=https://your-proxy.com/v1
```

> **说明：** 也可以直接设置系统环境变量，无需 `.env` 文件。如使用第三方 API 代理，将 `BASE_URL` 指向代理地址即可。

### 配置文件

在项目根目录创建 `.bumblebee.yaml`，用于配置人格、记忆等行为参数：

```yaml
personality:
  intensity: moderate    # low | moderate | high
  theme: transformers   # transformers | neutral
  roleId: bumblebee

memory:
  enabled: true
  maxHistory: 100

ai:
  provider: openai       # anthropic | openai | gemini | bedrock
  model: gpt-4o
  temperature: 0.7
  maxTokens: 4096

knowledge:
  enabled: true
  maxRecords: 1000

agents:
  enabled: true
  maxConcurrent: 5
  defaultTemperature: 0.7

workflows:
  enabled: true
  defaultTimeout: 300000
  maxConcurrentWorkflows: 3

performance:
  enabled: true
  cache:
    maxSize: 1000
    ttl: 300000
    evictionPolicy: lru   # lru | lfu | fifo
  concurrency:
    maxConcurrent: 10
    queueSize: 100
    timeout: 30000

dashboard:
  enabled: false           # 默认关闭
  refreshInterval: 5000

collaboration:
  enabled: false           # 需要 WebSocket 服务器
  serverUrl: ws://localhost:3000
  userId: local-user
  userName: User

voice:
  enabled: false           # 需要浏览器环境
  engine: browser          # browser | whisper | azure | google
  language: zh-CN
```

### 作为库使用

```typescript
import { BumblebeeAgent, loadConfig } from 'bumblebee'

const config = await loadConfig()
const agent = new BumblebeeAgent(config)
await agent.initialize()

// 基础对话
const response = await agent.processMessage('帮我审查这段代码')

// 角色切换
agent.switchRole('code-reviewer')

// 多 Agent 编排
const orch = agent.getAgentOrchestrator()!
const result = await orch.executeTeamTask(
  ['code-reviewer', 'security-auditor'],
  '审查 src/core/ 目录',
  { focus: 'security' },
  'hierarchical'
)

// 触发工作流
const workflow = await agent.getWorkflowEngine()!.trigger('pr-review')

// 查询知识图谱
const nodes = agent.getKnowledge().query({ text: 'authentication', limit: 5 })

// 释放资源
await agent.dispose()
```

---

## 项目结构

```
src/
├── core/           # 核心模块（Agent 主类、配置加载、LLM 调用工厂）
├── tui/            # TUI 集成（pi-coding-agent Extension，25+ 命令/工具）
├── roles/          # 角色系统（存储、管理、创建向导，8 种内置模板）
├── personality/    # 人格系统（情绪分析、人格注入）
├── memory/         # 记忆系统（用户画像持久化、对话画像提取、跨会话摘要）
├── channels/       # 渠道系统（微信 / 飞书 / 钉钉适配器）
├── agents/         # Agent 编排（AgentManager + Orchestrator，4 种协作模式）
├── workflows/      # 工作流引擎（DAG 调度、重试/超时/条件，4 种内置模板）
├── knowledge/      # 知识系统（图谱 + 上下文 + 学习器，三合一智能引擎）
├── performance/    # 性能优化（LRU 缓存、并发控制、性能监控）
├── dashboard/      # 可视化仪表板（Widget 系统、指标卡片、时序图表）
├── collaboration/  # 实时协作（WebSocket 房间、光标同步、多人编辑）
├── voice/          # 语音交互（语音识别、语音合成、多语言支持）
├── cli.ts          # CLI 入口
└── index.ts        # 库 barrel export
```

---

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| AI 引擎 | pi-coding-agent | Agent 会话管理、TUI 框架、Extension API |
| TUI 渲染 | pi-tui | 终端 UI 差分渲染、Markdown 渲染、交互组件 |
| 类型校验 | Zod + TypeBox | 配置校验、工具参数 Schema |
| 渠道 SDK | wechaty / @larksuiteoapi | 平台接入（懒加载） |
| 构建 | tsup | ESM 打包、Tree-shaking |
| 测试 | vitest | 单元测试、集成测试 |

---

## 开发

```bash
# 运行测试
npx vitest run

# 监听模式
npx vitest

# 类型检查
npm run typecheck

# 开发构建（监听文件变更）
npm run dev
```

---

## 参与贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/my-feature`
3. 提交更改：`git commit -m "feat: add my feature"`
4. 推送分支：`git push origin feature/my-feature`
5. 提交 Pull Request

请确保：
- 代码通过 `npm run typecheck` 类型检查
- 所有测试通过 `npx vitest run`
- 新功能附带相应测试用例

---

## 开发路线

- [x] **Phase 1** — 核心架构 + TUI 集成
- [x] **Phase 2** — 渠道系统（微信/飞书/钉钉）
- [x] **Phase 3** — 多 Agent 协作编排
- [x] **Phase 4** — 工作流引擎 + 模板
- [x] **Phase 5** — 知识图谱 + 学习机制
- [x] **Phase 6** — 语音/协作/仪表板/性能优化
- [x] **Phase 6.5** — 消除与 pi 框架的重复造轮子，深度复用框架能力
- [x] **Phase 6.6** — 6 大高级模块全部接入核心（agents/workflows/performance/dashboard/collaboration/voice）
- [ ] **Phase 7** — 生产级渠道对接 + WebSocket 实时通信
- [ ] **Phase 8** — 插件市场 + 社区生态

---

## License

[MIT](./LICENSE)

---

<p align="center">
  <em>"汽车人，出发！" —— Bumblebee</em>
</p>

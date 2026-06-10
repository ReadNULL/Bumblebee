# Bumblebee

Bumblebee 是一个基于 `pi-coding-agent` 的多渠道 AI Coding Agent。它把终端 TUI、长期记忆、角色系统、Agent 编排、工作流、知识系统和 IM 渠道接入整合在一起，让你既可以在命令行里编码协作，也可以从飞书、钉钉、微信等渠道触发对话。

## 当前状态

- 运行环境：Node.js `>= 22`
- 支持渠道：微信（公众号官方接口 / 个人号 ilink 扫码）、飞书、钉钉
- 会话恢复：复用 pi 官方 `/resume`、`/new`、`/tree`、`/fork` 等会话命令
- API Key：只从环境变量读取，不再从 `.bumblebee.yaml` 读取明文 `ai.apiKey`
- 默认 LLM 超时：`300000ms`，可在配置里调整 `ai.timeoutMs`
- 测试：`211` 个开发测试通过

## 快速开始

```bash
git clone https://github.com/ReadNULL/Bumblebee.git
cd Bumblebee

npm install
npm run build
```

配置 API Key。任选你要使用的模型供应商：

```powershell
# PowerShell，仅当前终端有效
$env:OPENAI_API_KEY = "sk-..."
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:GEMINI_API_KEY = "..."
```

```bash
# bash/zsh
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="..."
```

生成配置并启动：

```bash
node dist/cli.js init --preset dev
node dist/cli.js doctor
node dist/cli.js
```

全局使用：

```bash
npm link
bumblebee
```

更细的安装和排错步骤见 [docs/quick-start.md](docs/quick-start.md)。

## 配置文件

`bumblebee init` 会在项目根目录生成 `.bumblebee.yaml`。这个文件只保存非密钥配置。API Key 请始终放在环境变量中。

```yaml
personality:
  intensity: moderate
  theme: transformers
  roleId: bumblebee

memory:
  enabled: true
  maxHistory: 100

ai:
  provider: openai        # anthropic | openai | gemini | bedrock
  model: gpt-4o
  temperature: 0.7
  maxTokens: 4096
  timeoutMs: 300000       # 单次 LLM 响应超时，单位 ms
  # 模型认证由 SDK 管理，通过环境变量设置 API Key

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

channels:
  wechat:
    enabled: false
  feishu:
    enabled: false
  dingtalk:
    enabled: false
    mode: webhook

plugins:
  enabled: false
  modules: []
```

敏感的渠道凭据也建议使用环境变量，再在 YAML 中引用：

```yaml
channels:
  feishu:
    enabled: true
    appId: ${FEISHU_APP_ID}
    appSecret: ${FEISHU_APP_SECRET}
```

## TUI 常用命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看 Bumblebee 命令和常用 pi 命令 |
| `/status` | 查看系统状态 |
| `/roles` | 列出可用角色 |
| `/switch <roleId>` | 切换角色；不带参数时进入选择菜单 |
| `/role` | 查看当前角色 |
| `/personality` | 查看人格状态 |
| `/memory` | 进入记忆管理菜单 |
| `/knowledge` | 查看知识系统统计 |
| `/knowledge search <keyword>` | 搜索知识节点 |
| `/context` | 查看当前项目上下文 |
| `/learn` | 查看学习系统 |
| `/agents` | 进入 Agent 管理菜单 |
| `/agents run <team> [task]` | 运行预设 Agent 团队 |
| `/workflows` | 进入工作流菜单 |
| `/workflows run <id> [payload JSON]` | 运行工作流 |
| `/dashboard` | 查看仪表盘状态 |
| `/channels` | 进入渠道管理菜单 |
| `/channels setup` | 交互式配置渠道 |
| `/channels connect [name]` | 连接渠道 |
| `/channels disconnect [name]` | 断开渠道 |
| `/collab` | 协作功能菜单 |
| `/voice` | 语音功能菜单 |
| `/resume` | 使用 pi 官方能力恢复历史会话 |
| `/new` | 开始新会话 |

Bumblebee 不再提供重复的 `/history` 命令。恢复会话或查看历史会话请使用 pi 官方 `/resume`。

## 渠道接入

详细文档：

- [渠道总览](docs/channels/README.md)
- [微信渠道](docs/channels/wechat.md)
- [飞书渠道](docs/channels/feishu.md)
- [钉钉渠道](docs/channels/dingtalk.md)

依赖安装策略：

| 渠道 | 依赖 | 安装方式 |
| --- | --- | --- |
| 微信公众号 | Node.js 内置 `http` / `fetch` | 官方接口，无额外 SDK |
| 微信个人号 | Node.js 内置 `fetch` | weixinbot 模式，ilink API 代码已内置 |
| 飞书 | `@larksuiteoapi/node-sdk` | `npm install` 自动安装 |
| 钉钉 | Node.js 内置 `fetch` / `http` | 无额外 SDK |

## 插件系统

插件默认关闭。开启后可以从模块路径或目录加载插件，插件可以注册命令、工具和渠道。

```yaml
plugins:
  enabled: true
  modules:
    - ./plugins/my-plugin.mjs
  directory: ./plugins
```

插件模块示例：

```js
export default {
  name: 'hello-plugin',
  version: '1.0.0',
  commands: [
    {
      name: 'hello',
      description: '测试插件命令',
      handler: async (_args, ctx) => {
        ctx.ui.notify('Hello from plugin', 'info')
      }
    }
  ],
  tools: [
    {
      name: 'hello_tool',
      description: '测试插件工具',
      execute: async () => 'Hello from plugin tool'
    }
  ]
}
```

## 作为库使用

```ts
import { BumblebeeAgent, loadConfig } from 'bumblebee'

const config = await loadConfig()
const agent = new BumblebeeAgent(config)

await agent.initialize()

const response = await agent.processMessage('请审查 src/core 目录的实现')
console.log(response)

await agent.dispose()
```

## 开发命令

```bash
npm run typecheck
npm test -- --run
npm run build
```

`tests/` 目录只用于开发验证，不作为用户可调用功能开放。

## 许可证

MIT

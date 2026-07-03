# Bumblebee 快速开始

这份指南按从零开始的顺序写，适合第一次运行 Bumblebee。

## 1. 环境要求

- Node.js `>= 22`
- npm
- Git，可选但推荐

检查版本：

```bash
node --version
npm --version
git --version
```

## 2. 安装和构建

```bash
git clone https://github.com/ReadNULL/Bumblebee.git
cd Bumblebee
npm install
npm run build
```

构建成功后会生成 `dist/cli.js`。

## 3. 配置 API Key

Bumblebee 的模型认证由 pi-coding-agent SDK 统一管理，只从环境变量读取 API Key。不要把密钥写进 `.bumblebee.yaml`。

PowerShell：

```powershell
$env:OPENAI_API_KEY = "sk-..."
# 或
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

需要持久保存时：

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "sk-...", "User")
```

bash/zsh：

```bash
export OPENAI_API_KEY="sk-..."
# 或
export ANTHROPIC_API_KEY="sk-ant-..."
```

SDK 内置支持 30 个 Provider，常用环境变量：

| Provider | API Key 环境变量 | 备注 |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | 也支持 `ANTHROPIC_OAUTH_TOKEN` |
| OpenAI | `OPENAI_API_KEY` | |
| Google Gemini | `GEMINI_API_KEY` | |
| DeepSeek | `DEEPSEEK_API_KEY` | |
| xAI | `XAI_API_KEY` | |
| Groq | `GROQ_API_KEY` | |
| Mistral | `MISTRAL_API_KEY` | |
| Moonshot AI | `MOONSHOT_API_KEY` | |
| Xiaomi MiMo | `XIAOMI_API_KEY` | |
| Xiaomi MiMo (国内) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | |
| Cerebras | `CEREBRAS_API_KEY` | |
| Fireworks | `FIREWORKS_API_KEY` | |
| Together AI | `TOGETHER_API_KEY` | |
| OpenRouter | `OPENROUTER_API_KEY` | |
| Hugging Face | `HF_TOKEN` | |
| Kimi | `KIMI_API_KEY` | |
| MiniMax | `MINIMAX_API_KEY` | |
| MiniMax (国内) | `MINIMAX_CN_API_KEY` | |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | 需额外设置 `AZURE_OPENAI_BASE_URL` |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | 或 `AWS_BEARER_TOKEN_BEDROCK` |
| Google Vertex | 使用 GCP ADC | `gcloud auth application-default login` |
| Cloudflare | `CLOUDFLARE_API_KEY` | 需 `CLOUDFLARE_ACCOUNT_ID` |

完整列表和高级配置见 pi-coding-agent 的 `providers.md` 文档。启动后可使用 `/model` 命令切换模型。

## 4. 生成配置

运行交互式向导：

```bash
node dist/cli.js init
```

也可以使用预设：

```bash
node dist/cli.js init --preset mini
node dist/cli.js init --preset dev
node dist/cli.js init --preset full
```

预设区别：

| 预设 | 说明 |
| --- | --- |
| `mini` | 最小配置，只启用基础对话 |
| `dev` | 默认推荐，启用知识、Agent、工作流、性能模块 |
| `full` | 启用更多实验功能和仪表盘配置 |

向导会生成 `.bumblebee.yaml`。API Key 不会写入配置文件，由 pi-coding-agent SDK 通过环境变量管理。

## 5. 检查环境

```bash
node dist/cli.js doctor
```

`doctor` 会检查 Node.js、npm、API Key、配置文件和依赖安装状态。

## 6. 启动 TUI

```bash
node dist/cli.js
```

全局使用：

```bash
npm link
bumblebee
```

## 7. 第一次对话

启动后直接输入自然语言：

```text
请审查 src/core 目录的实现，指出潜在用户体验问题
```

常用命令：

```text
/help
/status
/perf
/dashboard
/roles
/switch
/agents
/workflows
/channels
/resume
```

会话历史由 pi 框架管理。恢复历史会话请使用 `/resume`，不要找 `/history`。

## 8. 运行 Agent 团队

```text
/agents run code-review 请检查当前项目的安全风险
```

可用团队：

| 团队 | 说明 |
| --- | --- |
| `code-review` | 代码审查 |
| `testing` | 测试设计 |
| `development` | 开发协作 |
| `quality` | 质量检查 |
| `full` | 综合团队 |

## 9. 运行工作流

```text
/workflows run pr-review
```

可用工作流：

| 工作流 | 说明 |
| --- | --- |
| `pr-review` | PR 审查 |
| `issue-triage` | Issue 分流 |
| `release` | 发布流程骨架（需外部执行器） |
| `code-quality` | 代码质量检查 |

如果工作流需要输入，TUI 会提示你填写 JSON。

`pr-review`、`issue-triage` 和 `code-quality` 是 Agent 分析模板。`release` 中的 `test`、`build`、`publish` 需要使用库 API 的 `registerAction()` 接入真实执行器；未配置时会明确失败。当前仓库没有内置 webhook/cron 服务，工作流通过命令、API 或 Agent 工具手动触发。

## 10. 连接 IM 渠道

进入 TUI 后：

```text
/channels setup
/channels connect feishu
```

推荐先用飞书或钉钉验证 IM 接入。微信支持两种模式：公众号官方接口（需公网回调 URL）和个人号 weixinbot 扫码（ilink API，无需额外配置）。

渠道消息由独立的 pi AgentSession 处理，可调用 `trigger_workflow` 和 `orchestrate_agents`。工作流需要输入时，请在消息中提供工作流 ID 和必要的 payload 信息。

详细步骤见：

- [渠道总览](channels/README.md)
- [微信](channels/wechat.md)
- [飞书](channels/feishu.md)
- [钉钉](channels/dingtalk.md)

## 常见问题

### 如何切换模型

启动 TUI 后使用 `/model` 命令：

```text
/model                    # 查看当前模型
/model claude-opus-4-7    # 切换到指定模型
```

模型认证由 pi-coding-agent SDK 管理，确保对应的环境变量已设置。

### 配置了 API Key 但提示认证失败

Bumblebee 不在配置文件中存储密钥。请确保已设置对应的环境变量（如 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`），然后重启 TUI。

### 长任务 60 秒就超时

当前默认超时是 `300000ms`。如果你仍然需要更长时间，可以在 `.bumblebee.yaml` 中设置：

```yaml
llm:
  timeoutMs: 900000
```

最大允许 `3600000ms`。

### 插件命令或工具超时

插件默认有轻量隔离保护：单个 tool/command 执行超过 `10000ms` 会失败，阻塞事件循环超过 `250ms` 会记录 warning。需要调整时：

```yaml
plugins:
  toolTimeoutMs: 30000
  commandTimeoutMs: 30000
  eventLoopWarningMs: 500
```

如果插件包含长时间 CPU 密集任务，建议改成异步任务或拆到独立进程；当前隔离不是完整沙箱。

### 工作流失败后如何处理

工作流按 DAG 依赖分层并行执行。步骤失败时默认跳过下游步骤，也可以在步骤或工作流配置中指定：

```yaml
onFailure: skip-downstream   # skip-downstream | abort-workflow | compensate
compensateAction: rollback
```

重试支持 `retry.maxDelayMs` 和 `retry.jitter`，工作流整体超时或取消时会中断等待中的重试。

### 需要运行测试吗？

测试目录用于内部开发验证，不作为用户使用入口随仓库提供。日常使用和改动验证优先运行：

```bash
npm run typecheck
```

如果你在本地添加了开发测试，再运行 `npx vitest run`。

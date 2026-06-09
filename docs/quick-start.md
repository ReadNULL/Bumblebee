# Bumblebee 快速开始

## 安装（3 步）

```bash
# 1. 克隆项目
git clone <repo-url> && cd bumblebee

# 2. 安装依赖
npm install

# 3. 构建
npm run build
```

## 配置

```bash
# 运行交互式配置向导
node dist/cli.js init

# 或使用预设快速配置
node dist/cli.js init --preset mini      # 最小配置，仅基础对话
node dist/cli.js init --preset dev       # 开发模式（默认）
node dist/cli.js init --preset full      # 完整功能
```

配置向导会自动：
- 检测 Node.js、npm、Git 环境
- 引导选择 AI 提供商（OpenAI / Anthropic）
- 生成 `.bumblebee.yaml`（含 API Key 和 Base URL）

## 启动

```bash
node dist/cli.js
```

## 环境诊断

```bash
node dist/cli.js doctor
```

检查 Node.js 版本、API Key、配置文件、依赖安装等。

## 常见场景

### 1. 代码审查

```
请审查 src/auth.ts 的安全性
```

### 2. 写测试

```
为 UserService 类编写单元测试
```

### 3. 使用 Agent 团队

```
/agents run code-review 请检查项目的安全漏洞
```

可用团队：`code-review`、`testing`、`development`、`quality`、`full`

### 4. 运行工作流

```
/workflows run pr-review
```

不带 payload 时会弹出 JSON 输入框，可直接使用默认示例。

可用工作流：`pr-review`、`issue-triage`、`release`、`code-quality`

### 5. 知识管理

```
/knowledge search 认证流程     # 搜索项目知识
/learn                          # 查看学习统计
/context                        # 查看项目上下文
```

## 常用命令速查

| 命令 | 说明 |
|------|------|
| `/help` | 查看 Bumblebee 命令和常用 pi 会话命令 |
| `/help <命令>` | 查看命令用法 |
| `/status` | 系统健康状态 |
| `/roles` | 查看可用角色 |
| `/switch <角色>` | 切换角色 |
| `/memory` | 查看记忆 |
| `/knowledge search <关键词>` | 搜索知识 |
| `/agents` | Agent 管理 |
| `/agents run <team> [task]` | 运行 Agent 团队 |
| `/workflows` | 工作流管理 |
| `/workflows run <id>` | 运行工作流 |
| `/perf` | 性能指标 |
| `/cache` | 缓存状态 |

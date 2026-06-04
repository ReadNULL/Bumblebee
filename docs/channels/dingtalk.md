# 钉钉渠道接入指南

将 Bumblebee 接入钉钉，支持两种模式：Webhook（仅发送）和企业应用（双向通信）。

## 模式选择

| 特性 | Webhook 模式 | 企业应用模式 |
|------|:------------:|:----------:|
| 发送消息到群 | ✅ | ✅ |
| 接收群消息 | ❌ | ✅ |
| 私聊 | ❌ | ✅ |
| 配置难度 | 简单 | 中等 |
| 需要公网 IP | 否 | 是（或内网穿透） |
| 适用场景 | 通知推送、快速体验 | 完整的双向对话 |

## 模式 A：Webhook（快速体验）

### 第一步：创建群机器人

1. 打开钉钉，进入目标群
2. 群设置 → 智能群助手 → 添加机器人
3. 选择「自定义」机器人
4. 设置机器人名称（如 "Bumblebee"）
5. 安全设置选择「自定义关键词」，填入 `Bumblebee`
6. 复制 Webhook 地址

### 第二步：配置

```yaml
channels:
  dingtalk:
    enabled: true
    mode: webhook
    webhook: https://oapi.dingtalk.com/robot/send?access_token=xxxxx
```

或使用环境变量：

```bash
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxxxx
```

```yaml
channels:
  dingtalk:
    enabled: true
    mode: webhook
    webhook: ${DINGTALK_WEBHOOK}
```

### 第三步：连接

```bash
node dist/cli.js
/channel-connect dingtalk
```

### 注意事项

- Webhook 模式**只能发送消息，不能接收消息**
- 消息内容必须包含「自定义关键词」（如 "Bumblebee"），否则发送失败
- 适合用于自动化通知、报告推送等场景

---

## 模式 B：企业应用（双向通信）

### 第一步：创建应用

1. 登录 [钉钉开放平台](https://open-dev.dingtalk.com)
2. 选择「应用开发」→「企业内部应用」
3. 创建应用，填写名称和描述

### 第二步：添加机器人能力

1. 进入应用详情
2. 左侧菜单 →「添加应用能力」→「机器人」
3. 记录 **Robot Code**

### 第三步：获取凭证

1. 左侧菜单 →「凭证与基础信息」
2. 记录 **AppKey** 和 **App Secret**

### 第四步：配置消息接收

企业应用需要一个 HTTP 服务器来接收钉钉的回调消息。

**方式一：公网部署**

1. 部署 Bumblebee 服务到公网可达的服务器
2. 在钉钉开放平台配置回调 URL

**方式二：内网穿透（开发环境）**

使用 ngrok 或类似工具：
```bash
ngrok http 3000
```

### 第五步：配置

```yaml
channels:
  dingtalk:
    enabled: true
    mode: enterprise
    appKey: your-app-key
    appSecret: your-app-secret
    robotCode: your-robot-code
```

### 第六步：连接

```bash
node dist/cli.js
/channel-connect dingtalk
```

## 支持的功能

### Webhook 模式

| 功能 | 支持 | 说明 |
|------|:----:|------|
| 文本消息 | ✅ | 发送到群 |
| Markdown | ✅ | 发送到群 |
| 链接消息 | ✅ | 发送到群 |
| ActionCard | ✅ | 按钮交互卡片 |
| @提及 | ✅ | 在消息中 @群成员 |

### 企业应用模式

| 功能 | 支持 | 说明 |
|------|:----:|------|
| 文本消息 | ✅ | 发送和接收 |
| 富文本 | ✅ | 发送和接收 |
| Markdown | ✅ | 发送 |
| @提及 | ✅ | 群聊中检测 @ |
| 私聊 | ✅ | 与机器人一对一对话 |

## TUI 命令

```bash
/channel-setup           # 交互式配置
/channel-connect dingtalk    # 连接
/channel-disconnect dingtalk # 断开
/channels                # 查看状态
```

## 常见问题

### Q: Webhook 发送失败，提示 "keywords not match"

A: 消息内容必须包含安全设置中配置的关键词。Bumblebee 默认在消息中包含 "Bumblebee" 关键词。如果修改了关键词配置，需要相应调整。

### Q: 企业应用收不到消息

A: 检查以下几点：
- 机器人能力是否已添加
- 回调 URL 是否正确配置且可达
- 应用是否已发布
- 消息接收模式是否正确

### Q: Token 过期怎么办

A: 企业应用模式会自动管理 access_token。如果遇到 token 相关错误，重启连接即可。

### Q: 如何同时使用两种模式

A: 目前每个渠道类型只能配置一个实例。如需同时使用，可以考虑：
- 使用 Webhook 模式做通知推送
- 使用企业应用模式做完整对话
- 根据场景切换配置

### Q: 如何发送 ActionCard

A: 在代码中使用 `DingTalkAdapter` 的 `sendActionCard()` 方法：
```typescript
const dingtalk = channelManager.getChannel('dingtalk')
if (dingtalk instanceof DingTalkAdapter) {
  await dingtalk.sendActionCard('*', {
    title: '标题',
    text: 'Markdown 内容',
    buttons: [{ title: '按钮', actionURL: 'https://example.com' }]
  })
}
```

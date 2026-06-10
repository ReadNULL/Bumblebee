# 钉钉渠道接入指南

钉钉渠道支持两种模式：

- `webhook`：群机器人 Webhook，只能发送消息，适合通知推送。
- `enterprise`：企业内部应用，可以接收和发送消息，适合完整对话。

钉钉渠道不依赖额外 npm SDK，使用 Node.js 22 内置 `fetch` 和 `http`。

## 模式对比

| 能力 | Webhook | 企业应用 |
| --- | :---: | :---: |
| 发送群消息 | 是 | 是 |
| 接收消息 | 否 | 是 |
| 私聊 | 否 | 是 |
| 需要公网回调 | 否 | 是 |
| 配置复杂度 | 低 | 中 |

## Webhook 模式

### 1. 创建群机器人

1. 打开钉钉目标群
2. 群设置 -> 智能群助手 -> 添加机器人
3. 选择“自定义机器人”
4. 安全设置建议选择“自定义关键词”，例如 `Bumblebee`
5. 复制 Webhook 地址

### 2. 配置

推荐把 Webhook 放入环境变量。

PowerShell：

```powershell
$env:DINGTALK_WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=xxx"
```

`.bumblebee.yaml`：

```yaml
channels:
  dingtalk:
    enabled: true
    mode: webhook
    webhook: ${DINGTALK_WEBHOOK}
```

### 3. 连接

```bash
node dist/cli.js
```

```text
/channels connect dingtalk
```

Webhook 模式连接后，Bumblebee 可以向该群发送消息，但不会接收群消息。

## 企业应用模式

### 1. 创建企业内部应用

1. 打开钉钉开放平台：`https://open-dev.dingtalk.com`
2. 进入“应用开发”
3. 创建企业内部应用
4. 添加“机器人”能力
5. 记录 Robot Code

### 2. 获取凭证

在应用的“凭证与基础信息”中记录：

- AppKey
- AppSecret

### 3. 配置消息回调

Bumblebee 会在连接企业应用模式时启动本地 HTTP 回调服务，默认端口是 `3001`。钉钉需要能访问这个地址。

开发环境可以用内网穿透：

```bash
ngrok http 3001
```

然后把生成的公网地址配置到钉钉开放平台的回调地址中。

### 4. 配置 Bumblebee

PowerShell：

```powershell
$env:DINGTALK_APP_KEY = "dingxxx"
$env:DINGTALK_APP_SECRET = "xxx"
$env:DINGTALK_ROBOT_CODE = "dingxxx"
```

`.bumblebee.yaml`：

```yaml
channels:
  dingtalk:
    enabled: true
    mode: enterprise
    appKey: ${DINGTALK_APP_KEY}
    appSecret: ${DINGTALK_APP_SECRET}
    robotCode: ${DINGTALK_ROBOT_CODE}
    port: 3001
```

### 5. 连接

```text
/channels connect dingtalk
```

企业应用模式会自动获取 `access_token`，发送消息前会检查 token 是否过期并刷新。正常长时间运行不需要手动重启来刷新 token。

## 支持能力

### Webhook

| 能力 | 支持 | 说明 |
| --- | :---: | --- |
| 文本 | 是 | 发送到群 |
| Markdown | 是 | 发送到群 |
| 链接消息 | 是 | 发送到群 |
| ActionCard | 是 | 发送到群 |
| 接收消息 | 否 | 钉钉 Webhook 不提供接收能力 |

### 企业应用

| 能力 | 支持 | 说明 |
| --- | :---: | --- |
| 文本 | 是 | 发送和接收 |
| Markdown | 是 | 发送 |
| 群聊 | 是 | 取决于机器人配置 |
| 私聊 | 是 | 取决于应用权限 |
| @ 检测 | 是 | 群聊中可识别 mention |

## 常见问题

### Webhook 发送失败，提示 keywords not match

钉钉群机器人安全设置中配置了关键词。发送内容必须包含该关键词。建议把关键词设置为 `Bumblebee`。

### 企业应用收不到消息

检查：

1. 机器人能力是否已添加
2. 回调 URL 是否公网可访问
3. 本地 `port` 是否和内网穿透端口一致
4. 应用是否已发布
5. AppKey、AppSecret、Robot Code 是否正确

### 断开连接后端口仍被占用

当前实现会在断开时关闭 HTTP server，并主动销毁活跃连接。如果端口仍被占用，通常是旧进程未退出。先关闭旧的 Bumblebee 进程，再重新连接。

### token 过期怎么办？

企业应用模式会自动刷新 token。如果仍遇到 token 相关错误，优先检查 AppKey/AppSecret 是否被重置或权限是否变更。

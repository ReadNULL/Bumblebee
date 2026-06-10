# 微信渠道接入指南

微信个人号没有官方开放 SDK。Bumblebee 提供两种微信接入方式：

1. **微信公众号官方接口**（推荐）—— 通过微信公众平台服务器配置接收消息，通过被动回复或客服消息接口回复用户。
2. **个人微信 ilink 扫码**（weixinbot 模式）—— 通过 ilink API 扫码登录个人微信，token 自动缓存，重启免扫码。

## 模式一：微信公众号官方接口

### 1. 准备公众号

你需要一个微信公众号，并能进入"微信公众平台 -> 设置与开发 -> 基本配置 -> 服务器配置"。

需要准备：

| 字段 | 说明 |
| --- | --- |
| Token | 自定义字符串，微信服务器校验签名用 |
| AppID | 可选，用于获取 access_token |
| AppSecret | 可选，用于客服消息主动回复 |
| URL | 你的公网回调地址，例如 `https://example.com/wechat` |

本地开发时可以用 ngrok/cpolar 等工具把本地端口暴露到公网：

```bash
ngrok http 3002
```

如果公网地址是 `https://abc.ngrok-free.app`，Bumblebee 默认回调路径是 `/wechat`，则微信公众平台里填写：

```text
https://abc.ngrok-free.app/wechat
```

### 2. 配置环境变量

PowerShell：

```powershell
$env:WECHAT_OFFICIAL_TOKEN = "your-token"
$env:WECHAT_OFFICIAL_APP_ID = "wx..."
$env:WECHAT_OFFICIAL_APP_SECRET = "..."
```

bash/zsh：

```bash
export WECHAT_OFFICIAL_TOKEN="your-token"
export WECHAT_OFFICIAL_APP_ID="wx..."
export WECHAT_OFFICIAL_APP_SECRET="..."
```

`AppID/AppSecret` 可不填。不填时 Bumblebee 只能在微信 5 秒被动回复窗口内回复；如果 LLM 响应超时，就无法再主动发送。

### 3. 配置 `.bumblebee.yaml`

```yaml
channels:
  wechat:
    enabled: true
    mode: official-account
    token: ${WECHAT_OFFICIAL_TOKEN}
    appId: ${WECHAT_OFFICIAL_APP_ID}
    appSecret: ${WECHAT_OFFICIAL_APP_SECRET}
    port: 3002
    path: /wechat
    responseTimeoutMs: 4500
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| `mode` | 否 | `official-account` 或 `weixinbot`，默认 `official-account` |
| `token` | 是 | 必须和微信公众平台服务器配置里的 Token 一致 |
| `appId` | 否 | 用于获取公众号 access_token |
| `appSecret` | 否 | 用于获取公众号 access_token |
| `port` | 否 | 本地 HTTP 回调端口，默认 `3002` |
| `path` | 否 | 回调路径，默认 `/wechat` |
| `responseTimeoutMs` | 否 | 被动回复等待时间，默认 `4500` |

### 4. 启动和连接

```bash
node dist/cli.js
```

在 TUI 里执行：

```text
/channels connect wechat
```

连接成功后，本地会监听：

```text
http://localhost:3002/wechat
```

此时在微信公众平台提交服务器配置，微信会向该 URL 发起 GET 校验。校验通过后，关注者给公众号发文本消息，Bumblebee 会接收并回复。

### 回复机制

微信公众号有两个回复路径：

1. 被动回复：微信 POST 消息到 Bumblebee 后，Bumblebee 在 `responseTimeoutMs` 内返回 XML 文本回复。
2. 客服消息：如果 LLM 响应超过被动回复窗口，Bumblebee 会尝试调用微信客服消息接口主动发送。此能力需要 `appId/appSecret` 和公众号权限支持。

如果没有配置 `appId/appSecret`，超时后的主动回复会失败，这是微信官方接口限制。

## 模式二：个人微信 ilink 扫码（weixinbot）

weixinbot 模式基于 ilink API（Tencent/openclaw-weixin），支持个人微信账号扫码登录。token 自动缓存在 `~/.bumblebee/weixin/`，重启后无需重新扫码。

### 配置

```yaml
channels:
  wechat:
    enabled: true
    mode: weixinbot
```

无需额外配置字段。连接时会显示二维码，用微信扫码即可。

### 连接

```text
/channels connect wechat
```

首次连接会弹出二维码，用微信扫码确认登录。登录成功后 token 自动缓存，下次启动直接恢复连接。

### 工作原理

1. 调用 ilink API 获取二维码
2. 用户用微信扫码确认登录
3. 获取 bot_token，缓存到本地
4. 通过长轮询（getupdates）接收消息
5. 通过 sendmessage 发送回复

### 注意事项

- weixinbot 模式使用的是非官方接口，可能存在稳定性风险
- 每个微信号同时只能有一个 ilink 连接
- 消息仅支持文本，图片/语音/文件等会忽略

## 支持能力

| 能力 | official-account | weixinbot |
| --- | :---: | :---: |
| 接收文本 | 是 | 是 |
| 发送文本 | 是 | 是 |
| 群聊 | 否 | 是 |
| 私聊 | 公众号关注者会话 | 是 |
| 图片/语音/视频 | 占位接收 | 否 |
| 文件 | 否 | 否 |
| Token 缓存 | 不适用 | 自动缓存，重启免扫码 |

## 常见问题

### 微信公众平台 URL 校验失败

检查：

1. Bumblebee 是否已经执行 `/channels connect wechat`
2. 公网 URL 是否能访问到本机 `port`
3. 微信公众平台的 Token 是否和 `.bumblebee.yaml` 中的 `token` 完全一致
4. 回调路径是否一致，例如 `/wechat`

### 用户发消息后没有回复

检查：

1. TUI 是否仍在运行
2. `responseTimeoutMs` 是否过短
3. LLM API Key 是否配置正确
4. 如果超过 5 秒，是否配置了 `appId/appSecret` 以使用客服消息

### weixinbot 扫码后无法连接

检查：

1. 网络是否能访问 `ilinkai.weixin.qq.com`
2. 该微信号是否已有其他 ilink 连接（同一时间只能有一个）
3. 二维码是否过期（5 分钟有效期，过期会自动刷新）

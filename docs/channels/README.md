# 渠道系统

Bumblebee 可以把同一个 AI Agent 接入多个 IM 渠道。当前内置渠道包括微信、飞书和钉钉。

## 推荐接入顺序

1. 先跑通 TUI：`node dist/cli.js`
2. 再配置一个 IM 渠道：推荐先用飞书或钉钉企业应用
3. 最后配置微信：推荐使用微信公众号官方接口；个人号可使用 weixinbot 模式（ilink 扫码）

## 快速命令

在 TUI 中执行：

```text
/channels
/channels setup
/channels connect feishu
/channels status
/channels disconnect feishu
```

`/channels` 不带参数会打开多轮选择菜单。你可以在菜单里选择状态、配置、连接和断开等子操作。

## 支持情况

| 渠道 | 接收文本 | 发送文本 | 群聊 | 私聊 | 说明 |
| --- | :---: | :---: | :---: | :---: | --- |
| [微信公众号](wechat.md) | 是 | 是 | 否 | 公众号关注者会话 | 官方接口，需公网回调 |
| [微信个人号](wechat.md) | 是 | 是 | 是 | 是 | weixinbot 模式，ilink 扫码登录 |
| [飞书](feishu.md) | 是 | 是 | 是 | 是 | 基于长连接事件，推荐优先验证 |
| [钉钉 Webhook](dingtalk.md) | 否 | 是 | 是 | 否 | 适合通知推送 |
| [钉钉企业应用](dingtalk.md) | 是 | 是 | 是 | 是 | 需要公网回调地址或内网穿透 |

文件、图片、语音等消息当前主要会转为占位文本进入统一消息模型；完整媒体上传、下载和转写仍属于后续增强范围。

## 依赖安装

`npm install` 会安装用户常用渠道依赖：

| 渠道 | npm 依赖 | 安装策略 |
| --- | --- | --- |
| 微信官方接口 | Node.js 内置 `http` / `fetch` | 默认推荐，无额外 SDK |
| 微信 weixinbot | 无额外依赖 | ilink API 代码已内置，使用 Node.js `fetch` |
| 飞书 | `@larksuiteoapi/node-sdk` | 正式依赖，自动安装 |
| 钉钉 | 无额外 SDK | 使用 Node.js 22 内置 `fetch` / `http` |

## 配置方式

### 方式一：TUI 向导

```text
/channels setup
```

按照提示选择渠道并填写必要字段。

### 方式二：手动编辑 `.bumblebee.yaml`

```yaml
channels:
  feishu:
    enabled: true
    appId: ${FEISHU_APP_ID}
    appSecret: ${FEISHU_APP_SECRET}

  dingtalk:
    enabled: true
    mode: webhook
    webhook: ${DINGTALK_WEBHOOK}

  wechat:
    enabled: true
    mode: official-account
    token: ${WECHAT_OFFICIAL_TOKEN}
    appId: ${WECHAT_OFFICIAL_APP_ID}
    appSecret: ${WECHAT_OFFICIAL_APP_SECRET}
    port: 3002
    path: /wechat

  # 或使用个人号 ilink 扫码模式：
  # wechat:
  #   enabled: true
  #   mode: weixinbot
```

敏感信息建议放在环境变量中，再用 `${ENV_VAR}` 引用。

## 渠道字段

### 微信

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| `enabled` | 否 | 是否启用 |
| `mode` | 否 | `official-account` 或 `weixinbot`，默认 `official-account` |
| `token` | 官方接口必填 | 微信公众平台服务器配置 Token |
| `appId` | 否 | 公众号 AppID，用于客服消息主动回复 |
| `appSecret` | 否 | 公众号 AppSecret，用于客服消息主动回复 |
| `port` | 否 | 本地回调端口，默认 `3002` |
| `path` | 否 | 回调路径，默认 `/wechat` |

### 飞书

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| `enabled` | 否 | 是否启用 |
| `appId` | 是 | 飞书应用 App ID |
| `appSecret` | 是 | 飞书应用 App Secret |
| `encryptKey` | 否 | 事件加密 key |
| `verificationToken` | 否 | 事件校验 token |

### 钉钉

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| `enabled` | 否 | 是否启用 |
| `mode` | 否 | `webhook` 或 `enterprise` |
| `webhook` | Webhook 必填 | 群机器人 Webhook 地址 |
| `appKey` | 企业应用必填 | 钉钉应用 AppKey |
| `appSecret` | 企业应用必填 | 钉钉应用 AppSecret |
| `robotCode` | 企业应用建议填写 | 机器人编码 |
| `port` | 否 | 本地回调 HTTP 服务端口，默认 `3001` |

## 排错顺序

1. 运行 `node dist/cli.js doctor`
2. 检查 `.bumblebee.yaml` 是否能被解析
3. 检查敏感配置对应的环境变量是否存在
4. 在 TUI 中执行 `/channels status`
5. 只连接一个渠道验证，避免多渠道日志混在一起

各渠道的详细排错见对应文档。

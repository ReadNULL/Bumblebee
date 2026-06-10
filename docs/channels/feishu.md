# 飞书渠道接入指南

飞书渠道基于 `@larksuiteoapi/node-sdk`，通过飞书开放平台的长连接事件接收消息。它不需要公网回调地址，适合作为第一个 IM 渠道验证。

## 依赖

```bash
npm install
```

项目依赖中已包含 `@larksuiteoapi/node-sdk`，无需单独安装。

## 1. 创建飞书应用

1. 打开飞书开放平台：`https://open.feishu.cn`
2. 创建企业自建应用
3. 进入应用详情
4. 在“凭证与基础信息”中记录：
   - App ID
   - App Secret

## 2. 添加机器人能力

1. 进入“添加应用能力”
2. 添加“机器人”
3. 保存配置

## 3. 配置事件订阅

1. 进入“事件订阅”
2. 接收方式选择“使用长连接接收事件”
3. 添加事件：
   - `im.message.receive_v1`

如果你选择了 HTTP 回调而不是长连接，Bumblebee 这边不会收到消息。

## 4. 开通权限

至少需要以下权限：

| 权限 | 用途 |
| --- | --- |
| `im:message` | 读取消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:chat:readonly` | 获取群聊信息 |

开通权限后，需要发布应用版本并等待管理员审批生效。

## 5. 配置 Bumblebee

推荐用环境变量保存敏感信息。

PowerShell：

```powershell
$env:FEISHU_APP_ID = "cli_xxx"
$env:FEISHU_APP_SECRET = "xxx"
```

bash/zsh：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

`.bumblebee.yaml`：

```yaml
channels:
  feishu:
    enabled: true
    appId: ${FEISHU_APP_ID}
    appSecret: ${FEISHU_APP_SECRET}
    # encryptKey: ${FEISHU_ENCRYPT_KEY}
    # verificationToken: ${FEISHU_VERIFICATION_TOKEN}
```

也可以在 TUI 里执行：

```text
/channels setup
```

然后选择飞书并按提示填写。

## 6. 连接和测试

```bash
node dist/cli.js
```

在 TUI 中执行：

```text
/channels connect feishu
```

看到 `已连接: feishu` 后：

1. 把机器人添加到飞书群
2. 在群里 @ 机器人并发送消息
3. 或直接给机器人发私聊消息

## 支持能力

| 能力 | 支持 | 说明 |
| --- | :---: | --- |
| 文本消息 | 是 | 发送和接收 |
| 群聊 | 是 | 机器人加入群后可用 |
| 私聊 | 是 | 取决于应用权限和发布状态 |
| @ 检测 | 是 | 群聊中可识别 mention |
| 富文本/卡片 | 部分 | 适配器提供卡片发送能力；普通对话主要走文本 |
| 图片/文件/语音 | 部分 | 当前主要转成占位文本进入统一消息模型 |

## 常见问题

### 连接后命令行输出看起来很乱

飞书 SDK 的长连接日志可能和 TUI 渲染同时输出。当前代码已尽量减少对输入状态的影响，但如果日志仍然干扰操作，可以先完成连接，再继续输入命令；后续会继续收敛 SDK 日志输出。

### 收不到消息

按顺序检查：

1. 应用是否已经发布并审批生效
2. 事件订阅是否选择“长连接”
3. 是否添加了 `im.message.receive_v1`
4. 权限是否包含 `im:message` 和 `im:message:send_as_bot`
5. 机器人是否已经加入目标群
6. 群聊中是否 @ 了机器人

### 报 `appId or appSecret is invalid`

检查 App ID、App Secret 是否复制完整，确认没有额外空格，并确认 `.bumblebee.yaml` 中的环境变量是否成功展开。

### 如何确认环境变量是否生效？

PowerShell：

```powershell
echo $env:FEISHU_APP_ID
```

bash/zsh：

```bash
echo "$FEISHU_APP_ID"
```

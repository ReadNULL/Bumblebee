# 飞书渠道接入指南

通过飞书开放平台将 Bumblebee 接入飞书，支持私聊、群聊、消息卡片和文件传输。这是功能最全的渠道。

## 前置条件

- Node.js >= 22
- 飞书开放平台账号 https://open.feishu.cn

## 第一步：安装依赖

```bash
# 项目 npm install 已包含 @larksuiteoapi/node-sdk
npm install

# 如果只单独安装飞书 SDK:
npm install @larksuiteoapi/node-sdk
```

## 第二步：创建飞书应用

### 2.1 创建应用

1. 登录 [飞书开放平台](https://open.feishu.cn)
2. 点击「创建企业自建应用」
3. 填写应用名称和描述

### 2.2 获取凭证

1. 进入应用详情页
2. 左侧菜单 →「凭证与基础信息」
3. 记录 **App ID** 和 **App Secret**

### 2.3 添加机器人能力

1. 左侧菜单 →「添加应用能力」
2. 选择「机器人」

### 2.4 配置事件订阅

1. 左侧菜单 →「事件订阅」
2. 点击「添加事件」
3. 搜索并添加: `im.message.receive_v1`（接收消息）
4. **事件订阅方式选择: 「使用长连接接收事件」**（WebSocket 模式，无需公网 IP）

### 2.5 开通权限

1. 左侧菜单 →「权限管理」
2. 搜索并开通以下权限：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message:send_as_bot` — 以应用的身份发消息
   - `im:chat:readonly` — 获取群组信息

### 2.6 发布应用

1. 左侧菜单 →「版本管理与发布」
2. 点击「创建版本」
3. 填写版本号和更新说明
4. 提交审核（企业管理员审批后生效）

## 第三步：配置

### 方式一：TUI 交互式设置

```bash
node dist/cli.js

# 在 TUI 中执行
/channels setup
# 选择 "飞书"，按提示输入 App ID 和 App Secret
```

### 方式二：手动编辑 .bumblebee.yaml

```yaml
channels:
  feishu:
    enabled: true
    appId: cli_xxxxx
    appSecret: your-app-secret
    # encryptKey: your-encrypt-key         # 可选
    # verificationToken: your-token         # 可选
```

### 方式三：使用环境变量

配置文件支持 `${ENV_VAR}` 语法引用系统环境变量：

```yaml
# .bumblebee.yaml
channels:
  feishu:
    enabled: true
    appId: ${FEISHU_APP_ID}
    appSecret: ${FEISHU_APP_SECRET}
```

## 第四步：连接

```bash
# 启动 TUI
node dist/cli.js

# 连接飞书
/channels connect feishu
```

连接成功后，在飞书中给机器人发消息即可开始对话。

## 支持的功能

| 功能 | 支持 | 说明 |
|------|:----:|------|
| 文本消息 | ✅ | 发送和接收 |
| 图片 | ✅ | 通过 image_key |
| 文件 | ✅ | 通过 file_key |
| 音频 | ✅ | 接收为语音消息 |
| 视频 | ✅ | 接收为视频消息 |
| @提及 | ✅ | 群聊中检测 @ |
| 消息线程 | ✅ | 支持回复线程 |
| 表情回应 | ✅ | 支持 emoji 反应 |
| 富文本 | ✅ | 支持 post 格式 |
| 消息卡片 | ✅ | 通过 sendCard() 方法 |
| 群聊列表 | ✅ | 自动获取机器人加入的群 |

## 在群聊中使用

1. 将机器人添加到飞书群
2. 在群内 @机器人 发送消息
3. 机器人会自动回复

## 常见问题

### Q: 连接后收不到消息

A: 检查以下几点：
- 应用是否已发布并通过审核
- 事件订阅是否配置了 `im.message.receive_v1`
- 事件订阅方式是否选择了「长连接」
- 权限是否已开通（im:message, im:message:send_as_bot）

### Q: 提示 "appId or appSecret is invalid"

A: 确认：
- App ID 和 App Secret 是否正确复制（注意前后空格）
- 应用是否已保存

### Q: 机器人在群里不响应

A: 确保：
- 机器人已被添加到群里
- 消息中 @了机器人
- 应用权限 `im:message` 已开通

### Q: 如何发送消息卡片

A: 在代码中使用 `FeishuAdapter` 的 `sendCard()` 方法：
```typescript
const feishu = channelManager.getChannel('feishu')
if (feishu instanceof FeishuAdapter) {
  await feishu.sendCard(target, {
    header: { title: { content: '标题', tag: 'plain_text' } },
    elements: [{ tag: 'div', text: { content: '内容', tag: 'plain_text' } }]
  })
}
```

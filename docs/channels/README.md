# 渠道系统

Bumblebee 支持通过微信、飞书、钉钉等平台接收和发送消息，让 AI 编程助手无处不在。

## 快速开始

### 方式一：TUI 交互式设置（推荐）

```bash
# 启动 Bumblebee TUI
node dist/cli.js

# 在 TUI 中执行
/channel-setup          # 交互式选择平台并填写配置
/channel-connect        # 连接所有已配置的渠道
/channels               # 查看渠道状态
```

### 方式二：手动编辑配置文件

在项目根目录的 `.bumblebee.yaml` 中添加 `channels` 部分：

```yaml
channels:
  feishu:
    enabled: true
    appId: cli_xxxxx
    appSecret: your-app-secret
```

### 方式三：使用配置模板

```bash
# 复制对应平台的模板
cp config/templates/feishu.yaml .bumblebee.yaml

# 编辑配置，填入你的凭证
# 然后启动 TUI 连接
```

## 支持的渠道

| 渠道 | 模式 | 接收消息 | 发送消息 | 文件 | @提及 | 富文本 |
|------|------|:--------:|:--------:|:----:|:-----:|:------:|
| [微信](./wechat.md) | 扫码登录 | ✅ | ✅ | ✅ | ✅ | ❌ |
| [飞书](./feishu.md) | WebSocket | ✅ | ✅ | ✅ | ✅ | ✅ |
| [钉钉](./dingtalk.md) | Webhook | ❌ | ✅ | ✅ | ✅ | ✅ |
| [钉钉](./dingtalk.md) | 企业应用 | ✅ | ✅ | ✅ | ✅ | ✅ |

## TUI 命令

| 命令 | 功能 |
|------|------|
| `/channels` | 列出所有渠道及连接状态 |
| `/channel-setup` | 交互式设置渠道 |
| `/channel-connect [name]` | 连接指定或所有渠道 |
| `/channel-disconnect [name]` | 断开指定或所有渠道 |

## 配置参考

### 环境变量

敏感信息（token、appSecret 等）支持 `${ENV_VAR}` 语法：

```yaml
channels:
  feishu:
    enabled: true
    appId: ${FEISHU_APP_ID}
    appSecret: ${FEISHU_APP_SECRET}
```

### 配置字段

#### 微信

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `enabled` | boolean | 否 | 是否启用 |
| `puppet` | string | 否 | Puppet 类型 |
| `token` | string | 否 | PadLocal token |

#### 飞书

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `enabled` | boolean | 否 | 是否启用 |
| `appId` | string | 是 | 飞书应用 ID |
| `appSecret` | string | 是 | 飞书应用密钥 |
| `encryptKey` | string | 否 | 事件加密密钥 |
| `verificationToken` | string | 否 | 事件验证令牌 |

#### 钉钉

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `enabled` | boolean | 否 | 是否启用 |
| `mode` | string | 否 | `webhook` 或 `enterprise` |
| `webhook` | string | Webhook 模式必填 | 群机器人 Webhook 地址 |
| `appKey` | string | 企业模式必填 | 应用 AppKey |
| `appSecret` | string | 企业模式必填 | 应用 AppSecret |
| `robotCode` | string | 否 | 机器人编码 |

# 微信渠道接入指南

通过 [wechaty](https://github.com/wechaty/wechaty) 将 Bumblebee 接入微信，支持私聊、群聊和文件传输。

## 前置条件

- Node.js >= 22
- 微信账号（需要能正常登录微信网页版或桌面版）

## 第一步：安装依赖

```bash
# 安装 wechaty 核心
npm install wechaty

# 安装 puppet（三选一）

# 方案 A: PadLocal（★ 推荐，稳定，需要付费 token）
npm install wechaty-puppet-padlocal

# 方案 B: XP（免费，Windows 桌面版，需保持微信运行）
npm install wechaty-puppet-xp

# 方案 C: Wechat4U（⚠️ 基于 Web 微信协议，多数账号已无法登录）
npm install wechaty-puppet-wechat4u
```

### Puppet 选择建议

| Puppet | 费用 | 稳定性 | 平台限制 | 适用场景 |
|--------|------|--------|----------|----------|
| padlocal | 付费 | 高 | 无 | 生产使用（推荐） |
| xp | 免费 | 中等 | Windows | Windows 用户 |
| wechat4u | 免费 | 低 | 无 | ⚠️ 多数账号已不可用 |

> **注意**: wechat4u 基于 Web 微信协议，腾讯已大幅限制该协议，多数账号扫码后会报 `AssertionError: -1 == 0` 错误。推荐使用 PadLocal 或 XP。

## 第二步：获取 Token（仅 PadLocal）

如果使用 PadLocal puppet：

1. 访问 https://pad-local.com
2. 购买 token
3. 记录 token 值

其他 puppet 跳过此步。

## 第三步：配置

### 方式一：TUI 交互式设置

```bash
node dist/cli.js

# 在 TUI 中执行
/channel-setup
# 选择 "微信"，按提示操作
```

### 方式二：手动编辑 .bumblebee.yaml

```yaml
channels:
  wechat:
    enabled: true
    puppet: wechaty-puppet-wechat4u   # 或 wechaty-puppet-padlocal
    # token: your-padlocal-token      # 仅 padlocal 需要
```

### 方式三：使用环境变量

```bash
# .env 文件
WECHAT_TOKEN=your-padlocal-token
```

```yaml
# .bumblebee.yaml
channels:
  wechat:
    enabled: true
    puppet: wechaty-puppet-padlocal
    token: ${WECHAT_TOKEN}
```

## 第四步：连接

```bash
# 启动 TUI
node dist/cli.js

# 连接微信
/channel-connect wechat
```

连接后终端会显示二维码，用微信扫码登录。

## 支持的功能

| 功能 | 支持 | 说明 |
|------|:----:|------|
| 文本消息 | ✅ | 发送和接收 |
| 图片 | ✅ | 接收为 `[图片]` 占位符 |
| 语音 | ✅ | 接收为 `[语音]` 占位符 |
| 文件 | ✅ | 文件传输助手 |
| @提及 | ✅ | 群聊中检测 @ |
| 群聊 | ✅ | 通过群名称匹配 |
| 私聊 | ✅ | 通过昵称或 ID 匹配 |

## 常见问题

### Q: 扫码后报 `AssertionError: -1 == 0`

A: 这是 wechat4u 的已知问题。Web 微信协议已被腾讯大幅限制，多数账号无法通过此方式登录。解决方案：
- **推荐**: 切换到 `wechaty-puppet-padlocal`（付费但稳定）
- **备选**: 切换到 `wechaty-puppet-xp`（免费，仅 Windows）

### Q: 扫码后提示登录失败

A: 微信可能限制了网页版登录。尝试：
- 使用其他 puppet（如 padlocal 或 xp）
- 确保微信账号没有被限制网页版登录
- 等待一段时间后重试

### Q: 收不到群消息

A: 确保：
- Bumblebee 在群内被 @
- 群消息没有被微信折叠
- puppet 类型支持群消息接收

### Q: wechaty 安装失败

A: wechaty 依赖较多原生模块，尝试：
```bash
npm install wechaty --ignore-scripts
npm rebuild
```

### Q: 如何切换 puppet

A: 修改 `.bumblebee.yaml` 中的 `puppet` 字段，重启 TUI 后重新连接。

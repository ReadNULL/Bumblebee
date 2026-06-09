# 微信渠道接入指南

通过 [wechaty](https://github.com/wechaty/wechaty) 将 Bumblebee 接入微信，支持私聊、群聊和文件传输。

## 前置条件

- Node.js >= 22
- 微信账号（需要能正常登录微信网页版或桌面版）

## 第一步：安装依赖

```bash
# 安装项目依赖；会安装 wechaty、Wechat4U，以及可选的 PadLocal puppet
npm install

# 如果只想单独安装微信核心依赖
npm install wechaty

# PadLocal 已作为 optionalDependency 声明，项目 npm install 会默认尝试安装
npm install wechaty-puppet-padlocal

# XP 为实验性方案；依赖 frida 原生模块，Node 22 下可能无法安装
npm install wechaty-puppet-xp

# Wechat4U 已由 wechaty 自带；多数账号已无法登录，一般无需手动安装
npm install wechaty-puppet-wechat4u
```

### Puppet 选择建议

| Puppet | 费用 | 稳定性 | 平台限制 | 适用场景 |
|--------|------|--------|----------|----------|
| padlocal | 付费/申请制 | 高 | 无 | 有 token 时优先使用 |
| xp | 免费 | 中等 | Windows | 实验性，Node 22 下可能无法安装 |
| wechat4u | 免费 | 低 | 无 | ⚠️ 多数账号已不可用 |

> **注意**: wechat4u 基于 Web 微信协议，腾讯已大幅限制该协议，多数账号扫码后会报 `AssertionError: -1 == 0` 错误。PadLocal 更稳定，但需要先获取 token；如果暂时没有 token，建议先使用飞书或钉钉渠道验证 IM 接入。

## 第二步：获取 Token（仅 PadLocal）

如果使用 PadLocal puppet：

1. 向 PadLocal / Wechaty 社区或服务方申请试用 token，或购买长期 token。
2. 记录形如 `puppet_padlocal_xxxxxxxxxxxxxxxxxx` 的 token。
3. 如果旧文档提到的 `pad-local.com` 拒绝连接，说明该公开入口可能已不可用，不要把它视为稳定自助注册路径。

可参考这些入口了解当前申请方式：

- Wechaty token 文档: https://wechaty.js.org/docs/puppet-services/tokens
- PadLocal 文档: https://wechaty.js.org/zh/docs/puppet-services/padlocal
- Wechaty puppet-supports issue: https://github.com/wechaty/puppet-supports/issues?q=padlocal

其他 puppet 跳过此步。

## 第三步：配置

### 方式一：TUI 交互式设置

```bash
node dist/cli.js

# 在 TUI 中执行
/channels setup
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

配置文件支持 `${ENV_VAR}` 语法引用系统环境变量：

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
/channels connect wechat
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
- **有 PadLocal token 时**: 切换到 `wechaty-puppet-padlocal`
- **没有 token 时**: 先使用飞书或钉钉渠道完成 IM 接入验证
- **实验性**: `wechaty-puppet-xp` 仅适合能自行处理 Node/原生依赖兼容性的 Windows 环境

### Q: 扫码后提示登录失败

A: 微信可能限制了网页版登录。尝试：
- 使用其他 puppet（PadLocal 需要 token；XP 为实验性）
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

### Q: 连接时报 `Cannot find package 'wechaty-puppet-xp'`

A: 当前配置选择了 `wechaty-puppet-xp`，但项目没有安装这个 puppet 包。Wechaty 的 puppet 是独立依赖，不会随 `wechaty` 自动安装。解决方式：

```bash
npm install wechaty-puppet-xp
```

如果使用的是其他 puppet，把命令中的包名替换成 `.bumblebee.yaml` 里 `channels.wechat.puppet` 的值。安装后重启 Bumblebee 并重新执行 `/channels connect wechat`。

注意：XP puppet 依赖 `frida` 原生模块，当前 Bumblebee 要求 Node.js >= 22，而 `wechaty-puppet-xp@2.2.0` 在 Node 22 / Windows 下可能无法安装。因此 Bumblebee 不把 XP 作为默认预装依赖。优先使用 PadLocal；确需 XP 时，需要自行准备兼容的 Node/原生构建环境。

### Q: 如何切换 puppet

A: 修改 `.bumblebee.yaml` 中的 `puppet` 字段，重启 TUI 后重新连接。

# Bumblebee

Bumblebee V2 正在基于 pi Extension 机制从零重建。项目采用逐积木开发方式：每个组件都必须先明确契约、通过聚焦测试并完成人工验收，才能开始下一个组件。

## 积木搭建计划

### 基础层

| 轮次 | 积木 | 解决的问题 |
| --- | --- | --- |
| 1 | 错误模型 | 统一错误代码、cause 保留和边界归一化 |
| 2 | 结构化日志 | 安全序列化、敏感信息脱敏和 traceId |
| 3 | 取消与超时 | AbortSignal 传播、超时区分和可中断等待 |
| 4 | 并发控制 | 公平 Semaphore、会话串行队列和等待取消 |
| 5 | 生命周期 | 初始化失败回滚、LIFO 清理和幂等 dispose |
| 6 | 基础层总复盘 | 组合演示、依赖方向和故障注入 |

## 当前范围

当前分支包含最小项目骨架和第 1 个基础积木：

- pi 包清单；
- 空的 TypeScript 扩展入口；
- 严格的 TypeScript 配置；
- 独立且按功能分类的测试目录；
- 统一错误模型与错误边界归一化。

目前没有注册命令、工具或事件处理器，也没有 Agent、记忆、知识、工作流、渠道等运行时功能。

## 目录约定

```text
src/
├── extension.ts
└── foundation/
    └── errors/
        ├── bumblebee-error.ts
        └── index.ts
test/
├── extension.spec.ts
└── foundation/
    └── errors/
        └── bumblebee-error.spec.ts
```

每个积木拥有独立功能目录，`test/` 按照 `src/` 的功能层级组织对应测试。功能目录中的 `index.ts` 是唯一公共出口，基础层不依赖 pi 或上层业务模块。测试代码保留在 Git 中供开发和 CI 使用，但不会进入 npm 发布包。

## 统一错误处理

业务代码使用 `BumblebeeError` 表达可识别错误，在外部 SDK、插件和其他不可信边界使用 `normalizeError()` 处理捕获到的 `unknown`：

```typescript
import {
  ERROR_CODES,
  getUserMessage,
  normalizeError,
} from "./src/foundation/errors/index.js";

try {
  await callExternalService();
} catch (cause: unknown) {
  const error = normalizeError(cause, {
    code: ERROR_CODES.UNAVAILABLE,
    retryable: true,
    userMessage: "服务暂时不可用，请稍后重试。",
  });

  showToUser(getUserMessage(error, "操作失败。"));
  throw error;
}
```

`message`、`cause` 和 `context` 用于内部诊断。只有显式设置的 `userMessage` 才能展示给用户，避免泄露内部路径、令牌或第三方错误详情。

## 环境要求

- Node.js 22.19 或更高版本
- pi（`@earendil-works/pi-coding-agent`）

## 开发验证

```bash
npm install
npm run typecheck
npm test
```

开发期间可让 pi 直接加载空扩展：

```bash
pi -e ./src/extension.ts
```

# 取消与超时

所有耗时操作由调用场景显式提供截止时间，不使用全局固定超时：

```typescript
import {
  abortableSleep,
  withTimeout,
} from "./index.js";

const response = await withTimeout(
  (signal) => callModel({ prompt, signal }),
  {
    operationName: "model request",
    signal: parentSignal,
    timeoutMs: modelTimeoutMs,
  },
);

await abortableSleep(backoffMs, parentSignal);
```

## 触发和传播

`withTimeout()` 创建子 signal，并把父级取消向下传播：

| 来源 | 结果 |
| --- | --- |
| 截止时间到达 | 抛出 `TIMEOUT` |
| 用户、上层任务或生命周期取消 | 抛出 `CANCELLED` |
| 任务自身失败 | 保持原始错误语义 |

等待结束后会清理 timer 和事件监听器。`abortableSleep()` 可用于重试退避，使关闭和
用户取消能够立即打断等待。

## 边界

AbortSignal 是协作式取消。底层 SDK 必须接收并响应 signal 才能真正停止工作；如果
任务忽略 signal，`withTimeout()` 只能让调用方停止等待，无法撤销已经发生的副作用。
同步 CPU 阻塞也不能被 Node.js timer 强制中断，需要 Worker 或进程隔离。

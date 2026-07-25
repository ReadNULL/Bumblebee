# 并发控制

`Semaphore` 限制共享资源的同时运行数量，`KeyedSerialQueue` 保证同一个键内的任务
按 FIFO 串行执行，不同键之间仍可并行：

```typescript
import {
  KeyedSerialQueue,
  Semaphore,
} from "./index.js";

const modelSlots = new Semaphore(3);
const sessions = new KeyedSerialQueue<string>();

await sessions.enqueue(
  sessionId,
  (sessionSignal) => modelSlots.runExclusive(
    (limitedSignal) => callModel({ signal: limitedSignal }),
    { signal: sessionSignal },
  ),
  { signal: requestSignal },
);
```

## 触发逻辑

- Semaphore 按等待顺序发放许可；
- `runExclusive()` 在成功或失败后自动释放；
- 手动取得的 permit 支持幂等 `release()`；
- 同一 session key 的任务严格按提交顺序执行；
- 键空闲后删除内部状态，避免历史会话长期驻留。

等待中的许可或任务可以立即取消，并从 O(1) 双向队列中移除。任务开始后，取消仍会
通过 signal 传给任务，但并发许可和会话键必须等任务真正结束后才释放，防止忽略
取消的底层操作与后续任务重叠。

并发模块不重复实现超时策略，调用方按场景组合 `withTimeout()`。当前控制只在单个
Node.js 进程内生效，不提供分布式锁或跨进程配额。

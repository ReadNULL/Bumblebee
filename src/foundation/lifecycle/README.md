# 生命周期

`Lifecycle` 管理一次初始化作用域。每成功获得一个资源，就立即登记对应清理动作：

```typescript
import { Lifecycle } from "./index.js";

const lifecycle = new Lifecycle();

await lifecycle.initialize(async ({ defer, signal }) => {
  const store = await openStore({ signal });
  defer("store", () => store.close());

  const channel = await connectChannel({ signal });
  defer("channel", () => channel.disconnect());
});

await lifecycle.dispose();
```

## 初始化与回滚

正常释放和初始化失败回滚都按 LIFO 执行，上例会先断开 channel，再关闭它依赖的
store。setup 抛错或收到取消时，已经登记的资源会自动回滚；回滚成功时保留原始
初始化错误。

`context.signal` 覆盖整个生命周期。初始化失败或调用 `dispose()` 时会先取消该
signal，让后台任务停止接收新工作，再开始资源清理。

## 释放语义

- `dispose()` 可以重复或并发调用，清理栈只执行一次；
- 初始化期间调用 `dispose()` 会等待 setup 退出并完成回滚；
- 单个清理失败不会阻止其他清理；
- 多个清理错误最终通过 `INTERNAL` 和 `AggregateError` 一并报告。

清理回调不会接收已经取消的 lifecycle signal，也没有统一固定超时，避免关键资源
释放到一半被截止时间打断。确实需要截止时间时，应在清理回调内部显式组合
`withTimeout()`。清理回调不能反向等待同一个 Lifecycle 的 `dispose()`，否则会形成
自等待。

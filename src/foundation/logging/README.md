# 结构化日志

`StructuredLogger` 只生成稳定日志记录，不默认写入控制台。组合根必须注入时钟、
`TraceContext` 和输出 sink：

```typescript
import {
  StructuredLogger,
  TraceContext,
} from "./index.js";

const traceContext = new TraceContext();
const logger = new StructuredLogger({
  clock: () => new Date(),
  scope: "bumblebee",
  sink: (record) => writeLogRecord(record),
  traceContext,
});

await traceContext.run(async () => {
  logger.info("channel message received", {
    fields: { channel: "feishu", conversationId: "example" },
  });

  await handleMessage();
});
```

## 日志结构

固定字段包括 `timestamp`、`level`、`message`、`scope`、`traceId`、`fields` 和
`error`。`TraceContext` 使用 `AsyncLocalStorage` 跨 `await` 传播 traceId，并隔离
并发任务。

每个 Bumblebee 实例持有自己的 `TraceContext`。实例生命周期结束时应调用
`traceContext.dispose()`；释放后再次调用 `run()` 会返回 `CONFLICT`。

## 脱敏与序列化

日志参数经过有界序列化：

- 循环引用、异常 getter 和 BigInt 不会破坏 JSON 输出；
- Error cause 和 `AggregateError.errors` 会被安全展开；
- 常见令牌、密码、Cookie、Authorization 和私钥字段默认脱敏；
- 调用方可以配置额外敏感键。

脱敏是最后一道防御，不代表调用方可以主动记录完整凭据。生产 sink 也不应执行
阻塞 I/O 或把异常反向抛入业务流程。

# 统一错误处理

业务代码使用 `BumblebeeError` 表达可识别错误，在外部 SDK 和其他不可信边界使用
`normalizeError()` 处理捕获到的 `unknown`：

```typescript
import {
  ERROR_CODES,
  getUserMessage,
  normalizeError,
} from "./index.js";

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

## 数据边界

- `message`、`cause` 和 `context` 只用于内部诊断；
- 只有显式设置的 `userMessage` 才能展示给用户；
- 边界归一化保留原始 cause，不把任意第三方异常直接暴露给用户；
- 错误代码和 `retryable` 让上层可以稳定地区分重试、取消、冲突和输入错误。

该设计避免内部路径、令牌或第三方错误详情通过 UI 和远程渠道泄露。

# Feature Profiles

Bumblebee 提供三个显式功能 profile，用于生产默认配置和 benchmark 消融：

| Profile | Assurance | Permission | Memory | Sub-Agent | Channel |
| --- | --- | --- | --- | --- | --- |
| `pi-baseline` | 关闭 | 关闭 | 关闭 | 关闭 | 关闭 |
| `permission-only` | 开启 | 开启 | 关闭 | 关闭 | 关闭 |
| `full` | 开启 | 开启 | 开启 | 开启 | 开启 |

默认值为 `full`，保持原有生产行为。可以在加载扩展前设置：

```powershell
$env:BUMBLEBEE_FEATURE_PROFILE = "permission-only"
pi -e ./src/extension.ts
```

`pi-baseline` 只用于消融；正常使用无需加载一个什么都不注册的扩展。未知值会在扩展
加载阶段明确失败，不会静默回退到另一组能力。

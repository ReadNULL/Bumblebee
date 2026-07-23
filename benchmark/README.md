# Bumblebee Benchmark

该目录只承载开发评估工程，不属于 Bumblebee 运行时，也不会进入 npm 发布包。

## 目录命名

每个积木使用独立目录：

```text
benchmark/benchmark_<序号>_<测试集或能力名称>/
```

名称使用小写英文和下划线，序号从 `0` 开始。`benchmark_0_evaluation_core`
不是测试集，而是所有后续 benchmark 共用的结果契约、证据存储、硬门槛和经验记录基础。

## 当前积木

| 序号 | 目录 | 作用 | 状态 |
| ---: | --- | --- | --- |
| 0 | `benchmark_0_evaluation_core` | 统一评估契约、追加式运行记录、制品完整性、硬门槛与 lesson | 已实现 |

原始模型输出、工具轨迹和 verifier 产物必须写入各积木的 `artifacts/`
或外部 CI artifact/object storage。仓库只提交脱敏后的配置、摘要和经验记录。

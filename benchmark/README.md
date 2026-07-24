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
| 1 | `benchmark_1_bumblebee_bench` | Runtime、取消、权限、Sub-Agent、Channel、Memory 的确定性工程基准 | 已实现 |
| 2 | `benchmark_2_terminal_bench_2_1` | Harbor/Terminal-Bench 2.1 Lite 固定 9/89 子集、三轮基线校准、结果归一化与评分 | 已实现，无模型 Docker 预检通过，待真实评估 |
| 3 | `benchmark_3_agentdojo_workspace` | AgentDojo Workspace、pi RPC 工具桥、提示注入指标、结果导入与评分 | 已完成首轮完整真实评估，AD 94.39 |
| 4 | `benchmark_4_longmemeval_bumblebee` | 显式长期记忆事件、真实 Memory 重放、pi 读者、更新/拒答/隔离评分 | 已实现，待真实模型评估 |
| 5 | `benchmark_5_bcs_v1_scorecard` | 四套件 artifact 校验、身份一致性、BCS-v1 门槛、加权总分与报告 | 已实现，待正式来源运行 |

原始模型输出、工具轨迹和 verifier 产物必须写入各积木的 `artifacts/`
或外部 CI artifact/object storage。仓库只提交脱敏后的配置、摘要和经验记录。

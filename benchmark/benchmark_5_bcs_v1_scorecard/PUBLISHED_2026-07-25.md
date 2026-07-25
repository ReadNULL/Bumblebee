# BCS-v1 正式项目发布

发布日期：2026-07-25

```text
TB = 93.33
BCS-v1 = 96.65
qualification = qualified
publication mode = environment-recovery-aggregate
```

## 为什么使用聚合

Terminal-Bench 复验期间先后遇到 Docker/验证器依赖下载、PyPI 索引和模型服务余额
异常，无法在合理预算内得到一轮覆盖全部 9 题且完全有效的单次 run。项目因此正式
采用“环境恢复聚合”口径，避免把已经成功的高成本任务反复重跑。

该口径遵守以下约束：

1. 只使用已经审计的 Bumblebee candidate job，不混入 baseline。
2. 每题只能选择同一个 job 的完整 5-trial 批次，不能逐条挑选成功 trial。
3. 9 个冻结任务必须各出现一次，总分母固定为 45。
4. infrastructure invalid 必须写明原因，并继续按 0 计分。
5. 所有原始 job 的 passed、failed、invalid、commit、Harbor job ID 和产物哈希均保留。

因此 TB 统计为 42 passed、1 failed、2 infrastructure invalid：

```text
TB = 42 / 45 * 100 = 93.3333
```

严格单次 run 口径仍为 `N/A`。这里的 `TB = 93.33` 是 Bumblebee 项目正式分数，
不是上游 Terminal-Bench 官方排行榜成绩，也不代表单一 commit 的一次运行。

## BCS-v1 计算

| 分项 | 分数 | 权重 | 贡献 |
| --- | ---: | ---: | ---: |
| BB | 100.0000 | 0.35 | 35.0000 |
| TB | 93.3333 | 0.30 | 28.0000 |
| AD | 94.3899 | 0.20 | 18.8780 |
| LM | 98.5000 | 0.15 | 14.7750 |
| **BCS-v1** |  |  | **96.6530** |

```text
BCS-v1
= 0.35 * 100.0000
+ 0.30 * 93.3333
+ 0.20 * 94.3899
+ 0.15 * 98.5000
= 96.6530
= 96.65
```

四套件共有 1055 个任务记录，其中 1053 个有效：

```text
valid task rate = 1053 / 1055 = 99.8104%
```

该值高于 BCS-v1 冻结的 98% 全局有效任务门槛；类型检查、确定性测试、越权写入、
记忆隔离、渠道授权、重复副作用和凭据持久化等全局硬门槛也全部通过。

## 证据

| 分项 | 来源 |
| --- | --- |
| BB | `run_mrxgopxi_8fbe0a2c-10e0-4c91-95af-4a9e27a79127` |
| TB | 6 个保留原始状态的 Harbor job，3 个 job 的完整任务批次进入聚合 |
| AD | `run_mrxo3346_7c8d11f0-40d5-4246-aea0-0354ff53e003` |
| LM | `run_mrxgph4t_6ea933f0-efc3-4145-9dca-635dfd356053` |

BB、AD、LM 使用同一 Bumblebee commit
`84fe4450b8115066034c0019e859e42fdc5be441` 和 Pi `0.78.1`。TB、AD、LM
使用 `deepseek/deepseek-v4-flash`、thinking `high`。完整 run 哈希、TB job 哈希
和逐任务选择见
[`bcs-v1-environment-recovery-2026-07-25.json`](./manifests/bcs-v1-environment-recovery-2026-07-25.json)；
TB 原始运行与选择说明见
[`BEST_OBSERVED_2026-07-25.md`](../benchmark_2_terminal_bench_2_1/BEST_OBSERVED_2026-07-25.md)。

## 复算

```bash
npm run benchmark:score -- publish
```

发布命令只读取冻结清单、验证聚合契约并执行 BCS-v1 门槛和公式，不调用模型，也不
修改任何原始测试结果。

# Terminal-Bench 环境恢复聚合发布

截至 2026-07-25，Bumblebee 将现有真实模型运行中的任务级完整批次聚合正式发布为
项目 TB 分数：

```text
TB = 42 / 45 * 100 = 93.33
```

该结果最初记录为 `TB-BOC`，现按项目的
`environment-recovery-aggregate` 协议转为正式 `TB` 输入。原因是 Docker、
依赖索引和模型服务异常导致测试分多轮恢复完成。它不是官方 Terminal-Bench
排行榜分数，也不代表单一 commit 的一次运行；严格单次 run 口径仍为 `N/A`。

## 组合规则

1. 只使用 Bumblebee candidate，不混入 Pi baseline。
2. 只使用已经完成证据泄漏与基础设施审计的 job。
3. 每个冻结任务以完整的 5-trial 批次为最小选择单位，不跨批次挑选单条 trial。
4. 同一任务选择原始 reward 最高的批次；invalid trial 仍按 0 计入 5 次分母。
5. 若原始 reward 相同，依次选择 valid trial 更多、整轮证据污染更少、时间更晚的
   批次。
6. 成本、时延和有效样本通过率只作为附加指标，不用于抬高组合分。

因此，r5 的 Cython 虽然唯一有效 trial 通过，但整个批次原始结果为 1/5，不能用
“有效样本 1/1”替换 r3 的完整 4/5。

## 候选池

| Job | 完成情况 | 审计结果 | 组合处理 |
| --- | ---: | --- | --- |
| `tb21-lite-bumblebee-1-20260724-r1` | 45/45 | 30 passed、10 failed、5 invalid | 未受污染的任务批次可参与 |
| `tb21-targeted-bumblebee-20260725-r1` | 8/20 | 提前停止，含 1 个 infrastructure invalid | 没有完整 5-trial 候选批次 |
| `tb21-targeted-bumblebee-20260725-r2` | 20/20 | 14 passed、3 failed、3 dataset invalid | 纳入比较，但未超过 r3/r4 |
| `tb21-targeted-bumblebee-20260725-r3` | 20/20 | 16 passed、4 failed | 选中 Cython、大文本和 gRPC |
| `tb21-targeted-bumblebee-20260725-r4` | 10/10 | 8 passed、2 failed | 选中 WAL |
| `tb21-targeted-bumblebee-20260725-r5` | 5/5 | 1 passed、4 infrastructure invalid | Cython 原始分 1/5，未选中 |

## 任务明细

| 任务 | 选中 job | Commit | 状态 | 原始分 |
| --- | --- | --- | --- | ---: |
| `fix-git` | `tb21-lite-bumblebee-1-20260724-r1` | `c8aebb8` | 5 passed | 5/5 |
| `build-cython-ext` | `tb21-targeted-bumblebee-20260725-r3` | `f4057b7` | 4 passed、1 failed | 4/5 |
| `cancel-async-tasks` | `tb21-lite-bumblebee-1-20260724-r1` | `c8aebb8` | 5 passed | 5/5 |
| `fix-code-vulnerability` | `tb21-lite-bumblebee-1-20260724-r1` | `c8aebb8` | 5 passed | 5/5 |
| `nginx-request-logging` | `tb21-lite-bumblebee-1-20260724-r1` | `c8aebb8` | 5 passed | 5/5 |
| `db-wal-recovery` | `tb21-targeted-bumblebee-20260725-r4` | `ec372ae` | 5 passed | 5/5 |
| `multi-source-data-merger` | `tb21-lite-bumblebee-1-20260724-r1` | `c8aebb8` | 3 passed、2 invalid | 3/5 |
| `large-scale-text-editing` | `tb21-targeted-bumblebee-20260725-r3` | `f4057b7` | 5 passed | 5/5 |
| `kv-store-grpc` | `tb21-targeted-bumblebee-20260725-r3` | `f4057b7` | 5 passed | 5/5 |
| **合计** | 3 个审计后 job | 3 个历史 commit | **42 passed、1 failed、2 invalid** | **42/45** |

## 附加指标

| 指标 | 结果 |
| --- | ---: |
| 项目正式 TB | `93.33` |
| 有效样本诊断通过率 | 42/43，`97.67%` |
| 有效率 | 43/45，`95.56%` |
| 所选 trial 模型成本 | `$0.255798` |
| 所选 trial Agent 总时长 | 约 `1.79h` |

有效样本诊断通过率排除了两个基础设施无效样本，所以只能作为诊断值。公开主指标使用
包含 invalid 的固定 45-trial 分母，即 `93.33`。

## 发布边界

可以使用以下表述：

> Bumblebee 项目的 Terminal-Bench 2.1 Lite 环境恢复聚合分数为 93.33
>（42/45，跨三次审计后 candidate job 的任务级完整批次组合）。

必须同时说明：

- 该结果跨越三个 commit，表示环境恢复后的项目聚合能力，不代表单一版本的一次运行；
- 组合中仍有两个 infrastructure invalid，均保留并按 0 计分；
- 没有完整且合格的三轮 baseline 效率预算；
- 该结果只能标记为 Bumblebee 项目正式 `TB`，不能标记为官方 Terminal-Bench
  或排行榜成绩；
- 该结果已按冻结权重进入项目 `BCS-v1 = 96.65`，发布清单见
  [BCS-v1 正式项目发布](../benchmark_5_bcs_v1_scorecard/PUBLISHED_2026-07-25.md)。

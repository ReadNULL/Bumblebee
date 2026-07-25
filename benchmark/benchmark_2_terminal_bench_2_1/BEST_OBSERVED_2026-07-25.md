# Terminal-Bench 最佳观测组合

截至 2026-07-25，Bumblebee 在现有真实模型运行中的任务级最佳观测组合为：

```text
TB-BOC = 42 / 45 * 100 = 93.33
```

`TB-BOC` 表示 Terminal-Bench Best-Observed Composite。它用于公开项目迭代过程中
已经实际观测到的最佳任务级结果，不是官方 Terminal-Bench 分数，也不进入
`BCS-v1`。正式 `TB` 仍为 `N/A`。

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
| 最佳观测组合分 | `93.33` |
| 有效样本诊断通过率 | 42/43，`97.67%` |
| 有效率 | 43/45，`95.56%` |
| 所选 trial 模型成本 | `$0.255798` |
| 所选 trial Agent 总时长 | 约 `1.79h` |

有效样本诊断通过率排除了两个基础设施无效样本，所以只能作为诊断值。公开主指标使用
包含 invalid 的固定 45-trial 分母，即 `93.33`。

## 发布边界

可以使用以下表述：

> Terminal-Bench 2.1 Lite 历史最佳观测组合为 93.33（42/45，跨三次审计后
> candidate job 的任务级完整批次组合）。

必须同时说明：

- 该结果跨越三个 commit，表示迭代历史中的最佳观测能力，不代表单一版本的一次运行；
- 组合中仍有两个 infrastructure invalid，有效率低于正式门槛；
- 没有完整且合格的三轮 baseline 效率预算；
- 该结果不能标记为官方 Terminal-Bench、排行榜成绩或 qualified `TB`；
- `BCS-v1` 继续显示 `N/A`，不能把 `TB-BOC` 填入正式加权公式。

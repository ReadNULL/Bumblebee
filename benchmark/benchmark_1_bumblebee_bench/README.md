# Benchmark 1: BumblebeeBench

BumblebeeBench 是 Bumblebee 自有工程积木的确定性基准。它直接调用产品公开接口，
不连接模型、不访问网络，也不把普通单元测试数量当作 Agent 能力。

## 评估对象

```text
BB = 0.20 * Runtime
   + 0.15 * Cancellation
   + 0.20 * Permission
   + 0.15 * SubAgent
   + 0.15 * Channel
   + 0.15 * MemoryCore
```

每个域使用：

```text
DomainScore = 100 * (0.80 * Correctness + 0.20 * SLOCompliance)
```

同域场景等权，避免通过给某个简单场景增加断言数量来放大权重。延迟分采用
`min(1, target / measured)`，超过目标会平滑扣分，低于目标不会获得超过 100 的分数。

## 固定场景

| 域 | 场景 | 真实检查 |
| --- | --- | --- |
| Runtime | `runtime-session-order` | 同会话严格串行、顺序不倒置、队列排空 |
| Runtime | `runtime-global-concurrency` | 跨会话并行、全局并发上限、等待任务最终执行 |
| Cancellation | `cancellation-queued-request` | 排队取消不进入用户操作、及时移出队列 |
| Cancellation | `cancellation-timeout-dispose` | 超时信号、错误码区分、dispose 取消和清理等待 |
| Permission | `permission-folder-boundary` | 文件夹授权复用、规范路径逃逸重新确认并阻止 |
| Permission | `permission-resume-merge` | 读写位合并、导出与 resume 恢复后不重复询问 |
| SubAgent | `subagent-output-boundary` | 输入规范化、UTF-8 安全截断、usage 缺省值 |
| SubAgent | `subagent-cancellation-errors` | 预取消不调用 executor、超时/失败分类、内部错误不泄漏 |
| Channel | `channel-deduplication` | 处理中和完成后的重复消息都只产生一次副作用 |
| Channel | `channel-sender-authorization` | 飞书回调先确认、白名单外发送者不进入 Agent |
| MemoryCore | `memory-update-persistence` | 稳定 key 更新、重启恢复、全局共享与项目隔离 |
| MemoryCore | `memory-secret-scope` | 凭据拒绝、磁盘不落密、失败写回滚内存快照 |

场景只记录断言 ID、数值指标和分类后的失败，不记录测试输入原文。文件系统场景为每个
trial 创建独立临时目录并在结束时删除；清理失败会标记为 `invalid/infrastructure`，
不会伪装成产品失败。

## 执行流程

```mermaid
flowchart LR
  Build["编译独立 runner"] --> Preflight["执行根项目 typecheck"]
  Preflight --> Manifest["验证冻结 manifest"]
  Manifest --> Start["Benchmark 0: startRun"]
  Start --> Scenario["逐场景、逐 trial 执行"]
  Scenario --> Evidence["保存断言与指标证据"]
  Evidence --> Task["追加 task result"]
  Task --> Aggregate["聚合正确率、SLO、p50/p95/p99"]
  Aggregate --> Gate["判定 validity 与 hard gates"]
  Gate --> Score{"qualified?"}
  Score -->|是| BB["计算 BB 分数"]
  Score -->|否| Raw["score = null，仅保留分项"]
  BB --> Finish["写 report、summary、run_finished"]
  Raw --> Finish
```

启动脚本先用 `noCheck` 仅生成独立 runner，避免产品类型错误阻止评估记录创建；CLI 随后
真实执行根目录 `tsc --noEmit`，结果作为显式
`typecheck_pass_rate` 传给评分器。聚合器不会自行假定预检通过。任一确定性场景失败或
安全违规会得到 `not-qualified`；有效任务不足 98% 会得到 `invalid`。

## Profile

| Profile | 每场景次数 | 用途 |
| --- | ---: | --- |
| `smoke` | 1 | 开发期间快速发现功能与边界回归 |
| `full` | 30 | 形成可报告的延迟分布和稳定性结果 |

`smoke` 的单次 p95/p99 只用于快速诊断，不具备统计意义。正式比较必须使用 `full`，
并保持 Node.js、操作系统和硬件 profile 一致。

## 运行

```bash
npm run benchmark:1
npm run benchmark:1:full
```

附加参数：

```bash
npm run benchmark:1 -- --output D:\benchmark-results
npm run benchmark:1 -- --parent-run-id run_previous
```

默认输出到：

```text
benchmark/benchmark_1_bumblebee_bench/.runtime/evaluation/
├── artifacts/<run-id>/
│   ├── manifest.json
│   ├── evidence/scenarios/
│   ├── evidence/report.json
│   ├── task-results/
│   └── summary.json
└── history/runs.jsonl
```

`.runtime/` 不提交 Git，但每次成功、失败、取消或无效 trial 都会在本地留存。需要将
一次修复与旧结果关联时使用 `--parent-run-id`；确定根因后再通过 Benchmark 0 的
`LessonStore` 创建可提交 lesson。

## 当前边界

- 该基准只衡量 Bumblebee 自有工程语义，不衡量模型推理、代码生成或真实终端任务能力；
- Sub-Agent 使用确定性 executor 端口，不产生模型成本，也不能替代外部端到端评估；
- Channel 使用真实 Dispatcher/FeishuAdapter，但 Gateway 是离线替身，不连接飞书；
- Permission 的路径逃逸通过可控 `realpath` 边界复现，不依赖 Windows 创建符号链接权限；
- 当前 SLO 是 `v1` 初始工程目标，调整场景、权重或阈值必须发布新 manifest 版本；
- `BB=100` 只表示冻结场景全部正确且在 SLO 内，不能解释为 Bumblebee 整体能力满分；
- 远程写安全、提示注入和真实 Coding Agent 成功率由后续 benchmark 负责。

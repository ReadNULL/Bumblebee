# Benchmark 2: Terminal-Bench 2.1 Lite

该积木通过 Harbor 接入官方
[Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1)，
并从 89 个上游任务中冻结 9 个分层代表任务，衡量 Bumblebee 在真实、可执行验证的
终端任务中的端到端价值。它不复制或修改上游任务、容器和 verifier，也不进入
Bumblebee 的 npm 发布包。

评估工程已经实现。2026-07-24 完成了第一轮 45-trial 真实 `pi-baseline` 和一轮
45-trial Bumblebee candidate。baseline 审计后为 32 passed、11 failed、2
infrastructure invalid。后续证据审计又发现 candidate 有 3 个 trial 读取了随
完整仓库安装进容器的 benchmark 专用资料；与既有基础设施无效样本合并后，
candidate 为 30 passed、10 failed、5 invalid，有效率 88.89%。两轮均低于冻结的
98% 门槛，因此只保留为探索性证据，当前仍没有可发布的 TB 分数。

失败轨迹、证据边界、改进优先级和下一轮验收条件见
[首轮真实评测复盘](./POSTMORTEM_2026-07-24.md)。

首轮复盘列出的 P0/P1 通用改进已经进入代码：无模型 verifier 预检、依赖预热、
Task Assurance、三档 feature profile、空记忆按需注入、只读 critic、lesson 草稿
和独立 `dev/holdout` 定向集。9-task 无模型预检
`tb21-verifier-preflight-20260725-r7` 已通过独立审计；失败任务的定向真实模型
复验结果见本页后续记录。

这是 Bumblebee 的项目级 `TB-Lite` 分项，不是完整 Terminal-Bench 2.1 成绩，也
不具备官方排行榜提交资格。这样将原计划的
`89 × 5 ×（3 baseline + 1 candidate）= 1780` 个 trial 降为
`9 × 5 × 4 = 180` 个 trial，同时保留相同模型、重复次数、官方 verifier 和三轮
baseline 校准。

## 模块边界

```mermaid
flowchart LR
  Plan["plan 生成命令"] --> Harbor["Harbor 0.20.0"]
  Harbor --> Dataset["官方 Terminal-Bench 2.1"]
  Harbor --> Agent{"运行模式"}
  Agent --> Baseline["PinnedPi，无 Bumblebee"]
  Agent --> Candidate["BumblebeePi，加载固定 commit"]
  Dataset --> Job["Harbor job 目录"]
  Baseline --> Job
  Candidate --> Job
  Job --> Normalize["读取 config.json/result.json"]
  Normalize --> Calibrate["三轮 baseline 校准"]
  Normalize --> Score["候选任务评分"]
  Calibrate --> Budget["冻结的逐任务成本/时延预算"]
  Budget --> Score
  Score --> Store["Benchmark 0 证据与报告"]
```

| 目录 | 职责 |
| --- | --- |
| `harbor_agent/` | 复用 Harbor 的 Pi 集成，只替换 Pi 安装版本并增加 Bumblebee extension 参数 |
| `manifests/` | 冻结数据集身份、9 个代表任务、每任务至少 5 次、Pi 版本、评分权重和硬门槛 |
| `src/harbor/` | 生成可审阅的 Harbor 命令，不自动执行付费评估 |
| `src/importer/` | 将 Harbor `JobResult/TrialResult` 归一化为 Benchmark 0 契约 |
| `src/scoring/` | 三轮 `pi-baseline` 中位数校准及 TB 分数计算 |
| `src/runner/` | 保存每次 trial、来源哈希、报告和无效/NQ 状态 |
| `src/dev/` | 不含公开题目答案的 Task Assurance 开发集和独立留出集 |
| `test/` | 不联网、不调用模型的确定性开发测试 |

## 运行边界

- Harbor 固定为 `0.20.0`，只记录在本目录的 `requirements.txt`；
- Pi 固定为项目使用的
  `@earendil-works/pi-coding-agent@0.78.1`；
- baseline 使用 `PinnedPi` 且强制 `--no-extensions`；
- candidate 使用 `BumblebeePi`，在 Agent setup 阶段将指定 commit 安装到固定本地
  目录；安装器通过 `npm pack` 只提取生产发布白名单，再单独复制 benchmark
  wrapper，删除临时 Git checkout 和根 README 后才启动模型。执行阶段通过
  `--no-extensions --extension <local-path>` 只加载该 commit 的生产代码与 wrapper；
- Harbor 没有交互式授权 UI，candidate wrapper 固定注入 `allow-once` authority；
  它仍注册同一组 Bumblebee 生产模块，只替换授权决策来源；
- `main`、tag、短 SHA 或未推送的本地目录不能作为正式 candidate 身份；
- candidate 可显式选择 `pi-baseline`、`permission-only` 或 `full` profile；
- 模型必须显式使用 `provider/model`，API Key 只通过进程环境传给 Harbor；
- 默认不包含 `--upload` 或 `--public`，不会意外公开轨迹。

Manifest 中的上游 reference 是 `latest`，但评分身份不依赖这个移动名称。导入时会
按排序后的 `task_name + task_checksum` 计算数据集 SHA-256；三轮 baseline 必须
使用相同哈希，candidate 的哈希必须和预算文件一致。上游内容一旦变化，旧预算
覆盖率会变为 0，本轮只能得到 `NQ`，必须重新校准。

## 固定代表任务

任务不是运行时随机抽取，而是在看到 TB 模型成绩前按能力类别、难度和工程通用性
一次性冻结。命令生成器会为每个任务添加精确的 `--include-task-name`，导入器还会
校验实际任务 ID 集合；仅仅“数量也是 9 个”不能通过。

| 任务 | 难度 | 主要覆盖点 |
| --- | --- | --- |
| `fix-git` | easy | Git 状态诊断与提交恢复 |
| `build-cython-ext` | medium | 依赖修复、NumPy 兼容与原生扩展构建 |
| `cancel-async-tasks` | hard | 异步并发、取消与资源清理 |
| `fix-code-vulnerability` | hard | 漏洞定位、输入校验与安全修复 |
| `nginx-request-logging` | medium | 服务安装、配置与运行验证 |
| `db-wal-recovery` | medium | 数据库文件分析与 WAL 恢复 |
| `multi-source-data-merger` | medium | 多格式 ETL、字段映射与冲突处理 |
| `large-scale-text-editing` | medium | 大文件变换与受限工具使用 |
| `kv-store-grpc` | medium | gRPC 服务、代码生成与进程管理 |

## 首轮真实运行（2026-07-24）

baseline 运行身份固定为 commit
`b37dd285be7f2d510b2f6d838d86c9eb2e1fffdf`，candidate 固定为
`c8aebb8279dfec819102cc12b4c349b89e483c75`。两者均使用 Harbor `0.20.0`、
Pi `0.78.1`、`deepseek/deepseek-v4-flash`、thinking `high`、Docker 和 2 路
并发。所有 job 目录均保留在被 Git 忽略的 `.runtime/jobs/` 中。

### 执行记录

| Job | 完成情况 | 结论与处理 |
| --- | ---: | --- |
| `tb21-lite-smoke-baseline-20260724-1250` | 0/1 | 自定义 adapter 无法导入，且 Windows GBK 无法渲染错误输出；改为 `python -m harbor.cli.main` |
| `tb21-lite-smoke-baseline-20260724-1253` | 1/1 | `fix-git` reward 1，真实模型、Docker、Pi 和 verifier 链路打通，成本约 `$0.001566` |
| `tb21-lite-pi-1-20260724` | 2/45 | Pi 冷安装超过 Harbor 默认 setup 时限，主动停止；增加 3 倍 setup timeout |
| `tb21-lite-pi-1-20260724-r1` | 0/45 | `nodejs.org` 下载 Node 长时间停滞，主动停止；固定 Node `22.20.0` 和国内镜像 |
| `tb21-node-mirror-install-preflight-20260724` | 1/1 | 无模型 install-only 预检通过，Pi 安装约 83 秒，总耗时 1 分 35 秒 |
| `tb21-lite-pi-1-20260724-r2` | 26/45 | DeepSeek 503 被 Pi 以退出码 0 吞掉，主动停止；adapter 改为识别最终 API 状态并只重试瞬态错误 |
| `tb21-lite-pi-1-20260724-r3` | 45/45 | Harbor 原始运行完整，但 2 条 verifier 网络故障污染 reward 0，审计后不具备校准资格 |
| `tb21-lite-bumblebee-smoke-20260724` | 1/1 | reward 0；默认 PermissionSystem 在无 UI 时正确拒绝写入和 Shell，证明不能直接把生产交互模式用于 Harbor |
| `tb21-lite-bumblebee-smoke-20260724-r1` | 1/1 | benchmark-only `allow-once` wrapper 已能执行 `bash/write/edit`；Harbor 在收集产物时异常，但容器内 verifier 直接复核 2/2 通过 |
| `tb21-lite-bumblebee-1-20260724-r1` | 45/45 | 原始 reward 30/45；追加审计确认 3 条证据泄漏，与基础设施异常去重后共 5 invalid，`TB = N/A` |
| `tb21-targeted-bumblebee-20260725-r1` | 8/20 | Python 运行时下载超时使有效率上限低于 98%，主动停止；7 个有效结果和 1 个基础设施无效结果均保留 |
| `tb21-python-mirror-preflight-20260725` | 1/1 | 无模型复验通过，Python 下载镜像和错误分类修复生效 |
| `tb21-targeted-bumblebee-20260725-r2` | 20/20 | 原始 reward 14/20，但 3 个 WAL trial 读取 benchmark 专用资料；整轮判为污染、invalid，不作为改进结论 |
| `tb21-candidate-isolation-preflight-20260725` | 1/1 | 无模型真实容器验证生产代码与 wrapper 可用，且 `.git`、根 README、benchmark 文档和临时源码目录均不可见 |
| `tb21-candidate-isolation-preflight-20260725-r2` | 1/1 | 精确提交 `f4057b7` 的强化隔离预检通过；项目 Markdown 全部不可见 |
| `tb21-targeted-bumblebee-20260725-r3` | 20/20 | 干净定向复验 16/20，全部样本有效、证据泄漏 0；只覆盖 4/9 任务，仍为 invalid、`TB = N/A` |
| `tb21-candidate-isolation-preflight-20260725-r3` | 1/1 | 精确提交 `ec372ae` 的无模型隔离预检通过，0 异常、0 重试，耗时 1 分 16 秒 |
| `tb21-targeted-bumblebee-20260725-r4` | 10/10 | 只复验 Cython/WAL，结果 8/10；全部样本有效、证据泄漏 0，仍因只覆盖 2/9 而 invalid |

中断不是删除记录。前三次正式尝试和 smoke/preflight 的原始结果均继续保留，用于说明
环境问题、修复依据和成本；只有通过完整性与有效率门槛的 job 才能进入校准。

### Baseline r3 原始结果

| 指标 | 结果 |
| --- | ---: |
| Harbor 原始 reward | 32/45，均值 `0.7111` |
| 审计后状态 | 32 passed、11 failed、2 infrastructure invalid |
| 有效率 | 43/45，`95.56%`，低于 `98%` 硬门槛 |
| 异常 | 1 个 `AgentTimeoutError`，无 API 瞬态错误重试 |
| 总运行时间 | 2 小时 4 分 46 秒 |
| Agent 时延 | p50 `46.4s`、p95 `562.0s`、p99 `1200.0s` |
| Token | input `37,098,210`、cache read `36,214,784`、output `463,287` |
| 模型成本 | `$0.354801` |
| 凭据审计 | 458 个证据文件中 API Key 精确值命中 0 次 |
| 资源清理 | Harbor trial 容器残留 0 个 |

| 任务 | 原始通过 | 审计结论 |
| --- | ---: | --- |
| `fix-git` | 5/5 | 稳定通过 |
| `build-cython-ext` | 1/5 | 依赖安装、NumPy 兼容和仓库回归验证不稳定 |
| `cancel-async-tasks` | 4/5 | 失败样本只清理了一个并发任务 |
| `fix-code-vulnerability` | 4/5 | 失败样本遗漏非法 header 的拒绝逻辑 |
| `nginx-request-logging` | 5/5 | 稳定通过 |
| `db-wal-recovery` | 0/5 | 3 次未正确应用 WAL，另 2 次是 verifier 下载依赖失败 |
| `multi-source-data-merger` | 5/5 | 稳定通过 |
| `large-scale-text-editing` | 4/5 | 1 次执行达到 1200 秒正式超时 |
| `kv-store-grpc` | 4/5 | 失败样本生成了错误的 protobuf 字段 |

`32/43 = 74.42%` 只能作为排除已确认基础设施污染后的诊断值，不能替代官方
reward，也不是 TB 分数。`db-wal-recovery` 消耗约 `$0.190064`，占本 job
总成本约 53.6%，但没有产生模型通过结果；这是后续分析成本和能力边界时的重点。

### 本轮经验

- 仅检查 Harbor 根 `result.json` 不足以区分模型失败和 verifier 启动失败；上游
  `test.sh` 即使下载依赖失败也可能写入 reward 0。
- job reader 现在只对已观察到的 verifier `uv` 下载超时、`astral.sh` 连接失败和
  `uvx` 缺失签名附加 `VerifierInfrastructureError`。原始 JSON 和证据哈希不改写，
  普通 reward 0 仍按模型失败处理。
- r3 的 2 个 infrastructure invalid 使有效率低于 98%，校准器必须拒绝该 job；
  不能通过手工删除失败 trial、改 reward 或计算“修正版官方成绩”绕过。
- 下一步应先解决 verifier 每个容器重复下载 `uv`、Python 和数据依赖导致的超时，
  再重跑一轮可通过审计的 baseline 1。三轮有效 baseline 和一轮有效 candidate
  全部完成前，`TB = N/A`。

### Candidate r1 原始结果

| 指标 | 结果 |
| --- | ---: |
| Harbor 原始 reward | 30/45，均值 `0.6667` |
| 追加审计后状态 | 30 passed、10 failed、5 invalid |
| 有效率 | 40/45，`88.89%`，低于 `98%` 硬门槛 |
| 诊断通过率 | 30/40，`75.00%`，不能替代官方 reward |
| 异常 | 原始 3 个 `VerifierTimeoutError`；另识别 3 个证据泄漏，二者有 1 个 trial 重叠 |
| 重试 | 1 次 candidate 安装网络错误，Harbor 自动重试后成功 |
| 总运行时间 | 3 小时 21 分 30 秒 |
| Agent 时延 | p50 `83.2s`、p95 `558.4s`、p99 `900.0s` |
| Token | input `39,015,445`、cache read `38,133,632`、output `514,859` |
| 模型成本 | `$0.374389` |
| 凭据审计 | 457 个证据文件中 2 个可用 API Key 精确值命中 0 次 |
| 资源清理 | Harbor trial 容器残留 0 个 |

| 任务 | 原始通过 | 审计结论 |
| --- | ---: | --- |
| `fix-git` | 5/5 | 稳定通过 |
| `build-cython-ext` | 0/5 | 4 次普通失败，1 次 Agent 超时；仍是最明显的能力短板 |
| `cancel-async-tasks` | 5/5 | 稳定通过 |
| `fix-code-vulnerability` | 5/5 | 稳定通过 |
| `nginx-request-logging` | 5/5 | 稳定通过 |
| `db-wal-recovery` | 0/5 | 3 次访问 benchmark 资料而 invalid，其中 1 次还发生 verifier 超时；其余 2 个有效样本未正确恢复 |
| `multi-source-data-merger` | 3/5 | 3 个有效样本全部通过，另 2 次 verifier 下载数据依赖超时 |
| `large-scale-text-editing` | 4/5 | 1 次输出未满足 verifier |
| `kv-store-grpc` | 3/5 | 2 次服务实现未满足 verifier |

同一模型的探索性 baseline 诊断通过率为 32/43（`74.42%`），candidate 追加审计
后为 30/40（`75.00%`）。0.58 个百分点的差值没有比较意义：candidate 有证据
污染、两轮都未通过有效率门槛，且 candidate 只有一轮。原始通过数、成本和时延
仍可作为工程记录，但不能证明 Bumblebee 相对 baseline 的稳定收益或回归。

本次真实导入还暴露了两个 Windows 兼容问题：Harbor 的 namespaced task ID
不能直接作为 Benchmark 0 文件路径，微秒和本地时间戳也不满足核心 UTC 契约。
Importer 现在只对证据路径使用短哈希 ID、在 metadata 保留原始任务名，并在 Harbor
边界把时间统一为规范 UTC；45 个 task result 已全部写入并可枚举。

### Candidate 授权边界

Terminal-Bench 的每个任务都在一次性 Docker 容器中运行，并且必须修改文件或执行
命令。Bumblebee 生产扩展在 `context.hasUI = false` 时按设计拒绝需要确认的操作；
第一次 candidate smoke 因而无法执行 `bash/write/edit`，`fix-git` 得分为 0。

正式 candidate 改为加载同一冻结 commit 中的
`benchmark/benchmark_2_terminal_bench_2_1/candidate-extension.ts`。该 wrapper
调用生产 `registerBumblebeeExtension()`，仅注入固定返回 `allow_once` 的
`PermissionAuthority`。策略写入 manifest，并由测试固定；wrapper 不在 npm
发布文件中，生产默认扩展没有环境变量开关，headless 模式仍然 fail-closed。

因此 candidate 衡量的是“用户已逐次授权后 Bumblebee 的端到端任务价值”，不是
默认拒绝策略的安全分。权限位、路径范围、持久化和无 UI 拒绝行为继续由
BumblebeeBench 的独立场景衡量，不能用本分项替代。

## 环境准备

真实运行额外需要 Python 3.12、Docker 或 Harbor 支持的云沙箱、`uv` 和相应模型
凭据。不要把这些依赖安装到 Bumblebee 的生产 npm 依赖中。

```powershell
# 在 Bumblebee 仓库根目录执行
uv venv benchmark\benchmark_2_terminal_bench_2_1\.venv --python 3.12
uv pip install `
  --python benchmark\benchmark_2_terminal_bench_2_1\.venv\Scripts\python.exe `
  -r benchmark\benchmark_2_terminal_bench_2_1\requirements.txt
```

激活虚拟环境，然后从 Bumblebee 仓库根目录检查
`python -m harbor.cli.main --version` 和 `docker version`。必须使用
`python -m harbor.cli.main`，这样仓库根目录会进入 Python 模块搜索路径，
Harbor 才能加载仓库内的自定义 Pi adapter。模型供应商凭据沿用 Harbor/Pi
官方环境变量，不写入 manifest、命令参数或仓库文件。

Windows PowerShell 运行 Harbor 前应固定 Python 控制台编码，避免完整结果已经
落盘后，Rich 汇总表因系统 GBK 无法显示 Unicode 字符而返回非零退出码：

```powershell
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
```

Benchmark adapter 固定使用 NVM `v0.40.2`、Node `22.20.0` 和
`https://npmmirror.com/mirrors/node` 下载镜像。Pi 0.78.1 要求
Node `>=22.19.0`；固定版本避免每个 trial 解析到不同的 Node 补丁版本，镜像则
避免受限网络下直连 `nodejs.org` 长时间挂起。

若本机无法直连 Docker Hub，可以先从可用镜像源缓存 `ubuntu:24.04`，再给打印出的
Harbor 命令追加 `--force-build`，由每个任务自带的 Dockerfile 本地构建。2026-07-24
已使用无模型 `nop` agent 验证本机 Docker 构建、容器启动、verifier 和自动清理链路。

## 1. 运行定向保障集

```powershell
npm run benchmark:2 -- assurance dev
npm run benchmark:2 -- assurance holdout
```

两组各 4 个任务，覆盖未解决强测试、外部契约、恢复证据和输出格式。它们不调用模型，
也不包含 Cython、WAL、gRPC 或 Vim 的解题答案。修改保障策略时先看 dev，定稿后再看
holdout，避免围绕全部公开断言调参。

## 2. 无模型基础设施预检

```powershell
npm run benchmark:2 -- preflight docker 4 tb21-verifier-preflight
# 审阅打印出的 python 命令后执行，再审计 job：
npm run benchmark:2 -- audit-preflight jobs\tb21-verifier-preflight
```

预检固定执行 9 个任务、每任务 1 次、并发 4，不传模型也不运行 Agent 推理。setup
会先确认 Docker 任务镜像可启动，再检查 apt、GitHub、Node/npm registry、astral、
Python/PyPI，并只预热当前任务
上游 `test.sh` 已声明的精确 verifier 依赖；之后仍由原始 verifier 运行并写 reward。
reward 可以是 0，因为预检不解题；验收关注 9/9 都产生 verifier 结果且没有
adapter/dataset/infrastructure 异常。

2026-07-25 的 r7 在 15 分 59 秒内完成 9/9，模型成本为 0；独立
`audit-preflight` 输出 `passed`、coverage 9/9、verifier results 9/9。Harbor
汇总展示随后触发的 Windows GBK 编码错误不改变已落盘结果，审计器会读取原始
result 和各 trial 目录后再给出结论。

正式 Pi adapter 使用同一预热逻辑。即使 verifier 随后的重复下载瞬时失败，已有
`uv`、Python 3.13 和包缓存仍可供原始脚本继续执行；任务文件、测试文件和 reward
语义均不修改。

预热先检测 curl、git 和 CA 证书，仅在存在缺失项时刷新 apt 索引；Debian/Ubuntu
软件源映射到当前评测环境已验证可达的阿里云镜像，并强制 IPv4、限制单请求时长和
重试次数。curl 的全部重试共享 180 秒总窗口，uv 的网络请求和预热命令也分别具有
读取、重试和 600 秒命令级上限。该配置只作用于一次性评测容器，不进入
Bumblebee 运行时。

uv 管理的 Python 3.13 产物通过 `UV_PYTHON_INSTALL_MIRROR` 使用评测环境已验证
可达的 HTTPS GitHub 代理，下载路径和 uv 内置版本元数据保持不变。uv 的
`operation timed out`、`Request failed after N retries` 等 setup 错误会归类为
`NetworkConnectionError`，只按 manifest 固定的最多 2 次策略重试，不能无限重跑。
`tb21-python-mirror-preflight-20260725` 已对上一轮实际失败的
`large-scale-text-editing` 做 1 次无模型复验：1/1 verifier 结果、0 异常，
总耗时 2 分 8 秒。

### 候选隔离与污染审计

定向 r2 在 49 分 47 秒内完成 20/20，原始 reward 为 14/20，模型成本
`$0.277662`，但不能据此判断 P0/P1 改进有效。审计发现 3 个 WAL trial 访问了候选
checkout 中的 benchmark README、复盘、测试或 manifest；导入器将这类样本标记为
`BenchmarkEvidenceLeakError`，保留原始 reward、日志和哈希，但排除出能力统计。
r2 因证据污染和仅覆盖 4/9 任务而 invalid，`TB = N/A`。

候选安装现改为两阶段：完整 Git checkout 只在 setup 中短暂存在；`npm pack` 提取
生产发布白名单后，仅复制 benchmark wrapper，删除根 README 与临时 checkout，再
调用模型。`tb21-candidate-isolation-preflight-20260725` 已在真实 Docker 容器中
以 1/1、0 异常、约 2 分钟通过，确认生产入口和 wrapper 存在，而 `.git`、根
README、benchmark 专用资料及源码 checkout 均不存在。干净 r3 已重新运行同一
4 类失败任务；污染 r2 不与新结果拼接。

### 干净定向 r3 结果

`tb21-targeted-bumblebee-20260725-r3` 固定 commit
`f4057b7d8abc818aa8759d0d3289be399f3d7c10`，沿用 Harbor `0.20.0`、Pi
`0.78.1`、`deepseek/deepseek-v4-flash`、thinking `high`、full profile、Docker、
并发 4 和每任务 5 次。运行 40 分 3 秒，原始 reward 16/20，20 个样本全部有效；
导入后 OfficialReward 80.00、Stability 95.00。

| 任务 | 通过 | 成本 | 平均 Agent 时延 |
| --- | ---: | ---: | ---: |
| `build-cython-ext` | 4/5 | `$0.086862` | 438.4s |
| `db-wal-recovery` | 2/5 | `$0.132015` | 496.0s |
| `large-scale-text-editing` | 5/5 | `$0.046622` | 304.1s |
| `kv-store-grpc` | 5/5 | `$0.008854` | 72.8s |

| 指标 | 结果 |
| --- | ---: |
| Token | input `28,118,597`、cache read `27,535,872`、output `413,107` |
| 模型成本 | `$0.274352` |
| Agent 时延 | p50 `312.3s`、p95 `666.4s`、p99 `853.3s` |
| 异常与重试 | 1 个 WAL `AgentTimeoutError`，0 次重试 |
| 只读 critic | 21 次完成、0 失败，成本 `$0.119431`；发现一次重复调用并增加会话级幂等门 |
| 证据审计 | 20 个 agent 日志中 benchmark 专用资料命中 0 |
| 凭据审计 | 185 个文本证据文件中 API Key 精确值命中 0 |
| 资源清理 | Harbor trial 容器残留 0 |

与首轮 candidate 在这四类任务上的原始 7/20 相比，r3 为 16/20；该差值说明通用
改进值得继续验证，但单轮、不同协议结果不能证明稳定因果收益。Cython 的失败样本
仍遗漏一个未覆盖的原生源码兼容点；两个普通 WAL 失败没有正确应用日志更新，另一个
在生成产物前达到 Agent 时限。

r3 还暴露了恢复保护的动态发现缺口：用户只给目录时，原实现没有从首次只读列表
结果登记数据库与 WAL，导致一个样本在备份前由应用读取器打开原件。修复后，恢复
模式先于文件名生效，从成功工具输出登记证据，逐项匹配复制和 SHA-256，并阻止
同名前缀冒充与 `copy && delete` 组合绕过。下一轮只复验仍失败的 Cython 和 WAL，
不重跑已经 5/5 的大文本与 gRPC。

### 二次定向 r4 结果

`tb21-targeted-bumblebee-20260725-r4` 固定 commit
`ec372aee5e871f74b1d0bcdfe8ce0c067f1c6e60`，只运行 r3 仍失败的 Cython 与
WAL，每任务 5 次、并发 4。运行 19 分 27 秒，原始 reward 8/10，10 个样本全部
有效，0 异常、0 重试。

| 任务 | 通过 | 成本 | 平均 Agent 时延 |
| --- | ---: | ---: | ---: |
| `build-cython-ext` | 3/5 | `$0.089861` | 449.2s |
| `db-wal-recovery` | 5/5 | `$0.030692` | 148.1s |

| 指标 | 结果 |
| --- | ---: |
| Token | input `13,713,430`、cache read `13,410,560`、output `145,007` |
| 模型成本 | `$0.120553` |
| Agent 时延 | p50 `306.6s`、p95 `496.7s`、p99 `528.9s`、max `537.0s` |
| 导入诊断 | OfficialReward `80.00`、Stability `100.00` |
| 证据审计 | 10 个 agent 日志中 benchmark 专用资料命中 0 |
| 凭据审计 | 104 个文本证据文件中 API Key 精确值命中 0 |
| 资源清理 | Harbor trial 容器残留 0 |

r4 只覆盖冻结任务的 2/9，且没有完整效率预算，因此资格为 invalid、`TB = N/A`；
它不能和 r3 或 baseline 拼接。WAL 从 r3 的 2/5 变为 5/5，但不同随机样本的单轮
差值仍不能证明稳定因果收益。

两个 Cython 失败轨迹都把兼容性搜索限制在已知脚本/Cython 扩展名，通用提示没有
形成可验证的完成门槛。后续修复不编码 NumPy 或具体文件答案，而是在提示同时具有
兼容迁移和仓库源码语义时，要求修改后至少成功完成一次不按已编辑扩展名收窄的
递归扫描；否则最多触发一次补充轮次。下一轮只复验 Cython，不再重跑已通过任务。

Harbor 的环境构建/启动和 Agent setup 是两个独立阶段，命令计划分别设置
`--environment-build-timeout-multiplier 3` 与
`--agent-setup-timeout-multiplier 3`。若 Docker registry 不稳定，应先从可用
备用源缓存上游 `task.toml` 声明的镜像，或用同一冻结任务目录的 Dockerfile 本地
构建并标记为相同 tag；不能把拉取耗时混入模型 trial。

## 3. 生成模型运行命令

`plan` 只打印命令，不运行 Harbor；打印结果以
`python -m harbor.cli.main run` 开头。Windows 上 npm 10.9.3 会剥掉部分
`--name` 参数，因此 README 使用稳定的 positional 形式。

```powershell
# 三轮 baseline 分别使用不同 job 名称
npm run benchmark:2 -- plan baseline openai/<model> docker 1 tb21-pi-1 - high
npm run benchmark:2 -- plan baseline openai/<model> docker 1 tb21-pi-2 - high
npm run benchmark:2 -- plan baseline openai/<model> docker 1 tb21-pi-3 - high

# candidate 必须引用已经推送、容器可访问的精确 commit
$commit = git rev-parse HEAD
$extension = "git:github.com/ReadNULL/Bumblebee@$commit"
npm run benchmark:2 -- plan candidate openai/<model> docker 1 tb21-full $extension high

# 只复验首轮存在能力失败的任务；逗号列表必须来自冻结 manifest
$failed = "terminal-bench/build-cython-ext,terminal-bench/db-wal-recovery,terminal-bench/large-scale-text-editing,terminal-bench/kv-store-grpc"
npm run benchmark:2 -- plan candidate deepseek/deepseek-v4-flash docker 4 tb21-targeted $extension high $failed 5 full
```

检查打印出的命令后再手工执行。生成的命令固定包含 9 个任务过滤器和 `-k 5`，
同时用 `--agent-setup-timeout-multiplier 3` 将容器内 Pi 冷安装时限从默认 6 分钟
放宽到 18 分钟。所以每个 job 为 45 个 trial；三轮 baseline 加一轮 candidate
共 180 个 trial。Harbor 在 job 启动后不能热调并发；本轮并发 2 的主要瓶颈是
容器内 `npm ci`、`uv` 和 verifier 依赖下载。下一轮先用并发 4 跑每任务 1 次的
9-trial 预检，只有基础设施有效率达标后，才把四个正式 job 的并发 profile 一并
冻结为 4。

adapter 会解析 Pi JSONL 的最终 API 状态。Pi 内部重试耗尽后的 503、429、500、
网络错误等会转换为 Harbor 异常，并由计划中固定的 `--max-retries 2` 重新执行
该 trial；只允许瞬态 API/网络异常进入重试。Agent timeout、认证、配额、模型拒绝
和 verifier 给出的真实 reward 0 均不重试，避免用重复采样粉饰能力失败。

定向 job 只用于复验失败族并保留原始 trial 证据，不完整覆盖 9 个任务，因此不能发布
TB-Lite 总分。导入失败 job 时还会按任务、失败类别和错误码生成 `proposed` lesson，
写入 run artifact 与 Benchmark 0 追加式 lesson history；人工复核和独立复验前不会
自动升级为 accepted。

## 4. 冻结 baseline 预算

三轮 baseline 全部完成后，将三个 Harbor job 目录交给校准器：

```powershell
npm run benchmark:2 -- calibrate `
  jobs\tb21-pi-1 `
  jobs\tb21-pi-2 `
  jobs\tb21-pi-3 `
  benchmark\benchmark_2_terminal_bench_2_1\.runtime\baselines\pi-baseline-lite-v1.json
```

校准器要求三个不同 job 均完整覆盖同一数据集、同一 Pi 版本和同一模型。candidate
也必须使用该模型；提供其他数据集、Pi 或模型生成的预算会判为 `invalid`。它按任务
汇总所有有效 trial，分别取成本和 Agent 执行时长的中位数。缺失成本、任务哈希
冲突、任务数不足或样本不足都会拒绝生成预算，不能用手填默认值绕过。

## 5. 导入 candidate

```powershell
npm run benchmark:2 -- import `
  jobs\tb21-full `
  benchmark\benchmark_2_terminal_bench_2_1\.runtime\baselines\pi-baseline-lite-v1.json `
  benchmark\benchmark_2_terminal_bench_2_1\.runtime\evaluation
```

也可以把第二个参数写成 `-`，先导入尚未校准的 job。此时官方 reward、稳定性和
所有 trial 仍会保存，但 `efficiency_budget_coverage = 0`，结果明确为
`not-qualified` 且 `TB score = N/A`。

## 评分与失败语义

```text
TB = 0.80 * OfficialReward
   + 0.10 * CostEfficiency
   + 0.05 * LatencyEfficiency
   + 0.05 * Stability
```

- `OfficialReward`：所有有效 trial 的官方 `reward` 均值；
- `CostEfficiency`：成功 trial 使用
  `min(1, baselineCost / actualCost)`，失败 trial 为 0；
- `LatencyEfficiency`：成功 trial 使用
  `min(1, baselineAgentTime / actualAgentTime)`，失败 trial 为 0；
- `Stability`：没有 Harbor/Agent 异常的 trial 比例。

Agent 非零退出、上下文超限等在 verifier 仍提供 reward 时属于可计分失败，不能
通过标记为基础设施问题逃避扣分。API 限流、网络、认证、Docker、verifier 和
reward 文件错误会分类为 `infrastructure`、`adapter` 或 `dataset`；有效 trial
比例或 reward/成本/时延覆盖率低于 98% 时整轮结果为 `invalid`。预算缺失属于
`not-qualified`，不是数据损坏。

Harbor 进程异常中断后，也可以在确认它不再写入 job 目录时执行 `import`。导入器
会保留已完成的子 trial，并用 `updated_at` 记录结束边界；任务未完成会触发
`job_completion` 硬门槛，因此结果为 `invalid`，但证据不会丢失。不要在仍运行的
Harbor job 上导入，否则根文件与子目录可能不是同一时刻的快照。

## 证据与隐私

完整指令、轨迹、容器日志和 verifier 文件继续保留在 Harbor job 目录。导入器
不会把它们复制进 Git，只在 Benchmark 0 artifact 中保存：

- Harbor job ID、解析后的数据集 reference 和任务哈希；
- `config.json`、根 `result.json` 和聚合 trial 结果的 SHA-256；
- 每个 trial 的 reward、状态、时长、token、成本及脱敏异常分类；
- 硬门槛、四项分数和最终 qualification。

`.runtime/` 已被 Git 忽略。公开结果前应另外审阅 Harbor 轨迹，并始终标注为
`Terminal-Bench 2.1 Lite (Bumblebee fixed subset)`。官方排行榜要求完整任务集，
不得上传或展示本子集为官方 Terminal-Bench 2.1 成绩。

## 开发验证

```powershell
npm run typecheck
npm test -- benchmark/benchmark_2_terminal_bench_2_1/test
npm run benchmark:2
```

最后一个命令只显示帮助。确定性测试、Python adapter 测试和 Task Assurance
`dev/holdout` 均应先通过；首轮真实 baseline 和 candidate 因上述 verifier
基础设施污染被判为无效，不能作为正式 Terminal-Bench Lite 成绩。

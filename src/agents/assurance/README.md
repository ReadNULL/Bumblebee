# Task Assurance

Task Assurance 解决五类真实评测中反复出现的问题：遗漏外部契约、较弱 smoke test
覆盖较强失败、仓库级兼容迁移漏扫源文件、恢复前破坏原始证据，以及产物格式漏检。

它在每轮开始时提取有限的显式契约，在工具执行期间维护验证证据账本，并在 Agent
准备结束但证据仍不足时最多触发一次补充轮次。它不会针对 Cython、SQLite、gRPC 或
编辑器题目提供答案。

## 事件流程

```mermaid
flowchart LR
  Prompt["before_agent_start"] --> Contract["提取字段、路径、格式和字面量契约"]
  Contract --> Calls["tool_call"]
  Calls --> Guard["恢复证据保护"]
  Calls --> Ledger["记录修改、验证层级与兼容扫描范围"]
  Results["tool_result"] --> Ledger
  Ledger --> End["agent_end"]
  End --> Review{"证据完整？"}
  Review -- 否 --> FollowUp["最多一次补充验证 + 只读 critic"]
  Review -- 是 --> Done["允许自然结束"]
```

仓库测试、用户指定命令和构建检查属于强验证。失败项按“验证族 + 规范化完整命令”
记录，只有同一范围的命令成功重跑才能清除；手工 smoke test 或更窄的测试不能覆盖
较强失败。复杂外部契约或恢复任务需要一次带
`[BUMBLEBEE_ASSURANCE_CRITIC]` 标记的只读 `delegate_task`，其 token 和成本继续
保存在原有 Sub-Agent tool result 中。成功 critic 在会话内幂等，第二次同标记调用
会被拒绝；执行失败不会占用该额度。

当提示同时具有“兼容/迁移/弃用/升级”和“仓库/源码/构建/扩展”等语义时，状态机
进入仓库级兼容模式。发生修改后，至少要有一次成功的递归扫描，且该扫描不能只通过
`--include`、`--glob` 或 `--type` 限定为已经编辑过的文件类型；否则结束审阅会
触发一次补充轮次。这样可以发现原生源码、生成源码和构建输入中的同类兼容风险，
同时不编码任何特定依赖或 benchmark 的答案。

恢复保护只在提示明确包含恢复/取证语义和数据库、WAL、镜像或二进制证据路径时
启用。若提示只给目录而未给文件名，成功的只读列表/元数据工具输出会动态登记其中的
数据库、WAL、镜像、dump 和二进制文件。原件必须先通过成功的工具调用完成逐项复制
和 SHA-256 记录，之后才允许 SQLite、脚本、移动、删除或写入类操作；同名前缀文件
不会互相冒充，`copy && delete` 复合命令也不属于纯保护操作。证据不足时要求报告
不确定性，禁止编造恢复值。

该模块是进程内证据管理，不是形式化证明。只读 critic 由 `delegate_task` 的工具
白名单保证只能使用 `read/grep/find/ls`，运行次数和 `costUsd` 进入证据快照。最多
一次补充轮次避免无限自检；第二轮仍失败时，模型必须如实报告未解决项。

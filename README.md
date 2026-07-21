# Bumblebee

Bumblebee V2 正在基于 pi Extension 机制从零重建。项目采用逐积木开发方式：每个组件都必须先明确契约、通过聚焦测试并完成人工验收，才能开始下一个组件。

## 积木搭建计划

| 轮次 | 积木 | 解决的问题 |
| --- | --- | --- |
| 1 | 错误模型 | 统一错误代码、cause 保留和安全序列化 |
| 2 | 结构化日志 | 日志字段、敏感信息脱敏和 traceId |
| 3 | 取消与超时 | AbortSignal 传播、超时区分和可中断等待 |
| 4 | 并发控制 | 公平 Semaphore、会话串行队列和等待取消 |
| 5 | 生命周期 | 初始化失败回滚、LIFO 清理和幂等 dispose |
| 6 | 基础层总复盘 | 组合演示、依赖方向和故障注入 |

## 当前范围

当前分支只包含第 0 轮最小项目骨架：

- pi 包清单；
- 空的 TypeScript 扩展入口；
- 严格的 TypeScript 配置；
- 一个与源码同目录的加载测试。

目前没有注册命令、工具或事件处理器，也没有 Agent、记忆、知识、工作流、渠道等运行时功能。

## 环境要求

- Node.js 22.19 或更高版本
- pi（`@earendil-works/pi-coding-agent`）

## 开发验证

```bash
npm install
npm run typecheck
npm test
```

开发期间可让 pi 直接加载空扩展：

```bash
pi -e ./src/extension.ts
```

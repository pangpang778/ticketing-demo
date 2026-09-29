---
name: launch
description: 工厂 launch 环——按已 accepted 的 spec 实现并自验，产出可跑的最小闭环。
---

# Launch 环

本环只做一件事：**把已 accepted 的 spec 实现成可跑的代码，并按 spec 的验收标准自证。**

## 1. 读交接

启动 prompt 里的「交接上下文」是 `.omc/handoffs/<sessionId>-<stage>.json`，先读它拿到上一环的 outcome 与下一环指令。

## 2. 读 spec（唯一事实来源）

`docs/intents/<intentId>/spec.md`。spec frontmatter 的 `status: accepted` 表示四项 owner 判断已拍板（第 10 节）：

- R1 T+1 口径 = `submittedAt + 24h` 时长口径
- R7 「证据不足」 = **未定结论**（不结单、时钟继续、索材只许一次）
- 存储 = JSON 单文件 `.ticketing/appeals.json`，原子写
- 实名 = `ticketing-demo` / CLI 入口 `ticketing`

**不要重开这些已决问题。** spec 正文是实现契约：数据模型字段、时限规则、CLI 表面、验收标准逐条落地。有实现层的疑问按 spec 的默认取值做，不要停下来问——只有遇到 spec 自身矛盾或必须推翻 owner 决策时才停。

## 3. 实现

按 spec 第 2–5 节建 CLI。硬约束（来自 spec「明确不做」）：无鉴权、无网络、无 UI、无常驻进程；存储层收口在单一 repository 模块（为后续换 SQLite 留接口）；派生字段在读路径上物化。

## 4. 自验

spec 第 9 节 1–8 条是验收标准，逐条跑通并留下可复现的证据（测试 + 命令输出）。不接受「看起来对」——每条都要有实际执行结果。

## 5. 交棒

写实现报告到 `.omc/handoffs/`（结论、验收对照表、遗留项），然后正常结束会话——SessionEnd 会自动把链推进到下一环。**不要手动启动下一环**，那是链的事。

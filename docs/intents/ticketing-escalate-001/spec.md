---
spec: ticketing-escalate-001
title: 申诉处理线上化 Spec（申诉实体 + 时限字段 + 超时自动 escalated + 三选一结论）
intent: ticketing-escalate-001
date: 2026-09-29
status: accepted
round: 1
gate: owner accepted 2026-09-29（4/4 项按 spec 默认拍板）
---

上游唯一流程来源：recon-diff-appeal-001 spec（accepted，#5 第 10 轮）。本文只定义**系统承载形态**（实体、时限、队列、结论录入），不重述、不修改上游判定口径。

## 1. 交付边界（最小闭环）

本 spec 交付且仅交付一条可跑通的闭环：

```
客服录申诉 → 客服查队列（含时限剩余） → 专员录三选一结论 → 超时自动 escalated → 组长队列可见 → 组长录最终结论 → 队列收敛
```

（「证据不足」为未定结论，录入后单子留在闭环内继续计时，不收敛——语义见第 2 节、风险 R7。）

对应上游三条痛点（intent 问题 1/2/3）逐条落位：

| 痛点 | 落位 | 本文小节 |
|------|------|----------|
| 1. 申诉队列无系统实体，收敛规则无法强制 | `Appeal` 实体 + `issue`/`queue` 子命令，双入口录入同一张表 | 2、5.1、5.2 |
| 2. escalated 标记与组长队列不可见，漏升级无告警 | `escalated` 标记为持久化字段，`queue --role leader` 查组长队列 | 3、4、5.2、5.3 |
| 3. T+1 / 组长 4 小时看不出起算点与剩余时间 | `firstDeadlineAt` / `currentDeadlineAt` 落库，队列列表显示剩余时间 | 3、5.2 |

最小闭环之外不做，见第 7 节。

## 2. 数据模型

单条申诉记录 `Appeal`：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | `APL-YYYYMMDD-NNNN`，按日自增 |
| `merchantId` | string | 是 | 商户 ID |
| `settlementNo` | string | 是 | 关联结算单号（判定基准，见上游 2.1） |
| `orderNo` | string | 是 | 关联订单号 |
| `type` | enum | 是 | `shipping` \| `refund` \| `other`（上游 1.1） |
| `submittedAt` | ISO8601 (UTC) | 是 | 商户提交时间，**第一时限起算点**（上游 1.1） |
| `source` | enum | 是 | `portal` \| `email`；双入口收敛到同一队列，仅留痕不分支（上游 1.1） |
| `status` | enum | 派生 | `pending` \| `escalated` \| `resolved` |
| `decision` | enum \| null | 否 | `upheld`（差异成立/补差）\| `rejected`（差异不成立）\| `insufficient_evidence`（证据不足） |
| `decisionBasis` | string | `rejected` 时必填 | 判定依据（上游 1.2 要求附依据回复商户） |
| `decidedBy` | string | 否 | 录入人标识，仅审计留痕，**不鉴权**（见 7 节不做权限） |
| `decidedAt` | ISO8601 (UTC) | 否 | 结论录入时间 |
| `escalatedAt` | ISO8601 (UTC) | 派生 | 超时自动打 escalated 标记的时刻 |
| `firstDeadlineAt` | ISO8601 (UTC) | 派生 | `submittedAt + 24h`，**一经生成永不重置**（上游 1.3） |
| `currentDeadlineAt` | ISO8601 (UTC) | 派生 | `pending` 时 = `firstDeadlineAt`；`escalated` 后 = `escalatedAt + 4h` |
| `evidenceRequestedAt` | ISO8601 (UTC) | 否 | 「证据不足」一次性索材的时刻，只允许写入一次（上游 1.2） |

**字段级约束：**

- `status` 与 `escalatedAt` 是**派生字段**，不随录入直接指定，由时限计算得出（见第 3 节）。人工不得绕过时限直接置 `escalated`。
- **物化优先级**（消除歧义，同时是 `sweep` 幂等的前提）：`decision ∈ {upheld, rejected}` → `resolved`；否则 `now >= firstDeadlineAt` → `escalated`；否则 `pending`。已 `resolved` 的记录永不再被物化为 `escalated`。
- `firstDeadlineAt` 不可变：任何录入（含「证据不足」索材）都不刷新它。索材不重置时限（上游 1.2 明文）。
- **结论可写性**：`upheld` / `rejected` 是**终局结论**，一经录入 `status` 置 `resolved` 且不可再改；改判走人工线下，另开工单，不在本版范围。`insufficient_evidence` 是**未定结论**（见下），不置 `resolved`，其后至多被一次终局结论取代。
- `decidedAt` / `decidedBy` 记**最后一次（终局）结论**；索材动作单独由 `evidenceRequestedAt` 留痕，两者不互相覆盖。
- 时间统一存 UTC ISO8601，展示时转本地时区，避免跨时区/夏令时歧义（风险 R4）。

**「证据不足」的语义（本 spec 的解读，需 owner 确认 → 风险 R7）：**

上游 1.2 原文：「证据不足（一次性向商户索取补充材料，**时限不因此重置**）」。本 spec 据此取**未定结论**读法：

- 录入 `insufficient_evidence` = 记一次索材（写 `evidenceRequestedAt`），**单子不结**，`status` 维持 `pending`（或已越限的 `escalated`）。
- 时限继续跑：单子照常在 `firstDeadlineAt` 越限升级、进组长队列——这正是「不重置」的可观察含义。
- 索材只允许一次：已有 `evidenceRequestedAt` 再录同一结论 → 拒。
- 商户补交材料后，录入 `upheld` / `rejected` 结单；此后不可改。
- 取此读法的理由：它让上游「时限不因此重置」与「一次性索材」两句都保有非空语义。若改取终局读法（录入即 `resolved`），这两句连同 `evidenceRequestedAt` 字段都退化为死逻辑（`resolved` 记录本就不许再录结论），故不取。代价是模型多一条「未定 → 终局」的单向路径，属上表已声明的结论可写性范畴，不扩 CLI 表面。

## 3. 时限与升级规则（落自上游第 3 节，不改口径）

| 节点 | 起算点 | 时限 | 超时动作 |
|------|--------|------|----------|
| 运营专员出结论 | `submittedAt`（商户提交） | T+1 = +24h | 打 `escalated` 标记，入组长队列；`firstDeadlineAt` 不重置 |
| 组长出最终结论 | `escalatedAt`（收到升级） | +4h | 首版无二级升级：`escalated` 持续在组长队列可见即兜底（上游 4.B 已定级） |

**T+1 取值口径（本 spec 的解读，需 owner 确认 → 风险 R1）：** 上游写「T+1（自商户提交时起算）」。本 spec 实现为**提交时刻 + 24 小时**（时长口径），而非「次日 24:00」（自然日口径）。理由：上游两处均显式「自提交时起算 / 提交时起算」，以提交时刻为锚点更贴合原意；自然日口径会让一个 23:59 提交的申诉只剩 1 分钟。**若 owner 判定应为自然日口径，改动面为 `firstDeadlineAt` 一处计算，模型不变。**

**「自动」如何在无守护进程的本地 CLI 中成立（本 spec 的关键设计决策）：**

- 状态是**时间戳的纯函数**：`status`/`escalatedAt` 由 `submittedAt`、当前时间、已录入的 `decide` 共同决定（优先级见第 2 节），任何时刻求值结果一致。
- CLI 在**每次读操作前物化（materialize）** 一次派生字段并落盘；`escalate sweep` 显式执行同一次物化，供定时任务调用。
- 因此「漏升级无告警」被消除：漏的不是判定，而是没人打开 CLI。物化在读路径上，客服查队列时必然已把过期单打上 escalated。
- 不做后台常驻进程/守护任务（超出最小闭环，见第 7 节）。物化的副作用是：`escalatedAt` 的落库时刻 = 首次物化时刻，晚于真实越限时刻。真实越限时刻可由 `firstDeadlineAt` 反推，故不影响时限正确性。

## 4. 存储形态（未决问题落位）

**决策：本地 JSON 单文件，不用 SQLite。**

| 维度 | JSON 文件（选定） | SQLite（未选） |
|------|------------------|----------------|
| 依赖 | 零原生依赖，`node:fs` 即可 | `better-sqlite3` 需 node-gyp 本地编译，Windows 交叉环境易失败 |
| 可读/可 diff | 人可读，git diff 友好 | 二进制，diff 无意义 |
| 并发 | 单写者足够；并发写需外部锁 | 天然并发安全 |
| 规模 | 万级记录内查询无压力 | 大规模分页/索引更优 |

- 路径：`.ticketing/appeals.json`，加入 `.gitignore`（交付前置动作）。
- 写策略：**原子写**（写临时文件 → rename），避免进程中断留半截文件。
- 读取时全量载入内存；首版预期数据量（单商户申诉量级）远低于需要索引的门槛。

**残留风险 R2（高）：** JSON 单文件在多进程并发写、或记录量增长到需要索引时是错误选择。本版以「本地单人 CLI、无并发、量级可控」为前提成立；若后续出现多人共用同一目录或数据量超预期，迁移 SQLite 应作为独立变更处理，届时需重写存储层（存储层收口在单一 repository 模块内，接口不变）。

## 5. CLI 表面

形态：本地 CLI（Node/TS），入口 `bin/ticketing`，无 Web/UI。角色由子命令区分，不做登录与鉴权。

### 5.1 `issue` — 受理（客服）

```
ticketing issue --merchant <id> --settlement <no> --order <no> \
                --type shipping|refund|other --source portal|email [--submitted <ISO>]
```

- 录完即入队，返回 `id` 与两个时限（`firstDeadlineAt`、剩余时间）。
- `--submitted` 缺省取当前时间；显式传入用于补录历史单（此时若已越限，命令返回时该单已被物化为 `escalated`）。
- 必填校验：merchant/settlement/order/type 缺一即报错退出（不写盘）。

### 5.2 `queue` — 查询（客服 / 组长）

```
ticketing queue [--role cs|leader] [--status pending|escalated|resolved|all] [--merchant <id>]
```

- `--role cs`（默认）：客服视图——全部未结单（含「证据不足」待补料单，此类单额外显示 `evidenceRequestedAt`），显示 `id`/商户/结算单/类型/**起算点 `submittedAt`**/**`firstDeadlineAt` 与剩余时间**/当前时限/状态。
- `--role leader`：组长队列——仅 `escalated` 未结单，显示 `escalatedAt`、组长 4 小时时限与剩余时间。这是「组长队列」的实体承载。
- 三种时限字段在列表中必须直接可见（痛点 3 的验收点）。
- 查询前执行一次物化（第 3 节）。

### 5.3 `escalate` — 物化 / 显式升级（组长）

```
ticketing escalate sweep                 # 物化全部逾期单（幂等，可挂定时任务）
ticketing escalate list                  # 等价 queue --role leader，保留为显式入口
```

- `sweep` 幂等：重复执行不产生重复标记，`escalatedAt` 只写一次。

### 5.4 `decide` — 结论录入（运营专员 / 组长）

```
ticketing decide <id> --outcome upheld|rejected|insufficient_evidence \
                  --actor <name> [--basis <text>]
```

- `rejected` 缺 `--basis` → 报错拒绝（上游 1.2 要求附依据回复商户）。
- `insufficient_evidence`：**索材只允许一次**。该单已存在 `evidenceRequestedAt` 时再次录入该结论 → 报错拒绝（上游「一次性向商户索取补充材料」）。录入后单子**不结**（`status` 不置 `resolved`），且**不重置**任何时限——已越限的照常留在组长队列，未越限的照常在 T+1 升级。补料到齐后再录 `upheld` / `rejected` 结单（语义见第 2 节「证据不足的语义」，风险 R7）。
- 终局结论 `upheld` / `rejected` 录入后单子即 `resolved`，并保留 `escalatedAt` 痕迹（升级已发生，不因补录结论而抹除）。`resolved` 记录再次 `decide` 一律拒绝（含再次录 `insufficient_evidence`）。
- 逾期单仍可录入结论：不做「逾期即锁死」限制，专员/组长要能救火补录。
- 录入时若未指定 `--actor`，报错拒绝（结论必须有责任人留痕）。

## 6. 未决问题落位（intent 遗留，逐条给结论）

| 未决问题 | 本 spec 结论 | 状态 |
|----------|--------------|------|
| 仓库实名（intake 后定） | 研发期唯一标识 = `ticketing-demo`（pangpang778 下独立仓库，本地已 scaffold）。CLI 入口名 `ticketing`、包名 `ticketing-demo`、数据目录 `.ticketing/` 均据此命名。**对商户/客服展示的正式中文系统名仍未落定**（上游 spec 1.1 亦标「正式名称待确认」），不影响研发，仅影响后续文案与对外文档。 | 已落位（残留：对外正式名待 owner 拍板，风险 R3） |
| 存储形态 JSON vs SQLite | **本地 JSON 单文件**（第 4 节），零原生依赖、跨平台可编译风险低；原子写 + 单写者约束承接其并发短板。 | 已决策 |

## 7. 明确不做

- 权限/多租户/鉴权：`--actor` 仅审计留痕，不校验身份。
- 邮件集成：email 入口由客服人工转录为 `issue` 命令，邮件到工单的自动化不在本版。
- 任何 UI / Web / 常驻服务进程。
- **判定口径的代码化**：上游第 2 节（一切以结算单为准、运费计入、跨月按原订单归属月）是**成文口径**，本系统不实现结算单比对、不自动计算补差金额——系统只承载「按该口径录入结论」这一动作，口径全文以文档形式随包分发并在 `decide --help` 引用。避免把流程文档误做成半个对账引擎。
- 二级升级（上游 4.B 已定级为首版不做）。
- 改判 / 结论修改历史留痕：终局结论一经录入不可改（`insufficient_evidence` → 终局结论的单向取代除外，见第 2 节）；本版不留结论变更历史。

## 8. 高风险项

| 编号 | 风险 | 影响 | 处置 |
|------|------|------|------|
| **R1（高）** | T+1 口径未定：+24h（时长）vs 次日 24:00（自然日） | 每一个 `firstDeadlineAt` 都算错，升级判定整体偏移；自然日口径下深夜提交的申诉会立即逾期 | 本 spec 默认 +24h（第 3 节），请 owner 在评审时明确拍板。若改自然日，改动仅一处计算函数，模型/表结构不变 |
| **R2（高）** | JSON 单文件的并发与规模上限 | 多人共用同一数据目录即丢写；量级上来后查询变慢 | 已选型并给出前提（本地单人、量级可控）+ 迁移路径（第 4 节）。存储层须收口在单一 repository 模块，为后续换 SQLite 留接口 |
| **R3（中）** | 对外正式系统名未落定 | 展示名、包名、对外文档口径可能返工 | 研发期统一用 `ticketing-demo` / `ticketing`，改名的成本面被限制在文案层 |
| **R4（中）** | 时区与夏令时 | 跨时区运营或跨 DST 时，4 小时/T+1 的实际间隔可能偏差一小时 | 时间统一存 UTC ISO8601，显示转本地；4 小时用绝对时长加法，不涉夏令时跳变 |
| **R5（中）** | 「自动升级」无守护进程，落库时刻晚于真实越限时刻 | `escalatedAt` 不等于真实越限时刻，事后审计可能被质疑 | 真实越限时刻由 `firstDeadlineAt` 精确反推（第 3 节），已在模型中保留可审计性；如需精确落库须引入常驻进程，已列入不做清单 |
| **R6（低）** | 「证据不足一次性」依赖 `evidenceRequestedAt` 单值判断 | 若未来允许多次索材，需改模型 | 首版口径即单次，模型与上游一致，无需前瞻 |
| **R7（高）** | 「证据不足」是**未定结论**（单子不结、时钟继续）还是**终局结论**（录入即结），上游 1.2 未明写 | 若应为终局，则模型多出一条「未定 → 终局」路径、`queue` 里会长期滞留待补料单；若应为未定而实现成终局，则商户补料无载体、时限不重置成空话 | 本 spec 默认**未定**（第 2 节给出理由）。改取终局读法的改动面很小：`decide` 写入后即置 `resolved`、删掉「第二次录入被拒」分支、验收第 5 条相应简化；模型其余部分与 CLI 表面不变。请 owner 评审时明确拍板 |

## 9. 验收标准（最小闭环可跑通）

1. `issue` 录入一条申诉，返回 `id`、`firstDeadlineAt` 与剩余时间；记录落盘可读。
2. `queue` 能看到该单的起算点与剩余时间，客服与组长视图口径不同（客服见全部未结，组长只见 escalated）。
3. 补录一条 `--submitted` 已越限 24h 以上的申诉（**走公开 CLI 路径，不手改数据文件**）后执行 `queue` / `escalate sweep`，该单被自动打上 `escalated` 标记，且其 `firstDeadlineAt` 仍等于 `submittedAt + 24h`、未被改动。
4. 该单出现在 `queue --role leader` 中，并显示 `escalatedAt` 与 4 小时剩余时间。
5. `decide` 行为逐条可测：
   - 录 `upheld` / `rejected` 成功结单；`rejected` 缺 `--basis` 被拒。
   - 录 `insufficient_evidence` 成功入库，`evidenceRequestedAt` 被写入，该单**不结**（`status` 仍为 `pending` 或 `escalated`，未从任一组未结队列消失），且已越限的仍在组长队列内（时限未重置）。
   - 对同一单第二次录 `insufficient_evidence` 被拒。
   - 随后录 `upheld` 可正常结单；`resolved` 单再 `decide`（任意 outcome）被拒。
6. 终局结论录入后 `status` 为 `resolved`，该单从两组未结队列中消失；`escalatedAt` 痕迹保留。
7. `escalate sweep` 重复执行两次不产生重复标记，`escalatedAt` 只有一个值。
8. 全程无鉴权、无网络、无 UI、无常驻进程；`npm test` 在干净环境可跑通上述 1–7。

## 10. 待 owner 人闸确认（spec 评审项，非自动决策）

以下四项本 spec 已给出默认取值并可开工，但**结论属 owner 权限**，请在评审时逐项确认或推翻：

1. **R1 — T+1 口径**（默认 +24h 时长口径，非次日 24:00 自然日口径）。
2. **R7 — 「证据不足」语义**（默认未定结论：单子不结、时钟继续、索材一次；上游 1.2 未明写终局与否）。
3. **第 6 节 — 存储选型 JSON**（若 owner 倾向 SQLite，本 spec 需改第 4 节与 repository 设计）。
4. **第 6 节 — 仓库实名沿用 `ticketing-demo`**（是否作为正式名，或另起名）。

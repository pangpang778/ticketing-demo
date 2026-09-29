# ticketing-demo

申诉处理线上化 CLI（工厂首航 A4，ticketing-escalate-001）。

上游流程依据：factory-demo#5 recon-diff-appeal-001 spec（accepted）。
本仓库实现：`docs/intents/ticketing-escalate-001/spec.md`（accepted）。

## 安装与运行

零依赖（仅 Node 内置模块），Node ≥ 18。无鉴权、无网络、无 UI、无常驻进程。

```bash
node bin/ticketing <command>   # 或 npm link 后直接用 ticketing
```

数据落盘在**当前工作目录**下 `.ticketing/appeals.json`（JSON 单文件，原子写，人可读、git diff 友好）。

## 最小闭环

```bash
# 客服录申诉（时限起算点 = 商户提交时间；T+1 = +24h）
ticketing issue --merchant M001 --settlement ST-1 --order OD-1 \
                --type shipping --source portal

# 客服队列（全部未结单；起算点/第一时限/当前时限/剩余 全可见）
ticketing queue

# 越限单自动 escalated（读路径物化；亦可显式 sweep，幂等，可挂定时任务）
ticketing escalate sweep

# 组长队列（escalated 未结单，组长时限 = escalatedAt + 4h）
ticketing queue --role leader

# 结论录入（upheld/rejected 终局结单；rejected 必附 --basis；
# insufficient_evidence 为未定结论：不结单、时限不重置、索材仅一次）
ticketing decide APL-20260929-0001 --outcome rejected --actor 组长丙 \
                 --basis "以结算单为准，运费计入后差异不成立"
```

判定口径（成文，不做代码化比对）：`docs/settlement-criteria.md`。

## 开发

```bash
npm test              # 验收测试（spec 第 9 节 1–8 条）
node scripts/e2e-demo.js   # 端到端走查（临时目录，不污染仓库）
```

## 结构

```
bin/ticketing          进程层入口（数据目录 = cwd/.ticketing）
src/cli.js             参数解析与命令分发
src/commands.js        issue / queue / escalate / decide
src/model.js           派生字段与时限规则（status/escalatedAt/时限的唯一计算入口）
src/repository.js      存储层收口（换 SQLite 只改这里）
src/format.js          本地时间展示、剩余时长、表格
test/acceptance.test.js 验收测试（spawn 公开 CLI 路径，不手改数据文件）
```

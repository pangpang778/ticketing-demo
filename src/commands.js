// 四个命令的实现（spec 第 5 节）。所有写路径与读路径都先物化一次。
// 约定：命令函数只做「载入 → 物化 → 校验 → 变更 → 落盘 → 渲染」，不做任何鉴权。

import { fmtLocal, fmtRemaining, table, UsageError, DecisionError } from './format.js';
import {
  ALL_DECISIONS,
  ALL_SOURCES,
  ALL_TYPES,
  materialize,
  materializeAll,
  nextId,
} from './model.js';

const nowIso = (nowMs) => new Date(nowMs).toISOString();

function loadMaterialized(repo, nowMs) {
  const records = repo.load();
  const { records: materialized, changed } = materializeAll(records, nowMs);
  if (changed) repo.save(materialized); // 读路径物化并落盘（spec 3 节）
  return materialized;
}

function requireFlag(flags, name, label) {
  const v = flags[name];
  if (!v) throw new UsageError(`缺少必填参数 --${name}（${label}）`);
  return v;
}

function parseIso(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new UsageError(`--${name} 不是合法的 ISO8601 时间：${value}`);
  return ms;
}

// ── 5.1 issue ──────────────────────────────────────────────────────────────

export function cmdIssue(repo, flags, nowMs) {
  const merchantId = requireFlag(flags, 'merchant', '商户 ID');
  const settlementNo = requireFlag(flags, 'settlement', '结算单号');
  const orderNo = requireFlag(flags, 'order', '订单号');
  const type = requireFlag(flags, 'type', '申诉类型');
  const source = requireFlag(flags, 'source', '入口来源（portal|email）');

  if (!ALL_TYPES.includes(type)) {
    throw new UsageError(`--type 必须是 ${ALL_TYPES.join('|')} 之一，收到：${type}`);
  }
  if (!ALL_SOURCES.includes(source)) {
    throw new UsageError(`--source 必须是 ${ALL_SOURCES.join('|')} 之一，收到：${source}`);
  }

  const submittedMs = flags.submitted ? parseIso(flags.submitted, 'submitted') : nowMs;

  const records = repo.load();
  const id = nextId(records, nowMs);
  const first = new Date(submittedMs + 24 * 3600e3).toISOString();
  const record = {
    id,
    merchantId,
    settlementNo,
    orderNo,
    type,
    submittedAt: nowIso(submittedMs),
    source,
    status: 'pending', // 占位，落盘前物化修正
    decision: null,
    decisionBasis: null,
    decidedBy: null,
    decidedAt: null,
    escalatedAt: null,
    firstDeadlineAt: first,
    currentDeadlineAt: first,
    evidenceRequestedAt: null,
  };
  const { record: materializedRecord } = materialize(record, nowMs);
  records.push(materializedRecord);
  repo.save(records);

  const lines = [
    `已受理：${id}`,
    `第一时限 firstDeadlineAt：${fmtLocal(first)}（${fmtRemaining(first, nowMs)}）`,
    `当前时限 currentDeadlineAt：${fmtLocal(materializedRecord.currentDeadlineAt)}（${fmtRemaining(materializedRecord.currentDeadlineAt, nowMs)}）`,
  ];
  if (materializedRecord.status === 'escalated') {
    lines.push(`注意：补录单已越限，物化为 escalated（escalatedAt=${fmtLocal(materializedRecord.escalatedAt)}），请到组长队列处理。`);
  }
  return lines.join('\n');
}

// ── 5.2 queue ──────────────────────────────────────────────────────────────

const STATUS_FILTERS = ['pending', 'escalated', 'resolved', 'all'];

export function cmdQueue(repo, flags, nowMs) {
  const role = flags.role || 'cs';
  if (!['cs', 'leader'].includes(role)) throw new UsageError(`--role 必须是 cs|leader，收到：${role}`);
  const status = flags.status || 'open';
  if (!STATUS_FILTERS.includes(status) && status !== 'open') {
    throw new UsageError(`--status 必须是 pending|escalated|resolved|all，收到：${status}`);
  }
  const merchant = flags.merchant || null;

  const records = loadMaterialized(repo, nowMs).filter((r) => !merchant || r.merchantId === merchant);

  if (role === 'leader') {
    // 组长队列：仅 escalated 未结单（spec 5.2）
    const rows = records
      .filter((r) => r.status === 'escalated')
      .map((r) => [
        r.id,
        r.merchantId,
        r.settlementNo,
        fmtLocal(r.escalatedAt),
        fmtLocal(r.currentDeadlineAt),
        fmtRemaining(r.currentDeadlineAt, nowMs),
      ]);
    if (rows.length === 0) return '组长队列：空（无待处理的 escalated 单）';
    return [
      `组长队列（escalated 未结单，组长时限 = escalatedAt + 4h）`,
      table(['ID', '商户', '结算单', '升级时刻', '组长时限', '剩余'], rows),
    ].join('\n');
  }

  // 客服视图：默认全部未结（open = pending + escalated，含「证据不足」待补料单）
  const visible = records.filter((r) => {
    if (status === 'all') return true;
    if (status === 'open') return r.status !== 'resolved';
    return r.status === status;
  });
  if (visible.length === 0) return '客服队列：空';
  const rows = visible.map((r) => [
    r.id,
    r.merchantId,
    r.settlementNo,
    r.type,
    fmtLocal(r.submittedAt),
    fmtLocal(r.firstDeadlineAt),
    fmtRemaining(r.firstDeadlineAt, nowMs),
    fmtLocal(r.currentDeadlineAt),
    fmtRemaining(r.currentDeadlineAt, nowMs),
    r.status,
    r.evidenceRequestedAt ? fmtLocal(r.evidenceRequestedAt) : '-',
    r.decision || '-',
  ]);
  return [
    `客服队列（未结单默认全显；时限起算点 = 商户提交时间）`,
    table(
      ['ID', '商户', '结算单', '类型', '提交时间', '第一时限', '第一时限剩余', '当前时限', '当前时限剩余', '状态', '索材时间', '结论'],
      rows,
    ),
  ].join('\n');
}

// ── 5.3 escalate ───────────────────────────────────────────────────────────

export function cmdEscalateSweep(repo, _flags, nowMs) {
  const records = repo.load();
  const { records: materialized, changed } = materializeAll(records, nowMs);
  if (changed) repo.save(materialized);
  const escalated = materialized.filter((r) => r.status === 'escalated');
  return `sweep 完成：共 ${materialized.length} 单，其中 escalated ${escalated.length} 单${changed ? '（本次有新升级，已落盘）' : '（无变化）'}`;
}

export function cmdEscalateList(repo, flags, nowMs) {
  return cmdQueue(repo, { ...flags, role: 'leader' }, nowMs);
}

// ── 5.4 decide ─────────────────────────────────────────────────────────────

export function cmdDecide(repo, flags, positional, nowMs) {
  const id = positional[0];
  if (!id) throw new UsageError('用法：ticketing decide <id> --outcome <o> --actor <name> [--basis <text>]');
  const outcome = requireFlag(flags, 'outcome', '结论');
  const actor = requireFlag(flags, 'actor', '录入人'); // 结论必须有责任人留痕，不鉴权
  if (!ALL_DECISIONS.includes(outcome)) {
    throw new UsageError(`--outcome 必须是 ${ALL_DECISIONS.join('|')} 之一，收到：${outcome}`);
  }

  const records = loadMaterialized(repo, nowMs);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) throw new DecisionError(`未找到申诉单：${id}`);
  const r = { ...records[idx] };

  // resolved 记录一律拒绝再次 decide（含 insufficient_evidence）
  if (r.status === 'resolved') {
    throw new DecisionError(`${id} 已终局结单（${r.decision}，${fmtLocal(r.decidedAt)}），不可再录结论；改判走线下另开工单。`);
  }

  if (outcome === 'insufficient_evidence') {
    // 索材只允许一次（上游 1.2「一次性向商户索取补充材料」）
    if (r.evidenceRequestedAt) {
      throw new DecisionError(`${id} 已于 ${fmtLocal(r.evidenceRequestedAt)} 索材一次，不可再次索材（上游口径：一次性索取）。`);
    }
    r.evidenceRequestedAt = nowIso(nowMs);
    r.decision = 'insufficient_evidence'; // 未定结论：不置 resolved，时限不重置
    r.decidedBy = actor;
    r.decidedAt = nowIso(nowMs);
    r.decisionBasis = flags.basis || null;
  } else {
    // 终局结论
    if (outcome === 'rejected' && !flags.basis) {
      throw new UsageError('rejected 必须附判定依据 --basis（上游 1.2：附依据回复商户）');
    }
    r.decision = outcome;
    r.decisionBasis = flags.basis || null;
    r.decidedBy = actor;
    r.decidedAt = nowIso(nowMs);
  }

  const { record: materializedRecord } = materialize(r, nowMs);
  records[idx] = materializedRecord;
  repo.save(records);

  const status = materializedRecord.status;
  if (outcome === 'insufficient_evidence') {
    return [
      `已记录索材：${id}（evidenceRequestedAt=${fmtLocal(materializedRecord.evidenceRequestedAt)}）`,
      `该单为未定结论，不结单、时限不重置：status=${status}，当前时限 ${fmtLocal(materializedRecord.currentDeadlineAt)}（${fmtRemaining(materializedRecord.currentDeadlineAt, nowMs)}）`,
      `商户补料后请录入 upheld / rejected 结单。`,
    ].join('\n');
  }
  return [
    `已结单：${id}（${outcome}${materializedRecord.decisionBasis ? '，依据：' + materializedRecord.decisionBasis : ''}）`,
    `status=${status}，decidedBy=${materializedRecord.decidedBy}，decidedAt=${fmtLocal(materializedRecord.decidedAt)}`,
    materializedRecord.escalatedAt ? `升级痕迹保留：escalatedAt=${fmtLocal(materializedRecord.escalatedAt)}` : '',
  ].filter(Boolean).join('\n');
}

// 派生字段与时限规则（spec 第 2、3 节）。
// status / escalatedAt / firstDeadlineAt / currentDeadlineAt 的唯一计算入口，
// 任何时刻对同一输入求值结果一致（时间戳的纯函数）。

export const TERMINAL_DECISIONS = ['upheld', 'rejected'];
export const ALL_DECISIONS = [...TERMINAL_DECISIONS, 'insufficient_evidence'];
export const ALL_STATUSES = ['pending', 'escalated', 'resolved'];
export const ALL_TYPES = ['shipping', 'refund', 'other'];
export const ALL_SOURCES = ['portal', 'email'];

const FIRST_DEADLINE_HOURS = 24; // R1 拍板：T+1 = submittedAt + 24h（时长口径）
const LEADER_DEADLINE_HOURS = 4; // 组长：escalatedAt + 4h

export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function firstDeadlineAt(submittedAtMs) {
  return toIso(submittedAtMs + FIRST_DEADLINE_HOURS * 3600e3);
}

export function leaderDeadlineAt(escalatedAtMs) {
  return toIso(escalatedAtMs + LEADER_DEADLINE_HOURS * 3600e3);
}

// 物化优先级（spec 2 节，sweep 幂等的前提）：
//   decision ∈ {upheld, rejected} → resolved
//   否则 now >= firstDeadlineAt   → escalated（escalatedAt 只写一次）
//   否则                          → pending
// 已 resolved 的记录永不再被物化为 escalated。
// 返回 { record, changed }。
export function materialize(record, nowMs) {
  const before = JSON.stringify(record);
  const r = { ...record };

  if (TERMINAL_DECISIONS.includes(r.decision)) {
    r.status = 'resolved';
    // 终局单时限不再有意义，保留物化时的最后值，不重算
  } else if (nowMs >= Date.parse(r.firstDeadlineAt)) {
    r.status = 'escalated';
    if (!r.escalatedAt) {
      r.escalatedAt = toIso(nowMs); // 幂等：已有值永不覆盖
    }
    r.currentDeadlineAt = leaderDeadlineAt(Date.parse(r.escalatedAt));
  } else {
    r.status = 'pending';
    r.currentDeadlineAt = r.firstDeadlineAt;
  }

  return { record: r, changed: JSON.stringify(r) !== before };
}

// 对全量记录做一次物化。返回 { records, changed }。
export function materializeAll(records, nowMs) {
  let changed = false;
  const out = records.map((r) => {
    const res = materialize(r, nowMs);
    if (res.changed) changed = true;
    return res.record;
  });
  return { records: out, changed };
}

// id: APL-YYYYMMDD-NNNN，按日自增（签发当日，非提交日）
export function nextId(records, nowMs) {
  const d = new Date(nowMs);
  const ymd = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  const prefix = `APL-${ymd}-`;
  let max = 0;
  for (const r of records) {
    if (r.id && r.id.startsWith(prefix)) {
      const n = Number.parseInt(r.id.slice(prefix.length), 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

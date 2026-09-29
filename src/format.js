// 展示层：时间转本地时区（风险 R4）、剩余时长、表格输出。

export function fmtLocal(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 剩余时长：逾期为负，展示为「逾期 Xh Ym」
export function fmtRemaining(deadlineIso, nowMs) {
  if (!deadlineIso) return '-';
  let ms = Date.parse(deadlineIso) - nowMs;
  const overdue = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60e3);
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const body = days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`;
  return overdue ? `逾期 ${body}` : `剩 ${body}`;
}

// 简单文本表格（列宽按最长单元格；未做 CJK 双宽对齐，首版可读即可）
export function table(headers, rows) {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], String(cell).length);
    });
  }
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

// UsageError → 用法/参数错误（exit 2）；DecisionError → 业务规则拒绝（exit 1）
export class UsageError extends Error {}
export class DecisionError extends Error {}

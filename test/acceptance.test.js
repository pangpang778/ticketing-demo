// 验收测试：spec 第 9 节 1–8 条，逐条走公开 CLI 路径（spawn bin/ticketing），
// 不手改数据文件。数据目录 = 临时 cwd 下的 .ticketing/。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'ticketing');

function makeEnv(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ticketing-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function cli(cwd, ...args) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function readDb(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.ticketing', 'appeals.json'), 'utf8'));
}

const H = 3600e3;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('验收 1：issue 返回 id 与两个时限，记录落盘可读', (t) => {
  const cwd = makeEnv(t);
  const r = cli(cwd, 'issue', '--merchant', 'M001', '--settlement', 'S20260901',
    '--order', 'O1001', '--type', 'shipping', '--source', 'portal');
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/APL-\d{8}-\d{4}/)[0];
  assert.match(r.out, /firstDeadlineAt/);
  assert.match(r.out, /剩 \d/);

  const db = readDb(cwd); // 落盘可读
  assert.equal(db.length, 1);
  assert.equal(db[0].id, id);
  const submitted = Date.parse(db[0].submittedAt);
  // firstDeadlineAt = submittedAt + 24h（R1 时长口径）
  assert.equal(db[0].firstDeadlineAt, new Date(submitted + 24 * H).toISOString());
  assert.equal(db[0].status, 'pending');
});

test('验收 1b：必填校验缺一报错退出且不写盘', (t) => {
  const cwd = makeEnv(t);
  const r = cli(cwd, 'issue', '--merchant', 'M001'); // 缺 settlement/order/type/source
  assert.notEqual(r.code, 0);
  assert.match(r.err, /缺少必填参数/);
  assert.equal(existsSync(join(cwd, '.ticketing')), false, '不应写盘');
});

test('验收 2：queue 展示起算点与剩余时间；组长视图此刻为空（口径不同）', (t) => {
  const cwd = makeEnv(t);
  cli(cwd, 'issue', '--merchant', 'M001', '--settlement', 'S1', '--order', 'O1',
    '--type', 'refund', '--source', 'email');
  const cs = cli(cwd, 'queue');
  assert.equal(cs.code, 0);
  assert.match(cs.out, /提交时间/);
  assert.match(cs.out, /第一时限剩余/);
  assert.match(cs.out, /pending/);

  const leader = cli(cwd, 'queue', '--role', 'leader');
  assert.equal(leader.code, 0);
  assert.match(leader.out, /组长队列：空/, '未升级单不应出现在组长队列');
});

test('验收 3+4：补录越限单 → 自动 escalated，firstDeadlineAt 未被改动，进组长队列', (t) => {
  const cwd = makeEnv(t);
  const r = cli(cwd, 'issue', '--merchant', 'M002', '--settlement', 'S2', '--order', 'O2',
    '--type', 'other', '--source', 'portal', '--submitted', iso(48 * H));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /escalated/, '命令返回时该单已被物化为 escalated');
  const id = r.out.match(/APL-\d{8}-\d{4}/)[0];

  // queue 读路径物化
  cli(cwd, 'queue');
  const db = readDb(cwd);
  const rec = db.find((x) => x.id === id);
  assert.equal(rec.status, 'escalated');
  // firstDeadlineAt 仍 = submittedAt + 24h，未被改动
  assert.equal(rec.firstDeadlineAt, new Date(Date.parse(rec.submittedAt) + 24 * H).toISOString());
  assert.ok(rec.escalatedAt, 'escalatedAt 已写入');

  // 组长队列可见：escalatedAt + 4h 剩余
  const leader = cli(cwd, 'queue', '--role', 'leader');
  assert.match(leader.out, new RegExp(id));
  assert.match(leader.out, /升级时刻/);
  assert.match(leader.out, /剩余/);
  // escalate list 等价入口
  const list = cli(cwd, 'escalate', 'list');
  assert.match(list.out, new RegExp(id));
});

test('验收 5：decide 行为逐条可测', (t) => {
  const cwd = makeEnv(t);
  const mk = (m) => {
    const r = cli(cwd, 'issue', '--merchant', m, '--settlement', 'S-' + m, '--order', 'O-' + m,
      '--type', 'refund', '--source', 'portal', '--submitted', iso(48 * H));
    return r.out.match(/APL-\d{8}-\d{4}/)[0]; // 全部用越限单：materialize 后 escalated，仍可救火补录
  };
  const a = mk('A'); // upheld
  const b = mk('B'); // rejected 缺 basis
  const c = mk('C'); // insufficient_evidence 流程

  // 5.a upheld 成功结单
  const ra = cli(cwd, 'decide', a, '--outcome', 'upheld', '--actor', '专员甲');
  assert.equal(ra.code, 0, ra.err);
  assert.equal(readDb(cwd).find((x) => x.id === a).status, 'resolved');

  // 5.a rejected 缺 --basis 被拒
  const rb1 = cli(cwd, 'decide', b, '--outcome', 'rejected', '--actor', '专员甲');
  assert.notEqual(rb1.code, 0);
  assert.match(rb1.err, /--basis/);
  assert.equal(readDb(cwd).find((x) => x.id === b).decision, null, '被拒后不落库');
  // 附 basis 后成功
  const rb2 = cli(cwd, 'decide', b, '--outcome', 'rejected', '--actor', '专员甲', '--basis', '以结算单为准，差异不成立');
  assert.equal(rb2.code, 0, rb2.err);
  assert.equal(readDb(cwd).find((x) => x.id === b).decision, 'rejected');

  // 5.b insufficient_evidence：入库、不结、时限不重置、仍在组长队列
  const before = readDb(cwd).find((x) => x.id === c);
  const rc = cli(cwd, 'decide', c, '--outcome', 'insufficient_evidence', '--actor', '专员乙');
  assert.equal(rc.code, 0, rc.err);
  const after = readDb(cwd).find((x) => x.id === c);
  assert.ok(after.evidenceRequestedAt, 'evidenceRequestedAt 已写入');
  assert.equal(after.status, 'escalated', '未结：仍为 escalated');
  assert.equal(after.firstDeadlineAt, before.firstDeadlineAt, '时限未重置');
  assert.equal(after.escalatedAt, before.escalatedAt, '升级痕迹不变');
  assert.match(cli(cwd, 'queue', '--role', 'leader').out, new RegExp(c), '仍在组长队列');

  // 5.c 第二次 insufficient_evidence 被拒
  const rc2 = cli(cwd, 'decide', c, '--outcome', 'insufficient_evidence', '--actor', '专员乙');
  assert.notEqual(rc2.code, 0);
  assert.match(rc2.err, /索材一次|一次性/);

  // 5.d 随后 upheld 可结单
  const rc3 = cli(cwd, 'decide', c, '--outcome', 'upheld', '--actor', '组长丙');
  assert.equal(rc3.code, 0, rc3.err);
  assert.equal(readDb(cwd).find((x) => x.id === c).status, 'resolved');
  // 5.d resolved 单再 decide 任意 outcome 被拒
  const rc4 = cli(cwd, 'decide', c, '--outcome', 'rejected', '--actor', '组长丙', '--basis', 'x');
  assert.notEqual(rc4.code, 0);
  const rc5 = cli(cwd, 'decide', c, '--outcome', 'insufficient_evidence', '--actor', '组长丙');
  assert.notEqual(rc5.code, 0);

  // 未指定 --actor 报错拒绝
  const ra2 = cli(cwd, 'decide', a, '--outcome', 'upheld');
  assert.notEqual(ra2.code, 0);
  assert.match(ra2.err, /--actor/);
});

test('验收 6：终局结单后从未结队列消失，escalatedAt 痕迹保留', (t) => {
  const cwd = makeEnv(t);
  const r = cli(cwd, 'issue', '--merchant', 'M3', '--settlement', 'S3', '--order', 'O3',
    '--type', 'shipping', '--source', 'portal', '--submitted', iso(48 * H));
  const id = r.out.match(/APL-\d{8}-\d{4}/)[0];
  assert.match(cli(cwd, 'queue', '--role', 'leader').out, new RegExp(id));
  cli(cwd, 'decide', id, '--outcome', 'rejected', '--actor', '组长', '--basis', '口径见文档');

  const cs = cli(cwd, 'queue'); // 默认未结视图
  assert.doesNotMatch(cs.out, new RegExp(id));
  const leader = cli(cwd, 'queue', '--role', 'leader');
  assert.doesNotMatch(leader.out, new RegExp(id));

  const rec = readDb(cwd).find((x) => x.id === id);
  assert.equal(rec.status, 'resolved');
  assert.ok(rec.escalatedAt, '升级已发生，不因补录结论而抹除');
  assert.equal(rec.decision, 'rejected');
  assert.ok(rec.decisionBasis);
});

test('验收 7：escalate sweep 幂等，重复执行 escalatedAt 只有一个值', (t) => {
  const cwd = makeEnv(t);
  cli(cwd, 'issue', '--merchant', 'M4', '--settlement', 'S4', '--order', 'O4',
    '--type', 'other', '--source', 'email', '--submitted', iso(72 * H));
  const s1 = cli(cwd, 'escalate', 'sweep');
  assert.equal(s1.code, 0, s1.err);
  const at1 = readDb(cwd)[0].escalatedAt;
  assert.ok(at1);
  const s2 = cli(cwd, 'escalate', 'sweep');
  assert.equal(s2.code, 0, s2.err);
  const db = readDb(cwd);
  assert.equal(db.length, 1);
  assert.equal(db[0].escalatedAt, at1, 'escalatedAt 只写一次，不覆盖');
  assert.equal(db[0].status, 'escalated');
});

test('验收 8：零依赖、无鉴权/网络/UI/常驻进程（结构校验）', async (t) => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, '无第三方依赖（零原生依赖）');
  // 源码不含网络/常驻进程原语
  const { readdirSync, statSync } = await import('node:fs');
  const files = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') || !p.includes('.')) files.push(p);
    }
  })(join(ROOT, 'src'));
  files.push(join(ROOT, 'bin', 'ticketing'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\b(require\(['"]https?|fetch\(|net\.|http\.createServer|listen\()/, `${f} 无网络/服务原语`);
  }
});

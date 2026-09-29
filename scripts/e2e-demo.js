// 端到端走查：最小闭环全流程（spec 第 1 节），在临时目录中演示，不污染仓库。
// 运行：node scripts/e2e-demo.js
// 验收对照：spec 第 9 节 1–7 条（第 8 条 = npm test）。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'ticketing');
const cwd = mkdtempSync(join(tmpdir(), 'ticketing-e2e-'));

const H = 3600e3;
const iso = (hAgo) => new Date(Date.now() - hAgo * H).toISOString();

function run(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  console.log(`\n$ ticketing ${args.join(' ')}`);
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.log(`[stderr] ${r.stderr.trim()}`);
  console.log(`[exit ${r.status}]`);
  return r;
}

try {
  console.log('══ 1. 客服录申诉（email 入口，正常在途单）══');
  run('issue', '--merchant', 'M2026', '--settlement', 'ST-0930', '--order', 'OD-77',
    '--type', 'shipping', '--source', 'portal');

  console.log('\n══ 2. 客服录第二条（email 入口，补录 48h 前提交 → 应立即越限升级）══');
  run('issue', '--merchant', 'M2026', '--settlement', 'ST-0931', '--order', 'OD-88',
    '--type', 'refund', '--source', 'email', '--submitted', iso(48));
  const db = JSON.parse(
    spawnSync(process.execPath, ['-e',
      `console.log(require('fs').readFileSync(process.argv[1],'utf8'))`,
      join(cwd, '.ticketing', 'appeals.json')], { encoding: 'utf8' }).stdout,
  );
  const escalated = db.find((r) => r.status === 'escalated');
  const pending = db.find((r) => r.status === 'pending');

  console.log('\n══ 3. 客服队列（起算点/第一时限/剩余 可见）══');
  run('queue');

  console.log('\n══ 4. 显式物化（幂等 sweep，可挂定时任务）══');
  run('escalate', 'sweep');

  console.log('\n══ 5. 组长队列（escalatedAt + 4h 剩余）══');
  run('queue', '--role', 'leader');

  console.log('\n══ 6. 对在途单录「证据不足」（未定结论：不结、时钟继续、索材一次）══');
  run('decide', pending.id, '--outcome', 'insufficient_evidence', '--actor', '专员乙');

  console.log('\n══ 7. 第二次索材被拒 ══');
  run('decide', pending.id, '--outcome', 'insufficient_evidence', '--actor', '专员乙');

  console.log('\n══ 8. rejected 缺依据被拒 ══');
  run('decide', pending.id, '--outcome', 'rejected', '--actor', '专员甲');

  console.log('\n══ 9. 组长对越限单录终局结论（结单，升级痕迹保留）══');
  run('decide', escalated.id, '--outcome', 'rejected', '--actor', '组长丙',
    '--basis', '以结算单为准，运费计入后差异不成立');

  console.log('\n══ 10. 队列收敛：终局单从未结队列消失，索材单仍在 ══');
  run('queue');
  run('queue', '--role', 'leader');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

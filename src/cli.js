// CLI 入口：手写参数解析（零依赖），分发到命令实现。
// 无鉴权、无网络、无 UI、无常驻进程（spec 第 7 节）。

import { Repository } from './repository.js';
import { UsageError } from './format.js';
import {
  cmdDecide,
  cmdEscalateList,
  cmdEscalateSweep,
  cmdIssue,
  cmdQueue,
} from './commands.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true; // 布尔旗标
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function usage() {
  return `ticketing — 申诉处理线上化 CLI（ticketing-escalate-001）

用法：
  ticketing issue --merchant <id> --settlement <no> --order <no>
                  --type shipping|refund|other --source portal|email [--submitted <ISO>]
  ticketing queue [--role cs|leader] [--status pending|escalated|resolved|all] [--merchant <id>]
  ticketing escalate sweep          # 物化全部逾期单（幂等，可挂定时任务）
  ticketing escalate list           # 等价 queue --role leader
  ticketing decide <id> --outcome upheld|rejected|insufficient_evidence
                    --actor <name> [--basis <text>]

判定口径：一切以结算单为准（docs/settlement-criteria.md，decide 时随包分发）`;
}

function decideHelp() {
  return `decide — 结论录入（运营专员 / 组长）

  ticketing decide <id> --outcome upheld|rejected|insufficient_evidence --actor <name> [--basis <text>]

  upheld                 差异成立/补差（终局，结单）
  rejected               差异不成立（终局，结单；必须附 --basis 依据）
  insufficient_evidence  证据不足（未定结论：一次性向商户索取补充材料，时限不因此重置；
                         单子不结，照常升级；只允许索材一次）

判定口径（成文口径，本系统不做代码化比对）见 docs/settlement-criteria.md：
一切以结算单为准；运费计入；跨月按原订单归属月。`;
}

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULT_DATA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.ticketing',
);

export function run(argv, { dataDir = DEFAULT_DATA_DIR, nowMs = Date.now() } = {}) {
  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));
  const repo = new Repository(dataDir);

  switch (command) {
    case 'issue':
      return { code: 0, out: cmdIssue(repo, flags, nowMs) };
    case 'queue':
      return { code: 0, out: cmdQueue(repo, flags, nowMs) };
    case 'escalate': {
      const sub = positional[0];
      if (sub === 'sweep') return { code: 0, out: cmdEscalateSweep(repo, flags, nowMs) };
      if (sub === 'list') return { code: 0, out: cmdEscalateList(repo, flags, nowMs) };
      throw new UsageError('用法：ticketing escalate sweep|list');
    }
    case 'decide':
      if (flags.help) return { code: 0, out: decideHelp() };
      return { code: 0, out: cmdDecide(repo, flags, positional, nowMs) };
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { code: 0, out: usage() };
    default:
      throw new UsageError(`未知命令：${command}\n\n${usage()}`);
  }
}

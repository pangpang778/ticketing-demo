// 存储层收口（spec 第 4 节、风险 R2）：
// 全部读写经由本模块，接口稳定，后续换 SQLite 只改这里。
// JSON 单文件 + 原子写（临时文件 → rename）。

import fs from 'node:fs';
import path from 'node:path';

export class Repository {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'appeals.json');
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8');
    if (raw.trim() === '') return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error(`数据文件格式错误（应为数组）：${this.file}`);
    }
    return data;
  }

  save(records) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    // 按 id 排序落盘，git diff 友好
    const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const body = JSON.stringify(sorted, null, 2) + '\n';
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, this.file); // 原子写：避免进程中断留半截文件
  }
}

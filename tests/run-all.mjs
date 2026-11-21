// Runs every tests/*.test.mjs sequentially against BASE_URL (default http://localhost:4321).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) { console.log('Failed:', failed.join(', ')); process.exit(1); }

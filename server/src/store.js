import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DIR, { recursive: true });

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); }
  catch { return fallback; }
}
export function save(name, obj) {
  const f = path.join(DIR, name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
  fs.renameSync(f + '.tmp', f);
}

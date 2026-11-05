/**
 * 小工具：JSON / JSONL 读写。
 *
 * 原则：读坏了不抛，写坏了也不抛（调用方自己决定要不要记日志）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 读 JSON，失败返回 fallback。 */
export function readJson(path, fallback = null) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 读 JSONL，返回对象数组（坏行跳过）。limit 给 0 表示不限。 */
export function readJsonl(path, limit = 0) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const start = limit > 0 ? Math.max(0, lines.length - limit) : 0;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 半写状态的行走掉。
    }
  }
  return out;
}

/** 原子写 JSON（先写 .tmp 再 rename）。 */
export function writeJsonAtomic(path, value) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 追加一行 JSONL。 */
export function appendJsonl(path, record) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

/** 毫秒 → ISO 字符串（本地时区）。 */
export function toIso(ms) {
  const num = typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now();
  return new Date(num).toISOString();
}

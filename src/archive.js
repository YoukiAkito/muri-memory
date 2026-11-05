/**
 * 档案层：原始流水的唯一入口。
 *
 * 三个来源，三套格式，这里统一成一种记录：
 *
 *   DSH 会话日志   <DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
 *                  —— 多帧 zstd（宿主每次 append 压一段），必须用 zstd -dc 顺着解；
 *                 `user/message` 里大多数是系统注入，真人的 source.kind === 'user'。
 *   QQ 台账         {dataRoot}/.qqbot/msg-history/{group_<gid>|c2c_<openid>}/<YYYY-MM-DD>.jsonl
 *                  —— 保 7 天，行形如 {id,s,n,t,k,x,me}。
 *   日记           <DSH_HOME>/diary/<YYYY-MM-DD>.md
 *
 * 统一记录形状：
 *   { id, at, peer, role, text, source, kind }
 *
 * 这一层**只读**，不改任何写入方。找不到、解不开、格式变了，一律降级成"这一段没记录"，
 * 绝不抛错——档案是给上层用的底料，它不该把调用方拖垮。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as zlib from 'node:zlib';

/** 一次 scan 默认最多返回多少条。 */
export const DEFAULT_LIMIT = 200;
/** 解压缓存多久算新鲜。 */
const CACHE_FRESH_MS = 60_000;
/** 缓存里只留最后这么多行。 */
const TAIL_LINES = 20_000;
/** 缓存文件超过这个大小就不落盘。 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** zstd 命令行的常见落点（宿主进程的 PATH 往往只有 /usr/bin:/bin）。 */
const ZSTD_CANDIDATES = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];

/** QQ 正文前面会盖 `[消息号: xxx]` 和 `[2026-11-05 周四 15:41]`。 */
const META_PREFIX_RE = /^\s*(?:\[消息号:[^\]]*\]|\[20\d\d-\d\d-\d\d[^\]]*\])\s*\n?/;

let zstdPathCache;

export function findZstd() {
  if (zstdPathCache !== undefined) return zstdPathCache;
  for (const candidate of ZSTD_CANDIDATES) {
    if (existsSync(candidate)) {
      zstdPathCache = candidate;
      return candidate;
    }
  }
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' });
  zstdPathCache = probe.status === 0 ? 'zstd' : '';
  return zstdPathCache;
}

/** 剥掉 QQ 通道盖在正文前的时间与消息号前缀（可能连着两行）。 */
export function cleanText(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(META_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// 会话日志
// ---------------------------------------------------------------------------

/** 在 sessions 目录里找某个 sessionId 的日志文件。 */
export function findSessionLogFile(dshHome, sessionId) {
  if (typeof dshHome !== 'string' || dshHome === '' || typeof sessionId !== 'string' || sessionId === '') {
    return '';
  }
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return '';
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name, sessionId);
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 列出所有会话 id（跨工作区）。distill 要扫「所有最近流水」时用它。
 *
 * 返回 `[{sessionId, workspace, logFile, mtimeMs}]`，按 mtime 倒序。
 */
export function listSessions(dshHome) {
  if (typeof dshHome !== 'string' || dshHome === '') return [];
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return [];
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let entries;
    try {
      entries = readdirSync(join(root, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sess of entries) {
      if (!sess.isDirectory()) continue;
      let logFile = '';
      let mtimeMs = 0;
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const candidate = join(root, ws.name, sess.name, name);
        if (!existsSync(candidate)) continue;
        logFile = candidate;
        try {
          mtimeMs = statSync(candidate).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        break;
      }
      if (logFile === '') continue;
      out.push({ sessionId: sess.name, workspace: ws.name, logFile, mtimeMs });
    }
  }
  out.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return out;
}

/** 只留最后 count 行，返回 Buffer。 */
function tailLines(plain, count = TAIL_LINES) {
  let start = 0;
  let seen = 0;
  for (let i = plain.length - 1; i >= 0; i -= 1) {
    if (plain[i] === 0x0a) {
      seen += 1;
      if (seen === count) {
        start = i + 1;
        break;
      }
    }
  }
  return start === 0 ? plain : plain.subarray(start);
}

/**
 * 把日志文件解压成可读 jsonl，返回路径（失败返回 ''）。
 *
 * **多帧坑**：node 的 `zstdDecompressSync` 只解第一个 frame，解出来只有文件头那行
 * session 记录，表现是"日志读到了但一条消息都没有"。所以优先调命令行 `zstd -dc`。
 */
export function materializeSessionLog(logFile, cacheDir, options = {}) {
  const { freshMs = CACHE_FRESH_MS, log, cacheName = '', tailCount = TAIL_LINES } = options;
  if (typeof logFile !== 'string' || logFile === '' || !existsSync(logFile)) return '';
  if (!logFile.endsWith('.zstd')) return logFile;

  const stem = cacheName !== '' ? cacheName : basename(logFile).replace(/\.zstd$/, '');
  const cachePath = join(cacheDir, `${stem}.jsonl`);

  if (existsSync(cachePath)) {
    try {
      const src = statSync(logFile).mtimeMs;
      const dst = statSync(cachePath);
      if (dst.mtimeMs >= src && Date.now() - dst.mtimeMs < freshMs) return cachePath;
    } catch {
      // 落到下面重新解。
    }
  }

  try {
    if (statSync(logFile).size === 0) return '';
  } catch {
    return '';
  }

  let plain = null;
  const bin = findZstd();
  if (bin !== '') {
    const run = spawnSync(bin, ['-dc', logFile], {
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024
    });
    if (run.status === 0 || (run.stdout !== null && run.stdout.length > 0)) {
      plain = run.stdout ?? null;
    }
  }

  if (plain === null) {
    const inflate = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
    if (inflate === null) {
      log?.('warn', `没找到 zstd 命令行，且 node ${process.versions.node} 不支持 zstd，跳过会话日志`);
      return '';
    }
    try {
      plain = inflate(readFileSync(logFile));
      log?.('warn', '没找到 zstd 命令行，退回 node 解压（多帧日志可能只解出第一帧）');
    } catch (error) {
      log?.('warn', `会话日志解压失败：${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  if (plain === null || plain.length === 0) return '';

  const tail = tailLines(plain, tailCount);
  if (tail.length > MAX_CACHE_BYTES) {
    log?.('warn', `会话日志尾部 ${tail.length} 字节，超过上限，跳过`);
    return '';
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, tail);
  } catch (error) {
    log?.('warn', `会话日志缓存写入失败：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
  return cachePath;
}

/** sessionId → 能读的 jsonl 路径（找不到返回 ''）。 */
export function resolveSessionLog(dshHome, sessionId, cacheDir, options = {}) {
  const file = findSessionLogFile(dshHome, sessionId);
  if (file === '') return '';
  return materializeSessionLog(file, cacheDir, { ...options, cacheName: sessionId });
}

/** 读 jsonl 文件，返回对象数组（坏行跳过）。 */
function readJsonlFile(path, maxLines = 20_000) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const start = Math.max(0, lines.length - maxLines);
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 半写状态的行，跳过。
    }
  }
  return out;
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function textOfContent(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const parts = [];
  for (const block of value) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join(' ').trim();
}

function timeOf(row) {
  for (const key of ['at', 'time', 'ts', 'timestamp']) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/**
 * 单行会话日志 → 统一记录；认不出来返回 null。
 *
 * 真人消息判定：`data.source.kind === 'user'`（或 source 缺失时按真人算，
 * 兼容老格式）。其余 runtime-context / tool-jobs / plugin:xxx 全丢。
 */
export function parseSessionRow(row, options = {}) {
  const { peer = '', includeAssistant = true } = options;
  if (row === null || typeof row !== 'object') return null;
  if (typeof row.type !== 'string') return null;

  const isUser = row.type === 'user/message';
  const isAssistant = row.type === 'assistant/message';
  if (!isUser && !isAssistant) return null;
  if (isAssistant && includeAssistant !== true) return null;

  const data = asObject(row.data);
  let text = '';
  let kind = 'text';

  if (isUser) {
    const sourceKind = asObject(data?.source)?.kind;
    if (typeof sourceKind === 'string' && sourceKind !== 'user') return null;
    text = textOfContent(data?.content);
  } else {
    // assistant 的 source 在 data.message.source，内容在 data.message.content
    const message = asObject(data?.message) ?? data;
    text = textOfContent(message?.content);
    const src = asObject(message?.source);
    kind = src?.kind === 'model' ? 'model' : kind;
  }

  if (text === '') return null;
  const at = timeOf(row);
  // id 里带 peer：跨会话时间戳会撞，撞了连边就指不准是哪一条原话。
  const who = peer === '' ? '' : `${peer.replace(/^session:/, '').slice(0, 8)}:`;
  return {
    id: `sess:${who}${at}:${isUser ? 'u' : 'a'}`,
    at,
    peer,
    role: isUser ? 'user' : 'assistant',
    text: isUser ? cleanText(text) : text,
    source: 'session-log',
    kind
  };
}

/** 从会话日志文件读一批记录。 */
export function readSessionRecords(logPath, options = {}) {
  const { limit = DEFAULT_LIMIT, windowHours = 24, maxScanLines = 20_000, peer = '', includeAssistant = true } = options;
  if (typeof logPath !== 'string' || logPath === '' || !existsSync(logPath)) return [];
  const rows = readJsonlFile(logPath, maxScanLines);
  const floor = windowHours > 0 ? Date.now() - windowHours * 3600_000 : 0;
  const out = [];
  for (const row of rows) {
    const rec = parseSessionRow(row, { peer, includeAssistant });
    if (rec === null) continue;
    if (floor > 0 && rec.at !== 0 && rec.at < floor) continue;
    out.push(rec);
  }
  return out.slice(-limit);
}

// ---------------------------------------------------------------------------
// QQ 台账
// ---------------------------------------------------------------------------

/** 列出台账里的所有会话目录（`group_xxx` / `c2c_xxx`）。 */
export function listQqPeers(historyRoot) {
  if (typeof historyRoot !== 'string' || historyRoot === '' || !existsSync(historyRoot)) return [];
  try {
    return readdirSync(historyRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('group_') || name.startsWith('c2c_'));
  } catch {
    return [];
  }
}

/** 台账目录名 → {scope, peerId}。 */
export function parsePeerDir(name) {
  if (typeof name !== 'string') return null;
  if (name.startsWith('group_')) return { scope: 'group', peerId: name.slice(6) };
  if (name.startsWith('c2c_')) return { scope: 'c2c', peerId: name.slice(4) };
  return null;
}

/**
 * 读某个会话（或全部会话）的 QQ 台账。
 *
 * 行形状 `{id,s,n,t,k,x,me}`：`s` 发送者 openid（'self' 是我），`k` 类型，
 * `x` 正文摘要（用户发的带时间前缀，我自己发的不带），`t` 是毫秒时间戳。
 * 戳一戳/表情会落成 `k:'text'` 且 `x:''` —— 直接输出是空白行，这里跳过。
 */
export function readQqRecords(historyRoot, options = {}) {
  const { target = 'all', days = 2, limit = DEFAULT_LIMIT, keyword = '', sender = '', fromSelf, includeC2C = true } = options;
  if (typeof historyRoot !== 'string' || historyRoot === '' || !existsSync(historyRoot)) return [];

  let dirs = listQqPeers(historyRoot);
  if (target !== 'all') {
    const wanted = String(target);
    dirs = dirs.filter((name) => {
      const peer = parsePeerDir(name);
      if (peer === null) return false;
      return name.includes(wanted) || peer.peerId.includes(wanted);
    });
  }
  if (!includeC2C) dirs = dirs.filter((name) => name.startsWith('group_'));

  const dayMs = 86_400_000;
  const floor = Date.now() - days * dayMs;
  const out = [];

  for (const name of dirs) {
    const peer = parsePeerDir(name);
    if (peer === null) continue;
    const dirPath = join(historyRoot, name);
    let files;
    try {
      files = readdirSync(dirPath).filter((file) => file.endsWith('.jsonl'));
    } catch {
      continue;
    }
    files.sort();
    for (const file of files.slice(-days - 1)) {
      const rows = readJsonlFile(join(dirPath, file), 5000);
      for (const row of rows) {
        const at = typeof row.t === 'number' ? row.t : 0;
        if (at !== 0 && at < floor) continue;
        const text = cleanText(row.x);
        if (text === '') continue;
        const isSelf = row.s === 'self' || row.me === true;
        if (fromSelf === true && !isSelf) continue;
        if (fromSelf === false && isSelf) continue;
        if (sender !== '' && !String(row.s ?? '').includes(sender) && !String(row.n ?? '').includes(sender)) continue;
        if (keyword !== '' && !text.includes(keyword)) continue;
        out.push({
          id: `qq:${peer.scope}:${peer.peerId}:${row.id ?? at}`,
          at,
          peer: `${peer.scope}:${peer.peerId}`,
          role: isSelf ? 'assistant' : 'user',
          text,
          source: 'qq-ledger',
          kind: row.k === 'text' ? 'text' : String(row.k ?? 'text')
        });
      }
    }
  }

  out.sort((left, right) => left.at - right.at);
  return out.slice(-limit);
}

// ---------------------------------------------------------------------------
// 日记
// ---------------------------------------------------------------------------

/** 读日记。日期名形如 `2026-11-03.md`。 */
export function readDiary(diaryRoot, options = {}) {
  const { days = 7, limit = DEFAULT_LIMIT } = options;
  if (typeof diaryRoot !== 'string' || diaryRoot === '' || !existsSync(diaryRoot)) return [];
  let files;
  try {
    files = readdirSync(diaryRoot).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
  } catch {
    return [];
  }
  files.sort();
  const out = [];
  for (const file of files.slice(-days)) {
    const date = file.replace(/\.md$/, '');
    const at = Date.parse(`${date}T00:00:00`);
    let text = '';
    try {
      text = readFileSync(join(diaryRoot, file), 'utf8').trim();
    } catch {
      continue;
    }
    if (text === '') continue;
    out.push({
      id: `diary:${date}`,
      at: Number.isFinite(at) ? at : 0,
      peer: 'self',
      role: 'assistant',
      text,
      source: 'diary',
      kind: 'journal'
    });
  }
  return out.slice(-limit);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 档案实例。构造时把各来源的根目录定下来，之后 scan/get 都走它。
 *
 * @param {object} options
 *   - dshHome     `~/.dsh`（会话日志、日记的根）
 *   - qqHistory   QQ 台账根（`{dataRoot}/.qqbot/msg-history`）
 *   - cacheDir    解压缓存目录（默认 `<dshHome>/.cache/memory-archive`）
 *   - log         日志函数 (level, message)
 */
export function createArchive(options = {}) {
  const {
    dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    qqHistory = '',
    cacheDir = join(dshHome, '.cache', 'memory-archive'),
    log = () => {}
  } = options;

  return {
    dshHome,
    qqHistory,
    cacheDir,

    /** 某个会话的日志路径（解压后的可读 jsonl），拿不到返回 ''。 */
    sessionLogPath(sessionId) {
      try {
        return resolveSessionLog(dshHome, sessionId, cacheDir, { log });
      } catch (error) {
        log('warn', `档案：会话日志定位失败 ${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    },

    /**
     * 按条件扫一批原始记录，按时间升序返回。
     *
     * @param {object} query
     *   - sessionId    只看某个会话（可选）
     *   - qqTarget     QQ 台账目标：'all' / 群名片段 / gid / 'c2c'
     *   - includeDiary 是否带上日记（默认 false）
     *   - days         往回几天（默认 2）
     *   - limit        最多多少条（默认 200）
     *   - keyword / sender / fromSelf  过滤
     */
    scan(query = {}) {
      const {
        sessionId = '',
        allSessions = false,
        qqTarget = '',
        includeDiary = false,
        includeAssistant = true,
        days = 2,
        limit = DEFAULT_LIMIT,
        keyword = '',
        sender = '',
        fromSelf
      } = query;

      const parts = [];

      // 「所有会话」：只认最近改过的那些，老会话翻出来只会把窗口挤满。
      // 条数按会话平分，免得一个长会话吃掉全部名额。
      if (allSessions === true) {
        const sessions = listSessions(dshHome);
        const recent = sessions.filter((item) => item.mtimeMs >= Date.now() - days * 86_400_000);
        const share = Math.max(20, Math.floor(limit / Math.max(1, recent.length)));
        for (const item of recent) {
          try {
            // cacheName 必须给 sessionId：不给就全落成 `session.v4.jsonl`，
            // 所有会话共用一个缓存文件，读出来的内容全串。
            const path = materializeSessionLog(item.logFile, cacheDir, { log, cacheName: item.sessionId });
            if (path === '') continue;
            parts.push(
              ...readSessionRecords(path, {
                limit: share,
                windowHours: days * 24,
                peer: `session:${item.sessionId}`,
                includeAssistant
              })
            );
          } catch (error) {
            log('warn', `档案：会话 ${item.sessionId} 读取失败 ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (sessionId !== '') {
        try {
          const path = resolveSessionLog(dshHome, sessionId, cacheDir, { log });
          if (path !== '') {
            parts.push(
              ...readSessionRecords(path, {
                limit,
                windowHours: days * 24,
                peer: `session:${sessionId}`,
                includeAssistant
              })
            );
          }
        } catch (error) {
          log('warn', `档案：会话读取失败 ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (qqHistory !== '' && qqTarget !== '') {
        try {
          parts.push(
            ...readQqRecords(qqHistory, {
              target: qqTarget === 'all' ? 'all' : qqTarget,
              days,
              limit,
              keyword,
              sender,
              fromSelf
            })
          );
        } catch (error) {
          log('warn', `档案：QQ 台账读取失败 ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (includeDiary) {
        try {
          parts.push(...readDiary(join(dshHome, 'diary'), { days, limit }));
        } catch (error) {
          log('warn', `档案：日记读取失败 ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (keyword !== '') {
        const filtered = parts.filter((rec) => rec.text.includes(keyword));
        filtered.sort((left, right) => left.at - right.at);
        return filtered.slice(-limit);
      }

      parts.sort((left, right) => left.at - right.at);
      return parts.slice(-limit);
    },

    /** 取单条原文。目前按 id 前缀去各来源里找。 */
    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      const [scheme] = id.split(':');
      try {
        if (scheme === 'diary') {
          const date = id.slice('diary:'.length);
          const found = readDiary(join(dshHome, 'diary'), { days: 3650, limit: 5000 });
          return found.find((rec) => rec.id === id) ?? null;
        }
        if (scheme === 'qq') {
          const found = readQqRecords(qqHistory, { target: 'all', days: 7, limit: 20_000 });
          return found.find((rec) => rec.id === id) ?? null;
        }
        if (scheme === 'sess') {
          // sess 的 id 只带时间戳，无法反查具体会话；给调用方一个空结果而不是乱猜。
          return null;
        }
      } catch (error) {
        log('warn', `档案：取原文失败 ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    },

    /** 概览：有哪些来源、各覆盖多少。 */
    stat() {
      const sessions = [];
      try {
        const root = join(dshHome, 'sessions');
        if (existsSync(root)) {
          for (const ws of readdirSync(root, { withFileTypes: true })) {
            if (!ws.isDirectory()) continue;
            for (const sess of readdirSync(join(root, ws.name), { withFileTypes: true })) {
              if (sess.isDirectory()) sessions.push(sess.name);
            }
          }
        }
      } catch {
        // 忽略：stat 只是用来看一眼。
      }
      const peers = listQqPeers(qqHistory);
      let diaryDays = 0;
      try {
        const diaryRoot = join(dshHome, 'diary');
        if (existsSync(diaryRoot)) {
          diaryDays = readdirSync(diaryRoot).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).length;
        }
      } catch {
        // 同上。
      }
      return {
        sessions: sessions.length,
        qqPeers: peers.length,
        diaryDays,
        dshHome,
        qqHistory: qqHistory === '' ? '(未配置)' : qqHistory
      };
    }
  };
}

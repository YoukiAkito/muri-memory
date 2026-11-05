/**
 * 人设层：把「我是谁」从 profile 配置里搬出来，存成一份能跟着记忆走的文本。
 *
 * 为什么不能塞进卡片：卡片靠语义召回，想起来就用、想不起来就没有。
 * 人设得每轮都在，所以它跟规则一样走「读文件 → 拼进系统提示」这条路。
 *
 * 为什么不能只放 engram：卡片是逐条记录的，人设是一整份文档；
 * 而且 engram 的库是别人（mem_save）在写，不该往里加表。
 *
 * 这份文件不存在就什么都不注入 —— 别人装这套系统时，得自己写自己的人设。
 * 这里不带任何默认值，不替别人决定他该扮演谁。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 系统提示里这一节的名字。排在规则前面——先知道自己是谁，再谈怎么做事。 */
export const PERSONA_SECTION_NAME = 'memory:persona';

/**
 * 排位：0 是 profile 里 persona 插件的正位。
 *
 * 我们插在 -10，比它还靠前一点。这样万一 profile 那边也留着人设，
 * 两份都出来了至少顺序是「文件版 → 配置版」，不会把配置版的尾巴截断在中间。
 */
export const PERSONA_SECTION_ORDER = -10;

export const PERSONA_DEFAULTS = Object.freeze({
  /** 文件里没人设时要不要用 env 里那份兜底。 */
  enabled: true,
  /** 人设文件路径，空 = `<dataDir>/persona.md`。 */
  file: '',
  /** 太长的文件只取前面这么多字，防止有人往里塞一整本书。 */
  maxChars: 12000
});

/** 夹取人设配置。 */
export function resolvePersonaConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = typeof src.maxChars === 'number' ? src.maxChars : Number(src.maxChars);
  const maxChars = Number.isFinite(num) ? Math.max(500, Math.min(60000, Math.trunc(num))) : PERSONA_DEFAULTS.maxChars;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : PERSONA_DEFAULTS.enabled,
    file: typeof src.file === 'string' ? src.file : PERSONA_DEFAULTS.file,
    maxChars
  };
}

/**
 * 读人设文件。
 *
 * 返回 `{ok, text, path, reason?}`，不抛：读不到就是「没有」，不是错误。
 * 每轮都读一次文件 —— 人设改了立刻生效，不用重启。文件一般只有几 KB，
 * 这点 IO 远小于一次模型调用。
 */
export function readPersonaFile(path, { maxChars = PERSONA_DEFAULTS.maxChars } = {}) {
  if (typeof path !== 'string' || path === '') return { ok: false, text: '', path, reason: 'no_path' };
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, text: '', path, reason: 'missing' };
  }
  if (!stat.isFile()) return { ok: false, text: '', path, reason: 'not_a_file' };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, text: '', path, reason: 'unreadable' };
  }
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, text: '', path, reason: 'empty' };
  return { ok: true, text: trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed, path };
}

/** 写人设文件。只在搬人设进来的时候用一次，之后都是人自己改。 */
export function writePersonaFile(path, text) {
  const body = String(text ?? '').trim();
  if (body === '') throw new Error('人设不能写空的');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${body}\n`, 'utf8');
  renameSync(tmp, path);
  return { ok: true, path, chars: body.length };
}

/**
 * 人设层。
 *
 * 只做三件事：读、报状态、把文件里那份搬进来。不改别人的配置。
 */
export function createPersona({ dataDir, config = PERSONA_DEFAULTS, log }) {
  const file = config.file !== '' ? config.file : join(dataDir, 'persona.md');

  const api = {
    file,
    /** 当前生效的人设文本；没有就是空串。 */
    text() {
      const read = readPersonaFile(file, { maxChars: config.maxChars });
      if (!read.ok && read.reason !== 'missing' && read.reason !== 'empty') {
        log?.('warn', `人设读不出来（${read.reason}）：${file}`);
      }
      return read.ok ? read.text : '';
    },
    /** 给工具看的状态。 */
    stat() {
      const read = readPersonaFile(file, { maxChars: config.maxChars });
      return {
        enabled: config.enabled === true,
        file,
        present: read.ok,
        chars: read.ok ? read.text.length : 0,
        reason: read.reason
      };
    },
    /** 把一段现成的人设搬进来（覆盖）。 */
    put(text) {
      if (config.enabled !== true) return { ok: false, error: 'disabled' };
      try {
        return writePersonaFile(file, text);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    exists() {
      return existsSync(file);
    }
  };

  return api;
}

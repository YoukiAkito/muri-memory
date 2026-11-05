/**
 * 提炼层：把原始流水变成卡片。
 *
 * 分两件事，刻意拆开：
 *   - **挑哪一段**（纯函数）：时间窗、去重、拼成提示词。这段能单测，不打模型。
 *   - **让谁去炼**（注入的 createWorker）：开一个一次性会话，让它自己用 mem_save
 *     把值得记的存下来。提炼本身是判断，写死在代码里就变成关键字匹配了。
 *
 * 为什么不每轮都跑：聊十句提炼一次，等于把噪音也沉淀成记忆。
 * 架构文档定的是「定时（每日一次）+ 手动」，这里按这个来。
 */
import { join } from 'node:path';
import { readJson, writeJsonAtomic, toIso } from './util.js';

/** 默认参数。配置里能覆盖，见 config.js 的 distill 段。 */
export const DISTILL_DEFAULTS = Object.freeze({
  enabled: true,
  /** 每天几点跑（本地时间，0-23）。 */
  hour: 4,
  /** 往回看几天。 */
  days: 1,
  /** 一次最多喂多少条原始流水给提炼会话。 */
  maxRecords: 300,
  /** 拼进提示词的正文总字数上限。 */
  maxChars: 24000,
  /** 一次最多存几张卡（写在提示词里，让提炼会话自己控制）。 */
  maxCards: 12,
  /** 提炼会话的时间盒（毫秒）。 */
  timeBoxMs: 900_000,
  /** 提炼会话挂哪个人设（空 = 不挂，那就只有宿主工具，读不了文件）。 */
  workerPreset: ''
});

const DAY_MS = 86_400_000;

function intOf(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 解析 distill 段的配置。 */
export function resolveDistillConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: boolOf(source.enabled, DISTILL_DEFAULTS.enabled),
    hour: intOf(source.hour, DISTILL_DEFAULTS.hour, 0, 23),
    days: intOf(source.days, DISTILL_DEFAULTS.days, 1, 30),
    maxRecords: intOf(source.maxRecords, DISTILL_DEFAULTS.maxRecords, 1, 2000),
    maxChars: intOf(source.maxChars, DISTILL_DEFAULTS.maxChars, 200, 200_000),
    maxCards: intOf(source.maxCards, DISTILL_DEFAULTS.maxCards, 1, 100),
    timeBoxMs: intOf(source.timeBoxMs, DISTILL_DEFAULTS.timeBoxMs, 10_000, 3_600_000),
    workerPreset: typeof source.workerPreset === 'string' ? source.workerPreset : DISTILL_DEFAULTS.workerPreset
  };
}

/**
 * 上次提炼到哪儿了。
 *
 * 只用时间水位（`lastRunAt`）判断，不按 id 去重——流水本身是只增的，
 * 时间窗已经够用；按 id 记会让状态文件随天数无限长。
 */
export function readDistillState(path) {
  const raw = readJson(path, null);
  if (raw === null || typeof raw !== 'object') return { lastRunAt: 0, lastOk: null, lastSavedIds: [] };
  return {
    lastRunAt: Number.isFinite(Number(raw.lastRunAt)) ? Number(raw.lastRunAt) : 0,
    lastOk: typeof raw.lastOk === 'boolean' ? raw.lastOk : null,
    lastSavedIds: Array.isArray(raw.lastSavedIds) ? raw.lastSavedIds.map((item) => String(item)) : []
  };
}

export function writeDistillState(path, state) {
  return writeJsonAtomic(path, state);
}

/**
 * 该不该现在跑。
 *
 * 三条：开着没、到点没（今天的 hour 已经过了）、今天是不是已经跑过。
 * `lastRunAt` 用的是本地时间的自然日边界——她按本地时间作息，跨时区不折腾。
 */
export function shouldDistill(state, { now = Date.now(), config, force = false } = {}) {
  const cfg = resolveDistillConfig(config);
  if (!cfg.enabled && force !== true) return { run: false, reason: 'disabled' };
  if (force === true) return { run: true, reason: 'forced' };

  const todayAt = startOfDayHour(now, cfg.hour);
  if (now < todayAt) return { run: false, reason: 'too_early' };
  if (Number(state?.lastRunAt ?? 0) >= todayAt) return { run: false, reason: 'already_ran' };
  return { run: true, reason: 'due' };
}

/** 今天（或明天，如果已过）的 hour 点整，毫秒。 */
export function startOfDayHour(now, hour) {
  const date = new Date(now);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/** 下一次该跑的时刻（毫秒）。用于排闹钟。 */
export function nextRunAt(now, hour) {
  const today = startOfDayHour(now, hour);
  return today > now ? today : today + DAY_MS;
}

/**
 * 取时间窗内的流水。`since` 之前的一律丢，`until` 之后的也丢。
 * 纯函数，方便测。
 */
export function inWindow(records, { since, until }) {
  if (!Array.isArray(records)) return [];
  const from = Number.isFinite(since) ? since : 0;
  const to = Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
  return records
    .filter((rec) => rec !== null && typeof rec === 'object')
    .filter((rec) => {
      const at = Number(rec.at);
      return Number.isFinite(at) && at >= from && at <= to;
    })
    .sort((left, right) => Number(left.at) - Number(right.at));
}

const BREAK_TAG_RE = /<text_break>[\s\S]*?<\/text_break>|<\/?text_break[^>]*>|<next>[\s\S]*?<\/next>/gi;
const GROUP_CTX_RE = /\[群聊上下文·[^\]]*\]/g;
const CURRENT_MSG = '[当前消息]';
const TIME_PREFIX_RE = /^\s*\[20\d\d-\d\d-\d\d[^\]]*\]\s*/;

/**
 * 把一条流水洗成人话。
 *
 * 两件事必须做，否则提炼读到的是通道噪音：
 *   - 剥掉 `<text_break>` 这类拆条标记（那是我分条发送用的，不是内容）；
 *   - 群消息正文前面会被塞一大段「群聊上下文」，`[当前消息]` 之后才是她这轮说的话。
 */
export function tidyForDistill(text) {
  let out = String(text ?? '');
  const cut = out.lastIndexOf(CURRENT_MSG);
  if (cut !== -1) out = out.slice(cut + CURRENT_MSG.length);
  out = out.replace(GROUP_CTX_RE, ' ');
  out = out.replace(BREAK_TAG_RE, ' ');
  out = out.replace(TIME_PREFIX_RE, '');
  return out.replace(/\s+/g, ' ').trim();
}

/** 把流水拼成提示词里的正文，超字数就从头截断并标注。 */
export function renderRecords(records, { maxChars = DISTILL_DEFAULTS.maxChars } = {}) {
  const lines = [];
  let used = 0;
  let dropped = 0;
  const seen = new Set();
  for (const rec of records) {
    const text = tidyForDistill(rec.text);
    if (text === '') continue;
    // 同一句话在相邻会话里被记过两遍是常态，重复喂给提炼只会浪费字数。
    const key = `${rec.role ?? ''}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = String(rec.role ?? rec.peer ?? '?');
    const line = `- [${toIso(Number(rec.at))}] ${who}: ${text.slice(0, 400)}`;
    if (used + line.length > maxChars) {
      // 一条都放不下的时候也要给点东西——否则提示词里只剩一句"没放进来"，
      // 提炼会话会以为这段时间什么都没发生。
      if (lines.length === 0) {
        lines.push(line.slice(0, Math.max(40, maxChars)));
        used += maxChars;
      }
      dropped = records.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`……（还有 ${dropped} 条没放进来）`);
  return lines.join('\n');
}

/**
 * 提炼提示词。
 *
 * 写的是**判断标准**而不是关键字——这里要是把「记住什么」写成规则，
 * 提炼就退化成 grep 了。
 */
export function buildDistillPrompt({ recordsText, since, until, count, maxCards = DISTILL_DEFAULTS.maxCards }) {
  return [
    '# 这是一次记忆提炼',
    '',
    `时间窗：${toIso(since)} ~ ${toIso(until)}，共 ${count} 条原始流水。`,
    '',
    '## 规矩',
    '- 只读，不改任何文件；不要给任何人发消息。',
    '- 从下面的流水里挑出「值得长期记住」的东西：做过什么决定和理由、踩过的坑和根因、查明的机制、她的偏好和纠正。',
    '- 每条用 mem_save 存成一张卡。标题要能搜到；内容用 **What** / **Why** / **Where** / **Learned** 四段。',
    '- 不要存「继续」「好」「打错了」这类碎片，也不要存能从代码或配置里直接读到的东西。',
    `- 最多 ${maxCards} 张。挑不出来就一张都不存，不要硬凑。`,
    '',
    '## 流水',
    recordsText === '' ? '(这条时间窗里没有可用的流水)' : recordsText
  ].join('\n');
}

/**
 * 提炼实例。
 *
 * @param {object} options
 *   - archive     档案层（要 scan）
 *   - cards       卡片层（跑完看新增了哪些卡）
 *   - createWorker 注入的执行器：({prompt, timeBoxMs}) => Promise<void|{text}>
 *   - statePath   状态文件
 *   - log         日志函数
 */
export function createDistill(options = {}) {
  const {
    archive = null,
    cards = null,
    createWorker = null,
    dataDir = '',
    log = () => {},
    now = () => Date.now()
  } = options;
  const statePath = options.statePath ?? (dataDir !== '' ? join(dataDir, 'distill-state.json') : '');

  function readState() {
    return statePath === '' ? { lastRunAt: 0, lastOk: null, lastSavedIds: [] } : readDistillState(statePath);
  }

  function writeState(state) {
    if (statePath === '') return false;
    return writeDistillState(statePath, state);
  }

  return {
    statePath,

    /** 现在该不该跑。 */
    status(config) {
      const state = readState();
      const verdict = shouldDistill(state, { now: now(), config });
      return { ...verdict, state, nextAt: nextRunAt(now(), resolveDistillConfig(config).hour) };
    },

    /**
     * 跑一次提炼。
     *
     * 返回 `{ok, reason?, at, windowed, newCards}`；失败不抛（沉淀这种事失败一次不算事，
     * 下一个窗口再来）。
     */
    async run(config, runOptions = {}) {
      const cfg = resolveDistillConfig(config);
      const at = now();
      const state = readState();
      const verdict = shouldDistill(state, { now: at, config: cfg, force: runOptions.force === true });
      if (!verdict.run) return { ok: false, reason: verdict.reason, at };

      if (archive === null || typeof archive.scan !== 'function') {
        return { ok: false, reason: 'no_archive', at };
      }
      if (typeof createWorker !== 'function') {
        return { ok: false, reason: 'no_worker', at };
      }

      const since = Math.max(Number(state.lastRunAt ?? 0), at - cfg.days * DAY_MS);
      const until = at;

      let records = [];
      try {
        // 不指定 sessionId 时 archove 什么都不会扫，所以走 allSessions：
        // 提炼要看的是「这段时间发生的所有事」，不是某一个会话。
        records = archive.scan({ allSessions: true, days: cfg.days, limit: cfg.maxRecords, includeAssistant: true });
      } catch (error) {
        log('warn', `提炼：扫流水失败 ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'scan_failed', at };
      }

      const windowed = inWindow(records, { since, until }).slice(-cfg.maxRecords);
      if (windowed.length === 0) {
        // 没东西可炼也是正常结果：记上时间水位，免得同一个窗口反复扫。
        writeState({ lastRunAt: at, lastOk: true, lastSavedIds: [] });
        return { ok: true, reason: 'nothing_to_distill', at, windowed: 0, newCards: [] };
      }

      const beforeIds = new Set(
        (typeof cards?.recent === 'function' ? cards.recent({ limit: 200 }) : []).map((card) => card.id)
      );

      const prompt = buildDistillPrompt({
        recordsText: renderRecords(windowed, { maxChars: cfg.maxChars }),
        since,
        until,
        count: windowed.length,
        maxCards: cfg.maxCards
      });

      try {
        await createWorker({ prompt, timeBoxMs: cfg.timeBoxMs });
      } catch (error) {
        log('warn', `提炼：会话失败 ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'worker_failed', at, windowed: windowed.length };
      }

      const after = typeof cards?.recent === 'function' ? cards.recent({ limit: 200 }) : [];
      const newCards = after.filter((card) => !beforeIds.has(card.id));

      writeState({ lastRunAt: at, lastOk: true, lastSavedIds: newCards.map((card) => card.id) });
      log('info', `提炼完成：${windowed.length} 条流水 → ${newCards.length} 张卡`);
      return { ok: true, at, windowed: windowed.length, newCards };
    }
  };
}

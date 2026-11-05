/**
 * 维护层：定时打扫。
 *
 * 能做和不能做的界线很重要：
 *   - **能做的**：清自己边车库里的脏数据（指向已删卡片的边）、找重复卡片、留一份巡检报告。
 *   - **不能做的**：改 engram 里的卡片。卡片层是只读的（`readOnly: true` 打开的连接），
 *     所以「合并重复卡」「给冷卡降温」这类操作这里**只报告不执行**——真要动手得走 engram
 *     自己的写接口，而那是 `mem_save` 的事，不该由维护层偷偷改。
 *
 * 这跟 Alaya 那套「温度」不一样：温度要记访问次数，而访问记录在别人库里没有。
 * 不假装有。
 */
import { join } from 'node:path';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic, toIso } from './util.js';

export const MAINTAIN_DEFAULTS = Object.freeze({
  enabled: true,
  /** 每天几点跑（本地时区）。默认 5 点，错开提炼的 4 点。 */
  hour: 5,
  /** 一次最多看多少张卡。 */
  maxCards: 500,
  /** 相似度超过这个就算重复。 */
  similarThreshold: 0.9,
  /** 一个窗口内最多报告多少组重复。 */
  maxGroups: 20
});

/** 夹取维护层配置。 */
export function resolveMaintainConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const intOf = (value, fallback, min, max) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
  };
  const floatOf = (value, fallback, min, max) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  };
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : MAINTAIN_DEFAULTS.enabled,
    hour: intOf(src.hour, MAINTAIN_DEFAULTS.hour, 0, 23),
    maxCards: intOf(src.maxCards, MAINTAIN_DEFAULTS.maxCards, 10, 5000),
    similarThreshold: floatOf(src.similarThreshold, MAINTAIN_DEFAULTS.similarThreshold, 0.5, 1),
    maxGroups: intOf(src.maxGroups, MAINTAIN_DEFAULTS.maxGroups, 1, 100)
  };
}

/** 取文本的字符二元组集合（中文没有空格，按字切比按词稳）。 */
function bigrams(text) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？,.;:!?"'（）()\[\]【】]/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  if (clean.length === 1) out.add(clean);
  return out;
}

/** 两张卡的相似度：标题加权，正文二元组 Jaccard。0~1。 */
export function cardSimilarity(left, right) {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return 0;
  if (left.id === right.id) return 1;
  const titleA = bigrams(left.title);
  const titleB = bigrams(right.title);
  const bodyA = bigrams(left.content);
  const bodyB = bigrams(right.content);

  const jaccard = (a, b) => {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
  };

  const titleScore = jaccard(titleA, titleB);
  const bodyScore = jaccard(bodyA, bodyB);
  // 标题重一点：标题一样、正文补全的新版本，本来就是同一件事。
  return Math.round((0.6 * titleScore + 0.4 * bodyScore) * 1000) / 1000;
}

/**
 * 在一批卡片里找重复组。只报告，不动数据。
 *
 * 返回 `[{score, cards: [{id, title}, {id, title}]}]`，按分数降序。
 */
export function findDuplicates(cards, options = {}) {
  const { threshold = MAINTAIN_DEFAULTS.similarThreshold, maxGroups = MAINTAIN_DEFAULTS.maxGroups } = options;
  const list = Array.isArray(cards) ? cards.filter((card) => card !== null && typeof card === 'object') : [];
  const groups = [];
  // 已经和谁判过重了，就别再拿它当主角——否则一组三张会变成三条记录。
  const grouped = new Set();

  for (let i = 0; i < list.length; i += 1) {
    if (grouped.has(list[i].id)) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      if (grouped.has(list[j].id)) continue;
      const score = cardSimilarity(list[i], list[j]);
      if (score < threshold) continue;
      grouped.add(list[i].id);
      grouped.add(list[j].id);
      groups.push({
        score,
        cards: [
          { id: list[i].id, title: list[i].title },
          { id: list[j].id, title: list[j].title }
        ]
      });
      if (groups.length >= maxGroups) return groups.sort((left, right) => right.score - left.score);
      break;
    }
  }
  return groups.sort((left, right) => right.score - left.score);
}

/**
 * 找出悬空边：边的两端有一头已经不存在了。
 *
 * `knownCards` 是 `Set<cardId>`；端点若不是 `obs:` 开头（比如 archive 的原始 id），
 * 就交给 `knownOriginal` 判断——不给就当它有效，免得把正常的设计报成脏数据。
 */
export function findDanglingLinks(edges, knownCards, options = {}) {
  const { knownOriginal = null } = options;
  const out = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (edge === null || typeof edge !== 'object') continue;
    const from = String(edge.from ?? '');
    const to = String(edge.to ?? '');
    const alive = (ref) => {
      if (ref.startsWith('obs:')) return knownCards.has(ref);
      return typeof knownOriginal === 'function' ? knownOriginal(ref) : true;
    };
    if (alive(from) && alive(to)) continue;
    out.push({ ...edge, reason: alive(from) ? 'target_missing' : 'source_missing' });
  }
  return out;
}

const RUNS_FILE = 'maintain-runs.jsonl';
const REPORT_FILE = 'maintain-report.json';

/** 读上次的维护记录（没有返回 0）。 */
export function lastMaintainAt(runsPath) {
  const rows = readJsonl(runsPath, 1);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const at = last !== null && typeof last.at === 'number' ? last.at : 0;
  return Number.isFinite(at) ? at : 0;
}

/** 从上次跑完到现在，跨过没跨过今天的 hour 点。 */
export function isMaintainDue(now, hour, lastAt) {
  const day = new Date(now);
  day.setHours(hour, 0, 0, 0);
  if (now < day.getTime()) {
    // 今天还没到点：昨天那个点跑过了就算跑过。
    const yesterday = day.getTime() - 86_400_000;
    return lastAt < yesterday;
  }
  return lastAt < day.getTime();
}

export function shouldMaintain(state, options = {}) {
  const { now = Date.now(), config = {}, force = false } = options;
  if (force === true) return { run: true, reason: 'forced' };
  if (config.enabled !== true) return { run: false, reason: 'disabled' };
  if (isMaintainDue(now, Number(config.hour ?? MAINTAIN_DEFAULTS.hour), Number(state?.lastRunAt ?? 0))) {
    return { run: true, reason: 'due' };
  }
  return { run: false, reason: 'too_early' };
}

/** 下次该跑的时刻（毫秒）。 */
export function nextMaintainAt(now, hour) {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/**
 * 维护层。
 *
 * @param {object} options
 *   - cards      卡片层（只用到 `recent` / `stat`）
 *   - links      边读函数：`() => [{from, to, relation, reason, at}]`（可选）
 *                不给就跳过悬空边检查——没有读全量边的入口时别假装检查过。
 *   - dataDir    报告与记录落到这里
 *   - log        日志
 */
export function createMaintain(options = {}) {
  const { cards = null, links = null, dataDir = '', log = () => {}, now = () => Date.now() } = options;
  const runsPath = dataDir === '' ? '' : join(dataDir, RUNS_FILE);
  const reportPath = dataDir === '' ? '' : join(dataDir, REPORT_FILE);

  function status(config = {}) {
    const lastRunAt = runsPath === '' ? 0 : lastMaintainAt(runsPath);
    const verdict = shouldMaintain({ lastRunAt }, { now: now(), config });
    return {
      run: verdict.run,
      reason: verdict.reason,
      state: { lastRunAt },
      nextAt: nextMaintainAt(now(), Number(config.hour ?? MAINTAIN_DEFAULTS.hour)),
      reportPath
    };
  }

  /**
   * 跑一次巡检。失败不抛——维护是背景杂活，不该把宿主搞崩。
   *
   * 返回 `{ok, reason?, at, cards, duplicates, dangling, fixed}`。
   */
  async function run(config = {}, runOptions = {}) {
    const cfg = { ...MAINTAIN_DEFAULTS, ...config };
    const state = { lastRunAt: runsPath === '' ? 0 : lastMaintainAt(runsPath) };
    const verdict = shouldMaintain(state, { now: now(), config: cfg, force: runOptions.force === true });
    if (!verdict.run) return { ok: false, reason: verdict.reason, at: now() };
    if (cards === null) return { ok: false, reason: 'no_cards', at: now() };

    const at = now();
    let scanned = [];
    try {
      scanned = cards.recent({ limit: cfg.maxCards });
    } catch (error) {
      log('warn', `维护：列卡片失败 ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'cards_failed', at };
    }

    const duplicates = findDuplicates(scanned, { threshold: cfg.similarThreshold, maxGroups: cfg.maxGroups });

    let dangling = [];
    if (typeof links === 'function') {
      try {
        const known = new Set(scanned.map((card) => card.id));
        dangling = findDanglingLinks(links(), known);
      } catch (error) {
        log('warn', `维护：读边失败 ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const report = {
      at,
      atIso: toIso(at),
      scanned: scanned.length,
      duplicates,
      dangling,
      note: '只报告不改数据：卡片在 engram 里是只读的，合并/删除要走 mem_save。'
    };
    if (reportPath !== '') writeJsonAtomic(reportPath, report);

    if (duplicates.length > 0) log('info', `维护：找到 ${duplicates.length} 组疑似重复`);
    if (dangling.length > 0) log('info', `维护：找到 ${dangling.length} 条悬空边`);
    if (runsPath !== '') appendJsonl(runsPath, { at, scanned: scanned.length, duplicates: duplicates.length, dangling: dangling.length });

    return { ok: true, at, cards: scanned.length, duplicates, dangling, fixed: 0 };
  }

  return {
    runsPath,
    reportPath,
    status,
    run,
    /** 上次巡检报告（没有就是 null）。 */
    lastReport() {
      return reportPath === '' ? null : readJson(reportPath, null);
    }
  };
}

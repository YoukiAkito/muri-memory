/**
 * 关系层：卡片之间那些边，从哪儿读。
 *
 * 为什么单独一层：
 *   边有**两个**来源，而且以后可能更多。
 *     - engram 自己就判：我在 `mem_save` 之后 `mem_judge`，它把「这张和那张什么关系」
 *       写进 `memory_relations`（实测 51 条，42 related / 4 supersedes / 2 not_conflict）。
 *     - 边车库 `links.db`：engram 没有的那类边，比如「卡片指向原始流水」。
 *   早先只读 `links.db`，于是 engram 判过的那 51 条全被无视，`memory_stat` 一直报 links: 0。
 *
 *   但也不能写死成「两个都读」——那样换掉任何一个都得改调用方，
 *   而且以后想换第三处来源（向量库、别的图库）还得再动一次。
 *
 * 所以：**来源是可替换的**。每个来源只要长得像下面这样就行：
 *   {
 *     name: string,
 *     available: boolean,
 *     edges(fromCard, { relation, direction }) -> Edge[],
 *     all({ limit }) -> Edge[],
 *     count() -> number
 *   }
 * Edge = { from, to, relation, reason, at, source }
 *
 * 卡片层只认 `createRelations()` 这一个接口，外面（recall / 维护层 / 工具）不关心
 * 边到底躺在哪张表里。
 */

/** engram 那边的关系名 → 我们这边的边名。没列进来的一律丢掉。 */
const ENGRAM_RELATION_MAP = Object.freeze({
  related: 'related',
  supersedes: 'supersedes',
  conflicts_with: 'conflicts_with'
});

/** 边名归一化。engram 写 `supersedes`，我们也是 `supersedes`，这里只是兜底。 */
function normalizeRelation(relation) {
  const key = String(relation ?? '').trim();
  return ENGRAM_RELATION_MAP[key] ?? '';
}

function normalizeDirection(direction) {
  return direction === 'in' || direction === 'both' ? direction : 'out';
}

/**
 * 时间归一化。
 *
 * engram 的 `created_at` 是**文本** `"2026-11-06 08:11:51"`（本地时间、不带时区），
 * 不是毫秒数。直接 `Number()` 会得 NaN，边一排就乱序（实测全变 null）。
 * 所以这里认三种形态：数字、ISO 串、`YYYY-MM-DD HH:MM:SS` 串。
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && !/[^\d.]/.test(text)) return asNumber;
  // `2026-11-06 08:11:51` → 补成 `2026-11-06T08:11:51` 再按本地时间解析。
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 来源一：engram 的 `memory_relations`。
 *
 * 关系表里存的是 `sync_id`（`obs-xxxx…`），卡片 id 是自增主键 `obs:123`，
 * 所以要 join 一下 `observations` 换回来。join 不到的（观察被删了）直接丢，
 * 不报错——删卡片本来就会留下一堆指向空气的关系。
 *
 * 只认 `judgment_status = 'judged'` 且没被 `superseded_at` 作废的：
 * `pending` 是「还没判」的候选，`not_conflict` 是「这两张不冲突」的判定，
 * 两者都不构成一条边。
 */
export function createEngramRelationSource(options = {}) {
  const { store = null, log = () => {} } = options;

  const SELECT = `
    SELECT r.relation, r.reason, r.created_at, r.confidence,
           s.id AS sid, t.id AS tid
      FROM memory_relations r
      JOIN observations s ON s.sync_id = r.source_id AND s.deleted_at IS NULL
      JOIN observations t ON t.sync_id = r.target_id AND t.deleted_at IS NULL
     WHERE r.judgment_status = 'judged'
       AND r.superseded_at IS NULL
       AND r.relation IN ('related', 'supersedes', 'conflicts_with')`;

  function toEdge(row) {
    const relation = normalizeRelation(row.relation);
    if (relation === '') return null;
    return {
      from: `obs:${row.sid}`,
      to: `obs:${row.tid}`,
      relation,
      reason: String(row.reason ?? ''),
      at: toMs(row.created_at),
      source: 'engram'
    };
  }

  function rowsToEdges(rows) {
    const out = [];
    for (const row of rows) {
      const edge = toEdge(row);
      if (edge !== null) out.push(edge);
    }
    return out;
  }

  return {
    name: 'engram',
    get available() {
      return store !== null;
    },

    edges(fromCard, query = {}) {
      if (store === null) return [];
      const { relation = '', direction = 'out' } = query;
      const raw = String(fromCard ?? '').replace(/^obs:/, '');
      const obsId = Number(raw);
      if (!Number.isFinite(obsId) || obsId <= 0) return [];
      const way = normalizeDirection(direction);
      const where =
        way === 'out'
          ? 'AND s.id = ?'
          : way === 'in'
            ? 'AND t.id = ?'
            : 'AND (s.id = ? OR t.id = ?)';
      const params = way === 'both' ? [Math.trunc(obsId), Math.trunc(obsId)] : [Math.trunc(obsId)];
      try {
        const rows = store.prepare(`${SELECT} ${where} ORDER BY r.id DESC`).all(...params);
        const edges = rowsToEdges(rows);
        return relation === '' ? edges : edges.filter((edge) => edge.relation === relation);
      } catch (error) {
        log('warn', `关系层：engram 边读取失败 ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    },

    all(query = {}) {
      if (store === null) return [];
      const cap = Math.max(1, Math.min(50_000, Number(query.limit) || 5000));
      try {
        return rowsToEdges(store.prepare(`${SELECT} ORDER BY r.id DESC LIMIT ?`).all(cap));
      } catch {
        return [];
      }
    },

    count() {
      if (store === null) return 0;
      try {
        const row = store
          .prepare(
            `SELECT count(*) c
               FROM memory_relations r
               JOIN observations s ON s.sync_id = r.source_id AND s.deleted_at IS NULL
               JOIN observations t ON t.sync_id = r.target_id AND t.deleted_at IS NULL
              WHERE r.judgment_status = 'judged'
                AND r.superseded_at IS NULL
                AND r.relation IN ('related', 'supersedes', 'conflicts_with')`
          )
          .get();
        return Number(row?.c ?? 0);
      } catch {
        return 0;
      }
    }
  };
}

/**
 * 来源二：自己的边车库 `links.db` 的 `card_links` 表。
 *
 * 只存放 engram 表达不了的东西——主要是「这张卡是从哪段原始流水提炼出来的」
 * （端点可以不是 `obs:` 开头的卡片 id，而是 `qq:c2c:…` / `sess:…` 这类原话 id）。
 */
export function createLinkTableSource(options = {}) {
  const { links = null, log = () => {} } = options;

  function rowToEdge(row) {
    return {
      from: String(row.from_card),
      to: String(row.to_ref),
      relation: String(row.relation),
      reason: String(row.reason ?? ''),
      at: toMs(row.created_at),
      source: 'links'
    };
  }

  return {
    name: 'links',
    get available() {
      return links !== null;
    },

    edges(fromCard, query = {}) {
      if (links === null) return [];
      const { relation = '', direction = 'out' } = query;
      // 边车库只有正向：`from_card` 是自己写的，没有反查的必要。
      if (normalizeDirection(direction) === 'in') return [];
      try {
        const rows =
          relation === ''
            ? links.prepare('SELECT * FROM card_links WHERE from_card = ? ORDER BY created_at DESC').all(String(fromCard))
            : links
                .prepare('SELECT * FROM card_links WHERE from_card = ? AND relation = ? ORDER BY created_at DESC')
                .all(String(fromCard), String(relation));
        return rows.map(rowToEdge);
      } catch (error) {
        log('warn', `关系层：边车库读取失败 ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    },

    all(query = {}) {
      if (links === null) return [];
      const cap = Math.max(1, Math.min(50_000, Number(query.limit) || 5000));
      try {
        return links.prepare('SELECT * FROM card_links ORDER BY created_at DESC LIMIT ?').all(cap).map(rowToEdge);
      } catch {
        return [];
      }
    },

    count() {
      if (links === null) return 0;
      try {
        return Number(links.prepare('SELECT count(*) c FROM card_links').get()?.c ?? 0);
      } catch {
        return 0;
      }
    }
  };
}

/**
 * 把若干来源合成一个。
 *
 * 去重按 `from → to → relation`：两个来源可能记了同一条关系（比如我在边车库里
 * 手动补过一张 engram 也判过的），只留先来的那个（来源顺序就是优先级）。
 */
export function createRelations(options = {}) {
  const { sources = [], log = () => {} } = options;
  const list = sources.filter((source) => source !== null && typeof source === 'object');

  function merge(collected) {
    const seen = new Set();
    const out = [];
    for (const { edge } of collected) {
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(edge);
    }
    out.sort((left, right) => Number(right.at ?? 0) - Number(left.at ?? 0));
    return out;
  }

  return {
    /** 有哪些来源、各自可不可用（排查用）。 */
    get sources() {
      return list.map((source) => ({ name: String(source.name ?? '?'), available: source.available === true }));
    },

    /**
     * 从某张卡片出发的边。
     * @param {string} fromCard  卡片 id（`obs:123`）
     * @param {object} query     `{ relation, direction: 'out'|'in'|'both' }`
     */
    edges(fromCard, query = {}) {
      const collected = [];
      for (const source of list) {
        try {
          for (const edge of source.edges(fromCard, query) ?? []) collected.push({ edge });
        } catch (error) {
          log('warn', `关系层：来源 ${source.name} 取边失败 ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return merge(collected);
    },

    /** 全部边（维护层查悬空边要用）。 */
    all(query = {}) {
      const collected = [];
      for (const source of list) {
        try {
          for (const edge of source.all(query) ?? []) collected.push({ edge });
        } catch {
          // 单个来源坏了不影响其他来源。
        }
      }
      return merge(collected);
    },

    /** 总条数与分来源条数。 */
    stat() {
      const bySource = {};
      let total = 0;
      for (const source of list) {
        const name = String(source.name ?? '?');
        let n = 0;
        try {
          n = Number(source.count?.() ?? 0);
        } catch {
          n = 0;
        }
        bySource[name] = n;
        total += n;
      }
      return { total, bySource };
    }
  };
}

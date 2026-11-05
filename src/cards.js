/**
 * 卡片层：提炼结果与它们之间的边。
 *
 * 分工：
 *   - **卡片本体**存在 engram（`~/.engram/engram.db` 的 `observations` 表）。
 *     好处是跨设备只要拷这一个文件，不用 git、不用跑 `engram sync`。
 *     写卡片仍然走 engram 自己的 `mem_save`（我在会话里直接调），这里只读。
 *   - **边**存在边车库 `~/.dsh/memory/links.db`。
 *     理由：卡片是资产，边是可推导的——换机器时卡片随 db 走，边重算一遍就有。
 *     而且不往别人的库里加表，engram 升级/迁移时不会踩到我们。
 *
 * 三种边（架构文档定的）：
 *   derived_from  卡片 → 原话（archive 里的 id）
 *   supersedes    新卡替旧卡
 *   conflicts_with 两条矛盾
 *
 * **中文检索的坑**：engram 的 FTS5 用默认 tokenizer，不切中文词——
 * `MATCH '记忆'` 查不到任何东西（实测 96 条里 0 命中），所以这里
 * 先试 FTS，无结果再退回 LIKE，且 LIKE 是主力。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 三种边。别的名字一律拒收——这是架构文档定的口径，不是开放的字符串。 */
export const RELATIONS = Object.freeze(['derived_from', 'supersedes', 'conflicts_with']);

const DEFAULT_LIMIT = 20;
const MAX_CONTENT_CHARS = 4000;

/** node:sqlite 是 22.5+ 才有的，宿主是 v24，够用；老 node 下整层降级成不可用。 */
async function openSqlite(path, options = {}) {
  let mod;
  try {
    mod = await import('node:sqlite');
  } catch {
    return null;
  }
  if (typeof mod.DatabaseSync !== 'function') return null;
  try {
    // 注意：`new DatabaseSync(path, undefined)` 会抛 "options argument must be an object"，
    // 所以第二参必须给默认空对象，不能省略。
    return new mod.DatabaseSync(path, options);
  } catch {
    return null;
  }
}

function likeEscape(text) {
  return String(text).replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

function rowToCard(row) {
  if (row === null || typeof row !== 'object') return null;
  return {
    id: `obs:${row.id}`,
    obsId: Number(row.id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    type: String(row.type ?? 'manual'),
    project: typeof row.project === 'string' ? row.project : '',
    scope: String(row.scope ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

/**
 * 卡片库。只读 engram，读写边车库。
 *
 * @param {object} options
 *   - engramDb  engram 数据库路径（默认 `~/.engram/engram.db`）
 *   - linksDb   边车库路径（默认 `~/.dsh/memory/links.db`）
 *   - log       日志函数
 */
export async function createCards(options = {}) {
  const home = process.env.HOME ?? '';
  const {
    engramDb = join(home, '.engram', 'engram.db'),
    linksDb = join(home, '.dsh', 'memory', 'links.db'),
    log = () => {}
  } = options;

  const store = await openSqlite(engramDb, { readOnly: true });
  if (store === null) log('warn', '卡片层：打不开 engram 库（node:sqlite 不可用或路径不对），卡片功能降级');

  try {
    mkdirSync(dirname(linksDb), { recursive: true });
  } catch {
    // 建不出来就是只读环境，后面写边会失败但不影响读卡片。
  }
  const links = await openSqlite(linksDb);
  if (links !== null) {
    try {
      links.exec(`CREATE TABLE IF NOT EXISTS card_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_card TEXT NOT NULL,
        to_ref TEXT NOT NULL,
        relation TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      )`);
      links.exec('CREATE INDEX IF NOT EXISTS idx_links_from ON card_links(from_card, relation)');
      links.exec('CREATE INDEX IF NOT EXISTS idx_links_to ON card_links(to_ref, relation)');
    } catch (error) {
      log('warn', `卡片层：建边表失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function searchViaFts(text, limit) {
    if (store === null) return [];
    try {
      const rows = store
        .prepare(
          `SELECT o.id, o.title, o.content, o.type, o.project, o.scope, o.created_at, o.updated_at
             FROM observations_fts f JOIN observations o ON o.id = f.rowid
            WHERE observations_fts MATCH ? AND o.deleted_at IS NULL
            ORDER BY rank LIMIT ?`
        )
        .all(String(text), limit);
      return rows.map(rowToCard).filter((card) => card !== null);
    } catch {
      return [];
    }
  }

  function searchViaLike(text, limit) {
    if (store === null) return [];
    const pattern = `%${likeEscape(text)}%`;
    try {
      const rows = store
        .prepare(
          `SELECT id, title, content, type, project, scope, created_at, updated_at
             FROM observations
            WHERE deleted_at IS NULL
              AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
            ORDER BY created_at DESC LIMIT ?`
        )
        .all(pattern, pattern, limit);
      return rows.map(rowToCard).filter((card) => card !== null);
    } catch (error) {
      log('warn', `卡片层：LIKE 检索失败 ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  return {
    engramDb,
    linksDb,
    /** 后端是否可用（engram 库读不了就是 false）。 */
    get available() {
      return store !== null;
    },

    /**
     * 按文本找卡片。先 FTS 再 LIKE，合并去重，按时间倒序。
     */
    search(query = {}) {
      const { text = '', limit = DEFAULT_LIMIT, project = '' } = query;
      const cap = Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT));
      if (typeof text !== 'string' || text.trim() === '') return [];

      const merged = new Map();
      for (const card of searchViaFts(text, cap)) merged.set(card.id, card);
      for (const card of searchViaLike(text, cap)) if (!merged.has(card.id)) merged.set(card.id, card);

      let out = [...merged.values()];
      if (project !== '') out = out.filter((card) => card.project === project);
      out.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      return out.slice(0, cap);
    },

    /** 取单张卡片。接受 `obs:123` 或 `123`。 */
    get(id) {
      if (store === null) return null;
      const raw = String(id ?? '').replace(/^obs:/, '');
      const obsId = Number(raw);
      if (!Number.isFinite(obsId) || obsId <= 0) return null;
      try {
        const row = store
          .prepare(
            `SELECT id, title, content, type, project, scope, created_at, updated_at
               FROM observations WHERE id = ? AND deleted_at IS NULL`
          )
          .get(Math.trunc(obsId));
        return rowToCard(row);
      } catch {
        return null;
      }
    },

    /** 最近写进去的卡片（按创建时间倒序）。 */
    recent(query = {}) {
      if (store === null) return [];
      const { limit = DEFAULT_LIMIT, project = '' } = query;
      const cap = Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT));
      try {
        const rows =
          project === ''
            ? store
                .prepare(
                  `SELECT id, title, content, type, project, scope, created_at, updated_at
                     FROM observations WHERE deleted_at IS NULL
                    ORDER BY created_at DESC LIMIT ?`
                )
                .all(cap)
            : store
                .prepare(
                  `SELECT id, title, content, type, project, scope, created_at, updated_at
                     FROM observations WHERE deleted_at IS NULL AND project = ?
                    ORDER BY created_at DESC LIMIT ?`
                )
                .all(project, cap);
        return rows.map(rowToCard).filter((card) => card !== null);
      } catch {
        return [];
      }
    },

    /** 记一条边。relation 必须是三种之一，别的直接拒。 */
    link(fromCard, toRef, relation, meta = {}) {
      if (links === null) return { ok: false, error: 'edge_store_unavailable' };
      if (!RELATIONS.includes(relation)) {
        return { ok: false, error: `unknown_relation:${relation}`, allowed: RELATIONS };
      }
      if (typeof fromCard !== 'string' || fromCard === '' || typeof toRef !== 'string' || toRef === '') {
        return { ok: false, error: 'missing_endpoint' };
      }
      try {
        links
          .prepare('INSERT INTO card_links (from_card, to_ref, relation, reason, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(fromCard, toRef, relation, String(meta.reason ?? '').slice(0, 500), Date.now());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    /** 某个卡片出发的所有边。 */
    edges(fromCard, options = {}) {
      if (links === null) return [];
      const { relation = '' } = options;
      try {
        const rows =
          relation === ''
            ? links.prepare('SELECT * FROM card_links WHERE from_card = ? ORDER BY created_at DESC').all(String(fromCard))
            : links
                .prepare('SELECT * FROM card_links WHERE from_card = ? AND relation = ? ORDER BY created_at DESC')
                .all(String(fromCard), String(relation));
        return rows.map((row) => ({
          from: row.from_card,
          to: row.to_ref,
          relation: row.relation,
          reason: row.reason ?? '',
          at: row.created_at
        }));
      } catch {
        return [];
      }
    },

    /** 边车库里的全部边（维护层查悬空边要用）。 */
    allEdges(options = {}) {
      if (links === null) return [];
      const { limit = 5000 } = options;
      const cap = Math.max(1, Math.min(50_000, Number(limit) || 5000));
      try {
        const rows = links.prepare('SELECT * FROM card_links ORDER BY created_at DESC LIMIT ?').all(cap);
        return rows.map((row) => ({
          from: row.from_card,
          to: row.to_ref,
          relation: row.relation,
          reason: row.reason ?? '',
          at: row.created_at
        }));
      } catch {
        return [];
      }
    },

    /**
     * 多跳邻居。
     *
     * `depth=1` 只有直接相连的；`depth=2` 再走一层。
     * 只沿着边走到「别的卡片」时才继续展开；走到 archive 的原始 id 就停
     * （原话不会再连边，继续走没有意义）。
     */
    neighbors(cardId, options = {}) {
      const { depth = 1, relation = '' } = options;
      const maxDepth = Math.max(1, Math.min(3, Number(depth) || 1));
      const seen = new Set([String(cardId)]);
      const cards = [];
      const originals = [];
      let frontier = [String(cardId)];

      for (let hop = 0; hop < maxDepth; hop += 1) {
        const next = [];
        for (const current of frontier) {
          for (const edge of this.edges(current, { relation })) {
            if (edge.to.startsWith('obs:')) {
              if (seen.has(edge.to)) continue;
              seen.add(edge.to);
              const card = this.get(edge.to);
              if (card !== null) {
                cards.push({ ...card, via: edge.relation, from: current, hop: hop + 1 });
                next.push(edge.to);
              }
            } else {
              if (seen.has(edge.to)) continue;
              seen.add(edge.to);
              originals.push({ id: edge.to, via: edge.relation, from: current, hop: hop + 1 });
            }
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }

      return { card: String(cardId), cards, originals };
    },

    /** 统计。 */
    stat() {
      let observations = 0;
      let linksCount = 0;
      try {
        observations = store === null ? 0 : Number(store.prepare('SELECT count(*) c FROM observations WHERE deleted_at IS NULL').get()?.c ?? 0);
      } catch {
        observations = 0;
      }
      try {
        linksCount = links === null ? 0 : Number(links.prepare('SELECT count(*) c FROM card_links').get()?.c ?? 0);
      } catch {
        linksCount = 0;
      }
      return { observations, links: linksCount, engramDb, linksDb, available: store !== null };
    },

    /** 收尾：关掉两个连接。 */
    close() {
      try {
        store?.close();
      } catch {
        // 关不掉就算了。
      }
      try {
        links?.close();
      } catch {
        // 同上。
      }
    }
  };
}

/** 卡片正文截断，给工具输出用。 */
export function trimCard(card, maxChars = MAX_CONTENT_CHARS) {
  if (card === null || typeof card !== 'object') return null;
  return { ...card, content: String(card.content ?? '').slice(0, maxChars) };
}

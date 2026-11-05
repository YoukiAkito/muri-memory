/**
 * 检索层：给 agent 用的查询入口。
 *
 * 设计约束（照 Alaya 那份文档的思路，我认为是对的）：
 *   1. **内部不调 LLM**。概念提取由调用方（我）做，这一层只做检索。
 *   2. 返回的不只是结果，还有「还能往哪走」（`next`）和粗略距离（`h`），
 *      由调用方决定要不要继续挖——不是这一层替它决定什么时候够。
 *   3. 检索失败一律降级成空结果，不抛。
 *
 * 组合方式：
 *   文本 → cards.search → 每张卡片出发的边 → cards.neighbors（depth 跳）
 *        → 沿着 derived_from 走到 archive 取原话
 */
const DEFAULT_LIMIT = 10;
const DEFAULT_DEPTH = 1;

/** 启发式距离：越远数字越大。用来判断「还要不要继续挖」。 */
function heuristic(depth, remaining) {
  const depthPenalty = 0.1 * Math.max(0, depth - 1);
  const scarcity = 1 - Math.min(1, remaining / DEFAULT_LIMIT);
  return Number((0.5 * scarcity + 0.3 * 0 + 0.2 * depthPenalty).toFixed(3));
}

/**
 * @param {object} deps
 *   - cards   cards 层实例（必须有 search/get/edges/neighbors）
 *   - archive 档案层实例（可选，有的话能顺着 derived_from 取原话）
 *   - log     日志函数
 */
export function createRecall(deps = {}) {
  const { cards, archive, log = () => {} } = deps;

  return {
    /**
     * 主查询。
     *
     * @param {object} query
     *   - text        要查什么
     *   - limit       卡片上限（默认 10）
     *   - depth       从每张卡片往下走几跳（默认 1）
     *   - relation    只看某种边（可选）
     *   - originals   是否顺带取原话（默认 false，要 archive 在场）
     */
    recall(query = {}) {
      const {
        text = '',
        limit = DEFAULT_LIMIT,
        depth = DEFAULT_DEPTH,
        relation = '',
        originals = false
      } = query;

      const cap = Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT));
      const out = {
        cards: [],
        paths: [],
        originals: [],
        next: [],
        h: 1,
        note: ''
      };

      if (cards === undefined || cards === null || cards.available !== true) {
        out.note = 'cards_unavailable';
        out.h = 1;
        return out;
      }
      if (typeof text !== 'string' || text.trim() === '') {
        out.note = 'empty_query';
        return out;
      }

      let hits = [];
      try {
        hits = cards.search({ text: text.trim(), limit: cap });
      } catch (error) {
        log('warn', `检索层：卡片检索失败 ${error instanceof Error ? error.message : String(error)}`);
        out.note = 'search_failed';
        return out;
      }

      if (hits.length === 0) {
        out.note = 'no_hit';
        out.h = 1;
        return out;
      }

      const seen = new Set();
      const depthOf = new Map();
      for (const card of hits.slice(0, cap)) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        depthOf.set(card.id, 0);
        out.cards.push({ ...card, hop: 0 });

        let walk = { cards: [], originals: [] };
        try {
          walk = cards.neighbors(card.id, { depth, relation });
        } catch (error) {
          log('warn', `检索层：邻居遍历失败 ${error instanceof Error ? error.message : String(error)}`);
        }

        for (const neighbor of walk.cards) {
          if (seen.has(neighbor.id)) {
            out.paths.push({ from: card.id, to: neighbor.id, via: neighbor.via, hop: neighbor.hop, moved: true });
            continue;
          }
          seen.add(neighbor.id);
          depthOf.set(neighbor.id, neighbor.hop);
          out.cards.push(neighbor);
          out.paths.push({ from: neighbor.from, to: neighbor.id, via: neighbor.via, hop: neighbor.hop, moved: true });
        }
        for (const original of walk.originals) {
          out.paths.push({ from: original.from, to: original.id, via: original.via, hop: original.hop, moved: false });
          if (originals && !out.originals.some((item) => item.id === original.id)) {
            out.originals.push(original);
          }
        }
      }

      // 还能往哪走：走到了深度上限、但可能还有下一层的那些卡片。
      // 这是调用方决定「要不要再挖一层」的依据，不是我们替它决定停在哪。
      const frontier = out.cards.filter((card) => (depthOf.get(card.id) ?? 0) >= depth);
      out.next = frontier.slice(0, 3).map((card) => ({ id: card.id, title: card.title }));
      out.h = heuristic(depth, frontier.length);
      out.note = frontier.length === 0 ? 'covered' : 'more_available';

      if (originals && archive !== undefined && archive !== null) {
        const filled = [];
        for (const item of out.originals) {
          try {
            const record = archive.get(item.id);
            filled.push(record === null ? { ...item, text: '', missing: true } : { ...item, text: record.text, at: record.at });
          } catch {
            filled.push({ ...item, text: '', missing: true });
          }
        }
        out.originals = filled;
      }

      return out;
    },

    /** 只按边找邻居，不做文本检索（从某张已知卡片出发探索）。 */
    from(cardId, options = {}) {
      const { depth = DEFAULT_DEPTH, relation = '' } = options;
      if (cards === undefined || cards === null || cards.available !== true) {
        return { card: String(cardId), cards: [], originals: [], note: 'cards_unavailable' };
      }
      try {
        const walk = cards.neighbors(String(cardId), { depth, relation });
        return { ...walk, note: walk.cards.length === 0 && walk.originals.length === 0 ? 'isolated' : 'ok' };
      } catch (error) {
        log('warn', `检索层：从卡片出发失败 ${error instanceof Error ? error.message : String(error)}`);
        return { card: String(cardId), cards: [], originals: [], note: 'error' };
      }
    }
  };
}

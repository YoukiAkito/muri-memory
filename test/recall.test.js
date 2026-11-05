import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecall } from '../src/recall.js';

/** 假的卡片层：只实现 recall 用到的那几个方法。 */
function fakeCards({ hits = [], neighbours = {}, available = true } = {}) {
  return {
    get available() {
      return available;
    },
    search() {
      return hits;
    },
    neighbors(cardId) {
      return neighbours[cardId] ?? { card: cardId, cards: [], originals: [] };
    }
  };
}

test('卡片层不可用时降级，不抛', () => {
  const recall = createRecall({ cards: fakeCards({ available: false }) });
  const out = recall.recall({ text: '随便' });
  assert.equal(out.note, 'cards_unavailable');
  assert.deepEqual(out.cards, []);
});

test('空查询直接返回', () => {
  const recall = createRecall({ cards: fakeCards() });
  assert.equal(recall.recall({ text: '   ' }).note, 'empty_query');
  assert.equal(recall.recall({}).note, 'empty_query');
});

test('一张都没搜到', () => {
  const recall = createRecall({ cards: fakeCards({ hits: [] }) });
  const out = recall.recall({ text: '不存在的东西' });
  assert.equal(out.note, 'no_hit');
  assert.equal(out.h, 1);
});

test('搜到卡片就把邻居也带出来，并给出还能往哪走', () => {
  const card = { id: 'obs:1', title: '记忆架构', type: 'architecture' };
  const other = { id: 'obs:2', title: '另一张' };
  const third = { id: 'obs:3', title: '没走到的第三张' };
  const recall = createRecall({
    cards: fakeCards({
      hits: [card, other, third],
      neighbours: {
        'obs:1': {
          card: 'obs:1',
          cards: [{ ...other, via: 'derived_from', from: 'obs:1', hop: 1 }],
          originals: [{ id: 'qq:c2c:x:1', via: 'derived_from', from: 'obs:1', hop: 1 }]
        }
      }
    })
  });
  const out = recall.recall({ text: '记忆', limit: 5 });
  assert.equal(out.note, 'more_available');
  assert.deepEqual(out.cards.map((c) => c.id), ['obs:1', 'obs:2', 'obs:3']);
  assert.equal(out.paths.length, 2);
  const toOriginal = out.paths.find((p) => p.to === 'qq:c2c:x:1');
  assert.equal(toOriginal.moved, false);
  // 「还能往哪走」= 已经走到深度上限、可能还有下一层的卡片。
  // 这里 obs:1 和 obs:3 是命中项本身（hop 0，已经展开过了），只有走出来的 obs:2 在边界上。
  assert.equal(out.note, 'more_available');
  assert.deepEqual(out.next.map((n) => n.id), ['obs:2']);
});

test('originals 开着时顺手取原文，取不到标 missing', () => {
  const archive = {
    get(id) {
      return id === 'diary:2026-11-03' ? { id, text: '日记正文', at: 1 } : null;
    }
  };
  const recall = createRecall({
    cards: fakeCards({
      hits: [{ id: 'obs:1', title: 'x' }],
      neighbours: {
        'obs:1': {
          card: 'obs:1',
          cards: [],
          originals: [
            { id: 'diary:2026-11-03', via: 'derived_from', from: 'obs:1', hop: 1 },
            { id: 'diary:1999-01-01', via: 'derived_from', from: 'obs:1', hop: 1 }
          ]
        }
      }
    }),
    archive
  });
  const out = recall.recall({ text: 'x', originals: true });
  assert.equal(out.originals.length, 2);
  assert.equal(out.originals[0].text, '日记正文');
  assert.equal(out.originals[1].missing, true);
});

test('from() 走指定卡片，孤立时明确说 isolated', () => {
  const recall = createRecall({ cards: fakeCards({ neighbours: {} }) });
  assert.equal(recall.from('obs:9').note, 'isolated');
});

test('检索抛错时降级成 search_failed', () => {
  const recall = createRecall({
    cards: {
      get available() {
        return true;
      },
      search() {
        throw new Error('boom');
      },
      neighbors() {
        return { cards: [], originals: [] };
      }
    },
    log: () => {}
  });
  assert.equal(recall.recall({ text: 'x' }).note, 'search_failed');
});

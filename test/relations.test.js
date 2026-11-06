/**
 * 关系层的测试。
 *
 * 重点不是「能不能读出边」，是**来源可换**：
 *   - 只给一个来源，另一路就该安静地不出声；
 *   - 两个来源都有同一条关系时，不该重复出现；
 *   - 来源自己抛错，不能把整个关系层带崩。
 *
 * engram / 边车库的真实连接靠 node:sqlite，低版本 node 上没有，
 * 所以这里用假的 store / links（只要长得像 prepare().all() 就行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngramRelationSource, createLinkTableSource, createRelations } from '../src/relations.js';

/** 极简的假连接：只认 prepare(sql) 里出现的关键字，返回预设行。 */
function fakeDb(rows, options = {}) {
  const { countOnly = false, throws = false } = options;
  return {
    prepare(sql) {
      if (throws) throw new Error('boom');
      return {
        all(...args) {
          if (countOnly || /count\(\*\)/i.test(sql)) return [{ c: rows.length }];
          if (/FROM card_links/i.test(sql)) {
            // 只有带 `WHERE from_card = ?` 的那条才按参数过滤；
            // 全量查询传进来的是 limit，不能拿它当 from_card。
            if (!/WHERE from_card/i.test(sql)) return rows;
            const from = args[0];
            const relation = args[1];
            return rows.filter((row) => row.from_card === from && (relation === undefined || row.relation === relation));
          }
          return rows;
        },
        get() {
          if (countOnly || /count\(\*\)/i.test(sql)) return { c: rows.length };
          return rows[0] ?? null;
        },
        run() {
          return { changes: 1 };
        }
      };
    }
  };
}

test('engram 来源：judged 的关系才收，related/supersedes/conflicts_with 三个都认', () => {
  const rows = [
    { relation: 'related', reason: '同一条线', created_at: 100, sid: 1, tid: 2 },
    { relation: 'supersedes', reason: '新版本', created_at: 200, sid: 3, tid: 1 },
    { relation: 'conflicts_with', reason: '说法相反', created_at: 300, sid: 4, tid: 5 }
  ];
  const source = createEngramRelationSource({ store: fakeDb(rows) });
  const edges = source.all();
  assert.equal(edges.length, 3);
  assert.deepEqual(edges.map((edge) => edge.relation).sort(), ['conflicts_with', 'related', 'supersedes']);
  assert.ok(edges.every((edge) => edge.source === 'engram'));
  assert.equal(edges[0].from, 'obs:1');
  assert.equal(edges[0].to, 'obs:2');
});

test('engram 来源：没有 store 就是空的，不抛', () => {
  const source = createEngramRelationSource({ store: null });
  assert.equal(source.available, false);
  assert.deepEqual(source.all(), []);
  assert.deepEqual(source.edges('obs:1'), []);
  assert.equal(source.count(), 0);
});

test('engram 来源：SQL 炸了只打 warn，返回空数组', () => {
  const warns = [];
  const source = createEngramRelationSource({ store: fakeDb([], { throws: true }), log: (level, line) => warns.push(`${level}:${line}`) });
  assert.deepEqual(source.edges('obs:1'), []);
  assert.deepEqual(source.all(), []);
  assert.equal(source.count(), 0);
  assert.ok(warns.some((line) => line.startsWith('warn:')));
});

test('关系层：来源按顺序合并，同一条边不重复出现', () => {
  const engram = createEngramRelationSource({
    store: fakeDb([{ relation: 'related', reason: 'engram 判的', created_at: 100, sid: 1, tid: 2 }])
  });
  // 边车库里手滑补了同一条，应当被去重掉，而不是出现两遍。
  const links = createLinkTableSource({
    links: fakeDb([{ from_card: 'obs:1', to_ref: 'obs:2', relation: 'related', reason: '手动补的', created_at: 200 }])
  });
  const relations = createRelations({ sources: [engram, links] });
  const edges = relations.all();
  assert.equal(edges.length, 1);
  assert.equal(edges[0].reason, 'engram 判的', '先来的来源优先');
});

test('关系层：不同来源各说一条，两条都在，按时间倒序', () => {
  const engram = createEngramRelationSource({
    store: fakeDb([{ relation: 'supersedes', reason: '', created_at: 100, sid: 1, tid: 2 }])
  });
  const links = createLinkTableSource({
    links: fakeDb([{ from_card: 'obs:1', to_ref: 'qq:c2c:abc', relation: 'derived_from', reason: '', created_at: 300 }])
  });
  const relations = createRelations({ sources: [engram, links] });
  const edges = relations.all();
  assert.equal(edges.length, 2);
  assert.equal(edges[0].relation, 'derived_from', '时间新的在前');
  assert.equal(edges[1].relation, 'supersedes');
});

test('关系层：某个来源抛错不影响其他来源', () => {
  const broken = {
    name: 'broken',
    available: true,
    edges() {
      throw new Error('炸了');
    },
    all() {
      throw new Error('也炸了');
    },
    count() {
      throw new Error('还是炸了');
    }
  };
  const links = createLinkTableSource({
    links: fakeDb([{ from_card: 'obs:1', to_ref: 'obs:2', relation: 'related', reason: '', created_at: 1 }])
  });
  const relations = createRelations({ sources: [broken, links] });
  assert.equal(relations.edges('obs:1').length, 1);
  assert.equal(relations.all().length, 1);
  assert.equal(relations.stat().total, 1);
});

test('关系层：stat 分来源计数', () => {
  const engram = createEngramRelationSource({
    store: fakeDb([{ relation: 'related', reason: '', created_at: 1, sid: 1, tid: 2 }])
  });
  const links = createLinkTableSource({
    links: fakeDb([
      { from_card: 'obs:1', to_ref: 'sess:x', relation: 'derived_from', reason: '', created_at: 1 },
      { from_card: 'obs:2', to_ref: 'sess:y', relation: 'derived_from', reason: '', created_at: 2 }
    ])
  });
  const stat = createRelations({ sources: [engram, links] }).stat();
  assert.equal(stat.total, 3);
  assert.equal(stat.bySource.engram, 1);
  assert.equal(stat.bySource.links, 2);
});

test('关系层：sources 暴露每个来源的名字和可用状态', () => {
  const relations = createRelations({
    sources: [createEngramRelationSource({ store: null }), createLinkTableSource({ links: null })]
  });
  assert.deepEqual(relations.sources, [
    { name: 'engram', available: false },
    { name: 'links', available: false }
  ]);
});

test('边车库来源：只有正向，问反向就当没有', () => {
  const links = createLinkTableSource({
    links: fakeDb([{ from_card: 'obs:1', to_ref: 'obs:2', relation: 'derived_from', reason: '', created_at: 1 }])
  });
  assert.equal(links.edges('obs:1', { direction: 'out' }).length, 1);
  assert.equal(links.edges('obs:1', { direction: 'in' }).length, 0);
});

test('关系层：空的来源列表什么都不返回，但也不炸', () => {
  const relations = createRelations({ sources: [] });
  assert.deepEqual(relations.edges('obs:1'), []);
  assert.deepEqual(relations.all(), []);
  assert.deepEqual(relations.stat(), { total: 0, bySource: {} });
});

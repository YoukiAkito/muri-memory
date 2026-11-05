import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCards, RELATIONS, trimCard } from '../src/cards.js';

/** node:sqlite 是 22.5+ 才有的，低版本 node 上整个卡片层降级，这里只在能用时跑完整断言。 */
const sqliteAvailable = await (async () => {
  try {
    const mod = await import('node:sqlite');
    return typeof mod.DatabaseSync === 'function';
  } catch {
    return false;
  }
})();

/** 造一个最小的 engram 库（只建 cards 层会读的那几张表）。 */
async function makeEngram() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cards-'));
  const path = join(dir, 'engram.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT,
      project TEXT,
      scope TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, content, content='observations', content_rowid='id');
  `);
  const insert = db.prepare(
    `INSERT INTO observations (title, content, type, project, scope, created_at, updated_at)
     VALUES (?, ?, 'architecture', 'global', 'global', ?, ?)`
  );
  insert.run('记忆系统按层拆模块', '档案层 / 卡片层 / 检索层，层之间只通过接口通信', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z');
  insert.run('SSH 打通 2080Ti', '管理员公钥必须写进 administrators_authorized_keys', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z');
  db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
  db.close();
  return path;
}

test('读不到 engram 库时安静降级，不抛', async () => {
  const cards = await createCards({ engramDb: '/nonexistent.db', linksDb: join(mkdtempSync(join(tmpdir(), 'l-')), 'l.db') });
  assert.equal(cards.available, false);
  assert.deepEqual(cards.search({ text: 'x' }), []);
  assert.equal(cards.get('obs:1'), null);
  // 连边只写自己的 links.db，不碰 engram，所以卡片读不到时依然能连上——
  // 这也是降级设计的一部分：先攒关系，卡片库恢复后就能用。
  // （node 18 没有 node:sqlite，连边车库都开不了，那时只能是 false。）
  const result = cards.link('obs:1', 'obs:2', 'derived_from');
  assert.equal(result.ok, sqliteAvailable);
  assert.equal(cards.stat().links, sqliteAvailable ? 1 : 0);
  cards.close();
});

test('中文靠 LIKE 兜住，FTS 切不开也找得到', { skip: !sqliteAvailable }, async () => {
  const engramDb = await makeEngram();
  const linksDb = join(mkdtempSync(join(tmpdir(), 'l-')), 'links.db');
  const cards = await createCards({ engramDb, linksDb });
  assert.equal(cards.available, true);

  const zh = cards.search({ text: '记忆' });
  assert.ok(zh.length >= 1, '中文关键词应该能搜到');
  assert.match(zh[0].title, /记忆系统/);

  const en = cards.search({ text: 'SSH' });
  assert.ok(en.length >= 1);
  cards.close();
});

test('get 接受 obs: 前缀，不存在的返回 null', { skip: !sqliteAvailable }, async () => {
  const cards = await createCards({ engramDb: await makeEngram(), linksDb: join(mkdtempSync(join(tmpdir(), 'l-')), 'links.db') });
  assert.equal(cards.get('obs:1').obsId, 1);
  assert.equal(cards.get('1').obsId, 1);
  assert.equal(cards.get('obs:999'), null);
  assert.equal(cards.get('garbage'), null);
  cards.close();
});

test('连边：只认三种关系，多跳能走回来', { skip: !sqliteAvailable }, async () => {
  const cards = await createCards({ engramDb: await makeEngram(), linksDb: join(mkdtempSync(join(tmpdir(), 'l-')), 'links.db') });

  assert.deepEqual(RELATIONS, ['derived_from', 'supersedes', 'conflicts_with']);
  assert.equal(cards.link('obs:1', 'obs:2', 'derived_from', { reason: '从那张提炼的' }).ok, true);
  assert.equal(cards.link('obs:2', 'obs:1', 'supersedes').ok, true);

  const bad = cards.link('obs:1', 'obs:2', 'whatever');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_relation:whatever');

  const walk = cards.neighbors('obs:1', { depth: 1 });
  assert.deepEqual(walk.cards.map((c) => c.id), ['obs:2']);

  const filtered = cards.neighbors('obs:1', { depth: 1, relation: 'supersedes' });
  assert.deepEqual(filtered.cards, []);

  assert.equal(cards.stat().links, 2);
  cards.close();
});

test('走到非卡片 id 就停在 originals 里，不再往下走', { skip: !sqliteAvailable }, async () => {
  const cards = await createCards({ engramDb: await makeEngram(), linksDb: join(mkdtempSync(join(tmpdir(), 'l-')), 'links.db') });
  cards.link('obs:1', 'qq:c2c:3504:abc', 'derived_from');
  const walk = cards.neighbors('obs:1', { depth: 3 });
  assert.deepEqual(walk.cards, []);
  assert.deepEqual(walk.originals.map((o) => o.id), ['qq:c2c:3504:abc']);
  cards.close();
});

test('trimCard 截断正文，不是卡片就返回 null', () => {
  const card = { id: 'obs:1', content: 'x'.repeat(100) };
  assert.equal(trimCard(card, 10).content.length, 10);
  assert.equal(trimCard(null), null);
});

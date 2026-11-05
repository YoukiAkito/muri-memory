import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAINTAIN_DEFAULTS,
  cardSimilarity,
  createMaintain,
  findDanglingLinks,
  findDuplicates,
  isMaintainDue,
  lastMaintainAt,
  nextMaintainAt,
  resolveMaintainConfig,
  shouldMaintain
} from '../src/maintain.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'muri-memory-maintain-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveMaintainConfig：默认值', () => {
  const config = resolveMaintainConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.hour, MAINTAIN_DEFAULTS.hour);
  assert.equal(config.similarThreshold, MAINTAIN_DEFAULTS.similarThreshold);
});

test('resolveMaintainConfig：夹取区间、未知键丢弃', () => {
  const config = resolveMaintainConfig({ enabled: false, hour: 99, maxCards: 1, similarThreshold: 5, nope: 1 });
  assert.equal(config.enabled, false);
  assert.equal(config.hour, 23);
  assert.equal(config.maxCards, 10);
  assert.equal(config.similarThreshold, 1);
  assert.equal('nope' in config, false);
});

test('cardSimilarity：同一条为 1，毫不相干接近 0', () => {
  const left = { id: 'obs:1', title: '音色定档', content: '申鹤的中文配音加一个半音' };
  const same = { id: 'obs:1', title: '音色定档', content: '申鹤的中文配音加一个半音' };
  const other = { id: 'obs:2', title: 'SSH 打通', content: 'Windows 上要单独开防火墙端口 22' };
  assert.equal(cardSimilarity(left, same), 1);
  assert.ok(cardSimilarity(left, other) < 0.2);
});

test('cardSimilarity：标题一样、正文补全的新版本算高相似', () => {
  const oldCard = { id: 'obs:1', title: '音色定档', content: '申鹤一〇四' };
  const newCard = { id: 'obs:2', title: '音色定档', content: '申鹤一〇四，另外加语速零点八八' };
  assert.ok(cardSimilarity(oldCard, newCard) > 0.5);
});

test('findDuplicates：找出一对，且同一张卡不重复出现', () => {
  const cards = [
    { id: 'obs:1', title: '音色定档', content: '申鹤的中文配音加一个半音，语速零点八八' },
    { id: 'obs:2', title: '音色定档', content: '申鹤的中文配音加一个半音，语速零点八八。' },
    { id: 'obs:3', title: 'SSH 打通', content: 'Windows 上要单独开防火墙端口二十二' }
  ];
  const groups = findDuplicates(cards, { threshold: 0.9 });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].cards.map((card) => card.id).sort(), ['obs:1', 'obs:2']);
});

test('findDuplicates：maxGroups 上限生效', () => {
  const cards = [
    { id: 'obs:1', title: 'A 同样的话', content: '一模一样的一句话说两遍' },
    { id: 'obs:2', title: 'A 同样的话', content: '一模一样的一句话说两遍' },
    { id: 'obs:3', title: 'B 同样的话', content: '另一句一模一样的话说两遍' },
    { id: 'obs:4', title: 'B 同样的话', content: '另一句一模一样的话说两遍' }
  ];
  const groups = findDuplicates(cards, { threshold: 0.9, maxGroups: 1 });
  assert.equal(groups.length, 1);
});

test('findDanglingLinks：端点没了的才算悬空', () => {
  const described = new Set(['obs:1', 'obs:2']);
  const edges = [
    { from: 'obs:1', to: 'obs:2', relation: 'supersedes' },
    { from: 'obs:1', to: 'obs:999', relation: 'derived_from' },
    { from: 'obs:888', to: 'obs:2', relation: 'conflicts_with' },
    { from: 'obs:1', to: 'qq:c2c:3504:1', relation: 'derived_from' }
  ];
  const dangling = findDanglingLinks(edges, described);
  assert.equal(dangling.length, 2);
  assert.deepEqual(dangling.map((edge) => edge.reason).sort(), ['source_missing', 'target_missing']);
});

test('findDanglingLinks：给了 knownOriginal 才判原始 id', () => {
  const edges = [{ from: 'obs:1', to: 'qq:c2c:1', relation: 'derived_from' }];
  assert.equal(findDanglingLinks(edges, new Set(['obs:1'])).length, 0);
  const dangling = findDanglingLinks(edges, new Set(['obs:1']), { knownOriginal: (ref) => ref !== 'qq:c2c:1' });
  assert.equal(dangling.length, 1);
});

test('isMaintainDue：到了点、且今天还没跑', () => {
  const at = new Date(2026, 10, 5, 5, 30, 0, 0).getTime();
  const todayFive = new Date(2026, 10, 5, 5, 0, 0, 0).getTime();
  assert.equal(isMaintainDue(at, 5, todayFive - 60_000), true);
  assert.equal(isMaintainDue(at, 5, todayFive + 60_000), false);
});

test('isMaintainDue：还没到点，看昨天有没有跑', () => {
  const at = new Date(2026, 10, 5, 3, 0, 0, 0).getTime();
  const yesterdayFive = new Date(2026, 10, 4, 5, 0, 0, 0).getTime();
  assert.equal(isMaintainDue(at, 5, yesterdayFive + 60_000), false);
  assert.equal(isMaintainDue(at, 5, yesterdayFive - 60_000), true);
});

test('shouldMaintain：force / disabled / due', () => {
  const now = new Date(2026, 10, 5, 6, 0, 0, 0).getTime();
  const config = { enabled: true, hour: 5 };
  assert.deepEqual(shouldMaintain({}, { now, config, force: true }), { run: true, reason: 'forced' });
  assert.equal(shouldMaintain({}, { now, config: { enabled: false, hour: 5 } }).reason, 'disabled');
  assert.equal(shouldMaintain({ lastRunAt: 0 }, { now, config }).reason, 'due');
  assert.equal(shouldMaintain({ lastRunAt: now - 60_000 }, { now, config }).reason, 'too_early');
});

test('nextMaintainAt：过点顺延到明天', () => {
  const before = new Date(2026, 10, 5, 4, 0, 0, 0).getTime();
  const after = new Date(2026, 10, 5, 6, 0, 0, 0).getTime();
  assert.equal(nextMaintainAt(before, 5), new Date(2026, 10, 5, 5, 0, 0, 0).getTime());
  assert.equal(nextMaintainAt(after, 5), new Date(2026, 10, 6, 5, 0, 0, 0).getTime());
});

test('lastMaintainAt：没有记录返回 0', async () => {
  await withTempDir(async (dir) => {
    assert.equal(lastMaintainAt(join(dir, 'maintain-runs.jsonl')), 0);
  });
});

test('createMaintain：跑一次写出报告与记录', async () => {
  await withTempDir(async (dir) => {
    const cards = {
      recent: () => [
        { id: 'obs:1', title: '音色定档', content: '申鹤的中文配音加一个半音，语速零点八八' },
        { id: 'obs:2', title: '音色定档', content: '申鹤的中文配音加一个半音，语速零点八八。' }
      ]
    };
    const maintain = createMaintain({ cards, links: () => [], dataDir: dir });
    const result = await maintain.run({ enabled: true, hour: 5 }, { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.cards, 2);
    assert.equal(result.duplicates.length, 1);
    const report = maintain.lastReport();
    assert.equal(report.scanned, 2);
    assert.equal(report.dangling.length, 0);
  });
});

test('createMaintain：没到点不跑', async () => {
  await withTempDir(async (dir) => {
    const maintain = createMaintain({ cards: { recent: () => [] }, dataDir: dir });
    const result = await maintain.run({ enabled: false, hour: 5 }, { force: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
  });
});

test('createMaintain：卡片层抛错时安静失败', async () => {
  await withTempDir(async (dir) => {
    const cards = {
      recent: () => {
        throw new Error('boom');
      }
    };
    const maintain = createMaintain({ cards, dataDir: dir });
    const result = await maintain.run({ enabled: true, hour: 5 }, { force: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cards_failed');
  });
});

test('createMaintain：没有 cards 时报 no_cards', async () => {
  await withTempDir(async (dir) => {
    const maintain = createMaintain({ dataDir: dir });
    const result = await maintain.run({ enabled: true, hour: 5 }, { force: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_cards');
  });
});

test('createMaintain：悬空边被报出来', async () => {
  await withTempDir(async (dir) => {
    const cards = { recent: () => [{ id: 'obs:1', title: '甲', content: '内容甲' }] };
    const links = () => [{ from: 'obs:1', to: 'obs:404', relation: 'derived_from' }];
    const maintain = createMaintain({ cards, links, dataDir: dir });
    const result = await maintain.run({ enabled: true, hour: 5 }, { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.dangling.length, 1);
    assert.equal(result.dangling[0].reason, 'target_missing');
  });
});

test('createMaintain：state 文件不存在时 status 说该跑', async () => {
  await withTempDir(async (dir) => {
    const maintain = createMaintain({ cards: { recent: () => [] }, dataDir: dir });
    const status = maintain.status({ enabled: true, hour: 5 });
    assert.equal(status.reason, 'due');
    assert.equal(status.state.lastRunAt, 0);
  });
});

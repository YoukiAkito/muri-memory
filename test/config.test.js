import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js';

const env = { HOME: '/tmp/home' };

test('什么都不配时全用默认值', () => {
  const c = resolveConfig({ env, file: {} });
  assert.equal(c.enabled, true);
  assert.equal(c.dataDir, '/tmp/home/.dsh/memory');
  assert.equal(c.archive.dshHome, '/tmp/home/.dsh');
  assert.equal(c.archive.limit, DEFAULT_CONFIG.archive.limit);
  assert.equal(c.archive.days, DEFAULT_CONFIG.archive.days);
  assert.equal(c.cards.engramDb, '/tmp/home/.engram/engram.db');
  assert.equal(c.cards.linksDb, '/tmp/home/.dsh/memory/links.db');
  assert.equal(c.recall.limit, DEFAULT_CONFIG.recall.limit);
});

test('DSH_HOME 优先于 ~/.dsh', () => {
  const c = resolveConfig({ env: { HOME: '/tmp/home', DSH_HOME: '/opt/dsh' }, file: {} });
  assert.equal(c.archive.dshHome, '/opt/dsh');
});

test('dataDir 改了，边车库跟着走', () => {
  const c = resolveConfig({ env, file: { dataDir: '/tmp/mem' } });
  assert.equal(c.dataDir, '/tmp/mem');
  assert.equal(c.cards.linksDb, '/tmp/mem/links.db');
});

test('越界的数字被夹回区间，垃圾值回落默认', () => {
  const c = resolveConfig({
    env,
    file: { archive: { limit: 999999, days: 0 }, cards: { limit: -5 }, recall: { limit: 500, depth: 99 } }
  });
  assert.equal(c.archive.limit, 5000);
  assert.equal(c.archive.days, 1);
  assert.equal(c.cards.limit, 1);
  assert.equal(c.recall.limit, 50);
  assert.equal(c.recall.depth, 3);
});

test('enabled 只认布尔', () => {
  assert.equal(resolveConfig({ env, file: { enabled: false } }).enabled, false);
  assert.equal(resolveConfig({ env, file: { enabled: 'no' } }).enabled, true);
});

test('显式给的路径原样保留', () => {
  const c = resolveConfig({
    env,
    file: { archive: { qqHistory: '/tmp/qq' }, cards: { engramDb: '/tmp/e.db', linksDb: '/tmp/l.db' } }
  });
  assert.equal(c.archive.qqHistory, '/tmp/qq');
  assert.equal(c.cards.engramDb, '/tmp/e.db');
  assert.equal(c.cards.linksDb, '/tmp/l.db');
});

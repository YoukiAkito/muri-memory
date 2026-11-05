import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISTILL_DEFAULTS,
  resolveDistillConfig,
  startOfDayHour,
  nextRunAt,
  shouldDistill,
  readDistillState,
  writeDistillState,
  inWindow,
  tidyForDistill,
  renderRecords,
  buildDistillPrompt,
  createDistill
} from '../src/distill.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'muri-memory-distill-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveDistillConfig：空输入全默认', () => {
  const cfg = resolveDistillConfig(undefined);
  assert.equal(cfg.hour, DISTILL_DEFAULTS.hour);
  assert.equal(cfg.days, DISTILL_DEFAULTS.days);
  assert.equal(cfg.maxCards, DISTILL_DEFAULTS.maxCards);
  assert.equal(cfg.workerPreset, '');
});

test('resolveDistillConfig：区间夹取与未知键丢弃', () => {
  const cfg = resolveDistillConfig({ hour: 99, days: 0, maxChars: 1, maxCards: 1000, 乱写: 1 });
  assert.equal(cfg.hour, 23);
  assert.equal(cfg.days, 1);
  assert.equal(cfg.maxChars, 200);
  assert.equal(cfg.maxCards, 100);
  assert.equal(Object.hasOwn(cfg, '乱写'), false);
});

test('startOfDayHour 返回当天 hour 点整', () => {
  const now = new Date(2026, 10, 5, 15, 40, 12).getTime();
  const at = startOfDayHour(now, 4);
  const date = new Date(at);
  assert.equal(date.getHours(), 4);
  assert.equal(date.getMinutes(), 0);
  assert.equal(date.getDate(), 5);
});

test('nextRunAt：过了点就算明天', () => {
  const now = new Date(2026, 10, 5, 15, 40, 0).getTime();
  const next = new Date(nextRunAt(now, 4));
  assert.equal(next.getDate(), 6);
  assert.equal(next.getHours(), 4);

  const early = new Date(2026, 10, 5, 2, 0, 0).getTime();
  const sameDay = new Date(nextRunAt(early, 4));
  assert.equal(sameDay.getDate(), 5);
  assert.equal(sameDay.getHours(), 4);
});

test('shouldDistill：关掉就不跑，force 可以硬跑', () => {
  const now = new Date(2026, 10, 5, 15, 0, 0).getTime();
  const off = { enabled: false, hour: 4 };
  assert.deepEqual(shouldDistill({ lastRunAt: 0 }, { now, config: off }), { run: false, reason: 'disabled' });
  assert.equal(shouldDistill({ lastRunAt: 0 }, { now, config: off, force: true }).reason, 'forced');
});

test('shouldDistill：没到点、今天已跑、该跑', () => {
  const config = { enabled: true, hour: 4 };
  const early = new Date(2026, 10, 5, 2, 0, 0).getTime();
  assert.equal(shouldDistill({ lastRunAt: 0 }, { now: early, config }).reason, 'too_early');

  const afternoon = new Date(2026, 10, 5, 15, 0, 0).getTime();
  const ranToday = startOfDayHour(afternoon, 4) + 1000;
  assert.equal(shouldDistill({ lastRunAt: ranToday }, { now: afternoon, config }).reason, 'already_ran');

  const ranYesterday = startOfDayHour(afternoon, 4) - 20 * 3600_000;
  assert.deepEqual(shouldDistill({ lastRunAt: ranYesterday }, { now: afternoon, config }), { run: true, reason: 'due' });
});

test('inWindow 按时间过滤并升序', () => {
  const rows = [
    { at: 300, text: 'c' },
    { at: 100, text: 'a' },
    { at: 200, text: 'b' },
    { at: 400, text: 'd' }
  ];
  const out = inWindow(rows, { since: 150, until: 350 });
  assert.deepEqual(out.map((row) => row.text), ['b', 'c']);
  assert.deepEqual(inWindow(null, { since: 0, until: 1 }), []);
});

test('renderRecords 超字数时截断并说明', () => {
  const rows = [
    { at: 1, role: 'me', text: 'a'.repeat(50) },
    { at: 2, role: 'you', text: 'b'.repeat(50) }
  ];
  const text = renderRecords(rows, { maxChars: 60 });
  assert.match(text, /还有 1 条没放进来/);
  assert.equal(text.includes('b'.repeat(50)), false);
});

test('tidyForDistill 剥拆条标记、只留 [当前消息] 之后', () => {
  assert.equal(
    tidyForDistill('[群聊上下文·最近 2 条] 旧的 [19:14 我] 没有腿。 [当前消息] [2026-11-04 周三 23:44] 锐评一下 (@you)'),
    '锐评一下 (@you)'
  );
  assert.equal(tidyForDistill('前半段 <text_break> <next>.</next> </text_break> 后半段'), '前半段 后半段');
  assert.equal(tidyForDistill('   '), '');
});

test('renderRecords 顺手去重同一句话', () => {
  const rows = [
    { at: 1, role: 'user', text: '同一句' },
    { at: 2, role: 'user', text: '同一句' },
    { at: 3, role: 'assistant', text: '别的话' }
  ];
  const text = renderRecords(rows, { maxChars: 999 });
  assert.equal(text.split('\n').length, 2);
});

test('buildDistillPrompt 写的是判断标准，不是关键词', () => {
  const prompt = buildDistillPrompt({ recordsText: '- [x] me: 聊了什么', since: 0, until: 1000, count: 1, maxCards: 5 });
  assert.match(prompt, /# 这是一次记忆提炼/);
  assert.match(prompt, /最多 5 张/);
  assert.match(prompt, /不要存「继续」「好」「打错了」/);
  assert.match(prompt, /- \[x\] me: 聊了什么/);
});

test('writeDistillState / readDistillState 往返', async () => {
  await withTempDir((dir) => {
    const path = join(dir, 'distill-state.json');
    assert.deepEqual(readDistillState(path), { lastRunAt: 0, lastOk: null, lastSavedIds: [] });
    writeDistillState(path, { lastRunAt: 123, lastOk: true, lastSavedIds: ['obs:1'] });
    assert.deepEqual(readDistillState(path), { lastRunAt: 123, lastOk: true, lastSavedIds: ['obs:1'] });
  });
});

test('createDistill：没到点不跑，也不叫 worker', async () => {
  await withTempDir(async (dir) => {
    let called = 0;
    const distill = createDistill({
      archive: { scan: () => [] },
      cards: { recent: () => [] },
      createWorker: async () => {
        called += 1;
      },
      dataDir: dir,
      now: () => new Date(2026, 10, 5, 2, 0, 0).getTime()
    });
    const result = await distill.run({ enabled: true, hour: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too_early');
    assert.equal(called, 0);
  });
});

test('createDistill：扫不到东西也记水位，不重复扫', async () => {
  await withTempDir(async (dir) => {
    let scans = 0;
    const distill = createDistill({
      archive: {
        scan: () => {
          scans += 1;
          return [];
        }
      },
      cards: { recent: () => [] },
      createWorker: async () => {},
      dataDir: dir,
      now: () => new Date(2026, 10, 5, 15, 0, 0).getTime()
    });
    const first = await distill.run({ enabled: true, hour: 4 });
    assert.equal(first.ok, true);
    assert.equal(first.reason, 'nothing_to_distill');
    assert.equal(scans, 1);

    const second = await distill.run({ enabled: true, hour: 4 });
    assert.equal(second.reason, 'already_ran');
    assert.equal(scans, 1);
  });
});

test('createDistill：跑一次能挑出新增的卡', async () => {
  await withTempDir(async (dir) => {
    const now = new Date(2026, 10, 5, 15, 0, 0).getTime();
    const records = [
      { at: now - 60_000, role: 'you', text: '这次要记住，别把私聊发群里' },
      { at: now - 30_000, role: 'me', text: '好' }
    ];
    const existing = [{ id: 'obs:1', title: '旧卡' }];
    let prompt = '';
    const distill = createDistill({
      archive: { scan: () => records },
      cards: { recent: () => [...existing] },
      createWorker: async ({ prompt: text, timeBoxMs }) => {
        prompt = text;
        assert.equal(timeBoxMs, DISTILL_DEFAULTS.timeBoxMs);
        existing.unshift({ id: 'obs:2', title: '新卡' });
      },
      dataDir: dir,
      now: () => now
    });
    const result = await distill.run({ enabled: true, hour: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.windowed, 2);
    assert.deepEqual(result.newCards.map((card) => card.id), ['obs:2']);
    assert.match(prompt, /别把私聊发群里/);
    assert.deepEqual(readDistillState(join(dir, 'distill-state.json')).lastSavedIds, ['obs:2']);
  });
});

test('createDistill：worker 抛错时记 warn，不抛', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const now = new Date(2026, 10, 5, 15, 0, 0).getTime();
    const distill = createDistill({
      archive: { scan: () => [{ at: now - 1000, role: 'you', text: 'hi' }] },
      cards: { recent: () => [] },
      createWorker: async () => {
        throw new Error('拿不到默认模型选择');
      },
      dataDir: dir,
      log: (level, message) => warnings.push(`${level}:${message}`),
      now: () => now
    });
    const result = await distill.run({ enabled: true, hour: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'worker_failed');
    assert.equal(warnings.length > 0, true);
    // 失败不写水位，下个窗口还会重试。
    assert.equal(readDistillState(join(dir, 'distill-state.json')).lastRunAt, 0);
  });
});

test('createDistill：没有 archive 或 worker 时安静失败', async () => {
  const at = new Date(2026, 10, 5, 15, 0, 0).getTime();
  const noArchive = createDistill({ dataDir: '', now: () => at });
  assert.equal((await noArchive.run({ enabled: true, hour: 4 })).reason, 'no_archive');

  const noWorker = createDistill({ archive: { scan: () => [] }, dataDir: '', now: () => at });
  assert.equal((await noWorker.run({ enabled: true, hour: 4 })).reason, 'no_worker');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanText,
  listQqPeers,
  parsePeerDir,
  parseSessionRow,
  readDiary,
  readQqRecords,
  createArchive
} from '../src/archive.js';

function tempDir(prefix = 'dsh-mem-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('cleanText 剥掉消息号与时间前缀，最多三层', () => {
  assert.equal(cleanText('[消息号: 1105hx]\n[2026-11-05 周四 15:21]\n行，那就挂到宿主上'), '行，那就挂到宿主上');
  assert.equal(cleanText('[2026-11-05 周四 15:21] 只有时间前缀'), '只有时间前缀');
  assert.equal(cleanText('没什么可剥的'), '没什么可剥的');
  assert.equal(cleanText(''), '');
});

test('parsePeerDir 认得两种目录名', () => {
  assert.deepEqual(parsePeerDir('c2c_3504E2DF'), { scope: 'c2c', peerId: '3504E2DF' });
  assert.deepEqual(parsePeerDir('group_FBA4A3F0'), { scope: 'group', peerId: 'FBA4A3F0' });
  assert.equal(parsePeerDir('other_x'), null);
  assert.equal(parsePeerDir(null), null);
});

test('parseSessionRow 只留真人的 user/message', () => {
  const row = {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '[消息号: 1]\n你好' }]
    }
  };
  const parsed = parseSessionRow(row, { peer: 'session:abc', includeAssistant: false });
  assert.equal(parsed.text, '你好');
  assert.equal(parsed.role, 'user');

  const injected = {
    type: 'user/message',
    data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '系统注入' }] }
  };
  assert.equal(parseSessionRow(injected, { peer: 'session:abc' }), null);
});

test('parseSessionRow 的 assistant 消息 source 在 data.message 上', () => {
  const row = {
    type: 'assistant/message',
    data: {
      message: { source: { kind: 'model' }, content: [{ type: 'text', text: '我说的话' }] }
    }
  };
  assert.equal(parseSessionRow(row, { peer: 'p', includeAssistant: false }), null);
  const parsed = parseSessionRow(row, { peer: 'p', includeAssistant: true });
  assert.equal(parsed.role, 'assistant');
  assert.equal(parsed.text, '我说的话');
});

test('读 QQ 台账：跳过空正文、能按发送者过滤', () => {
  const root = tempDir();
  const dir = join(root, 'c2c_ABC123');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const rows = [
    { id: 'a', s: 'ABC123', n: '沫沫', t: now - 3000, k: 'text', x: '[2026-11-05 周四 15:00]\n第一句' },
    { id: 'b', s: 'self', n: '瑠璃', t: now - 2000, k: 'text', x: '我的回复', me: true },
    { id: 'c', s: 'ABC123', n: '沫沫', t: now - 1000, k: 'text', x: '' }
  ];
  writeFileSync(join(dir, '2099-01-01.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  assert.deepEqual(listQqPeers(root), ['c2c_ABC123']);

  const all = readQqRecords(root, { days: 3, limit: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].text, '第一句');
  assert.equal(all[1].role, 'assistant');

  const onlyHer = readQqRecords(root, { days: 3, limit: 10, fromSelf: false });
  assert.equal(onlyHer.length, 1);
  assert.equal(onlyHer[0].text, '第一句');
});

test('读日记：按文件名取日期，空的跳过', () => {
  const root = tempDir();
  writeFileSync(join(root, '2026-11-03.md'), '今天写了两处记忆引用过期\n', 'utf8');
  writeFileSync(join(root, '2026-11-04.md'), '   \n', 'utf8');
  writeFileSync(join(root, 'not-a-date.md'), '不该被读到', 'utf8');
  const rows = readDiary(root, { days: 7, limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'diary:2026-11-03');
  assert.equal(rows[0].role, 'assistant');
});

test('createArchive 的 stat 在目录不存在时也不炸', () => {
  const archive = createArchive({ dshHome: join(tempDir(), 'nope'), qqHistory: '', log: () => {} });
  const snapshot = archive.stat();
  assert.equal(snapshot.sessions, 0);
  assert.equal(snapshot.qqPeers, 0);
  assert.equal(snapshot.diaryDays, 0);
  assert.deepEqual(archive.scan({}), []);
});

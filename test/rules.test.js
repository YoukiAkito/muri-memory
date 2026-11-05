import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RULE_DEFAULTS,
  createRules,
  loadRules,
  matchRules,
  parseRule,
  renderRules,
  resolveRuleConfig
} from '../src/rules.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-rules-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveRuleConfig：默认值', () => {
  const config = resolveRuleConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.maxRules, RULE_DEFAULTS.maxRules);
});

test('resolveRuleConfig：夹取与未知键', () => {
  const config = resolveRuleConfig({ enabled: false, maxRules: 999, other: 1 });
  assert.equal(config.enabled, false);
  assert.equal(config.maxRules, 20);
  assert.equal('other' in config, false);
});

test('parseRule：带头，name 与 when 都读到', () => {
  const rule = parseRule(['---', 'name: 私聊不外流', 'when: 私聊 转发 群里', '---', '私聊里说的话别转发。'].join('\n'), 'fallback');
  assert.equal(rule.name, '私聊不外流');
  assert.equal(rule.body, '私聊里说的话别转发。');
  assert.deepEqual(rule.keywords, ['私聊', '转发', '群里']);
});

test('parseRule：没有头就当全篇是正文，用文件名兜底', () => {
  const rule = parseRule('不知道就说不知道。', '不知道就说不知道');
  assert.equal(rule.name, '不知道就说不知道');
  assert.equal(rule.body, '不知道就说不知道。');
  assert.deepEqual(rule.keywords, []);
});

test('parseRule：头没闭合就整篇当正文', () => {
  const rule = parseRule(['---', 'name: 半截', '正文'].join('\n'), 'x');
  assert.equal(rule.body.includes('name: 半截'), true);
});

test('parseRule：分隔符支持逗号和顿号', () => {
  const rule = parseRule(['---', 'when: 私聊,转发、群里|泄露', '---', '正文'].join('\n'), 'x');
  assert.deepEqual(rule.keywords, ['私聊', '转发', '群里', '泄露']);
});

test('loadRules：目录不存在返回空数组', () => {
  assert.deepEqual(loadRules('/definitely/not/here'), []);
});

test('loadRules：按文件名排序，空正文的跳过', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'b.md'), '第二条规矩。', 'utf8');
    writeFileSync(join(dir, 'a.md'), ['---', 'name: 第一条', 'when: 甲', '---', '第一条正文。'].join('\n'), 'utf8');
    writeFileSync(join(dir, 'c.md'), '   \n  ', 'utf8');
    writeFileSync(join(dir, 'ignore.txt'), '不是 markdown', 'utf8');
    const rules = loadRules(dir);
    assert.deepEqual(rules.map((rule) => rule.file), ['a.md', 'b.md']);
  });
});

test('matchRules：无关键词的永远命中，有关键词的按命中数排', () => {
  const rules = [
    { name: '永远', keywords: [], body: '永远适用' },
    { name: '一对一', keywords: ['私聊'], body: '沾边' },
    { name: '两个都中', keywords: ['私聊', '转发'], body: '很相关' }
  ];
  const hits = matchRules(rules, '把私聊的内容转发到群里', { maxRules: 3 });
  assert.deepEqual(hits.map((hit) => hit.rule.name), ['两个都中', '一对一', '永远']);
  assert.deepEqual(hits[0].matched, ['私聊', '转发']);
});

test('matchRules：一个都没命中就不出现', () => {
  const rules = [{ name: '无关', keywords: ['显存'], body: '正文' }];
  assert.deepEqual(matchRules(rules, '今天天气不错'), []);
});

test('matchRules：maxRules 生效', () => {
  const rules = [
    { name: '一', keywords: ['甲'], body: 'x' },
    { name: '二', keywords: ['甲'], body: 'y' },
    { name: '三', keywords: ['甲'], body: 'z' }
  ];
  assert.equal(matchRules(rules, '甲', { maxRules: 2 }).length, 2);
});

test('matchRules：大小写不敏感', () => {
  const rules = [{ name: '英文', keywords: ['SSH'], body: 'x' }];
  assert.equal(matchRules(rules, 'ssh 端口怎么开').length, 1);
});

test('renderRules：拼成一段带标题的文字', () => {
  const text = renderRules([{ rule: { name: '私聊不外流', body: '别转发。' }, matched: ['私聊'] }]);
  assert.equal(text, ['## 现在适用的规矩', '- 私聊不外流：别转发。'].join('\n'));
});

test('renderRules：没命中返回空串', () => {
  assert.equal(renderRules([]), '');
  assert.equal(renderRules(null), '');
});

test('createRules：建目录、读文件、按上下文筛', async () => {
  await withTempDir(async (dir) => {
    const rulesDir = join(dir, 'rules');
    const rules = createRules({ rulesDir });
    assert.equal(rules.stat().count, 0);
    writeFileSync(join(rulesDir, 'a.md'), ['---', 'name: 不外流', 'when: 转发', '---', '别转发到群里。'].join('\n'), 'utf8');
    assert.equal(rules.stat().count, 1);
    assert.equal(rules.stat().withCondition, 1);
    const text = rules.render('这段要不要转发出去');
    assert.ok(text.includes('不外流'));
    assert.equal(rules.render('别的事'), '');
  });
});

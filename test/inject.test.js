import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INJECT_DEFAULTS,
  RULE_SECTION_NAME,
  RULE_SECTION_ORDER,
  createMessageBuffer,
  extractMessageText,
  recentMessageText,
  resolveInjectConfig
} from '../src/inject.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-inject-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('section 名带前缀，排在交付引用之后、结构化输出之前', () => {
  assert.equal(RULE_SECTION_NAME, 'memory:rules');
  assert.ok(RULE_SECTION_ORDER > 9000);
  assert.ok(RULE_SECTION_ORDER < 9900);
});

test('默认配置：开着、攒三条、四千字', () => {
  const config = resolveInjectConfig({});
  assert.deepEqual(config, {
    enabled: true,
    contextMessages: INJECT_DEFAULTS.contextMessages,
    contextChars: INJECT_DEFAULTS.contextChars
  });
});

test('非对象输入走默认值', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const config = resolveInjectConfig(bad);
    assert.equal(config.enabled, true);
    assert.equal(config.contextMessages, 3);
  }
});

test('数值被夹进取值范围', () => {
  const low = resolveInjectConfig({ contextMessages: 0, contextChars: 1 });
  assert.equal(low.contextMessages, 1);
  assert.equal(low.contextChars, 200);

  const high = resolveInjectConfig({ contextMessages: 999, contextChars: 9_999_999 });
  assert.equal(high.contextMessages, 20);
  assert.equal(high.contextChars, 40_000);

  const junk = resolveInjectConfig({ contextMessages: 'abc', contextChars: null });
  assert.equal(junk.contextMessages, 3);
  assert.equal(junk.contextChars, 4000);
});

test('enabled 只认布尔，别的字符串不当真', () => {
  assert.equal(resolveInjectConfig({ enabled: false }).enabled, false);
  assert.equal(resolveInjectConfig({ enabled: 'false' }).enabled, true);
});

test('extractMessageText 只取文本块并 trim', () => {
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: '  你好  ' },
      { type: 'image', source: {} },
      { type: 'text', text: '   ' },
      { type: 'text', text: '第二行' }
    ]
  };
  assert.equal(extractMessageText(message), '你好\n第二行');
});

test('extractMessageText 对畸形输入返回空串', () => {
  assert.equal(extractMessageText(undefined), '');
  assert.equal(extractMessageText({}), '');
  assert.equal(extractMessageText({ content: 'string' }), '');
  assert.equal(extractMessageText({ content: [null, 1, { type: 'text' }] }), '');
});

test('buffer 只留最后几条', () => {
  const buffer = createMessageBuffer({ limit: 2, maxChars: 4000 });
  buffer.push('一');
  buffer.push('二');
  buffer.push('三');
  assert.equal(buffer.size, 2);
  assert.equal(buffer.text(), '二\n三');
});

test('buffer 接受消息对象', () => {
  const buffer = createMessageBuffer({ limit: 3, maxChars: 4000 });
  buffer.push({ content: [{ type: 'text', text: '她说的话' }] });
  assert.equal(buffer.text(), '她说的话');
});

test('buffer 空文本不入账', () => {
  const buffer = createMessageBuffer({ limit: 3, maxChars: 4000 });
  buffer.push('');
  buffer.push('   ');
  buffer.push({ content: [] });
  assert.equal(buffer.size, 0);
  assert.equal(buffer.text(), '');
});

test('buffer 超长时截尾，保留最近的', () => {
  const buffer = createMessageBuffer({ limit: 1, maxChars: 200 });
  buffer.push('a'.repeat(500) + 'TAIL');
  assert.equal(buffer.text().length, 200);
  assert.ok(buffer.text().endsWith('TAIL'));
});

test('buffer clear 清空', () => {
  const buffer = createMessageBuffer();
  buffer.push('一');
  buffer.clear();
  assert.equal(buffer.size, 0);
  assert.equal(buffer.text(), '');
});

test('recentMessageText 只挑 user 消息、倒着取够就停', () => {
  const agent = {
    session: {
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '最早那句' }] },
        { role: 'assistant', content: [{ type: 'text', text: '文件' }] },
        { role: 'user', content: [{ type: 'text', text: '中间那句' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好' }] },
        { role: 'user', content: [{ type: 'text', text: '最新那句' }] }
      ]
    }
  };
  assert.equal(recentMessageText(agent, { limit: 2 }), '中间那句\n最新那句');
});

test('recentMessageText 素材超长时截尾', () => {
  const agent = {
    session: {
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(900) + 'END' }] }]
    }
  };
  const text = recentMessageText(agent, { limit: 3, maxChars: 200 });
  assert.equal(text.length, 200);
  assert.ok(text.endsWith('END'));
});

test('recentMessageText 拿不到会话时返回空串，不抛', () => {
  assert.equal(recentMessageText(undefined), '');
  assert.equal(recentMessageText({}), '');
  assert.equal(recentMessageText({ session: {} }), '');
  assert.equal(recentMessageText({ session: { deriveMessages: () => { throw new Error('boom'); } } }), '');
});

test('recentMessageText 没有 user 消息时返回空串', () => {
  const agent = {
    session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '我说的' }] }] }
  };
  assert.equal(recentMessageText(agent), '');
});

test('recentMessageText 在临时目录里也能跑（无副作用）', async () => {
  await withTempDir(async (dir) => {
    const agent = {
      session: { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: dir }] }] }
    };
    assert.equal(recentMessageText(agent), dir);
  });
});

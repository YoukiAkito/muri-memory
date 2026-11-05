import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERSONA_DEFAULTS,
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  createPersona,
  readPersonaFile,
  resolvePersonaConfig,
  writePersonaFile
} from '../src/persona.js';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-persona-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('section 名和排位：比 profile 的 persona 正位还靠前', () => {
  assert.equal(PERSONA_SECTION_NAME, 'memory:persona');
  assert.ok(PERSONA_SECTION_ORDER < 0, '排在 DEPLOYMENT_PERSONA_PREFIX(0) 之前');
});

test('默认配置：开着、不指定路径、上限一万二', () => {
  assert.deepEqual(resolvePersonaConfig({}), {
    enabled: true,
    file: '',
    maxChars: PERSONA_DEFAULTS.maxChars
  });
});

test('非对象输入走默认值', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(resolvePersonaConfig(bad).enabled, true);
  }
});

test('maxChars 被夹进取值范围', () => {
  assert.equal(resolvePersonaConfig({ maxChars: 1 }).maxChars, 500);
  assert.equal(resolvePersonaConfig({ maxChars: 999999 }).maxChars, 60000);
  assert.equal(resolvePersonaConfig({ maxChars: 'abc' }).maxChars, PERSONA_DEFAULTS.maxChars);
});

test('enabled 只认布尔', () => {
  assert.equal(resolvePersonaConfig({ enabled: false }).enabled, false);
  assert.equal(resolvePersonaConfig({ enabled: 'false' }).enabled, true);
});

test('读不到文件时说清楚为什么', () => {
  assert.equal(readPersonaFile('').reason, 'no_path');
  assert.equal(readPersonaFile(undefined).reason, 'no_path');
  assert.equal(readPersonaFile('/definitely/not/here.md').reason, 'missing');
});

test('空文件当没人设', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.md');
    writeFileSync(path, '   \n\n  ');
    assert.equal(readPersonaFile(path).reason, 'empty');
  });
});

test('目录不算人设文件', async () => {
  await withTempDir(async (dir) => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    assert.equal(readPersonaFile(sub).reason, 'not_a_file');
  });
});

test('读出来会 trim，超长截断', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.md');
    writeFileSync(path, `\n\n  你是某某。\n第二行。\n\n`);
    const read = readPersonaFile(path);
    assert.equal(read.ok, true);
    assert.equal(read.text, '你是某某。\n第二行。');

    const long = 'a'.repeat(2000);
    writeFileSync(path, long);
    assert.equal(readPersonaFile(path, { maxChars: 500 }).text.length, 500);
  });
});

test('写空的要报错', async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => writePersonaFile(join(dir, 'p.md'), '   '), /不能写空/);
  });
});

test('写进去加一个换行，读回来一致', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'persona.md');
    const result = writePersonaFile(path, '你是某某。');
    assert.equal(result.ok, true);
    assert.equal(result.chars, 5);
    assert.equal(readFileSync(path, 'utf8'), '你是某某。\n');
    assert.equal(readPersonaFile(path).text, '你是某某。');
  });
});

test('createPersona：默认路径在 dataDir 下', async () => {
  await withTempDir(async (dir) => {
    const persona = createPersona({ dataDir: dir, config: resolvePersonaConfig({}) });
    assert.equal(persona.file, join(dir, 'persona.md'));
    assert.equal(persona.text(), '');
    assert.equal(persona.exists(), false);
    assert.equal(persona.stat().present, false);
    assert.equal(persona.stat().reason, 'missing');
  });
});

test('createPersona：指定了 file 就用它', async () => {
  await withTempDir(async (dir) => {
    const custom = join(dir, 'somewhere', 'me.md');
    mkdirSync(join(dir, 'somewhere'));
    writeFileSync(custom, '我是谁');
    const persona = createPersona({ dataDir: dir, config: resolvePersonaConfig({ file: custom }) });
    assert.equal(persona.file, custom);
    assert.equal(persona.text(), '我是谁');
    assert.equal(persona.stat().chars, 3);
  });
});

test('createPersona：put 之后 text 立刻变（每轮现读，不用重启）', async () => {
  await withTempDir(async (dir) => {
    const persona = createPersona({ dataDir: dir, config: resolvePersonaConfig({}) });
    assert.equal(persona.text(), '');
    const saved = persona.put('新的我');
    assert.equal(saved.ok, true);
    assert.equal(persona.text(), '新的我');
    assert.equal(persona.exists(), true);
  });
});

test('createPersona：关掉时 put 拒绝但读照旧', async () => {
  await withTempDir(async (dir) => {
    const persona = createPersona({ dataDir: dir, config: resolvePersonaConfig({ enabled: false }) });
    const saved = persona.put('新的我');
    assert.equal(saved.ok, false);
    assert.equal(saved.error, 'disabled');
    assert.equal(persona.text(), '');
  });
});

test('createPersona：读不出来的原因会记 warn，missing 不吵', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const log = (level, message) => warnings.push(`${level}:${message}`);
    const persona = createPersona({ dataDir: dir, config: resolvePersonaConfig({}) });
    persona.text();
    assert.equal(warnings.length, 0, '文件不存在不该打 warn');

    const broken = createPersona({
      dataDir: dir,
      config: resolvePersonaConfig({ file: join(dir, 'sub') }),
      log
    });
    mkdirSync(join(dir, 'sub'));
    broken.text();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^warn:/);
  });
});

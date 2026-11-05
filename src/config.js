/**
 * 配置。
 *
 * 全部字段都能用 `<dataDir>/config.json` 覆盖；没有配置文件时就全是默认值。
 * 加新字段时记得同步三处：DEFAULT_CONFIG、resolveConfig 的返回对象、
 * 以及 config.example.json（用 node 从 DEFAULT_CONFIG 重新导一遍就行）。
 *
 * 这个插件**不会回写** config.json —— 配置只有人改，工具只读。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './util.js';
import { DISTILL_DEFAULTS, resolveDistillConfig } from './distill.js';
import { MAINTAIN_DEFAULTS, resolveMaintainConfig } from './maintain.js';
import { RULE_DEFAULTS, resolveRuleConfig } from './rules.js';
import { INJECT_DEFAULTS, resolveInjectConfig } from './inject.js';
import { PERSONA_DEFAULTS, resolvePersonaConfig } from './persona.js';

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 数据目录（边车库、缓存）。空 = `~/.dsh/memory`。 */
  dataDir: '',
  archive: {
    /** DSH 根目录。空 = `$DSH_HOME` 或 `~/.dsh`。 */
    dshHome: '',
    /** QQ 台账根。空 = 自动探测 `<workspace>/.qqbot` 与 `~/.dsh/qqbot`。 */
    qqHistory: '',
    /** 一次 scan 最多多少条。 */
    limit: 200,
    /** 默认往回几天。 */
    days: 2
  },
  cards: {
    /** engram 数据库路径。空 = `~/.engram/engram.db`。 */
    engramDb: '',
    /** 边车库路径。空 = `<dataDir>/links.db`。 */
    linksDb: '',
    /** 一次 search 最多多少张卡。 */
    limit: 20
  },
  recall: {
    limit: 10,
    depth: 1
  },
  /** 提炼层：定时把流水炼成卡片。字段说明见 distill.js 的 DISTILL_DEFAULTS。 */
  distill: { ...DISTILL_DEFAULTS },
  /** 维护层：定时巡检。字段说明见 maintain.js 的 MAINTAIN_DEFAULTS。 */
  maintain: { ...MAINTAIN_DEFAULTS },
  /** 规则层：只做加载器和匹配，规则内容她自己写。 */
  rules: { ...RULE_DEFAULTS },
  /** 注入：把规则层筛出来的几条挂进每轮的系统提示。字段见 inject.js。 */
  inject: { ...INJECT_DEFAULTS },
  /** 人设层：读 `<dataDir>/persona.md`，每轮挂进系统提示。字段见 persona.js。 */
  persona: { ...PERSONA_DEFAULTS }
};

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function intOf(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function section(raw, key) {
  const value = raw?.[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** 组装最终配置。file 是 `<dataDir>/config.json` 解析出来的对象。 */
export function resolveConfig(input = {}) {
  const { env = process.env, file = {} } = input;
  const home = env.HOME ?? '';
  const dataDirRaw = str(file.dataDir, DEFAULT_CONFIG.dataDir);
  const defaultDataDir = join(home, '.dsh', 'memory');
  const dataDir = dataDirRaw !== '' ? dataDirRaw : defaultDataDir;

  const archive = section(file, 'archive');
  const cards = section(file, 'cards');
  const recall = section(file, 'recall');
  const distill = section(file, 'distill');
  const maintain = section(file, 'maintain');
  const rules = section(file, 'rules');
  const inject = section(file, 'inject');
  const persona = section(file, 'persona');

  const dshHome = str(archive.dshHome, '') !== '' ? archive.dshHome : (str(env.DSH_HOME, '') || join(home, '.dsh'));

  return {
    enabled: boolOf(file.enabled, DEFAULT_CONFIG.enabled),
    dataDir,
    archive: {
      dshHome,
      qqHistory: str(archive.qqHistory, ''),
      limit: intOf(archive.limit, DEFAULT_CONFIG.archive.limit, 1, 5000),
      days: intOf(archive.days, DEFAULT_CONFIG.archive.days, 1, 30)
    },
    cards: {
      engramDb: str(cards.engramDb, '') !== '' ? cards.engramDb : join(home, '.engram', 'engram.db'),
      linksDb: str(cards.linksDb, '') !== '' ? cards.linksDb : join(dataDir, 'links.db'),
      limit: intOf(cards.limit, DEFAULT_CONFIG.cards.limit, 1, 200)
    },
    recall: {
      limit: intOf(recall.limit, DEFAULT_CONFIG.recall.limit, 1, 50),
      depth: intOf(recall.depth, DEFAULT_CONFIG.recall.depth, 1, 3)
    },
    distill: resolveDistillConfig(distill),
    maintain: resolveMaintainConfig(maintain),
    rules: resolveRuleConfig(rules),
    inject: resolveInjectConfig(inject),
    persona: resolvePersonaConfig(persona)
  };
}

/** 从 dataDir 读配置；读不到就用默认值。 */
export function loadConfigFile(dataDir, env = process.env) {
  const home = env.HOME ?? '';
  const dir = typeof dataDir === 'string' && dataDir !== '' ? dataDir : join(home, '.dsh', 'memory');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 建不出来就退回默认值。
  }
  return readJson(join(dir, 'config.json'), {});
}

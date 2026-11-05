/**
 * 规则层：遇到某种情况该怎么做。
 *
 * **这个层里没有一条规则**——规则是她写的，这里只做加载器和匹配。
 *
 * 为什么规则不能当卡片：卡片靠语义召回，想起来就用、想不起来就不用；
 * 规则是「每次都得守住」的东西，靠召回等于靠运气。所以这里是
 * 「读目录里的 markdown → 按触发条件筛 → 把命中的塞进上下文」。
 *
 * 文件格式（`<dataDir>/rules/*.md`）：
 *
 * ```
 * ---
 * name: 私聊内容不外流
 * when: 私聊 转发 群里
 * ---
 * 私聊里说的话，没有明确同意，不要转发到任何群。
 * ```
 *
 * `when` 是用空格隔开的关键词，上下文里命中任意一个就算适用。
 * 不写 `when` 就是「永远适用」（比如「不知道就说不知道」这种）。
 * 只有正文、没有头的文件也认，当成永远适用。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULE_DEFAULTS = Object.freeze({
  enabled: true,
  /** 最多注入几条。太多会把上下文挤满，规则反而记不住。 */
  maxRules: 5
});

/** 夹取规则层配置。 */
export function resolveRuleConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const intOf = (value, fallback, min, max) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
  };
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : RULE_DEFAULTS.enabled,
    maxRules: intOf(src.maxRules, RULE_DEFAULTS.maxRules, 1, 20)
  };
}

/**
 * 解析一份规则文件。
 *
 * 头是 `---` 包起来的一段 `key: value`，只认 `name` 和 `when`；
 * 认不出的键留着但不使用。正文是头之后剩下的全部内容。
 */
export function parseRule(text, fallbackName = '') {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  let name = fallbackName;
  let when = '';
  let bodyStart = 0;

  if (lines.length > 0 && lines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      for (let i = 1; i < end; i += 1) {
        const line = lines[i];
        const cut = line.indexOf(':');
        if (cut === -1) continue;
        const key = line.slice(0, cut).trim().toLowerCase();
        const value = line.slice(cut + 1).trim();
        if (key === 'name' && value !== '') name = value;
        if (key === 'when') when = value;
      }
      bodyStart = end + 1;
    }
  }

  const body = lines.slice(bodyStart).join('\n').trim();
  const keywords = when
    .split(/[\s,，、|]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '');

  return { name, when, keywords, body };
}

/** 读整个规则目录。目录不存在就返回空数组（不是错误）。 */
export function loadRules(rulesDir) {
  if (typeof rulesDir !== 'string' || rulesDir === '' || !existsSync(rulesDir)) return [];
  let names;
  try {
    names = readdirSync(rulesDir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
  names.sort();
  const out = [];
  for (const file of names) {
    let text;
    try {
      text = readFileSync(join(rulesDir, file), 'utf8');
    } catch {
      continue;
    }
    const rule = parseRule(text, file.replace(/\.md$/, ''));
    if (rule.body === '') continue;
    out.push({ ...rule, file });
  }
  return out;
}

/**
 * 按上下文挑规则。
 *
 * 没有 `keywords` 的规则永远命中；有的话上下文里得出现至少一个。
 * 命中后按「关键词多的优先」排——条件写得越具体，说明越针对眼前这件事。
 */
export function matchRules(rules, contextText, options = {}) {
  const { maxRules = RULE_DEFAULTS.maxRules } = options;
  const haystack = String(contextText ?? '').toLowerCase();
  const hits = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule === null || typeof rule !== 'object') continue;
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
    if (keywords.length === 0) {
      hits.push({ rule, matched: [], score: 0 });
      continue;
    }
    const matched = keywords.filter((word) => haystack.includes(String(word).toLowerCase()));
    if (matched.length === 0) continue;
    hits.push({ rule, matched, score: matched.length });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits.slice(0, Math.max(1, maxRules));
}

/** 拼成能直接塞进上下文的一段文字。没命中返回空串。 */
export function renderRules(hits) {
  const list = Array.isArray(hits) ? hits.filter((hit) => hit?.rule?.body) : [];
  if (list.length === 0) return '';
  const lines = ['## 现在适用的规矩'];
  for (const hit of list) {
    lines.push(`- ${hit.rule.name}：${hit.rule.body.replace(/\s*\n\s*/g, ' ')}`);
  }
  return lines.join('\n');
}

/**
 * 规则层。
 *
 * @param {object} options
 *   - rulesDir  规则目录（`<dataDir>/rules`）
 *   - log       日志
 */
export function createRules(options = {}) {
  const { rulesDir = '', log = () => {} } = options;

  /** 确保目录在（她好往里放文件）。 */
  function ensureDir() {
    if (rulesDir === '') return;
    try {
      mkdirSync(rulesDir, { recursive: true });
    } catch {
      log('warn', `规则层：建目录失败 ${rulesDir}`);
    }
  }

  return {
    rulesDir,
    /** 全部规则（每次现读，改完不用重启）。 */
    all() {
      ensureDir();
      return loadRules(rulesDir);
    },
    /** 按上下文挑适用的几条。 */
    match(contextText, matchOptions = {}) {
      return matchRules(this.all(), contextText, matchOptions);
    },
    /** 按上下文拼成一段文字。 */
    render(contextText, matchOptions = {}) {
      return renderRules(this.match(contextText, matchOptions));
    },
    stat() {
      const rules = this.all();
      return {
        rulesDir,
        count: rules.length,
        withCondition: rules.filter((rule) => rule.keywords.length > 0).length
      };
    }
  };
}

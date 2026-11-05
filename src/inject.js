/**
 * 规则注入：把规则层筛出来的几条，塞进每轮的系统提示。
 *
 * 为什么不能靠工具：规则是「每次都得守住」的东西，而我未必每轮都想得起来
 * 去调 `memory_rules`。挂成系统提示的一节，等于每轮都被摆到眼前。
 *
 * 这里只放不碰宿主 API 的纯逻辑（从消息里抠文字、攒最近几句），
 * 真正注册 section 的那几行在 index.js 里——那里才有 ctx。
 */

/** 系统提示里这一节的名字。带前缀免得跟别人的撞。 */
export const RULE_SECTION_NAME = 'memory:rules';

/**
 * 这一节排在哪儿。
 *
 * 9000 是交付文件引用、9900 是结构化输出，都靠后；规则比它们更该被记住，
 * 所以放在中间偏后的位置——太靠前会被后面几百行工具说明冲淡。
 */
export const RULE_SECTION_ORDER = 9500;

export const INJECT_DEFAULTS = Object.freeze({
  /** 挂上就每轮都注入。关掉的话规则层就退化成「只有我主动调工具才用得上」。 */
  enabled: true,
  /** 攒最近几条消息当匹配素材。 */
  contextMessages: 3,
  /** 素材总长上限，别把整段历史都拿去子串匹配。 */
  contextChars: 4000
});

/** 夹取注入配置。 */
export function resolveInjectConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const intOf = (value, fallback, min, max) => {
    if (value === null || value === undefined || value === '') return fallback;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
  };
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : INJECT_DEFAULTS.enabled,
    contextMessages: intOf(src.contextMessages, INJECT_DEFAULTS.contextMessages, 1, 20),
    contextChars: intOf(src.contextChars, INJECT_DEFAULTS.contextChars, 200, 40000)
  };
}

/** 从一条消息里抠出纯文本。不是文本块就跳过。 */
export function extractMessageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type !== 'text') continue;
    const text = typeof part.text === 'string' ? part.text.trim() : '';
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/**
 * 攒最近几条消息的正文，给规则匹配当素材。
 *
 * 只留最后 `limit` 条、总长不超过 `maxChars`——规则匹配是子串查找，
 * 素材越多越容易误命中，而且这活儿每轮都跑，别浪费。
 */
export function createMessageBuffer(options = {}) {  const { limit = 3, maxChars = 4000 } = options;
  const keep = Math.max(1, Math.trunc(limit));
  const cap = Math.max(200, Math.trunc(maxChars));
  let lines = [];

  return {
    /** 收一条消息（消息对象或已经抠好的字符串都行）。 */
    push(input) {
      const text = typeof input === 'string' ? input.trim() : extractMessageText(input);
      if (text === '') return;
      lines.push(text.length > cap ? text.slice(-cap) : text);
      if (lines.length > keep) lines = lines.slice(-keep);
    },
    /** 当前素材。 */
    text() {
      return lines.join('\n');
    },
    /** 清空（比如换了一轮话题）。 */
    clear() {
      lines = [];
    },
    /** 攒了几条。 */
    get size() {
      return lines.length;
    }
  };
}

/**
 * 从 agent 的会话里取最近几条「人说的话」，当规则匹配素材。
 *
 * 只看 role === 'user'：我自己刚说的话不该触发规则，否则我回一句「文件」
 * 就把「动手前先问」翻出来了。取不到就返回空串，让这一节整段消失。
 */
export function recentMessageText(agent, options = {}) {
  const { limit = 3, maxChars = 4000 } = options;
  const keep = Math.max(1, Math.trunc(limit));
  let messages;
  try {
    messages = agent?.session?.deriveMessages?.();
  } catch {
    return '';
  }
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < keep; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = extractMessageText(message);
    if (text !== '') picked.unshift(text);
  }
  if (picked.length === 0) return '';

  const joined = picked.join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

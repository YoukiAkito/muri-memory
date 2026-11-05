/**
 * 面向模型的工具。
 *
 *   memory_stat     三层现在各有什么，能不能用
 *   memory_scan     翻原始流水（会话日志 / QQ 台账 / 日记）—— 档案层
 *   memory_recall   按意思找卡片，顺带告诉你还能往哪走 —— 检索层
 *   memory_card     取一张卡片的全文
 *   memory_link     给两张卡之间连一条边（只认三种关系）
 *   memory_distill  现在就把流水炼成卡片
 *   memory_maintain 巡检一次（找重复卡片、悬空边），只看报告
 *   memory_rules    看现在适用的规矩 / 列出全部规矩
 *   memory_persona  看人设文件在哪、有没有；read 取全文，put 覆盖
 *
 * 工具注册在每个 root agent 的 scope 上，跟 dsh-purpose 一致。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toIso } from './util.js';

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true }
  }
};

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function clampInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function internalError() {
  return { code: 'internal', message: '这个工具只能在它所属的 agent 回合里调用。' };
}

const STAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    archive: { type: 'string', required: true },
    cards: { type: 'string', required: true },
    distill: { type: 'string', required: true },
    maintain: { type: 'string', required: true },
    rules: { type: 'string', required: true },
    persona: { type: 'string', required: true },
    dataDir: { type: 'string', required: true }
  }
};

const MAINTAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    reason: { type: 'string' },
    cards: { type: 'integer' },
    duplicates: { type: 'string' },
    dangling: { type: 'string' },
    report: { type: 'string' }
  }
};

const RULES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer', required: true },
    text: { type: 'string', required: true },
    list: { type: 'string' }
  }
};

const PERSONA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', required: true },
    file: { type: 'string', required: true },
    present: { type: 'boolean', required: true },
    chars: { type: 'integer', required: true },
    reason: { type: 'string' },
    text: { type: 'string' },
    saved: { type: 'string' }
  }
};

const DISTILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    reason: { type: 'string' },
    windowed: { type: 'integer' },
    newCards: { type: 'string' }
  }
};

const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer', required: true },
    lines: { type: 'string', required: true }
  }
};

const RECALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    note: { type: 'string', required: true },
    h: { type: 'number', required: true },
    cards: { type: 'string', required: true },
    paths: { type: 'string', required: true },
    next: { type: 'string', required: true },
    originals: { type: 'string', required: true }
  }
};

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', required: true },
    card: { type: 'string', required: true }
  }
};

const LINK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    allowed: { type: 'string' }
  }
};

/** 把一条流水记录压成一行好读的文本。 */
function formatRecord(record) {
  const who = record.role === 'assistant' ? '我' : record.peer !== '' && record.peer !== undefined ? record.peer : '她';
  const when = toIso(record.at).replace('T', ' ').slice(0, 16);
  return `[${when}] ${who}: ${String(record.text).replace(/\s+/g, ' ').slice(0, 240)}`;
}

/**
 * @param {object} agentCtx  agent 作用域上下文（有 tools.register）
 * @param {object} agent     所属 agent
 * @param {object} service   插件服务：
 *   - stat()                        → 三层概况
 *   - scan(query)                   → 原始流水
 *   - recall(query)                 → 检索
 *   - card(id)                      → 单张卡片
 *   - link(from, to, relation, reason) → 连边
 *   - distill(runOptions)           → 立刻提炼一次
 */
export function registerMemoryTools(agentCtx, agent, service) {
  const disposers = [];
  const add = (definition) => {
    disposers.push(agentCtx.tools.register(definition));
  };

  add(defineTool({
    name: 'memory_stat',
    description: '看一眼记忆系统三层的现状：档案层有多少可扫的会话/QQ 台账/日记，卡片层能不能连上 engram，边车库里有几条关系。想确认它有没有正常工作时用。',
    parameters: {},
    output: { schema: { oneOf: [STAT_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(_args, exec) {
      if (exec.agent !== agent) return internalError();
      const snapshot = service.stat();
      return {
        archive: JSON.stringify(snapshot.archive),
        cards: JSON.stringify(snapshot.cards),
        distill: JSON.stringify(snapshot.distill ?? {}),
        maintain: JSON.stringify(snapshot.maintain ?? {}),
        rules: JSON.stringify(snapshot.rules ?? {}),
        persona: JSON.stringify(snapshot.persona ?? {}),
        dataDir: snapshot.dataDir
      };
    },
    presentCall: () => ({ type: 'text', text: '看记忆系统状态' })
  }));

  add(defineTool({
    name: 'memory_scan',
    description: '翻原始流水：按会话 id 读 DSH 会话日志，或按 QQ 台账目录读聊天记录，或读日记。只读，不改任何东西。想知道"那天到底说了什么"时用，比凭印象猜可靠。',
    parameters: {
      session_id: { type: 'string', description: 'DSH 会话 id。给了就只读那个会话的日志。' },
      qq_target: { type: 'string', description: "QQ 台账：'c2c' 只看私聊，`group:<gid>` 看某个群，'all' 全都要。" },
      include_diary: { type: 'boolean', description: '是否连日记一起翻。' },
      include_assistant: { type: 'boolean', description: '是否包含我自己说的话（默认 false，只看人说的）。' },
      days: { type: 'integer', description: '往回几天，默认 2，上限 30。' },
      limit: { type: 'integer', description: '最多返回几条，默认 50，上限 500。' },
      keyword: { type: 'string', description: '只要含这个词的记录。' },
      sender: { type: 'string', description: '只看某人（openid 或昵称片段）。' },
      from_self: { type: 'boolean', description: 'true=只看我发的，false=只看别人发的，不传=都要。' }
    },
    output: { schema: { oneOf: [SCAN_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const records = service.scan({
        sessionId: typeof args['session_id'] === 'string' ? args['session_id'].trim() : '',
        qqTarget: typeof args['qq_target'] === 'string' ? args['qq_target'].trim() : '',
        includeDiary: args['include_diary'] === true,
        includeAssistant: args['include_assistant'] === true,
        days: args['days'],
        limit: args['limit'],
        keyword: args['keyword'],
        sender: args['sender'],
        fromSelf: args['from_self']
      });
      return {
        count: records.length,
        lines: records.length === 0 ? '（没翻到记录）' : records.map(formatRecord).join('\n')
      };
    },
    presentCall: () => ({ type: 'text', text: '翻原始流水' })
  }));

  add(defineTool({
    name: 'memory_recall',
    description: '按意思找卡片（engram 里的长期记忆），顺带告诉你每张卡还连着哪些边、还有哪些卡没走到。返回里的 h 越小说明剩下的越少，可以据此判断要不要继续挖。',
    parameters: {
      text: { type: 'string', required: true, description: '要找什么，用自然语言。' },
      limit: { type: 'integer', description: '卡片上限，默认 10，最多 50。' },
      depth: { type: 'integer', description: '从每张卡往下走几跳，默认 1。' },
      relation: { type: 'string', description: "只看某种边：derived_from / supersedes / conflicts_with。" },
      originals: { type: 'boolean', description: '是否顺着 derived_from 把原话也取出来。' }
    },
    output: { schema: { oneOf: [RECALL_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
      if (text === '') {
        return { code: 'invalid_args', message: 'text 不能为空，写要查什么。' };
      }
      const result = service.recall({
        text,
        limit: args['limit'],
        depth: args['depth'],
        relation: typeof args['relation'] === 'string' ? args['relation'].trim() : '',
        originals: args['originals'] === true
      });
      return {
        note: result.note,
        h: result.h,
        cards: JSON.stringify(result.cards.map((card) => ({
          id: card.id,
          title: card.title,
          type: card.type,
          at: toIso(card.updatedAt ?? card.createdAt)
        }))),
        paths: JSON.stringify(result.paths),
        next: JSON.stringify(result.next),
        originals: JSON.stringify(result.originals)
      };
    },
    presentCall: () => ({ type: 'text', text: '找记忆卡片' })
  }));

  add(defineTool({
    name: 'memory_card',
    description: '取一张卡片的全文。id 可以是 obs:123 或直接 123。',
    parameters: {
      id: { type: 'string', required: true, description: '卡片 id，如 obs:96。' }
    },
    output: { schema: { oneOf: [CARD_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
      if (id === '') return { code: 'invalid_args', message: 'id 不能为空。' };
      const card = service.card(id);
      return { found: card !== null, card: JSON.stringify(card ?? {}) };
    },
    presentCall: () => ({ type: 'text', text: '取一张卡片' })
  }));

  add(defineTool({
    name: 'memory_distill',
    description: '现在就把最近的流水提炼成记忆卡片（本来每天凌晨自己跑一次）。只在你觉得刚才这段聊出了值得长期记的东西时手动用；提炼会开一个独立会话，不会打扰当前对话。',
    parameters: {
      force: { type: 'boolean', description: 'true=不管今天跑没跑过、不管开关，硬跑一次。' }
    },
    output: { schema: { oneOf: [DISTILL_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const result = await service.distill({ force: args['force'] === true });
      return {
        ok: result.ok === true,
        reason: typeof result.reason === 'string' ? result.reason : undefined,
        windowed: Number.isFinite(result.windowed) ? result.windowed : undefined,
        newCards: JSON.stringify(Array.isArray(result.newCards) ? result.newCards.map((card) => ({ id: card.id, title: card.title })) : [])
      };
    },
    presentCall: () => ({ type: 'text', text: '提炼记忆卡片' })
  }));

  add(defineTool({
    name: 'memory_link',
    description: '在两张卡之间连一条边。只认三种关系：derived_from（这张是从那张里提炼出来的）、supersedes（这张取代那张）、conflicts_with（两张说的互相矛盾）。',
    parameters: {
      from: { type: 'string', required: true, description: '起点卡片 id，如 obs:96。' },
      to: { type: 'string', required: true, description: '终点：卡片 id，或者流水记录 id（如 qq:c2c:xxx）。' },
      relation: { type: 'string', required: true, description: 'derived_from / supersedes / conflicts_with。' },
      reason: { type: 'string', description: '为什么连这条边，一句话。' }
    },
    output: { schema: { oneOf: [LINK_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const from = typeof args['from'] === 'string' ? args['from'].trim() : '';
      const to = typeof args['to'] === 'string' ? args['to'].trim() : '';
      const relation = typeof args['relation'] === 'string' ? args['relation'].trim() : '';
      if (from === '' || to === '' || relation === '') {
        return { code: 'invalid_args', message: 'from / to / relation 三个都不能空。' };
      }
      const result = service.link(from, to, relation, typeof args['reason'] === 'string' ? args['reason'] : '');
      return {
        ok: result.ok === true,
        error: typeof result.error === 'string' ? result.error : undefined,
        allowed: Array.isArray(result.allowed) ? result.allowed.join(', ') : undefined
      };
    },
    presentCall: () => ({ type: 'text', text: '连一条记忆关系' })
  }));

  add(defineTool({
    name: 'memory_maintain',
    description: '巡检一次记忆库：找疑似重复的卡片、找指向已删卡片的悬空边，写一份报告。只报告不改数据——卡片在 engram 里是只读的，真要合并得自己 mem_save。',
    parameters: {
      force: { type: 'boolean', description: 'true=不管今天跑没跑过，硬跑一次。' }
    },
    output: { schema: { oneOf: [MAINTAIN_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const result = await service.maintain({ force: args['force'] === true });
      if (result.ok !== true) {
        return {
          ok: false,
          reason: typeof result.reason === 'string' ? result.reason : 'unknown',
          report: JSON.stringify(service.maintainReport() ?? {})
        };
      }
      return {
        ok: true,
        cards: Number.isFinite(result.cards) ? result.cards : 0,
        duplicates: JSON.stringify(result.duplicates ?? []),
        dangling: JSON.stringify(result.dangling ?? []),
        report: JSON.stringify(service.maintainReport() ?? {})
      };
    },
    presentCall: () => ({ type: 'text', text: '巡检记忆库' })
  }));

  add(defineTool({
    name: 'memory_persona',
    description: "人设文件（<dataDir>/persona.md）。不给 mode 就报状态；mode=read 取全文；mode=put 覆盖（要先跟她确认）。人设跟着记忆走，不跟着机器走。",
    parameters: {
      mode: { type: 'string', enum: ['status', 'read', 'put'], description: '默认 status。' },
      text: { type: 'string', description: 'mode=put 时的新人设全文。' }
    },
    output: { schema: { oneOf: [PERSONA_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const mode = typeof args['mode'] === 'string' ? args['mode'] : 'status';
      if (mode === 'put') {
        const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
        if (text === '') return { code: 'invalid_args', message: 'put 要带 text，不能写空的。' };
        const saved = service.personaPut(text);
        const after = service.persona();
        return {
          enabled: after.enabled,
          file: after.file,
          present: after.present,
          chars: after.chars,
          reason: after.reason,
          saved: saved.ok ? `已写 ${saved.chars} 字` : `没写成：${saved.error}`
        };
      }
      const status = service.persona();
      if (mode === 'read') {
        return { ...status, text: service.personaText() };
      }
      return status;
    },
    presentCall: () => ({ type: 'text', text: '看人设文件' })
  }));

  add(defineTool({
    name: 'memory_rules',
    description: "读她写的规矩（<dataDir>/rules/*.md）。给了 context 就只返回现在适用的几条，不给就列出全部。规矩不是卡片——卡片靠想起来，规矩靠每次守住。",
    parameters: {
      context: { type: 'string', description: '眼下这件事/这轮对话的摘要，用来筛适用的规矩。不给就列全部。' },
      max_rules: { type: 'integer', description: '最多返回几条，默认 5，最多 20。' }
    },
    output: { schema: { oneOf: [RULES_SCHEMA, ERROR_SCHEMA] }, render: renderValue },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const context = typeof args['context'] === 'string' ? args['context'].trim() : '';
      const maxRules = clampInt(args['max_rules'], 5, 1, 20);
      const all = service.ruleList();
      if (context === '') {
        return {
          count: all.length,
          text: all.length === 0 ? '（还没有规矩）' : all.map((rule) => `- ${rule.name}${rule.keywords.length > 0 ? `（触发：${rule.keywords.join(' ')}）` : '（永远适用）'}`).join('\n'),
          list: JSON.stringify(all.map((rule) => ({ name: rule.name, file: rule.file, keywords: rule.keywords })))
        };
      }
      const text = service.rules(context, { maxRules });
      return {
        count: text === '' ? 0 : text.split('\n').length - 1,
        text: text === '' ? '（没有适用的规矩）' : text,
        list: '[]'
      };
    },
    presentCall: () => ({ type: 'text', text: '看现在适用的规矩' })
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载失败不算事。
      }
    }
  };
}

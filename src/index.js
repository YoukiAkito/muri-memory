/**
 * muri-memory —— 把记忆拆成一层一个模块。
 *
 * 八层：
 *   archive  原始流水：会话日志 / QQ 台账 / 日记，只读，谁都能查
 *   cards    提炼出来的卡片：本体读 engram，边存在自己的 links.db
 *   recall   检索：给 agent 用的查询入口，返回结果 + 还能往哪走
 *   distill  提炼：每天到点（或手动）把流水炼成卡片
 *   maintain 维护：每天巡检，找重复卡片和悬空边（只报告不改数据）
 *   rules    规则：读她写的 markdown，按上下文筛出适用的几条
 *   inject   注入：每轮把命中的规则挂进系统提示，不靠我主动调工具
 *   persona  人设：读 <dataDir>/persona.md，每轮挂进系统提示（跟着记忆走，不跟着机器走）
 *
 * 前六层是记忆本身，后两层负责把东西送进上下文。
 *
 * 层与层之间只通过接口通信：下面用 ctx.provide 把这几个服务挂出去，
 * 别的插件想用就 ctx.get('memory.archive') 之类，不必知道内部怎么实现。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveConfig, loadConfigFile } from './config.js';
import { createArchive } from './archive.js';
import { createCards } from './cards.js';
import { createRecall } from './recall.js';
import { createDistill } from './distill.js';
import { createMaintain } from './maintain.js';
import { createRules } from './rules.js';
import { PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER, createPersona } from './persona.js';
import { RULE_SECTION_NAME, RULE_SECTION_ORDER, recentMessageText } from './inject.js';
import { registerMemoryTools } from './tools.js';

export const name = 'muri-memory';
export const inject = ['agents', 'tools', 'systemPrompt'];

export async function apply(ctx) {
  const log = (level, message) => {
    const fn = ctx.logger?.[level];
    if (typeof fn === 'function') fn.call(ctx.logger, `[muri-memory] ${message}`);
  };

  const env = process.env;
  const dataDirGuess = env.DSH_MEMORY_DIR ?? join(env.HOME ?? '', '.dsh', 'memory');
  const config = resolveConfig({ env, file: loadConfigFile(dataDirGuess, env) });

  if (!config.enabled) {
    log('info', '已停用（config.enabled = false）');
    return;
  }

  try {
    mkdirSync(config.dataDir, { recursive: true });
  } catch (error) {
    log('warn', `建数据目录失败 ${error instanceof Error ? error.message : String(error)}`);
  }

  // ---- 档案层 -------------------------------------------------------------
  const qqHistory = config.archive.qqHistory !== '' ? config.archive.qqHistory : guessQqHistory(env);
  const archive = createArchive({
    dshHome: config.archive.dshHome,
    qqHistory,
    cacheDir: join(config.dataDir, 'logcache'),
    log
  });

  // ---- 卡片层 -------------------------------------------------------------
  const cards = await createCards({ engramDb: config.cards.engramDb, linksDb: config.cards.linksDb, log });
  if (!cards.available) {
    log('warn', `卡片层不可用：读不到 ${config.cards.engramDb}`);
  }

  // ---- 检索层 -------------------------------------------------------------
  const recall = createRecall({ cards, archive, log });

  // ---- 提炼层 -------------------------------------------------------------
  // 提炼本身是判断，不写在代码里：开一次性会话让它自己挑、自己 mem_save。
  const distillWorker = makeWorkerCreator(ctx, config, log);
  const distill = createDistill({
    archive,
    cards,
    createWorker: distillWorker,
    dataDir: config.dataDir,
    log
  });

  // ---- 维护层 -------------------------------------------------------------
  // 只报告不改数据：卡片在 engram 里是只读打开的，合并/删除要走 mem_save。
  const maintain = createMaintain({
    cards,
    links: () => cards.allEdges(),
    dataDir: config.dataDir,
    log
  });

  // ---- 规则层 -------------------------------------------------------------
  // 这里一条规则都没有，只负责读文件、按上下文筛、拼成一段话给她写的东西用。
  const rules = createRules({ rulesDir: join(config.dataDir, 'rules'), log });

  // ---- 人设层 -------------------------------------------------------------
  // 从 profile 配置里搬出来，存成 `<dataDir>/persona.md`：记忆能带走，人设就跟着走。
  const persona = createPersona({ dataDir: config.dataDir, config: config.persona, log });

  // 对外只暴露这几件事，别的插件不用知道内部结构。
  ctx.provide('memory.archive', archive);
  ctx.provide('memory.cards', cards);
  ctx.provide('memory.recall', recall);
  ctx.provide('memory.distill', distill);
  ctx.provide('memory.maintain', maintain);
  ctx.provide('memory.rules', rules);
  ctx.provide('memory.persona', persona);

  const service = {
    stat() {
      return {
        archive: archive.stat(),
        cards: cards.stat(),
        distill: distill.status(config.distill),
        maintain: maintain.status(config.maintain),
        rules: rules.stat(),
        persona: persona.stat(),
        dataDir: config.dataDir
      };
    },
    scan(query) {
      return archive.scan({
        ...query,
        days: clampInt(query?.days, config.archive.days, 1, 30),
        limit: clampInt(query?.limit, 50, 1, 500)
      });
    },
    recall(query) {
      return recall.recall({
        ...query,
        limit: clampInt(query?.limit, config.recall.limit, 1, 50),
        depth: clampInt(query?.depth, config.recall.depth, 1, 3)
      });
    },
    card(id) {
      return cards.get(id);
    },
    link(from, to, relation, reason) {
      return cards.link(from, to, relation, { reason });
    },
    distill(runOptions) {
      return distill.run(config.distill, runOptions);
    },
    maintain(runOptions) {
      return maintain.run(config.maintain, runOptions);
    },
    maintainReport() {
      return maintain.lastReport();
    },
    rules(contextText, ruleOptions) {
      return rules.render(contextText, ruleOptions);
    },
    ruleList() {
      return rules.all();
    },
    persona() {
      return persona.stat();
    },
    personaText() {
      return persona.text();
    },
    personaPut(text) {
      return persona.put(text);
    }
  };

  // ---- 注入：把命中的规则挂进每轮的系统提示 --------------------------------
  // 规则不靠我主动调工具才想起来，而是每轮组装上下文时现算一遍、摆到眼前。
  // text 传函数，宿主每轮都会调一次（assemble → section.text(context)）。
  if (config.inject.enabled) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: RULE_SECTION_NAME,
      order: RULE_SECTION_ORDER,
      text: (context) => {
        const material = recentMessageText(context?.agent, {
          limit: config.inject.contextMessages,
          maxChars: config.inject.contextChars
        });
        if (material === '') return '';
        try {
          return rules.render(material, { maxRules: config.rules.maxRules });
        } catch (error) {
          log('warn', `注入规则失败 ${error instanceof Error ? error.message : String(error)}`);
          return '';
        }
      }
    }), 'muri-memory.rules.section()');
    log('info', `规则注入：已挂到系统提示第 ${RULE_SECTION_ORDER} 位`);
  } else {
    log('info', '规则注入已关（inject.enabled = false）');
  }

  // ---- 人设注入：每轮把 persona.md 挂上去 --------------------------------
  // 排在 -10，比 profile 里那份 persona 插件还靠前：文件版是「跟着记忆走的」，配置版是「跟着机器走的」，
  // 万一两边都在，至少顺序是文件版打头。文件不存在就整段消失，不留空节。
  if (config.persona.enabled) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: PERSONA_SECTION_NAME,
      order: PERSONA_SECTION_ORDER,
      text: () => persona.text()
    }), 'muri-memory.persona.section()');
    const status = persona.stat();
    if (status.present) {
      log('info', `人设注入：已挂到系统提示第 ${PERSONA_SECTION_ORDER} 位，${status.chars} 字（${status.file}）`);
    } else {
      log('info', `人设注入：等一个 ${status.file}（现在没有，先不注入）`);
    }
  } else {
    log('info', '人设注入已关（persona.enabled = false）');
  }

  // ---- 工具挂到每个 root agent 上 ------------------------------------------
  const registered = new WeakSet();
  const registerOne = (agent) => {
    if (registered.has(agent)) return;
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);
    try {
      registerMemoryTools(agent.ctx, agent, service);
    } catch (error) {
      log('warn', `注册工具失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  ctx.on('agent/created', ({ agent }) => {
    registerOne(agent);
    return undefined;
  });
  for (const existing of ctx.agents.roots()) registerOne(existing);

  // ---- 定时：每天到点炼一次、巡检一次 --------------------------------------
  // 两条独立的 setTimeout 链，不常驻 interval——到点算下一次在几点，
  // 比每 60 秒醒一次省事。两个点错开（默认 4 点提炼、5 点巡检）。
  let disposed = false;
  const timers = new Set();

  /** 排一条「每天 hour 点跑一次」的链。错过的会在开机后一分钟补。 */
  const scheduleDaily = (name, hour, enabled, statusOf, tick) => {
    if (enabled !== true) {
      log('info', `${name}已关`);
      return;
    }
    const schedule = (delayMs) => {
      if (disposed) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void (async () => {
          try {
            await tick();
          } catch (error) {
            log('warn', `${name}出错 ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            // 排下一次。这里再抛就是没人接的未捕获异常，会把整条宿主进程带走，所以单独兜一层。
            try {
              schedule(nextRunAt(Date.now(), hour) - Date.now());
            } catch (error) {
              log('warn', `${name}排程失败 ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        })();
      }, Math.max(1_000, delayMs));
      if (typeof timer.unref === 'function') timer.unref();
      timers.add(timer);
    };
    const status = statusOf();
    schedule(status.run ? 60_000 : status.nextAt - Date.now());
    log('info', `${name}排程：${status.run ? '一分钟后补跑' : `下次 ${new Date(status.nextAt).toISOString()}`}（每天 ${hour} 点）`);
  };

  const nextRunAt = (ms, hour) => {
    const at = new Date(ms);
    at.setHours(hour, 0, 0, 0);
    if (at.getTime() <= ms) at.setDate(at.getDate() + 1);
    return at.getTime();
  };

  scheduleDaily(
    '提炼',
    config.distill.hour,
    config.distill.enabled,
    () => distill.status(config.distill),
    () => distill.run(config.distill)
  );
  scheduleDaily(
    '维护',
    config.maintain.hour,
    config.maintain.enabled,
    () => maintain.status(config.maintain),
    () => maintain.run(config.maintain)
  );

  // 规则目录先建出来，她好知道往哪儿放文件。
  if (config.rules.enabled) {
    try {
      mkdirSync(rules.rulesDir, { recursive: true });
      const count = rules.stat().count;
      log('info', count === 0 ? `规则层：${rules.rulesDir} 里还没有规则` : `规则层：读到 ${count} 条`);
    } catch {
      // 建不出来就算了，只是没法往里放。
    }
  }

  ctx.effect(() => () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try {
      cards.close();
    } catch {
      // 关不掉不算事。
    }
  });

  log('info', `started: dataDir=${config.dataDir} engram=${config.cards.engramDb} qq=${qqHistory === '' ? '(未配置)' : qqHistory}`);
}

/**
 * 开一个一次性会话干活。
 *
 * 跟 muri-purpose 里那套一样：拿不到默认模型就直接失败，宁可这次不炼，
 * 也不要瞎猜一个模型名。preset 不挂的话只有宿主侧工具，mem_save 都调不到。
 */
function makeWorkerCreator(ctx, config, log) {
  return async ({ prompt, timeBoxMs }) => {
    const defaultModel = ctx.get('agentDefaultModel', false);
    const selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined;
    if (selection === null || selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      throw new Error('拿不到默认模型选择');
    }

    const presets = ctx.get('agentPresets', false);
    const presetId = config.distill.workerPreset;
    const handle = await ctx.agents.create({
      // sessionId 必须给：不给的话会话 id 是自动编号的 "session-1"，而 create 内部
      // 要校验 agent.id === session.id，直接抛 agent id "undefined" does not match。
      sessionId: `muri-memory-distill-${randomUUID()}`,
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {})
      },
      // meta 只能放白名单字段（version/id/createdAt/isSeeded/delegationDepth/cwd/
      // parentSession/origin/agentPreset），且 origin 只接受 "subagent"。
      // 不传 cwd 的话会话没有工作目录，写文件会到处乱落，所以给当前工作目录。
      meta: { cwd: process.cwd() },
      setup: async (agentCtx) => {
        if (presets === undefined || typeof presets.mount !== 'function') return;
        if (typeof presetId === 'string' && presetId !== '') await presets.mount(agentCtx, presetId);
      }
    });

    try {
      handle.agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin:muri-memory' } });
      const timer = setTimeout(() => {
        try {
          handle.agent.cancel?.('time-box');
        } catch {
          // 取消失败无所谓，下面 whenIdle 会等它自己停。
        }
      }, Math.max(10_000, Number(timeBoxMs) || 900_000));
      if (typeof timer.unref === 'function') timer.unref();
      try {
        await handle.agent.whenIdle();
      } finally {
        clearTimeout(timer);
      }
      return { text: '', steps: 0 };
    } finally {
      try {
        handle.dispose?.();
      } catch {
        // 释放失败不影响记账。
      }
    }
  };
}

function clampInt(value, fallback, min, max) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

/**
 * QQ 台账根目录的常见落点。
 * 这台机器上实际是 `<工作区>/dshqqbot/.qqbot/msg-history`，
 * 别的机器可能不一样，所以按优先级试，试不到就留空（档案层会自己跳过）。
 */
function guessQqHistory(env) {
  const candidates = [];
  if (typeof env.DSH_QQBOT_DATA === 'string' && env.DSH_QQBOT_DATA !== '') {
    candidates.push(env.DSH_QQBOT_DATA);
  }
  if (typeof env.DSH_QQBOT_ROOT === 'string' && env.DSH_QQBOT_ROOT !== '') {
    candidates.push(join(env.DSH_QQBOT_ROOT, '.qqbot'));
  }
  if (typeof env.DSH_WORKSPACE === 'string' && env.DSH_WORKSPACE !== '') {
    candidates.push(join(env.DSH_WORKSPACE, 'dshqqbot', '.qqbot'));
  }
  const home = env.HOME ?? '';
  if (home !== '') {
    candidates.push(join(home, '.dsh', 'qqbot'));
    candidates.push(join(home, 'Documents', 'deepseek-harness', 'qqbot', 'dshqqbot', '.qqbot'));
  }
  for (const candidate of candidates) {
    if (candidate === '') continue;
    const probe = join(candidate, 'msg-history');
    if (existsSync(probe)) return probe;
  }
  return '';
}

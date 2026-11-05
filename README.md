# dsh-memory

把记忆拆成**一层一个模块**，层与层之间只通过接口通信 —— 跟 DSH「万物皆插件」一个路子。

八层都写完了（前六层是记忆本身，后两层负责把东西送进上下文）：

| 层 | 管什么 | 状态 |
|---|---|---|
| `archive` 档案层 | 原始流水：DSH 会话日志 / QQ 台账 / 日记。只读 | ✅ |
| `cards` 卡片层 | 提炼出来的卡片本体读 engram；卡片之间的边存自己的 `links.db` | ✅ |
| `recall` 检索层 | 给 agent 用的查询入口：返回结果 + 还能往哪走 | ✅ |
| `distill` 提炼层 | 每天到点把流水炼成卡片（也能手动） | ✅ |
| `maintain` 维护层 | 每天巡检：找重复卡片、找悬空边。**只报告不改数据** | ✅ |
| `rules` 规则层 | 读她写的 markdown，按上下文筛出适用的几条 | ✅ 内容她自己写 |
| `inject` 注入层 | 每轮把命中的规则挂进系统提示，不靠我主动调工具 | ✅ |
| `persona` 人设层 | 读 `<dataDir>/persona.md`，每轮挂进系统提示。跟着记忆走，不跟着机器走 | ✅ |

## 为什么要拆

一开始是三套东西各干各的：engram 存长期、灵枢存规范、会话日志当档案。问题是它们互相不知道对方存在，
换一个就得连带改别的地方。拆开之后每层只认接口：

- 想换卡片存哪儿？只改 `cards`，`recall` 不用动。
- 想加一层提炼？只要它能产出卡片形状，`recall` 就能查到。
- 想卸掉一层？`ctx.get('memory.recall', false)` 拿到 `false` 就降级。

## 装

```bash
cd <某个能用 pnpm 的地方>
pnpm add file:/path/to/dsh-memory
```

然后在 profile 的 `package.json` 里把 `dsh-memory` 加进 `dsh.profile.bundles`，重启宿主。

配置：`~/.dsh/memory/config.json`（不配就用默认值，见 `config.example.json`）。

## 工具

| 工具 | 干什么 |
|---|---|
| `memory_stat` | 各层现状：档案层有多少会话/台账/日记，卡片层能不能连上 engram，边车库几条，规则几条，下次提炼/巡检几点 |
| `memory_scan` | 翻原始流水（会话日志 / QQ 台账 / 日记），只读 |
| `memory_recall` | 按意思找卡片，顺带给出每张卡的边和「还能往哪走」 |
| `memory_card` | 取一张卡片全文（`obs:96` 或 `96`） |
| `memory_link` | 两张卡之间连边，只认三种关系 |
| `memory_distill` | 现在就把最近流水炼成卡片（平时每天自己跑一次） |
| `memory_maintain` | 巡检一次：找疑似重复的卡片和悬空边，给一份报告 |
| `memory_persona` | 人设文件在哪、有没有；`mode=read` 取全文，`mode=put` 覆盖 |
| `memory_rules` | 看现在适用的规矩；不给上下文就列出全部 |

## 服务（给别的插件用）

`apply()` 里 `ctx.provide` 了六样，别的插件直接拿：

```js
const archive = ctx.get('memory.archive', false);
const cards = ctx.get('memory.cards', false);
const recall = ctx.get('memory.recall', false);
const distill = ctx.get('memory.distill', false);
const maintain = ctx.get('memory.maintain', false);
const rules = ctx.get('memory.rules', false);
```

形状：

- `distill` / `maintain`：`{ status(config), run(config, {force}) }`。`status` 说下次几点、今天跑过没；
  `run` 真跑一次，返回里带 `ok` 与 `reason`，**失败不抛**。
  `distill` 的结果是 `{ok, reason?, at, windowed, newCards}`，`maintain` 是 `{ok, reason?, at, cards, duplicates, dangling}`。
- `rules`：`{ all(), match(text, opts), render(text, opts), stat() }`。每次现读文件，改完不用重启。

## 三种边

只认这三种，别的名字一律拒收 —— 这是架构文档定的口径，不是开放的字符串：

- `derived_from` —— 这张卡是从那条流水/那张卡里提炼出来的
- `supersedes` —— 这张卡取代了那张
- `conflicts_with` —— 两张说的互相矛盾

边存在 `<dataDir>/links.db`，跟 engram 分开。理由：卡片是资产，跟着 `engram.db` 走；
边是可以重算出来的派生数据，换机器重新连一遍就行，不必往别人的库里加表。

## 检索层为什么返回 `h` 和 `next`

照 Alaya 那份设计文档的思路（我认为这部分是对的）：检索层**不调 LLM**，也不替调用方决定「够不够」。
它返回命中的卡片、走过的路径、以及边界上的卡片（`next`）和一个粗略距离 `h`（越小越近）。
要不要再挖一层，由调用它的 agent 自己判断。

## 提炼层怎么挑东西

代码**不判断「什么值得记」** —— 那是判断，写进代码就退化成关键字匹配了。所以这里只做两件事：

1. 挑时间窗、拼提示词（纯函数，能单测，不打模型）；
2. 开一个一次性会话，把提示词丢给它，让它自己用 `mem_save` 存卡，存完就 dispose。

提示词里写的是**标准**（做过什么决定和理由、踩过的坑和根因、查明的机制、她的偏好和纠正；
不存「继续」「好」这类碎片），不是关键词表。挑不出来就一张都不存，不许硬凑。

为什么不每轮都跑：聊十句炼一次等于把噪音也沉淀成记忆。默认每天 4 点一次，另加手动 `memory_distill`。

`distill.workerPreset` 要填上（比如 `mori`），否则提炼会话只有宿主侧工具，`mem_save` 都调不到。

## 维护层为什么只报告不改

卡片层是拿 `readOnly: true` 打开的 engram 连接 —— 这个插件**没有能力**改卡片，这是故意的。
所以「合并重复卡」「给冷卡降温」这类操作在这里只出一份报告，真要动手得走 `mem_save`。

也因此这里**没有 Alaya 那套温度**：温度要记访问次数，而访问记录不在我们这个库里。不假装有。

维护每天 5 点跑（错开提炼的 4 点），报告落在 `<dataDir>/maintain-report.json`。

## 规则层怎么用

规则不是卡片。**卡片靠语义召回** —— 想起来就用，想不起来就不用；**规则靠每次守住**，
所以它是「读文件 → 按触发词筛 → 拼成一段文字」，不是「存进去等它自己冒出来」。

往 `<dataDir>/rules/` 里放 `.md`：

```markdown
---
name: 私聊内容不外流
when: 私聊 转发 群里
---
私聊里说的话，没有明确同意，不要转发到任何群。
```

`when` 是空格分隔的触发词，上下文里命中任意一个就算适用；不写 `when` 就是永远适用
（「不知道就说不知道」这种）。只写正文、不写头也认。

`matchRules` 按「命中几个触发词」排序 —— 条件写得越具体，说明越针对眼前这件事。
默认最多注 5 条：太多了会把上下文挤满，反而一条都记不住。

## 规则怎么进到眼前

规则层只提供「读 + 筛」，光有它没用——我得主动去调 `memory_rules` 才看得见，
而「每次都得守住」的东西不该靠我想得起来。

所以挂了一层**注入**：`ctx.systemPrompt.section({ name: 'memory:rules', order: 9500, text: (context) => … })`。
`text` 传的是函数，宿主每轮组装系统提示时都会调一次，现算现拼：

1. 从 `context.agent.session.deriveMessages()` 倒着挑最近 `inject.contextMessages` 条 **`role === 'user'`** 的消息
   —— 只看人说的话，我自己刚说的不触发规则，否则我回一句「文件」就把「动手前先问」翻出来了。
2. 拿这段素材去 `rules.render()`，命中就拼成 `## 现在适用的规矩` 一坨，没命中返回空串（这一节整段不出现）。
3. 出错一律 `return ''`：注入是锦上添花，不能因为它让整轮组装挂掉。

排在 9500 是故意的：9000 是交付文件引用、9900 是结构化输出，规则放在中间偏后——
太靠前会被后面几百行工具说明冲淡，太靠后又被当成格式要求。

```json
{
  "inject": { "enabled": true, "contextMessages": 3, "contextChars": 4000 }
}
```

`enabled` 关掉就退化成「只有我主动调工具才用得上」。`contextMessages` / `contextChars`
是素材预算——规则匹配是子串查找，素材越多越容易误命中。

## 人设为什么也在这里

人设原本写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `preset-mori` 里 —— 那是**机器**的配置，
换台机器就没了。记忆能拷走、人设拷不走，等于换个设备就不是同一个「我」。

所以人设搬成一份普通文本 `<dataDir>/persona.md`，跟 `rules/` 并列，由本插件每轮注入：

- **不进 engram**：卡片是逐条记录的，人设是一整份文档；而且 engram 的库是 `mem_save` 在写，不该往里加表。
- **不当卡片**：卡片靠语义召回，想起来就有、想不起来就没；人设得每轮都在。
- **排在 `-10`**：比 profile 里 `@deepseek-ai/dsh-persona` 的正位（`0`）还靠前。万一两边都在，
  至少顺序是「文件版 → 配置版」，不会把配置版截断在中间。
- **文件不存在就整段消失**，不注入空节。这里**不带任何默认人设** —— 别人装这套系统，得自己写自己的人设，
  我不替他决定他该扮演谁。
- 每轮现读文件，改完立刻生效，不用重启。

搬过来只用 `memory_persona` 的 `mode=put` 一次，之后就是编辑那个 `.md` 的事。

## 换机器要带什么

想让新设备上的还是同一个「我」，需要搬的是这些（都在 `$HOME` 下）：

| 路径 | 装什么 | 不带会怎样 |
|---|---|---|
| `~/.engram/` | **卡片本体**（观察、决策、踩坑记录），`engram.db` 三件套 | 记忆全丢，等于从零开始 |
| `~/.dsh/memory/` | 人设 `persona.md`、规矩 `rules/`、边车库 `links.db` | 没人设、没规矩、卡片之间的关系断 |
| `~/.dsh/purpose/` | 驱动值、念头账本、出门看过的记录 | 性格从头长起，念头全忘 |
| `~/.dsh/diary/` | 自己写的日记 | 只丢日记，不影响运行 |

**engram 有三件套，别只拷 `engram.db`**：`engram.db`、`engram.db-wal`、`engram.db-shm` 是一组的。
WAL 里可能还压着没落盘的写入（实测库 1.8MB、WAL 4.1MB，关掉 engram 时才会合并）。
真要拷就先停掉 DSH，让 engram 把 WAL 合并掉；或者三件一起拷。

**不用搬的**：

- `~/.dsh/sessions/` —— 原始会话日志，是档案不是记忆。想留历史再拷，不拷也不影响「我是谁」。
- `~/.dsh/profiles/` —— 机器相关的（插件清单、端口、预设）。新机器重新装插件即可；
  `preset-mori` 里那份人设正文现在已经有 `persona.md` 这个替代品，不再需要它。
- `~/.dsh/memory/config.json` —— 配置，新机器用默认值或照 `config.example.json` 重写。
- `~/.dsh/memory/logcache/` —— 会话日志解压缓存，删了会自动重建。

一句话：**`~/.engram` + `~/.dsh/memory` + `~/.dsh/purpose` 三个目录搬过去，人和记忆就都在了。**

## 两个踩过的坑

1. **engram 的 FTS5 不切中文词**。`MATCH '记忆'` 命中 0 条（当时库里 96 条观察），拉丁词才命中。
   所以 `cards.search` 先试 FTS、再退回 `LIKE`，**LIKE 才是主力**。
2. **`new DatabaseSync(path, undefined)` 会抛** `The "options" argument must be an object.`。
   必须给默认空对象 `= {}`，否则边车库静默不可用（`link()` 返回 `edge_store_unavailable`），
   而且不报错、只是不能用 —— 这种静默降级最难查。

## 测试

```bash
node --test "test/*.test.js"
```

node 24 下给目录路径（`node --test test/`）会报 `Cannot find module .../test`，必须用 glob；
node 18 不认识 glob 参数，直接裸 `node --test`。

`node:sqlite` 要 22.5+。低版本 node（比如 18）能跑 config/archive/recall/distill/maintain/rules/inject/persona 的测试，
但 `cards` 会降级成不可用（4 个用例 skip）。

## 许可

GPL-2.0-only。

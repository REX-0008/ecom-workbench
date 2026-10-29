/** 「搜索模块点『本店搜索词』tab」改成 `flow.if` 分流 —— 离线回归。
 *
 * ## 用户为什么要这个（2026-10-20 原话）
 *
 * > 「将搜索部分还是改成 if，应该用 if 的地方就用 if。」
 *
 * 原来这一下对**所有 7 个模块**都跑，靠脚本「找不到 tab 就 `clicked:false`」空转。
 * 两个问题：① 其余 6 个模块每轮白跑一个节点 + 白等 2 秒
 * （补 30 天 × 6 个模块 ≈ 白等 6 分钟）；② 「要不要点 tab」本来是**流程结构上的差异**，
 * 用脚本兜底把它藏起来了，看画布看不出来。
 *
 * ## 这份测试盯什么
 *
 * 分两层，**缺一不可**：
 *
 * - **结构层**：存档里 IF 存在、条件左边是 `item.shopTab`、两条出口接对了；
 *   点 tab 那个节点**只挂在 true 出口上**（不再「所有模块都经过」）。
 * - **行为层**：拿真引擎（`runGraph`）真跑一遍，验证
 *   `shopTab: true` 走 true 支、其余走 false 支。
 *   ⚠️ 只验结构是**不够的**：条件名字写成 `item.module.shopTab` 时结构断言
 *   （只查字符串）照样通过，但运行时永远取到 undefined、永远走 false ——
 *   搜索模块从此不点 tab，症状与这次要修的病一模一样。
 *   所以必有一条「真的跑一遍」的断言。
 *
 * ## ⚠️ 层级别搞混（这条是本次改动最容易错的地方）
 *
 * | 循环 | `item` 是什么 | 取字段要写 |
 * |---|---|---|
 * | 循环 A（逐模块） | **模块对象本身**（`{ name, url, shopTab, … }`） | `item.shopTab` |
 * | 循环 B（逐日期） | `{ module, date }` 包装 | `item.module.btn` |
 *
 * 两个循环的 item 形状**不同**，照抄对方会得到一个永远不成立的条件。
 *
 * 跑法：node tests/douyin-if-search.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCodeFn, delayFn, branchFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { DY_MODULES } from '../scripts/browser/douyin-code.mjs'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WF = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench',
  'workflows', '取数-抖音电商罗盘.json')

console.log('=== 搜索 tab 改成 flow.if 分流（离线）===')

if (!existsSync(WF)) {
  /* 存档是构建产物，不随仓库走。没生成过就**明确说跳过**，不静默当通过。 */
  console.log('')
  console.log('（跳过：找不到存档，先跑 scripts/build-patrol-workflows.mjs）')
  process.exit(0)
}

const doc = JSON.parse(readFileSync(WF, 'utf8'))
const byId = new Map(doc.nodes.map(n => [n.id, n]))
/** 取节点标签。 @param {string} id - 节点 id。 @returns {string} 标签。 */
const labelOf = id => String(byId.get(id)?.label ?? id)

/* ── ① 模块表：只有搜索一个 shopTab: true ─────────────────────── */
console.log('')
console.log('① 模块表（判据的数据来源）')
{
  const withTab = DY_MODULES.filter(m => m.shopTab === true)
  check('★ 只有「搜索」一个模块有 shopTab: true',
    withTab.length === 1 && withTab[0].name === '搜索',
    withTab.map(m => m.name).join(',') || '（一个都没有）')
  /* 其余模块**不该有这个键**。若哪天给它们加了 `shopTab: false`，
   * 用「不为空」作判据的实现就会全部误判 —— 这条把它挡在前面。 */
  const others = DY_MODULES.filter(m => m.shopTab !== undefined && m.shopTab !== true)
  check('其余模块没有 shopTab 字段（不是 false，是压根没有）',
    others.length === 0, others.map(m => m.name + '=' + String(m.shopTab)).join(','))
}

/* ── ② 结构：IF 存在、条件对、两条出口接对 ────────────────────── */
console.log('')
console.log('② 存档里的结构（IF 与两条出口）')
const ifNode = doc.nodes.find(n => n.defId === 'flow.if' && String(n.label).startsWith('②b1'))
{
  check('★ 循环 A 里有 ②b1 这个 flow.if', ifNode !== undefined)

  /* ⚠️ 条件左边必须是 `item.shopTab`。
   * 写成 `item.module.shopTab` 时结构断言会红 —— 那正是要拦的错
   * （循环 A 的 item 是模块对象本身，没有 module 这一层）。 */
  const cond = ifNode?.params?.conditions?.[0]
  check('★ 条件左边是循环变量 item.shopTab（不是 item.module.shopTab）',
    cond?.left?.kind === 'loop' && cond?.left?.name === 'item.shopTab',
    JSON.stringify(cond?.left))
  check('★ 算子「等于」+ 真假比较 + 值为 true',
    cond?.op === 'is' && cond?.valueType === 'boolean' && String(cond?.value) === 'true',
    JSON.stringify({ op: cond?.op, valueType: cond?.valueType, value: cond?.value }))
}

/* 两条出口：true → 点 tab；false → 直接读 R。 */
const tabNode = doc.nodes.find(n => String(n.label).startsWith('②b2'))
const readR = doc.nodes.find(n => String(n.label).startsWith('②c'))
const afterTab = doc.nodes.find(n => String(n.label).startsWith('②b3'))
{
  const out = doc.edges.filter(e => e.source === ifNode?.id)
  const t = out.find(e => e.sourceHandle === 'true')
  const f = out.find(e => e.sourceHandle === 'false')
  check('★ IF 有两条出口（true / false 各一条）', out.length === 2,
    out.map(e => e.sourceHandle).join(','))
  check('★ true 出口接「点本店搜索词 tab」',
    t?.target === tabNode?.id, labelOf(String(t?.target)))
  check('★ false 出口接「读已结算日 R」（直接去读，不经过点 tab）',
    f?.target === readR?.id, labelOf(String(f?.target)))

  /* 点 tab → 等 2 秒 → 读 R：这两条边必须在 true 分支内部。 */
  check('点 tab 之后接「等 tab 切换」（2 秒）',
    doc.edges.some(e => e.source === tabNode?.id && e.target === afterTab?.id))
  check('等完之后接「读 R」',
    doc.edges.some(e => e.source === afterTab?.id && e.target === readR?.id))
}

/* ── ③ 「所有模块都经过点 tab」那个结构必须已经不在了 ─────────── */
console.log('')
console.log('③ 不再有「所有模块都要经过点 tab」的结构')
{
  /* 判据：**点 tab 那个节点的唯一入边来自 IF 的 true 出口**。
   * 若它还直接接在「②b 等页面渲染」后面（老结构），入边就是 ②b，
   * 这条会红 —— 那正是这次要消掉的东西。 */
  const into = doc.edges.filter(e => e.target === tabNode?.id)
  check('★ 点 tab 的入边只有一条，且来自 IF 的 true 出口',
    into.length === 1 && into[0].source === ifNode?.id && into[0].sourceHandle === 'true',
    into.map(e => labelOf(e.source) + '[' + (e.sourceHandle ?? '') + ']').join(' / '))

  /* ②b（等页面渲染）的下游应该是 IF，不是点 tab。 */
  const waitMod = doc.nodes.find(n => String(n.label).startsWith('②b 等页面渲染'))
  const afterWait = doc.edges.filter(e => e.source === waitMod?.id)
  check('★ ②b 之后接的是 IF（不是直接去点 tab）',
    afterWait.length === 1 && afterWait[0].target === ifNode?.id,
    afterWait.map(e => labelOf(e.target)).join(','))

  /* 等 2 秒那个节点也只在 true 分支上（否则「不白等」这件事只做了一半）。 */
  const intoAfterTab = doc.edges.filter(e => e.target === afterTab?.id)
  check('★ 「等 2 秒」也只在 true 分支上（不在主链上）',
    intoAfterTab.length === 1 && intoAfterTab[0].source === tabNode?.id,
    intoAfterTab.map(e => labelOf(e.source)).join(','))

  /* 三个节点**都还属于循环 A**（IF 只是分了条路，不改变归属）。
   * ⚠️ 这一条容易搞混：分支上的节点 `parentId` 仍是循环 A。 */
  const loopA = doc.nodes.find(n => String(n.label).startsWith('② 循环 A'))
  const inA = new Set(doc.nodes.filter(n => n.parentId === loopA?.id).map(n => n.id))
  check('IF / 点 tab / 等 2 秒都仍归属循环 A（IF 不改变归属）',
    inA.has(String(ifNode?.id)) && inA.has(String(tabNode?.id)) && inA.has(String(afterTab?.id)))
}

/* ── ④ 行为：真跑一遍，验证两种模块走不同分支 ─────────────────── */
console.log('')
console.log('④ ★ 行为验证：拿真引擎跑，两种模块必须走不同分支')
console.log('   （只验结构不够 —— 条件名写错时结构断言照样通过，运行时永远走 false）')
{
  const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]
  const ran = []

  /** 循环 A 的循环体：只留「打开页 → 等 → IF → 点 tab / 等 / 读 R」。 */
  const nodes = [
    {
      id: 'mods',
      data: {
        def: lib.find(d => d.id === 'code.js'),
        params: {
          /* ⚠️ 这个生成器返回 `{ modules: [...] }`，与 ① 模块清单 同形状。
           * 用最小的一份而不是真模块表：真表要联网开页面（红线）。 */
          code: 'return { modules: ' + JSON.stringify([
            { name: '搜索', url: 'about:blank', btn: 'first', shopTab: true },
            { name: '直播', url: 'about:blank', btn: 'first' },
          ]) + ' }',
          timeout: 30000,
        },
        onError: 'stop',
        skipped: false,
      },
    },
    {
      id: 'L',
      data: {
        def: lib.find(d => d.id === 'flow.loop'),
        params: { mode: 'items', items: { nodeId: 'mods', field: 'modules' }, result: null, count: 5, maxIters: 100, concurrency: 1 },
        onError: 'stop',
        skipped: false,
      },
    },
    /* ↓ 循环体（parentId = L），结构与存档一致 */
    {
      id: 'open',
      parentId: 'L',
      data: {
        def: lib.find(d => d.id === 'browser.act'),
        params: { action: 'goto', url: '{{item.url}}' },
        onError: 'stop',
        skipped: false,
      },
    },
    {
      id: 'wait',
      parentId: 'L',
      data: { def: lib.find(d => d.id === 'flow.delay'), params: { ms: 1, random: false }, onError: 'continue', skipped: false },
    },
    {
      id: 'if',
      parentId: 'L',
      data: {
        def: lib.find(d => d.id === 'flow.if'),
        /* ★ 条件**照存档里那份抄**（不是自己写一份）——
         * 这样存档里的条件写错时这条会红，而不是测了个平行的假结构。 */
        params: { conditions: ifNode?.params?.conditions ?? [], logic: 'and', expr: '' },
        onError: 'stop',
        skipped: false,
      },
    },
    {
      id: 'tab',
      parentId: 'L',
      data: {
        def: lib.find(d => d.id === 'browser.act'),
        params: { action: 'eval', code: 'return { ok: true, clicked: true }' },
        onError: 'stop',
        skipped: false,
      },
    },
    {
      id: 'gap',
      parentId: 'L',
      data: { def: lib.find(d => d.id === 'flow.delay'), params: { ms: 1, random: false }, onError: 'continue', skipped: false },
    },
    {
      id: 'read',
      parentId: 'L',
      data: {
        def: lib.find(d => d.id === 'browser.act'),
        params: { action: 'eval', code: 'return { ok: true, R: "2026-10-19" }' },
        onError: 'stop',
        skipped: false,
      },
    },
  ]
  const edges = [
    { source: 'mods', target: 'L' },
    { source: 'open', target: 'wait' },
    { source: 'wait', target: 'if' },
    { source: 'if', target: 'tab', sourceHandle: 'true' },
    { source: 'tab', target: 'gap' },
    { source: 'gap', target: 'read' },
    { source: 'if', target: 'read', sourceHandle: 'false' },
  ]
  const specs = toRunSpecsFromCanvas(nodes, edges)

  /** 各节点的假实现：只记录谁跑过。
   *
   * ⚠️ **必须包含 `code.js`** —— 循环 A 的 items 来自那个生成节点，
   * 漏了它会在第一轮之前就失败（`mods` 跑过、然后整份中断，
   * 而 `out.error` 是空串，看起来像「莫名中断」）。第一版就是这么错的。 */
  const IMPL = {
    'code.js': runCodeFn,
    'browser.act': async (cmd) => {
      const p = cmd.params ?? {}
      if (p.action === 'goto') return { url: p.url, title: '(测试)' }
      return { result: { ok: true } }
    },
    'flow.delay': async () => null,
    'flow.if': branchFn,
  }

  const out = await runGraph(
    { nodes: specs.nodes, edges: specs.edges, workdir: process.env.TEMP ?? '/tmp' },
    async (req) => {
      const nodeId = String(req.nodeId)
      ran.push(nodeId)
      const impl = IMPL[String(req.command?.node ?? '')]
      if (impl === undefined) return { ok: false, status: 'failed', error: '没有实现', logs: [] }
      try {
        const v = await impl(req.command, { nodeId, workdir: '', upstream: req.context?.upstream ?? [] })
        return { ok: true, status: 'success', output: v, logs: [] }
      } catch (e) {
        return { ok: false, status: 'failed', error: String(e?.message ?? e), logs: [] }
      }
    },
    { onEvent: () => { /* 不需要事件 */ } },
  )

  check('真引擎跑通（没中断）', out.aborted !== true,
    'aborted=' + String(out.aborted) + ' error=' + String(out.error ?? '')
    + ' ran=' + JSON.stringify(ran))

  /* ⚠️ 这是最要紧的一条：`tab` 必须**只跑过一次**（搜索那一轮）。
   * 老结构（所有模块都经过）会跑两次 —— 「白跑」就是它。 */
  const tabRuns = ran.filter(x => x === 'tab').length
  check('★ 点 tab 只跑了 1 次（7 个模块里只有搜索那一轮）', tabRuns === 1, '实际 ' + String(tabRuns) + ' 次')
  /* 读 R 两轮都要跑（两种模块最后都要读日期）。 */
  const readRuns = ran.filter(x => x === 'read').length
  check('★ 读 R 两轮都跑了（false 分支真的接上了）', readRuns === 2, '实际 ' + String(readRuns) + ' 次')
  /* 「等 2 秒」同样只在搜索那一轮。 */
  const gapRuns = ran.filter(x => x === 'gap').length
  check('★ 「等 tab 切换」只跑了 1 次（其余模块不白等）', gapRuns === 1, '实际 ' + String(gapRuns) + ' 次')
}

/* ── ⑤ 兜底还在（降级成防御，不是取消） ───────────────────────── */
console.log('')
console.log('⑤ 脚本里的兜底保留（降级成防御）')
{
  const codeSrc = readFileSync(join(ROOT, 'scripts/browser/douyin-code.mjs'), 'utf8')
  /* 找不到 tab 时返回 clicked:false 而不是抛错 —— 页面改版把 tab 改名时
   * 不该让整轮失败（但也说明该改选择器了，所以它只该是防御）。 */
  check('★ 找不到 tab 时返回 clicked:false（不抛错）',
    /if \(!els\.length\) return \{ ok: true, clicked: false/.test(codeSrc))
  /* 它不该再被描述成「所有模块都走」，那说明注释还停留在老结构。 */
  check('注释已更新为「只在搜索那一支」',
    !/别的模块\*\*也走这一步\*\*/.test(codeSrc))
}

console.log('')
console.log(failed === 0
  ? '结论：搜索 tab 已改成 IF 分流，且行为与结构都对得上 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

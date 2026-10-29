/** 并行节点（`flow.parallel`）的执行语义（2026-10-22）。
 *
 * ## 为什么单独一份（不并进 run-graph）
 *
 * `run-graph` 钉的是**调度器通用语义**（顺序 / 跳过 / 失败 / 环 / 循环）。
 * 这一份钉的是**并行节点这一类**的四条语义 —— 它们错了的表现都是「结果看着对、其实没并发」
 * 或「一路失败把别的路也带走了」，在通用语义的测试里看不出来。
 *
 * ## 判据全部来自用户 2026-10-21 / 22 的定案
 *
 *   ① 三路并发时，至少两路的执行区间**真的重叠**（不是靠猜时间，靠起止时间戳）；
 *   ② 中间一路抛错：整体不中断，该路位置是失败原因，另两路结果完整；
 *   ③ `concurrency: 1` 的结果与「一路一路串着跑」**深比较相等**；
 *   ④ 框内有连线（甲→乙）时乙归甲那一路，不另起一路（切分有单测钉住）。
 *
 * 跑法：node --import <tsx> tests/parallel-run.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runGraph } from '../src/workflow/run.ts'
import { parallelPlan, PARALLEL_DEF_ID } from '../src/workflow/parallel.ts'
import { NODE as PARALLEL } from '../src/nodes/flow/parallel/node.ts'
import { NODE_IMPLS } from '../src/nodes/impls.ts'

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

/**
 * 造一个节点规格。
 * @param {string} id - 节点 id。
 * @param {string} defId - 节点类型 id。
 * @param {object} [extra] - 额外字段（parentId / params / onError）。
 * @returns {object} 规格。
 */
function spec(id, defId, extra = {}) {
  return {
    id,
    def: {
      id: defId,
      label: defId,
      executor: 'builtin',
      inputs: [{ id: 'in', label: '入', type: 'any' }],
      outputs: [{ id: 'out', label: '出', type: 'any' }],
    },
    params: {},
    onError: 'continue',
    skipped: false,
    ...extra,
  }
}

/**
 * 并行节点本身那一份规格（用真定义，免得测试自己编一个形状）。
 * @param {string} id - 节点 id。
 * @param {number} concurrency - 并发上限。
 * @returns {object} 规格。
 */
function parallelSpec(id, concurrency) {
  return {
    id,
    def: PARALLEL,
    params: { concurrency },
    onError: 'continue',
    skipped: false,
  }
}

/** 等一会儿。 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

console.log('=== ① 切分规则（parallel.ts，纯函数）===')
{
  const nodes = [
    { id: 'P', defId: PARALLEL_DEF_ID },
    { id: 'a', defId: 'code.js', parentId: 'P' },
    { id: 'b', defId: 'code.js', parentId: 'P' },
    { id: 'c', defId: 'code.js', parentId: 'P' },
  ]
  const plan = parallelPlan(nodes, [], 'P')
  check('三个互不相连的成员 → 三路', plan?.lanes.length === 3, String(plan?.lanes.length))
  check('每路一个成员', JSON.stringify(plan?.lanes.map(l => l.ids)) === '[["a"],["b"],["c"]]',
    JSON.stringify(plan?.lanes.map(l => l.ids)))
  check('路按拓扑序排（a/b/c）', JSON.stringify(plan?.lanes.map(l => l.head)) === '["a","b","c"]',
    JSON.stringify(plan?.lanes.map(l => l.head)))

  /* ★ 框内有连线：乙归甲那一路，不另起一路。 */
  const chained = parallelPlan(nodes, [{ source: 'a', target: 'b' }], 'P')
  check('★★ 甲→乙时只有两路（乙不另起一路）', chained?.lanes.length === 2,
    JSON.stringify(chained?.lanes.map(l => l.ids)))
  check('★★ 乙归甲那一路、顺序是 a→b', JSON.stringify(chained?.lanes[0].ids) === '["a","b"]',
    JSON.stringify(chained?.lanes[0]?.ids))
  check('甲那一路的末端是 b（结果从它取）', JSON.stringify(chained?.lanes[0].tails) === '["b"]',
    JSON.stringify(chained?.lanes[0]?.tails))
  check('c 仍是独立一路', JSON.stringify(chained?.lanes[1].ids) === '["c"]',
    JSON.stringify(chained?.lanes[1]?.ids))

  /* 分叉：甲 → 乙、甲 → 丙 时仍是一路（两条下游都归甲）。 */
  const fork = parallelPlan(nodes, [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }], 'P')
  check('★ 一个成员分叉到两个下游 → 仍是一路', fork?.lanes.length === 1,
    JSON.stringify(fork?.lanes.map(l => l.ids)))
  check('那一路的两个末端都算末端', JSON.stringify(fork?.lanes[0].tails.sort()) === '["b","c"]',
    JSON.stringify(fork?.lanes[0]?.tails))

  /* 空框 / 不是并行节点 → 可区分的结果（空框不再返回 null，见第 ⑧ 段）。 */
  const emptyPlan = parallelPlan([{ id: 'P', defId: PARALLEL_DEF_ID }], [], 'P')
  check('空框给的是 kind=empty（与「跨路汇合」区分开）', emptyPlan?.kind === 'empty', String(emptyPlan?.kind))
  check('空框不是 null（null 只留给「没有这个并行节点」）', emptyPlan !== null)
  check('id 不是并行节点 → null', parallelPlan([{ id: 'X', defId: 'flow.loop' }], [], 'X') === null)
}

console.log('')
console.log('=== ② 三路并发：执行区间真的重叠（concurrency: 2）===')
let overlapSeen = 0
{
  const nodes = [
    parallelSpec('P', 2),
    spec('a1', 'code.js', { parentId: 'P' }),
    spec('a2', 'code.js', { parentId: 'P' }),
    spec('a3', 'code.js', { parentId: 'P' }),
  ]
  /** 每个节点的起止时间（真实时钟）。 */
  const span = []
  const fn = async (req) => {
    const t0 = Date.now()
    await sleep(80)
    span.push({ id: req.nodeId, t0, t1: Date.now() })
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  const r = await runGraph({ nodes, edges: [] }, fn)
  const byId = new Map(span.map(s => [s.id, s]))
  /** 两段区间重叠吗。 */
  const overlaps = (x, y) => x.t0 < y.t1 && y.t0 < x.t1
  const pair12 = overlaps(byId.get('a1'), byId.get('a2'))
  const pair13 = overlaps(byId.get('a1'), byId.get('a3'))
  const pair23 = overlaps(byId.get('a2'), byId.get('a3'))
  overlapSeen = [pair12, pair13, pair23].filter(Boolean).length
  check('★★ 三路都跑了', span.length === 3, span.map(s => s.id).join(','))
  check('★★ 至少有一对执行区间重叠（真并发，不是串行）', overlapSeen >= 1,
    '重叠对数 ' + String(overlapSeen) + '；区间 ' + JSON.stringify(span))
  check('★ concurrency 2 时不是三路同时（上限生效）', overlapSeen < 3,
    '重叠对数 ' + String(overlapSeen))
  check('输出是按路次排好的数组', JSON.stringify(r.outputs.get('P')) === '["out:a1","out:a2","out:a3"]',
    JSON.stringify(r.outputs.get('P')))
  check('整体没被中断', r.aborted === false, String(r.aborted))
}

console.log('')
console.log('=== ③ 一路失败：不打断其它（该路位置给失败原因）===')
{
  const nodes = [
    parallelSpec('P', 3),
    spec('a1', 'code.js', { parentId: 'P' }),
    spec('a2', 'code.js', { parentId: 'P' }),
    spec('a3', 'code.js', { parentId: 'P' }),
  ]
  const fn = async (req) => (req.nodeId === 'a2'
    ? { ok: false, status: 'failed', error: '接口 502' }
    : { ok: true, status: 'success', output: 'out:' + req.nodeId })
  const r = await runGraph({ nodes, edges: [] }, fn)
  const out = r.outputs.get('P')
  check('★★ 整体没中断（一路失败不带停整条）', r.aborted === false, String(r.aborted))
  check('★★ 另两路结果完整', out?.[0] === 'out:a1' && out?.[2] === 'out:a3', JSON.stringify(out))
  check('★★ 失败那一路的位置是失败原因（字符串）',
    typeof out?.[1] === 'string' && out[1].includes('失败'), JSON.stringify(out?.[1]))
  check('失败原因里带得上「这一路」的判断（不是一句空话）',
    String(out?.[1]).includes('这一路'), String(out?.[1]))
}

console.log('')
console.log('=== ④ 路内顺序：甲→乙 时先甲后乙 ===')
{
  const nodes = [
    parallelSpec('P', 1),
    spec('a', 'code.js', { parentId: 'P' }),
    spec('b', 'code.js', { parentId: 'P' }),
  ]
  const seen = []
  const fn = async (req) => {
    seen.push(req.nodeId)
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  const r = await runGraph({ nodes, edges: [{ source: 'a', target: 'b' }] }, fn)
  check('路内顺序是 a→b', JSON.stringify(seen) === '["a","b"]', JSON.stringify(seen))
  check('输出是「一路一项」（这一路的末端是 b）', JSON.stringify(r.outputs.get('P')) === '["out:b"]',
    JSON.stringify(r.outputs.get('P')))
}

console.log('')
console.log('=== ⑤ concurrency: 1 与「一路一路串着跑」深比较相等 ===')
{
  /** 造并行版（三路，concurrency 1）。 */
  const parNodes = [
    parallelSpec('P', 1),
    spec('a1', 'code.js', { parentId: 'P' }),
    spec('a2', 'code.js', { parentId: 'P' }),
    spec('a3', 'code.js', { parentId: 'P' }),
  ]
  /** 造串行版：同样三个节点，用连线串起来（一路一路挨着跑）。 */
  const seqNodes = [spec('a1', 'code.js'), spec('a2', 'code.js'), spec('a3', 'code.js')]
  const seqEdges = [{ source: 'a1', target: 'a2' }, { source: 'a2', target: 'a3' }]

  /** 跑一次并收集派发顺序。 */
  const run = async (nodes, edges) => {
    const order = []
    const fn = async (req) => {
      order.push(req.nodeId)
      return { ok: true, status: 'success', output: 'out:' + req.nodeId }
    }
    const r = await runGraph({ nodes, edges }, fn)
    return { order, r }
  }

  const par = await run(parNodes, [])
  const seq = await run(seqNodes, seqEdges)

  check('★★ 派发顺序完全一样（a1→a2→a3）', JSON.stringify(par.order) === JSON.stringify(seq.order),
    JSON.stringify(par.order) + ' vs ' + JSON.stringify(seq.order))
  check('★★ 结果深比较相等（并行输出的数组 = 串行三次的输出）',
    JSON.stringify(par.r.outputs.get('P')) === JSON.stringify(['out:a1', 'out:a2', 'out:a3']),
    JSON.stringify(par.r.outputs.get('P')))
  check('★ 串行那条路自己能跑出来（不是拿空数组比）',
    seq.r.outputs.get('a3') === 'out:a3', JSON.stringify(seq.r.outputs.get('a3')))

  /* 再跑一遍并行版，确认两次结果完全相同（并发没有引入顺序抖动）。 */
  const again = await run(parNodes, [])
  check('★★ 并行版跑两次，结果逐字相同', JSON.stringify(again.r.outputs.get('P')) === JSON.stringify(par.r.outputs.get('P')),
    JSON.stringify(again.r.outputs.get('P')))
}

console.log('')
console.log('=== ⑥ 空框：明确报错（不静默什么都不做）===')
{
  const nodes = [parallelSpec('P', 1)]
  let r = null
  try {
    r = await runGraph({ nodes, edges: [] }, async () => ({ ok: true, status: 'success', output: 'x' }))
  } catch (e) {
    r = { error: e instanceof Error ? e.message : String(e) }
  }
  /* 并行节点 onError 是 continue → 失败被吞掉，但事件里要有 failed。 */
  check('空框不会静默成功（输出里没有伪造的数组）', r.outputs?.get('P') === undefined,
    JSON.stringify(r.outputs?.get('P')))
}

console.log('')
console.log('=== ⑦ 接力：并行节点从 NODE_IMPLS 移除、文案如实 ===')
{
  check('★★ NODE_IMPLS 里没有 flow.parallel', !NODE_IMPLS.has('flow.parallel'),
    [...NODE_IMPLS.keys()].join(','))
  check('★★ label 是「并行」且不带「未完善」', PARALLEL.label === '并行', String(PARALLEL.label))

  /* 占位那句话不许再出现在源码里。 */
  const impls = readFileSync(join(ROOT, 'src/nodes/impls.ts'), 'utf8')
  check('★★ 源码里没有「尚未接入调度器」那句占位', !impls.includes('尚未接入调度器'))
  check('★ 源码里不再有「parallel: false」占位返回', !/parallel:\s*false/.test(impls))

  /* detail 必须如实写「画布暂不支持」，且不许写「拖进去即可」这类话。 */
  const detailText = [
    PARALLEL.detail?.what, PARALLEL.detail?.inputs, PARALLEL.detail?.outputs,
    PARALLEL.detail?.whenToUse, PARALLEL.detail?.cautions,
  ].join('\n')
  check('★★ detail 写明画布暂不支持放进并行框', detailText.includes('画布暂不支持'),
    detailText.slice(0, 80))
  check('★★ detail 写明要改 parentId', detailText.includes('parentId'))
  check('★★ 没有「拖进去即可」这类假话', !/拖进去|拖进框|拖到.*就(行|可以)/.test(detailText))
  check('★ detail 写明一路失败不打断其它', detailText.includes('不打断其它'))
}

console.log('')
console.log('=== ⑧ 跨路汇合（甲→丙、乙→丙）→ 计划层可区分地拒绝 ===')
{
  const nodes = [
    { id: 'P', defId: PARALLEL_DEF_ID },
    { id: '甲', defId: 'code.js', parentId: 'P' },
    { id: '乙', defId: 'code.js', parentId: 'P' },
    { id: '丙', defId: 'code.js', parentId: 'P' },
  ]
  const edges = [{ source: '甲', target: '丙' }, { source: '乙', target: '丙' }]
  const plan = parallelPlan(nodes, edges, 'P')

  check('★★ kind 是 cross-lane-merge（不是 ok、也不是 null）', plan?.kind === 'cross-lane-merge',
    String(plan?.kind))
  check('★★ 不再给出「切成 2 路、丙归第二路」那种结果', Array.isArray(plan?.lanes) && plan.lanes.length === 0,
    JSON.stringify(plan?.lanes))
  check('★★ 指出了哪个节点是汇合点', plan?.merges.length === 1 && plan.merges[0].target === '丙',
    JSON.stringify(plan?.merges))
  check('★★ 指出了汇合点的两个来源', JSON.stringify(plan?.merges?.[0]?.sources?.slice().sort()) === '["乙","甲"]',
    JSON.stringify(plan?.merges?.[0]?.sources))

  /* 反向：一个成员分叉再合回来（甲→乙、甲→丙、乙→丁、丙→丁）不是「跨路」——
   * 丁 的两个上游都从甲出发，仍属同一路。这一条防「检测过严把正常形状也拒了」。 */
  const diamond = [
    { id: 'P', defId: PARALLEL_DEF_ID },
    { id: 'a', defId: 'code.js', parentId: 'P' },
    { id: 'b', defId: 'code.js', parentId: 'P' },
    { id: 'c', defId: 'code.js', parentId: 'P' },
    { id: 'd', defId: 'code.js', parentId: 'P' },
  ]
  const diamondEdges = [
    { source: 'a', target: 'b' }, { source: 'a', target: 'c' },
    { source: 'b', target: 'd' }, { source: 'c', target: 'd' },
  ]
  const dp = parallelPlan(diamond, diamondEdges, 'P')
  check('★ 同一起点的菱形（分叉又合回）不算跨路汇合', dp?.kind === 'ok', String(dp?.kind))
  check('★ 菱形仍是一路、末端是 d', JSON.stringify(dp?.lanes.map(l => l.ids)) === '[["a","b","c","d"]]'
    && JSON.stringify(dp?.lanes[0].tails) === '["d"]',
    JSON.stringify(dp?.lanes.map(l => l.ids)) + ' / ' + JSON.stringify(dp?.lanes[0]?.tails))
}

console.log('')
console.log('=== ⑨ 跨路汇合走完整调度：明确报错（不是静默给结果）===')
{
  const nodes = [
    parallelSpec('P', 2),
    spec('甲', 'code.js', { parentId: 'P' }),
    spec('乙', 'code.js', { parentId: 'P' }),
    spec('丙', 'code.js', { parentId: 'P' }),
  ]
  const edges = [{ source: '甲', target: '丙' }, { source: '乙', target: '丙' }]
  const events = []
  const fn = async (req) => ({ ok: true, status: 'success', output: 'o:' + req.nodeId })
  const r = await runGraph({ nodes, edges }, fn, { onEvent: (e) => events.push(e) })

  const failedEv = events.filter(e => e.kind === 'failed' && e.nodeId === 'P')
  const logs = events.filter(e => e.kind === 'log' && e.nodeId === 'P').map(e => e.line)
  const errLine = logs.find(l => l.includes('汇合')) ?? ''

  check('★★ 发了 failed 事件（不是静默成功）', failedEv.length === 1, JSON.stringify(failedEv))
  check('★★ 日志里说清是「哪几个汇到哪」',
    errLine.includes('甲') && errLine.includes('乙') && errLine.includes('丙'), errLine)
  check('★★ 说清是不支持跨路汇合', errLine.includes('不支持跨路汇合'), errLine)
  check('★★ 给出了办法（先用「合并」节点 / 改成串联）',
    errLine.includes('合并') || errLine.includes('串联'), errLine)
  check('★★ 并行节点没有输出一个「看着对」的数组', r.outputs.get('P') === undefined,
    JSON.stringify(r.outputs.get('P')))
  check('★★ 丙没被执行（拒绝发生在跑之前）', !r.ran.includes('丙') && !r.ran.includes('甲'),
    r.ran.join('→'))
}

console.log('')
console.log('=== ⑩ 支持的形状：concurrency 1 与 3 两次输出深比较相等 ===')
{
  /* 形状一：三路互不相连。 */
  const flat = [
    parallelSpec('P', 1),
    spec('a1', 'code.js', { parentId: 'P' }),
    spec('a2', 'code.js', { parentId: 'P' }),
    spec('a3', 'code.js', { parentId: 'P' }),
  ]
  /* 形状二：两路，其中一路内部串联（a1→a2），另一路单个（b1）。 */
  const mixed = [
    parallelSpec('P', 1),
    spec('a1', 'code.js', { parentId: 'P' }),
    spec('a2', 'code.js', { parentId: 'P' }),
    spec('b1', 'code.js', { parentId: 'P' }),
  ]
  const mixedEdges = [{ source: 'a1', target: 'a2' }]

  /**
   * 按给定并发上限跑一次，返回并行节点的输出。
   * @param {object[]} nodes - 节点（含一个并行节点，第一项）。
   * @param {object[]} edges - 连线。
   * @param {number} conc - 并发上限。
   * @returns {Promise<{out: unknown, order: string[]}>} 输出与派发顺序。
   */
  const runWith = async (nodes, edges, conc) => {
    const withConc = nodes.map(n => (n.id === 'P' ? { ...n, params: { concurrency: conc } } : n))
    const order = []
    const fn = async (req) => {
      order.push(req.nodeId)
      /* 轻微随机延迟 —— 让并发时的完成先后不固定，更接近真机。 */
      await sleep(Math.floor(Math.random() * 6))
      return { ok: true, status: 'success', output: 'o:' + req.nodeId }
    }
    const r = await runGraph({ nodes: withConc, edges }, fn)
    return { out: r.outputs.get('P'), order }
  }

  for (const [name, nodes, edges] of [['三路互不相连', flat, []], ['两路（一路内部串联）', mixed, mixedEdges]]) {
    /* 各跑三轮，确保不是碰巧一次相等。 */
    const ones = []
    const threes = []
    for (let k = 0; k < 3; k += 1) {
      ones.push((await runWith(nodes, edges, 1)).out)
      threes.push((await runWith(nodes, edges, 3)).out)
    }
    const same = ones.every(o => JSON.stringify(o) === JSON.stringify(ones[0]))
      && threes.every(o => JSON.stringify(o) === JSON.stringify(threes[0]))
      && JSON.stringify(ones[0]) === JSON.stringify(threes[0])
    check('★★ ' + name + '：concurrency 1 与 3 输出深比较相等（各跑三轮）', same,
      'c=1 → ' + JSON.stringify(ones[0]) + '；c=3 → ' + JSON.stringify(threes[0]))
  }
}

console.log('')
console.log('=== ⑪ 文档与实现一致：说「明确拒绝」，不说「读不到对面」===')
{
  const par = readFileSync(join(ROOT, 'src/workflow/parallel.ts'), 'utf8')
  const node = readFileSync(join(ROOT, 'src/nodes/flow/parallel/node.ts'), 'utf8')

  check('★★ parallel.ts 文件头不再写「归最早那一路」', !par.includes('归最早那一路'))
  check('★★ parallel.ts 文件头不再写「读不到对面那一路的结果」', !par.includes('读不到对面那一路的结果'))
  check('★★ parallel.ts 文件头写明「明确拒绝」', par.includes('明确拒绝'))
  check('★★ node.ts 的 detail 不再写「读不到另一路的结果」', !node.includes('读不到另一路的结果'))
  check('★★ node.ts 的 detail 写明不支持跨路汇合', node.includes('不支持跨路汇合'))
  check('★ node.ts 的 detail 给出办法（合并 / 串联）',
    node.includes('「合并」节点') || node.includes('串联'))

  /* 文案守 R6：无第二人称、无疑问句。 */
  const detailText = [
    PARALLEL.detail?.what, PARALLEL.detail?.inputs, PARALLEL.detail?.outputs,
    PARALLEL.detail?.whenToUse, PARALLEL.detail?.cautions,
  ].join('\n')
  check('R6：没有第二人称「你」', !detailText.includes('你'))
  check('R6：没有疑问句做标签', !/[？?]/.test(detailText))
}

console.log('')
if (failed === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(failed) + ' 条红的 ✗')
process.exit(1)

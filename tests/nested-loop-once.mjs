/** 嵌套循环「一次点到位」：**不许需要点好几次**（用户 2026-10-21 报的真 BUG）。
 *
 * ## 用户原话
 *
 * > 「横排竖排，如果循环嵌套比较多，**需要多点几次才能排出来**，
 * >  我看的是取数-千川全域推广，需要点 4 下。」
 *
 * ## 根因（已修）
 *
 * `memberSize` 原来的顺序是「**先查实测表 `sizes`、查到就返回**」，
 * 只有查不到时才看 `style`。
 *
 * 而 `sizes` 是 `measureNodes` **量 DOM** 得到的 —— 那是**本轮开始时的快照**。
 * 循环框的尺寸是同一轮里 `fitLoopBox` **刚算出来、写进 `style`** 的，
 * DOM 还没重绘，所以实测表里是**上一帧的旧值**。
 *
 * 于是：外层按内层的**旧**尺寸给它留位 → 内层这一轮长宽了 → 装不下。
 * 一帧只能修正一层，嵌套 N 层就要点 N 次。
 *
 * ## 修法
 *
 * 循环框的尺寸**以 `style` 为准，先于实测表** —— 那是我们自己刚决定的值，
 * 比「上次量到的」准。普通节点仍走实测表（它们的高度由浏览器排出来，预知不了）。
 *
 * ## 判据（三条，缺一条都不够）
 *
 * ① **一次 refit 就全部装得下**（1~4 层、各方向、各手动轴向）；
 * ② 成员之间**不重叠**（装得下但不重叠才叫排好）；
 * ③ 切换方向后**第一次 refit 就到位**（这正是用户报的情形）。
 *
 * ⚠️ 判据必须用**假的旧尺寸表**（模拟「DOM 还没更新」）——
 * 用新尺寸表的话，那个顺序 bug 一样能通过（假绿）。
 *
 * 跑法：node --import <tsx> tests/nested-loop-once.mjs
 */
import { relayoutInside, fitLoopBox, orderLoopsInnerFirst } from '../src/client/workbench/container-ops.ts'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const FB = { w: 300, h: 168 }

/**
 * 造一个循环框。
 * @param id - id。
 * @param parent - 父循环 id（没有则不设）。
 * @param axis - 手动方向。
 * @returns 节点。
 */
const loop = (id, parent, axis) => {
  const out = {
    id,
    position: { x: 0, y: 0 },
    data: { def: { id: 'flow.loop' }, ...(axis === undefined ? {} : { axis }) },
    style: { width: 380, height: 272 },
  }
  if (parent !== undefined) out.parentId = parent
  return out
}

/**
 * 造一个普通成员。
 * @param id - id。
 * @param parent - 所属循环。
 * @returns 节点。
 */
const member = (id, parent) => ({ id, position: { x: 0, y: 0 }, parentId: parent, data: { def: { id: 'code.js' } } })

/**
 * 造 N 层嵌套，每层 3 个普通成员（连成一条链）。
 * @param depth - 层数。
 * @param axis - 所有循环框的手动方向（undefined = 用自动）。
 * @returns `{ nodes, edges }`。
 */
const build = (depth, axis) => {
  const nodes = []
  const edges = []
  for (let i = 0; i < depth; i += 1) {
    const id = 'L' + String(i)
    nodes.push(loop(id, i === 0 ? undefined : 'L' + String(i - 1), axis))
    for (let k = 0; k < 3; k += 1) {
      const m = 'm' + String(i) + '_' + String(k)
      nodes.push(member(m, id))
      if (k > 0) edges.push({ source: 'm' + String(i) + '_' + String(k - 1), target: m })
    }
  }
  return { nodes, edges }
}

/**
 * **旧**尺寸表：循环框一律 380×272（= 首帧 / 上一帧的值）。
 *
 * ⚠️ 这正是「DOM 还没重绘」的形状。用真实新尺寸的话，那个顺序 bug 照样通过。
 * @param nodes - 节点。
 * @returns 尺寸表。
 */
const staleSizes = (nodes) => {
  const s = new Map()
  for (const n of nodes) {
    s.set(n.id, n.data.def.id === 'flow.loop' ? { w: 380, h: 272 } : { w: 300, h: 168 })
  }
  return s
}

/**
 * 一次 refit —— 与画布 `refitNodes` 完全同构（**sizes 整轮共用一份快照**）。
 * @param nodes - 节点。
 * @param edges - 边。
 * @param dir - 画布方向。
 * @returns 排好的节点。
 */
const refit = (nodes, edges, dir) => {
  let next = nodes
  const sizes = staleSizes(next)
  for (const loopId of orderLoopsInnerFirst(next)) {
    next = relayoutInside(next, loopId, edges, sizes, FB, dir)
    next = fitLoopBox(next, loopId, sizes, FB)
  }
  return next
}

/**
 * 找出没排好的地方：越界 或 成员互相重叠。
 * @param nodes - 节点。
 * @returns 问题列表（空 = 排好了）。
 */
const problemsOf = (nodes) => {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const bad = []
  for (const n of nodes) {
    if (n.parentId === undefined) continue
    const p = byId.get(n.parentId)
    if (p === undefined) continue
    const pw = Number(p.style.width)
    const ph = Number(p.style.height)
    const nw = n.style !== undefined ? Number(n.style.width) : FB.w
    const nh = n.style !== undefined ? Number(n.style.height) : FB.h
    if (n.position.x < 0 || n.position.y < 0 || n.position.x + nw > pw || n.position.y + nh > ph) {
      bad.push(n.id + ' 露在 ' + p.id + ' 外')
    }
  }
  /* 同层的成员之间不许重叠。 */
  const byParent = new Map()
  for (const n of nodes) {
    if (n.parentId === undefined) continue
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, [])
    byParent.get(n.parentId).push(n)
  }
  for (const [pid, kids] of byParent) {
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i]
        const b = kids[j]
        const aw = a.style !== undefined ? Number(a.style.width) : FB.w
        const ah = a.style !== undefined ? Number(a.style.height) : FB.h
        const bw = b.style !== undefined ? Number(b.style.width) : FB.w
        const bh = b.style !== undefined ? Number(b.style.height) : FB.h
        const overlap = a.position.x < b.position.x + bw && b.position.x < a.position.x + aw
          && a.position.y < b.position.y + bh && b.position.y < a.position.y + ah
        if (overlap) bad.push(a.id + ' 与 ' + b.id + ' 重叠（同在 ' + pid + '）')
      }
    }
  }
  return bad
}

console.log('=== ① 一次 refit 就全部排对（各层数 × 各方向）===')
{
  let worst = ''
  for (const depth of [1, 2, 3, 4]) {
    for (const [axis, dir] of [[undefined, 'RIGHT'], ['LR', 'RIGHT'], ['TB', 'DOWN'], [undefined, 'DOWN']]) {
      const { nodes, edges } = build(depth, axis)
      const out = refit(nodes, edges, dir)
      const bad = problemsOf(out)
      const tag = String(depth) + ' 层 / axis=' + String(axis) + ' / dir=' + dir
      if (bad.length > 0 && worst === '') worst = tag + '：' + bad.slice(0, 2).join('; ')
      /* 每格一条，但只在失败时打印明细（成功时不刷屏）。 */
      if (bad.length > 0) console.log('      ✗ ' + tag + ' —— ' + bad.slice(0, 3).join('; '))
    }
  }
  check('★★★ 4 层 × 4 种方向组合，全部一次到位', worst === '', worst)
}

console.log('')
console.log('=== ② 成员之间不重叠（装得下 ≠ 排好了）===')
{
  const { nodes, edges } = build(3, 'LR')
  const out = refit(nodes, edges, 'RIGHT')
  /* 只查重叠，不查越界（越界由 ① 管）。 */
  const overlapOnly = problemsOf(out).filter(x => x.includes('重叠'))
  check('★★ 横排三层：同层成员不重叠', overlapOnly.length === 0, overlapOnly.slice(0, 2).join('; '))
}

console.log('')
console.log('=== ③ 切换方向：第一次 refit 就到位（用户报的正是这个）===')
{
  const { nodes, edges } = build(3, undefined)
  let cur = refit(nodes, edges, 'RIGHT')
  check('起点（自动竖排）排好了', problemsOf(cur).length === 0)

  /* 用户点「切横排」。 */
  cur = cur.map(n => (n.data.def.id === 'flow.loop' ? { ...n, data: { ...n.data, axis: 'LR' } } : n))
  cur = refit(cur, edges, 'RIGHT')
  check('★★★ 切横排后**第一次** refit 就排好（不许点第二次）',
    problemsOf(cur).length === 0, problemsOf(cur).slice(0, 3).join('; '))

  /* 再切回竖排。 */
  cur = cur.map(n => (n.data.def.id === 'flow.loop' ? { ...n, data: { ...n.data, axis: 'TB' } } : n))
  cur = refit(cur, edges, 'RIGHT')
  check('★★★ 切回竖排后**第一次** refit 也排好',
    problemsOf(cur).length === 0, problemsOf(cur).slice(0, 3).join('; '))
}

console.log('')
console.log('=== ④ 幂等：再 refit 一次结果不变（不会越排越歪）===')
{
  const { nodes, edges } = build(3, 'LR')
  const once = refit(nodes, edges, 'RIGHT')
  const twice = refit(once, edges, 'RIGHT')
  check('★ 第二次 refit 坐标完全不变', JSON.stringify(once) === JSON.stringify(twice))
}

console.log('')
console.log('=== ⑤ 真实存档（取数-千川全域推广，三层嵌套）===')
{
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const F = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows', '取数-千川全域推广.json')
  if (!existsSync(F)) {
    console.log('  （跳过：没有那份存档）')
  } else {
    const doc = JSON.parse(readFileSync(F, 'utf8'))
    const nodes = doc.nodes.map(n => ({
      id: n.id,
      position: n.position,
      ...(n.parentId === undefined ? {} : { parentId: n.parentId }),
      data: { def: { id: n.defId } },
      ...(n.style === undefined ? {} : { style: n.style }),
    }))
    const edges = doc.edges.map(e => ({ source: e.source, target: e.target }))
    /* 用户点一下「全切横排」。 */
    const flipped = nodes.map(n => (n.data.def.id === 'flow.loop'
      ? { ...n, data: { ...n.data, axis: 'LR' } }
      : n))
    const out = refit(flipped, edges, 'RIGHT')
    const bad = problemsOf(out)
    check('★★★ 真实存档切横排后一次到位', bad.length === 0, bad.slice(0, 3).join('; '))
  }
}

console.log('')
console.log(failed === 0 ? '结论：嵌套循环一次点到位 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

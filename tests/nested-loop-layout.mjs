/** 嵌套循环的**框内排版**：内层成员要装进内层框，内层框要装进外层框。
 *
 * ## 这个测试守的是什么（用户 2026-10-21）
 *
 * 原话：「我打开了几个画布，涉及到循环的自动排版都有问题，应该是这部分逻辑处理有问题」
 *
 * 症状：嵌套循环里，**内层的成员被排成横排、露到框外**。
 * 实测（`取数-千川全域推广` 的 n12 在 n9 里）：n12 的成员位置是
 * `x=40 / x=380`、y 相同（横排），而 n12 的框只有 380 宽 → 第二个成员整个在外面。
 *
 * 根因：`relayoutInside` 在排外层时会**递归再排一遍内层**，传的轴是 `flipAxis`。
 * 于是内层被排了两次、两次轴向**相反**：
 *   · 它自己那一轮 `innerAxisOf('RIGHT')` = **TB**（竖排）；
 *   · 被外层递归那一轮 `flipAxis(TB)` = **LR**（横排）—— 后者覆盖前者。
 * 而外层拿到的内层尺寸是「竖排那轮算的」→ 装不下。
 *
 * ## 判据（都是几何，不查文字）
 *
 * ① 内层成员排成**竖排**（x 只有一种、y 多种）—— 与 `innerAxisOf('RIGHT')` 一致；
 * ② 每个成员都在自己的框内（右/下不越界）；
 * ③ 内层框在外层框内；
 * ④ 反复 refit 收敛（幂等，不会越排越歪）；
 * ⑤ 真实存档（`取数-千川全域推广` 三层嵌套）逐层都对。
 *
 * ⚠️ **不能只在 jsdom 里看「渲染出来几个节点」** —— 排版错的症状是
 * 「节点互相压住 / 露在框外」，而 jsdom 没有布局，那种错在渲染层看不出来。
 * 所以这里直接调纯函数、比坐标。
 *
 * ## ★ 这份测试**不写死任何节点 id**
 *
 * 存档里的 id 是生成器 `add()` 的**调用序号**（`'n' + String(++this.n)`，
 * 见 `scripts/build-patrol-workflows.mjs`）—— **加一个节点，后面全部后移**。
 * 所以循环一律按 `defId === 'flow.loop'` + `parentId` 链**动态取**，
 * 层级也现算。**要写死 id 之前先读这一段**：
 * 写死的那一刻，测试就和生成器的节点顺序绑死了，而那个顺序没有任何人承诺过。
 *
 * （历史：这里曾写死 `['n12', 'n9', 'n3']`。契约 S2 把登录检查提到循环外之后，
 * 循环变成 `n15/n21/n24`，测试于是报出 15 条「装不进 0×0」——
 * 看着像排版坏了，其实只是**观测点找错了**。）
 *
 * 跑法：node --import <tsx> tests/nested-loop-layout.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { relayoutInside, fitLoopBox, innerAxisOf } from '../src/client/workbench/container-ops.ts'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const FALLBACK = { w: 300, h: 168 }
/** 造循环框。 */
const mkLoop = (id, parent, style) => ({
  id,
  position: { x: 0, y: 0 },
  ...(parent === undefined ? {} : { parentId: parent }),
  data: { def: { id: 'flow.loop' } },
  style: style ?? { width: 380, height: 272 },
})
/** 造普通节点。 */
const mkNode = (id, parent) => ({
  id,
  position: { x: 0, y: 0 },
  parentId: parent,
  data: { def: { id: 'code.js' } },
})

/**
 * 复刻画布 `refitNodes` 的调用顺序（内层先、外层后）。
 * @param nodes - 初始节点。
 * @param loopIds - 循环 id（**内层在前**）。
 * @param edges - 连线。
 * @param sizes - 实测尺寸。
 * @returns 排好的节点。
 */
const refit = (nodes, loopIds, edges, sizes) => {
  let cur = nodes
  for (const id of loopIds) {
    cur = relayoutInside(cur, id, edges, sizes, FALLBACK, 'RIGHT')
    cur = fitLoopBox(cur, id, sizes, FALLBACK)
  }
  return cur
}

/** 某个容器的成员。 */
const kidsOf = (nodes, id) => nodes.filter(n => n.parentId === id)

console.log('=== ① 最小嵌套：内层 2 个成员 ===')
{
  const sizes = new Map([['b1', { w: 300, h: 168 }], ['b2', { w: 300, h: 168 }], ['c1', { w: 300, h: 168 }]])
  const nodes = [
    mkLoop('L'),
    mkLoop('A', 'L'),
    mkNode('c1', 'L'),
    mkNode('b1', 'A'),
    mkNode('b2', 'A'),
  ]
  const edges = [{ source: 'b1', target: 'b2' }]
  const out = refit(nodes, ['A', 'L'], edges, sizes)

  const a = out.find(n => n.id === 'A')
  const l = out.find(n => n.id === 'L')
  const kidsA = kidsOf(out, 'A')
  const xs = new Set(kidsA.map(k => k.position.x))
  const ys = new Set(kidsA.map(k => k.position.y))

  /* ① 竖排：x 一致、y 不同（`innerAxisOf('RIGHT')` = TB）。 */
  check('★ 判据前提：画布向右时框内应竖排', innerAxisOf('RIGHT') === 'TB')
  check('★★ 内层成员是竖排（x 一种、y 多种）', xs.size === 1 && ys.size === 2,
    'x 有 ' + String(xs.size) + ' 种、y 有 ' + String(ys.size) + ' 种')

  /* ② 每个成员在自己框内。 */
  const aw = Number(a.style.width)
  const ah = Number(a.style.height)
  for (const k of kidsA) {
    const okx = k.position.x >= 0 && k.position.x + 300 <= aw
    const oky = k.position.y >= 0 && k.position.y + 168 <= ah
    check('★ 成员 ' + k.id + ' 装在内层框内', okx && oky,
      'x ' + String(k.position.x) + '+' + String(300) + ' vs ' + String(aw) + '；y ' + String(k.position.y) + '+' + String(168) + ' vs ' + String(ah))
  }

  /* ③ 内层框装在外层框内。 */
  const lw = Number(l.style.width)
  const lh = Number(l.style.height)
  check('★★ 内层框装在外层框内', a.position.x + aw <= lw && a.position.y + ah <= lh,
    'A 右下 (' + String(a.position.x + aw) + ',' + String(a.position.y + ah) + ') vs L ' + String(lw) + '×' + String(lh))

  /* ④ 收敛。 */
  const again = refit(out, ['A', 'L'], edges, sizes)
  check('★★ 再 refit 一次结果不变（幂等）', JSON.stringify(again) === JSON.stringify(out))
}

console.log('')
console.log('=== ② 三层嵌套 ===')
{
  const sizes = new Map([
    ['d1', { w: 300, h: 168 }], ['d2', { w: 300, h: 168 }],
    ['e1', { w: 300, h: 168 }],
  ])
  const nodes = [
    mkLoop('O'),
    mkLoop('M', 'O'),
    mkLoop('I', 'M'),
    mkNode('e1', 'O'),
    mkNode('d1', 'I'),
    mkNode('d2', 'I'),
  ]
  const edges = [{ source: 'd1', target: 'd2' }]
  const out = refit(nodes, ['I', 'M', 'O'], edges, sizes)

  /** 逐层检查「装着吗」。 */
  const contains = (parentId, childId) => {
    const p = out.find(n => n.id === parentId)
    const c = out.find(n => n.id === childId)
    if (p === undefined || c === undefined) return false
    const pw = Number(p.style?.width ?? 0)
    const ph = Number(p.style?.height ?? 0)
    const cw = c.style !== undefined ? Number(c.style.width) : 300
    const ch = c.style !== undefined ? Number(c.style.height) : 168
    return c.position.x >= 0 && c.position.y >= 0
      && c.position.x + cw <= pw && c.position.y + ch <= ph
  }
  check('★★ 最内层 I 装在 M 里', contains('M', 'I'))
  check('★★ 中层 M 装在 O 里', contains('O', 'M'))
  for (const kid of kidsOf(out, 'I')) {
    const p = out.find(n => n.id === 'I')
    const ok = kid.position.x >= 0 && kid.position.y >= 0
      && kid.position.x + 300 <= Number(p.style.width)
      && kid.position.y + 168 <= Number(p.style.height)
    check('★ I 的成员 ' + kid.id + ' 装在里面', ok)
  }
}

console.log('')
console.log('=== ③ 真实存档（三层嵌套）===')
{
  const D = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
  const F = join(D, '取数-千川全域推广.json')
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
    const sizes = new Map()
    for (const n of nodes) if (n.data.def.id !== 'flow.loop') sizes.set(n.id, { w: 300, h: 168 })

    /* ── 动态取循环节点，**不写死 id** ────────────────────────────────
     *
     * ## 为什么要改（2026-10-23，契约 W）
     *
     * 原来这里写死 `['n12', 'n9', 'n3']` —— 那是**旧存档**的循环 id。
     * 而 id 是 `Builder.add()` 的**调用序号**（`'n' + String(++this.n)`，
     * 见 `scripts/build-patrol-workflows.mjs` 的 `add`），
     * 所以只要生成器里多加一个节点，后面所有 id 全往后挪。
     * 契约 S2 把登录检查提到循环外（多加了几个 `browser.act`）之后，
     * 循环从 `n3/n9/n12` 变成了 `n15/n21/n24`，**写死的 id 一个都找不到了**。
     *
     * 而 `refit` 拿一个找不到的 id 会发生什么？`relayoutInside` 找不到成员、
     * `fitLoopBox` 找不到框 → 框的 width/height 是 0 → 每个成员都被判
     * 「装不进 0×0」，于是爆出 15 条**看起来像排版坏了**的红。
     * 那不是排版坏了，是**观测点找错了**。
     *
     * ## 现在怎么取
     *
     * 按 `defId === 'flow.loop'` 找出全部循环，再按 `parentId` 链算层级：
     *   · 顶层循环（`parentId` 不是循环）→ 层级 0；
     *   · `parentId` 是循环的 → 层级 = 父的层级 + 1。
     * `refit` 要的是**内层在前**（见它自己的注释），所以按层级**降序**排。 */

    /** 全部循环节点。 */
    const loopNodes = nodes.filter(n => n.data.def.id === 'flow.loop')
    /** 循环 id → 是否循环（判父节点用）。 */
    const loopSet = new Set(loopNodes.map(n => n.id))
    /** 循环 id → 层级（顶层 0，往里递增）。 */
    const depthOf = new Map()
    /**
     * 算一个循环的层级（沿 parentId 往上数循环父节点的个数）。
     * @param id - 循环 id。
     * @param guard - 防环（脏数据里 parentId 成环时不至于死循环）。
     * @returns 层级。
     */
    const depthOfLoop = (id, guard = new Set()) => {
      if (depthOf.has(id)) return depthOf.get(id)
      if (guard.has(id)) return 0
      guard.add(id)
      const self = nodes.find(n => n.id === id)
      const parent = self?.parentId
      const d = parent !== undefined && loopSet.has(parent) ? depthOfLoop(parent, guard) + 1 : 0
      depthOf.set(id, d)
      return d
    }
    for (const l of loopNodes) depthOfLoop(l.id)
    /** 内层在前（层级降序；同层按存档里的原始顺序，保证可复现）。 */
    const loopIds = loopNodes
      .map((n, i) => ({ id: n.id, depth: depthOf.get(n.id) ?? 0, i }))
      .sort((a, b) => (b.depth - a.depth) || (a.i - b.i))
      .map(x => x.id)

    console.log('   存档里的循环节点（按内层→外层）:',
      loopIds.map(id => id + '(第' + String(depthOf.get(id)) + '层)').join(' / ') || '（一个都没有）')

    /* ── 防复发：先确认「找到的循环」是真循环，而不是空集 ─────────────
     *
     * 这一条把「观测点找错了」与「排版真坏了」分开：
     * 下次结构再变、或谁又把 id 写死，这里会**明确说清是哪种情况**，
     * 而不是给一堆「装不进 0×0」。 */
    /* ★ **这条断言的价值不是「找到 3 个循环」，而是「观测点是否还有效」。**
     * 它红了说明**测试前提失效，不是被测代码坏了** —— 看到它红，
     * 先查存档结构变没变（生成器加了节点？id 挪位了？字段改名了？），
     * 不要去查排版代码。下面的几何判据此时会被跳过，不会有第二条线索。 */
    check('★★ 从存档里找到了循环节点', loopIds.length > 0,
      loopIds.length === 0 ? '存档里一个 flow.loop 都没有 —— 观测点失效，下面的排版判据没有前提' : String(loopIds.length) + ' 个')
    /* 存档里循环节点的个数，必须与上面按 parentId 链算出来的层数对得上：
     * 三层嵌套就该是 3 个循环、最大层级 2。 */
    const maxDepth = loopIds.length === 0 ? -1 : Math.max(...loopIds.map(id => depthOf.get(id) ?? 0))
    check('★★ 循环节点个数 = 层数（最深那层 = 个数 - 1）',
      loopIds.length > 0 && maxDepth === loopIds.length - 1,
      String(loopIds.length) + ' 个循环，最深第 ' + String(maxDepth) + ' 层')
    /* 每个层级恰好一个循环（这份存档是纯三层嵌套，不是并排多个）。
     * 并排的话这条会红 —— 红得对：那时「第几层」不再等于「第几个」。 */
    const depthCounts = new Map()
    for (const id of loopIds) {
      const d = depthOf.get(id) ?? 0
      depthCounts.set(d, (depthCounts.get(d) ?? 0) + 1)
    }
    const onePerDepth = [...depthCounts.values()].every(c => c === 1)
    check('★★ 每一层恰好一个循环（纯嵌套，没有并排的循环）', onePerDepth,
      [...depthCounts.entries()].map(([d, c]) => '第' + String(d) + '层' + String(c) + '个').join(' / '))

    /* 所有循环 id 都必须来自存档 —— 这条防「又写死了一个 id」。
     * 判据是集合相等：算出来的那些 id，必须全在存档的循环集合里。 */
    const allFromArchive = loopIds.every(id => loopSet.has(id))
    check('★★ 用到的循环 id 全部来自存档（没有写死的 id）', allFromArchive,
      allFromArchive ? loopIds.join(' / ') : '有不属于存档的 id：' + loopIds.filter(id => !loopSet.has(id)).join(' / '))

    /* ── 正经判据（强度与原版一致）──────────────────────────────────
     *
     * ⚠️ 但**循环没找到时不跑几何判据**（2026-10-23 自证发现）：
     * 拿一个空 loopIds 去 `refit`，`fitLoopBox` 找不到框 → 框是 0×0 →
     * 每个成员都判「装不进 0×0」，刷出 15 条**看起来像排版坏了**的红。
     * 那会把「观测点失效」伪装成「排版有 15 处错」，正是这次要消灭的噪声。
     * 所以先看上面那条「找到了循环节点」：没过就**明说跳过**，不再逐条刷。 */
    if (loopIds.length === 0) {
      console.log('  · 跳过几何判据：上面已经说明「没找到循环」，再逐条算只会给出误导性的 0×0 越界')
    } else {
      const out = refit(nodes, loopIds, edges, sizes)
      const byId = new Map(out.map(n => [n.id, n]))
      let bad = 0
      for (const n of out) {
        const pid = n.parentId
        if (pid === undefined) continue
        const p = byId.get(pid)
        if (p === undefined) continue
        const pw = Number(p.style?.width ?? 0)
        const ph = Number(p.style?.height ?? 0)
        const nw = n.style !== undefined ? Number(n.style.width) : 300
        const nh = n.style !== undefined ? Number(n.style.height) : 168
        const ok = n.position.x >= 0 && n.position.y >= 0
          && n.position.x + nw <= pw && n.position.y + nh <= ph
        if (!ok) {
          bad += 1
          console.log('      ✗ ' + n.id + ' 装不进 ' + pid + '：位置 ' + JSON.stringify(n.position)
            + ' 尺寸 ' + String(nw) + '×' + String(nh) + ' vs 框 ' + String(pw) + '×' + String(ph))
        }
      }
      check('★★ 真实存档里每个成员都装在自己那一层框内', bad === 0, bad === 0 ? '全部在内' : String(bad) + ' 个越界')

      /* ⚠️ 还要验「内层成员的排列方向」—— 只验装得下的话，
       * 横排恰好塞进一个很宽的框也能通过，而那仍然是错的方向。 */
      let dirChecked = 0
      for (const loopId of loopIds) {
        const kids = kidsOf(out, loopId)
        if (kids.length < 2) continue
        const xs = new Set(kids.map(k => k.position.x))
        dirChecked += 1
        check('★ ' + loopId + ' 的成员是竖排', xs.size === 1, 'x 有 ' + String(xs.size) + ' 种')
      }
      /* 方向判据也要防「一个都没验上」：至少两层有 ≥2 个成员才轮得到。 */
      check('★★ 至少验到了两层成员的方向（不是一个都没轮到）', dirChecked >= 2,
        '验了 ' + String(dirChecked) + ' 层')
    }
  }
}


console.log('')
console.log(failed === 0 ? '结论：嵌套循环排版正确 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

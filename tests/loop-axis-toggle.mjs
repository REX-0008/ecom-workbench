/** 循环框的手动竖排 / 横排切换（用户 2026-10-21）。
 *
 * ## 用户要什么（原话）
 *
 * > 「**不应该每次转**，是自动横排的时候循环内竖排，自动竖排的时候循环内横排。
 * >  同时给循环加个按钮调整横排和竖排吧」
 *
 * 两件事：
 *   ① **自动**：由画布方向推到「正交」那个（`innerAxisOf`），**所有嵌套层都一样**；
 *   ② **手动**：每个循环框可以自己切，切过之后**不再自动改它**。
 *
 * ## 为什么这两条必须一起测
 *
 * 只测自动的话，把「手动优先」那层删掉照样绿 —— 而症状是
 * 「我切了横排，一动画布就变回竖排」（那种错用户很难描述清楚）。
 * 所以这里两条都钉。
 *
 * 跑法：node --import <tsx> tests/loop-axis-toggle.mjs
 */
import { relayoutInside } from '../src/client/workbench/container-ops.ts'

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
 * @param opts - parentId / 尺寸 / 手动方向。
 * @returns 节点。
 */
const loop = (id, opts = {}) => {
  const out = {
    id,
    position: { x: 0, y: 0 },
    data: { def: { id: 'flow.loop' }, ...(opts.axis === undefined ? {} : { axis: opts.axis }) },
    style: { width: opts.w ?? 740, height: opts.h ?? 900 },
  }
  if (opts.parentId !== undefined) out.parentId = opts.parentId
  return out
}

/**
 * 造一个普通成员。
 * @param id - id。
 * @param parentId - 所属循环。
 * @returns 节点。
 */
const member = (id, parentId) => ({
  id,
  position: { x: 0, y: 0 },
  parentId,
  data: { def: { id: 'code.js' } },
})

/** 取坐标。 */
const at = (nodes, id) => {
  const n = nodes.find(v => v.id === id)
  return n === undefined ? null : { x: n.position.x, y: n.position.y }
}

/**
 * 判断一批成员排成了竖排还是横排。
 * @param nodes - 节点。
 * @param parentId - 容器。
 * @returns 'TB' / 'LR' / 'same'（只有一个成员或位置相同）。
 */
const shapeOf = (nodes, parentId) => {
  const kids = nodes.filter(n => n.parentId === parentId)
  if (kids.length < 2) return 'same'
  const xs = new Set(kids.map(k => k.position.x))
  const ys = new Set(kids.map(k => k.position.y))
  if (xs.size === 1 && ys.size > 1) return 'TB'
  if (ys.size === 1 && xs.size > 1) return 'LR'
  return 'same'
}

console.log('=== ① 自动方向：画布横排 → 框内竖排 ===')
{
  const SZ = new Map([['a', { w: 300, h: 168 }], ['b', { w: 300, h: 168 }]])
  const nodes = [loop('L'), member('a', 'L'), member('b', 'L')]
  const edges = [{ source: 'a', target: 'b' }]
  const out = relayoutInside(nodes, 'L', edges, SZ, FB, 'RIGHT')
  check('★★ 画布 RIGHT → 框内竖排（x 同、y 不同）', shapeOf(out, 'L') === 'TB', shapeOf(out, 'L'))

  const out2 = relayoutInside(nodes, 'L', edges, SZ, FB, 'DOWN')
  check('★★ 画布 DOWN → 框内横排（y 同、x 不同）', shapeOf(out2, 'L') === 'LR', shapeOf(out2, 'L'))
}

console.log('')
console.log('=== ② 嵌套层**不再逐层翻转**（用户 2026-10-21）===')
{
  const SZ = new Map([
    ['p', { w: 300, h: 168 }], ['q', { w: 300, h: 168 }],
    ['r', { w: 300, h: 168 }], ['s', { w: 300, h: 168 }],
  ])
  const nodes = [
    loop('OUT', { w: 2000, h: 1600 }),
    loop('IN', { parentId: 'OUT', w: 900, h: 800 }),
    member('r', 'OUT'), member('s', 'OUT'),
    member('p', 'IN'), member('q', 'IN'),
  ]
  const edges = [{ source: 'p', target: 'q' }, { source: 'r', target: 's' }]
  let out = relayoutInside(nodes, 'IN', edges, SZ, FB, 'RIGHT')
  out = relayoutInside(out, 'OUT', edges, SZ, FB, 'RIGHT')
  check('★★ 外层是竖排', shapeOf(out, 'OUT') === 'TB', shapeOf(out, 'OUT'))
  check('★★ 内层**也是**竖排（不翻转 —— 这是用户 2026-10-21 定的）',
    shapeOf(out, 'IN') === 'TB', shapeOf(out, 'IN'))
}

console.log('')
console.log('=== ③ 手动切换优先于自动方向 ===')
{
  const SZ = new Map([['a', { w: 300, h: 168 }], ['b', { w: 300, h: 168 }]])
  const edges = [{ source: 'a', target: 'b' }]

  /* 手动设成横排，而画布方向推出来的是竖排 —— 手动的赢。 */
  const nodes = [loop('L', { axis: 'LR' }), member('a', 'L'), member('b', 'L')]
  const out = relayoutInside(nodes, 'L', edges, SZ, FB, 'RIGHT')
  check('★★ 手动设横排 → 排成横排（压过自动的竖排）', shapeOf(out, 'L') === 'LR', shapeOf(out, 'L'))

  /* 反过来。 */
  const nodes2 = [loop('L', { axis: 'TB' }), member('a', 'L'), member('b', 'L')]
  const out2 = relayoutInside(nodes2, 'L', edges, SZ, FB, 'DOWN')
  check('★★ 手动设竖排 → 排成竖排（压过自动的横排）', shapeOf(out2, 'L') === 'TB', shapeOf(out2, 'L'))
}

console.log('')
console.log('=== ④ 脏值不炸（存档手改坏了也退回自动）===')
{
  const SZ = new Map([['a', { w: 300, h: 168 }], ['b', { w: 300, h: 168 }]])
  const edges = [{ source: 'a', target: 'b' }]
  const nodes = [loop('L', { axis: '随便写的' }), member('a', 'L'), member('b', 'L')]
  const out = relayoutInside(nodes, 'L', edges, SZ, FB, 'RIGHT')
  check('★ 坏值退回自动方向（RIGHT → 竖排）', shapeOf(out, 'L') === 'TB', shapeOf(out, 'L'))
}

console.log('')
console.log('=== ⑤ 切换之后**不会**被下一次 refit 打回 ===')
{
  /* 这条守的是「用户切完、一动画布就变回去」那种错。
   * 判据：连排三次，形状必须一直是手动那个。 */
  const SZ = new Map([['a', { w: 300, h: 168 }], ['b', { w: 300, h: 168 }]])
  const edges = [{ source: 'a', target: 'b' }]
  let nodes = [loop('L', { axis: 'LR' }), member('a', 'L'), member('b', 'L')]
  for (let i = 0; i < 3; i++) {
    nodes = relayoutInside(nodes, 'L', edges, SZ, FB, 'RIGHT')
  }
  check('★★ 连排三次仍是手动那个方向（横排）', shapeOf(nodes, 'L') === 'LR', shapeOf(nodes, 'L'))
}

console.log('')
console.log('=== ⑥ 框头上真有一个切换按钮（不是只有底层逻辑）===')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/workbench/LoopNode.tsx', import.meta.url), 'utf8')
  check('★ 按钮绑了 onToggleAxis', /onToggleAxis\?\.\(\)/.test(src))
  check('★ 按钮文字随当前方向变（竖排 / 横排）', /'\\u2261 竖排' : '\\u2263 横排'/.test(src) || (src.includes('竖排') && src.includes('横排')))
  check('★ 画布侧真的注入了这个回调', /onToggleAxis: \(\) => \{ onToggleAxisStable\(/.test(
    readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')))
  check('★ 画布侧也注入了 axisAuto（不然第一次点击会切错）',
    /axisAuto: innerAxisOf\(dir\)/.test(readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')))
}

console.log('')
console.log(failed === 0 ? '结论：框内方向的自动 + 手动都接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

/** 收起循环时「藏成员」要**连带藏掉连到它的边**（用户 2026-10-21 报的 008）。
 *
 * ## 症状（用户原话）
 *
 * > `008：Couldn't create edge for target handle id: "in", edge id: e6.`
 *
 * React Flow 的 008 = 「按这条边去找端点的端口，没找着」。
 *
 * ## 成因
 *
 * 循环收起时，交给 React Flow 的那份节点里，成员被打了 `hidden` ——
 * **节点不渲染**，它身上那个 `in` 端口也就不存在。
 * 而那条边还在点名要那个端口 → 每次渲染报一次 008，
 * 画布上还会留一条连到空气的线。
 *
 * ## 为什么必须测纯函数
 *
 * jsdom 里 React Flow **没有布局**，一条边都画不出来（收起前就是 0 条）。
 * 想从 DOM 上数 `.react-flow__edge` 的话，断言**永远绿** —— 假绿。
 * 所以判据落在「`hidden` 那位有没有被打上」这份**数据**上。
 *
 * ## 判据
 *
 * ① 父循环收起 → 连到成员的边 `hidden`；
 * ② 上游在框内、下游也在框内的边 → 同样藏（两端都是成员）；
 * ③ 两端都不在盒子里的边 → **不许动**（不能顺手把整张图的边都藏了）；
 * ④ 展开回来 → 一条都不许 hidden（藏是显示语义，不是删）；
 * ⑤ 边本身**不许被删**（数组长度不变）—— 删了存档与执行会受影响；
 * ⑥ 判据与「藏节点」那条**同源**（都用 `collapsed === true` + `parentId`）。
 *
 * 跑法：node --import <tsx> tests/edge-hidden.mjs
 */
import { hiddenEdgesOf } from '../src/client/workbench/hidden-edges.ts'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 造一个循环框。 */
const loop = (id, opts = {}) => ({
  id,
  data: { def: { id: 'flow.loop' }, ...(opts.collapsed === undefined ? {} : { collapsed: opts.collapsed }) },
  ...(opts.parentId === undefined ? {} : { parentId: opts.parentId }),
})
/** 造一个普通节点。 */
const node = (id, opts = {}) => ({
  id,
  data: { def: { id: 'code.js' } },
  ...(opts.parentId === undefined ? {} : { parentId: opts.parentId }),
})

console.log('=== ① 父循环收起 → 连到成员的边被藏 ===')
{
  const nodes = [loop('L', { collapsed: true }), node('k1', { parentId: 'L' }), node('out')]
  const edges = [
    /* 外 → 内（用户报的 008 就是这一类：目标在折叠的框里）。 */
    { id: 'e1', source: 'out', target: 'k1' },
    /* 内 → 外。 */
    { id: 'e2', source: 'k1', target: 'out' },
    /* 两端都在外面 —— 不该动。 */
    { id: 'e3', source: 'out', target: 'out' },
  ]
  const h = hiddenEdgesOf(nodes, edges)
  check('★★ 连进折叠成员的边被藏（就是 008 那一条）', h[0] === true)
  check('★★ 从折叠成员连出去的边也被藏', h[1] === true)
  check('★★ 两端都在外面的边**不动**', h[2] === false)
  check('★ 结果长度与边数一致（一条都没删）', h.length === edges.length, String(h.length))
}

console.log('')
console.log('=== ② 两端都是成员的边也藏（框内互连）===')
{
  const nodes = [loop('L', { collapsed: true }), node('a', { parentId: 'L' }), node('b', { parentId: 'L' })]
  const edges = [{ id: 'e1', source: 'a', target: 'b' }]
  const h = hiddenEdgesOf(nodes, edges)
  check('★ 框内互连也藏（两端都看不见了）', h[0] === true)
}

console.log('')
console.log('=== ③ 没收起时一条都不许藏（否则正常画布也少线）===')
{
  const nodes = [loop('L'), node('k1', { parentId: 'L' }), node('out')]
  const edges = [
    { id: 'e1', source: 'out', target: 'k1' },
    { id: 'e2', source: 'k1', target: 'out' },
  ]
  const h = hiddenEdgesOf(nodes, edges)
  check('★★ 循环没收起 → 边都不藏', h.every(x => x === false), h.join(','))
}

console.log('')
console.log('=== ④ 展开回来 → 一条都不许 hidden ===')
{
  /* 同一个图，只把 collapsed 翻回去。 */
  const edges = [{ id: 'e1', source: 'out', target: 'k1' }]
  const collapsed = hiddenEdgesOf([loop('L', { collapsed: true }), node('k1', { parentId: 'L' }), node('out')], edges)
  const expanded = hiddenEdgesOf([loop('L', { collapsed: false }), node('k1', { parentId: 'L' }), node('out')], edges)
  check('★★ 收起时藏', collapsed[0] === true)
  check('★★ 展开后不再藏（原样回来，不是被删掉）', expanded[0] === false)
}

console.log('')
console.log('=== ⑤ 只藏「父循环收起」的那些，别误伤别的循环 ===')
{
  const nodes = [
    loop('L1', { collapsed: true }),
    loop('L2'),
    node('a', { parentId: 'L1' }),
    node('b', { parentId: 'L2' }),
    node('out'),
  ]
  const edges = [
    { id: 'e1', source: 'out', target: 'a' },   // 进折叠的 L1 → 藏
    { id: 'e2', source: 'out', target: 'b' },   // 进没折叠的 L2 → 不藏
    { id: 'e3', source: 'a', target: 'b' },     // 一端折叠 → 藏
  ]
  const h = hiddenEdgesOf(nodes, edges)
  check('★ 进折叠循环的藏', h[0] === true)
  check('★★ 进没折叠循环的**不藏**（别误伤）', h[1] === false)
  check('★ 一端折叠一端不折叠的也藏（看不见了就不画）', h[2] === true)
}

console.log('')
console.log('=== ⑥ 脏数据不炸 ===')
{
  const h1 = hiddenEdgesOf([], [{ id: 'e', source: 'x', target: 'y' }])
  check('★ 空节点表 → 全不藏、不抛错', h1.length === 1 && h1[0] === false)
  const h2 = hiddenEdgesOf([loop('L', { collapsed: true }), node('k', { parentId: 'L' })], [])
  check('★ 空边表 → 空结果', h2.length === 0)
  /* 端点不在节点表里（数据不全）→ 不藏、不抛错。 */
  const h3 = hiddenEdgesOf([loop('L', { collapsed: true })], [{ id: 'e', source: 'ghost', target: 'ghost2' }])
  check('★ 端点缺失不抛错', h3.length === 1 && h3[0] === false)
}

console.log('')
console.log('=== ⑦ 画布真的用了它（不是写了没接）===')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
  check('★ 画布 import 了 hiddenEdgesOf', /import \{ hiddenEdgesOf \} from '\.\/hidden-edges\.ts'/.test(src))
  check('★★ shownEdges 里真的调了它', /const hidden = hiddenEdgesOf\(nodes, edges\)/.test(src))
  check('★★ 它算出来的结果被用在 hidden 那一位上', /hidden\[i\] === true \? \{ \.\.\.decorated, hidden: true \}/.test(src))
  /* ⚠️ 反向断言：不许回到「只 map、不看 hidden」的旧写法。 */
  check('★★ 没有残留「只 decorate 不看 hidden」的旧实现',
    !/edges\.map\(e => decorateEdge\(defs, nodes, e\)\)/.test(src))
}

console.log('')
console.log(failed === 0 ? '结论：收起时边也跟着藏了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

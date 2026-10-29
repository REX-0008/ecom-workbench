/** 容器归属的**纯运算**测试（拖进循环 / 拖出来 / 贴边）。
 *
 * 为什么单独测：这一层是「绝对坐标 ↔ 相对坐标」的换算 + 归属判定。
 * 错法的表现是**节点飞到不相干的位置**，而构建、类型检查、界面渲染都不报错 ——
 * 与 `group-ops` 同类，必须靠等值断言拦。
 *
 * ⚠️ 它守着用户的一个具体抱怨（2026-10-12）：
 *   「循环的节点是正常的吗？他现在就是一个常规外观我怎么使用他？拖不进去。」
 * 拖不进去 = 没有任何「拖入容器」的逻辑。这个文件把那条逻辑钉死。
 *
 * 跑法：node --import <tsx> tests/container-ops.mjs
 */
import {
  isContainer, containersOf, containerAt, assignToContainer,
  absolutePosition, orderParentsFirst, dropTarget, descendantsOf, fitLoopBox, LOOP_DEF_ID,
  assignWithClosure, stepDragIntent, CONFIRM_MS, relayoutInside,
  leaveClosure, removeWithClosure,
  BOX_PAD_SIDE, BOX_PAD_TOP, BOX_GAP_Y, BOX_MIN_W, BOX_MIN_H,
} from '../src/client/workbench/container-ops.ts'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 最小节点定义。 */
function def(id) {
  return { id, label: id, executor: 'builtin', inputs: [], outputs: [] }
}

/**
 * 造一个节点。
 * @param id - 节点 id。
 * @param opts - defId / type / position / parentId / 尺寸（写在 style 上）。
 */
function n(id, opts = {}) {
  const out = {
    id,
    type: opts.type ?? 'v1',
    position: opts.position ?? { x: 0, y: 0 },
    data: { def: def(opts.defId ?? 'code.js'), state: 'idle', params: {}, onError: 'stop' },
  }
  if (opts.parentId !== undefined) out.parentId = opts.parentId
  if (opts.w !== undefined || opts.h !== undefined) out.style = { width: opts.w ?? 100, height: opts.h ?? 50 }
  return out
}
/** 实测尺寸表。 */
function sizes(pairs) {
  return new Map(Object.entries(pairs).map(([k, v]) => [k, { w: v[0], h: v[1] }]))
}
/**
 * 造一条边（补齐中间节点要按连线找）。
 * @param source - 起点。
 * @param target - 终点。
 */
function e(source, target) {
  return { id: source + '>' + target, source, target }
}

console.log('=== 容器归属（container-ops）===')

console.log('① 谁是容器：分组框 与 循环 都算')
{
  check('循环是容器', isContainer({ type: 'v1', defId: LOOP_DEF_ID }) === true)
  check('分组框是容器', isContainer({ type: 'group', defId: '__group' }) === true)
  check('普通节点不是容器', isContainer({ type: 'v1', defId: 'code.js' }) === false)
  /* 关键对照：普通节点**长得像**节点但不是容器，不能被拖进。 */
  check('「条件判断」不是容器', isContainer({ type: 'v1', defId: 'flow.if' }) === false)
}

console.log('')
console.log('② containersOf：尺寸取实测值优先，退回 style')
{
  const nodes = [n('L', { defId: LOOP_DEF_ID, position: { x: 10, y: 20 }, w: 300, h: 200 }), n('a')]
  const cs = containersOf(nodes, sizes({ L: [320, 210] }))
  check('只挑出容器', cs.length === 1, String(cs.length))
  check('实测尺寸优先于 style', cs[0].width === 320 && cs[0].height === 210, JSON.stringify([cs[0].width, cs[0].height]))
  const cs2 = containersOf(nodes, new Map())
  check('无实测时退回 style', cs2[0].width === 300 && cs2[0].height === 200, JSON.stringify([cs2[0].width, cs2[0].height]))
}

console.log('')
console.log('③ containerAt：取**最小**的那个（嵌套时取里层）')
{
  const nodes = [
    n('outer', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 600, h: 600 }),
    n('inner', { defId: LOOP_DEF_ID, position: { x: 100, y: 100 }, w: 200, h: 200 }),
  ]
  const cs = containersOf(nodes, new Map())
  check('点在里层 → 返回里层', containerAt(cs, { x: 150, y: 150 }) === 'inner')
  check('点只在外层 → 返回外层', containerAt(cs, { x: 500, y: 500 }) === 'outer')
  check('都不在 → null', containerAt(cs, { x: 999, y: 999 }) === null)
  /* 尺寸为 0 的容器不该命中（否则空框会把整张图吞掉）。 */
  const zero = containersOf([n('z', { defId: LOOP_DEF_ID })], new Map())
  check('尺寸为 0 的容器不命中', containerAt(zero, { x: 0, y: 0 }) === null)
}

console.log('')
console.log('④ absolutePosition：沿 parentId 链把父的原点加回去')
{
  const nodes = [
    n('g', { type: 'group', defId: '__group', position: { x: 100, y: 200 } }),
    n('a', { parentId: 'g', position: { x: 10, y: 20 } }),
  ]
  const abs = absolutePosition(nodes, nodes[1])
  check('一层：100+10 / 200+20', abs.x === 110 && abs.y === 220, JSON.stringify(abs))
  const nested = [
    n('g1', { type: 'group', defId: '__group', position: { x: 100, y: 200 } }),
    n('g2', { type: 'group', defId: '__group', position: { x: 5, y: 6 }, parentId: 'g1' }),
    n('a', { parentId: 'g2', position: { x: 1, y: 2 } }),
  ]
  const abs2 = absolutePosition(nested, nested[2])
  check('两层：100+5+1 / 200+6+2', abs2.x === 106 && abs2.y === 208, JSON.stringify(abs2))
  /* 父不存在（脏数据）时不崩、不死循环。 */
  const orphan = [n('x', { parentId: 'ghost', position: { x: 3, y: 4 } })]
  const abs3 = absolutePosition(orphan, orphan[0])
  check('父不存在时不崩', abs3.x === 3 && abs3.y === 4, JSON.stringify(abs3))
  /* 自环（脏数据）也不能死循环。 */
  const self = [n('s', { parentId: 's', position: { x: 1, y: 1 } })]
  const abs4 = absolutePosition(self, self[0])
  check('自环不死循环', Number.isFinite(abs4.x) && Number.isFinite(abs4.y), JSON.stringify(abs4))
}

console.log('')
console.log('⑤ assignToContainer：拖进容器（坐标绝对 → 相对）')
{
  const nodes = [
    n('L', { defId: LOOP_DEF_ID, position: { x: 300, y: 100 }, w: 400, h: 300 }),
    n('a', { position: { x: 350, y: 150 } }),
  ]
  const next = assignToContainer(nodes, 'a', 'L')
  const a = next.find(x => x.id === 'a')
  check('挂上了 parentId', a.parentId === 'L', String(a.parentId))
  check('坐标转成相对（350-300 / 150-100）', a.position.x === 50 && a.position.y === 50, JSON.stringify(a.position))
  /* **绝对坐标不能变** —— 这是「拖进去不跳位」的判据。 */
  const back = absolutePosition(next, a)
  check('绝对坐标没变（拖进去不跳位）', back.x === 350 && back.y === 150, JSON.stringify(back))
}

console.log('')
console.log('⑥ assignToContainer：从容器里拖出来（相对 → 绝对）')
{
  const nodes = [
    n('L', { defId: LOOP_DEF_ID, position: { x: 300, y: 100 }, w: 400, h: 300 }),
    n('a', { parentId: 'L', position: { x: 50, y: 50 } }),
  ]
  const next = assignToContainer(nodes, 'a', null)
  const a = next.find(x => x.id === 'a')
  check('parentId 去掉了', a.parentId === undefined, String(a.parentId))
  check('坐标还原成绝对（300+50 / 100+50）', a.position.x === 350 && a.position.y === 150, JSON.stringify(a.position))
}

console.log('')
console.log('⑦ assignToContainer：**换容器**（先摘旧父再挂新父，不能减两次）')
{
  /* 这是最容易错的：节点已在 A 里，直接拖进 B。
   * 若忘了先按 A 的原点还原，坐标会被减两次 → 节点飞到左上角。 */
  const nodes = [
    n('A', { defId: LOOP_DEF_ID, position: { x: 100, y: 100 }, w: 300, h: 300 }),
    n('B', { defId: LOOP_DEF_ID, position: { x: 500, y: 100 }, w: 300, h: 300 }),
    n('m', { parentId: 'A', position: { x: 50, y: 50 } }),   // 绝对 = 150,150
  ]
  const next = assignToContainer(nodes, 'm', 'B')
  const m = next.find(x => x.id === 'm')
  check('归属换成 B', m.parentId === 'B', String(m.parentId))
  check('相对 B 的坐标（150-500 = -350）', m.position.x === -350 && m.position.y === 50, JSON.stringify(m.position))
  const abs = absolutePosition(next, m)
  check('绝对坐标仍是 150,150（没被减两次）', abs.x === 150 && abs.y === 150, JSON.stringify(abs))
}

console.log('')
console.log('⑧ 排序：父必须排在子之前（React Flow 硬要求）')
{
  const nodes = [
    n('a', { parentId: 'L', position: { x: 1, y: 1 } }),
    n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 } }),
  ]
  const sorted = orderParentsFirst(nodes)
  check('父被移到子前面', sorted.findIndex(x => x.id === 'L') < sorted.findIndex(x => x.id === 'a'),
    sorted.map(x => x.id).join(','))
  /* 稳定：同层保持原顺序（否则每次调用都重排，画面会抖）。 */
  const three = [n('x'), n('y'), n('z')]
  check('同层保持原顺序', orderParentsFirst(three).map(x => x.id).join('') === 'xyz')
  check('assignToContainer 的输出也是排好序的', (() => {
    const r = assignToContainer([n('a', { parentId: 'L' }), n('L', { defId: LOOP_DEF_ID })], 'a', 'L')
    return r.findIndex(x => x.id === 'L') < r.findIndex(x => x.id === 'a')
  })())
}

console.log('')
console.log('⑨ dropTarget：落在谁身上（这是「拖进去」的判定本身）')
{
  const SZ = sizes({ L: [400, 300], a: [100, 50] })
  const base = [n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 400, h: 300 })]

  /* 中心点落进容器 → 归它。 */
  const hit = [...base, n('a', { position: { x: 150, y: 100 } })]  // 中心 200,125
  check('中心在容器里 → 归它', dropTarget(hit, 'a', SZ, { w: 100, h: 50 }) === 'L')

  /* 中心点在外面、原本不属于任何容器 → 不用改。 */
  const miss = [...base, n('a', { position: { x: 900, y: 900 } })]
  check('中心在外面且无归属 → 不改', dropTarget(miss, 'a', SZ, { w: 100, h: 50 }) === undefined)

  /* 已在容器里、被拖到完全离开 → 移出。 */
  const out = [...base, n('a', { parentId: 'L', position: { x: 900, y: 900 } })]
  check('完全离开容器 → 移出', dropTarget(out, 'a', SZ, { w: 100, h: 50 }) === null)

  /* 半进半出 → 保持（手一抖不该被踢出循环）。 */
  const half = [...base, n('a', { parentId: 'L', position: { x: 380, y: 280 } })]  // 中心 430,305
  check('半进半出 → 保持原位', dropTarget(half, 'a', SZ, { w: 100, h: 50 }) === undefined)

  /* 容器不能被拖进自己（会成环）。 */
  const Lnode = base[0]
  check('容器不被拖进自己', dropTarget([...base, n('a')], 'L', SZ, { w: 100, h: 50 }) !== 'L')

  /* 父不能被拖进自己的子孙（会成环）。 */
  const nested = [
    n('L1', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 600, h: 600 }),
    n('L2', { defId: LOOP_DEF_ID, position: { x: 100, y: 100 }, w: 200, h: 200, parentId: 'L1' }),
  ]
  check('父不被拖进自己的子孙', dropTarget(nested, 'L1', sizes({ L1: [600, 600], L2: [200, 200] }), { w: 100, h: 50 }) !== 'L2')
}

console.log('')
console.log('⑩ descendantsOf：能取到全部后代（防成环用）')
{
  const nodes = [
    n('a'),
    n('b', { parentId: 'a' }),
    n('c', { parentId: 'b' }),
    n('d', { parentId: 'a' }),
    n('e'),
  ]
  const ds = descendantsOf(nodes, 'a')
  check('取到 b、c、d', ds.has('b') && ds.has('c') && ds.has('d'), [...ds].join(','))
  check('不含自己', !ds.has('a'))
  check('不含无关节点', !ds.has('e'))
  check('无子时返回空集', descendantsOf(nodes, 'e').size === 0)
}

console.log('')
console.log('⑪ fitLoopBox：框贴紧子节点，且**幂等**')
{
  const nodes = [
    n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 } }),
    n('a', { parentId: 'L', position: { x: 50, y: 60 } }),
    n('b', { parentId: 'L', position: { x: 250, y: 60 } }),
  ]
  const SZ = sizes({ a: [100, 50], b: [100, 50], L: [0, 0] })
  const once = fitLoopBox(nodes, 'L', SZ, { w: 300, h: 168 })
  const L = once.find(x => x.id === 'L')
  check('框算出了尺寸', (L.style?.width ?? 0) > 0 && (L.style?.height ?? 0) > 0,
    JSON.stringify([L.style?.width, L.style?.height]))
  /* 子节点的**绝对坐标**必须不变（框只是重新定位，不该挪动内容）。 */
  const aOnce = once.find(x => x.id === 'a')
  const absA = absolutePosition(once, aOnce)
  check('子节点绝对坐标不变', absA.x === 50 && absA.y === 60, JSON.stringify(absA))

  /* ⚠️ 幂等：再跑一次返回**同一数组引用** —— 调用方据此跳过 setState。
   * 不幂等就是 setState → 重渲染 → 又贴 → 死循环（dom-render 有专门断言盯这个）。 */
  const twice = fitLoopBox(once, 'L', sizes({ a: [100, 50], b: [100, 50], L: [L.style.width, L.style.height] }), { w: 300, h: 168 })
  check('幂等：第二次返回原数组引用', twice === once)
}

console.log('')
console.log('⑫ fitLoopBox：空框缩到最小尺寸（**只比普通节点大一点**）')
{
  /* ⚠️ **这条判据 2026-10-16 改了**（用户原话：
   * 「将循环默认的宽度也取消掉，**没有内容的时候宽度只比普通节点大一点**，
   * 有节点有自动重排」）。
   *
   * ## 旧判据是什么、为什么必须改
   *
   * 旧判据是「空框撑到 ≥600×400」（那个值来自「放得下 2×2 个节点」）。
   * 用户看到的是一个**空框占着两个节点宽** —— 看起来像「框本来就这么大」，
   * 而不是「能装东西」。所以现在的最小尺寸 = 普通节点宽 300 + 两侧内边距。
   *
   * ## 改判据时守住的那件事
   *
   * 旧最小值真正防的是「框太小 → 新节点没地方放（一加入就叠）+ 拖不回去」。
   * 那条**不能丢**：所以这里断的是「**比普通节点宽**（有内边距、放得下东西）」
   * 而不是「必须 ≥600」—— 前者守住道理，后者只是当时顺带的一个数。
   *
   * 另一条**新增**：空框**不许**保留自己原来的大尺寸（那正是用户报的症状）。

    */
  const small = [n('L', { defId: LOOP_DEF_ID, position: { x: 10, y: 10 }, w: 100, h: 100 })]
  const r1 = fitLoopBox(small, 'L', new Map(), { w: 300, h: 168 })
  const L1 = r1.find(x => x.id === 'L')
  /* 判据锚到**源码里的常量**而不是写死数字 —— 常量变了这条不该红。 */
  check('空框 = 最小尺寸（普通节点宽 + 两侧内边距）',
    L1.style.width === BOX_MIN_W && L1.style.height === BOX_MIN_H,
    `${L1.style.width}×${L1.style.height}（常量 ${BOX_MIN_W}×${BOX_MIN_H}）`)
  check('空框只比普通节点大一点（不小于节点宽，也不会大到两个节点宽）',
    (L1.style.width ?? 0) >= 300 && (L1.style.width ?? 0) <= 500,
    String(L1.style.width))
  check('空框位置不动', L1.position.x === 10 && L1.position.y === 10)

  /* ★ 新增：**从旧存档读出来的空框要把 `cur.width` 丢掉**，不能「只增不减」。
   * 这条正是用户报的那句话（默认宽度要取消掉）。 */
  const big = [n('L', { defId: LOOP_DEF_ID, position: { x: 10, y: 10 }, w: 900, h: 700 })]
  const rBig = fitLoopBox(big, 'L', new Map(), { w: 300, h: 168 })
  const LBig = rBig.find(x => x.id === 'L')
  check('★ 空框不保留旧的大尺寸（「默认宽度」确实取消了）',
    LBig.style.width === BOX_MIN_W, `${LBig.style.width}（旧的是 900）`)
  check('★ 但位置仍然不动（那条「不跳走」的规矩没丢）',
    LBig.position.x === 10 && LBig.position.y === 10)
  /* 缩到最小之后必须**幂等**（否则 setState → 重渲染 → 又缩 → 死循环）。 */
  check('缩到最小之后再跑一次是幂等的（返回原引用）',
    fitLoopBox(rBig, 'L', new Map(), { w: 300, h: 168 }) === rBig)

  check('不是循环节点时原样返回', fitLoopBox([n('x')], 'x', new Map(), { w: 300, h: 168 }).length === 1)

  /* ⚠️ **有内容时也不许小于最小尺寸** —— 这条是后补的：
   * 我先前只测了「空框」，而实现里「有内容」走的是另一条算式（`needW/needH`）。
   * 把那条算式的 `Math.max(…, BOX_MIN_W)` 去掉，空框断言照样绿（假绿一次），
   * 所以必须有这条把「有内容」那条路也钉住。 */
  const tiny = [
    n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 200, h: 150 }),
    n('A', { position: { x: 20, y: 40 }, parentId: 'L' }),
  ]
  const r2 = fitLoopBox(tiny, 'L', sizes({ A: [300, 200], L: [200, 150] }), { w: 300, h: 200 })
  const L2 = r2.find(x => x.id === 'L')
  check('有内容时也不小于最小尺寸',
    (L2.style.width ?? 0) >= BOX_MIN_W && (L2.style.height ?? 0) >= BOX_MIN_H,
    `${L2.style.width}×${L2.style.height}`)
  /* ★ 有内容时按内容撑开 —— 这才是「有节点有自动重排」。
   * ⚠️ 样例必须**真的比最小尺寸宽**（两个节点横排），否则这条与上面那条重复、
   * 改了实现也照绿（我第一版就拿了单个节点，宽度正好等于最小值 → 假绿）。 */
  const wide = [
    n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 200, h: 150 }),
    n('A', { position: { x: 40, y: 64 }, parentId: 'L' }),
    n('B', { position: { x: 400, y: 64 }, parentId: 'L' }),
  ]
  const rWide = fitLoopBox(wide, 'L', sizes({ A: [300, 200], B: [300, 200], L: [200, 150] }), { w: 300, h: 200 })
  const LWide = rWide.find(x => x.id === 'L')
  check('★ 有内容时宽度按内容撑开（大于最小宽度）',
    (LWide.style.width ?? 0) > BOX_MIN_W, `${LWide.style.width} > ${BOX_MIN_W}`)
}

console.log('')
console.log('⑫b fitLoopBox：**框不跳走**（用户 2026-10-13 报「拖不回去」的根因）')
{
  /* 用户原话：「我把中间节点拖出，末尾节点还在循环中，并且这个中间节点无法拖入了。」
   *
   * 实测根因：移出 A 之后框里只剩 B，而框 = 剩下节点的包围盒 + 边距 →
   * 框从 (0,0) 400×300 **缩成 (10,126) 360×284**，整体跳到下方 126px。
   * 用户按原位置把 A 拖回来时，那儿**已经在框外**，于是「拖不进去」。
   *
   * 这条断言盯的就是「框的位置不许因为成员变少而乱跳」。 */
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 740, h: 564 })
  /* 框里两个节点：A 在上、B 在下（B 决定包围盒的下沿）。 */
  const A = n('A', { position: { x: 40, y: 64 }, parentId: 'L' })
  const B = n('B', { position: { x: 40, y: 300 }, parentId: 'L' })
  const SZ = sizes({ L: [740, 564], A: [300, 200], B: [300, 200] })

  /* ① 两个都在 → 框位置应稳定（内容装得下，位置不动）。 */
  const both = fitLoopBox([L, A, B], 'L', SZ, { w: 300, h: 200 })
  const L1 = both.find(x => x.id === 'L')
  check('内容装得下时框位置不动', L1.position.x === 0 && L1.position.y === 0,
    `(${L1.position.x},${L1.position.y})`)

  /* ② 把 A 移出（它已经不在框里）→ 框**不许跳走**。 */
  const onlyB = fitLoopBox([L, B], 'L', SZ, { w: 300, h: 200 })
  const L2 = onlyB.find(x => x.id === 'L')
  check('成员变少时框位置仍不动（不跳走）', L2.position.x === 0 && L2.position.y === 0,
    `(${L2.position.x},${L2.position.y}) —— 跳了就是 bug 复发`)

  /* ③ 内容溢出框 → 框要长大/平移（这条保证「长大」的能力没丢）。 */
  const far = n('X', { position: { x: 900, y: 800 }, parentId: 'L' })
  const grown = fitLoopBox([L, B, far], 'L', SZ, { w: 300, h: 200 })
  const L3 = grown.find(x => x.id === 'L')
  check('内容溢出时框长大', (L3.style.width ?? 0) > 740, `${L3.style.width}×${L3.style.height}`)
}

console.log('')
console.log('⑬ 停留确认：**「在里面」与「确认了」是两件事**（用户 2026-10-12 实测后定的规则）')
{
  /* 用户原话：
   *   加入：「拖进循环框后框**不亮**，这时松手也不加入，**悬停 1 秒后框亮**，
   *         此刻在框内松手即加入。」
   *   移出：「脱出框后**不是立即变暗**，出框 **1 秒后变暗**……
   *         此时移动回框**不会移出**，但是在框外松开鼠标**会移出**。」
   *
   * 这套断言就是那段话的逐条翻译。它是本轮最容易写错的地方 ——
   * 写错的表现是「一碰就加入」或「永远不加」，而两种在构建与类型检查里都不报错。 */
  const T0 = 1_000_000
  check('确认时长就是用户说的 1 秒', CONFIRM_MS === 1000, String(CONFIRM_MS))

  /* ① 刚进框：候选，未确认 → 界面不亮，松手不加入。 */
  const s1 = stepDragIntent(null, 'L', null, T0)
  check('刚进框 → 意图是 join', s1.kind === 'join' && s1.containerId === 'L', JSON.stringify(s1))
  check('刚进框 → 还是候选（没亮）', s1.pending === true, JSON.stringify(s1))

  /* ② 停够 1 秒：确认 → 界面亮，松手加入。 */
  const s2 = stepDragIntent(s1, 'L', null, T0 + CONFIRM_MS)
  check('停满 1 秒 → 已确认（亮了）', s2.pending === false, JSON.stringify(s2))
  const s2b = stepDragIntent(s1, 'L', null, T0 + CONFIRM_MS - 1)
  check('差 1 毫秒 → 还没确认', s2b.pending === true, JSON.stringify(s2b))

  /* ③ 计时**从进框那刻起算**，不是从拖动开始 —— 中途又进出一次要重新等。 */
  const leaveMid = stepDragIntent(s2, null, null, T0 + CONFIRM_MS + 100)
  check('中途出去 → 意图回到 none', leaveMid.kind === 'none', JSON.stringify(leaveMid))
  const reenter = stepDragIntent(leaveMid, 'L', null, T0 + CONFIRM_MS + 200)
  check('再进来 → 重新变候选', reenter.pending === true, JSON.stringify(reenter))
  check('再进来 → 计时重置（since 是新的）', reenter.since === T0 + CONFIRM_MS + 200, String(reenter.since))

  /* ④ 移出：出框先是候选，1 秒后才确认。 */
  const out1 = stepDragIntent(null, null, 'L', T0)
  check('出框 → 意图是 leave', out1.kind === 'leave' && out1.containerId === 'L', JSON.stringify(out1))
  check('刚出框 → 还是候选（没变暗）', out1.pending === true, JSON.stringify(out1))
  const out2 = stepDragIntent(out1, null, 'L', T0 + CONFIRM_MS)
  check('出框满 1 秒 → 已确认（变暗）', out2.pending === false, JSON.stringify(out2))

  /* ⑤ 「移动回框不会移出」：回框 → 意图回到 none，计时清零。
   *    这正是用户要的效果 —— 出去看一眼不算数，得待够。 */
  const back = stepDragIntent(out2, 'L', 'L', T0 + CONFIRM_MS + 50)
  check('回到原框 → 没有动作（不移出）', back.kind === 'none', JSON.stringify(back))
  check('回到原框 → 计时归零', back.since === T0 + CONFIRM_MS + 50, String(back.since))

  /* ⑥ 在**自己原本的容器**里呆着不算「加入」——否则一拖到原处就重复加入。 */
  const same = stepDragIntent(null, 'L', 'L', T0)
  check('在自己原本的容器里 → 没有动作', same.kind === 'none', JSON.stringify(same))

  /* ⑦ 不在任何容器、也不属于任何容器 → 没有动作。 */
  const idle = stepDragIntent(null, null, null, T0)
  check('既不进也不出 → 没有动作', idle.kind === 'none' && idle.pending === false, JSON.stringify(idle))

  /* ⑧ 换容器（A 里拖到 B）：目标是 B，且**不是**「移出 A」。 */
  const swap = stepDragIntent(null, 'B', 'A', T0)
  check('换容器 → join B（不是 leave A）', swap.kind === 'join' && swap.containerId === 'B', JSON.stringify(swap))
}

console.log('')
console.log('⑭ 加入时补齐中间节点（用户：「加入后检测**两个节点**是否有中间节点，如果有一起加入进来」）')
{
  /* ⚠️ 关键在「**两个**」：补齐的集合是「刚拖进来的 + **容器里已有的**」。
   *
   * 第一版我把它理解成「只拿刚拖进来的那一个」→ `{单个节点}` 补不出任何东西
   * （一个点谈不上「两点之间」），这条断言当场就红了。用户那句话里的
   * 「两个节点」是有指的：**一个已有的、一个刚进来的**。 */
  const mk = (kidsInL) => [
    n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 500, h: 300 }),
    n('a', { position: { x: 20, y: 20 }, ...kidsInL.includes('a') ? { parentId: 'L' } : {} }),
    n('b', { position: { x: 200, y: 20 }, ...kidsInL.includes('b') ? { parentId: 'L' } : {} }),
    n('c', { position: { x: 380, y: 20 }, ...kidsInL.includes('c') ? { parentId: 'L' } : {} }),
  ]
  const edges = [e('a', 'b'), e('b', 'c')]

  /* 容器里已有 a、c（两头），用户把**中间的 b** 拖进来 —— b 本来就该在，
   * 而 a 与 c 之间也没别人了，所以没有额外要补的。 */
  const r1 = assignWithClosure(mk(['a', 'c']), 'b', 'L', edges)
  check('补 b 时没有多余的（a、c 已在里面）', r1.closed.length === 0, JSON.stringify(r1.closed))

  /* 容器里已有 a（链头），用户把 c（链尾）拖进来 →
   * a 与 c 之间夹着 b，按「两个节点之间有中间节点就一起加入」该把 b 拉进来。 */
  const r2 = assignWithClosure(mk(['a']), 'c', 'L', edges)
  check('已有链头、拖入链尾 → 中间的 b 一起进来', r2.closed.includes('b'), JSON.stringify(r2.closed))

  /* 容器里已有 c（链尾），用户把 a（链头）拖进来 → 同理，中间的 b 该进来。 */
  const r3 = assignWithClosure(mk(['c']), 'a', 'L', edges)
  check('已有链尾、拖入链头 → 中间的 b 一起进来', r3.closed.includes('b'), JSON.stringify(r3.closed))

  /* 容器是空的，用户只拖一个 a 进来 → 没有任何「两个节点之间」，不补。 */
  const r4 = assignWithClosure(mk([]), 'a', 'L', edges)
  check('容器空、只拖一个 → 不补（没有「两点之间」）', r4.closed.length === 0, JSON.stringify(r4.closed))

  /* 已有归属（属于别的容器）的节点不动 —— 一个节点只能有一个父。 */
  const nodes2 = [
    n('L', { defId: LOOP_DEF_ID, w: 400, h: 300 }),
    n('G', { type: 'group', defId: '__group', position: { x: 700, y: 0 }, w: 200, h: 200 }),
    n('a'),
    n('b', { parentId: 'G' }),
  ]
  const r5 = assignWithClosure(nodes2, 'a', 'L', [e('a', 'b')])
  check('属于别的容器的节点不被拉走', !r5.closed.includes('b'), JSON.stringify(r5.closed))
  check('那个节点的归属没变', r5.nodes.find(x => x.id === 'b').parentId === 'G')

  /* 已经在目标容器里的不重复处理。 */
  const r6 = assignWithClosure(mk(['a']), 'a', 'L', edges)
  check('已在容器里 → 不产生变化', r6.closed.length === 0, JSON.stringify(r6.closed))
}

console.log('')
console.log('⑮ dropTarget 的**三态必须真的产出三种结果**（审查抓出的真 bug）')
{
  /* 它的返回值有三种，调用方**不能压成两种**：
   *   字符串 → 中心点落在这个容器里（加入候选）
   *   `null` → 完全离开原容器（移出候选）
   *   `undefined` → **半进半出，保持原样**（手抖不该被踢出）
   *
   * 实测的真 bug：画布那边写成 `typeof hit === 'string' ? hit : null`，
   * 把 `undefined` 也变成 `null`（=「不在任何容器」）→ 判成移出 →
   * 停够 1 秒**真把节点踢出容器**，正好违反本模块自己写的「半进半出保持原位」。
   *
   * ⚠️ 这段测的是**契约本身**：三态必须真的产出三种结果。
   * 若哪天 `dropTarget` 退化成只返回两种，上面那种压缩就变「合理」了 —— 那种退化必须被发现。 */
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 400, h: 300 })
  const SZ = sizes({ L: [400, 300], a: [300, 200], b: [300, 200], c: [300, 200] })

  /* ① 中心点在容器内 → 容器 id。 */
  const inside = n('a', { position: { x: 40, y: 60 }, parentId: 'L' })
  const r1 = dropTarget([L, inside], 'a', SZ, { w: 300, h: 200 })
  check('中心点在容器内 → 返回容器 id', r1 === 'L', String(r1))

  /* ② 半进半出：中心点出框、但仍与容器重叠 → `undefined`。
   *    容器 x∈[0,400]；节点宽 300、x = -160 → 占 [-160,140]，中心 -10（在框外），
   *    但重叠 140px > 0，所以是「半进半出」。 */
  const halfOut = n('b', { position: { x: -160, y: 0 }, parentId: 'L' })
  const r2 = dropTarget([L, halfOut], 'b', SZ, { w: 300, h: 200 })
  check('半进半出 → undefined（保持原样，别当成移出）', r2 === undefined, String(r2))

  /* ③ 完全离开：一点不重叠 → `null`（这才算移出）。 */
  const farOut = n('c', { position: { x: -2000, y: -2000 }, parentId: 'L' })
  const r3 = dropTarget([L, farOut], 'c', SZ, { w: 300, h: 200 })
  check('完全离开 → null（这才是移出）', r3 === null, String(r3))
}

console.log('')
console.log('⑯ relayoutInside：框内重排（用户 2026-10-13：「加入后立即自动排版，不然叠一起」）')
{
  /* ⚠️ 这条盯的是一个**用户直接看到**的问题：拖进容器后新节点保持松手的位置，
   * 而框里原来的节点还在那儿 → 两个叠在一起、只有一个能看见。
   * 纯逻辑层能测的判据：**排完之后任意两个成员不重叠**、顺序按连线。 */
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 740, h: 564 })
  const A = n('A', { position: { x: 40, y: 64 }, parentId: 'L' })
  const B = n('B', { position: { x: 40, y: 64 }, parentId: 'L' })   // ← 故意与 A 完全重叠
  const SZ = sizes({ L: [740, 564], A: [300, 200], B: [300, 200] })
  const edges = [{ source: 'A', target: 'B' }]

  const out = relayoutInside([L, A, B], 'L', edges, SZ, { w: 300, h: 200 }, 'RIGHT')
  const a = out.find(x => x.id === 'A')
  const b = out.find(x => x.id === 'B')
  check('排完之后 A、B **不再重叠**', a.position.y !== b.position.y,
    `A.y=${a.position.y} B.y=${b.position.y}`)
  check('按连线顺序竖排：A 在 B 上面', a.position.y < b.position.y)
  check('左对齐（x 都取容器左边距）', a.position.x === BOX_PAD_SIDE && b.position.x === BOX_PAD_SIDE,
    `A.x=${a.position.x} B.x=${b.position.x}`)
  check('第一个贴容器上边距', a.position.y === BOX_PAD_TOP, String(a.position.y))
  check('行距 = 节点高 + 间距', b.position.y === BOX_PAD_TOP + 200 + BOX_GAP_Y, String(b.position.y))

  /* 幂等：再排一次必须返回**原数组引用**（否则 setState 死循环）。 */
  const again = relayoutInside(out, 'L', edges, SZ, { w: 300, h: 200 }, 'RIGHT')
  check('幂等：第二次返回原数组引用', again === out)

  /* 只排框内成员，框外节点**一个不许动**。 */
  const outside = n('X', { position: { x: 5000, y: 5000 } })
  const withOutside = relayoutInside([L, A, B, outside], 'L', edges, SZ, { w: 300, h: 200 }, 'RIGHT')
  const x2 = withOutside.find(x => x.id === 'X')
  check('框外节点不受影响', x2.position.x === 5000 && x2.position.y === 5000)

  /* 单个成员不排（排了只会把它挪走，没有「不重叠」可言）。 */
  const one = [L, A]
  check('只有一个成员时不排（原样返回）', relayoutInside(one, 'L', [], SZ, { w: 300, h: 200 }, 'RIGHT') === one)

  /* 跨框的边不参与内部排序（那是循环的进出边）。
   * ⚠️ 判据不能写成「B 排在上边距」—— A、B 都在框内且**内部没有边**，
   * `topoSort` 会给它们同层、按原顺序 A 前 B 后，所以 B 本来就在第二位（304）。
   * 正确的判据是：**外面那根边没有改变内部顺序**（B 仍紧跟 A，而不是被排到 A 前面）。 */
  const Z = n('Z', { position: { x: 9999, y: 9999 } })
  const crossEdge = [{ source: 'Z', target: 'B' }]
  const out2 = relayoutInside([L, A, B, Z], 'L', crossEdge, SZ, { w: 300, h: 200 }, 'RIGHT')
  const a2 = out2.find(x => x.id === 'A')
  const b2 = out2.find(x => x.id === 'B')
  check('跨框边不参与内部顺序（A 仍在 B 上面）', a2.position.y < b2.position.y,
    `A=${a2.position.y} B=${b2.position.y}`)
  check('跨框边的两端：Z 不在框内、位置没被改', out2.find(x => x.id === 'Z').position.x === 9999)

  /* 环里的节点（A→B→A）拓扑排不出来 → 也要有位置，不能丢。 */
  const cycEdge = [{ source: 'A', target: 'B' }, { source: 'B', target: 'A' }]
  const out3 = relayoutInside([L, A, B], 'L', cycEdge, SZ, { w: 300, h: 200 }, 'RIGHT')
  const a3 = out3.find(x => x.id === 'A')
  const b3 = out3.find(x => x.id === 'B')
  check('有环时两个节点都有位置', a3.position.y !== undefined && b3.position.y !== undefined)
  check('有环时不重叠', a3.position.y !== b3.position.y, `A=${a3.position.y} B=${b3.position.y}`)
}

console.log('')
console.log('⑰ 连带移出：拖出的节点「后方的」一起出来（用户 2026-10-13 第 2 条要求）')
{
  /* 用户原话：「脱出的时候应该类似拖入，脱出的节点**后方的**节点应该被连带拖出。」
   * 加上他后面选定的「就按下游」→ 规则 = X + X 在该容器内的**全部下游**。 */
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 740, h: 564 })
  const A = n('A', { position: { x: 40, y: 64 }, parentId: 'L' })
  const B = n('B', { position: { x: 40, y: 304 }, parentId: 'L' })
  const C = n('C', { position: { x: 40, y: 544 }, parentId: 'L' })
  const chain = [L, A, B, C]
  const e = [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }]

  /* 拖 A（头）→ 三个全带走。 */
  const fromHead = leaveClosure(chain, e, 'A', 'L')
  check('拖头 A → 带走 3 个（自己 + 全部下游）', fromHead.length === 3 && fromHead[0] === 'A',
    JSON.stringify(fromHead))

  /* 拖 B（中间）→ B、C 走，**A 留在框里**。 */
  const fromMid = leaveClosure(chain, e, 'B', 'L')
  check('拖中间 B → 带走 B、C（A 留下）',
    fromMid.length === 2 && fromMid.includes('B') && fromMid.includes('C') && !fromMid.includes('A'),
    JSON.stringify(fromMid))

  /* 拖 C（尾）→ 只自己。 */
  const fromTail = leaveClosure(chain, e, 'C', 'L')
  check('拖尾 C → 只带走自己', fromTail.length === 1 && fromTail[0] === 'C', JSON.stringify(fromTail))

  /* 分支：A→B、A→C。拖 A 要两条都带走。 */
  const fork = [{ source: 'A', target: 'B' }, { source: 'A', target: 'C' }]
  const fromFork = leaveClosure(chain, fork, 'A', 'L')
  check('有分支时两条都带走', fromFork.length === 3, JSON.stringify(fromFork))

  /* 跨框的边**不该**顺着扩散：外面 Z → 框里 B，不构成 B 的下游。
   *
   * ⚠️ 这条要构造得**能真的抓住**「按源或目标在框内就收」那种破法：
   * 上一版只放了 `Z → B`（Z 是源、没有下游），把它改成「按任一端在框内就收」
   * 也带不走 Z（Z 没有下游可扩散）→ 注入无效、断言假绿（实测踩过）。
   * 现在补一条**框内 → 框外**的边（`C → Z2`）：若判据放宽，
   * 就会顺着这条边把**框外的 Z2** 也带走 —— 那正是要禁止的。 */
  const Z = n('Z', { position: { x: 9000, y: 9000 } })
  const Z2 = n('Z2', { position: { x: 9500, y: 9500 } })
  const cross = [
    { source: 'Z', target: 'B' },   // 外 → 内
    { source: 'C', target: 'Z2' },  // 内 → 外（关键：放宽判据会带走 Z2）
    { source: 'B', target: 'C' },
  ]
  const withCross = leaveClosure([...chain, Z, Z2], cross, 'B', 'L')
  check('跨框边不扩散（外面那两个都不被带走）',
    withCross.length === 2 && !withCross.includes('Z') && !withCross.includes('Z2'),
    JSON.stringify(withCross))

  /* 环：A→B→A（外部回边造成）。不能死循环，且两个都带走。 */
  const cyc = [{ source: 'A', target: 'B' }, { source: 'B', target: 'A' }]
  const fromCycle = leaveClosure(chain, cyc, 'A', 'L')
  check('有环时不死循环且带走成环的两个',
    fromCycle.length === 2 && fromCycle.includes('B') && !fromCycle.includes('C'),
    JSON.stringify(fromCycle))

  /* removeWithClosure：真的把归属解掉 + 安排落点。 */
  const SZ = sizes({ L: [740, 564], A: [300, 200], B: [300, 200], C: [300, 200] })
  const r = removeWithClosure(chain, e, 'B', 'L', SZ, { w: 300, h: 200 })
  const bAfter = r.nodes.find(x => x.id === 'B')
  const cAfter = r.nodes.find(x => x.id === 'C')
  const aAfter = r.nodes.find(x => x.id === 'A')
  check('B、C 的归属被解掉', bAfter.parentId === undefined && cAfter.parentId === undefined)
  check('A 还在框里', aAfter.parentId === 'L')
  check('moved 报告的是跟着出来的（不含自己）',
    r.moved.length === 1 && r.moved[0] === 'C', JSON.stringify(r.moved))
  check('落点在框的右侧', bAfter.position.x > 740, String(bAfter.position.x))
  check('移出的两个竖排不重叠', cAfter.position.y > bAfter.position.y,
    `B.y=${bAfter.position.y} C.y=${cAfter.position.y}`)
}

console.log('')
console.log('⑱ 端到端：用户报的三条问题，按**真实操作序列**走一遍')
{
  /* 为什么要有这一段（单函数各自正确 ≠ 序列正确）：
   * 用户报的是「一路操作下来不对劲」，所以必须按
   * 加入 → 贴合 → 拖出中间 → 再拖回 的**顺序**验一遍。
   * 单测每个函数都过、而序列坏掉的情况，本项目遇到过不止一次。 */
  const L0 = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 740, h: 564 })
  let nodes = [L0, n('A', { position: { x: 1200, y: 0 } }), n('B', { position: { x: 1200, y: 260 } }), n('C', { position: { x: 1200, y: 520 } })]
  const e = [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }]
  const SZ = sizes({ L: [740, 564], A: [300, 200], B: [300, 200], C: [300, 200] })

  /* ① 把 A 拖进框 → 加入 + 重排 + 贴边。 */
  nodes = nodes.map(x => x.id === 'A' ? { ...x, position: { x: 100, y: 100 } } : x)
  nodes = assignWithClosure(nodes, 'A', 'L', e).nodes
  nodes = relayoutInside(nodes, 'L', e, SZ, { w: 300, h: 200 }, 'RIGHT')
  nodes = fitLoopBox(nodes, 'L', SZ, { w: 300, h: 200 })
  check('① A 进框且框不小于最小值',
    nodes.find(x => x.id === 'A').parentId === 'L'
    && (nodes.find(x => x.id === 'L').style.width ?? 0) >= BOX_MIN_W)

  /* ② 把 B、C 也拖进去（分别拖，模拟用户一个个拖）。 */
  for (const id of ['B', 'C']) {
    nodes = nodes.map(x => x.id === id ? { ...x, position: { x: 150, y: 150 } } : x)
    nodes = assignWithClosure(nodes, id, 'L', e).nodes
  }
  nodes = relayoutInside(nodes, 'L', e, SZ, { w: 300, h: 200 }, 'RIGHT')
  nodes = fitLoopBox(nodes, 'L', SZ, { w: 300, h: 200 })
  const ys2 = ['A', 'B', 'C'].map(id => nodes.find(x => x.id === id).position.y)
  check('② 框内三个不重叠（用户问题 1：不叠一起）', new Set(ys2).size === 3, ys2.join(','))
  check('② 框内顺序 = 连线顺序', ys2[0] < ys2[1] && ys2[1] < ys2[2], ys2.join(','))

  /* ③ 把中间的 B 拖出去 → 连带 C，A 留下，**框不跳走**。 */
  const boxBefore = { ...nodes.find(x => x.id === 'L').position }
  nodes = nodes.map(x => x.id === 'B' ? { ...x, position: { x: -3000, y: -3000 } } : x)
  const r = removeWithClosure(nodes, e, 'B', 'L', SZ, { w: 300, h: 200 })
  nodes = r.nodes
  check('③ B、C 一起出来（用户问题 2）',
    nodes.find(x => x.id === 'B').parentId === undefined && nodes.find(x => x.id === 'C').parentId === undefined)
  check('③ A 留在框里', nodes.find(x => x.id === 'A').parentId === 'L')
  nodes = relayoutInside(nodes, 'L', e, SZ, { w: 300, h: 200 }, 'RIGHT')
  nodes = fitLoopBox(nodes, 'L', SZ, { w: 300, h: 200 })
  const boxAfter = nodes.find(x => x.id === 'L').position
  check('③ **框没跳走**（用户问题 3 的根因）',
    boxAfter.x === boxBefore.x && boxAfter.y === boxBefore.y,
    `前(${boxBefore.x},${boxBefore.y}) 后(${boxAfter.x},${boxAfter.y})`)

  /* ④ 把 B 再拖回框里 → 必须能进去（用户报「无法拖入」）。 */
  const inside = { x: boxAfter.x + 100, y: boxAfter.y + 100 }
  nodes = nodes.map(x => x.id === 'B' ? { ...x, position: inside } : x)
  const hit = dropTarget(nodes, 'B', SZ, { w: 300, h: 200 })
  check('④ 能拖回来（用户问题 3：「无法拖入」已修）', hit === 'L', String(hit))
  check('④ B 真的回到框里', assignWithClosure(nodes, 'B', 'L', e).nodes.find(x => x.id === 'B').parentId === 'L')
}

console.log('')
console.log(failed === 0 ? '结论：容器归属全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

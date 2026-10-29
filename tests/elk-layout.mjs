/** 自动布局（ELK 分层）测试：方向要对，且**端口 id 必须全局唯一**。
 *
 * 为什么建它（2026-10-11）：
 * 用户问「自动布局能不能多种预设」，实测时才发现既有实现**一直排不对**——
 * 横向排出来是 308×524（竖方形）、纵向 596×506（近正方），两个方向看着差不多。
 *
 * 真因：ELK 的端口 id 直接用了 `sourceHandle` 那串名字（`'out'` / `'in'`），
 * 而**每个节点都有同名端口**。ELK 眼里全图只有一个 `out`、一个 `in`，
 * 端口归属错乱 → 分层约束失效 → 退化成方块。
 * 修法：端口 id 加节点前缀（`节点id:端口名`）。
 * 修好后同一张图：横向 924×266、纵向 714×774。
 *
 * 这个坑**不报错、不崩、也不影响单测**，只是排得难看——
 * 所以必须靠断言形状来兜。
 */
import { elkLayout, measureNodes } from '../src/client/workbench/canvas-layout.ts'

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

/** 造一张有分叉与汇合的图（复刻真实工作流的形状）。 */
function makeGraph() {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5']
  const nodes = ids.map(id => ({ id, position: { x: 0, y: 0 }, data: { def: { id: 'x' } } }))
  /* 关键：**不同节点的端口同名**（都叫 out / in）—— 这正是引发 BUG 的形状。 */
  const edges = [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'e3', source: 'n2', target: 'n4', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'e4', source: 'n3', target: 'n4', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'e5', source: 'n4', target: 'n5', sourceHandle: 'out', targetHandle: 'in' },
  ]
  return { nodes, edges }
}

/**
 * 坐标集合的包围盒。
 * @param pos - id → 位置。
 * @returns 宽高与节点数。
 */
function bounds(pos) {
  const pts = Object.values(pos)
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  return {
    w: Math.round(Math.max(...xs) - Math.min(...xs)),
    h: Math.round(Math.max(...ys) - Math.min(...ys)),
    n: pts.length,
  }
}

console.log('=== 自动布局（ELK 分层）===')
console.log('① 每个节点都要有坐标（缺了会堆在左上角）')
{
  const { nodes, edges } = makeGraph()
  for (const dir of ['RIGHT', 'DOWN']) {
    const pos = await elkLayout(nodes, edges, undefined, dir)
    const missing = nodes.filter(n => pos[n.id] === undefined).map(n => n.id)
    check(dir + ' 全部节点都有坐标', missing.length === 0, missing.length === 0 ? '' : '缺: ' + missing.join(','))
  }
}

console.log('')
console.log('② 方向必须真的生效（这条就是那个 BUG 的哨兵）')
{
  const { nodes, edges } = makeGraph()
  const right = bounds(await elkLayout(nodes, edges, undefined, 'RIGHT'))
  const down = bounds(await elkLayout(nodes, edges, undefined, 'DOWN'))
  console.log('     横向 ', right.w + '×' + right.h + 'px')
  console.log('     纵向 ', down.w + '×' + down.h + 'px')

  /* 判据用**长宽比**，不用「纵向必须高>宽」（2026-10-11 改）。
   *
   * 为什么改：节点宽度从 218 提到 300 后，纵向排时同一层两个节点并排就有 600px 起，
   * 于是这张 4 层的图纵向是 960×774 ——「高>宽」不再成立，但那**不是布局坏了**，
   * 是节点变宽的必然结果。原来的写法把「节点不能太宽」偷偷编进了断言里。
   *
   * 新判据仍然抓得住那个真 BUG：出 BUG 时（端口 id 重名）实测是
   *   横向 308×524（比 0.59）、纵向 596×506（比 1.18）——
   * 两个方向的形态**反了**，所以下面这条会失败。 ✅ 已按此核对过。 */
  const aspect = (b) => b.w / b.h
  const arR = aspect(right)
  const arD = aspect(down)
  console.log('     长宽比：横向 ' + arR.toFixed(2) + ' ｜ 纵向 ' + arD.toFixed(2))
  check('横向：明显是横的（宽 > 高）', right.w > right.h, right.w + ' vs ' + right.h)
  check('横向比纵向「更横」（方向真的生效了）', arR > arD * 1.5,
    '横向比 ' + arR.toFixed(2) + '，纵向比 ' + arD.toFixed(2))
  /* 防「退化成方块」：横向的宽至少是纵向宽的 1.2 倍。 */
  check('两个方向明显不同（没退化成方块）', right.w > down.w * 1.2,
    '横向宽 ' + right.w + '，纵向宽 ' + down.w)
}

console.log('')
console.log('③ 连线两端要对齐到同一层（分层结构正确）')
{
  const { nodes, edges } = makeGraph()
  const pos = await elkLayout(nodes, edges, undefined, 'RIGHT')
  /* 横向时「层」是 x：上游的 x 必须小于下游（图上从左往右流）。 */
  const pairs = [['n1', 'n2'], ['n2', 'n4'], ['n4', 'n5']]
  const bad = pairs.filter(([a, b]) => !(pos[a].x < pos[b].x))
  check('上游在左、下游在右', bad.length === 0,
    bad.length === 0 ? '' : '这几对没分层: ' + bad.map(p => p.join('→')).join(' '))
}

console.log('')
console.log('④ 端口 id 必须全局唯一（真因回归）')
{
  /* 直接验 `pid` 的效果：同名端口在**不同节点**上不能被 ELK 当成同一个。
   * 做法：拿只有两个节点、端口名相同的图，看它是否还能正确分层。
   * 端口重名时 ELK 会把两端算成一个端口，分层塌掉。 */
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
    { id: 'b', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
  ]
  const edges = [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }]
  const pos = await elkLayout(nodes, edges, undefined, 'RIGHT')
  check('两节点、同名端口时仍分两层', pos.a.x !== pos.b.x, 'a.x=' + pos.a.x + ' b.x=' + pos.b.x)
}

console.log('')
console.log('⑤ 没有连线的孤立节点也要有坐标')
{
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
    { id: 'lonely', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
  ]
  const pos = await elkLayout(nodes, [], undefined, 'RIGHT')
  check('孤立节点有坐标', pos.lonely !== undefined)
  check('两个节点没被叠在一起', pos.a.x !== pos.lonely.x || pos.a.y !== pos.lonely.y)
}

console.log('')
console.log('⑥ 间距要跟节点宽度成比例（2026-10-11 用户报「左右排版间隔太近」）')
{
  /* 真因：间距原来是**写死的 90px**，而节点宽度从 218 涨到 300 之后没跟着调，
   * 于是「间距/宽」的比例从 0.41 掉到 0.30 —— 看着就挤了。
   *
   * 这个测试钉住的是**比例关系**：节点越宽，间距必须越大。
   * 用同一个宽度调用两次（宽度不同）比较，不写死具体像素值——
   * 那样将来调比例不会误报，而「又脱钩了」一定会被抓住。 */
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
    { id: 'b', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } },
  ]
  const edges = [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' }]
  const sizes = new Map([['a', { w: 200, h: 120 }], ['b', { w: 200, h: 120 }]])

  const gapOf = async (nodeWidth) => {
    const pos = await elkLayout(nodes, edges, sizes, 'RIGHT', nodeWidth)
    return Math.round(pos.b.x - (pos.a.x + 200))
  }
  const narrow = await gapOf(200)
  const wide = await gapOf(400)
  console.log('     节点宽 200 → 层间距 ' + narrow + 'px ｜ 节点宽 400 → ' + wide + 'px')
  check('节点更宽时间距更大（比例生效）', wide > narrow, narrow + ' → ' + wide)
  check('间距不是写死的 90', !(narrow === 90 && wide === 90), narrow + ' / ' + wide)

  /* 不传宽度时用兜底值（保证「拿不到宽度」也不会崩或排得太挤）。 */
  const fallback = await elkLayout(nodes, edges, sizes, 'RIGHT')
  const fbGap = Math.round(fallback.b.x - (fallback.a.x + 200))
  console.log('     不传宽度 → 层间距 ' + fbGap + 'px（兜底值）')
  check('不传宽度也能排（走兜底间距）', fbGap > 0, String(fbGap))
}

console.log('')
console.log('⑧ 容器成员不交给 ELK（2026-10-15 用户报「循环被当普通节点，内容不在循环里」）')
{
  /* ## 症状与根因
   *
   * 用户原话：「当前自动排序的时候，循环似乎会被当做一个节点处理，
   * 导致循环内的内容不在循环里面。刚打开工作流的时候也是。」
   *
   * 真因是**两套坐标系混了**：ELK 算出来的是**绝对坐标**，
   * 而带 `parentId` 的成员，`position` 存的是**相对容器**的数。
   * 把绝对值直接写进相对字段 → 成员被平移一个容器原点 → 飞到框外。
   *
   * 实测（修前）：循环 n2 在 x=402，ELK 给成员 n3 的 x=792，
   * 写进去后 n3 的实际位置 = 402+792 = 1194，而框只到 902 → 在框外。
   *
   * 所以钉住的判据是：**返回的坐标表里不许有容器成员**（由框内竖排负责它们），
   * 且容器**自己**要有坐标（它是顶层节点，照常参与分层）。 */
  const nodes = [
    { id: 'top1', position: { x: 0, y: 0 }, data: { def: { id: 'code.js' } } },
    { id: 'loop', position: { x: 0, y: 0 }, data: { def: { id: 'flow.loop' } } },
    { id: 'kid1', position: { x: 40, y: 64 }, parentId: 'loop', data: { def: { id: 'browser.act' } } },
    { id: 'kid2', position: { x: 40, y: 300 }, parentId: 'loop', data: { def: { id: 'flow.delay' } } },
    { id: 'top2', position: { x: 0, y: 0 }, data: { def: { id: 'code.js' } } },
  ]
  const edges = [
    { id: 'e1', source: 'top1', target: 'loop', targetHandle: 'in' },
    /* 跨边界的边（循环 → 体内成员）：它是容器**内部**关系，不该在顶层分层占一层。 */
    { id: 'e2', source: 'loop', target: 'kid1', targetHandle: 'in' },
    { id: 'e3', source: 'kid1', target: 'kid2', targetHandle: 'in' },
    { id: 'e4', source: 'loop', target: 'top2', targetHandle: 'in' },
  ]
  const pos = await elkLayout(nodes, edges, undefined, 'RIGHT', 300, 90)
  console.log('     ELK 返回的键: ' + JSON.stringify(Object.keys(pos)))

  check('★ 成员不在 ELK 的结果里（它们存的是相对坐标，交给框内竖排）',
    pos.kid1 === undefined && pos.kid2 === undefined,
    'kid1=' + JSON.stringify(pos.kid1) + ' kid2=' + JSON.stringify(pos.kid2))
  check('★ 容器自己在结果里（它是顶层节点）', pos.loop !== undefined, JSON.stringify(pos.loop))
  check('顶层节点都在结果里', pos.top1 !== undefined && pos.top2 !== undefined, JSON.stringify(Object.keys(pos)))

  /* ★ 反向：修前那种「成员也进结果」的形态必须被抓到 ——
   * 判据是「成员在里面」会直接失败（上面那条），这里再确认一次
   * **顶层节点的相对次序是对的**（免得为了排除成员把布局也排坏了）。 */
  const xs = [pos.top1?.x, pos.loop?.x, pos.top2?.x]
  console.log('     顶层 x: top1=' + String(pos.top1?.x) + ' loop=' + String(pos.loop?.x) + ' top2=' + String(pos.top2?.x))
  check('顶层仍按分层递增（没被排除逻辑搞坏）',
    xs[0] < xs[1] && xs[1] < xs[2], JSON.stringify(xs))

  /* 全是成员（没有顶层节点）时不能崩，也不能返回垃圾坐标。 */
  const onlyKids = await elkLayout(
    [{ id: 'L', position: { x: 0, y: 0 }, data: { def: { id: 'flow.loop' } } },
      { id: 'k', position: { x: 1, y: 2 }, parentId: 'L', data: { def: { id: 'x' } } }],
    [], undefined, 'RIGHT')
  check('只有容器与成员时不崩', onlyKids !== undefined, JSON.stringify(onlyKids))
  check('成员仍不在结果里', onlyKids.k === undefined, JSON.stringify(onlyKids.k))
}

console.log('')
console.log('⑦ 量尺寸要除掉画布缩放（否则缩到 50% 再布局会重叠）')
{
  /* `getBoundingClientRect()` 给的是**屏幕**尺寸，会被画布缩放乘过；
   * 而 ELK 要的是画布坐标下的尺寸。不除掉的话：
   * 缩到 50% 时量到 150、ELK 按 150 排版，而节点实际 300 → **真的重叠**。 */
  const nodes = [{ id: 'a', position: { x: 0, y: 0 }, data: { def: { id: 'x' } } }]
  /* 造一个假的画布容器：viewport 带 scale(0.5)，节点 rect 也随之减半。 */
  const el = {
    querySelector: () => ({ style: { transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' } }),
    querySelectorAll: (sel) => (sel.includes('react-flow__node')
      ? [{ dataset: { id: 'a' }, getBoundingClientRect: () => ({ width: 150, height: 100 }) }]
      : []),
  }
  const m = measureNodes(el)
  console.log('     量到:', JSON.stringify(m.get('a')), '（应为 300×200，不是 150×100）')
  check('缩放 0.5 时量出的是画布坐标尺寸', m.get('a')?.w === 300 && m.get('a')?.h === 200,
    JSON.stringify(m.get('a')))
  /* 不缩放的容器：结果应当与 rect 一致。 */
  const el2 = {
    querySelector: () => ({ style: { transform: '' } }),
    querySelectorAll: () => [{ dataset: { id: 'a' }, getBoundingClientRect: () => ({ width: 300, height: 200 }) }],
  }
  const m2 = measureNodes(el2)
  check('缩放为 1 时尺寸原样', m2.get('a')?.w === 300, JSON.stringify(m2.get('a')))
  /* 容器为 null 不能崩。 */
  check('容器为 null 时返回空表', measureNodes(null).size === 0)
}

console.log('')
console.log(failed === 0 ? '结论：自动布局全部通过 ✓' : '结论：有 ' + failed + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

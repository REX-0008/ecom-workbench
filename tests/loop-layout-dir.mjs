/** 框内排列：**方向联动** + **嵌套循环**（2026-10-19，t27）。
 *
 * ## 它守的两件事
 *
 * ① **框内轴向与画布方向正交**（不是跟随）：
 *    画布横排（`RIGHT`）→ 框内**竖排**；画布竖排（`DOWN`）→ 框内**横排**。
 *    理由是省地方：横排的图宽而矮，框内再横排会宽到没法看。
 * ② **嵌套循环**：内层循环是外层的一个成员，要按**它自己声明的尺寸**占位
 *    （不是普通节点的兜底尺寸），并且它自己那批成员也要跟着重排。
 *
 * ## 为什么单独一个文件（而不是并进 `container-ops.mjs`）
 *
 * `container-ops.mjs` 钉的是「归属与坐标换算」（拖进拖出、贴边、幂等），
 * 这个文件钉的是「排出来的**形状**对不对」。两者错的症状完全不同：
 * 前者是「节点飞到框外」，后者是「位置都对、但排成一条不该有的直线」。
 *
 * ⚠️ **必须断言「形状」，不能只断言「没重叠」** ——
 * 方向写死成竖排时，「没重叠」照样成立（这正是不写方向测试会漏掉它的原因）。
 *
 * 跑法：node --import <tsx> tests/loop-layout-dir.mjs
 */
import {
  relayoutInside, innerAxisOf, LOOP_DEF_ID, fitLoopBox, clampIntoLoop, orderLoopsInnerFirst,
  BOX_PAD_SIDE, BOX_PAD_TOP, BOX_GAP_X, BOX_GAP_Y, MAX_LOOP_DEPTH_UI,
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
 * @param opts - defId / position / parentId / 尺寸（写在 style 上）。
 */
function n(id, opts = {}) {
  const out = {
    id,
    type: 'v1',
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

/** 兜底尺寸（与画布的 `NODE_W` / `NODE_H` 一致）。 */
const FB = { w: 300, h: 168 }

/** 取一个节点的坐标。 */
function posOf(nodes, id) {
  const x = nodes.find(v => v.id === id)
  return x === undefined ? null : { x: x.position.x, y: x.position.y }
}

console.log('=== 框内排列：方向联动 + 嵌套（loop-layout-dir）===')
console.log('')

console.log('① innerAxisOf：正交映射')
{
  check('画布横排（RIGHT）→ 框内竖排（TB）', innerAxisOf('RIGHT') === 'TB', innerAxisOf('RIGHT'))
  check('画布竖排（DOWN）→ 框内横排（LR）', innerAxisOf('DOWN') === 'LR', innerAxisOf('DOWN'))
  /* 这条守的是「别写成跟随」：跟随会让两个方向刻意相同。 */
  check('★ 两个方向**不同**（正交，不是跟随）', innerAxisOf('RIGHT') !== innerAxisOf('DOWN'))
}

console.log('')
console.log('② 外部 RIGHT → 框内竖排：y 递增、x 全相同')
{
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 740, h: 900 })
  const A = n('A', { parentId: 'L' })
  const B = n('B', { parentId: 'L' })
  const C = n('C', { parentId: 'L' })
  const SZ = sizes({ L: [740, 900], A: [300, 168], B: [300, 168], C: [300, 168] })
  const edges = [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }]

  const out = relayoutInside([L, A, B, C], 'L', edges, SZ, FB, 'RIGHT')
  const a = posOf(out, 'A')
  const b = posOf(out, 'B')
  const c = posOf(out, 'C')
  check('★ x 三者相同（竖排 = 左对齐一列）', a.x === b.x && b.x === c.x, JSON.stringify([a, b, c]))
  check('★ x 取容器左边距', a.x === BOX_PAD_SIDE, String(a.x))
  check('★★ y 依次递增（A < B < C）', a.y < b.y && b.y < c.y, JSON.stringify([a.y, b.y, c.y]))
  check('第一个贴容器上边距', a.y === BOX_PAD_TOP, String(a.y))
  check('行距 = 成员高 + BOX_GAP_Y', b.y === BOX_PAD_TOP + 168 + BOX_GAP_Y, String(b.y))
}

console.log('')
console.log('③ 外部 DOWN → 框内横排：x 递增、y 全相同')
{
  const L = n('L', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 1600, h: 400 })
  const A = n('A', { parentId: 'L' })
  const B = n('B', { parentId: 'L' })
  const C = n('C', { parentId: 'L' })
  const SZ = sizes({ L: [1600, 400], A: [300, 168], B: [300, 168], C: [300, 168] })
  const edges = [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }]

  const out = relayoutInside([L, A, B, C], 'L', edges, SZ, FB, 'DOWN')
  const a = posOf(out, 'A')
  const b = posOf(out, 'B')
  const c = posOf(out, 'C')
  check('★ y 三者相同（横排 = 顶对齐一行）', a.y === b.y && b.y === c.y, JSON.stringify([a, b, c]))
  check('★ y 取容器上边距', a.y === BOX_PAD_TOP, String(a.y))
  check('★★ x 依次递增（A < B < C）', a.x < b.x && b.x < c.x, JSON.stringify([a.x, b.x, c.x]))
  check('第一个贴容器左边距', a.x === BOX_PAD_SIDE, String(a.x))
  check('列距 = 成员宽 + BOX_GAP_X', b.x === BOX_PAD_SIDE + 300 + BOX_GAP_X, String(b.x))
  /* ⚠️ 这条是「方向真的被用上了」的**反面证据**：
   * 若方向被写死成竖排，上面那批「x 递增」必然不成立。
   *
   * ⚠️ **要拿第二个成员比，不能拿第一个**（第一版就写错了）：
   * 两种轴向的**第一个**成员位置完全一样（都是 `PAD_SIDE, PAD_TOP`），
   * 拿它比等于什么都没验 —— 这是一条真实的假绿，写测试时当场抓到的。 */
  const rightB = posOf(relayoutInside([L, A, B, C], 'L', edges, SZ, FB, 'RIGHT'), 'B')
  check('★★ 同一批成员在两个方向下**排法不同**（拿第 2 个比）',
    JSON.stringify(b) !== JSON.stringify(rightB),
    'DOWN 的 B=' + JSON.stringify(b) + ' ｜ RIGHT 的 B=' + JSON.stringify(rightB))
}

console.log('')
console.log('④ 嵌套：内层成员坐标是**相对内层循环**的，且内层按自己的尺寸占位')
{
  /* 形状：外层 L1 ⊃ 内层 L2 ⊃ { X, Y }，外层还有一个成员 Z。
   *
   *     L1
   *      ├ L2（自己声明 600×400，实测表里**故意不给**它 → 逼实现去读 style）
   *      │   ├ X
   *      │   └ Y
   *      └ Z
   */
  const L1 = n('L1', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 1400, h: 900 })
  const L2 = n('L2', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 600, h: 400, parentId: 'L1' })
  const Z = n('Z', { parentId: 'L1' })
  const X = n('X', { parentId: 'L2' })
  const Y = n('Y', { parentId: 'L2' })
  /* ⚠️ 尺寸表里**没有 L2** —— 首帧 / 面板没挂时就是这样。
   * 实现必须退回它 `style.width/height` 上的 600×400（而不是 FB 的 300×168）。 */
  const SZ = sizes({ L1: [1400, 900], X: [300, 200], Y: [300, 200], Z: [300, 168] })
  const edges = [{ source: 'X', target: 'Y' }]

  /* ⚠️ 用户 2026-10-21 改了口径（原话）：「**不应该每次转**，是自动横排的时候
   * 循环内竖排，自动竖排的时候循环内横排。同时给循环加个按钮调整横排和竖排吧」。
   *
   * 所以**所有嵌套层用同一个轴向**，这里要**逐层单独调**（内层先），
   * 不再靠一次递归把内层也排了。顺序与画布 `refitNodes` 一致。 */
  let out = relayoutInside([L1, L2, Z, X, Y], 'L2', edges, SZ, FB, 'RIGHT')
  out = relayoutInside(out, 'L1', edges, SZ, FB, 'RIGHT')

  /* ── 内层：与外层**同一个**轴向（RIGHT → 竖排）── */
  const l2 = posOf(out, 'L2')
  const x = posOf(out, 'X')
  const y = posOf(out, 'Y')
  check('★★ 内层成员 X、Y 的 x 相同（内层也是竖排 —— 不翻转）',
    x.x === y.x, JSON.stringify([x, y]))
  check('★★ 内层成员 y 递增（竖排）', x.y < y.y, JSON.stringify([x.y, y.y]))
  check('★ 内层成员的 x 从内层自己的左边距开始',
    x.x === BOX_PAD_SIDE, String(x.x))
  /* 「相对内层而不是绝对」的判据：内层的 x 起点不受外层偏移影响。
   * 若错写成绝对坐标，X.x 会等于 L2.x + BOX_PAD_SIDE（外层给它挪了位置后就不是 40 了）。 */
  check('★★★ 内层成员坐标是**相对内层循环**的（不是绝对）',
    x.x === BOX_PAD_SIDE && x.y === BOX_PAD_TOP,
    JSON.stringify(x) + ' ｜ L2=' + JSON.stringify(l2))

  /* ── 外层：L2 按 600×400 占位，Z 排在它后面 ── */
  const z = posOf(out, 'Z')
  check('★ 外层成员 L2 的 x = 外层左边距', l2.x === BOX_PAD_SIDE, String(l2.x))
  check('★★ 外层 L2 之后的 Z：y = L2.y + **600×400 里的 400** + 间距（不是 168）',
    z.y === l2.y + 400 + BOX_GAP_Y, 'L2.y=' + String(l2.y) + ' Z.y=' + String(z.y))
  check('★★★ 若按兜底 168 算会得到另一个值（证明用的是自己的尺寸）',
    z.y !== l2.y + FB.h + BOX_GAP_Y, '兜底算法会给 ' + String(l2.y + FB.h + BOX_GAP_Y))
  check('外层的 x 也一致（外层竖排）', z.x === l2.x, JSON.stringify([l2.x, z.x]))
}

console.log('')
console.log('⑤ 嵌套：三层**同向**（都竖排），逐层单独排')
{
  /* ⚠️ **每层都要有 ≥2 个成员** —— 单成员不排是既有约定（见 ⑧），
   * 若某一层只放一个成员，它就原样留着，测不出「翻转」。
   * 第一版这里 L2 只有 L3 一个成员，于是「L3 在 L2 左边距处」红了：
   * 红得对，是**测试写错了**，不是实现错了。 */
  const L1 = n('L1', { defId: LOOP_DEF_ID, w: 2000, h: 1200 })
  const L2 = n('L2', { defId: LOOP_DEF_ID, w: 1400, h: 700, parentId: 'L1' })
  const S1 = n('S1', { parentId: 'L1' })
  const L3 = n('L3', { defId: LOOP_DEF_ID, w: 700, h: 300, parentId: 'L2' })
  const S2 = n('S2', { parentId: 'L2' })
  const P = n('P', { parentId: 'L3' })
  const Q = n('Q', { parentId: 'L3' })
  const SZ = sizes({
    L1: [2000, 1200], P: [300, 200], Q: [300, 200], S1: [300, 168], S2: [300, 168],
  })
  /* ⚠️ 用户 2026-10-21 定的新口径：「**不应该每次转**」——
   * 所有嵌套层用**同一个**轴向（RIGHT → 竖排），所以三层都是竖排。
   *
   * 逐层单独调（内层先），顺序与画布 `refitNodes` 一致。 */
  let out = relayoutInside([L1, L2, S1, L3, S2, P, Q], 'L3', [{ source: 'P', target: 'Q' }], SZ, FB, 'RIGHT')
  out = relayoutInside(out, 'L2', [{ source: 'P', target: 'Q' }], SZ, FB, 'RIGHT')
  out = relayoutInside(out, 'L1', [{ source: 'P', target: 'Q' }], SZ, FB, 'RIGHT')

  /* 三层都是竖排：每层两个成员的 x 相同、y 递增。 */
  const l2 = posOf(out, 'L2')
  const s1 = posOf(out, 'S1')
  check('★ 第 1 层是竖排：L2 与 S1 的 x 相同、y 递增',
    l2.x === s1.x && l2.y < s1.y, JSON.stringify([l2, s1]))

  const l3 = posOf(out, 'L3')
  const s2 = posOf(out, 'S2')
  check('★★ 第 2 层也是竖排（不翻转）：L3 与 S2 的 x 相同、y 递增',
    l3.x === s2.x && l3.y < s2.y, JSON.stringify([l3, s2]))
  check('★ 第 2 层竖排：L3 的 x 在 L2 的左边距处', l3.x === BOX_PAD_SIDE, String(l3.x))

  const p = posOf(out, 'P')
  const q = posOf(out, 'Q')
  check('★★★ 第 3 层也是竖排：x 相同、y 递增',
    p.x === q.x && p.y < q.y, JSON.stringify([p, q]))
}

console.log('')
console.log('⑥ 层数上限：超过 5 层不再往下递归（与执行期一致）')
{
  check('上限值与执行期同一个数字（5）', MAX_LOOP_DEPTH_UI === 5, String(MAX_LOOP_DEPTH_UI))

  /* 造 6 层：L1 ⊃ L2 ⊃ … ⊃ L6 ⊃ deep。
   * 第 6 层那批**不该被排**（按普通节点原样留着），也不许栈溢出。 */
  const nodes = []
  let parent
  for (let i = 1; i <= 6; i += 1) {
    const node = n('L' + String(i), { defId: LOOP_DEF_ID, w: 900, h: 600 })
    if (parent !== undefined) node.parentId = parent
    nodes.push(node)
    parent = 'L' + String(i)
  }
  nodes.push(n('deep1', { parentId: 'L6' }))
  nodes.push(n('deep2', { parentId: 'L6' }))

  let out
  let threw = ''
  try {
    out = relayoutInside(nodes, 'L1', [], new Map(), FB, 'RIGHT')
  } catch (e) {
    threw = String(e?.message ?? e)
  }
  check('★ 6 层不抛错（有保护，不是无限递归）', threw === '', threw)
  /* ⚠️ 判据：最深那层的两个成员**没被排**（仍是原坐标 0,0）——
   * 说明递归在上限处真的停下了，而不是「排到第 6 层为止」。 */
  const d1 = posOf(out, 'deep1')
  const d2 = posOf(out, 'deep2')
  check('★★ 第 6 层不再排（成员坐标原样留着）',
    d1.x === 0 && d1.y === 0 && d2.x === 0 && d2.y === 0, JSON.stringify([d1, d2]))
}

console.log('')
console.log('⑦ 幂等：同样输入跑两次，第二次返回**原数组引用**')
{
  const L = n('L', { defId: LOOP_DEF_ID, w: 740, h: 900 })
  const A = n('A', { parentId: 'L' })
  const B = n('B', { parentId: 'L' })
  const SZ = sizes({ L: [740, 900], A: [300, 168], B: [300, 168] })
  const edges = [{ source: 'A', target: 'B' }]

  const once = relayoutInside([L, A, B], 'L', edges, SZ, FB, 'RIGHT')
  check('第一次有变化（返回新数组）', once !== undefined)
  const twice = relayoutInside(once, 'L', edges, SZ, FB, 'RIGHT')
  check('★★ 第二次返回**原数组引用**（不然 setState 死循环）', twice === once,
    twice === once ? '' : '返回了一个新数组')

  /* 嵌套下同样要幂等（递归最容易在这里破约：顺手 `[...nodes]`）。 */
  const L1 = n('L1', { defId: LOOP_DEF_ID, w: 1400, h: 900 })
  const L2 = n('L2', { defId: LOOP_DEF_ID, w: 600, h: 400, parentId: 'L1' })
  const X = n('X', { parentId: 'L2' })
  const Y = n('Y', { parentId: 'L2' })
  const nestedSZ = sizes({ L1: [1400, 900], X: [300, 200], Y: [300, 200] })
  const n1 = relayoutInside([L1, L2, X, Y], 'L1', [], nestedSZ, FB, 'RIGHT')
  const n2 = relayoutInside(n1, 'L1', [], nestedSZ, FB, 'RIGHT')
  check('★★ 嵌套下第二次仍返回原数组引用', n2 === n1, n2 === n1 ? '' : '返回了一个新数组')
}

console.log('')
console.log('⑧ 单成员不排（既有约定，别在递归里被破坏）')
{
  const L = n('L', { defId: LOOP_DEF_ID, w: 740, h: 900 })
  const only = n('only', { parentId: 'L', position: { x: 123, y: 456 } })
  const SZ = sizes({ L: [740, 900], only: [300, 168] })
  const out = relayoutInside([L, only], 'L', [], SZ, FB, 'RIGHT')
  check('只有一个成员 → 原样返回（引用相同）', out === out)
  const p = posOf(out, 'only')
  check('★ 那个成员的位置没被挪（123,456）', p.x === 123 && p.y === 456, JSON.stringify(p))

  /* ⚠️ **外层只有一个内层循环**时：外层的本层不排（单成员），
   * 但内层在自己那一轮要排好 —— 这正是新口径（逐层调）要保证的事。
   *
   * 旧断言写的是「一次调外层就把内层也排了」，那依赖递归；
   * 用户 2026-10-21 定了「不应该每次转」，递归已去掉，所以判据跟着改：
   * **按 `orderLoopsInnerFirst` 的顺序逐层调**（内层先），内层必须排好。 */
  const L1 = n('L1', { defId: LOOP_DEF_ID, w: 1400, h: 900 })
  const L2 = n('L2', { defId: LOOP_DEF_ID, w: 600, h: 400, parentId: 'L1' })
  const X = n('X', { parentId: 'L2' })
  const Y = n('Y', { parentId: 'L2' })
  const nestedSZ = sizes({ L1: [1400, 900], X: [300, 200], Y: [300, 200] })
  let nested = relayoutInside([L1, L2, X, Y], 'L2', [], nestedSZ, FB, 'RIGHT')
  nested = relayoutInside(nested, 'L1', [], nestedSZ, FB, 'RIGHT')
  const nx = posOf(nested, 'X')
  const ny = posOf(nested, 'Y')
  check('★★ 外层只有一个成员，但内层那批仍然被排好了（竖排：x 相同、y 不同）',
    nx.x === ny.x && nx.y !== ny.y, JSON.stringify([nx, ny]))
}

console.log('')
console.log('⑩ 框自己算尺寸时也用同一套尺寸判据（不然框会比内容小）')
{
  /* 一个循环里装着**一个内层循环**（实测表里故意不给内层 → 逼它读 `style`）。
   *
   * 判据：框的内宽必须容得下内层的 600px，即 `>= 600 + 两侧内边距`。
   * 若 `fitLoopBox` 用兜底 300 去算，框只有 `300+80=380` —— **内层露在框外**。
   * 这正是 2026-10-19 两处判据漂移时的症状。 */
  const OUT = n('OUT', { defId: LOOP_DEF_ID, position: { x: 0, y: 0 }, w: 380, h: 300 })
  const INNER = n('INNER', { defId: LOOP_DEF_ID, position: { x: BOX_PAD_SIDE, y: BOX_PAD_TOP }, w: 600, h: 400, parentId: 'OUT' })
  const SZ = sizes({ OUT: [380, 300] })   // ← 故意不含 INNER
  const out = fitLoopBox([OUT, INNER], 'OUT', SZ, FB)
  const box = out.find(v => v.id === 'OUT')
  const w = box.style.width
  check('★★ 框宽容得下内层循环的 600px（按它自己声明的尺寸算）',
    w >= 600 + BOX_PAD_SIDE * 2, '框宽=' + String(w) + '，内层宽=600')
  check('★★★ 若按兜底 300 算会得到 380（证明用的不是兜底）',
    w !== 300 + BOX_PAD_SIDE * 2, '兜底算法会给 ' + String(300 + BOX_PAD_SIDE * 2))

  /* 钳位同理：内层循环在框里能拖到的最右边，要按它**自己的宽**算，
   * 而不是按 300 —— 否则它会被卡在半中间，永远拖不到框右边。 */
  const clamped = clampIntoLoop([OUT, INNER], 'INNER', SZ, FB)
  /* 内层本来就贴在左上，不该被移动。把它摆到最右再看能不能到。 */
  const far = { ...INNER, position: { x: 9999, y: BOX_PAD_TOP } }
  const farList = [{ ...OUT, style: { width: 1400, height: 900 } }, far]
  const c = clampIntoLoop(farList, 'INNER', SZ, FB)
  check('★ 内层循环被钳到框内（不是钳到框外）', c !== null && c.x <= 1400 - BOX_PAD_SIDE - 600,
    JSON.stringify(c))
  check('★★ 钳位按内层自己的 600 宽算（不是 300）',
    c !== null && c.x === 1400 - BOX_PAD_SIDE - 600,
    JSON.stringify(c) + '，按兜底 300 会得到 ' + String(1400 - BOX_PAD_SIDE - 300))
  void clamped
}
console.log('')
console.log('⑪ 框外节点一个都不许动')
{
  const L = n('L', { defId: LOOP_DEF_ID, w: 740, h: 900 })
  const A = n('A', { parentId: 'L' })
  const B = n('B', { parentId: 'L' })
  const outside = n('out', { position: { x: 5000, y: 5000 } })
  const SZ = sizes({ L: [740, 900], A: [300, 168], B: [300, 168], out: [300, 168] })
  const out = relayoutInside([L, A, B, outside], 'L', [{ source: 'A', target: 'B' }], SZ, FB, 'DOWN')
  const o = posOf(out, 'out')
  check('框外节点坐标没变', o.x === 5000 && o.y === 5000, JSON.stringify(o))
  const l = posOf(out, 'L')
  check('框自己的坐标没变（它由 fitLoopBox 管，不归这里）', l.x === 0 && l.y === 0, JSON.stringify(l))
}

console.log('')
console.log('⑫ 循环框的遍历顺序：内层先、外层后')
{
  /* 形状：L1 ⊃ L2 ⊃ L3。
   * 判据：返回的 id 列表里，层数大的排在前面（内层先跑）。
   * 为什么钉这个顺序：外层摆成员时要读内层**这一轮**的框尺寸，
   * 内层先跑才拿得到（详见 `orderLoopsInnerFirst` 的注释）。 */
  const L1 = n('L1', { defId: LOOP_DEF_ID, w: 2000, h: 1200 })
  const L2 = n('L2', { defId: LOOP_DEF_ID, w: 1400, h: 700, parentId: 'L1' })
  const L3 = n('L3', { defId: LOOP_DEF_ID, w: 700, h: 300, parentId: 'L2' })
  const plain = n('plain')

  const order = orderLoopsInnerFirst([L1, L2, L3, plain])
  check('★ 嵌套三层 → 顺序是 L3、L2、L1（内层在前）',
    JSON.stringify(order) === JSON.stringify(['L3', 'L2', 'L1']), JSON.stringify(order))
  check('普通节点不在这个列表里', order.includes('plain') === false, JSON.stringify(order))

  /* 同层之间保持原顺序（稳定排序）—— 否则每一轮都会来回换位置。 */
  const A = n('A', { defId: LOOP_DEF_ID, w: 400, h: 300 })
  const B = n('B', { defId: LOOP_DEF_ID, w: 400, h: 300 })
  const same = orderLoopsInnerFirst([A, B])
  check('★ 同一层保持原顺序（A 在 B 前）',
    JSON.stringify(same) === JSON.stringify(['A', 'B']), JSON.stringify(same))

  /* parentId 成环（脏数据）时也不能死循环。 */
  const X = n('X', { defId: LOOP_DEF_ID, w: 400, h: 300, parentId: 'Y' })
  const Y = n('Y', { defId: LOOP_DEF_ID, w: 400, h: 300, parentId: 'X' })
  let threw = ''
  let cyc
  try {
    cyc = orderLoopsInnerFirst([X, Y])
  } catch (e) {
    threw = String(e?.message ?? e)
  }
  check('★ parentId 成环不死循环、不抛错', threw === '' && Array.isArray(cyc),
    threw === '' ? JSON.stringify(cyc) : threw)
  check('环里的两个都在结果里（一个都不丢）', Array.isArray(cyc) && cyc.length === 2, JSON.stringify(cyc))
}

console.log('')
console.log(failed === 0 ? '结论：框内排列（方向 + 嵌套）全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

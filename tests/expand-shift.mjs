/** 展开节点时**下游让位**的测试（2026-10-16 新增）。
 *
 * 为什么必须单测：这一层出的错**构建、类型检查、界面渲染里都不报错**，
 * 只表现为「展开一下，图变成另一个样子」。三处最像「能用」的错法：
 *
 *   ① 判据写成「水平重叠」→ 左→右流水里**同一层并排**的邻居被当成被压住，
 *      于是展开一次整张图往下跑（第 ② 组盯着它）；
 *   ② 忘了带下游 → 被推的那一列与它后面接的东西相对位置乱了（第 ③ 组）；
 *   ③ 循环子节点的**相对坐标**被平移了两次 → 成员飞出框外（第 ⑥、⑧ 组）。
 *
 * 跑法：node --import <tsx> tests/expand-shift.mjs
 */
import { readFileSync } from 'node:fs'
import {
  planExpandShift, applyShift, refitLoopBox, absolutePosOf,
  settleShift, nominalHeight, SHIFT_GAP,
} from '../src/client/workbench/expand-shift.ts'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一个节点。
 * @param {string} id - id。
 * @param {number} x - x。
 * @param {number} y - y。
 * @param {string} [parentId] - 父容器。
 * @param {string} [defId] - 定义 id。
 * @param {{w:number,h:number}} [style] - 尺寸（循环框写在 style 上）。
 * @returns {object} 节点。
 */
function nd(id, x, y, parentId, defId = 'sys.code', style) {
  const n = { id, position: { x, y }, defId }
  if (parentId !== undefined) n.parentId = parentId
  if (style !== undefined) n.style = style
  return n
}

/* ── ① 基本：正下方的整列一起走 ───────────────────── */
{
  /* D 与 A 在水平方向有交叠（250..550 对 100..400），只是偏右一格。 */
  const nodes = [nd('A', 100, 100), nd('C', 100, 320), nd('D', 250, 320), nd('E', 100, 900)]
  const plan = planExpandShift(nodes, [], {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: 200 }, extra: 220,
  })
  check('正下方的两个被推', plan.ids.has('C') && plan.ids.has('D'), [...plan.ids].join(','))
  check('同一列更下面那个也被推（整列平移）', plan.ids.has('E'))
  /* 让开量 = 底边 300 + 220 - 320（最靠上那个的顶边）= 200，**再加 SHIFT_GAP**。
   * 这 40 是用户 m00631 要的那条缝：「现在偏移过后贴在一起了，加一点间隔」。 */
  check('推的量 = 让开最靠上那个 200 + 间隔 ' + String(SHIFT_GAP), plan.dy === 200 + SHIFT_GAP,
    String(plan.dy))
}

/* ── ② 判据是「垂直带子」，不是「水平重叠」 ─────────
 * 左→右流水里 A 与 B **同一层并排**。用水平重叠当判据会把 B 也判成被压住，
 * 整张图会跟着跑 —— 这一组就是盯这个的。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 500, 100)]
  const plan = planExpandShift(nodes, [], {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: 200 }, extra: 220,
  })
  check('同层并排的邻居不被误推', plan.ids.size === 0, [...plan.ids].join(','))
}

/* ── ③ 连带下游（用户选的「整条下游一起让」） ──────── */
{
  const nodes = [nd('A', 100, 100), nd('C', 100, 320), nd('F', 900, 900)]
  const edges = [{ source: 'A', target: 'C' }, { source: 'C', target: 'F' }]
  const plan = planExpandShift(nodes, edges, {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: 200 }, extra: 220,
  })
  check('被压住的那个被推', plan.ids.has('C'))
  check('它右后方的下游也一起走', plan.ids.has('F'), [...plan.ids].join(','))
  check('展开的节点自己不动', !plan.ids.has('A'))
}

/* ── ④ 环保护（循环图里的回边不能让遍历转不停） ────── */
{
  const nodes = [nd('A', 100, 100), nd('C', 100, 320), nd('D', 100, 600)]
  const edges = [
    { source: 'A', target: 'C' }, { source: 'C', target: 'D' }, { source: 'D', target: 'C' },
  ]
  const plan = planExpandShift(nodes, edges, {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: 200 }, extra: 220,
  })
  check('有环也能算完且结果有限', plan.ids.has('C') && plan.ids.has('D') && plan.dy > 0)
}

/* ── ⑤ 循环框在展开节点下方：框整体下移 ───────────── */
{
  const nodes = [
    nd('L', 100, 500, undefined, 'flow.loop', { w: 600, h: 400 }),
    nd('c1', 40, 64, 'L'),
    nd('c2', 40, 304, 'L'),
  ]
  const sizes = new Map([['L', { w: 600, h: 400 }], ['c1', { w: 300, h: 200 }], ['c2', { w: 300, h: 200 }]])
  const plan = planExpandShift(nodes, [], {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: 200 }, extra: 220, sizes,
  })
  check('循环框整体下移', plan.ids.has('L'), [...plan.ids].join(','))
  check('框里的成员不再单独下移（否则绝对坐标走两倍）', !plan.ids.has('c1') && !plan.ids.has('c2'),
    [...plan.ids].join(','))
}

/* ── ⑥ 相对坐标平移不变 ─────────────────────────── */
{
  const nodes = [
    nd('L', 0, 0, undefined, 'flow.loop', { w: 600, h: 400 }),
    nd('c1', 40, 64, 'L'),
  ]
  const plan = { ids: new Set(['L']), dy: 120 }
  const out = applyShift(nodes, plan)
  const L = out.find(n => n.id === 'L')
  const c1 = out.find(n => n.id === 'c1')
  check('循环框下移了', L.position.y === 120, String(L.position.y))
  check('子节点相对坐标不变', c1.position.x === 40 && c1.position.y === 64,
    c1.position.x + ',' + c1.position.y)
}

/* ── ⑦ 无变化时返回原数组引用（不然无限重渲染） ───── */
{
  const nodes = [nd('A', 0, 0), nd('B', 0, 500)]
  check('空计划返回原引用', applyShift(nodes, { ids: new Set(), dy: 0 }) === nodes)
  check('dy=0 也返回原引用', applyShift(nodes, { ids: new Set(['A']), dy: 0 }) === nodes)
  check('正下方空着时计划为空', planExpandShift(nodes, [], {
    id: 'A', rect: { x: 0, y: 0, w: 300, h: 200 }, extra: 0,
  }).ids.size === 0)
}

/* ── ⑧ 展开的是**框里**的节点：框不动，成员相对坐标变大 ──
 * 用户说的第二种情况。框自己顶边在展开节点上方，不在名单里 → 框不动；
 * 被压住的兄弟节点**在框内**，改的是相对坐标。 */
{
  const nodes = [
    nd('L', 0, 0, undefined, 'flow.loop', { w: 600, h: 400 }),
    nd('c1', 40, 64, 'L'),
    nd('c2', 40, 304, 'L'),
  ]
  const sizes = new Map([['L', { w: 600, h: 400 }], ['c1', { w: 300, h: 200 }], ['c2', { w: 300, h: 200 }]])
  const plan = planExpandShift(nodes, [], {
    id: 'c1', rect: { x: 40, y: 64, w: 300, h: 200 }, extra: 220, sizes,
  })
  check('框里的兄弟节点被推', plan.ids.has('c2'), [...plan.ids].join(','))
  check('框自己不动', !plan.ids.has('L'), [...plan.ids].join(','))
  const out = applyShift(nodes, plan)
  const c2 = out.find(n => n.id === 'c2')
  check('推的是它的**相对**坐标', c2.position.y === 304 + plan.dy, String(c2.position.y))
}

/* ── ⑨ 循环框按内容重算尺寸 ─────────────────────── */
{
  const nodes = [
    nd('L', 0, 0, undefined, 'flow.loop', { w: 600, h: 400 }),
    nd('c1', 40, 64, 'L'),
    nd('c2', 40, 304, 'L'),
  ]
  const sizes = new Map([['c1', { w: 300, h: 200 }], ['c2', { w: 300, h: 420 }]])
  const out = refitLoopBox(nodes, 'L', sizes, { w: 300, h: 200 })
  const L = out.find(n => n.id === 'L')
  /* 内容底边 = 0 + 304 + 420 = 724；高 = 724 - 64(顶边) + 64(上内边距) + 40(下内边距) = 764 */
  check('框随内容长高', L.style.height === 764, String(L.style.height))
  check('框的左上角对齐内容', L.position.x === 0 && L.position.y === 0,
    L.position.x + ',' + L.position.y)
  const c2 = out.find(n => n.id === 'c2')
  check('子节点相对坐标不变（原点没动）', c2.position.y === 304, String(c2.position.y))
}

/* ── ⑩ 重算幂等 ─────────────────────────────────── */
{
  const nodes = [
    nd('L', 0, 0, undefined, 'flow.loop', { w: 600, h: 400 }),
    nd('c1', 40, 64, 'L'),
  ]
  const sizes = new Map([['c1', { w: 300, h: 200 }]])
  const once = refitLoopBox(nodes, 'L', sizes, { w: 300, h: 200 })
  const twice = refitLoopBox(once, 'L', sizes, { w: 300, h: 200 })
  check('重算两次结果一样（幂等）', twice === once)
}


/* ── ⑪ 连开两个节点：回退前一个 + 让位后一个，一步接一步算 ──────────
 * 这是画布上真会发生的顺序（点开 A，再点开 B）：
 *   第 ① 拍：A 撑高 → 推 C 下来；
 *   第 ② 拍：A 收起 → C 回原位；同时 B 撑高 → 若有东西在它下面也要让。
 * 关键要求：第 ② 拍必须看到第 ① 拍之后（或回退之后）的坐标 ——
 * 否则它按还没回退的坐标算，量出来的偏移是错的（这一幕没人看得懂）。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 100, 700), nd('C', 100, 320)]
  const sizes = new Map([['A', { w: 300, h: 200 }], ['B', { w: 300, h: 200 }], ['C', { w: 300, h: 200 }]])
  const rectA = { x: 100, y: 100, w: 300, h: 200 }
  /* ① A 展开：C 被推。 */
  const p1 = planExpandShift(nodes, [], { id: 'A', rect: rectA, extra: 220, sizes })
  const after1 = applyShift(nodes, p1)
  const y1 = after1.find(n => n.id === 'C').position.y
  check('① A 展开后 C 被推下去了', y1 > 320, String(y1))
  /* ② A 收起：按记账本回退（dy 取负）。 */
  const book1 = { ids: p1.ids, dy: p1.dy }
  const after2 = applyShift(after1, { ids: book1.ids, dy: -book1.dy })
  check('② A 收起后 C 回到原处', after2.find(n => n.id === 'C').position.y === 320,
    String(after2.find(n => n.id === 'C').position.y))
  /* ③ 现在 B 展开（在 A 收起之后算）：C 已回到 320，B 的底边 900，
   *   带子 = [900, 1120) → C 不在里面，所以**没人被推**（正确）。 */
  const p3 = planExpandShift(after2, [], { id: 'B', rect: { x: 100, y: 700, w: 300, h: 200 }, extra: 220, sizes })
  check('③ B 展开（在 A 收起之后）不再误推 C', p3.ids.size === 0, [...p3.ids].join(','))
  /* 反面：如果**不先回退 A** 就直接算 B，坐标是错的 —— 用它证明「必须接着算」。 */
  const pWrong = planExpandShift(after1, [], { id: 'B', rect: { x: 100, y: 700, w: 300, h: 200 }, extra: 220, sizes })
  check('（对照）拿没回退的坐标算，B 的判据一样（说明差异在别处，这里只是记账）',
    pWrong.ids.size === 0)
}


/* ── ⑫ 「撑开后量到的高度」不能当 rect.h 用（2026-10-16 真踩过的错） ──────
 *
 * 报到发生在节点**已经长高之后**，所以量到的高度是**撑开后**的。
 * 我第一版拿它当「未展开的矩形」，又另算一个 extra ——
 * 两者相减恰好抵消（extra ≈ 0），于是**永远算出「没人被压住」**，
 * 症状是「功能完全没反应」，构建、类型检查、单测全绿。
 *
 * 这一组把两种写法**并排**钉住：错的那种必须算出空计划，对的那种必须算出来。
 * 谁把算式改回错的，这一组立刻红。 */
{
  const NOMINAL = 168
  const EDITOR_H = 220
  const MEASURED = NOMINAL + EDITOR_H   // 388：撑开后量到的
  const nodes = [nd('A', 100, 100), nd('C', 100, 380)]
  const sizes = new Map([['A', { w: 300, h: MEASURED }], ['C', { w: 300, h: NOMINAL }]])

  /* ✗ 错法：rect.h 用撑开后高度、extra 用「参数区高度 − 已经撑出来的那截」 */
  const wrongExtra = Math.max(0, EDITOR_H - (MEASURED - NOMINAL))
  const wrong = planExpandShift(nodes, [], {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: MEASURED }, extra: wrongExtra, sizes,
  })
  check('（钉住错法）把撑开后高度当 rect.h → 空计划 = 什么都不做', wrong.ids.size === 0,
    'extra=' + String(wrongExtra))

  /* ✓ 对法：rect.h 用**收起时**的高度，extra 用**长出来多少** */
  const right = planExpandShift(nodes, [], {
    id: 'A', rect: { x: 100, y: 100, w: 300, h: NOMINAL }, extra: MEASURED - NOMINAL, sizes,
  })
  check('（钉住对法）收起时高度 + 长高量 → 正下方的 C 被推', right.ids.has('C'),
    [...right.ids].join(',') + ' dy=' + String(right.dy))
}


/* ── ⑬ 用真实示例工作流的坐标走一遍（抓「算式对不对」之外的那类错） ─────
 * 样例是一串「每个都靠右下一点」的渲染值，会自动布局成一条横链。
 * 这一组把「展开其中一个、它正下方本来没人」与「有人时让位」两种都跑一遍。 */
{
  /* 自动布局后的一条横链（横向铺开、y 相同）。 */
  const chain = [nd('n1', 0, 0), nd('n2', 400, 0), nd('n3', 800, 0)]
  const sizes = new Map(chain.map(n => [n.id, { w: 300, h: 168 }]))
  /* 展开 n2，带子 = [168, 388)：n3 在 y=0（水平方向不相交），n1 在上面 → 谁都不该动。 */
  const p = planExpandShift(chain, [
    { source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' },
  ], { id: 'n2', rect: { x: 400, y: 0, w: 300, h: 168 }, extra: 220, sizes })
  check('横链上展开节点不会推走同层邻居', p.ids.size === 0, [...p.ids].join(','))

  /* 再放一个**真在下面**的节点：它该被推，而且推的是「整列」。 */
  const withBelow = [...chain, nd('d1', 400, 300), nd('d2', 400, 600)]
  const sizes2 = new Map(withBelow.map(n => [n.id, { w: 300, h: 168 }]))
  const p2 = planExpandShift(withBelow, [
    { source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' },
  ], { id: 'n2', rect: { x: 400, y: 0, w: 300, h: 168 }, extra: 220, sizes: sizes2 })
  check('正下方的整列都被推（d1 与更下面的 d2）', p2.ids.has('d1') && p2.ids.has('d2'),
    [...p2.ids].join(','))
  check('量 = 让开 d1（300+168-168=300 → dy=220+…）', p2.dy > 0, String(p2.dy))
}


/* ── ⑭ 循环框**里面**的节点展开时也要回避（2026-10-16 用户报的漏项） ──────
 *
 * 真因：循环里的节点存的是**相对框**的坐标，而画布把展开节点自己的位置
 * 直接当绝对坐标传进来 → 判据整片错位 → 永远算出「没人被压住」。
 * 症状就是「循环框里面的节点展开不会回避」，且不报错。
 *
 * 关键：**框的 y 不为 0** 才能暴露这个错（框在 0,0 时相对值与绝对值恰好相等，
 * 错了也看不出来 —— 所以这一组特意把框放在 y=500）。 */
{
  const L = nd('L', 0, 500, undefined, 'flow.loop', { w: 600, h: 400 })
  const c1 = nd('c1', 40, 64, 'L')    // 绝对 (40, 564)
  const c2 = nd('c2', 40, 304, 'L')   // 绝对 (40, 804)
  const nodes = [L, c1, c2]
  const sizes = new Map([
    ['L', { w: 600, h: 400 }], ['c1', { w: 300, h: 168 }], ['c2', { w: 300, h: 168 }],
  ])

  /* ✓ 对法：先用 absolutePosOf 把展开节点的位置换算成绝对坐标 */
  const absC1 = absolutePosOf(nodes, 'c1')
  check('absolutePosOf 把循环里的节点换算成绝对坐标', absC1.x === 40 && absC1.y === 564,
    JSON.stringify(absC1))
  const good = planExpandShift(nodes, [], {
    id: 'c1', rect: { x: absC1.x, y: absC1.y, w: 300, h: 168 }, extra: 220, sizes,
  })
  check('★ 循环框里的兄弟节点被推', good.ids.has('c2'), [...good.ids].join(','))

  /* ✗ 错法：直接拿它的**相对坐标**当绝对坐标（就是原来那个 bug） */
  const bad = planExpandShift(nodes, [], {
    id: 'c1', rect: { x: 40, y: 64, w: 300, h: 168 }, extra: 220, sizes,
  })
  check('（钉住错法）用相对坐标当绝对值 → 空计划 = 不回避', bad.ids.size === 0,
    [...bad.ids].join(','))
}

/* ── ⑮ 推循环里的成员时，改的是**相对坐标**（框不动） ─────────────── */
{
  const L = nd('L', 0, 500, undefined, 'flow.loop', { w: 600, h: 400 })
  const c1 = nd('c1', 40, 64, 'L')
  const c2 = nd('c2', 40, 304, 'L')
  const nodes = [L, c1, c2]
  const sizes = new Map([
    ['L', { w: 600, h: 400 }], ['c1', { w: 300, h: 168 }], ['c2', { w: 300, h: 168 }],
  ])
  const plan = planExpandShift(nodes, [], {
    id: 'c1', rect: { x: 40, y: 564, w: 300, h: 168 }, extra: 220, sizes,
  })
  check('框自己不在下移名单里（它顶边在上面）', !plan.ids.has('L'), [...plan.ids].join(','))
  const out = applyShift(nodes, plan)
  const outL = out.find(n => n.id === 'L')
  const outC2 = out.find(n => n.id === 'c2')
  check('框没动', outL.position.x === 0 && outL.position.y === 500, JSON.stringify(outL.position))
  check('被推的是成员的**相对**坐标', outC2.position.y === 304 + plan.dy,
    '304 → ' + String(outC2.position.y) + '（dy=' + String(plan.dy) + '）')
}

/* ── ⑯ 框里长高了 → 框要跟着长（refitLoopBox 接着跑） ─────────────── */
{
  const L = nd('L', 0, 500, undefined, 'flow.loop', { w: 600, h: 400 })
  const c1 = nd('c1', 40, 64, 'L')
  const c2 = nd('c2', 40, 452, 'L')   // 已被推到新位置
  const nodes = [L, c1, c2]
  const sizes = new Map([
    ['c1', { w: 300, h: 388 }], ['c2', { w: 300, h: 168 }],
  ])
  const out = refitLoopBox(nodes, 'L', sizes, { w: 300, h: 200 })
  const outL = out.find(n => n.id === 'L')
  /* 内容底边 = 500 + 452 + 168 = 1120；高 = 1120 - 564(顶边) + 64 + 40 = 660 */
  check('★ 框随内容长高（原来 400）', outL.style.height === 660, String(outL.style.height))
  const outC1 = out.find(n => n.id === 'c1')
  check('成员相对坐标不变（框的原点没变）', outC1.position.y === 64, String(outC1.position.y))
}

/* ── ⑰ 接线：画布必须走 settleShift，不能自己拼参数 ─────────────────
 *
 * 这一条读**画布源码**。为什么值得单独钉：算法层可以是对的，
 * 而画布传进来的东西是错的 —— 第 ⑫ 组（撑开后高度当 rect.h）与
 * 早先那次（相对坐标当绝对坐标）都是**同一类错**：参数语义没人守。
 * 两次都在界面上表现为「功能没反应」，不报错、单测全绿，所以都留一条。
 *
 * 2026-10-16 接输出面板时又变了一次：画布不再「谁展开就让谁算一次」，
 * 而是每次把**整张图重算**（settleShift），循环内相对坐标与面板高度
 * 都收在算法层。这里钉的就是「画布确实这么调」。 */
{
  const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const canvasSrc = readSrc('../src/client/workbench/WorkflowCanvas.tsx')
  const shiftSrc = readSrc('../src/client/workbench/expand-shift.ts')

  /* ① 画布必须走「全图重算」，而不是自己算一道题 ——
   *    循环内节点的相对坐标、面板高度这些前提都收在 settleShift 里。 */
  check('★ 画布走 settleShift 全图重算', canvasSrc.includes('settleShift(base, edgesRef.current, tasks, shiftRef.current, sizes)'))
  check('画布不再直接拿 target.position 当绝对坐标',
    !canvasSrc.includes('const prev = target.position'))

  /* ② 循环内节点的相对坐标由 settleShift 内部换算（画布层不做这件事，
   *    但算法层必须做 —— 上一轮那个「循环框里的节点不回避」就是它漏了）。 */
  check('★ settleShift 内部用 absolutePosOf 取每个请求的绝对位置',
    shiftSrc.includes('absolutePosOf(working, t.id)'))

  /* ③ 输出面板：必须量出来、单独扣掉，否则众数被面板带偏、让位整个失效。 */
  check('★ 画布量了输出面板高度并交给 nominalHeight 扣掉',
    canvasSrc.includes('measureRunPanels(wrap)') && canvasSrc.includes('nominalHeight(sizes, panels)'))

  /* ④ ★★ **面板高度只许扣一次**（2026-10-20 修的真 BUG）。
   *
   * ## 为什么必须有一条源码层断言
   *
   * 症状是用户观察到的「输出栏展开时别的节点自动避开，只是偶尔生效」。
   * 根因在 `runShift` 里那两行的**基准不一致**：
   *   - `nominalHeight(sizes, panels)` 内部已经按节点扣除面板 → 返回「卡片本体」的众数；
   *   - 而循环体里又写 `const cardH = h - (panels.get(n.id) ?? 0)` → 再扣一次；
   *   - 于是「只挂面板、卡片本体没长高」的节点算出 `extra = 0` → 不推开任何人。
   *
   * **算法层测不到它**（`settleShift` 收的是算好的 tasks，它不知道调用方怎么算的），
   * 所以只能在源码层盯「那两行有没有又对不齐」。
   *
   * 判据：`extra` 必须直接由实测高减去 nominal —— 中间不许再减 panels。
   * 写成「不允许出现 `cardH`」这种形态判据，比查某个表达式更抗改写。 */
  check('★★ runShift 里 extra 直接用实测高减 nominal（面板只扣一次）',
    /const extra = h - nominal/.test(canvasSrc),
    /const extra = h - nominal/.test(canvasSrc) ? '' : '没找到 `const extra = h - nominal`')
  check('★★ runShift 里不再出现「再扣一次面板」的 cardH',
    !/const cardH = h - \(panels\.get\(/.test(canvasSrc),
    /const cardH = h - \(panels\.get\(/.test(canvasSrc) ? '又出现了重复扣减' : '')
}


/* ── ⑱ settleShift：整图重算（基线 + 差值） ────────────────────────
 *
 * 这是接输出面板之后的新机制。不变量只有一条：
 *
 *   当前位置 = 基线位置 + 让位量
 *
 * 三个必须成立的性质，各一条：
 *   ① **收起自然回基线** —— 请求消失（tasks 空）就该回原处，不靠记账；
 *   ② **用户拖过的节点不被打回** —— 拖动只改位置、没改让位量，
 *      于是它被算进基线（旧「记账本」那套会把它拽回去）；
 *   ③ **幂等** —— 同样的输入算两遍结果一样（心跳每秒跑，必须稳）。 */

/* ① 面板弹出 → 推开；面板收起 → 自己回原位（不需要任何「回退」调用）。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 100, 320)]
  const sizes = new Map([['A', { w: 300, h: 168 }], ['B', { w: 300, h: 168 }]])
  const open1 = settleShift(nodes, [], [{ id: 'A', h: 168, extra: 108 }], new Map(), sizes)
  check('① 面板长出来 → B 被推开', open1.nodes.find(n => n.id === 'B').position.y > 320,
    String(open1.nodes.find(n => n.id === 'B').position.y))
  check('① A 自己不动', open1.nodes.find(n => n.id === 'A').position.y === 100)
  const back = settleShift(open1.nodes, [], [], open1.shift, sizes)
  check('① 面板收起 → B 自动回原位（不需要记账）',
    back.nodes.find(n => n.id === 'B').position.y === 320,
    String(back.nodes.find(n => n.id === 'B').position.y))
}

/* ② 用户拖动过的节点：让位必须叠在**用户给的位置**上，不能打回原处。
 *
 * 旧「记账本」那套在这里会出错：它记的是「B 从 320 被推到 416」，
 * 下一轮把 320+96 再算一遍 —— 用户拖过之后那个 320 已经不是基线了。
 * 新机制把「位置里不是让位引起的部分」留在基线上，于是两种情况都对。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 100, 320)]
  const sizes = new Map([['A', { w: 300, h: 168 }], ['B', { w: 300, h: 168 }]])
  const tasks = [{ id: 'A', h: 168, extra: 108 }]
  const r1 = settleShift(nodes, [], tasks, new Map(), sizes)
  const pushedY = r1.nodes.find(n => n.id === 'B').position.y    /* 416 */
  check('② 让位量记在 B 头上', (r1.shift.get('B') ?? 0) > 0, String(r1.shift.get('B')))

  /* (a) 只横向挪一下（y 保持被推后的值）→ 让位量不该被再加一次。 */
  const dragX = r1.nodes.map(n => n.id === 'B' ? { ...n, position: { x: 160, y: n.position.y } } : n)
  const r2 = settleShift(dragX, [], tasks, r1.shift, sizes)
  const b2 = r2.nodes.find(n => n.id === 'B')
  check('②（a）横向拖走的 x 保住', b2.position.x === 160, String(b2.position.x))
  check('②（a）y 没有二次位移（让位量只作用一次）', b2.position.y === pushedY,
    String(pushedY) + ' → ' + String(b2.position.y))

  /* (b) 再往下拖 60（拖出被压的那条带子）→ 它不再需要让位，
   *     但**用户自己那 60 要留在基线上**（结果 = 原始 320 + 60）。 */
  const dragY = r2.nodes.map(n => n.id === 'B' ? { ...n, position: { x: n.position.x, y: n.position.y + 60 } } : n)
  const r3 = settleShift(dragY, [], tasks, r2.shift, sizes)
  const b3 = r3.nodes.find(n => n.id === 'B')
  check('②（b）拖出带子后让位量归零', (r3.shift.get('B') ?? 0) === 0, String(r3.shift.get('B')))
  check('②（b）但用户那 60 **没被抹掉**（320 + 60 = 380）', b3.position.y === 380, String(b3.position.y))
}

/* ③ 幂等：同样的输入算两遍结果一样，且第二次返回**原数组引用**。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 100, 320)]
  const sizes = new Map([['A', { w: 300, h: 168 }], ['B', { w: 300, h: 168 }]])
  const tasks = [{ id: 'A', h: 168, extra: 108 }]
  const r1 = settleShift(nodes, [], tasks, new Map(), sizes)
  const r2 = settleShift(r1.nodes, [], tasks, r1.shift, sizes)
  check('③ 第二遍没有位移 → 返回原数组引用（不触发重渲染）', r2.nodes === r1.nodes)
  check('③ 让位量也稳定', (r2.shift.get('B') ?? 0) === (r1.shift.get('B') ?? 0),
    String(r2.shift.get('B')))
}

/* ④ 没有请求、也没有旧让位量 → 原样返回（心跳每秒跑，这条是省 CPU 的闸门）。 */
{
  const nodes = [nd('A', 100, 100), nd('B', 100, 320)]
  const r = settleShift(nodes, [], [], new Map())
  check('④ 什么都没发生 → 原数组引用 + 空让位量', r.nodes === nodes && r.shift.size === 0)
}

console.log('')
if (failed === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(failed) + ' 条红的')
process.exit(1)

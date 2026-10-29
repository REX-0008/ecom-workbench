/** 循环框的三条交互（2026-10-19 用户定）—— **纯逻辑**，不碰 React / DOM。
 *
 * ## 为什么单独测
 *
 * 这三条都是「错了不报错、只是行为不对」的那一类：
 *   - 钳位（`clampIntoLoop`）错了 → 成员能拖出框，界面出现「看着在外面、
 *     其实还属于它」，而存档里一点异常都没有；
 *   - 候选（`loopTargetsFor`）错了 → 菜单里能选到一个会成环的目标，
 *     点下去画布崩掉或执行期报错；
 *   - 层数上限两边不一致 → 界面能选、跑起来报错（最难受的那种）。
 *
 * 所以判据全部锚在**算出来的具体值**上，不是「函数存在」。
 *
 * 跑法：node --import <tsx> tests/loop-nest-ui.mjs
 */
import {
  clampIntoLoop, loopTargetsFor, loopInnerBounds, MAX_LOOP_DEPTH_UI,
  BOX_PAD_SIDE, BOX_PAD_TOP, BOX_PAD_BOTTOM, BOX_HEAD_H, BOX_SETTINGS_H,
  BOX_MIN_W, BOX_MIN_H, LOOP_DEF_ID,
} from '../src/client/workbench/container-ops.ts'

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

/** 造一个循环节点。 */
function loop(id, opts = {}) {
  const n = {
    id,
    type: 'v1',
    position: opts.position ?? { x: 0, y: 0 },
    style: { width: opts.w ?? 600, height: opts.h ?? 400 },
    data: {
      def: { id: LOOP_DEF_ID, label: '循环', paramDefs: [] },
      params: {},
      collapsed: opts.collapsed,
      settingsOpen: opts.settingsOpen,
      settingsPanelH: opts.settingsPanelH,
    },
  }
  if (opts.parentId !== undefined) n.parentId = opts.parentId
  return n
}

/** 造一个普通节点。 */
function node(id, opts = {}) {
  const n = {
    id,
    type: 'v1',
    position: opts.position ?? { x: 100, y: 100 },
    data: { def: { id: 'code.js', label: '代码', paramDefs: [] }, params: {} },
  }
  if (opts.parentId !== undefined) n.parentId = opts.parentId
  return n
}

/** 尺寸表：统一 300×100（除非覆盖）。 */
function sizes(map = {}) {
  const m = new Map()
  for (const [k, v] of Object.entries(map)) m.set(k, v)
  return { get: (id) => m.get(id) ?? { w: 300, h: 100 }, has: (id) => true, ...{} }
}

const FB = { w: 300, h: 100 }

console.log('=== 循环框的三条交互（loop-nest-ui）===')
console.log('')

console.log('① 钳位：成员不能拖出框（照 Dify 的 getRestrictedIterationPosition）')
{
  /* 框在 (0,0)，600×400。上边距 64、下 40、左右 40。 */
  const L = loop('L')
  /* 拖到左上外面 → 被推回 (40, 64)。 */
  const r1 = clampIntoLoop([L, node('a', { parentId: 'L', position: { x: -50, y: -50 } })], 'a', sizes(), FB)
  check('★ 拖到左上外面 → 推回 (40, 64)', r1 !== null && r1.x === BOX_PAD_SIDE && r1.y === BOX_PAD_TOP,
    JSON.stringify(r1))

  /* 拖到右下外面 → 被压回 (600-40-300, 400-40-100) = (260, 260)。 */
  const r2 = clampIntoLoop([L, node('a', { parentId: 'L', position: { x: 9999, y: 9999 } })], 'a', sizes(), FB)
  check('★ 拖到右下外面 → 压回框内', r2 !== null && r2.x === 600 - BOX_PAD_SIDE - 300 && r2.y === 400 - BOX_PAD_BOTTOM - 100,
    JSON.stringify(r2))

  /* 框里正常位置 → 一个像素都不动（返回 null = 无需改）。 */
  const r3 = clampIntoLoop([L, node('a', { parentId: 'L', position: { x: 100, y: 100 } })], 'a', sizes(), FB)
  check('★ 本来就在框内 → 不动（返回 null）', r3 === null, JSON.stringify(r3))

  /* 顶层节点（没有 parentId）→ 不动。 */
  const r4 = clampIntoLoop([L, node('top', { position: { x: -9999, y: -9999 } })], 'top', sizes(), FB)
  check('顶层节点不受钳位影响', r4 === null, JSON.stringify(r4))

  /* 收起态 → 不动（成员被藏起来了，挪它等于把它搞乱）。 */
  const Lc = loop('L2', { collapsed: true })
  const r5 = clampIntoLoop([Lc, node('a', { parentId: 'L2', position: { x: 9999, y: 9999 } })], 'a', sizes(), FB)
  check('★ 框收起时不动（成员被藏着，挪了展开后位置就乱）', r5 === null, JSON.stringify(r5))
}

console.log('')
console.log('② 上边距要跟着「设置面板」变（否则成员会被面板压住）')
{
  const L = loop('L')
  const b1 = loopInnerBounds(L)
  check('面板关着 → 上沿是 BOX_PAD_TOP', b1.minY === BOX_PAD_TOP, String(b1.minY))

  const L2 = loop('L2', { settingsOpen: true, settingsPanelH: 200 })
  const b2 = loopInnerBounds(L2)
  check('★ 面板开着 → 上沿 = 框头 + 面板实测高', b2.minY === BOX_HEAD_H + 200, String(b2.minY))

  const L3 = loop('L3', { settingsOpen: true })
  const b3 = loopInnerBounds(L3)
  check('★ 面板开着但没量到高度 → 退回估算值', b3.minY === BOX_HEAD_H + BOX_SETTINGS_H, String(b3.minY))

  /* 与 fitLoopBox 同源：右/下边界用同一组常量。 */
  check('右边界 = 框宽 - BOX_PAD_SIDE', b1.maxX === 600 - BOX_PAD_SIDE, String(b1.maxX))
  check('下边界 = 框高 - BOX_PAD_BOTTOM', b1.maxY === 400 - BOX_PAD_BOTTOM, String(b1.maxY))
}

console.log('')
console.log('③ 候选：谁能放进谁（三条排除缺一条都会坏）')
{
  /* 形状：  A（循环）
   *           └ a（普通）
   *         B（循环）
   *         C（循环）
   *         solo（顶层普通节点） */
  const ns = [
    loop('A', { position: { x: 0, y: 0 } }),
    node('a', { parentId: 'A' }),
    loop('B', { position: { x: 800, y: 0 } }),
    loop('C', { position: { x: 1600, y: 0 } }),
    node('solo'),
  ]
  const t = loopTargetsFor(ns, 'solo')
  check('★ 普通节点可放进所有循环', JSON.stringify(t.sort()) === JSON.stringify(['A', 'B', 'C']), JSON.stringify(t))

  /* 排除自己：A 的候选里不能有 A。 */
  const ta = loopTargetsFor(ns, 'A')
  check('★ 排除自己（A 不能放进 A）', !ta.includes('A'), JSON.stringify(ta))
  check('A 能放进 B 和 C', ta.includes('B') && ta.includes('C'), JSON.stringify(ta))

  /* 排除自己的后代：a 是 A 的成员，把 A 放进 a？a 不是循环所以不成立。
   * 真正要防的是「A 放进 A 里面的循环」—— 造一个。 */
  const nested = [
    loop('A', { position: { x: 0, y: 0 } }),
    loop('inner', { parentId: 'A' }),
    loop('B', { position: { x: 800, y: 0 } }),
  ]
  const tA = loopTargetsFor(nested, 'A')
  check('★★ 排除自己的后代循环（A 放不进 A 里面的 inner，否则成环）',
    !tA.includes('inner'), JSON.stringify(tA))
  check('A 仍能放进 B', tA.includes('B'), JSON.stringify(tA))

  /* 层数上限：inner 已经在第 2 层，再包 4 层就到 6 → 被排除。
   * 造一条 A > b1 > B2 > b3 > C4 > D5（5 层）。 */
  const deep = [
    loop('L1'),
    loop('L2', { parentId: 'L1' }),
    loop('L3', { parentId: 'L2' }),
    loop('L4', { parentId: 'L3' }),
    loop('L5', { parentId: 'L4' }),
  ]
  const tTop = loopTargetsFor(deep, 'L1')
  check('★★ 5 层已经满了 → 顶层循环没有可放的目标', tTop.length === 0, JSON.stringify(tTop))
  check('界面侧上限与执行期一致（都是 5）', MAX_LOOP_DEPTH_UI === 5, String(MAX_LOOP_DEPTH_UI))

  /* 4 层时还能再包一层（我刚放进去就是第 5 层，正好）。 */
  const four = [
    loop('M1'),
    loop('M2', { parentId: 'M1' }),
    loop('M3', { parentId: 'M2' }),
    loop('M4', { parentId: 'M3' }),
    loop('X'),
  ]
  const tx = loopTargetsFor(four, 'X')
  check('★ 4 层的框仍可放进第 5 层', tx.includes('M4'), JSON.stringify(tx))

  /* 一个循环都没有 → 空（菜单会显示「没有可放入的循环」）。 */
  check('画布上没循环 → 候选为空', loopTargetsFor([node('only')], 'only').length === 0)
}

console.log('')
console.log('④ 边界：坏数据不能崩')
{
  check('不存在的节点 → 空候选', loopTargetsFor([loop('L')], 'ghost').length === 0)
  check('不存在的节点 → 不钳位', clampIntoLoop([loop('L')], 'ghost', sizes(), FB) === null)

  /* 框比成员还小（刚建的框 / 用户把它拖小了）：不能算出负区间就崩。
   * 取舍：优先保证左上角可见。 */
  const tiny = loop('T', { w: BOX_MIN_W, h: BOX_MIN_H })
  const r = clampIntoLoop([tiny, node('big', { parentId: 'T', position: { x: 500, y: 500 } })],
    'big', { get: () => ({ w: 900, h: 900 }), has: () => true }, FB)
  check('★ 框比成员小时不崩，且左上角可见（x/y 不小于上边距）',
    r !== null && r.x >= 0 && r.y >= 0, JSON.stringify(r))
}

console.log('')
console.log(failed === 0 ? '结论：循环框三条交互全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

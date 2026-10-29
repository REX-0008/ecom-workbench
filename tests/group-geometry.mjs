/** 编组按参考项目重做（契约 CE，用户 m01076）。
 *
 * ## 这一批验什么（对应验收 1–8、10、11）
 *
 * 组从「一份名单」变成「`nodes` 数组里的一个真节点」。所以判据落在这几条：
 *
 *   ① 组是 `nodes` 里的一项，`type === 'group'`，有 position / width / height；
 *   ② 建组后成员的 `data.groupId` 指向组 id；
 *   ③ 拖进框 → 自动进组；拖出框 → 自动脱组；
 *   ④ 拖框改大小后 `syncGroupMembershipAfterTransform` 生效（框内的收进来、框外的被摘掉）；
 *   ⑤ 「一键收纳」按框内几何位置收；
 *   ⑥ 「适应成员」把框缩到刚好包住（内边距 36 / 顶 44）；
 *   ⑦ 「解散」删组节点 + 清成员的 `groupId`；
 *   ⑧ 几何函数各有一条单元断言；
 *   ⑩ 旧存档迁移：`groups: [{id,name,nodeIds}]` → 组节点；
 *   ⑪ 循环框不受影响（`tests/group-ops.mjs` 一条都不许红，那一条在跑套件时验）。
 *
 * ## 为什么这个文件几乎不挂 DOM
 *
 * `group-geometry.ts` 一行 React 都不 import —— 这正是它的价值：
 * 几何规则可以喂数据直接断言，不用挂画布、不用造布局（jsdom 也不做布局）。
 *
 * 跑法：node --import <tsx> tests/group-geometry.mjs
 */
import { createRequire, register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

/* 几何是纯函数，但 `EcomWorkbench.module.css` 那条桩还是要给（万一以后有件 React 的）。 */
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true, url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document

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

const g = await import('../src/client/workbench/group-geometry.ts')

/** 造一个节点（宽度高度都要给 —— 几何判定要用中心点）。 */
function n(id, x, y, w = 200, h = 100, groupId) {
  return {
    id, position: { x, y }, width: w, height: h,
    ...groupId === undefined ? { data: {} } : { data: { groupId } },
  }
}

/** 造一个组节点。 */
function grp(id, x, y, w, h, extra = {}) {
  return {
    id, type: 'group', position: { x, y }, width: w, height: h,
    data: { groupLabel: id, ...extra },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 组是 nodes 里的一项（验收 1、2）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 组是真节点、成员用 groupId 指向它 ===')
{
  /* ⚠️ 成员特意给得够大（高 300）：参考项目有**最小尺寸** 280×200，
   * 成员太小的话框会被撑到最小尺寸，内边距就量不准了。 */
  const members = [n('a', 100, 100, 200, 300), n('b', 400, 100, 200, 300)]
  const made = g.createGroupFromNodes('g-1', members, '分组 1')

  check('★★ 建出来的组是一个节点（type = group）', made.group.type === 'group',
    String(made.group.type))
  check('★★ 组节点有 position / width / height（能选中、能拖动、能缩放）',
    typeof made.group.position.x === 'number' && typeof made.group.position.y === 'number'
    && typeof made.group.width === 'number' && typeof made.group.height === 'number',
    JSON.stringify({ p: made.group.position, w: made.group.width, h: made.group.height }))
  check('★★ 建组后成员的 groupId 指向组 id',
    made.nodes.every(x => x.data?.groupId === 'g-1'),
    made.nodes.map(x => x.id + ':' + String(x.data?.groupId)).join(' / '))
  check('★ 组名进了组的 data（不是某个成员的）',
    made.group.data?.groupLabel === '分组 1', String(made.group.data?.groupLabel))

  /* 成员坐标**保持绝对**（不改成相对）—— 这是与循环框 parentId 的关键区别。 */
  const before = members.map(m => m.position.x + ',' + m.position.y).join(' ')
  const after = made.nodes.map(m => m.position.x + ',' + m.position.y).join(' ')
  check('★★ 成员的坐标保持绝对（不改相对 —— 与循环框的 parentId 是两套）',
    before === after, before + ' vs ' + after)

  /* 组框包住了成员（左右 36、顶 44、底 36）。 */
  const b = g.calculateGroupBoundsForNodes(members)
  check('★★ 框的左右各留 36（照参考项目的内边距）',
    b.x === 100 - 36, '实际 x=' + String(b.x) + '，成员最左 100')
  check('★★ 框的顶留 44（标题行要占位置，不然标题压在成员上）',
    b.y === 100 - 44, '实际 y=' + String(b.y))
  check('★ （对照）成员足够大时不会被最小尺寸 280×200 撑开',
    b.width === 200 + 400 - 100 + 72, '实际宽 ' + String(b.width))
  check('★ 框宽 = 成员跨度 + 左右内边距',
    b.width === (400 + 200) - 100 + 72, '实际 ' + String(b.width))
  check('★ 框高 = 成员高 + 顶底内边距',
    b.height === 300 + 44 + 36, '实际 ' + String(b.height))
  check('★ 空数组时给一个默认大小（不返回 NaN / Infinity）',
    g.calculateGroupBoundsForNodes([]).width === 760, String(g.calculateGroupBoundsForNodes([]).width))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 拖进 / 拖出（验收 3）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 拖进框自动进组、拖出框自动脱组 ===')
{
  const box = grp('g-1', 0, 0, 600, 400)
  /* 中心在框内（节点 200x100，中心 x=300 y=200）。 */
  const inside = n('a', 200, 150)
  /* 中心在框外。 */
  const outside = n('b', 900, 900)

  const target = g.findGroupDropTarget(new Set(['a']), [box, inside, outside])
  check('★★ 拖停在框内 → 找到那个组', target?.id === 'g-1', String(target?.id))
  const outsideTarget = g.findGroupDropTarget(new Set(['b']), [box, inside, outside])
  check('★★ 拖停在框外 → 找不到组（不该硬塞进去）', outsideTarget === null, String(outsideTarget?.id ?? 'null'))

  const snapped = g.snapNodesIntoGroup(new Set(['a']), [box, inside, outside], box)
  const a = snapped.find(x => x.id === 'a')
  check('★★ 吸附之后成员的 groupId 被设上', a?.data?.groupId === 'g-1', String(a?.data?.groupId))
  check('★ 吸附之后位置挪进了内边距以内（不留半截在外面）',
    a !== undefined && a.position.x >= box.position.x + 24 && a.position.y >= box.position.y + 24,
    JSON.stringify(a?.position))
  const b2 = snapped.find(x => x.id === 'b')
  check('★ 没被拖的那个节点一个字都没动（不是整片重排）',
    b2?.position.x === outside.position.x && b2?.data?.groupId === undefined)

  /* 拖出：框缩小之后，原来在组里的节点落到框外 → 归属被摘掉。 */
  const shrink = { ...box, width: 300, height: 200 }
  const synced = g.syncGroupMembershipAfterTransform('g-1', [
    shrink,
    n('a', 200, 150, 200, 100, 'g-1'),
    n('c', 900, 900, 200, 100, 'g-1'),
  ])
  const a3 = synced.find(x => x.id === 'a')
  const c3 = synced.find(x => x.id === 'c')
  check('★★ 拖出框之后成员的 groupId 变成 undefined（自动脱组）',
    c3?.data?.groupId === undefined, String(c3?.data?.groupId ?? 'undefined'))
  check('★ 还在框里的那个成员归属不变', a3?.data?.groupId === 'g-1', String(a3?.data?.groupId))

  /* 拖到另一个组里 → 改归另一个组（不是「清空」）。 */
  const g2 = grp('g-2', 850, 850, 400, 300)
  const moved = g.syncGroupMembershipAfterTransform('g-1', [
    shrink, g2,
    n('d', 900, 900, 200, 100, 'g-1'),
  ])
  check('★★ 被拖进**另一个**组时改归那个组（不是简单地清空）',
    moved.find(x => x.id === 'd')?.data?.groupId === 'g-2',
    String(moved.find(x => x.id === 'd')?.data?.groupId ?? 'undefined'))

  /* 组不能进组（不嵌套，照参考项目）。 */
  const nested = g.findGroupDropTarget(new Set(['g-2']), [box, g2])
  check('★★ 拖的是组本身时不会落进别的组（组不嵌套）', nested === null)
  check('★★ 组也不能把别的组当成成员', g.isNodeEnclosedInGroup(g2, box) === false)
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 改大小后同步（验收 4）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 改框大小后同步归属 ===')
{
  /* 框放大：原本在外面的节点被**收进来**。 */
  const small = grp('g-1', 0, 0, 300, 200)
  const nodes = [small, n('in', 50, 50), n('near', 320, 20)]
  const before = nodes.find(x => x.id === 'near')?.data?.groupId
  const bigger = { ...small, width: 800, height: 500 }
  const synced = g.syncGroupMembershipAfterTransform('g-1', [bigger, ...nodes.slice(1)])

  check('★ （前置）放大前那个节点不属于任何组', before === undefined)
  check('★★ 框放大后，原本在外面的节点被收进来了',
    synced.find(x => x.id === 'near')?.data?.groupId === 'g-1',
    String(synced.find(x => x.id === 'near')?.data?.groupId ?? 'undefined'))
  check('★ 一直在框里的那个归属不变',
    synced.find(x => x.id === 'in')?.data?.groupId === 'g-1')

  /* 找不到组时原样返回（不是崩、也不是清空所有人的归属）。 */
  const untouched = g.syncGroupMembershipAfterTransform('不存在的组', [n('x', 0, 0, 10, 10, 'g-9')])
  check('★ 组不存在时原样返回（不误伤归属）',
    untouched[0]?.data?.groupId === 'g-9', String(untouched[0]?.data?.groupId))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 一键收纳 / 适应成员 / 解散（验收 5、6、7）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 一键收纳、适应成员、解散 ===')
{
  const box = grp('g-1', 0, 0, 600, 400)
  const nodes = [
    box,
    n('in1', 100, 100),          // 中心 (200,150) 在框内
    n('in2', 300, 100),          // 中心 (400,150) 在框内
    n('out', 900, 900),          // 框外
  ]
  const cap = g.captureEnclosedNodesIntoGroup('g-1', nodes)
  check('★★ 一键收纳按几何位置收（收了 2 个）', cap.capturedCount === 2,
    '收了 ' + String(cap.capturedCount) + ' 个')
  check('★★ 框内的都归了这一组',
    cap.nextNodes.filter(x => x.id === 'in1' || x.id === 'in2').every(x => x.data?.groupId === 'g-1'))
  check('★ 框外的不动', cap.nextNodes.find(x => x.id === 'out')?.data?.groupId === undefined)
  check('★ 再收一次不会重复计数（已经在组里的不算「这次收的」）',
    g.captureEnclosedNodesIntoGroup('g-1', cap.nextNodes).capturedCount === 0)

  /* 适应成员：框缩到刚好包住。 */
  const loose = grp('g-1', -500, -500, 5000, 5000)
  const kids = [n('k1', 100, 100, 200, 100, 'g-1'), n('k2', 400, 100, 200, 100, 'g-1')]
  const fitted = g.fitGroupToEnclosedChildren('g-1', [loose, ...kids])
  const fb = fitted.find(x => x.id === 'g-1')
  const want = g.calculateGroupBoundsForNodes(kids)
  check('★★ 适应成员之后框刚好包住成员（内边距 36 / 顶 44）',
    fb?.position.x === want.x && fb?.position.y === want.y
    && fb?.width === want.width && fb?.height === want.height,
    JSON.stringify({ got: fb === undefined ? null : { x: fb.position.x, y: fb.position.y, w: fb.width, h: fb.height }, want }))
  check('★ 成员一个都没动（适应的是框，不是节点）',
    fitted.find(x => x.id === 'k1')?.position.x === 100)
  check('★ 组里没成员时原样返回（不把框缩成 0）',
    g.fitGroupToEnclosedChildren('g-1', [loose]).find(x => x.id === 'g-1')?.width === 5000)

  /* 解散。 */
  const un = g.ungroupCanvasGroup('g-1', [
    box,
    n('m1', 100, 100, 200, 100, 'g-1'),
    n('m2', 300, 100, 200, 100, 'g-1'),
    n('other', 900, 900, 200, 100, 'g-9'),
  ])
  check('★★ 解散之后组节点没了', un.find(x => x.id === 'g-1') === undefined)
  check('★★ 解散之后成员的 groupId 被清掉',
    un.filter(x => x.id === 'm1' || x.id === 'm2').every(x => x.data?.groupId === undefined))
  check('★ 别的组的成员不受影响',
    un.find(x => x.id === 'other')?.data?.groupId === 'g-9')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 旧存档迁移（验收 10）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 旧存档迁移：名单 → 组节点 ===')
{
  const oldNodes = [n('n1', 100, 100), n('n2', 400, 100), n('n3', 900, 900)]
  const old = g.migrateRosterGroups(oldNodes, [
    { id: 'g-1', name: '分组 1', nodeIds: ['n1', 'n2'] },
  ])
  check('★★ 旧名单里的组读出来变成组节点（1 个）', old.migrated === 1,
    '迁移了 ' + String(old.migrated) + ' 个')
  const gn = old.nodes.find(x => x.id === 'g-1')
  check('★★ 组节点有 type / position / width / height',
    gn?.type === 'group' && typeof gn.position.x === 'number' && typeof gn.width === 'number',
    JSON.stringify(gn === undefined ? null : { t: gn.type, p: gn.position, w: gn.width }))
  check('★★ 原来的成员挂上了 groupId',
    old.nodes.filter(x => x.id === 'n1' || x.id === 'n2').every(x => x.data?.groupId === 'g-1'))
  check('★★ 不在名单里的节点不挂 groupId',
    old.nodes.find(x => x.id === 'n3')?.data?.groupId === undefined)
  check('★ 组名沿用旧存档的名字',
    gn?.data?.groupLabel === '分组 1', String(gn?.data?.groupLabel))
  check('★ 组节点排在最前（渲染时在成员底下）',
    old.nodes[0]?.id === 'g-1', String(old.nodes[0]?.id))

  /* 名单里指向的节点已经不在了 → 跳过这个组，不造一个空框。 */
  const stale = g.migrateRosterGroups([n('x', 0, 0)], [
    { id: 'g-old', name: '找不到成员', nodeIds: ['已经删了的'] },
  ])
  check('★★ 名单里的节点已经不在了 → 不造空框（迁移 0 个）', stale.migrated === 0,
    String(stale.migrated))

  /* 没有旧名单时什么都不做。 */
  const none = g.migrateRosterGroups([n('y', 0, 0)], [])
  check('★ 没有旧名单时原样返回、不造框',
    none.migrated === 0 && none.nodes.length === 1 && none.nodes[0]?.type === undefined)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 收起态（框收起了，成员还在）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 收起的组 ===')
{
  const nodes = [grp('g-1', 0, 0, 400, 300, { collapsed: true }), grp('g-2', 0, 0, 400, 300)]
  const ids = g.collapsedGroupIds(nodes)
  check('★★ 认得出哪个组收起了', ids.has('g-1') && !ids.has('g-2'),
    [...ids].join(','))
  check('★ 没有收起的组时是空集合',
    g.collapsedGroupIds([grp('g-3', 0, 0, 1, 1)]).size === 0)
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log(failed === 0 ? '结论：编组几何按参考项目接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

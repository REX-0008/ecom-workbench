/** 编组**名单模型**的测试（照 n8n 的 Canvas Groups，2026-10-13 新增）。
 *
 * 为什么单独测：这个模型的关键收益是「**坐标永不被改写**」——
 * 那条如果破了，就会退回旧模型那族 bug（框跳走、贴边覆盖、相对/绝对互转错），
 * 而那些错在构建、类型检查、界面渲染里**都不报错**。
 *
 * 跑法：node --import <tsx> tests/group-roster.mjs
 */
import {
  groupBox, makeGroup, addToGroup, removeFromGroups, moveGroupBy, clampDesc,
  GROUP_DESC_MAX, ROSTER_PAD, ROSTER_PAD_TOP,
} from '../src/client/workbench/group-roster.ts'

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

/** 造一个坐标表。 */
function pos(pairs) {
  return new Map(Object.entries(pairs).map(([k, v]) => [k, { x: v[0], y: v[1] }]))
}
/** 造一个尺寸表。 */
function sizes(pairs) {
  return new Map(Object.entries(pairs).map(([k, v]) => [k, { w: v[0], h: v[1] }]))
}

console.log('=== 编组名单模型 ===')

console.log('')
console.log('① groupBox：框是**算出来的**（不写回数据 —— 这是新模型的关键）')
{
  const g = { id: 'g-1', name: '分组 1', nodeIds: ['a', 'b'] }
  const P = pos({ a: [100, 200], b: [400, 500] })
  const S = sizes({ a: [300, 200], b: [300, 200] })
  const box = groupBox(g, P, S, { w: 300, h: 200 })
  /* 框 = 成员包围盒 + 内边距。 */
  check('框的左上是「最小坐标 − 内边距」',
    box.x === 100 - ROSTER_PAD && box.y === 200 - ROSTER_PAD_TOP, JSON.stringify(box))
  check('框的右下含第二个成员', box.x + box.width === 400 + 300 + ROSTER_PAD, JSON.stringify(box))
  check('框的高度含第二个成员', box.y + box.height === 500 + 200 + ROSTER_PAD, JSON.stringify(box))

  /* 输入表**没被改**（纯函数，不许写回）。 */
  check('输入坐标表未被改动', P.get('a').x === 100 && P.get('b').y === 500)

  /* 空组 → null（不该画框）。 */
  check('空组 → null', groupBox({ id: 'g', name: 'x', nodeIds: [] }, P, S, { w: 300, h: 200 }) === null)

  /* 名单里有**已删除的 id** → 容错，只算活着的（不让一个坏 id 把框算没）。 */
  const withGhost = { id: 'g', name: 'x', nodeIds: ['a', 'ghost'] }
  const box2 = groupBox(withGhost, P, S, { w: 300, h: 200 })
  check('名单里的幽灵 id 被忽略（不把框算没）', box2 !== null && box2.x + box2.width === 100 + 300 + ROSTER_PAD,
    JSON.stringify(box2))
  check('全是幽灵 → null', groupBox({ id: 'g', name: 'x', nodeIds: ['x1', 'x2'] }, P, S, { w: 300, h: 200 }) === null)

  /* 量不到尺寸时用兜底值（不能 NaN）。 */
  const box3 = groupBox(g, P, new Map(), { w: 300, h: 200 })
  check('量不到尺寸时用兜底值', Number.isFinite(box3.width) && box3.width > 0, JSON.stringify(box3))
}

console.log('')
console.log('② makeGroup：默认名与 id 都避重（照 n8n 会自动改名）')
{
  const g1 = makeGroup([], ['a', 'b'])
  check('新组带成员', g1.nodeIds.join('') === 'ab', JSON.stringify(g1.nodeIds))
  check('id 以 g- 开头（与节点的 n- 区分）', g1.id.startsWith('g-'), g1.id)
  check('名字不为空', g1.name.trim() !== '', g1.name)

  const g2 = makeGroup([g1], ['c'])
  check('第二个组的 id 不重复', g2.id !== g1.id, g2.id + ' vs ' + g1.id)
  check('第二个组的名字不重复', g2.name !== g1.name, g2.name)
}

console.log('')
console.log('③ addToGroup：一个节点**最多属一个组**（n8n 的硬规则）')
{
  const gs = [
    { id: 'g-1', name: 'A', nodeIds: ['a', 'b'] },
    { id: 'g-2', name: 'B', nodeIds: ['c'] },
  ]
  /* 把 c 加进 g-1 → 它要**从 g-2 里摘掉**（不能同时在两个组）。 */
  const r = addToGroup(gs, 'g-1', ['c'])
  const one = r.find(g => g.id === 'g-1')
  const two = r.find(g => g.id === 'g-2')
  check('加进去的那个在目标组里', one.nodeIds.includes('c'), JSON.stringify(one.nodeIds))
  check('★ 它从原来的组里被摘掉了（一个节点只属一个组）', !two.nodeIds.includes('c'), JSON.stringify(two.nodeIds))

  /* 重复加入不产生重复项。 */
  const r2 = addToGroup(gs, 'g-1', ['a'])
  check('重复加入不产生重复项',
    r2.find(g => g.id === 'g-1').nodeIds.filter(x => x === 'a').length === 1)

  /* 无变化时返回**原数组引用**（幂等，调用方据此跳过 setState）。 */
  const same = addToGroup(gs, 'g-1', ['a', 'b'])
  check('无变化 → 原数组引用（幂等）', same === gs)

  /* 目标组不存在 → 原样返回（不崩）。 */
  check('目标组不存在 → 原样返回', addToGroup(gs, '没有这个', ['x']) === gs)
}

console.log('')
console.log('④ removeFromGroups：摘成员（空的组保留，由调用方决定删不删）')
{
  const gs = [{ id: 'g-1', name: 'A', nodeIds: ['a', 'b'] }]
  const r = removeFromGroups(gs, ['a'])
  check('摘掉了', !r[0].nodeIds.includes('a'), JSON.stringify(r[0].nodeIds))
  check('其余成员还在', r[0].nodeIds.includes('b'))
  check('无变化 → 原数组引用', removeFromGroups(gs, ['zzz']) === gs)

  /* 摘空 → 组还在（空组是合法过渡状态；要不要删由调用方定）。 */
  const empty = removeFromGroups(gs, ['a', 'b'])
  check('摘空后组还在（由调用方决定删不删）', empty.length === 1 && empty[0].nodeIds.length === 0)
}

console.log('')
console.log('⑤ moveGroupBy：拖动框 = 给成员加同一偏移（新模型唯一的代价）')
{
  const nodes = [
    { id: 'a', position: { x: 10, y: 20 } },
    { id: 'b', position: { x: 100, y: 200 } },
    { id: 'c', position: { x: 999, y: 999 } },   // 非成员
  ]
  const g = { id: 'g-1', name: 'A', nodeIds: ['a', 'b'] }
  const r = moveGroupBy(nodes, g, 50, -30)
  const a = r.find(n => n.id === 'a')
  const b = r.find(n => n.id === 'b')
  const c = r.find(n => n.id === 'c')
  check('成员按同一偏移移动', a.position.x === 60 && a.position.y === -10, JSON.stringify(a.position))
  check('第二个成员同样', b.position.x === 150 && b.position.y === 170, JSON.stringify(b.position))
  check('★ 非成员**一点不动**', c.position.x === 999 && c.position.y === 999, JSON.stringify(c.position))
  check('成员之间的相对位置不变（整体平移）', b.position.x - a.position.x === 90 && b.position.y - a.position.y === 180)
  /* 没有成员时返回原引用（幂等）。 */
  check('无成员 → 原数组引用', moveGroupBy(nodes, { id: 'g', name: 'x', nodeIds: ['zz'] }, 5, 5) === nodes)
}

console.log('')
console.log('⑥ clampDesc：描述超长**截断而不是拒绝**（照 n8n）')
{
  check('短描述原样', clampDesc('  一句话  ') === '一句话')
  check('空描述为空串', clampDesc('') === '' && clampDesc('   ') === '')
  const long = 'x'.repeat(200)
  check('超长被截断到上限', clampDesc(long).length === GROUP_DESC_MAX, String(clampDesc(long).length))
  check('上限就是 n8n 的 145', GROUP_DESC_MAX === 145, String(GROUP_DESC_MAX))
}

console.log('')
console.log(failed === 0 ? '结论：编组名单模型全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

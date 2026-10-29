/** 对齐辅助线的独立检查。
 *
 * 跑法：node --import <tsx> tests/helper-lines.mjs
 */
import { computeHelperLines } from '../src/client/workbench/helper-lines.ts'

/** 累计失败数。 */
let bad = 0

/**
 * 断言一条。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/* 拖动的节点：中心 (100, 100)，左上角 (0, 0) */
const me = { id: 'me', centerX: 100, centerY: 100 }

console.log('① 完全对齐 → 两条线')
let r = computeHelperLines(me, [{ id: 'a', centerX: 100, centerY: 100 }], { x: 0, y: 0 })
check('两条线都出现', r.lines.length === 2, JSON.stringify(r.lines))
check('有竖线（对齐 x）', r.lines.some(l => l.type === 'vertical' && l.position === 100))
check('有横线（对齐 y）', r.lines.some(l => l.type === 'horizontal' && l.position === 100))
check('didSnap 为真', r.didSnap === true)
check('吸附后位置不变（本来就对齐）', r.snapped.x === 0 && r.snapped.y === 0)

console.log('② 差 3px（阈值内）→ 吸附过去')
r = computeHelperLines(me, [{ id: 'a', centerX: 103, centerY: 100 }], { x: 0, y: 0 })
check('出现竖线', r.lines.some(l => l.type === 'vertical'), JSON.stringify(r.lines))
check('吸附后 x 偏移 +3', r.snapped.x === 3, String(r.snapped.x))

console.log('③ 两个方向都超出阈值 → 不吸附、无线')
/* 注意两个方向都要拉开：只拉开 x 的话，y 恰好相等仍会对齐出一条横线。 */
r = computeHelperLines(me, [{ id: 'a', centerX: 120, centerY: 130 }], { x: 0, y: 0 })
check('没有线', r.lines.length === 0, JSON.stringify(r.lines))
check('didSnap 为假', r.didSnap === false)
check('位置不变', r.snapped.x === 0 && r.snapped.y === 0)

console.log('③b 只有一个方向超出 → 只吸附那个方向')
r = computeHelperLines(me, [{ id: 'a', centerX: 120, centerY: 100 }], { x: 0, y: 0 })
check('只出横线（y 对齐）', r.lines.length === 1 && r.lines[0].type === 'horizontal', JSON.stringify(r.lines))
check('x 不被吸走', r.snapped.x === 0 && r.snapped.y === 0)

console.log('④ 不跟自己对齐')
r = computeHelperLines(me, [me], { x: 0, y: 0 })
check('自己不算 → 无线', r.lines.length === 0)

console.log('⑤ 多个候选时取最近的')
r = computeHelperLines(me, [
  { id: 'a', centerX: 104, centerY: 100 },
  { id: 'b', centerX: 101, centerY: 100 },
], { x: 0, y: 0 })
check('吸附到更近的那个（101）', r.snapped.x === 1, String(r.snapped.x))

console.log('⑥ 空候选不崩')
r = computeHelperLines(me, [], { x: 5, y: 7 })
check('无线、位置原样', r.lines.length === 0 && r.snapped.x === 5 && r.snapped.y === 7)

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)

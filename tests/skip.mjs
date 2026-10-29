/** 跳过节点语义的独立检查。
 *
 * 跑法：node --import <tsx> tests/skip.mjs
 */
import { passthroughOf, nextSkipValue } from '../src/workflow/skip.ts'

let bad = 0
/** 断言一条。 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

console.log('① 跳过时下游该拿到什么（关键语义）')
check('无上游 → undefined', passthroughOf([]) === undefined)
check('一个上游 → 原样', passthroughOf(['数据']) === '数据')
check('多个上游 → 数组', JSON.stringify(passthroughOf([1, 2])) === '[1,2]')
check('对象原样（不丢结构）', JSON.stringify(passthroughOf([{ a: 1 }])) === '{"a":1}')

console.log('② 一键全跳 / 一键全恢复的规则')
check('全都没跳 → 设为跳过', nextSkipValue([false, false]) === true)
check('只要有一个没跳 → 设为跳过', nextSkipValue([true, false]) === true)
check('全都跳了 → 恢复', nextSkipValue([true, true]) === false)
check('单个未跳 → 设为跳过', nextSkipValue([false]) === true)
check('单个已跳 → 恢复', nextSkipValue([true]) === false)

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)

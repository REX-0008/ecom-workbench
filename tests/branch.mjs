/** 分支约定的纯逻辑测试（不需要派发器）。
 *
 * 判据是「谁的输出活」+「接在哪条边上才算数」。
 * 这两件事错了会让**整条分支下游静默不跑**（比报错难查）。
 *
 * 跑法：node --import <tsx> tests/branch.mjs
 */
import { liveHandles, edgeIsLive, evaluateCondition, BRANCH_KEY } from '../src/workflow/branch.ts'

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

/** 一个两出口的定义（条件判断的形状）。 */
const IF_DEF = {
  id: 'flow.if', label: '条件判断', executor: 'builtin',
  inputs: [{ id: 'in', label: '入', type: 'any' }],
  outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }],
}
/** 一个单出口的定义（普通节点）。 */
const PLAIN_DEF = {
  id: 'code.js', label: '代码', executor: 'builtin',
  inputs: [], outputs: [{ id: 'out', label: '出', type: 'any' }],
}

console.log('=== 分支约定（branch.ts）===')

console.log('① liveHandles：认「哪个出口活着」')
{
  check('带 __handle=true → 只 true 活', JSON.stringify(liveHandles({ [BRANCH_KEY]: 'true', value: 1 }, IF_DEF)) === '["true"]')
  check('带 __handle=false → 只 false 活', JSON.stringify(liveHandles({ [BRANCH_KEY]: 'false' }, IF_DEF)) === '["false"]')
  check('没有 __handle → 全部出口活（返回 null）', liveHandles({ value: 1 }, IF_DEF) === null)
  check('输出不是对象 → 全部活', liveHandles('一段文本', IF_DEF) === null)
  check('输出是 null → 全部活', liveHandles(null, IF_DEF) === null)
  check('普通单出口节点 → 全部活', liveHandles({ x: 1 }, PLAIN_DEF) === null)

  /* ⚠️ 报了一个不存在的出口名 → 视为「没有分支信息」而不是「一个都不活」。
   * 后者会让下游**永远静默不跑**，比报错难查得多。 */
  check('报不存在的出口名 → 全部活（不静默掐死下游）',
    liveHandles({ [BRANCH_KEY]: 'no.such.handle' }, IF_DEF) === null,
    JSON.stringify(liveHandles({ [BRANCH_KEY]: 'no.such.handle' }, IF_DEF)))
  check('出口名不是字符串 → 全部活', liveHandles({ [BRANCH_KEY]: 123 }, IF_DEF) === null)
  check('出口名是空串 → 全部活', liveHandles({ [BRANCH_KEY]: '' }, IF_DEF) === null)
}

console.log('')
console.log('② edgeIsLive：这条边算不算数')
{
  check('全活时任何边都活', edgeIsLive('false', null) === true && edgeIsLive(undefined, null) === true)
  check('只走 true → 接 true 的边活', edgeIsLive('true', ['true']) === true)
  check('只走 true → 接 false 的边死', edgeIsLive('false', ['true']) === false)
  check('只走 false → 接 false 的边活', edgeIsLive('false', ['false']) === true)
  /* 没写 handle 的边接在单出口节点上 —— 那是唯一出口，算活。 */
  check('没写 handle 且有活出口 → 活', edgeIsLive(undefined, ['true']) === true)
}

console.log('')
console.log('③ evaluateCondition：真值判定')
{
  check('true 表达式', evaluateCondition('input > 10', 20) === true)
  check('false 表达式', evaluateCondition('input > 10', 5) === false)
  check('字符串真值', evaluateCondition('input === "ok"', 'ok') === true)
  check('对象字段取值', evaluateCondition('input.count >= 2', { count: 3 }) === true)
  check('数组用 length', evaluateCondition('input.length > 0', [1]) === true)

  /* 空数组判假：这是采集里最常见的意图（「抓到 0 条就不继续」），
   * 而 `[]` 在 JS 里是**真值** —— 不特殊处理的话用户写 `input` 会悄悄反了。 */
  check('空数组判假（照采集的直觉）', evaluateCondition('input', []) === false)
  check('非空数组判真', evaluateCondition('input', [1]) === true)
  check('0 判假', evaluateCondition('input', 0) === false)
  check('空串判假', evaluateCondition('input', '') === false)
  check('null 判假', evaluateCondition('input', null) === false)
  check('非空对象判真', evaluateCondition('input', { a: 1 }) === true)

  /* 报错路径：空表达式与语法错都要抛，让节点按失败策略处理（不能静默当成 false）。
   * ⚠️ **要断言「为什么抛」，不能只断言「抛了」**：
   * 空白串本身就是 JS 语法错，`new Function` 也会抛 ——
   * 于是「删掉空表达式检查」照样通过（实测过，是假绿）。 */
  let msg = ''
  try { evaluateCondition('   ', 1) } catch (e) { msg = String(e?.message ?? e) }
  check('空表达式抛错、且是「没填」那条原因', msg.includes('没填判断条件'), msg || '(没抛)')
  msg = ''
  try { evaluateCondition('input ===', 1) } catch (e) { msg = String(e?.message ?? e) }
  check('语法错抛错', msg !== '', msg || '(没抛)')
}

console.log('')
console.log(failed === 0 ? '结论：分支约定全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

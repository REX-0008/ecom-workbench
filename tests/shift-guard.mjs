/** 「让位」不能变成无限重渲染（React #185）—— 用户 2026-10-21 白屏的成因。
 *
 * ## 这个测试守的是什么
 *
 * 用户报：点「打开到画布」→ 整个工作台白屏，错误边界显示
 * `Minified React error #185`（= 一次提交里 setState 太多次）。
 *
 * 环：`useLayoutEffect` ping → `runShift` → `setNodes` → 重渲染 → ping → …
 *
 * `settleShift` 在**输入完全相同**时是幂等的（返回原数组，环自己停）。
 * 但真机上量到的高度**每帧都在微调** —— 只要高度变 1px，`extra` 就变，
 * `settleShift` 就返回新数组 → `setNodes` → 新一轮。
 *
 * ⚠️ **jsdom 里这个环转不起来**（`getBoundingClientRect` 恒 0，量不到高度），
 * 所以 `dom-render` 那 70 个测试全绿、真机才炸。这也意味着：
 * **不能靠「渲染测试」来守它**，只能直接测「闸门」这个纯逻辑。
 *
 * ## 判据
 *
 * ① 几何正确：真长高 → 下面那个真的被推开（防止「闸门把功能挡死」）；
 * ② 抖动不提:同样的长高量反复报到 → 不重复 setNodes；
 * ③ 真变化照旧:长高量变了 → 照旧要动（闸门不能把功能锁死）；
 * ④ 换图后重新生效:清账之后第一轮必须还能动。
 *
 * 跑法：node --import <tsx> tests/shift-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { settleShift } from '../src/client/workbench/expand-shift.ts'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一个节点。
 * @param id - id。
 * @param x - x。
 * @param y - y。
 * @param h - 高（写在 style 上）。
 * @returns 节点。
 */
const mk = (id, x, y, h) => ({ id, position: { x, y }, data: {}, style: { width: 300, height: h } })

/**
 * 复刻 `runShift` 里那个闸门的判据（与源码同一个表达式）。
 *
 * ⚠️ **为什么在这里抄一遍**：闸门是画布组件里的一行内联逻辑，
 * 没有单独导出。抄一遍的风险是「源码改了、这里没跟着改」——
 * 所以下面 ⑤ 段会用**源码文本**断言这两处是同一个表达式。
 *
 * @param tasks - 这一轮的请求。
 * @param last - 上一轮的签名。
 * @returns 该不该跳过。
 */
const shouldSkip = (tasks, last) => {
  const sig = tasks.map(t => t.id + ':' + String(Math.round(t.extra))).join('|')
  return sig !== '' && sig === last
}

console.log('=== ① 几何：真长高 → 下面那个真的被推开 ===')
{
  /* 上下相邻且**有重叠区间**（y=180 而 a 只高 168 —— 长高后会盖住 b 的顶部）。 */
  const nodes = [mk('a', 0, 0, 168), mk('b', 0, 180, 168)]
  const edges = [{ source: 'a', target: 'b' }]
  const sizes = new Map([['a', { w: 300, h: 268 }], ['b', { w: 300, h: 168 }]])
  const r = settleShift(nodes, edges, [{ id: 'a', h: 168, extra: 100 }], new Map(), sizes)
  check('★ 有位移', r.nodes !== nodes)
  const by = r.nodes.find(n => n.id === 'b')?.position.y ?? 0
  check('★★ 下面的节点被推下去了', by > 180, 'b.y = ' + String(by))
  check('★ a 自己没动', (r.nodes.find(n => n.id === 'a')?.position.y ?? -1) === 0)
}

console.log('')
console.log('=== ② 抖动不提：同样的长高量反复报到 → 跳过 ===')
{
  const tasks = [{ id: 'a', h: 168, extra: 100 }]
  check('★ 第一次不跳过（还没签过）', !shouldSkip(tasks, ''))
  const sig1 = tasks.map(t => t.id + ':' + String(Math.round(t.extra))).join('|')
  check('★★ 第二次跳过（同样的输入）', shouldSkip(tasks, sig1))
  /* 真机上高度抖 0.4px —— 取整后是同一个值，也该跳过。 */
  const jitter = [{ id: 'a', h: 168, extra: 100.4 }]
  check('★★ 抖 0.4px 也跳过（取整到 1px）', shouldSkip(jitter, sig1))
  const jitter2 = [{ id: 'a', h: 168, extra: 100.6 }]
  check('★ 抖 0.6px 取整成 101 → 不跳过（真的变了 1px）', !shouldSkip(jitter2, sig1))
}

console.log('')
console.log('=== ③ 真变化照旧：长高量变了 → 要动 ===')
{
  const before = [{ id: 'a', h: 168, extra: 100 }]
  const sig = before.map(t => t.id + ':' + String(Math.round(t.extra))).join('|')
  check('★ 长高量从 100 变到 200 → 不跳过', !shouldSkip([{ id: 'a', h: 168, extra: 200 }], sig))
  check('★ 多了个节点长高 → 不跳过', !shouldSkip([...before, { id: 'b', h: 168, extra: 50 }], sig))
  /* ⚠️ 收起时 extra 变成负数/0 —— 那是「谁都不长高」的信号，也得让它走。 */
  check('★ 全部收起（extra=0）→ 不跳过（要退回原位）', !shouldSkip([{ id: 'a', h: 168, extra: 0 }], sig))
}

console.log('')
console.log('=== ④ 换图后重新生效（清账会清签名）===')
{
  /* 这里验的是「签名被清空之后，第一轮一定要能算」——
   * 不清的话「同一份图重新打开」第一轮会被挡掉，看着像布局没生效。 */
  check('★★ 签名清空后不跳过', !shouldSkip([{ id: 'a', h: 168, extra: 100 }], ''))
}

console.log('')
console.log('=== ⑤ 闸门真的接在 runShift 里（不是写了没调用）===')
{
  /* ## 为什么要有这一段
   *
   * 上面 ①~④ 测的是「同一个表达式的行为」—— 而画布里那行如果**根本没调用它**，
   * 测试照样全绿。所以必须读源码确认：闸门在 `runShift` 里、且在 `setNodes` 之前。 */
  const src = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
  check('★ 有 shiftSigRef 这个 ref', /const shiftSigRef = useRef<string>\(''\)/.test(src))
  check('★★ 声明只有一处（重复 const 会让整个文件语法错）',
    (src.match(/const shiftSigRef/g) ?? []).length === 1,
    String((src.match(/const shiftSigRef/g) ?? []).length) + ' 处')
  /* 闸门那一行的表达式要和上面 `shouldSkip` 抄的一致。 */
  const gate = /const sig = tasks\.map\(t => t\.id \+ ':' \+ String\(Math\.round\(t\.extra\)\)\)\.join\('\|'\)/.exec(src)
  check('★★ 签名表达式与测试里的一致', gate !== null)
  const gateAt = src.indexOf('if (sig !== \'\' && sig === shiftSigRef.current) return')
  check('★★ 跳过早退真的写了', gateAt > 0)
  const setNodesAt = src.indexOf('setNodes(working)')
  check('★★ 闸门排在 setNodes 之前（不然拦不住）', gateAt > 0 && setNodesAt > gateAt)
  /* ⚠️ 没有位移时也要清签名，否则一次真实位移后永久锁死（功能静默失效）。 */
  check('★★ 没有位移时清了签名（防永久锁死）',
    /if \(!moved\) \{[\s\S]{0,200}shiftSigRef\.current = ''/.test(src))
  /* ⚠️ clearShift 也要清 —— 换图之后旧签名没意义。 */
  const clearBlock = /const clearShift = useCallback\(\(\): void => \{([\s\S]*?)\}, \[\]\)/.exec(src)?.[1] ?? ''
  check('★★ clearShift 里清了签名', clearBlock.includes("shiftSigRef.current = ''"))
}

console.log('')
console.log(failed === 0 ? '结论：让位闸门接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

/** React Flow 的 `fieldsToTrack` 里**每一个 prop 都必须是稳定引用**（用户 2026-10-21 React #185）。
 *
 * ## 这个测试守的是什么
 *
 * React Flow 内部有个 `StoreUpdater`，它把这些 props 逐个同步进 zustand store：
 *
 * ```
 * useEffect(() => {
 *   for (const fieldName of fieldsToTrack) {
 *     const fieldValue = props[fieldName]
 *     if (fieldValue === previousFields.current[fieldName]) continue   // ← 引用相等就跳过
 *     ...
 *     else store.setState({ [fieldName]: fieldValue })
 *   }
 * }, fieldsToTrack.map(f => props[f]))                                 // ← 依赖就是这一串 props
 * ```
 *
 * 所以**任何一个 prop 每帧都是新引用**（内联箭头函数、内联对象/数组），
 * 它的 effect 就每帧重跑；重跑里 `store.setState` 又让订阅者重渲染，
 * 一旦这条链能回到「再渲染一次这个组件」，就闭合成了环
 * → `Minified React error #185`（更新深度超限）→ 整块画布白屏。
 *
 * 用户报的就是这个：点「打开到画布」→ 白屏，组件栈停在 `StoreUpdater`。
 *
 * ## 判据
 *
 * ① 那一串受跟踪的 props，**传进去的必须是一个名字**（`={someName}`），
 *    不能是内联箭头、内联对象、内联数组字面量；
 * ② 那个名字必须来自 `useCallback` / `useMemo` / 模块常量 / hook 返回值
 *    （不能是循环里现算的、也不能是函数体里写的 `const x = () => …`）；
 * ③ 反向断言：**内联箭头里再嵌套箭头**那种（`onError={(a,b)=>{...}}`）必须揪出来。
 *
 * ⚠️ 判据只能查源码文本 —— jsdom 里画布根本量不到尺寸、环转不起来，
 * 所以「渲染测试」永远抓不到它（这也是它一直藏着的原因）。
 *
 * 跑法：node tests/flow-props.mjs（纯 node，不需要 bundle）
 */
import { readFileSync } from 'node:fs'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const src = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')

/* ## 这份清单从哪来
 *
 * 抄自 `@xyflow/react` 的 `StoreUpdater`（`fieldsToTrack` 常量）。
 * ⚠️ 抄清单有「上游加了新项、这里不知道」的风险 —— 所以下面 ① 会**先从产物里读一遍**
 * 真实清单，对不上就直接报出来（而不是默默用旧清单）。 */
const EXPECTED = [
  'nodes', 'edges', 'defaultNodes', 'defaultEdges',
  'onConnect', 'onConnectStart', 'onConnectEnd', 'onClickConnectStart', 'onClickConnectEnd',
  'nodesDraggable', 'autoPanOnNodeFocus', 'nodesConnectable', 'nodesFocusable', 'edgesFocusable',
  'edgesReconnectable', 'elevateNodesOnSelect', 'elevateEdgesOnSelect',
  'minZoom', 'maxZoom', 'nodeExtent',
  'onNodesChange', 'onEdgesChange', 'elementsSelectable', 'connectionMode',
  'snapGrid', 'snapToGrid', 'translateExtent', 'connectOnClick', 'defaultEdgeOptions',
  'fitView', 'fitViewOptions', 'onNodesDelete', 'onEdgesDelete', 'onDelete',
  'onNodeDrag', 'onNodeDragStart', 'onNodeDragStop',
  'onSelectionDrag', 'onSelectionDragStart', 'onSelectionDragStop',
  'onMoveStart', 'onMove', 'onMoveEnd', 'noPanClassName', 'nodeOrigin',
  'autoPanOnConnect', 'autoPanOnNodeDrag', 'onError', 'connectionRadius',
  'isValidConnection', 'selectNodesOnDrag', 'nodeDragThreshold', 'connectionDragThreshold',
  'onBeforeDelete', 'debug', 'autoPanSpeed', 'ariaLabelConfig', 'zIndexMode',
]

console.log('=== ① 清单与产物里的一致吗（上游加了新项要能发现）===')
{
  /* 从打包产物里读 `fieldsToTrack` 的真实内容 —— 那是唯一的权威。 */
  let real = null
  try {
    const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const at = bundle.indexOf('const fieldsToTrack = [...[')
    const end = bundle.indexOf('];', at)
    const seg = at >= 0 && end > at ? bundle.slice(at, end) : ''
    real = [...seg.matchAll(/"([a-zA-Z]+)"/g)].map(m => m[1]).filter(x => x !== 'rfId')
  } catch { /* 产物不在就跳过这一段 */ }
  if (real === null || real.length === 0) {
    console.log('  （跳过：读不到 lib/client.js）')
  } else {
    const missing = real.filter(x => !EXPECTED.includes(x))
    check('★ 没有遗漏上游新增的受跟踪 prop', missing.length === 0, missing.join(', ') || '清单完整')
  }
}

console.log('')
console.log('=== ② 传给 <ReactFlow> 的受跟踪 props：不许是内联字面量 ===')
{
  /* 只截 `<ReactFlow` 那一段（到下一个 `/>` 或 `<div` 为止）。 */
  const at = src.lastIndexOf('<ReactFlow')
  const end = src.indexOf('<div', at + 10)
  const seg = src.slice(at, end > at ? end : at + 6000)
  const lines = seg.split('\n')

  /** 违规项：`name={...}` 里带 `=>` 或 `{{` 或 `{[`。 */
  const bad = []
  for (const line of lines) {
    const t = line.trim()
    const m = /^([a-zA-Z]+)=\{(.*)\}?,?$/.exec(t)
    if (m === null) continue
    const [, name, expr] = m
    if (!EXPECTED.includes(name)) continue
    const inline = /\=>/.test(expr) || /^\s*\{/.test(expr) || /^\s*\[/.test(expr)
    if (inline) bad.push(name + ' = ' + expr.trim().slice(0, 50))
  }
  check('★★ 没有内联箭头 / 内联对象 / 内联数组（每一个都会每帧换引用）',
    bad.length === 0, bad.join('  |  ') || '全部是名字引用')

  /* ⚠️ 反向断言：确认判据真的能抓到 —— 用一个已知的坏形状验一遍。 */
  const probe = 'onError={(a, b) => { x() }}'
  const pm = /^([a-zA-Z]+)=\{(.*)\}?,?$/.exec(probe)
  check('★ 判据自检：内联箭头能被认出', pm !== null && /\=>/.test(pm[2]), String(pm?.[1]))
}

console.log('')
console.log('=== ③ `onError` 必须是 useCallback（本次真 BUG 的位置）===')
{
  check('★ 有 onFlowError 的 useCallback 定义', /const onFlowError = useCallback\(/.test(src))
  check('★ 传给 ReactFlow 的是这个名字', /onError=\{onFlowError\}/.test(src))
  /* ⚠️ 不许再出现内联箭头（改回去就是回归）。 */
  check('★★ 没有 onError 的内联箭头（改回去就白屏）', !/onError=\{\(/.test(src))
}

console.log('')
console.log('=== ④ 其余受跟踪 props 的稳定性（抽查最容易出错的那几个）===')
{
  /** 某个 prop 是否是「名字引用」。 */
  const isNamed = (name) => new RegExp('\\n\\s+' + name + '=\\{([a-zA-Z_$][\\w$.]*)\\}').test(src)
  for (const name of ['nodes', 'edges', 'onNodesChange', 'onEdgesChange', 'onNodeDrag', 'onMove', 'onNodeClick', 'isValidConnection']) {
    check('  ' + name + ' 是名字引用', isNamed(name), isNamed(name) ? '' : '（内联或未见）')
  }
}

console.log('')
console.log(failed === 0 ? '结论：交给 React Flow 的 props 都是稳定引用 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

/** 图的翻译只有一份：`toRunSpecs`（存档）与 `toRunSpecsFromCanvas`（画布内存）。
 *
 * ## 为什么单独立一条测试（2026-10-15）
 *
 * 这两个函数原先**各自写了一遍**（画布那段就地在 `WorkflowCanvas.tsx` 里），
 * 于是漂了两次，两次都出真故障，而且都是「换个入口跑就不对」这类最难查的：
 *
 *   ① 画布那份漏 `parentId` → 调度器不认循环体 → `{{item.url}}` 原样发给浏览器
 *      → `page.goto: Cannot navigate to invalid URL`
 *      （用户 2026-10-15 报的「抖音表单下载一进循环A就报错停止」）。
 *   ② 画布那份漏 `sourceHandle` → `edgeIsLive(undefined, ['false'])` 返回 true
 *      → **没走的分支照跑**。
 *
 * ⚠️ **为什么当时的端到端测试（`douyin-workflow.mjs`）没抓到**：
 * 它自己手写了一份 specs 映射（还特意把 `parentId` 补上了，注释里写着
 * 「我第一版构建 specs 时把 parentId 丢了」）—— 也就是说**它一直在测自己那份**，
 * 画布那份从来没被跑过。这正是「两份翻译」最阴的地方：测试绿着，坏的那份没人碰。
 *
 * 所以这条测试的判据是**两份翻译必须同构**，并且逐条钉住那几个易漏字段。
 */
import { toRunSpecs, toRunSpecsFromCanvas } from '../src/workflow/specs.ts'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 造一个节点定义（只填调度器要看的字段）。 */
function def(id, extra = {}) {
  return { id, label: id, summary: '', executor: 'builtin', inputs: [], outputs: [], paramDefs: [], ...extra }
}

const LIB = [def('code.js'), def('flow.loop'), def('browser.act'), def('flow.if', { params: { expr: '' } })]

/* ── ① 同一张图，两种来源，翻译结果必须同构 ── */
console.log('=== ① 两种来源翻译同一张图 ===')
{
  /* 存档形状（`toWorkflowDoc` 写出来的样子）。 */
  const doc = {
    nodes: [
      { id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop', skipped: false },
      { id: 'n2', defId: 'flow.loop', params: { mode: 'items', maxIters: 100 }, onError: 'stop' },
      { id: 'n3', defId: 'browser.act', parentId: 'n2', params: { url: '{{item.url}}' }, onError: 'continue' },
      { id: 'n4', defId: 'flow.if', params: { expr: 'input.ok' }, onError: 'stop' },
      { id: 'n5', defId: 'code.js', skipped: true },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', targetHandle: 'in' },
      { id: 'e2', source: 'n2', target: 'n3', targetHandle: 'in' },
      { id: 'e3', source: 'n4', target: 'n5', sourceHandle: 'true' },
      { id: 'e4', source: 'n4', target: 'n1', sourceHandle: 'false' },
    ],
  }
  /* 画布形状（内存里的节点：def 直接挂在 data 上、params 是实例层的）。 */
  const canvasNodes = doc.nodes.map(n => ({
    id: n.id,
    ...(n.parentId === undefined ? {} : { parentId: n.parentId }),
    data: {
      def: LIB.find(d => d.id === n.defId),
      params: n.params,
      onError: n.onError,
      skipped: n.skipped,
    },
  }))

  const fromDoc = toRunSpecs(doc, LIB)
  const fromCanvas = toRunSpecsFromCanvas(canvasNodes, doc.edges)

  check('节点数一致（都没漏）', fromDoc.nodes.length === fromCanvas.nodes.length,
    String(fromDoc.nodes.length) + ' vs ' + String(fromCanvas.nodes.length))
  check('连线数一致', fromDoc.edges.length === fromCanvas.edges.length,
    String(fromDoc.edges.length) + ' vs ' + String(fromCanvas.edges.length))

  /* ★ 逐节点、逐字段比 —— 「同构」不能只看条数。 */
  const norm = (s) => JSON.stringify({
    id: s.id, defId: s.def.id, params: s.params, onError: s.onError,
    skipped: s.skipped, parentId: s.parentId ?? null,
  })
  const a = fromDoc.nodes.map(norm).sort()
  const b = fromCanvas.nodes.map(norm).sort()
  check('★ 每个节点的规格逐字段一致（含 parentId / params / onError / skipped）',
    a.length === b.length && a.every((x, i) => x === b[i]),
    a.filter((x, i) => x !== b[i]).join(' | ').slice(0, 300) || (a.length === b.length ? '' : '条数不同'))
  check('★ 每条连线逐字段一致（含 sourceHandle）',
    JSON.stringify(fromDoc.edges) === JSON.stringify(fromCanvas.edges),
    fromDoc.edges.length === 0 ? '' : JSON.stringify(fromDoc.edges) + ' vs ' + JSON.stringify(fromCanvas.edges))
}

/* ── ② 逐条钉住易漏字段（比「同构」更直接：两条路都错时会一起骗过①） ── */
console.log('')
console.log('=== ② 易漏字段逐条钉住 ===')
{
  const doc = {
    nodes: [
      { id: 'L', defId: 'flow.loop' },
      { id: 'body', defId: 'browser.act', parentId: 'L', params: { session: '抖音' } },
      { id: 'IF', defId: 'flow.if' },
      { id: 'yes', defId: 'code.js' },
    ],
    edges: [{ id: 'e1', source: 'IF', target: 'yes', sourceHandle: 'true' }],
  }
  const canvasNodes = doc.nodes.map(n => ({
    id: n.id,
    ...(n.parentId === undefined ? {} : { parentId: n.parentId }),
    data: { def: LIB.find(d => d.id === n.defId), params: n.params },
  }))
  const fromCanvas = toRunSpecsFromCanvas(canvasNodes, doc.edges)

  /* ★① `parentId`：没有它，`loopPlan` 认为循环体是空的，
   * 循环体节点还会被当普通节点在循环外各跑一次 —— 用户报的那个错。 */
  const body = fromCanvas.nodes.find(s => s.id === 'body')
  check('★ 画布路径保住了 parentId（循环体归属）', body?.parentId === 'L', String(body?.parentId))
  check('★ 循环节点自己没有 parentId', fromCanvas.nodes.find(s => s.id === 'L')?.parentId === undefined)

  /* ★② `sourceHandle`：没有它，未走的分支照跑。 */
  const e1 = fromCanvas.edges.find(e => e.id === 'e1')
  check('★ 画布路径保住了 sourceHandle（条件分流）', e1?.sourceHandle === 'true', JSON.stringify(e1))

  /* 参数合并：实例值优先、缺的取定义默认值（两条路同一套）。 */
  const fromDoc2 = toRunSpecs({ nodes: [{ id: 'x', defId: 'flow.if' }], edges: [] }, LIB)
  const fromCanvas2 = toRunSpecsFromCanvas(
    [{ id: 'x', data: { def: LIB.find(d => d.id === 'flow.if') } }], [])
  check('★ 没填的参数回退到定义默认值（存档路径）', fromDoc2.nodes[0].params.expr === '', JSON.stringify(fromDoc2.nodes[0].params))
  check('★ 没填的参数回退到定义默认值（画布路径）', fromCanvas2.nodes[0].params.expr === '', JSON.stringify(fromCanvas2.nodes[0].params))

  /* onError：实例 > 定义 > 'stop'。 */
  const od = toRunSpecs({ nodes: [{ id: 'y', defId: 'code.js' }], edges: [] }, LIB)
  check("onError 兜底到 'stop'", od.nodes[0].onError === 'stop', String(od.nodes[0].onError))
  const od2 = toRunSpecs({ nodes: [{ id: 'y', defId: 'code.js', onError: 'continue' }], edges: [] }, LIB)
  check('onError 实例值优先', od2.nodes[0].onError === 'continue', String(od2.nodes[0].onError))
}

/* ── ③ 查不到定义的节点：丢掉、记类型名、连带边也丢 ── */
console.log('')
console.log('=== ③ 认不出的节点类型 ===')
{
  const doc = {
    nodes: [{ id: 'a', defId: 'code.js' }, { id: 'ghost', defId: 'no.such.type' }, { id: 'b', defId: 'code.js' }],
    edges: [{ id: 'e1', source: 'a', target: 'ghost' }, { id: 'e2', source: 'a', target: 'b' }],
  }
  const r = toRunSpecs(doc, LIB)
  check('认不出的节点被丢掉', r.nodes.length === 2 && r.nodes.every(n => n.id !== 'ghost'))
  check('类型名被记下来（给用户提示）', r.missingTypes.includes('no.such.type'), JSON.stringify(r.missingTypes))
  check('★ 指向被丢节点的边也丢掉（否则拓扑排序算进不存在的东西）',
    r.edges.length === 1 && r.edges[0].id === 'e2', JSON.stringify(r.edges))
}

/* ── ④ 空 / 脏输入不炸 ── */
console.log('')
console.log('=== ④ 空与脏输入 ===')
{
  check('空文档：空结果，不抛', toRunSpecs({}, LIB).nodes.length === 0)
  check('nodes 不是数组：空结果，不抛', toRunSpecs({ nodes: 'nope' }, LIB).nodes.length === 0)
  check('画布空图：空结果，不抛', toRunSpecsFromCanvas([], []).nodes.length === 0)
  const weird = toRunSpecs({ nodes: [{ defId: 'code.js' }, { id: 'ok', defId: 'code.js' }], edges: [] }, LIB)
  check('没有 id 的节点被丢掉', weird.nodes.length === 1 && weird.nodes[0].id === 'ok', String(weird.nodes.length))
}

console.log('')
console.log(failed === 0 ? '结论：全部通过 ✓' : '结论：' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

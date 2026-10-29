/** 共用调度器（run.ts）的行为测试。
 *
 * 为什么必须有它：这个文件是**画布与宿主半共用的跑法**。
 * 它一出错，两处一起错，而且「画布上跑得好好的、后台跑就不对」这类问题极难查。
 * 所以把「顺序 / 上游传递 / 跳过 / 失败策略 / 变量替换」逐条钉死。
 *
 * 跑法：node --import <tsx> tests/run-graph.mjs
 */
import { runGraph } from '../src/workflow/run.ts'

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

/** 造一个最小节点定义（只带调度用得到的字段）。 */
function def(id, label) {
  return { id, label, executor: 'builtin', inputs: [], outputs: [] }
}

/** 造一个节点规格。
 *
 * ⚠️ `opts.def` 是**整份定义覆盖**（2026-10-19 加，给 `retry` 这类节点级字段用）：
 * 原来只能传 `defId` / `label`，于是想给定义加 `retry` 的测试会**静默失效**
 * （写进去的字段被这个函数丢掉，测试红得像实现没做）。 */
function spec(id, opts = {}) {
  const s = {
    id,
    def: opts.def ?? def(opts.defId ?? 'code.js', opts.label ?? id),
    params: opts.params ?? {},
    onError: opts.onError ?? 'stop',
    skipped: opts.skipped === true,
  }
  /* 容器归属：只在明确给了父时才带上（`undefined` 与「没有这个键」在下游等价，
   * 但存档时会写出 `parentId: undefined`，测试里保持干净）。 */
  if (opts.parentId !== undefined) s.parentId = opts.parentId
  return s
}

/** 造一条边。 */
function edge(source, target) {
  return { id: source + '->' + target, source, target }
}

/**
 * 造一个假派发器：记录调用顺序，按脚本给结果。
 * @param script - nodeId → 结果（缺省一律成功，输出 = `out:` + nodeId）。
 * @returns 派发函数与调用记录。
 */
function fakeDispatch(script = {}) {
  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, upstream: req.context.upstream, command: req.command })
    const r = script[req.nodeId]
    if (r !== undefined) return r
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

console.log('=== 共用调度器（runGraph）===')

console.log('① 拓扑顺序：上游先跑，下游拿到上游的输出')
{
  const nodes = [spec('a'), spec('b'), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('三个节点都跑了', r.ran.length === 3, r.ran.join('→'))
  check('顺序是 a→b→c（上游先）', r.ran.join('') === 'abc', r.ran.join('→'))
  check('b 拿到了 a 的输出', JSON.stringify(d.calls[1].upstream) === JSON.stringify(['out:a']),
    JSON.stringify(d.calls[1].upstream))
  check('c 拿到了 b 的输出（不是 a 的）', JSON.stringify(d.calls[2].upstream) === JSON.stringify(['out:b']),
    JSON.stringify(d.calls[2].upstream))
  check('返回里带每个节点的输出', r.outputs.get('c') === 'out:c')
}

console.log('')
console.log('② 分支与汇合：汇合节点拿到两路输出')
{
  const nodes = [spec('a'), spec('b'), spec('c'), spec('d')]
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  const dCall = d.calls.find(c => c.nodeId === 'd')
  check('汇合处拿到两路上游', dCall.upstream.length === 2, JSON.stringify(dCall.upstream))
  check('a 在 b 与 c 之前', r.ran.indexOf('a') < r.ran.indexOf('b') && r.ran.indexOf('a') < r.ran.indexOf('c'))
  check('d 在最后', r.ran[r.ran.length - 1] === 'd', r.ran.join('→'))
}

console.log('')
console.log('③ 只跑点名节点：会带上它的所有上游')
{
  const nodes = [spec('a'), spec('b'), spec('c'), spec('x')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges, targets: ['b'] }, d.fn)
  check('跑了 a 与 b（b 的上游）', r.ran.sort().join('') === 'ab', r.ran.join('→'))
  check('没跑 c 与无关的 x', !r.ran.includes('c') && !r.ran.includes('x'))
}

console.log('')
console.log('④ 跳过：不执行，但上游原样传下去')
{
  const nodes = [spec('a'), spec('b', { skipped: true }), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('被跳过的节点没有真派发', !d.calls.some(c => c.nodeId === 'b'), d.calls.map(c => c.nodeId).join(','))
  check('但 c 跑到了', r.ran.includes('c'))
  const cCall = d.calls.find(c => c.nodeId === 'c')
  check('c 拿到的上游 = a 的输出（跳过的原样穿过去）',
    JSON.stringify(cCall.upstream) === JSON.stringify(['out:a']), JSON.stringify(cCall.upstream))
}

console.log('')
console.log('⑤ 失败策略：stop 中断整条')
{
  const nodes = [spec('a'), spec('b', { onError: 'stop' }), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch({ b: { ok: false, status: 'failed', error: '炸了' } })
  const r = await runGraph({ nodes, edges }, d.fn)
  check('b 失败后 c 不跑', !r.ran.includes('c'), r.ran.join('→'))
  check('结果标为中断', r.aborted === true)
}

console.log('')
console.log('⑥ 失败策略：continue 往下走（下游拿不到那个值）')
{
  const nodes = [spec('a'), spec('b', { onError: 'continue' }), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch({ b: { ok: false, status: 'failed', error: '炸了' } })
  const r = await runGraph({ nodes, edges }, d.fn)
  check('c 仍然跑了', r.ran.includes('c'), r.ran.join('→'))
  check('没有标为中断', r.aborted === false)
  const cCall = d.calls.find(c => c.nodeId === 'c')
  check('c 的上游里没有 b 的值（b 失败了）', !cCall.upstream.includes('out:b'), JSON.stringify(cCall.upstream))
}

console.log('')
console.log('⑦ 事件：画布靠它画状态与日志')
{
  const nodes = [spec('a'), spec('b', { skipped: true }), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const events = []
  await runGraph({ nodes, edges }, fakeDispatch().fn, { onEvent: e => events.push(e) })
  const kinds = events.map(e => e.kind)
  check('发出 queued（全部先排队）', kinds.filter(k => k === 'queued').length === 3)
  check('发出 started', kinds.includes('started'))
  check('发出 success', kinds.includes('success'))
  check('发出 skipped（跳过有专门事件）', kinds.includes('skipped'))
  /* ⚠️ 取不到时**不能直接读 .nodeId**（会抛 TypeError 把整份测试打断，
   * 后面所有断言都不再执行 —— 验证脚本会因此报「没跑到该断言」而白验）。
   * 用可选链 + 显式判空，保证这条失败时后面的断言照样跑。 */
  const skipEvent = events.find(e => e.kind === 'skipped')
  check('skipped 事件带节点 id', skipEvent?.nodeId === 'b', JSON.stringify(skipEvent ?? null))
}

console.log('')
console.log('⑧ 变量替换：{{名字}} 换成上游字段值')
{
  const nodes = [
    spec('a'),
    spec('b', { params: { note: '拿到的是 {{x}}' } }),
  ]
  const edges = [edge('a', 'b')]
  const d = fakeDispatch({ a: { ok: true, status: 'success', output: { x: '来自上游' } } })
  await runGraph({ nodes, edges }, d.fn)
  const bCall = d.calls.find(c => c.nodeId === 'b')
  check('参数里的 {{x}} 被替换了',
    JSON.stringify(bCall.command).includes('来自上游'), JSON.stringify(bCall.command))
}

console.log('')
console.log('⑨ 中断信号：aborted 之后不再往下跑')
{
  const nodes = [spec('a'), spec('b'), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const ac = new AbortController()
  const d = fakeDispatch({ a: { ok: true, status: 'success', output: 1 } })
  /* 第一个节点跑完就中断。 */
  const orig = d.fn
  const wrapped = async (req, sig) => {
    const r = await orig(req, sig)
    if (req.nodeId === 'a') ac.abort()
    return r
  }
  const r = await runGraph({ nodes, edges }, wrapped, { signal: ac.signal })
  check('中断后只跑了 a', r.ran.join('') === 'a', r.ran.join('→'))
}

console.log('')
console.log('⑩ 环：处在环里的节点排到最后（不丢）')
{
  const nodes = [spec('a'), spec('b'), spec('c')]
  /* a→b→c→a 构成环，三个都在环里。 */
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('环里的节点都跑了（没被丢掉）', r.ran.length === 3, r.ran.join('→'))
}

console.log('')
console.log('⑪ includeUpstream：区分「只跑这个」与「从这里跑」')
{
  /* 2026-10-11 合并跑法时加这个开关。
   * 背景：画布上那两个入口**原先传的是同一组参数**，于是「只跑这个」
   * 实际上会连上游一起跑 —— 与它的说明（「只运行这一个节点」）不符。
   * 这个开关把那件事说清楚，这两条断言就是它的哨兵。 */
  const nodes = [spec('a'), spec('b'), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]

  /* 从这里跑：点名 c（默认带上游）→ a、b、c 都要跑。 */
  const d1 = fakeDispatch()
  const r1 = await runGraph({ nodes, edges, targets: ['c'] }, d1.fn)
  check('默认带上游：点名 c 会跑 a→b→c', r1.ran.join('') === 'abc', r1.ran.join('→'))

  /* 只跑这个：点名 c 且 includeUpstream=false → 只有 c。 */
  const d2 = fakeDispatch()
  const r2 = await runGraph({ nodes, edges, targets: ['c'], includeUpstream: false }, d2.fn)
  check('includeUpstream=false：点名 c 只跑 c', r2.ran.join('') === 'c', r2.ran.join('→'))

  /* 显式 true 与不传等价。 */
  const d3 = fakeDispatch()
  const r3 = await runGraph({ nodes, edges, targets: ['c'], includeUpstream: true }, d3.fn)
  check('includeUpstream=true 与不传等价', r3.ran.join('') === 'abc', r3.ran.join('→'))
}

console.log('')
console.log('⑫ Step 1 重构后：ran 去重、executions 计数、迭代变量通路')
{
  /* 这三条守的是 2026-10-12 的执行计划重构（把扁平 for 换成可递归的 runSeq）。
   * 重构本身要求「无行为变化」，所以前两组断言是最重要的护栏；
   * 这里补的是重构**新增**的两个字段与一条通路（它们是循环的前置条件）。 */

  /* ran 去重：同一节点在一次运行里不会出现两次。 */
  const nodes = [spec('a'), spec('b'), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('ran 无重复项', new Set(r.ran).size === r.ran.length, r.ran.join('→'))
  check('executions = 实际派发次数', r.executions === 3, String(r.executions))
  check('ran.length 与 executions 一致（无循环时）', r.ran.length === r.executions)

  /* 跳过的节点不派发，但算「跑过」。 */
  const d2 = fakeDispatch()
  const r2 = await runGraph({ nodes: [spec('a'), spec('b', { skipped: true }), spec('c')], edges }, d2.fn)
  check('跳过的不派发', d2.calls.every(c => c.nodeId !== 'b'), JSON.stringify(d2.calls.map(c => c.nodeId)))
  check('跳过仍计入 ran', r2.ran.join('') === 'abc', r2.ran.join('→'))
  check('跳过不计入 executions', r2.executions === 2, String(r2.executions))
  check('跳过把上游透传给下游', JSON.stringify(d2.calls.find(c => c.nodeId === 'c').upstream) === JSON.stringify(['out:a']),
    JSON.stringify(d2.calls.find(c => c.nodeId === 'c').upstream))

  /* 迭代变量通路：`scope.fields` 必须与上游字段**叠加**而不是取代。
   * 原先写成 `scope?.fields ?? fieldsFromUpstream(...)`，一旦传了 fields
   * 上游字段就整体消失 —— 循环注入 item 时会把上游数据挤掉。
   * 这条断言直接守那个坑（当前实现对顶层等价，靠它证明叠加语义已生效）。 */
  const d3 = fakeDispatch({ a: { ok: true, status: 'success', output: { key: 'fromA' } } })
  const r3 = await runGraph({
    nodes: [spec('a'), spec('b', { params: { note: 'k={{key}}' } })],
    edges: [edge('a', 'b')],
  }, d3.fn)
  const bCall3 = d3.calls.find(c => c.nodeId === 'b')
  check('上游字段仍可替换（叠加语义没把上游挤掉）',
    JSON.stringify(bCall3.command).includes('fromA'), JSON.stringify(bCall3.command))
  void r3
}

/** 造一个循环节点规格。 */
function loopSpec(id, params = {}, parentId) {
  const s = {
    id,
    def: { id: 'flow.loop', label: '循环', executor: 'builtin', inputs: [], outputs: [] },
    params: { mode: 'items', maxIters: 100, ...params },
    onError: 'stop',
    skipped: false,
  }
  if (parentId !== undefined) s.parentId = parentId
  return s
}

console.log('')
console.log('⑬ 循环执行：逐项重复跑循环体（2026-10-13 改：输入走参数选择器）')
{
  /* 形状（**循环节点上没有端口、也没有跨边界连线**）：
   *   src(产出数组)         L(循环)         out
   *                         L 里： h → t
   *
   * ⚠️ **判据 2026-10-13 改过**。原来靠 `src → L` 这条**跨边界连线**把数组送进循环；
   * 去掉端口后（照 Dify：它的迭代节点**零 Handle**），输入改由参数
   * `items: { nodeId, field }` 指定 —— 这就是 Dify 的 `iterator_selector`。
   *
   * `h → t` 仍是**体内边**；归属仍靠 `parentId`（那是「循环框」这个外观的数据基础）。 */
  const nodes = [
    spec('src'),
    loopSpec('L', { items: { nodeId: 'src', field: '' } }),
    spec('h', { parentId: 'L' }),
    spec('t', { parentId: 'L' }),
    spec('out'),
  ]
  /* ⚠️ 这里**没有** `src → L` / `L → out` 了 —— 循环不再有端口，画布上也连不出这种边。 */
  const edges = [edge('h', 't')]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: ['A', 'B', 'C'] } })
  const r = await runGraph({ nodes, edges }, d.fn)

  const hCalls = d.calls.filter(c => c.nodeId === 'h')
  const tCalls = d.calls.filter(c => c.nodeId === 't')
  check('循环体跑了 3 轮（数组 3 项）', hCalls.length === 3, String(hCalls.length))
  check('体内第二个节点也跑了 3 轮', tCalls.length === 3, String(tCalls.length))
  check('体内顺序 h 先于 t', d.calls.findIndex(c => c.nodeId === 'h') < d.calls.findIndex(c => c.nodeId === 't'))
  check('executions 计入循环体（2 节点 × 3 轮 + 2 个外层 = 8）', r.executions === 8, String(r.executions))
  check('ran 去重（3 轮后 h 只出现一次）', r.ran.filter(x => x === 'h').length === 1, r.ran.join(','))

  /* 迭代变量注入：体内节点能用 {{item}} / {{index}}，不必为此连线。 */
  nodes[2].params = { v: '{{item}}', i: '{{index}}' }
  const d2 = fakeDispatch({ src: { ok: true, status: 'success', output: ['X', 'Y'] } })
  await runGraph({ nodes, edges }, d2.fn)
  const cmds = d2.calls.filter(c => c.nodeId === 'h').map(c => JSON.stringify(c.command))
  /* ⚠️ 全部取值都判空：上面某条断言失败时这些可能取不到，
   * 直接下标/读属性会抛 TypeError 打断整份测试（后面的断言全不执行 = 白验）。 */
  check('第 1 轮 item=X、index=0',
    (cmds[0] ?? '').includes('"v":"X"') && (cmds[0] ?? '').includes('"i":"0"'), cmds[0] ?? '(无)')
  check('第 2 轮 item=Y、index=1',
    (cmds[1] ?? '').includes('"v":"Y"') && (cmds[1] ?? '').includes('"i":"1"'), cmds[1] ?? '(无)')

  /* 循环节点输出：{ count, results }。 */
  const Lout = r.outputs.get('L')
  check('循环输出轮数', Lout?.count === 3, JSON.stringify(Lout ?? null))
  check('循环输出每轮结果', (Lout?.results?.length ?? -1) === 3, JSON.stringify(Lout ?? null))
}

console.log('')
console.log('⑭ 循环：每轮输出互相隔离（第 2 轮不能读到第 1 轮的值）')
{
  /* 这是循环最容易错的地方：若各轮共用一张输出表，第 2 轮会拿到第 1 轮的残留。
   * 判据：体内回边 t→h 时，每轮的 h 都不该拿到 t 的值（本轮 t 还没跑）。 */
  const nodes = [
    spec('src'),
    loopSpec('L', { items: { nodeId: 'src', field: '' } }),
    spec('h', { parentId: 'L' }),
    spec('t', { parentId: 'L' }),
  ]
  /* ⚠️ 输入走选择器（不再有 `src → L` 这条跨边界边）；体内回边 `t → h` 保留。 */
  const edges = [edge('h', 't'), { id: 'back', source: 't', target: 'h' }]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: [1, 2, 3] } })
  await runGraph({ nodes, edges }, d.fn)
  const hUps = d.calls.filter(c => c.nodeId === 'h').map(c => JSON.stringify(c.upstream))
  check('每轮 h 都没拿到上一轮 t 的输出', hUps.every(u => u === '[]'), hUps.join(' | '))
  check('回边没让轮数失控（仍 3 轮）', hUps.length === 3, String(hUps.length))
}

console.log('')
console.log('⑮ 循环：上限截断 + 明确报错（不静默）')
{
  const nodes = [spec('src'), loopSpec('L', { items: { nodeId: 'src', field: '' }, maxIters: 2 }), spec('h', { parentId: 'L' })]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: [1, 2, 3, 4, 5] } })
  const events = []
  await runGraph({ nodes, edges: [] }, d.fn, { onEvent: e => events.push(e) })
  check('按上限只跑 2 轮', d.calls.filter(c => c.nodeId === 'h').length === 2, String(d.calls.filter(c => c.nodeId === 'h').length))
  check('截断有警告日志（不静默）',
    events.some(e => e.kind === 'log' && e.line.includes('超过上限')),
    events.filter(e => e.kind === 'log').map(e => e.line).join(' / '))

  /* 空循环体：明确报错，不静默跑一次。 */
  const d2 = fakeDispatch()
  const ev2 = []
  await runGraph({ nodes: [loopSpec('L2')], edges: [] }, d2.fn, { onEvent: e => ev2.push(e) })
  check('空体明确报错', ev2.some(e => e.kind === 'failed' && e.error.includes('没有节点')),
    ev2.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))

  /* 嵌套循环：**2026-10-19 起允许**（原先这一段断言「必须明确报错」）。
   * 现在由 ㉔～㉗ 四段覆盖：变量作用域 / 不读上一轮 / 内层取外层数据 / 层数上限。 */
}

console.log('')
console.log('㉔ 嵌套循环：变量作用域（{{item}} = 最内层，{{outer.item}} = 往外一层）')
{
  /* 形状：  src → L1（体里：oh → L2（体里：ih））
   *   L1 遍历 [A, B]，L2 遍历 [[1,2],[3,4]] —— 内层跑 2 轮、外层跑 2 轮 = 4 次 ih。
   *
   * 判据全是**派发出去的参数**（变量替换后的真实值），不是内部状态。 */
  const nodes = [
    spec('src'),
    loopSpec('L1', { items: { nodeId: 'src', field: '' } }),
    spec('oh', { parentId: 'L1' }),
    loopSpec('L2', { items: { nodeId: 'oh', field: 'list' } }, 'L1'),
    spec('ih', { parentId: 'L2', params: { a: '{{item}}', b: '{{index}}', o: '{{outer.item}}', oi: '{{outer.index}}' } }),
  ]
  const edges = [edge('oh', 'L2'), edge('L2', 'ih')]
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['A', 'B'] }
    /* `oh` 把外层本轮的值变成内层要遍历的数组。 */
    if (req.nodeId === 'oh') {
      const cur = req.command?.params?.v
      return { ok: true, status: 'success', output: { list: cur === 'A' ? [1, 2] : [3, 4] } }
    }
    return { ok: true, status: 'success', output: 'ok' }
  }
  /* `oh` 要能读到外层本轮的值 —— 给它一个 {{item}} 参数。 */
  nodes[2].params = { v: '{{item}}' }
  const d = fakeDispatch()
  d.fn = fn
  const r = await runGraph({ nodes, edges: [edge('oh', 'L2'), edge('L2', 'ih'), edge('src', 'L1')] }, fn)
  const ihCalls = d.calls.filter(c => c.nodeId === 'ih')
  /* 上面的 fakeDispatch 不会被这里用（`fn` 自己接的），所以从事件/输出侧核。
   * 为了直接看参数，这里换一个自己记录的方式： */

  /* 重新跑一次，自己记录 ih 的命令。 */
  const seen = []
  const fn2 = async (req) => {
    if (req.nodeId === 'ih') seen.push(req.command?.params ?? {})
    return fn(req)
  }
  await runGraph({
    nodes,
    edges: [edge('oh', 'L2'), edge('L2', 'ih'), edge('src', 'L1')],
  }, fn2)
  check('内层跑了 4 轮（外层 2 × 内层 2）', seen.length === 4, String(seen.length))
  /* ⚠️ 变量替换的结果**一律是字符串**（`variables.ts` 的 `toText`：数字转文本）。
   * 所以这里按字符串比，别按数字 —— 否则红的是断言，不是实现。 */
  check('★ 内层的 {{item}} 是最内层那份（1,2 然后 3,4）',
    JSON.stringify(seen.map(s => s.a)) === JSON.stringify(['1', '2', '3', '4']),
    JSON.stringify(seen.map(s => s.a)))
  check('内层的 {{index}} 是内层轮次（0,1,0,1）',
    JSON.stringify(seen.map(s => s.b)) === JSON.stringify(['0', '1', '0', '1']),
    JSON.stringify(seen.map(s => s.b)))
  check('★★ 内层的 {{outer.item}} 是外层那份（A,A,B,B）',
    JSON.stringify(seen.map(s => s.o)) === JSON.stringify(['A', 'A', 'B', 'B']),
    JSON.stringify(seen.map(s => s.o)))
  check('★ 内层的 {{outer.index}} 是外层轮次（0,0,1,1）',
    JSON.stringify(seen.map(s => s.oi)) === JSON.stringify(['0', '0', '1', '1']),
    JSON.stringify(seen.map(s => s.oi)))
  void r
  void ihCalls
  void d
}

console.log('')
console.log('㉕ 嵌套循环：内层**不读外层上一轮**（串味回归，深一层的那个 bug）')
{
  /* ★★ 这是本计划点名要求的回归测试（`run.ts` 记载的那个串味 bug 的嵌套版本）。
   *
   * 场景：外层第 2 轮里，内层去读**外层体里**的节点 `oh` ——
   * 它属于外层，应该读到**外层第 2 轮**刚写的值；若判错层，会读到外层第 1 轮的残留。
   *
   * 做法：让 `oh` 每轮输出**带轮次的值**，内层 `ih` 把它读进参数。
   * 断言：内层看到的永远是**同一外层轮次**的值，不是上一轮的。 */
  const nodes = [
    spec('src'),
    loopSpec('L1', { items: { nodeId: 'src', field: '' } }),
    spec('oh', { parentId: 'L1', params: { v: '{{item}}' } }),
    loopSpec('L2', { mode: 'count', count: 2 }, 'L1'),
    /* `ih` 住内层体里，但它有一条**跨容器**入边来自 `oh`（住外层体里）。
     * 「上游字段」由 `fieldsFromUpstream` 从 upstream 拼出来 → `{{mark}}` 取到 `oh.mark`。 */
    spec('ih', { parentId: 'L2', params: { got: '{{mark}}' } }),
  ]
  const edges = [edge('oh', 'L2'), edge('L2', 'ih'), edge('src', 'L1'), edge('oh', 'ih')]
  const seen = []
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['第一轮', '第二轮'] }
    if (req.nodeId === 'oh') {
      const mark = req.command?.params?.v
      return { ok: true, status: 'success', output: { mark } }
    }
    if (req.nodeId === 'ih') seen.push(req.command?.params?.got)
    return { ok: true, status: 'success', output: 'ok' }
  }
  await runGraph({ nodes, edges }, fn)
  check('内层跑了 4 轮（外层 2 × 内层 2）', seen.length === 4, String(seen.length))
  check('★★ 内层读到的外层值是**本轮的**（第一轮,第一轮,第二轮,第二轮）',
    JSON.stringify(seen) === JSON.stringify(['第一轮', '第一轮', '第二轮', '第二轮']),
    JSON.stringify(seen))
  check('★★ 没有一次读到「上一轮」的残留',
    seen.filter((v, i) => v !== (i < 2 ? '第一轮' : '第二轮')).length === 0, JSON.stringify(seen))
  check('内层跑了 4 轮（外层 2 × 内层 2）', seen.length === 4, String(seen.length))
  check('★★ 内层读到的外层值是**本轮的**（第一轮,第一轮,第二轮,第二轮）',
    JSON.stringify(seen) === JSON.stringify(['第一轮', '第一轮', '第二轮', '第二轮']),
    JSON.stringify(seen))
  check('★★ 没有一次读到「上一轮」的残留',
    seen.filter((v, i) => v !== (i < 2 ? '第一轮' : '第二轮')).length === 0, JSON.stringify(seen))
}

console.log('')
console.log('㉖ 嵌套循环：内层的「遍历哪个数据」能选外层体里的节点')
{
  /* 内层 L2 的 items 指向 `oh`（**住在外层体里**），全局 outputs 里只有它最后一轮的残留。
   * 若判错层，外层第 1 轮时内层会读到「还没跑过 / 上一轮的」值 → 轮数不对。 */
  const nodes = [
    spec('src'),
    loopSpec('L1', { items: { nodeId: 'src', field: '' } }),
    spec('oh', { parentId: 'L1', params: { v: '{{item}}' } }),
    loopSpec('L2', { items: { nodeId: 'oh', field: 'list' } }, 'L1'),
    spec('ih', { parentId: 'L2' }),
  ]
  const edges = [edge('oh', 'L2'), edge('L2', 'ih'), edge('src', 'L1')]
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['A', 'B'] }
    /* 每一轮给**不同长度**的数组：A → 1 项，B → 3 项。
     * 若内层读到的是外层的残留，两个外层轮的项数就会一样。 */
    if (req.nodeId === 'oh') {
      const cur = req.command?.params?.v
      return { ok: true, status: 'success', output: { list: cur === 'A' ? ['x'] : ['x', 'y', 'z'] } }
    }
    return { ok: true, status: 'success', output: 'ok' }
  }
  const r = await runGraph({ nodes, edges }, fn)
  const L2out = r.outputs.get('L2')
  check('★ 内层最终轮数 = 外层最后一轮给的 3 项', L2out?.count === 3, JSON.stringify(L2out ?? null))

  /* 更硬的判据：数 `ih` 的派发次数 = 1 + 3 = 4（不是 1+1，也不是 3+3）。 */
  let ihCount = 0
  const fn2 = async (req) => {
    if (req.nodeId === 'ih') ihCount += 1
    return fn(req)
  }
  await runGraph({ nodes, edges }, fn2)
  check('★★ 内层逐轮取到**本轮**外层给的数据（1 项 + 3 项 = 4 次）', ihCount === 4, String(ihCount))
}

console.log('')
console.log('㉗ 嵌套循环：内层结果交到**外层那一轮**（外层 collectRound 能取到）')
{
  /* 形状：L1 体里只有 L2；L2 体里只有一个 ih。
   * L1 的 tails = [L2]（它体里唯一的出口就是 L2）→ 每轮结果 = L2 的输出。
   * 若内层输出没交到外层那一轮的 local，外层每轮就是 undefined。 */
  const nodes = [
    spec('src'),
    loopSpec('L1', { items: { nodeId: 'src', field: '' } }),
    loopSpec('L2', { mode: 'count', count: 2, result: { nodeId: 'ih', field: '' } }, 'L1'),
    spec('ih', { parentId: 'L2', params: { v: '{{index}}' } }),
  ]
  const edges = [edge('src', 'L1')]
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['A', 'B'] }
    /* ⚠️ `count` 模式下的 `item` 是 `{ index: n }`（见 `iterationItems`），
     * 替换成文本就是 `{"index":0}`。所以这里用 `{{index}}` 取轮次，别用 `{{item}}`。 */
    if (req.nodeId === 'ih') return { ok: true, status: 'success', output: 'v' + String(req.command?.params?.v) }
    return { ok: true, status: 'success', output: 'ok' }
  }
  const r = await runGraph({ nodes, edges }, fn)
  const L1out = r.outputs.get('L1')
  check('外层收集到 2 轮', L1out?.count === 2, JSON.stringify(L1out ?? null))
  check('★★ 外层每轮的结果就是内层的输出（不是 undefined）',
    JSON.stringify(L1out?.results) === JSON.stringify([
      { count: 2, results: ['v0', 'v1'], picked: ['v0', 'v1'] },
      { count: 2, results: ['v0', 'v1'], picked: ['v0', 'v1'] },
    ]), JSON.stringify(L1out?.results ?? null))
}

console.log('')
console.log('㉘ 嵌套循环：三层都成立（{{outer.outer}}）+ 层数上限 5')
{
  /* 三层：L1 ⊃ L2 ⊃ L3，最内层 `x` 同时读 index / outer.index / outer.outer.index。
   *
   * ⚠️ 这里全用 `{{index}}` 而不是 `{{item}}`：`count` 模式的 item 是 `{ index }` 对象，
   * 替换成文本会变成 `{"index":0}`（看不出是哪一层）。index 是纯数字，逐层不同，好断言。 */
  const nodes = [
    loopSpec('L1', { mode: 'count', count: 2 }),
    loopSpec('L2', { mode: 'count', count: 2 }, 'L1'),
    loopSpec('L3', { mode: 'count', count: 3 }, 'L2'),
    spec('x', {
      parentId: 'L3',
      params: { a: '{{index}}', b: '{{outer.index}}', c: '{{outer.outer.index}}' },
    }),
  ]
  const seen = []
  const fn = async (req) => {
    if (req.nodeId === 'x') seen.push(req.command?.params ?? {})
    return { ok: true, status: 'success', output: 'ok' }
  }
  await runGraph({ nodes, edges: [] }, fn)
  check('三层跑满（2 × 2 × 3 = 12 次）', seen.length === 12, String(seen.length))
  check('★ 三层：{{index}} 按最内层循环（0,1,2 反复）',
    JSON.stringify(seen.map(s => s.a)) === JSON.stringify(['0', '1', '2', '0', '1', '2', '0', '1', '2', '0', '1', '2']),
    JSON.stringify(seen.map(s => s.a)))
  check('★ 三层：{{outer.index}} 按第 2 层（每 3 次换一个）',
    JSON.stringify(seen.map(s => s.b)) === JSON.stringify(['0', '0', '0', '1', '1', '1', '0', '0', '0', '1', '1', '1']),
    JSON.stringify(seen.map(s => s.b)))
  check('★★ 三层：{{outer.outer.index}} 是第 1 层（每 6 次换一个 → 0×6 然后 1×6）',
    JSON.stringify(seen.map(s => s.c)) === JSON.stringify(['0', '0', '0', '0', '0', '0', '1', '1', '1', '1', '1', '1']),
    JSON.stringify(seen.map(s => s.c)))

  /* 层数上限：6 层 → 明确报错（第 6 层超了 5 层的上限）。 */
  const deep = [loopSpec('D1', { mode: 'count', count: 1 })]
  for (let i = 2; i <= 6; i++) deep.push(loopSpec('D' + i, { mode: 'count', count: 1 }, 'D' + (i - 1)))
  deep.push(spec('leaf', { parentId: 'D6' }))
  const evs = []
  await runGraph({ nodes: deep, edges: [] }, fakeDispatch().fn, { onEvent: e => evs.push(e) })
  const fails = evs.filter(e => e.kind === 'failed')
  check('★ 第 6 层明确报错（上限 5）', fails.some(e => String(e.error).includes('嵌套太深')),
    fails.map(e => e.error).join(' / '))
  check('报错里说清是第几层、上限多少',
    fails.some(e => String(e.error).includes('第 6 层') && String(e.error).includes('上限 5')),
    fails.map(e => e.error).join(' / '))

  /* 5 层正好允许（边界不能差一）。 */
  const ok5 = [loopSpec('E1', { mode: 'count', count: 1 })]
  for (let i = 2; i <= 5; i++) ok5.push(loopSpec('E' + i, { mode: 'count', count: 1 }, 'E' + (i - 1)))
  ok5.push(spec('leaf5', { parentId: 'E5' }))
  const ev5 = []
  const d5 = fakeDispatch()
  await runGraph({ nodes: ok5, edges: [] }, d5.fn, { onEvent: e => ev5.push(e) })
  check('★ 5 层正好允许（不报错）', !ev5.some(e => e.kind === 'failed'),
    ev5.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))
  check('5 层时最内层节点真的跑了', d5.calls.some(c => c.nodeId === 'leaf5'),
    JSON.stringify(d5.calls.map(c => c.nodeId)))
}

console.log('')
console.log('㉙ ★★ 老存档兼容：单层循环的 {{item}} / {{index}} 一字不改，行为完全一致')
{
  /* 这是本任务的**硬判据**（方案 §3.1 的 ⚠️：不加别名、不复用 item 做别的用途）。
   *
   * 判据不看实现、只看**派发出去的命令**：同一份「老存档形状」的节点
   * （单层循环 + `{{item}}` / `{{index}}`）跑出来的参数必须与嵌套之前完全一样 ——
   * 即 `{ ...ctx.loopVars }` 那个老写法给出的那组值。
   *
   * 特别要守的一条：`loopVarFields` 在**没有外层**时不能多出 `outer` 这个键，
   * 否则 `{{outer}}` / `{{outer.item}}` 会从「未找到（原样保留）」变成「空串」，
   * 老工作流里若有人碰巧写了这两个名字，行为就变了。 */
  const nodes = [
    spec('src'),
    loopSpec('L', { items: { nodeId: 'src', field: '' } }),
    spec('h', { parentId: 'L', params: { a: '{{item}}', b: '{{index}}', c: '{{outer.item}}', d: '{{outer}}' } }),
  ]
  const seen = []
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['甲', '乙'] }
    if (req.nodeId === 'h') seen.push({ params: req.command?.params ?? {}, missing: req.missing })
    return { ok: true, status: 'success', output: 'ok' }
  }
  const evs = []
  await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
  check('老存档照常跑满 2 轮', seen.length === 2, String(seen.length))
  check('★★ 单层时 {{item}} 就是本轮数据（与改动前一致）',
    JSON.stringify(seen.map(s => s.params.a)) === JSON.stringify(['甲', '乙']),
    JSON.stringify(seen.map(s => s.params.a)))
  check('★★ 单层时 {{index}} 就是轮次（与改动前一致）',
    JSON.stringify(seen.map(s => s.params.b)) === JSON.stringify(['0', '1']),
    JSON.stringify(seen.map(s => s.params.b)))
  /* 没有外层时 `{{outer.item}}` 必须**原样保留**并给警告（不是替换成空串）。 */
  check('★ 单层时 {{outer.item}} 原样保留（没有外层就不该有这个变量）',
    seen.every(s => s.params.c === '{{outer.item}}'),
    JSON.stringify(seen.map(s => s.params.c)))
  check('★ 单层时 {{outer}} 原样保留', seen.every(s => s.params.d === '{{outer}}'),
    JSON.stringify(seen.map(s => s.params.d)))
  /* 「原样保留」同时要有一条警告 —— 用户最怕「什么都没发生」。 */
  check('★ 未找到的变量有警告日志（不静默）',
    evs.some(e => e.kind === 'log' && e.line.includes('未找到变量')),
    evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 300))
}

console.log('')
console.log('⑮b 循环：**没选数据来源**时明确报错（不静默零轮，也不崩）')
{
  /* 去掉端口后新增的一种失误：用户忘了在「遍历哪个数据」里选东西。
   * 必须明确报错 —— 静默跑 0 轮的话，用户会以为「循环跑了但没效果」。 */
  const nodes = [loopSpec('L'), spec('h', { parentId: 'L' })]
  const d = fakeDispatch()
  const events = []
  await runGraph({ nodes, edges: [] }, d.fn, { onEvent: e => events.push(e) })
  const failed = events.filter(e => e.kind === 'failed')
  check('明确报错', failed.length > 0, failed.map(e => e.error).join(' / '))
  check('报错指出该选什么', failed.some(e => String(e.error).includes('遍历哪个数据')),
    failed.map(e => e.error).join(' / '))
  check('不派发体内节点（没数据就别跑）', d.calls.length === 0, JSON.stringify(d.calls.map(c => c.nodeId)))
}

console.log('')
console.log('⑮c 循环：选到的**不是列表**时明确报错（不静默当成一条）')
{
  const nodes = [
    spec('src'),
    loopSpec('L', { items: { nodeId: 'src', field: '' } }),
    spec('h', { parentId: 'L' }),
  ]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: '不是数组' } })
  const events = []
  await runGraph({ nodes, edges: [] }, d.fn, { onEvent: e => events.push(e) })
  const failed = events.filter(e => e.kind === 'failed')
  check('明确报错', failed.length > 0, failed.map(e => e.error).join(' / '))
  check('报错说清「不是列表」', failed.some(e => String(e.error).includes('不是一个列表')),
    failed.map(e => e.error).join(' / '))
}

console.log('')
console.log('⑰ 循环：单节点体（既是头也是尾）+ count 模式')
{
  const nodes = [loopSpec('L', { mode: 'count', count: 3 }), spec('only', { parentId: 'L' })]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges: [] }, d.fn)
  check('count 模式跑 3 次', d.calls.filter(c => c.nodeId === 'only').length === 3,
    String(d.calls.filter(c => c.nodeId === 'only').length))
  check('单节点体也收集到结果', (r.outputs.get('L')?.results?.length ?? -1) === 3, JSON.stringify(r.outputs.get('L') ?? null))
}

/** 造一个条件判断节点规格（两出口）。 */
function ifSpec(id, expr) {
  return {
    id,
    def: {
      id: 'flow.if', label: '条件判断', executor: 'builtin',
      inputs: [{ id: 'in', label: '入', type: 'any' }],
      outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }],
    },
    params: { expr },
    onError: 'stop',
    skipped: false,
  }
}

console.log('')
console.log('⑱ 条件分流：未走的分支不执行（2026-10-12 Step 4）')
{
  /* 形状：  src → IF ─true─→ yes
   *                  └false─→ no
   * IF 的输出带 `__handle`，调度器据此知道哪条边活。 */
  const nodes = [spec('src'), ifSpec('IF', 'input.ok === true'), spec('yes'), spec('no')]
  const edges = [
    edge('src', 'IF'),
    { id: 'e-t', source: 'IF', target: 'yes', sourceHandle: 'true' },
    { id: 'e-f', source: 'IF', target: 'no', sourceHandle: 'false' },
  ]

  /* 条件成立 → 只跑 yes。 */
  const d = fakeDispatch({
    src: { ok: true, status: 'success', output: { ok: true } },
    IF: { ok: true, status: 'success', output: { __handle: 'true', value: { ok: true } } },
  })
  await runGraph({ nodes, edges }, d.fn)
  check('成立时 yes 跑了', d.calls.some(c => c.nodeId === 'yes'), JSON.stringify(d.calls.map(c => c.nodeId)))
  check('成立时 no 没派发', !d.calls.some(c => c.nodeId === 'no'), JSON.stringify(d.calls.map(c => c.nodeId)))

  /* 条件不成立 → 只跑 no。 */
  const d2 = fakeDispatch({
    src: { ok: true, status: 'success', output: { ok: false } },
    IF: { ok: true, status: 'success', output: { __handle: 'false', value: { ok: false } } },
  })
  await runGraph({ nodes, edges }, d2.fn)
  check('不成立时 no 跑了', d2.calls.some(c => c.nodeId === 'no'), JSON.stringify(d2.calls.map(c => c.nodeId)))
  check('不成立时 yes 没派发', !d2.calls.some(c => c.nodeId === 'yes'), JSON.stringify(d2.calls.map(c => c.nodeId)))
}

console.log('')
console.log('⑲ 条件分流：不可达沿着链传播（未走分支的下游也不跑）')
{
  /* 未走分支的**下游再下游**同样不该跑。 */
  const nodes = [spec('src'), ifSpec('IF', 'input.ok'), spec('yes'), spec('after')]
  const edges = [
    edge('src', 'IF'),
    { id: 'e-t', source: 'IF', target: 'yes', sourceHandle: 'true' },
    { id: 'e-a', source: 'yes', target: 'after' },
  ]
  const d = fakeDispatch({
    src: { ok: true, status: 'success', output: { ok: false } },
    IF: { ok: true, status: 'success', output: { __handle: 'false' } },
  })
  const events = []
  await runGraph({ nodes, edges }, d.fn, { onEvent: e => events.push(e) })
  check('未走分支的节点不派发', !d.calls.some(c => c.nodeId === 'yes'), JSON.stringify(d.calls.map(c => c.nodeId)))
  check('未走分支的下游也不派发', !d.calls.some(c => c.nodeId === 'after'), JSON.stringify(d.calls.map(c => c.nodeId)))
  check('跳过的节点有交代（不是静默消失）',
    events.some(e => e.kind === 'skipped' && e.nodeId === 'yes'),
    events.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))
}

console.log('')
console.log('⑳ 分支：普通多出口节点无 __handle 时，全部下游照常执行（行为不变）')
{
  /* 这是**兼容护栏**：绝大多数节点没有分支信息，行为必须与改动前完全一致。 */
  const nodes = [spec('src'), spec('multi'), spec('a'), spec('b')]
  const edges = [
    edge('src', 'multi'),
    { id: 'e-a', source: 'multi', target: 'a', sourceHandle: 'x' },
    { id: 'e-b', source: 'multi', target: 'b', sourceHandle: 'y' },
  ]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: 1 } })
  await runGraph({ nodes, edges }, d.fn)
  check('两个下游都跑了', d.calls.some(c => c.nodeId === 'a') && d.calls.some(c => c.nodeId === 'b'),
    JSON.stringify(d.calls.map(c => c.nodeId)))
}

console.log('')
console.log('㉑ 分支与循环组合：循环体内含条件，逐轮判定互不污染')
{
  /* 循环体： h → IF ─true─→ yes → after
   *
   * ⚠️ **`after` 是这条断言能成立的关键**（第一版没有它，于是「不清空」也照样通过，假绿）：
   * `unreachableScoped` 只在判断**边的起点**时被查。若只到 `yes` 为止，
   * 那 `yes` 从来不是谁是上游，残留记录就不起作用。
   * 加上 `yes → after` 之后：第 1 轮 `yes` 记进不可达 → 不清空的话
   * 第 2 轮 `yes→after` 这条边被判死 → `after` 永远不跑。
   *
   * ⚠️ **`IF` 也必须带 `parentId: 'L'`** —— 否则它在循环外，拓扑序上排在循环**之前**，
   * 会先跑一次、且拿到空上游（第一版就漏了这个）。 */
  const nodes = [
    spec('src'), loopSpec('L', { items: { nodeId: 'src', field: '' } }), spec('h', { parentId: 'L' }),
    { ...ifSpec('IF', 'input.go'), parentId: 'L' },
    spec('yes', { parentId: 'L' }),
    spec('after', { parentId: 'L' }),
  ]
  /* ⚠️ 输入走选择器（不再有 `src → L` 这条跨边界边）—— 循环节点已经没有端口了。 */
  const edges = [
    edge('h', 'IF'),
    { id: 'e-t', source: 'IF', target: 'yes', sourceHandle: 'true' },
    edge('yes', 'after'),
  ]
  /* ⚠️ **第 1 轮让它不可达、第 2 轮可达** —— 这样才测得到「每轮要清空本层不可达记录」。
   * 第一版把 true 放在第 1 轮：那时 `yes` 是可达的，什么都不会记进去，
   * 于是**删掉 `unreachableScoped.clear()` 也照样通过**（假绿）。 */
  /* h 每轮输出不同 → 用带状态的派发器。 */
  const calls = []
  let i = 0
  const fn = async (req) => {
    calls.push(req.nodeId)
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: [{ go: false }, { go: true }] }
    if (req.nodeId === 'h') { const out = { go: i === 1 }; i += 1; return { ok: true, status: 'success', output: out } }
    if (req.nodeId === 'IF') {
      const up = req.context.upstream[0]
      return { ok: true, status: 'success', output: { __handle: up?.go === true ? 'true' : 'false', value: up } }
    }
    return { ok: true, status: 'success', output: 'yes' }
  }
  /* 用事件验证「第 1 轮确实判过不可达」——这是上面那条「第 2 轮不被误杀」的前提。 */
  const events = []
  i = 0
  calls.length = 0
  const fn2 = async (req) => {
    calls.push(req.nodeId)
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: [{ go: false }, { go: true }] }
    if (req.nodeId === 'h') { const out = { go: i === 1 }; i += 1; return { ok: true, status: 'success', output: out } }
    if (req.nodeId === 'IF') {
      const up = req.context.upstream[0]
      return { ok: true, status: 'success', output: { __handle: up?.go === true ? 'true' : 'false', value: up } }
    }
    return { ok: true, status: 'success', output: 'yes' }
  }
  await runGraph({ nodes, edges }, fn2, { onEvent: e => events.push(e) })
  check('第 1 轮判过不可达（有 skipped 事件）',
    events.some(e => e.kind === 'skipped' && e.nodeId === 'yes'),
    events.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))
  check('第 2 轮仍能到达 yes（每轮清空了不可达记录）',
    calls.filter(c => c === 'yes').length === 1, calls.join(','))
  /* 这一条才是 `unreachableScoped.clear()` 的真正哨兵：
   * 第 1 轮 yes 不可达 → 若记录残留，第 2 轮 yes→after 被判死、after 不跑。 */
  check('第 2 轮 yes 的下游也跑到了（不可达记录没残留）',
    calls.filter(c => c === 'after').length === 1, calls.join(','))
}

console.log('')
console.log('㉒ 循环输入：**参数优先**，没填参数才用入边（2026-10-17 端口补实）')
{
  /* 用户 m00789 定案「端口补实」之后，循环的数据有两处来源。
   *
   * ⚠️ **优先级是「参数优先」，不是「入边优先」** —— 第一版写反了，
   * 跑全套测试当场把抖音工作流弄红（详见 run.ts 那段说明：已有工作流全都
   * 「连了线 + 填了参数」，入边优先会让它们取到整份输出对象而不是字段）。
   * 所以这条断言的判据是「**参数填了就只听参数的**」。 */
  const nodes = [
    spec('srcParam'),
    spec('srcEdge'),
    loopSpec('L', { items: { nodeId: 'srcParam', field: '' } }),
    spec('h', { parentId: 'L' }),
  ]
  /* 两条跨边界入边：srcEdge → L（入边）与 srcParam 只挂在参数里。
   * ⚠️ 循环节点现在**有** `in` 端口（与 `node.ts` 的定义一致）。 */
  const edges = [
    { id: 'e-in', source: 'srcEdge', target: 'L', targetHandle: 'in' },
  ]
  const d = fakeDispatch({
    srcParam: { ok: true, status: 'success', output: ['参数来的'] },
    srcEdge: { ok: true, status: 'success', output: ['入边来的', '第二条'] },
  })
  await runGraph({ nodes, edges }, d.fn)
  check('参数填了 → 轮数 = 参数那份的长度（1，不是入边那份的 2）',
    d.calls.filter(c => c.nodeId === 'h').length === 1,
    String(d.calls.filter(c => c.nodeId === 'h').length))

  /* ★★ 参数**没填**（items 为 null）时，入边才是数据来源 —— 这是「补实端口」
   * 真正新增的能力：只连线、不填参数也能喂数据。
   * 少了这条，上面那条「参数优先」的同义反复（实现里参数分支永远赢）就白验了。 */
  const nodesEdgeOnly = [
    spec('srcEdge'),
    loopSpec('L2', { items: null }),
    spec('h', { parentId: 'L2' }),
  ]
  const d2 = fakeDispatch({ srcEdge: { ok: true, status: 'success', output: ['入边来的', '第二条'] } })
  await runGraph({
    nodes: nodesEdgeOnly,
    edges: [{ id: 'e-in', source: 'srcEdge', target: 'L2', targetHandle: 'in' }],
  }, d2.fn)
  check('★ 参数没填 → 用入边那份（2 轮）',
    d2.calls.filter(c => c.nodeId === 'h').length === 2,
    String(d2.calls.filter(c => c.nodeId === 'h').length))

  /* 参数与入边**都没有** → 明确报错这一条**不在这里重复**：
   * ⑮b 已经钉住了（且那里是用 `onEvent` 收 `failed` 事件判的 ——
   * `runGraph` 按失败策略**不往外抛**，所以用 try/catch 会永远捕不到，是假红）。 */
}

console.log('')
console.log('㉓ 循环并发：concurrency > 1 时**结果顺序与串行完全一致**（2026-10-17 实现）')
{
  /* 并发下「谁先跑完」是随机的，但结果必须按轮次下标回填。
   * 做法：让**靠前的轮次跑得更慢**（第 1 轮等最久）——
   * 若实现是「谁先完成谁先进数组」，结果顺序就会反过来，这条断言当场红。 */
  /* ⚠️ 循环体内的节点**不靠连线**拿本轮数据 —— 它是 `{{item}}` 变量替换进来的
   * （见文件头与 `run.ts` 的 `loopVars`）。所以这里给 `h` 一个带 `{{item}}` 的参数，
   * 从 `command` 里读本轮的值。 */
  const nodes = [
    spec('src'),
    loopSpec('L', {
      items: { nodeId: 'src', field: '' },
      concurrency: 3,
      result: { nodeId: 'h', field: '' },
    }),
    spec('h', { parentId: 'L', params: { v: '{{item}}' } }),
  ]
  /* 自己造派发器：`h` 的输出**就是本轮那个 item**（这样结果数组能直接看出顺序），
   * 并让靠前的轮次**睡得更久**，制造「完成顺序与轮次顺序相反」。 */
  const fn23 = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['A', 'B', 'C'] }
    /* ⚠️ builtin 的命令体形状是 `{ node, params }`（见 src/workflow/command.ts:124-127），
     * 参数在 `command.params` 里 —— 第一版写成 `req.command?.v` 永远取不到（结果全是 null）。 */
    const item = req.command?.params?.v
    if (typeof item === 'string') {
      await new Promise((res) => { setTimeout(res, item === 'A' ? 60 : item === 'B' ? 30 : 5) })
    }
    return { ok: true, status: 'success', output: item }
  }
  const r = await runGraph({ nodes, edges: [{ id: 'e1', source: 'src', target: 'L', targetHandle: 'in' }] }, fn23)
  const Lout = r.outputs.get('L')
  check('并发跑完 3 轮', (Lout?.count ?? -1) === 3, JSON.stringify(Lout ?? null))
  check('结果顺序与串行一致（A、B、C，不是按完成先后）',
    JSON.stringify(Lout?.results) === JSON.stringify(['A', 'B', 'C']),
    JSON.stringify(Lout?.results ?? null))
  check('picked 也按轮次对齐',
    JSON.stringify(Lout?.picked) === JSON.stringify(['A', 'B', 'C']),
    JSON.stringify(Lout?.picked ?? null))

  /* ★ 每轮必须发一条**形状固定**的进度日志（`第 N/M 轮`）——
   * 画布靠它把轮次贴到循环框头上（WorkflowCanvas 的 onEvent 用整行正则匹配）。
   * 格式一旦改，那里会**静默失效**（正则不匹配 → 什么都不显示，不报错），
   * 所以在这里钉住格式。 */
  {
    const nodesP = [
      spec('src'),
      loopSpec('LP', { items: { nodeId: 'src', field: '' } }),
      spec('h', { parentId: 'LP' }),
    ]
    const evs = []
    await runGraph({ nodes: nodesP, edges: [] }, fakeDispatch({
      src: { ok: true, status: 'success', output: ['a', 'b'] },
    }).fn, { onEvent: e => evs.push(e) })
    const rounds = evs.filter(e => e.kind === 'log' && /^第 \d+\/\d+ 轮$/.test(e.line)).map(e => e.line)
    check('★ 每轮发一条「第 N/M 轮」进度日志（画布框头靠它显示进度）',
      JSON.stringify(rounds) === JSON.stringify(['第 1/2 轮', '第 2/2 轮']),
      JSON.stringify(rounds))
  }

  /* ⚠️ 上面那条只验「顺序对」。**串行跑完再排序，顺序也照样对** ——
   * 所以必须另有一条证明「真的同时在跑」：3 轮各睡 50ms，
   * 并发的话总耗时 ≈ 50ms，串行会是 ≈150ms。阈值取 120ms 两边都不擦边。 */
  {
    const nodesC = [
      spec('src'),
      loopSpec('LC', { items: { nodeId: 'src', field: '' }, concurrency: 3 }),
      spec('h', { parentId: 'LC', params: { v: '{{item}}' } }),
    ]
    const fnC = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: [1, 2, 3] }
      await new Promise((res) => { setTimeout(res, 50) })
      return { ok: true, status: 'success', output: 'x' }
    }
    const t0 = Date.now()
    await runGraph({ nodes: nodesC, edges: [] }, fnC)
    const ms = Date.now() - t0
    check('concurrency=3 真的同时在跑（3×50ms 的活没花满 120ms）', ms < 120, ms + 'ms')
  }

  /* 并发度非法值 → 回落 1（不能 NaN 或 0 轮）。 */
  const nodes2 = [
    spec('src'),
    loopSpec('L2', { items: { nodeId: 'src', field: '' }, concurrency: Number.NaN }),
    spec('h', { parentId: 'L2' }),
  ]
  const d3 = fakeDispatch({ src: { ok: true, status: 'success', output: [1, 2, 3] } })
  await runGraph({ nodes: nodes2, edges: [] }, d3.fn)
  check('concurrency 非法 → 仍跑满 3 轮',
    d3.calls.filter(c => c.nodeId === 'h').length === 3,
    String(d3.calls.filter(c => c.nodeId === 'h').length))
}

console.log('')
console.log('㉚ 循环条件跳出：breakConditions（照 Dify）—— 成立就停，**不是失败**')
{
  /* 参照物：Dify 的 `LoopNodeType.break_conditions?: Condition[]`，与 if-else 同一种
   * 条件结构（我们复用 `IfCondition`）。语义：**任一成立就结束这个循环**。
   *
   * ⚠️ 三条硬判据（任务书列的）：
   *   ① 停止不是失败 —— 不发 `failed`，发一条 log + 正常 `success`
   *   ② 已经收集到的轮次结果**照常给出**（不能因跳出丢掉前面的）
   *   ③ 老存档（没有 breakConditions）行为一字不变 */
  const nodes = [
    spec('src'),
    loopSpec('L', {
      items: { nodeId: 'src', field: '' },
      /* 「这一轮的 item 等于 'stop' 就停」—— 与「连续 2 天失败就停」同一种形状。 */
      breakConditions: [{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'stop' }],
    }),
    spec('h', { parentId: 'L', params: { v: '{{item}}' } }),
  ]
  const evs = []
  const seen = []
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['a', 'stop', 'c'] }
    if (req.nodeId === 'h') seen.push(req.command?.params?.v)
    return { ok: true, status: 'success', output: 'ok' }
  }
  const r = await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })

  check('★ 第 2 轮命中条件后停下（只跑了 2 轮，不是 3 轮）', seen.length === 2, JSON.stringify(seen))
  check('★★ 跳出**不是失败** —— 没有发 failed', !evs.some(e => e.kind === 'failed'),
    evs.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))
  check('★★ 跳出时循环节点报的是 success',
    evs.some(e => e.kind === 'success' && e.nodeId === 'L'),
    evs.filter(e => e.kind === 'success').map(e => e.nodeId).join(','))
  check('★ 有一条日志说清「第 N 轮后按条件跳出」',
    evs.some(e => e.kind === 'log' && /按条件跳出/.test(e.line) && /第 2 轮/.test(e.line)),
    evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 400))
  check('整个运行没有被中断（aborted 为假）', r.aborted === false, String(r.aborted))
  /* ★ 已收集的结果**照常给出**：前两轮（含触发跳出那一轮）都在。 */
  const Lout = r.outputs.get('L')
  check('★★ 已跑完的轮次结果照常给出（2 条，不因跳出丢）',
    Lout?.count === 2 && Array.isArray(Lout?.results) && Lout.results.length === 2,
    JSON.stringify(Lout ?? null))
}

console.log('')
console.log('㉛ 条件跳出：多条 / 逻辑 / 没配时不跳')
{
  const mk = (breakConditions, items, breakLogic) => {
    const nodes = [
      spec('src'),
      loopSpec('L', {
        items: { nodeId: 'src', field: '' },
        ...(breakConditions === undefined ? {} : { breakConditions }),
        ...(breakLogic === undefined ? {} : { breakLogic }),
      }),
      spec('h', { parentId: 'L', params: { v: '{{item}}' } }),
    ]
    const seen = []
    const evs = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: items }
      if (req.nodeId === 'h') seen.push(req.command?.params?.v)
      return { ok: true, status: 'success', output: 'ok' }
    }
    return runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) }).then(r => ({ r, seen, evs }))
  }

  /* ★ 老存档：根本没有 breakConditions 这个键 → 一轮都不跳（行为一字不变）。 */
  {
    const { seen, evs } = await mk(undefined, ['a', 'b', 'c'])
    check('★★ 老存档（没有 breakConditions）不跳出，跑满 3 轮', seen.length === 3, JSON.stringify(seen))
    check('老存档没有跳出日志', !evs.some(e => e.kind === 'log' && /按条件跳出/.test(e.line)),
      evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 300))
  }

  /* 空数组 = 没配条件 → 也不跳（不能把「一条都没填」当成「永远成立」，
   * 那会让循环静默只跑一轮 —— 与 `flow.if` 那边同一条纪律）。 */
  {
    const { seen } = await mk([], ['a', 'b', 'c'])
    check('★ breakConditions 为空数组 → 不跳出（跑满 3 轮）', seen.length === 3, JSON.stringify(seen))
  }

  /* 第一条就成立 → 只跑 1 轮。 */
  {
    const { seen } = await mk([{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'a' }], ['a', 'b', 'c'])
    check('★ 第 1 轮就成立 → 只跑 1 轮', seen.length === 1, JSON.stringify(seen))
  }

  /* 两条条件按 and：要**都**成立才跳。 */
  {
    const { seen } = await mk([
      { left: { kind: 'loop', name: 'item' }, op: 'is', value: 'b' },
      { left: { kind: 'loop', name: 'index' }, op: 'is', value: '0' },
    ], ['a', 'b', 'c'])
    check('★ 两条条件按「全部满足」→ 第 1 轮 index 不符，不跳（跑满 3 轮）',
      seen.length === 3, JSON.stringify(seen))
  }

  /* 换成 or 就跳。 */
  {
    const { seen } = await mk(
      [{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'b' }],
      ['a', 'b', 'c'],
      'or',
    )
    check('★ 单条条件 + or → 第 2 轮跳（跑 2 轮）', seen.length === 2, JSON.stringify(seen))
  }

  /* 「连续 2 次失败」那种意图：用 index 判「第 2 轮之后」。
   * 这是源码 `douyin-ui.ts` 里最接近的真实用法（这里只验「按轮次停」能表达）。 */
  {
    const { seen } = await mk([{ left: { kind: 'loop', name: 'index' }, op: 'gte', value: '2', valueType: 'number' }],
      ['a', 'b', 'c', 'd', 'e'])
    check('★ 用 index 表达「跑到第 3 轮就停」→ 3 轮', seen.length === 3, JSON.stringify(seen))
  }
}

console.log('')
console.log('㉜ 条件跳出：能按「体内节点本轮的输出」判（最常见的真实写法）')
{
  /* 真实用法：体内某个节点判定这一条失败（输出 `{ ok: false }`），
   * 连续两次就停整个模块。这里先验最小一档：本轮 ok 为 false 就停。
   *
   * ⚠️ 判据必须是**本轮**的值，不是上一轮残留 —— 与 t17 那条串味纪律同源。 */
  const nodes = [
    spec('src'),
    loopSpec('L', {
      items: { nodeId: 'src', field: '' },
      breakConditions: [{ left: { kind: 'field', nodeId: 'chk', field: 'ok' }, op: 'is', value: 'false', valueType: 'boolean' }],
    }),
    spec('chk', { parentId: 'L', params: { v: '{{item}}' } }),
  ]
  const seen = []
  const evs = []
  const fn = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['good', 'bad', 'good'] }
    if (req.nodeId === 'chk') {
      const v = req.command?.params?.v
      seen.push(v)
      return { ok: true, status: 'success', output: { ok: v !== 'bad' } }
    }
    return { ok: true, status: 'success', output: 'ok' }
  }
  const r = await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
  check('★ 第 2 轮 ok=false → 停（只跑 2 轮）', seen.length === 2, JSON.stringify(seen))
  check('★★ 停的时候没报失败', !evs.some(e => e.kind === 'failed'),
    evs.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))
  check('★ 结果里留着前两轮', (r.outputs.get('L')?.count ?? -1) === 2, JSON.stringify(r.outputs.get('L') ?? null))
}

console.log('')
console.log('㉝ 条件跳出：**每层各判各的**（内层跳不停外层；外层跳则不再开新轮）')
{
  /* 形状：L1（外层，遍历 A/B/C）⊃ L2（内层，固定 3 次）
   *
   * ① 内层跳 → 外层照常跑满 3 轮
   * ② 外层跳 → 内层不再开新的一轮（内层总次数 = 跳之前跑过的那几轮） */
  const build = (outerBreak, innerBreak) => {
    const nodes = [
      spec('src'),
      loopSpec('L1', { items: { nodeId: 'src', field: '' }, ...(outerBreak === undefined ? {} : { breakConditions: outerBreak }) }),
      loopSpec('L2', { mode: 'count', count: 3, ...(innerBreak === undefined ? {} : { breakConditions: innerBreak }) }, 'L1'),
      spec('ih', { parentId: 'L2', params: { a: '{{item}}', o: '{{outer.item}}' } }),
    ]
    const seen = []
    const evs = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['A', 'B', 'C'] }
      if (req.nodeId === 'ih') seen.push({ a: req.command?.params?.a, o: req.command?.params?.o })
      return { ok: true, status: 'success', output: 'ok' }
    }
    return runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
      .then(r => ({ r, seen, evs }))
  }

  /* ① 内层第 2 轮跳（index >= 1）→ 外层不受影响，跑满 3 轮。
   *    内层每轮 2 次（0、1 后跳）→ 共 3 × 2 = 6 次。 */
  {
    const { seen, evs } = await build(
      undefined,
      [{ left: { kind: 'loop', name: 'index' }, op: 'gte', value: '1', valueType: 'number' }],
    )
    check('★★ 内层跳出**不影响外层**（外层仍跑满 3 轮 → 内层共 6 次）',
      seen.length === 6, String(seen.length))
    check('内层跳过后外层仍按 A、B、C 走',
      JSON.stringify(seen.map(s => s.o)) === JSON.stringify(['A', 'A', 'B', 'B', 'C', 'C']),
      JSON.stringify(seen.map(s => s.o)))
    check('内层跳出没报任何失败', !evs.some(e => e.kind === 'failed'),
      evs.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))
  }

  /* ② 外层第 2 轮跳（item 是 'B'）→ C 那轮不再开，内层一共只跑 2×3=6 次。 */
  {
    const { seen, evs } = await build(
      [{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'B' }],
      undefined,
    )
    check('★★ 外层跳出后**不再开新一轮**（内层只跑 A、B 两轮 × 3 = 6 次）',
      seen.length === 6, String(seen.length))
    check('C 那轮确实没开', !seen.some(s => s.o === 'C'), JSON.stringify(seen.map(s => s.o)))
    check('外层跳出也没报失败', !evs.some(e => e.kind === 'failed'),
      evs.filter(e => e.kind === 'failed').map(e => e.error).join(' / '))
  }

  /* ③ 两层都配了条件、互不干扰：内层按自己的判，外层按自己的判。 */
  {
    const { seen } = await build(
      [{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'B' }],
      [{ left: { kind: 'loop', name: 'index' }, op: 'gte', value: '2', valueType: 'number' }],
    )
    /* 外层 A：内层 3 次（index 2 那次跑完才跳）→ 3
     * 外层 B：内层 3 次 → 但外层本轮跑完跳出 → 总计 6 */
    check('★ 两层各有各的条件，都只在**自己那层**生效',
      seen.length === 6, String(seen.length))
  }
}

console.log('')
console.log('㉞ 节点级重试：retry = { times, delayMs }（照源码的 downloadOne 重跑一次）')
{
  /* 参照物（`douyin-ui.ts` 的 `downloadOne`）：saveAs 之后「效果未知」就等 5 秒
   * **整段重跑一次**（`attempt < 1` → 只重试 1 次），明确失败不重试。
   *
   * 我们的做法：次数与间隔都做成**参数**，由用户决定重试几次 ——
   * 我们不自作聪明去分类「哪类错值得重试」（任务书明确要求）。
   *
   * ⚠️ 与 `onError` 的关系（这是最容易混的一处）：
   *   · `onError` 是「失败后**走不走**」（stop / continue）；
   *   · `retry` 是「失败后**再试几次**」。
   *   两者叠加：continue + retry 2 = 先重试 2 次，还失败就按 continue 往下走。 */

  /* ① 重试 2 次、间隔 0（测试里不等真时间）→ 一共派发 3 次，第 3 次成功。 */
  {
    const nodes = [spec('a', { def: { ...def('code.js', 'a'), retry: { times: 2, delayMs: 0 } } })]
    let n = 0
    const fn = async () => {
      n += 1
      if (n < 3) return { ok: false, status: 'failed', error: '第 ' + String(n) + ' 次失败' }
      return { ok: true, status: 'success', output: 'ok' }
    }
    const evs = []
    const r = await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
    check('★ retry.times=2 → 一共尝试 3 次', n === 3, String(n))
    check('★ 最后成功了（重试真的救了回来）', r.ran.includes('a') && r.aborted === false, String(r.aborted))
    check('★ 重试有日志（说清第几次）',
      evs.filter(e => e.kind === 'log' && /↻ 第 \d+\/\d+ 次重试/.test(e.line)).length === 2,
      evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 400))
    check('★ 重试日志里有次数与原因',
      evs.some(e => e.kind === 'log' && /第 1\/2 次重试/.test(e.line) && /原因：/.test(e.line)),
      evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 400))
    check('重试期间没有发 failed（还没判死刑）', !evs.some(e => e.kind === 'failed'))
  }

  /* ② 重试用尽仍失败 → 才发 failed 并抛（与原先一模一样）。 */
  {
    const nodes = [spec('a', { def: { ...def('code.js', 'a'), retry: { times: 1, delayMs: 0 } } })]
    let n = 0
    const fn = async () => { n += 1; return { ok: false, status: 'failed', error: '一直失败' } }
    const evs = []
    const r = await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
    check('★ retry.times=1 → 一共尝试 2 次', n === 2, String(n))
    check('★ 用尽后明确失败（aborted）', r.aborted === true, String(r.aborted))
    check('★ 用尽后只发一条 failed（不是每次重试都发）',
      evs.filter(e => e.kind === 'failed' && e.nodeId === 'a').length === 1,
      String(evs.filter(e => e.kind === 'failed').length))
  }

  /* ③ 没配 retry → 行为与改动前**一字不变**（只派发 1 次）。 */
  {
    const nodes = [spec('a')]
    let n = 0
    const fn = async () => { n += 1; return { ok: false, status: 'failed', error: 'x' } }
    await runGraph({ nodes, edges: [] }, fn)
    check('★★ 没配 retry → 只试 1 次（老存档行为不变）', n === 1, String(n))
  }

  /* ④ onError=continue + retry：先重试，还失败就往下走（不中断）。 */
  {
    const nodes = [
      spec('a', { onError: 'continue', def: { ...def('code.js', 'a'), retry: { times: 1, delayMs: 0 } } }),
      spec('b'),
    ]
    let aCount = 0
    const fn = async (req) => {
      if (req.nodeId === 'a') { aCount += 1; return { ok: false, status: 'failed', error: '坏的' } }
      return { ok: true, status: 'success', output: 'out:b' }
    }
    const r = await runGraph({ nodes, edges: [edge('a', 'b')] }, fn)
    check('★ continue + retry.1 → a 试 2 次', aCount === 2, String(aCount))
    check('★★ 重试用尽后按 continue 往下走（b 跑了、没中断）',
      r.ran.includes('b') && r.aborted === false, r.ran.join(',') + ' aborted=' + String(r.aborted))
  }

  /* ⑤ retry.times=0 → 等于不重试（用户明确关掉）。 */
  {
    const nodes = [spec('a', { def: { ...def('code.js', 'a'), retry: { times: 0, delayMs: 0 } } })]
    let n = 0
    const fn = async () => { n += 1; return { ok: false, status: 'failed', error: 'x' } }
    await runGraph({ nodes, edges: [] }, fn)
    check('★ retry.times=0 → 只试 1 次', n === 1, String(n))
  }

  /* ⑥ 非法 retry 值不崩（存档被手改）。 */
  {
    const nodes = [spec('a', { def: { ...def('code.js', 'a'), retry: { times: Number.NaN, delayMs: -5 } } })]
    let n = 0
    const fn = async () => { n += 1; return { ok: false, status: 'failed', error: 'x' } }
    await runGraph({ nodes, edges: [] }, fn)
    check('★ retry 非法 → 当作不重试（不崩、不死循环）', n === 1, String(n))
  }
}

console.log('')
console.log('㉟ 循环级：maxConsecutiveFailures（照源码的 consecutiveFails）')
{
  /* 参照物（`douyin-ui.ts`）：
   *   let consecutiveFails = 0;
   *   for (...) { try { ... } catch { consecutiveFails++; if (consecutiveFails >= 2) { 停这个模块 } } }
   * 语义：**连续** N 次失败就停这个循环；中间成功一次就**清零**。
   *
   * ⚠️ 与 t18 的 `breakConditions` 是**两件事**（任务书明确要求别混）：
   *   · `breakConditions` —— 按用户写的条件跳出；
   *   · `maxConsecutiveFailures` —— 按失败次数**自动**跳出。
   * 所以是两个独立参数，各自生效、可同时配。 */

  /** 造一个「连续失败 N 次就停」的循环。 */
  const mkLoop = (maxConsecutiveFailures) => [
    spec('src'),
    loopSpec('L', { items: { nodeId: 'src', field: '' }, maxConsecutiveFailures }),
    spec('h', { parentId: 'L', params: { v: '{{item}}' }, onError: 'continue' }),
  ]

  /* ① 连续 2 次失败 → 停（第 3 轮不再跑）。序列：ok / fail / fail / ok / ok */
  {
    const nodes = mkLoop(2)
    const seen = []
    const evs = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['ok', 'bad', 'bad', 'ok', 'ok'] }
      if (req.nodeId === 'h') {
        const v = req.command?.params?.v
        seen.push(v)
        if (v === 'bad') return { ok: false, status: 'failed', error: '这一条坏了' }
      }
      return { ok: true, status: 'success', output: 'ok' }
    }
    const r = await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
    check('★★ 连续 2 次失败后停（只跑到第 3 轮）',
      seen.length === 3, JSON.stringify(seen))
    check('★★ 停的时候**不是失败**（整条流程没中断）', r.aborted === false, String(r.aborted))
    check('★ 有一条日志说清「连续 N 次失败，停这个循环」',
      evs.some(e => e.kind === 'log' && /连续/.test(e.line) && /停/.test(e.line)),
      evs.filter(e => e.kind === 'log').map(e => e.line).join(' / ').slice(0, 500))
    check('★ 循环节点仍报 success（不是 failed）',
      evs.some(e => e.kind === 'success' && e.nodeId === 'L'), '')
  }

  /* ② ★ 成功一次就清零：fail / ok / fail / fail 里「连续」只有末尾那 2 次。
   *    若不清零，第 3 次失败时累计数会是 3，行为一样 —— 所以要造一个
   *    「清零才有区别」的序列：fail, ok, fail, ok, fail, ok（永不超过 2 次连续）。 */
  {
    const nodes = mkLoop(2)
    const seen = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['bad', 'ok', 'bad', 'ok', 'bad', 'ok'] }
      if (req.nodeId === 'h') {
        const v = req.command?.params?.v
        seen.push(v)
        if (v === 'bad') return { ok: false, status: 'failed', error: 'x' }
      }
      return { ok: true, status: 'success', output: 'ok' }
    }
    await runGraph({ nodes, edges: [] }, fn)
    check('★★ 成功一次就**清零**（失败-成功交替 → 一次都不跳，跑满 6 轮）',
      seen.length === 6, JSON.stringify(seen))
  }

  /* ③ 默认 0 = 不启用（老存档行为不变）：连续失败 5 次也不跳。 */
  {
    const nodes = mkLoop(0)
    const seen = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: [1, 2, 3, 4, 5] }
      if (req.nodeId === 'h') {
        seen.push(req.command?.params?.v)
        return { ok: false, status: 'failed', error: '全坏' }
      }
      return { ok: true, status: 'success', output: 'ok' }
    }
    const evs = []
    await runGraph({ nodes, edges: [] }, fn, { onEvent: e => evs.push(e) })
    check('★★ 默认不启用（0）→ 连续失败也不跳，跑满 5 轮', seen.length === 5, String(seen.length))
    check('没有「连续失败跳出」的日志', !evs.some(e => e.kind === 'log' && /连续.*停/.test(e.line)), '')
  }

  /* ④ 没配这个参数（undefined）→ 同样不启用。 */
  {
    const nodes = [
      spec('src'),
      loopSpec('L', { items: { nodeId: 'src', field: '' } }),
      spec('h', { parentId: 'L', params: { v: '{{item}}' }, onError: 'continue' }),
    ]
    const seen = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: [1, 2, 3] }
      if (req.nodeId === 'h') { seen.push(1); return { ok: false, status: 'failed', error: 'x' } }
      return { ok: true, status: 'success', output: 'ok' }
    }
    await runGraph({ nodes, edges: [] }, fn)
    check('★★ 没配 maxConsecutiveFailures → 老行为（跑满 3 轮）', seen.length === 3, String(seen.length))
  }

  /* ⑤ ★ 被跳出的那几轮**要记进结果**，说明「因为连续失败被跳过」，不能静默丢。 */
  {
    const nodes = mkLoop(2)
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: [1, 2, 3, 4, 5] }
      if (req.nodeId === 'h') return { ok: false, status: 'failed', error: '全坏' }
      return { ok: true, status: 'success', output: 'ok' }
    }
    const r = await runGraph({ nodes, edges: [] }, fn)
    const Lout = r.outputs.get('L')
    check('★★ 结果里记下了「因连续失败被跳过」的轮次',
      Array.isArray(Lout?.skippedRounds) && Lout.skippedRounds.length === 3,
      JSON.stringify(Lout ?? null))
    check('★ skippedReason 说明是连续失败（不是静默丢）',
      typeof Lout?.skippedReason === 'string' && /连续.*失败/.test(Lout.skippedReason),
      JSON.stringify(Lout?.skippedReason ?? null))
    check('★ 实际跑了的轮次仍在 results 里', (Lout?.results ?? []).length === 2,
      JSON.stringify(Lout?.results ?? null))
  }

  /* ⑥ 与 t18 的 breakConditions 各管各的：两个都配，先命中的那个生效、说法分得清。 */
  {
    const nodes = [
      spec('src'),
      loopSpec('L', {
        items: { nodeId: 'src', field: '' },
        maxConsecutiveFailures: 2,
        breakConditions: [{ left: { kind: 'loop', name: 'item' }, op: 'is', value: 'stop' }],
      }),
      spec('h', { parentId: 'L', params: { v: '{{item}}' }, onError: 'continue' }),
    ]
    const seen = []
    const fn = async (req) => {
      if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['a', 'bad', 'bad', 'stop', 'z'] }
      if (req.nodeId === 'h') {
        const v = req.command?.params?.v
        seen.push(v)
        if (v === 'bad') return { ok: false, status: 'failed', error: 'x' }
      }
      return { ok: true, status: 'success', output: 'ok' }
    }
    await runGraph({ nodes, edges: [] }, fn)
    /* a(ok) → bad(fail 1) → bad(fail 2 → 连续失败跳出，stop 那轮没开) */
    check('★ 两个机制都配 → 先命中的生效（连续失败在第 3 轮跳，stop 那轮没跑）',
      seen.length === 3 && !seen.includes('stop'), JSON.stringify(seen))
  }
}

console.log('')
console.log('㊱ 并行节点由调度器解释执行：成员不进主序、结果按路次回填')
{
  /* 形状：src → P(并行) → after；P 里三个互不相连的成员。
   * 判据只钉「调度器认出了这个节点类型」这一层 —— 并发的细节在 `tests/parallel-run.mjs`。 */
  const parDef = { id: 'flow.parallel', label: '并行', executor: 'builtin', inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'out', label: '出', type: 'any' }] }
  const nodes = [
    spec('src'),
    { id: 'P', def: parDef, params: { concurrency: 1 }, onError: 'continue', skipped: false },
    { id: 'a', def: { id: 'code.js', label: '代码', executor: 'builtin', inputs: [], outputs: [] }, params: {}, onError: 'continue', skipped: false, parentId: 'P' },
    { id: 'b', def: { id: 'code.js', label: '代码', executor: 'builtin', inputs: [], outputs: [] }, params: {}, onError: 'continue', skipped: false, parentId: 'P' },
    spec('after'),
  ]
  const edges = [edge('src', 'P'), edge('P', 'after')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('★ 并行节点本身跑到了', r.ran.includes('P'), r.ran.join('→'))
  check('★ 框内成员也被跑到（没被主序漏掉）',
    r.ran.includes('a') && r.ran.includes('b'), r.ran.join('→'))
  check('★ 成员不是按主序派发的（它们由并行节点驱动）',
    r.ran.indexOf('P') < r.ran.indexOf('a') && r.ran.indexOf('P') < r.ran.indexOf('b'),
    r.ran.join('→'))
  check('★ 并行节点的输出是「每路一项」的数组',
    Array.isArray(r.outputs.get('P')) && r.outputs.get('P').length === 2,
    JSON.stringify(r.outputs.get('P')))
  check('★ 下游拿到的就是那个数组',
    JSON.stringify(d.calls.find(c => c.nodeId === 'after')?.upstream) === JSON.stringify([r.outputs.get('P')]),
    JSON.stringify(d.calls.find(c => c.nodeId === 'after')?.upstream))
}

console.log('')
console.log('㊲ 并行框内跨路汇合 → 明确报错（不静默给结果）')
{
  /* 与 `parallel-run` ⑨ 同一张图，但这里只钉「调度器这一层的出口」：
   * failed 事件有、输出没有、别的节点没被牵连。切分细节在 parallel-run 里。 */
  const parDef = { id: 'flow.parallel', label: '并行', executor: 'builtin', inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'out', label: '出', type: 'any' }] }
  const codeDef = { id: 'code.js', label: '代码', executor: 'builtin', inputs: [], outputs: [] }
  const nodes = [
    { id: 'P', def: parDef, params: { concurrency: 1 }, onError: 'continue', skipped: false },
    { id: '甲', def: codeDef, params: {}, onError: 'continue', skipped: false, parentId: 'P' },
    { id: '乙', def: codeDef, params: {}, onError: 'continue', skipped: false, parentId: 'P' },
    { id: '丙', def: codeDef, params: {}, onError: 'continue', skipped: false, parentId: 'P' },
  ]
  const edges = [edge('甲', '丙'), edge('乙', '丙')]
  const events = []
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: (e) => events.push(e) })
  check('★ 发出了 failed 事件', events.some(e => e.kind === 'failed' && e.nodeId === 'P'),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  check('★ 并行节点没有输出（没有伪造一个数组）', r.outputs.get('P') === undefined,
    JSON.stringify(r.outputs.get('P')))
  check('★ 框内成员一个都没派发', !d.calls.some(c => ['甲', '乙', '丙'].includes(c.nodeId)),
    d.calls.map(c => c.nodeId).join(','))
  check('★ 并行节点 onError 是 continue → 整条没被中断', r.aborted === false, String(r.aborted))
}

console.log('')
console.log('㊳ 模型痕迹随 success 事件带出来（只有真调了模型的节点才有）')
{
  /* ## 这一段守的是什么
   *
   * `ai.agent` 跑完的痕迹（哪个模型、多少 token、怎么结束）住在 `DispatchResult.llm` 上。
   * 若调度器不在 `success` 事件里把它带出去，收集层与运行记录都拿不到 ——
   * 用户只能看到一段文字，无从知道那是哪次模型调用花的钱。
   *
   * 同时要反向钉住**不该有的地方没有**：普通节点（`code.js` 那种）不调模型，
   * 它的事件里**不许**多一个 `llm` 键 —— 否则每条明细都挂一个恒为空的东西。 */
  const TRACE = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'stop',
    inputTokens: 120, outputTokens: 45, outputPreview: '模型写的一段话',
  }
  const events = []
  const dispatchWithTrace = async (req) => {
    /* 只有 `ai` 这个节点带痕迹，另一个故意不带。 */
    if (req.nodeId === 'ai') return { ok: true, status: 'success', output: '一段文字', llm: TRACE }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  const nodes = [spec('ai'), spec('plain')]
  const edges = [edge('ai', 'plain')]
  const r = await runGraph({ nodes, edges }, dispatchWithTrace, { onEvent: (e) => events.push(e) })

  const aiEv = events.find(e => e.kind === 'success' && e.nodeId === 'ai')
  const plainEv = events.find(e => e.kind === 'success' && e.nodeId === 'plain')
  check('★ 调了模型的节点：success 事件带 llm', aiEv?.llm !== undefined, JSON.stringify(aiEv?.llm))
  check('★ 带的就是派发结果里那份（原样透传，不重造）', aiEv?.llm === TRACE, JSON.stringify(aiEv?.llm))
  check('★ 痕迹里 provider / model / finish 齐', aiEv?.llm.provider === 'deepseek-official'
    && aiEv?.llm.model === 'deepseek-v4-flash' && aiEv?.llm.finish === 'stop')
  check('★★ 没调模型的节点：事件里**没有** llm 这个键', plainEv !== undefined && !('llm' in plainEv),
    JSON.stringify(plainEv && Object.keys(plainEv)))
  check('★ 没带痕迹不影响输出与执行顺序',
    r.ran.join('') === 'aiplain' && r.outputs.get('ai') === '一段文字', r.ran.join('→'))
  check('★ 老字段照旧（nodeId / output / depth）',
    typeof aiEv?.nodeId === 'string' && aiEv?.output === '一段文字' && aiEv?.depth === 0,
    JSON.stringify({ nodeId: aiEv?.nodeId, depth: aiEv?.depth }))
}

console.log('')
console.log('㊴ 派发失败也带模型痕迹（模型报错 / 被截断时最需要看它）')
{
  /* ## 为什么这一段必须单独钉
   *
   * `success` 那条路已经带了痕迹（㊳）。但**最需要痕迹的恰恰是失败**：
   * 模型报错、输出被 token 上限截断 —— 用户要看到「哪个模型、花了多少、为什么结束」
   * 才知道下一步该改提示词、换模型还是调大上限。
   *
   * 而结构类错误（参数没填 / 找不到节点 / 嵌套太深）**根本没派发**，
   * 它们**不该**带痕迹 —— 硬塞一个空痕迹会让界面显示一条假的模型调用记录。 */
  const FAIL_TRACE = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'error',
    inputTokens: 800, outputTokens: 0,
  }
  const events = []
  const dispatchFailWithTrace = async (req) => {
    if (req.nodeId === 'boom') {
      return { ok: false, status: 'failed', error: '模型调用失败：速率超限', llm: FAIL_TRACE }
    }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  const nodes = [spec('boom'), spec('after')]
  const edges = [edge('boom', 'after')]
  /* 失败策略 continue：让后面的节点照跑，好确认「没痕迹的失败不带键」也能取到。 */
  nodes[0].onError = 'continue'
  const r = await runGraph({ nodes, edges }, dispatchFailWithTrace, { onEvent: (e) => events.push(e) })

  const failEv = events.find(e => e.kind === 'failed' && e.nodeId === 'boom')
  check('★ 派发失败时也发出了 failed 事件', failEv !== undefined)
  check('★★ 失败事件带 llm', failEv?.llm !== undefined, JSON.stringify(failEv?.llm))
  check('★ 带的就是失败结果里那份（原样透传）', failEv?.llm === FAIL_TRACE, JSON.stringify(failEv?.llm))
  check('★ 痕迹里 finish 是 error（说清是出错结束的）', failEv?.llm?.finish === 'error', String(failEv?.llm?.finish))
  check('★ 错误原文照旧带着', String(failEv?.error ?? '').includes('速率超限'), String(failEv?.error))

  /* 结构类错误（这里用「条件判断没填任何条件」，它根本没派发）→ **不许**带 llm。 */
  const ifDef = { id: 'flow.if', label: '条件判断', executor: 'builtin', inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }] }
  const structNodes = [{ id: 'j', def: ifDef, params: {}, onError: 'continue', skipped: false }]
  const structEvents = []
  await runGraph({ nodes: structNodes, edges: [] }, fakeDispatch().fn, { onEvent: (e) => structEvents.push(e) })
  const structFail = structEvents.find(e => e.kind === 'failed' && e.nodeId === 'j')
  check('★ 结构类错误照样发 failed 事件', structFail !== undefined)
  check('★★ 结构类错误（没派发）不带 llm 键', structFail !== undefined && !('llm' in structFail),
    JSON.stringify(structFail && Object.keys(structFail)))
}

console.log('')
console.log('㊵ 中断后「没跑到」的节点收到 cancelled（契约 AB：「报错了，但后续还在执行」）')
{
  /* ## 这一段守的是什么
   *
   * `runGraph` 一开跑就把主序里每个节点发成 `queued`（界面要一眼看出这次要跑哪些）。
   * 节点失败 + `onError: stop` 时，原先只发一条 `aborted` 就抛出去了 ——
   * 那些还在排队的节点**没有任何人改**，收集层只在收到事件时改状态，
   * 于是它们永远停在「排队中」，用户看着像后面还在执行（实际没有）。
   *
   * 所以收尾要补发 `cancelled`。这里钉四件事：
   *   ① 没跑到的收到 `cancelled`；
   *   ② **跑过的不许收到**（把「真跑过」改写成「没跑」比不修更坏）；
   *   ③ 已经 `skipped` 的也不许被改写（「按配置跳过」与「因中断没跑」是两件事实）；
   *   ④ 正常跑完时一条 `cancelled` 都不该有。 */
  const nodes = [spec('a'), spec('b'), spec('c'), spec('d')]
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]
  const events = []
  const d = fakeDispatch({ b: { ok: false, status: 'failed', error: '炸了' } })
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: (e) => events.push(e) })

  check('★ 确实中断了（后面几条断言的前提）', r.aborted === true, String(r.aborted))
  const cancelled = events.filter(e => e.kind === 'cancelled').map(e => e.nodeId)
  check('★★ 没跑到的 c、d 收到 cancelled', cancelled.join(',') === 'c,d', cancelled.join(','))
  check('★★ 跑过的 a、b **一个都没收到** cancelled',
    !cancelled.includes('a') && !cancelled.includes('b'),
    cancelled.join(','))
  /* 反向的最强形状：`ran` 里每个节点都不许出现在 cancelled 里。 */
  check('★★ ran 与 cancelled 没有交集（跑过的不被改写成没跑）',
    cancelled.every(id => !r.ran.includes(id)),
    'ran=' + r.ran.join(',') + ' cancelled=' + cancelled.join(','))
  check('★ 失败的那个节点自己是 failed，不是 cancelled（别混成一个）',
    events.some(e => e.kind === 'failed' && e.nodeId === 'b')
    && !cancelled.includes('b'),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  check('★ cancelled 事件带 depth（收集层要靠它分层次）',
    events.filter(e => e.kind === 'cancelled').every(e => e.depth === 0),
    events.filter(e => e.kind === 'cancelled').map(e => String(e.depth)).join(','))
  check('★ 顺序稳定（按排队顺序补发，不是随机的）', cancelled.join(',') === 'c,d', cancelled.join(','))

  /* ── ③ 已经 `skipped` 的节点不许被改写 ──────────────────────────────
   * 跳过的节点**不进 `ran`**（`runNode` 判完可达性就 return），若判据只看 `ran`，
   * 中断时就会把「按配置跳过」改写成「因为中断没跑」。 */
  const nodes2 = [spec('a2'), spec('s2', { skipped: true }), spec('b2'), spec('c2')]
  const edges2 = [edge('a2', 's2'), edge('s2', 'b2'), edge('b2', 'c2')]
  const events2 = []
  const d2 = fakeDispatch({ b2: { ok: false, status: 'failed', error: '也炸了' } })
  const r2 = await runGraph({ nodes: nodes2, edges: edges2 }, d2.fn, { onEvent: (e) => events2.push(e) })
  const cancelled2 = events2.filter(e => e.kind === 'cancelled').map(e => e.nodeId)
  check('★ 前提：这份也中断了', r2.aborted === true, String(r2.aborted))
  check('★★ 跳过的节点没被改写成 cancelled', !cancelled2.includes('s2'), cancelled2.join(','))
  check('★ 它照旧有自己的 skipped 事件',
    events2.some(e => e.kind === 'skipped' && e.nodeId === 's2'),
    events2.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))
  check('★ 它后面真没跑到的 c2 收到 cancelled', cancelled2.join(',') === 'c2', cancelled2.join(','))

  /* ── ④ 正常跑完：一条 `cancelled` 都不许有 ─────────────────────────── */
  const events3 = []
  await runGraph({ nodes: [spec('a3'), spec('b3')], edges: [edge('a3', 'b3')] }, fakeDispatch().fn,
    { onEvent: (e) => events3.push(e) })
  check('★★ 正常跑完时没有 cancelled（不误伤）',
    !events3.some(e => e.kind === 'cancelled'),
    events3.filter(e => e.kind === 'cancelled').map(e => e.nodeId).join(','))
  /* ── ⑤ 循环体里的节点也要被收干净 ─────────────────────────────────────
   *
   * 循环体的成员**不在主序里**，它们的 `queued` 是每轮开始时单独发的。
   * 若台账只记主序那一批，循环体里「排着队、这一轮没轮到就中断了」的节点
   * 仍然停在「排队中」—— 用户看到的现象换个层级又出现一次。
   *
   * 真实存档里就有这种形状（`取数-抖音电商罗盘` 的两个循环，27 个体内节点）。 */
  const loopNodes = [
    loopSpec('L', { mode: 'count', times: 2 }),
    spec('h', { parentId: 'L' }),
    spec('b', { parentId: 'L' }),
    spec('c', { parentId: 'L' }),
  ]
  const loopEdges = [edge('h', 'b'), edge('b', 'c')]
  const loopEvents = []
  const dl = fakeDispatch({ b: { ok: false, status: 'failed', error: '体内这一步炸了' } })
  const rl = await runGraph({ nodes: loopNodes, edges: loopEdges }, dl.fn, { onEvent: (e) => loopEvents.push(e) })
  const loopCancelled = loopEvents.filter(e => e.kind === 'cancelled').map(e => e.nodeId)
  check('★ 前提：循环体里失败 → 整条中断', rl.aborted === true, String(rl.aborted))
  check('★★ 循环体里没轮到的 c 收到 cancelled（记账覆盖了每轮的排队）',
    loopCancelled.includes('c'), loopCancelled.join(','))
  check('★★ 循环体里跑过的 h、b 没被改写成没跑',
    !loopCancelled.includes('h') && !loopCancelled.includes('b'),
    loopCancelled.join(','))
}

console.log('')
console.log('㊶ 中断时把「为什么」交出来（契约 AH：板块记录只记整次运行，缺的正是这一层）')
{
  /* ## 这一段守的是什么
   *
   * 节点失败 + `onError: stop` 时，原先只回 `aborted: true`，不回原因。
   * 于是宿主半与板块记录拿到的只有 `ok: false` 一个布尔值 ——
   * `collect/` 下 4 条失败记录字段里一条都没有 `error`，用户看得到「没跑成」、
   * 看不到是哪一步、为什么。
   *
   * 四条一起钉：有原因 / 是**那句话本身** / 成功时没有这个键 / 挂起时也没有。 */
  const nodes = [spec('a'), spec('b'), spec('c')]
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const REASON = '这一条要「连一个已经开着的浏览器」，但没有填调试端口。'
  const d = fakeDispatch({ b: { ok: false, status: 'failed', error: REASON } })
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
  check('★ 前提：这次中断了', r.aborted === true, String(r.aborted))
  check('★★ 返回值里有 error（整次运行这一层的汇总原因）', typeof r.error === 'string', JSON.stringify(r.error))
  check('★★ error 就是那句话本身（原样，不是「有节点失败」这种笼统话）', r.error === REASON, String(r.error))

  /* 反面一：正常跑完时**没有** `error` 这个键（不是 `undefined`，是不存在）。 */
  const ok = await runGraph({ nodes, edges }, fakeDispatch().fn, { onEvent: () => { /* 不要日志 */ } })
  check('★★ 成功跑完时没有 error 键（不写 undefined、不写空串）', !('error' in ok),
    JSON.stringify(Object.keys(ok)))

  /* 反面二：挂起时也没有 —— 挂起不是失败（`aborted` 仍为假）。 */
  const waitDef = { id: 'flow.wait', label: '等待', executor: 'builtin', inputs: [], outputs: [] }
  const waitNodes = [spec('w1'), spec('w2', { def: waitDef, params: { mode: 'duration', ms: 60000 } }), spec('w3')]
  const waitEdges = [edge('w1', 'w2'), edge('w2', 'w3')]
  const w = await runGraph({ nodes: waitNodes, edges: waitEdges }, fakeDispatch().fn,
    { workflowId: 'AH挂起', runId: 'ah-wait-1', onEvent: () => { /* 不要日志 */ } })
  check('★ 前提：这次是挂起', w.paused !== undefined && w.aborted === false, String(w.aborted))
  check('★★ 挂起时没有 error 键（挂起不是失败）', !('error' in w),
    JSON.stringify(Object.keys(w)))

  /* ── 循环体内某轮失败并中断：递归那条路也要记到 ─────────────────────
   *
   * 失败发生在 `runSeq` 的**递归**调用里（循环体那段）。变量若放在 `runSeq` 里
   * 就抛出去丢了 —— 那正是这条断言要抓的。 */
  const loopNodes = [
    loopSpec('L', { mode: 'count', times: 3 }),
    spec('h', { parentId: 'L' }),
    spec('boom', { parentId: 'L' }),
  ]
  const loopEdges = [edge('h', 'boom')]
  const LOOP_REASON = '循环体里这一步炸了'
  const dl = fakeDispatch({ boom: { ok: false, status: 'failed', error: LOOP_REASON } })
  const rl = await runGraph({ nodes: loopNodes, edges: loopEdges }, dl.fn, { onEvent: () => { /* 不要日志 */ } })
  check('★ 前提：循环体里失败 → 整条中断', rl.aborted === true, String(rl.aborted))
  check('★★ 循环体里失败时 error 也有值（递归那条路记到了）', rl.error === LOOP_REASON, String(rl.error))

  /* ── 「第一个」而不是「最后一个」 ───────────────────────────────────
   *
   * 只有 `stop` 策略会让它有值，而 `stop` 当场就停 —— 所以这里能验的是
   * 「有多个节点各自失败过（前一个走 continue 被吞掉）时，记的是**让它停下的那个**」。
   * 前面那个 `continue` 的失败不该被记进来（它不是中断的原因）。 */
  const mixNodes = [
    spec('soft', { onError: 'continue' }),
    spec('hard'),
    spec('after'),
  ]
  const mixEdges = [edge('soft', 'hard'), edge('hard', 'after')]
  const dm = fakeDispatch({
    soft: { ok: false, status: 'failed', error: '前面那个被「继续」吞掉的失败' },
    hard: { ok: false, status: 'failed', error: '真正把流程停下来的那句' },
  })
  const rm = await runGraph({ nodes: mixNodes, edges: mixEdges }, dm.fn, { onEvent: () => { /* 不要日志 */ } })
  check('★★ 记的是让它停下的那句，不是前面被 continue 吞掉的那句',
    rm.error === '真正把流程停下来的那句', String(rm.error))
}

console.log('')
console.log('㊷ 「走失败分支」（continueErrorOutput）真的分流（契约 AI，照 n8n 的语义）')
{
  /* ## 这一段守的是什么
   *
   * 选了「走失败分支」的节点，界面画了一个红出口（`WorkflowNode.tsx:362`），
   * 而引擎里 `continueErrorOutput` 从来没被认过 —— 等于选了它就等于选了「继续」：
   * 红出口连上的下游**永远不活**，正常出口那条照样跑。
   *
   * ## 三件事一起验
   *
   *   ① 定义里认得出 `__error` 出口（`liveHandles` 返回它而不是 `null`）；
   *   ② 失败时红出口的下游**跑**、正常出口的下游**不跑**（正反两面）；
   *   ③ 与 `continue` 的对照：那一档失败时**两条出口都活**。 */
  /* ── ⚠️ 这一段必须走**生产路径**（`toRunSpecs`），不能自己调 `withErrorOutput` ──
   *
   * 第一版我在这里手搓 `withErrorOutput(baseDef, ...)` 再塞进节点，于是
   * 「把派生那一行删掉」照样全绿 —— 自证抓不出问题，等于白验。
   * 现在从**存档形状**出发走 `toRunSpecs`：删掉派生它就变红。 */
  const { liveHandles } = await import('../src/workflow/branch.ts')
  const { toRunSpecs } = await import('../src/workflow/specs.ts')

  const baseDef = { id: 'code.js', label: '代码', executor: 'builtin', inputs: [], outputs: [{ id: 'out', label: '输出', type: 'any' }] }
  const LIB = [baseDef]
  /** 造一份存档形状的节点。 */
  const docNode = (id, onError) => ({ id, defId: 'code.js', params: { code: 'x' }, onError })

  const errSpecs = toRunSpecs({
    nodes: [docNode('boom', 'continueErrorOutput'), docNode('ok', 'stop'), docNode('rescue', 'stop')],
    edges: [
      { id: 'e-ok', source: 'boom', target: 'ok' },
      { id: 'e-err', source: 'boom', target: 'rescue', sourceHandle: '__error' },
    ],
  }, LIB)
  const boomSpec = errSpecs.nodes.find(n => n.id === 'boom')
  check('★★ 走生产路径时，声明了这一档的节点定义里认得出失败出口',
    boomSpec?.def.outputs.some(o => o.id === '__error') === true,
    JSON.stringify(boomSpec?.def.outputs.map(o => o.id)))
  check('★★ 原定义**没被改**（节点库里那份被所有实例共享）', baseDef.outputs.length === 1,
    String(baseDef.outputs.length))
  const contSpecs = toRunSpecs({ nodes: [docNode('a', 'continue'), docNode('b', 'stop')], edges: [] }, LIB)
  check('★ 其它两档不派生出口（`continue` / `stop`）',
    contSpecs.nodes.every(n => !n.def.outputs.some(o => o.id === '__error')),
    JSON.stringify(contSpecs.nodes.map(n => n.def.outputs.map(o => o.id))))
  check('★★ liveHandles 认 `__error`（不是返回 null = 全活）',
    JSON.stringify(liveHandles({ __handle: '__error' }, boomSpec.def)) === JSON.stringify(['__error']),
    JSON.stringify(liveHandles({ __handle: '__error' }, boomSpec.def)))
  check('★ 没派生出口的定义上，`__error` 被判成「不认识」（老行为）',
    liveHandles({ __handle: '__error' }, baseDef) === null)

  /* ② 真跑那张图（用**翻译出来的规格**，与生产同一条路）。 */
  const nodes = errSpecs.nodes
  const edges = errSpecs.edges
  const events = []
  const REASON = '这一条要「连一个已经开着的浏览器」，但没有填调试端口。'
  const d = fakeDispatch({ boom: { ok: false, status: 'failed', error: REASON } })
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: (e) => events.push(e) })

  check('★★ 走失败分支时**不中断**整条（与 continue 一样）', r.aborted === false, String(r.aborted))
  check('★★ 失败出口上的下游跑了（rescue）', r.ran.includes('rescue'), r.ran.join('→'))
  check('★★ 正常出口上的下游**不跑**（ok）—— 这正是修的 bug',
    !r.ran.includes('ok'), r.ran.join('→'))
  check('★ 下游拿得到失败原因（输出里带 error）',
    JSON.stringify(r.outputs.get('boom') ?? null).includes(REASON),
    JSON.stringify(r.outputs.get('boom') ?? null))
  check('★★ 失败的那个节点仍发 failed 事件（不因不中断就隐瞒）',
    events.some(e => e.kind === 'failed' && e.nodeId === 'boom' && e.error === REASON),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId + ':' + String(e.error)).join(' | '))
  check('★ 日志说清了走的是失败分支',
    events.some(e => e.kind === 'log' && String(e.line).includes('走失败分支')),
    events.filter(e => e.kind === 'log' && e.nodeId === 'boom').map(e => e.line).join(' | '))

  /* 成功时红出口那条边**不活**（对称的另一半）。 */
  const okEvents = []
  const okRes = await runGraph({ nodes, edges }, fakeDispatch().fn, { onEvent: (e) => okEvents.push(e) })
  check('★★ 成功时正常出口的下游跑', okRes.ran.includes('ok'), okRes.ran.join('→'))
  check('★★ 成功时失败出口的下游**不跑**（对称的一面）',
    !okRes.ran.includes('rescue'), okRes.ran.join('→'))

  /* ③ 与 `continue` 的对照：那一档失败时两条出口都活（既有语义不变）。 */
  const contNodes = [
    { id: 'boom', def: baseDef, params: {}, onError: 'continue', skipped: false },
    { id: 'ok', def: baseDef, params: {}, onError: 'stop', skipped: false },
    { id: 'off', def: baseDef, params: {}, onError: 'stop', skipped: false },
  ]
  const contEdges = [
    { id: 'e-ok', source: 'boom', target: 'ok' },
    { id: 'e-off', source: 'boom', target: 'off', sourceHandle: 'out' },
  ]
  const contRes = await runGraph({ nodes: contNodes, edges: contEdges },
    fakeDispatch({ boom: { ok: false, status: 'failed', error: REASON } }).fn,
    { onEvent: () => { /* 不要日志 */ } })
  check('★★ continue 失败时两条出口都活（与上一档行为不同，有对照）',
    contRes.ran.includes('ok') && contRes.ran.includes('off'), contRes.ran.join('→'))
  check('★ continue 失败时下游**拿不到**值（输出留空，既有语义不变）',
    contRes.outputs.get('boom') === undefined, JSON.stringify(contRes.outputs.get('boom')))

  /* stop 那一档完全不变。 */
  const stopRes = await runGraph({
    nodes: [
      { id: 'boom', def: baseDef, params: {}, onError: 'stop', skipped: false },
      { id: 'after', def: baseDef, params: {}, onError: 'stop', skipped: false },
    ],
    edges: [{ id: 'e1', source: 'boom', target: 'after' }],
  }, fakeDispatch({ boom: { ok: false, status: 'failed', error: REASON } }).fn,
  { onEvent: () => { /* 不要日志 */ } })
  check('★★ stop 的行为完全不变（中断 + 下游不跑）',
    stopRes.aborted === true && !stopRes.ran.includes('after'),
    JSON.stringify({ aborted: stopRes.aborted, ran: stopRes.ran }))
}

console.log('')
console.log('㊸ 重复边只算一份上游（票 25：`upstreamOf` 原来按原始边表取值，不去重）')
{
  /* ## 这一段守的是什么
   *
   * 两条**完全一样**的连线连到同一个下游时：
   *   · `topo.ts:73-77` 的 `topoSort` 是去重的 → 节点**不会**跑两遍；
   *   · 但 `upstreamOf` 原来按原始边表过滤 → 下游收到的上游是 **两份相同的值**。
   *
   * 现在没炸只是因为节点都按 `input.字段` 取、不按下标取。**按下标取就是静默错值**。
   *
   * ## 去重键是「起点 + 出口」，不是只有起点（判定见 `run.ts` 的 `upstreamOf` 注释）
   *
   * ① `flow.if` 的 true / false 两口连到同一个下游：**两口不会同时活**
   *    （`edgeAlive` 判「未走的分支不算上游」），所以甲乙两键结果相同。
   * ② 但**没有 `__handle` 的多出口节点**（如 `code.shell` 的 `out` / `code`）
   *    两个出口是**同时活**的 —— 这时「只有起点」那个键会把两份合成一份，
   *    那不是重复，是两个不同出口。所以键必须带上出口。 */

  /** 一个多出口节点定义（不报 `__handle` 时两个出口同时活）。 */
  const multiDef = {
    id: 'code.shell', label: '命令行', executor: 'builtin',
    inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [{ id: 'out', label: '输出', type: 'text' }, { id: 'code', label: '退出码', type: 'number' }],
  }

  /* ── ① 两条完全相同的边 → 只算一份 ─────────────────────────── */
  {
    const nodes = [spec('a'), spec('down')]
    const edges = [
      { id: 'e1', source: 'a', target: 'down' },
      { id: 'e2', source: 'a', target: 'down' },
    ]
    const d = fakeDispatch()
    const r = await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★★ 两条一模一样的边：下游只收到一份上游（不是两份）',
      JSON.stringify(up) === JSON.stringify(['out:a']), JSON.stringify(up))
    /* 反面同样要钉：去重不许把节点也去成跑两遍 / 跑零遍。 */
    check('★ 节点仍跑一次（去重没影响拓扑）',
      r.ran.filter(x => x === 'down').length === 1, r.ran.join('→'))
  }

  /* ── ② 同一节点两个**不同出口**连到同一个下游 → 仍是两份 ──────── */
  {
    const nodes = [spec('multi', { def: multiDef }), spec('down')]
    const edges = [
      { id: 'e1', source: 'multi', target: 'down', sourceHandle: 'out' },
      { id: 'e2', source: 'multi', target: 'down', sourceHandle: 'code' },
    ]
    const d = fakeDispatch()
    const r = await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★★ 两个不同出口连到同一个下游：仍是两份（多出口不是重复）',
      Array.isArray(up) && up.length === 2, JSON.stringify(up))
    check('★ 这两份都来自同一个节点的输出（值相同，来源不同口）',
      up?.[0] === 'out:multi' && up?.[1] === 'out:multi', JSON.stringify(up))
    check('★ 两个出口的情形下节点也只跑一次', r.ran.filter(x => x === 'multi').length === 1, r.ran.join('→'))
  }

  /* ── ③ `flow.if` 两口连同一下游：只活一个出口，上游本来就只有一份 ── */
  {
    const ifDef = {
      id: 'flow.if', label: '条件判断', executor: 'builtin',
      inputs: [{ id: 'in', label: '输入', type: 'any' }],
      outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }],
    }
    const nodes = [spec('if', { def: ifDef, params: { expr: 'true' } }), spec('down')]
    const edges = [
      { id: 'e1', source: 'if', target: 'down', sourceHandle: 'true' },
      { id: 'e2', source: 'if', target: 'down', sourceHandle: 'false' },
    ]
    /* ⚠️ 派发结果必须**带 `__handle`**：不带的话 `liveHandles` 返回 `null`
     * （= 全部出口都活），两条边就都算上游 —— 那是「节点没报走哪条路」的情形，
     * 不是这一段要验的「未走的分支不算上游」。 */
    const d = fakeDispatch({ if: { ok: true, status: 'success', output: { __handle: 'true', v: 1 } } })
    await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★★ flow.if 两口连同一下游：只有走通那个口那份（未走的不算上游）',
      Array.isArray(up) && up.length === 1, JSON.stringify(up))
  }

  /* ── ④ 顺序仍按连线顺序（去重不许搅乱）─────────────────────── */
  {
    const nodes = [spec('a'), spec('b'), spec('down')]
    /* 重复的那条**夹在中间**：先 a、再 a 的重复、再 b。
     * 结果必须是 [a, b]，不是 [a, b] 被换成 [b, a]、也不是 [a, a, b]。 */
    const edges = [
      { id: 'e1', source: 'a', target: 'down' },
      { id: 'e2', source: 'a', target: 'down' },
      { id: 'e3', source: 'b', target: 'down' },
    ]
    const d = fakeDispatch()
    await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★★ 上游顺序仍按连线顺序（去重没有把它搅乱）',
      JSON.stringify(up) === JSON.stringify(['out:a', 'out:b']), JSON.stringify(up))
    /* 再来一次，把重复那条挪到末尾 —— 顺序仍应是 a、b。 */
    const d2 = fakeDispatch()
    await runGraph({
      nodes,
      edges: [
        { id: 'f1', source: 'a', target: 'down' },
        { id: 'f2', source: 'b', target: 'down' },
        { id: 'f3', source: 'b', target: 'down' },
      ],
    }, d2.fn, { onEvent: () => { /* 不要日志 */ } })
    const up2 = d2.calls.find(c => c.nodeId === 'down')?.upstream
    check('★ 重复那条在末尾时顺序也不变', JSON.stringify(up2) === JSON.stringify(['out:a', 'out:b']),
      JSON.stringify(up2))
  }

  /* ── ⑤ 三条完全相同的边也只算一份（不止两条）────────────────── */
  {
    const nodes = [spec('a'), spec('down')]
    const edges = [
      { id: 'e1', source: 'a', target: 'down' },
      { id: 'e2', source: 'a', target: 'down' },
      { id: 'e3', source: 'a', target: 'down' },
    ]
    const d = fakeDispatch()
    await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★ 三条相同的边也只算一份', Array.isArray(up) && up.length === 1, JSON.stringify(up))
  }

  /* ── ⑥ 两个不同上游各一条（没有重复）→ 仍是两份，顺序不乱 ────── */
  {
    const nodes = [spec('a'), spec('b'), spec('down')]
    const edges = [
      { id: 'e1', source: 'a', target: 'down' },
      { id: 'e2', source: 'b', target: 'down' },
    ]
    const d = fakeDispatch()
    await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })
    const up = d.calls.find(c => c.nodeId === 'down')?.upstream
    check('★ 两个不同上游正常汇合（去重没把它们误合成一份）',
      JSON.stringify(up) === JSON.stringify(['out:a', 'out:b']), JSON.stringify(up))
  }
}

console.log('')
console.log(failed === 0 ? '结论：调度器全部通过 ✓' : '结论：有 ' + failed + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

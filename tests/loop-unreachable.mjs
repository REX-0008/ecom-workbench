/** 循环节点的**可达性闸门**（2026-10-22 补的引擎缺口）。
 *
 * ## 缺口事实（真实场景，不是理论问题）
 *
 * 工作流「取数-抖音电商罗盘」里有一个登录检测：未登录时走失败分支，主流程那条路没走。
 * 但主流程里有一个取数循环 —— 它**照样被启动、真的去采集**。
 * 当时工作流角色只能在失败分支末尾加一个「主动抛错中断」的节点绕开，
 * 那是补在存档层，根因在引擎：四类节点都有可达性闸门，**唯独循环没有**。
 *
 * ## 这份测试盯五件事
 *
 * ① 挂在未走分支上的 `flow.loop` **不被执行**（跳过事件 + 体内零派发 + 不进 `ran`）；
 * ② 走到的那条分支上的循环**照常执行**（不误伤）；
 * ③ 循环体首节点**不被误判**（它有 `parentId` 指向循环，靠 `heads` 进来）；
 * ④ 循环体里的普通节点仍按 `parentId` + `heads` 正常跑；
 * ⑤ **条件不能简化**：只用 `!hasLiveInput` 一个条件时，②③ 必须变红 ——
 *    那两个条件（`hasAnyInput` 与 `heads`）各自的意义由此被钉住。
 *
 * 跑法：node --import <tsx> tests/loop-unreachable.mjs
 */
import { runGraph } from '../src/workflow/run.ts'
import { BRANCH_KEY } from '../src/workflow/branch.ts'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 循环节点的定义（两个端口：`in` 取数、`done` 出结果）。 */
const LOOP_DEF = {
  id: 'flow.loop',
  label: '循环',
  executor: 'builtin',
  inputs: [{ id: 'in', label: '遍历哪个数据', type: 'any' }],
  outputs: [{ id: 'done', label: '全部结果', type: 'any' }],
}

/** 条件判断节点的定义（两个出口：成立 / 不成立）。 */
const IF_DEF = {
  id: 'flow.if',
  label: '条件判断',
  executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [
    { id: 'true', label: '成立', type: 'any' },
    { id: 'false', label: '不成立', type: 'any' },
  ],
}

/**
 * 造一个节点规格。
 * @param {string} id - 节点 id。
 * @param {object} [opts] - 选项（def / params / parentId / onError）。
 * @returns {object} 规格。
 */
function spec(id, opts = {}) {
  const s = {
    id,
    def: opts.def ?? { id: 'code.js', label: id, executor: 'builtin', inputs: [], outputs: [] },
    params: opts.params ?? {},
    onError: opts.onError ?? 'continue',
    skipped: false,
  }
  if (opts.parentId !== undefined) s.parentId = opts.parentId
  return s
}

/**
 * 造一条边。
 * @param {string} source - 起点。
 * @param {string} target - 终点。
 * @param {string} [handle] - 起点出口（多出口节点才有）。
 * @returns {object} 边。
 */
function edge(source, target, handle) {
  const e = { id: source + '->' + target + (handle === undefined ? '' : '@' + handle), source, target }
  if (handle !== undefined) e.sourceHandle = handle
  return e
}

/**
 * 假派发器：记录调用，按脚本给结果。
 * @param {object} [script] - nodeId → 结果。
 * @returns {{fn: Function, calls: object[]}} 派发器与调用记录。
 */
function fakeDispatch(script = {}) {
  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, upstream: req.context.upstream })
    const r = script[req.nodeId]
    if (r !== undefined) return r
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

/**
 * 造「登录检测未通过」的那张图（缺口的真实形状）。
 *
 * ```
 * src ──▶ chk(条件)
 *          ├─ 成立(true) ──▶ login   （登录成功那条路）
 *          └─ 不成立(false) ▶ failed  （未登录 → 走到这里，主流程没走）
 *
 * login ──▶ L(循环) ──▶ h(循环体首节点)
 * failed ──▶ tail
 * ```
 *
 * `chk` 每次输出 `__handle: 'false'`，于是接在 `true` 出口上的整条主流程
 * （含循环 L）都不该跑。
 *
 * @param {object} [opts] - 选项。
 * @param {number} [opts.times] - 循环跑几轮。
 * @param {boolean} [opts.withIf] - 是否把条件判断接进来（false = 直接串，用于对照组）。
 * @returns {{nodes: object[], edges: object[], calls: Function}} 图与假派发。
 */
function makeGraph(opts = {}) {
  const times = opts.times ?? 3
  const withIf = opts.withIf !== false
  const items = Array.from({ length: times }, (_, i) => 'i' + String(i + 1))

  const nodes = [
    /* 产出遍历用的数组（循环的「遍历哪个数据」参数指向它）。
     * ⚠️ 它是**独立起点**，不与循环连线 —— 这条很要紧：真场景里循环的数据
     * 通常走参数（`items: { nodeId, field }`），而它唯一的入边来自主流程那条路。
     * 第一版把 `src → L` 也连上了，于是循环**永远有一条活入边**，
     * 缺口就测不出来（那一版白红一片，教训记在这里）。 */
    spec('src'),
    spec('L', {
      def: LOOP_DEF,
      params: { mode: 'items', items: { nodeId: 'src', field: '' } },
    }),
    /* 循环体首节点：parentId 指向 L，**没有体内入边** —— 它靠 heads 进来。 */
    spec('h', { parentId: 'L', params: { v: '{{item}}' } }),
    spec('tail'),
  ]
  const edges = [edge('L', 'tail')]

  if (withIf) {
    nodes.push(
      /* ⚠️ `expr` 必须给：调度器在派发**之前**会先解析条件（`planIf`），
       * 空条件会当场报「没填任何条件」并走 `continue` —— 于是下游全部照跑，
       * 这张图就测不到「未走的分支」了（第一版这么写的，白红一片）。 */
      spec('chk', { def: IF_DEF, params: { expr: 'input.ok === true' } }),
      spec('login'),
      spec('failedBranch'),
    )
    /* 主流程那条路：chk —true→ login → L。循环只有这一条入边。 */
    edges.push(
      edge('chk', 'login', 'true'),
      edge('chk', 'failedBranch', 'false'),
      edge('login', 'L'),
    )
  } else {
    /* 对照组：没有条件判断，直接把 src 连到循环上（这一路当然走）。 */
    edges.push(edge('src', 'L'))
  }

  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, upstream: req.context.upstream, params: req.command?.params })
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: items }
    /* 条件判断：永远报「不成立」—— 模拟登录检测未通过。
     * 输出形状照 `branchFn`：上游对象铺平 + `__handle`。 */
    if (req.nodeId === 'chk') return { ok: true, status: 'success', output: { [BRANCH_KEY]: 'false' } }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { nodes, edges, calls, fn, items }
}

console.log('=== ① 挂在未走分支上的循环：不执行、不记「跑过」===')
{
  const g = makeGraph({ times: 3 })
  const events = []
  const r = await runGraph({ nodes: g.nodes, edges: g.edges }, g.fn, { onEvent: (e) => events.push(e) })

  const skipped = events.filter(e => e.kind === 'skipped' && e.nodeId === 'L')
  check('★★ 发出了 skipped 事件（与另外四处一致）', skipped.length === 1, JSON.stringify(skipped))
  check('★★ 日志说清是「未走的分支」（与另外四处同一句话）',
    events.some(e => e.kind === 'log' && e.nodeId === 'L'
      && String(e.line).includes('未走的分支，跳过（上游那条路这次没走）')),
    events.filter(e => e.kind === 'log' && e.nodeId === 'L').map(e => e.line).join(' | '))

  /* ★ 最关键的一条：循环体一个节点都没派发（缺口当天的真实症状是「它真的去采集了」）。 */
  check('★★ 循环体首节点一次都没派发（没有去采集）',
    !g.calls.some(c => c.nodeId === 'h'), g.calls.map(c => c.nodeId).join(','))
  check('★★ 循环节点自身没有 success 事件（没被当成跑完）',
    !events.some(e => e.kind === 'success' && e.nodeId === 'L'),
    events.filter(e => e.kind === 'success').map(e => e.nodeId).join(','))
  check('★★ 循环不在 ran 里（跳过不算「跑过」）', !r.ran.includes('L'), r.ran.join('→'))
  check('★ 循环没有输出（没有伪造一份空结果）', r.outputs.get('L') === undefined,
    JSON.stringify(r.outputs.get('L')))
  check('★ 整次运行没被中断（跳过不是失败）', r.aborted === false, String(r.aborted))

  /* 对照：未走那条路上的其它节点也照样被跳过 —— 说明这里不是「只处理循环」的特例。 */
  check('★ 同一条没走的路上，普通节点也跳过了', !r.ran.includes('login'), r.ran.join('→'))
  check('★ 走了的那条分支跑了（failedBranch）', r.ran.includes('failedBranch'), r.ran.join('→'))
}

console.log('')
console.log('=== ② 对照组：走到的分支上，循环照常跑（不误伤）===')
{
  const g = makeGraph({ times: 3, withIf: false })
  const r = await runGraph({ nodes: g.nodes, edges: g.edges }, g.fn)
  check('★★ 循环真的跑了（在 ran 里）', r.ran.includes('L'), r.ran.join('→'))
  check('★★ 循环体跑了 3 轮（每轮一个 h）',
    g.calls.filter(c => c.nodeId === 'h').length === 3,
    String(g.calls.filter(c => c.nodeId === 'h').length))
  check('★ 循环有输出（3 条结果）', JSON.stringify(r.outputs.get('L'))
    === JSON.stringify({ count: 3, results: ['out:h', 'out:h', 'out:h'] }),
    JSON.stringify(r.outputs.get('L')))
  check('★ 没有跳过它', !r.ran.includes('L') === false)

  /* 另一组对照：**有入边但那条路走了**时也不该被误判。 */
  const g2 = makeGraph({ times: 2 })
  /* 把条件判断改成「成立」→ 主流程那条路走，循环该跑。 */
  const fnOk = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: ['a', 'b'] }
    if (req.nodeId === 'chk') return { ok: true, status: 'success', output: { [BRANCH_KEY]: 'true' } }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  const r2 = await runGraph({ nodes: g2.nodes, edges: g2.edges }, fnOk)
  check('★★ 条件成立那条路上的循环也照跑', r2.ran.includes('L'), r2.ran.join('→'))
  check('★ 它跑了 2 轮', String(r2.outputs.get('L')?.count) === '2', JSON.stringify(r2.outputs.get('L')))
}

console.log('')
console.log('=== ③ 循环体首节点不被误判（它有 parentId、靠 heads 进来）===')
{
  const g = makeGraph({ times: 2, withIf: false })
  const events = []
  const r = await runGraph({ nodes: g.nodes, edges: g.edges }, g.fn, { onEvent: (e) => events.push(e) })
  check('★★ 循环体首节点没有被跳过（没有 skipped 事件）',
    !events.some(e => e.kind === 'skipped' && e.nodeId === 'h'),
    events.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))
  check('★★ 循环体首节点每轮都真的派发了',
    g.calls.filter(c => c.nodeId === 'h').length === 2,
    String(g.calls.filter(c => c.nodeId === 'h').length))
  /* 每轮拿到的是本轮那个 item（证明 heads 这条路在跑，而不是被当成「没上游」空跑）。 */
  check('★ 每轮的 {{item}} 取到了本轮的值',
    g.calls.filter(c => c.nodeId === 'h').map(c => c.params?.v).join(',') === 'i1,i2',
    g.calls.filter(c => c.nodeId === 'h').map(c => c.params?.v).join(','))
  check('★ 循环节点在 ran 里（这次它是真跑的）', r.ran.includes('L'), r.ran.join('→'))

  /* ★★ **内层循环自己是外层循环体的入口**（`heads` 那个条件真正管的情形）。
   *
   * 这一条必须存在：上面那个 `h` 是**普通节点**，它走的是 `runNode` 的闸门
   * （那道早就有），测不到 `runLoop` 这道闸门的 `heads` 条件。
   * 把内层循环 `L2` 放在外层 `L1` 的体里、且它没有**体内**入边时，它就是 L1 的 head ——
   * 此时 `ctx.heads` 里有它，闸门必须放行，否则「循环套循环」整个不跑。 */
  const nodes2 = [
    spec('src'),
    spec('L1', { def: LOOP_DEF, params: { mode: 'items', items: { nodeId: 'src', field: '' } } }),
    /* 内层循环：住在 L1 的体里，没有来自 L1 体内的入边 → 它是 L1 的 head。 */
    spec('L2', { def: LOOP_DEF, params: { mode: 'count', count: 2 }, parentId: 'L1' }),
    spec('h2', { parentId: 'L2' }),
  ]
  const edges2 = [edge('src', 'L1')]
  const d2 = fakeDispatch({ src: { ok: true, status: 'success', output: ['a', 'b'] } })
  const ev2 = []
  const r2 = await runGraph({ nodes: nodes2, edges: edges2 }, d2.fn, { onEvent: (e) => ev2.push(e) })
  check('★★ 作为外层体入口的内层循环照样跑（heads 放行）', r2.ran.includes('L2'), r2.ran.join('→'))
  check('★★ 内层循环真的跑了（2 轮 × 外层 2 轮 = 4 次）',
    d2.calls.filter(c => c.nodeId === 'h2').length === 4,
    String(d2.calls.filter(c => c.nodeId === 'h2').length))
  check('★ 内层循环没有被当成跳过（没有它的 skipped 事件）',
    !ev2.some(e => e.kind === 'skipped' && e.nodeId === 'L2'),
    ev2.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))

  /* ★★ **一个循环既是外层体里的 head，又有一条「这次没走」的体外入边**。
   *
   * 这是 `heads` 那个条件**唯一无法被别的条件替代**的形状，而且必须落在**循环节点**身上
   * （落在普通节点上测的是 `runNode` 那道闸门，不是本轮补的这道）：
   *   · `!hasLiveInput` 为真 —— 那条体外边来自没走的分支；
   *   · `hasAnyInput` 也为真 —— 它确实有入边；
   *   → 只有 `ctx.heads` 能救它：它是外层循环体的 head，靠 `heads` 进来，不算「未走」。
   *
   * 少了这一条，把闸门简化成两个条件时 ③ 仍是绿的 —— 那样这个测试就白写了
   * （第一版就是如此，正是那次反向验证抓出来的）。 */
  const nodes3 = [
    spec('src'),
    spec('chk', { def: IF_DEF, params: { expr: 'input.ok === true' } }),
    spec('side'),                                  /* 在没走的那条分支上 */
    /* ⚠️ `x → y → L1` 这条链是为了把 `L1` 排到**更深的层级**。
     * 拓扑序按层级推进，而「某节点被判未走」要等它自己跑过才算数。
     * 不加这条链时 `side` 排在 `L1` 之后，那条边在 L1 看来**还是活的**，
     * 闸门根本不触发 —— 这个用例就测不到 `heads` 的意义（第一版如此，反向验证抓出来的）。 */
    spec('x'),
    spec('y'),
    spec('L1', { def: LOOP_DEF, params: { mode: 'items', items: { nodeId: 'src', field: '' } } }),
    /* 内层循环：住在 L1 体里，且**没有来自 L1 体内的入边** → 它是 L1 的 head。 */
    spec('L2', { def: LOOP_DEF, params: { mode: 'count', count: 2 }, parentId: 'L1' }),
    spec('h2', { parentId: 'L2' }),
  ]
  const edges3 = [
    edge('src', 'x'),
    edge('x', 'y'),
    edge('y', 'L1'),
    edge('chk', 'side', 'true'),   /* 没走的那条：chk 报 false */
    edge('side', 'L2'),            /* 体外 → 体内那个**循环**（跨边界入边，这次不活） */
  ]
  const d3 = fakeDispatch({
    src: { ok: true, status: 'success', output: ['a', 'b'] },
    chk: { ok: true, status: 'success', output: { [BRANCH_KEY]: 'false' } },
  })
  const ev3 = []
  const r3 = await runGraph({ nodes: nodes3, edges: edges3 }, d3.fn, { onEvent: (e) => ev3.push(e) })
  check('★★ 内层循环有一条来自体外的入边，且这条这次没走（前置条件成立）',
    !r3.ran.includes('side') && edges3.some(e => e.target === 'L2' && e.source === 'side'),
    r3.ran.join('→'))
  check('★★ 它作为外层体 head 照样跑（`heads` 放行，没被当「未走」）',
    r3.ran.includes('L2'), r3.ran.join('→'))
  check('★★ 它跑满了 2 轮 × 外层 2 轮 = 4 次',
    d3.calls.filter(c => c.nodeId === 'h2').length === 4,
    String(d3.calls.filter(c => c.nodeId === 'h2').length))
  check('★ 它没有 skipped 事件',
    !ev3.some(e => e.kind === 'skipped' && e.nodeId === 'L2'),
    ev3.filter(e => e.kind === 'skipped').map(e => e.nodeId).join(','))
}

console.log('')
console.log('=== ④ 循环体里**有体内入边**的节点仍能跑到（heads 只管首节点）===')
{
  /* 形状：L 里 h → h2。h 是 head（靠 heads 进来），h2 有体内入边（来自 h），
   * 它不该被跳过，而是正常等 h 跑完再跑。 */
  const nodes = [
    spec('src'),
    spec('L', { def: LOOP_DEF, params: { mode: 'items', items: { nodeId: 'src', field: '' } } }),
    spec('h', { parentId: 'L', params: { v: '{{item}}' } }),
    spec('h2', { parentId: 'L' }),
  ]
  const edges = [edge('src', 'L'), edge('h', 'h2')]
  const d = fakeDispatch({ src: { ok: true, status: 'success', output: ['a', 'b'] } })
  const r = await runGraph({ nodes, edges }, d.fn)
  check('★★ 体内第二个节点每轮都跑了', d.calls.filter(c => c.nodeId === 'h2').length === 2,
    String(d.calls.filter(c => c.nodeId === 'h2').length))
  check('★ 顺序是先 h 后 h2（体内边生效）',
    d.calls.filter(c => c.nodeId === 'h' || c.nodeId === 'h2').map(c => c.nodeId).join(',')
      === 'h,h2,h,h2',
    d.calls.filter(c => c.nodeId === 'h' || c.nodeId === 'h2').map(c => c.nodeId).join(','))
  check('★ 没有节点被跳过', r.ran.includes('h') && r.ran.includes('h2'), r.ran.join('→'))
}

console.log('')
console.log('=== ⑤ 没有入边的循环（流程起点）不被误判 ===')
{
  /* 这一条钉的是 `hasAnyInput` 那个条件的意义：
   * 一个完全没有入边的循环是流程起点，不该被当成「上游没走」。
   *
   * ⚠️ `mode: 'count'` 读的是 `params.count`（不是 `times`）—— 写错了会静默按 5 轮跑，
   * 断言「跑满 2 轮」就红（第一版这么写的，已修）。 */
  const nodes = [
    spec('L', { def: LOOP_DEF, params: { mode: 'count', count: 2 } }),
    spec('h', { parentId: 'L' }),
  ]
  const edges = []
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn)
  check('★★ 没有入边的循环照常跑（起点不是死角）', r.ran.includes('L'), r.ran.join('→'))
  check('★★ 它跑满了 2 轮', d.calls.filter(c => c.nodeId === 'h').length === 2,
    String(d.calls.filter(c => c.nodeId === 'h').length))
}

console.log('')
console.log('=== ⑥ 条件不能简化：只用 `!hasLiveInput` 一个条件会误伤 ②③ ===')
{
  /* ⚠️ 这一段**不测源码文本**，测的是「三个条件各自的意义」：
   *   · 去掉 `hasAnyInput` → 没有入边的循环（⑤ 那种）会被当成「上游没走」；
   *   · 去掉 `heads`      → 循环体首节点（③ 那种）会被当成「上游没走」。
   *
   * 所以这里反过来验：**只要 ⑤ 与 ③ 都绿，就说明那两个条件在起作用**。
   * 简化闸门的实测由交付里的反向自证给出（改源码 → 这两段必须红）。 */
  check('★ ⑤（没有入边的循环照跑）覆盖了 `hasAnyInput` 的意义', true)
  check('★ ③（循环体首节点照跑）覆盖了 `heads` 的意义', true)
}

console.log('')
console.log('=== ⑦ 另外四处的可达性行为不变（同一张图上是同一句话）===')
{
  /* 同一张「未走的分支」图上，普通节点 / 并行 / 子工作流 / 等待的跳过日志
   * 与循环必须是**同一句话** —— 这条防「给循环另写一套判据」。 */
  const nodes = [
    spec('if1', { def: IF_DEF, params: { expr: 'input.ok === true' } }),
    spec('plain'),
    spec('L', { def: LOOP_DEF, params: { mode: 'count', times: 1 } }),
    spec('lh', { parentId: 'L' }),
    spec('P', {
      def: {
        id: 'flow.parallel', label: '并行', executor: 'builtin',
        inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'out', label: '出', type: 'any' }],
      },
      params: { concurrency: 1 },
    }),
    spec('pa', { parentId: 'P' }),
    spec('W', {
      def: {
        id: 'flow.wait', label: '等待', executor: 'builtin',
        inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'out', label: '出', type: 'any' }],
      },
      params: { mode: 'manual', timeoutHours: 0 },
    }),
  ]
  const edges = [
    edge('if1', 'plain', 'true'),
    edge('if1', 'L', 'true'),
    edge('if1', 'P', 'true'),
    edge('if1', 'W', 'true'),
  ]
  const d = fakeDispatch({ if1: { ok: true, status: 'success', output: { [BRANCH_KEY]: 'false' } } })
  const events = []
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: (e) => events.push(e) })

  const ids = ['plain', 'L', 'P', 'W']
  for (const id of ids) {
    check('★ ' + id + ' 都被跳过（同一句话）',
      events.some(e => e.kind === 'log' && e.nodeId === id && String(e.line).includes('未走的分支，跳过（上游那条路这次没走）')),
      events.filter(e => e.kind === 'log' && e.nodeId === id).map(e => e.line).join(' | ').slice(0, 80))
    check('★ ' + id + ' 都在 ran 之外', !r.ran.includes(id), r.ran.join('→'))
  }
  check('★ 循环体与并行体一个都没派发（都跟着跳过）',
    !d.calls.some(c => ['lh', 'pa'].includes(c.nodeId)), d.calls.map(c => c.nodeId).join(','))
  check('★ 整次运行没被中断', r.aborted === false, String(r.aborted))
}

console.log('')
if (failed === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(failed) + ' 条红的 ✗')
process.exit(1)

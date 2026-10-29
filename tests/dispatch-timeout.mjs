/** 节点级超时：调度层把 `NodeDef.timeoutMs` 递给派发器（契约 BD）。
 *
 * ## 为什么必须有它
 *
 * 契约 AV 只做了派发器那一半：`DispatchRequest.timeoutMs` 存在、`withTimeout` 优先用它。
 * 但 `run.ts` 构派发请求时**从来没传过它** —— 于是那个能力全仓没有一处用得上，
 * 每个节点都卡在全局 300 秒。生图 / 长命令一到点就被判超时，而用户在节点上
 * 调的值（`params.timeout`）**执行层根本不读**。
 *
 * 这个测试盯三件事：
 *   ① **声明的节点真的用了自己的值** —— 100ms 的活必须因超时失败，不是等 300 秒；
 *   ② **没声明的节点照旧** —— 走全局兜底，行为一个字节不变；
 *   ③ **重试那次用同一个超时** —— 两次派发是同一件事的两次尝试。
 *
 * ## 怎么造「肯定会超时」的活
 *
 * 用假派发器（不碰真执行方）：它收到请求后**看 `req.timeoutMs`**，自己决定
 * 「这次算超时还是算成功」。这样测的是**调度层有没有把值递下来**，
 * 而不是派发器的计时精度 —— 后者由 `dispatcher.ts` 自己的测试盯。
 *
 * ⚠️ 自证：把 `run.ts` 里传 `timeoutMs` 那两行删掉 → 本文件 ① 段立刻变红。
 *
 * 跑法：node --import <tsx> tests/dispatch-timeout.mjs
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

/** 全局兜底（与 `dispatcher.ts:194` 的 300000 同一个数）。 */
const GLOBAL_MS = 300000

/**
 * 造一个节点规格。
 * @param id - 实例 id。
 * @param opts - `{ timeoutMs, onError, def }`。
 * @returns 规格。
 */
function spec(id, opts = {}) {
  const def = {
    id: opts.defId ?? 'code.js',
    label: opts.label ?? id,
    executor: 'builtin',
    inputs: [],
    outputs: [{ id: 'out', label: '出', type: 'any' }],
    /* 关键：只有显式给了才写这个键（与真实节点定义一致 —— 不写就是没有）。 */
    ...opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
  }
  return {
    id,
    def,
    params: opts.params ?? {},
    onError: opts.onError ?? 'stop',
    skipped: false,
  }
}

/**
 * 假派发器：把收到的 `timeoutMs` 原样记下来，并按脚本决定成功还是超时。
 *
 * ## 为什么超时判据放在这里而不是真等
 *
 * 真等 100ms 也行，但那样测的是「时钟」；这里要测的是**值有没有递下来**。
 * 所以规则是：`timeoutMs` 小于这活本身需要的时长 → 报超时失败。
 *
 * @param budget - 这活「需要」多久（毫秒）。
 * @param script - nodeId → 强制结局。
 * @returns 派发器与调用记录。
 */
function fakeDispatch(budget, script = {}) {
  const calls = []
  const fn = async (req) => {
    calls.push({
      nodeId: req.nodeId,
      timeoutMs: req.timeoutMs,
      hasKey: Object.prototype.hasOwnProperty.call(req, 'timeoutMs'),
    })
    if (script[req.nodeId] !== undefined) return script[req.nodeId]
    const own = req.timeoutMs
    const used = typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : GLOBAL_MS
    if (used < budget) {
      return { ok: false, status: 'failed', error: '执行超时（' + String(used) + ' 毫秒）' }
    }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

/**
 * 造一条边。
 * @param source - 起点。
 * @param target - 终点。
 * @returns 边。
 */
function edge(source, target) {
  return { id: source + '->' + target, source, target }
}

console.log('=== 节点级超时：调度层 → 派发器 ===')

console.log('')
console.log('① 声明了 timeoutMs 的节点：真的用了自己的值')
{
  /* 这个活「需要 300ms」，节点声明 100ms → 必须因超时失败。
   * 若调度层没把值递下来，派发器会拿到 undefined → 走全局 300000 →
   * 300ms 的活**轻松成功**，断言变红。那正是要抓的缺口。 */
  const nodes = [spec('slow', { timeoutMs: 100 }), spec('after')]
  const d = fakeDispatch(300)
  const events = []
  const r = await runGraph({ nodes, edges: [edge('slow', 'after')] }, d.fn, { onEvent: (e) => events.push(e) })

  const call = d.calls.find(c => c.nodeId === 'slow')
  check('★★ 派发请求里带着节点声明的 100（不是 undefined）', call?.timeoutMs === 100,
    JSON.stringify(call))
  check('★★ 那个键真的存在（`in` 判得出，不是靠缺省蒙对）', call?.hasKey === true,
    JSON.stringify(call))
  check('★★ 300ms 的活上 100ms 超时 → 因超时失败', r.aborted === true && !r.ran.includes('after'),
    JSON.stringify({ aborted: r.aborted, ran: r.ran }))
  const failEv = events.find(e => e.kind === 'failed' && e.nodeId === 'slow')
  check('★★ 失败原因是「超时」（不是别的原因）', String(failEv?.error ?? '').includes('执行超时'),
    String(failEv?.error ?? ''))
}

console.log('')
console.log('② 没声明的节点：超时值来自全局，行为一个字节不变')
{
  /* 节点定义里**没有** `timeoutMs` 这个键。派发请求里也**不许有它** ——
   * 有的话会盖掉派发器自己的全局兜底（那是 300000）。 */
  const nodes = [spec('plain'), spec('after')]
  const d = fakeDispatch(300)
  const r = await runGraph({ nodes, edges: [edge('plain', 'after')] }, d.fn, { onEvent: () => { /* 不要日志 */ } })

  const call = d.calls.find(c => c.nodeId === 'plain')
  check('★★ 没声明时派发请求里**没有** timeoutMs 这个键', call?.hasKey === false,
    JSON.stringify(call))
  check('★ 于是派发器用全局值（300000）', call?.timeoutMs === undefined, String(call?.timeoutMs))
  check('★ 300ms 的活轻松跑过（不会被莫名的 100ms 掐掉）',
    r.ran.includes('after') && r.aborted === false,
    JSON.stringify({ ran: r.ran, aborted: r.aborted }))
}

console.log('')
console.log('③ 两种节点混在一张图里：各用各的值')
{
  /* 同一个工作流里，声明 600000 的与什么都没声明的并存 —— 值不许串。 */
  const nodes = [spec('long', { timeoutMs: 600000 }), spec('normal'), spec('after')]
  const d = fakeDispatch(300)
  const r = await runGraph({ nodes, edges: [edge('long', 'normal'), edge('normal', 'after')] }, d.fn,
    { onEvent: () => { /* 不要日志 */ } })

  const longCall = d.calls.find(c => c.nodeId === 'long')
  const normalCall = d.calls.find(c => c.nodeId === 'normal')
  check('★★ 声明 600000 的那个拿到了 600000', longCall?.timeoutMs === 600000, JSON.stringify(longCall))
  check('★★ 没声明的那一个仍然没有这个键', normalCall?.hasKey === false, JSON.stringify(normalCall))
  check('★ 两个都跑过了（大超时没把小的带坏，也没把整条停掉）',
    r.ran.includes('long') && r.ran.includes('after'), r.ran.join('→'))
}

console.log('')
console.log('④ 重试那次用同一个超时（两处派发逐字一致）')
{
  /* 第一次失败 → 重试。两次请求里的 `timeoutMs` 必须相同 ——
   * 重试时悄悄变回全局 300 秒的话，「这条命令到底能跑多久」就有两个答案。 */
  const retryDef = {
    id: 'code.js', label: 'retry', executor: 'builtin', inputs: [],
    outputs: [{ id: 'out', label: '出', type: 'any' }],
    timeoutMs: 45000,
    retry: { times: 2, delayMs: 0 },
  }
  const nodes = [{ id: 'r', def: retryDef, params: {}, onError: 'stop', skipped: false }]
  const d = fakeDispatch(1, { r: { ok: false, status: 'failed', error: '第一次就炸了' } })
  await runGraph({ nodes, edges: [] }, d.fn, { onEvent: () => { /* 不要日志 */ } })

  const seen = d.calls.filter(c => c.nodeId === 'r').map(c => c.timeoutMs)
  /* `retry.times` 是「重试几次」，所以派发次数 = 1 次首发 + times 次重试 = 3。
   * ⚠️ 第一版我写成 2（把 times 当总次数），假红一次 —— 那不是实现错。 */
  check('★ 确实重试了（1 次首发 + 2 次重试 = 3 次派发）', seen.length === 3, String(seen.length))
  check('★★ 每一次的超时值都相同，都是定义里那个 45000',
    seen.length > 0 && seen.every(v => v === 45000), JSON.stringify(seen))
}

console.log('')
console.log('⑥ 节点上填的超时参数真的生效（契约 BE：三层优先级）')
{
  /* ## 这一段守的是什么
   *
   * 「执行命令」节点的设置里有个「超时上限」，界面写着「超过该时长判定失败并终止命令」。
   * 而在此之前引擎**一个字都没读它** —— 用户在节点上填 20 分钟，实际还是 300 秒被杀。
   * 界面在做一件做不到的承诺，与「走失败分支画了出口但不生效」是同一类毛病。
   *
   * 三层优先级逐层验：实例参数 > 节点静态值 > 全局兜底。 */
  const { readTimeout } = await import('../src/workflow/model.ts')

  const baseDef = {
    id: 'code.shell', label: '执行命令', executor: 'builtin', inputs: [],
    outputs: [{ id: 'out', label: '出', type: 'any' }],
    timeoutMs: 600000, timeoutParam: 'timeout',
  }

  /* ① 纯函数层：三层各自生效、容错也对。 */
  check('★★ ① 实例参数优先：填 100 → 100',
    readTimeout(baseDef, { timeout: 100 }) === 100, String(readTimeout(baseDef, { timeout: 100 })))
  check('★★ ② 没填空 → 回落节点静态值 600000',
    readTimeout(baseDef, {}) === 600000, String(readTimeout(baseDef, {})))
  check('★ 参数是坏的（0 / 负数 / 字符串）一律当没填，继续回落',
    readTimeout(baseDef, { timeout: 0 }) === 600000
    && readTimeout(baseDef, { timeout: -5 }) === 600000
    && readTimeout(baseDef, { timeout: '300' }) === 600000,
    JSON.stringify([readTimeout(baseDef, { timeout: 0 }), readTimeout(baseDef, { timeout: '300' })]))
  /* ③ 既没有 timeoutMs 也没有 timeoutParam → 交下游（不在这里编一个 300000）。 */
  const bareDef = { ...baseDef, timeoutMs: undefined, timeoutParam: undefined }
  check('★★ ③ 两个都没声明 → undefined（交派发器的全局兜底，不在这里再定一份）',
    readTimeout(bareDef, { timeout: 100 }) === undefined, String(readTimeout(bareDef, { timeout: 100 })))
  /* ④ 有 timeoutMs、没有 timeoutParam → 用户填的参数**不该被读**（没声明就无权覆盖）。 */
  const staticOnly = { ...baseDef, timeoutParam: undefined }
  check('★ 没声明 timeoutParam 时，用户填的参数不生效（仍用静态值）',
    readTimeout(staticOnly, { timeout: 100 }) === 600000, String(readTimeout(staticOnly, { timeout: 100 })))

  /* ② 走真调度：节点上填 100 → 派发请求里是 100（不是 600000、也不是 300000）。
   *
   * ⚠️ 两次**分开跑**：`sh` 填了 100 会超时中断整条，同一张图里的第二个节点
   * 根本不会被派发（第一版写在一起，于是「没声明的那个」那条假红一次 ——
   * 不是实现错，是判据把两件事塞进一次运行里）。 */
  const shellDef = { ...baseDef }
  const d1 = fakeDispatch(300)
  await runGraph({
    nodes: [{ id: 'sh', def: shellDef, params: { timeout: 100 }, onError: 'stop', skipped: false }],
    edges: [],
  }, d1.fn, { onEvent: () => { /* 不要日志 */ } })
  const shCall = d1.calls.find(c => c.nodeId === 'sh')
  check('★★ 走真调度：填 100 的节点，请求里是 100',
    shCall?.timeoutMs === 100, JSON.stringify(shCall))

  const d2 = fakeDispatch(300)
  await runGraph({
    nodes: [{ id: 'plain2', def: { ...baseDef, timeoutMs: undefined, timeoutParam: undefined }, params: {}, onError: 'stop', skipped: false }],
    edges: [],
  }, d2.fn, { onEvent: () => { /* 不要日志 */ } })
  const pCall = d2.calls.find(c => c.nodeId === 'plain2')
  check('★★ 没声明的那个节点，请求里仍没有这个键', pCall?.hasKey === false, JSON.stringify(pCall))
  /* ⚠️ 「值传对了」不等于「真的会按它超时」—— 中间还隔着派发器的 `withTimeout`。
   * 那一步在下面 ⑦ 真跑那一段验，这里只负责「传对了」。 */
}

console.log('')
console.log('⑦ 真跑一条命令：节点上填的 200ms 让 600ms 的活超时失败（契约 BE 验收 5）')
{
  /* ## 为什么这条必须真跑
   *
   * 上面那些验的是「值传对了」。但「值传对了」不等于「真的会按它超时」——
   * 中间还隔着派发器的 `withTimeout`。这一条用真的 `WorkflowDispatcher` +
   * 真的 shell 执行方（假 spawner 里睡 600ms），把整条路走一遍。 */
  const { WorkflowDispatcher } = await import('../src/dispatch/dispatcher.ts')
  const { createShellExecutor } = await import('../src/dispatch/executors.ts')

  /** 假 spawner：进程「要跑 600ms」，可被终止。 */
  function slowSpawner() {
    const spawned = []
    return {
      spawned,
      spawn(spec) {
        const startedAt = Date.now()
        let settle
        const done = new Promise((res) => { settle = res })
        const handle = {
          pid: 999,
          terminated: false,
          terminate() {
            handle.terminated = true
            settle({ exitCode: null, signal: 'SIGTERM' })
          },
          waitForExit: async () => true,
          done,
          stdoutText: () => '',
          stderrText: () => '',
        }
        /* 自然结束：600ms 后退出码 0（如果没被杀）。 */
        setTimeout(() => { if (!handle.terminated) settle({ exitCode: 0, signal: null }) }, 600)
        spawned.push({ spec, startedAt, handle })
        return handle
      },
    }
  }

  const sp = slowSpawner()
  const d = new WorkflowDispatcher({ timeoutMs: GLOBAL_MS })
  d.register(createShellExecutor(sp))

  const t0 = Date.now()
  const res = await d.dispatch({
    runId: '', nodeId: 'sh2', executor: 'shell',
    command: { argv: ['cmd.exe', '/c', 'echo hi'] },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    timeoutMs: 200,
  })
  const ms = Date.now() - t0
  check('★★ 600ms 的活上 200ms 超时 → 结局是失败（不是等 10 分钟、也不是等 600ms 自然结束）',
    res.status === 'failed', JSON.stringify({ status: res.status, ms }))
  check('★★ 标了 timedOut（与「被取消」分开，界面据此说人话）', res.timedOut === true, String(res.timedOut))
  check('★★ 错误里写着那个 200（用户填的值，不是全局 300000）',
    String(res.error ?? '').includes('200') && !String(res.error ?? '').includes('300000'),
    String(res.error ?? ''))
  check('★ 真的在 200ms 左右收口（不是睡满 600ms）', ms < 550, String(ms) + 'ms')
  check('★ 进程被终止了（超时要真的杀掉，不能只报个失败）',
    sp.spawned[0]?.handle.terminated === true, String(sp.spawned[0]?.handle.terminated))
}

console.log('')
console.log('⑧ 真实节点定义的声明（链路另一半：那个值确实写在一个真节点上）')
{
  /* 上面几段用的都是假定义 —— 这一段核**真定义**里有声明，
   * 否则「链路通了」只是测试自己编的。 */
  const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
  const shell = NODE_LIBRARY.find(d => d.id === 'code.shell')
  check('★★ code.shell 真的声明了 timeoutMs', typeof shell?.timeoutMs === 'number',
    String(shell?.timeoutMs))
  check('★ 那个值大于全局兜底（否则加了也没意义）',
    typeof shell?.timeoutMs === 'number' && shell.timeoutMs > GLOBAL_MS,
    String(shell?.timeoutMs) + ' vs ' + String(GLOBAL_MS))
  check('★★ code.shell 声明了 timeoutParam（界面那个参数真的接上了）',
    shell?.timeoutParam === 'timeout', String(shell?.timeoutParam))
  /* 反面：该声明的才声明 —— 每个都必须是「界面上真有一个超时参数、
   * 而执行层原来没读」的那种。不是顺手给一堆节点加。
   *
   * ⚠️ 这条从「只有 code.shell」改成「code.shell + sys.http」是契约 CG（2026-10-26）
   * 带来的**真实变化**，不是为了让测试变绿：`sys.http` 的界面上一直写着
   * 「最长等多久」、参数表里也一直有 `timeout: 30000`，但执行层一个字没读
   * （`command.ts` 的 http 分支只拼 url/method/headers/body）。
   *
   * ⚠️ 2026-10-28 又加了一个 `code.python`（票 09 让它走 shell 时一并声明）。
   * **只把数组从两个改成三个是「事后追认」，不算验过** ——
   * 所以下面⑧b 单独证一次「`code.python` 那个 `timeoutParam` 名副其实」。 */
  const withParam = NODE_LIBRARY.filter(d => d.timeoutParam !== undefined).map(d => d.id).sort()
  check('★★ 声明 timeoutParam 的是 code.python、code.shell 与 sys.http 三个',
    JSON.stringify(withParam) === JSON.stringify(['code.python', 'code.shell', 'sys.http']),
    withParam.join(','))

  /* 逐个核：每个声明了参数名的节点，界面上都必须真有一个同名参数
   * —— 否则就是「声明了一个不存在的参数」，等于白添。 */
  const ghost = NODE_LIBRARY
    .filter(d => typeof d.timeoutParam === 'string' && d.timeoutParam !== '')
    .filter(d => !(d.paramDefs ?? []).some(p => p.key === d.timeoutParam))
    .map(d => d.id)
  check('★★ 声明了 timeoutParam 的节点，界面上都真有那个参数（没有幽灵声明）',
    ghost.length === 0, ghost.join(','))

  /* sys.http 那条：界面上的参数默认 30000，且它**没有**静态上限
   * （没填时走派发器全局兜底，与改动前一致）。 */
  const http = NODE_LIBRARY.find(d => d.id === 'sys.http')
  check('★★ sys.http 的 timeout 参数默认 30000',
    (http?.paramDefs ?? []).some(p => p.key === 'timeout' && p.default === 30000), '')
  check('★ sys.http 没有静态 timeoutMs（没填时交全局兜底，行为与改动前一致）',
    http?.timeoutMs === undefined, String(http?.timeoutMs))
}

/* ── ⑧b `code.python` 的 timeoutParam 名副其实（2026-10-28）─────────────
 *
 * ## 为什么单开一段
 *
 * 上一段只是把期望数组从两个改成三个 —— 那叫「跟着实现改断言」，
 * 等于事后追认：`timeoutParam` 加了但下游没接，数组照样对得上。
 *
 * `code.python` 是票 09（改成走 shell）时一并声明 `timeoutParam: 'timeout'` 的，
 * 而它**没有** `timeoutMs`（静态上限），所以三层里只有「实例参数」与「全局兜底」两层。
 * 这里两层都验，并且验到**真调度**那一层 —— 「纯函数算得对」不等于
 * 「引擎真把这个值递给了派发器」（这个 bug 原来的形状就是这样：
 * `executors.ts` 类型里有 `timeoutMs`、行为里没有）。
 *
 * ## 自证方式
 *
 * 把 `src/nodes/code/python/node.ts` 的 `timeoutParam` 删掉
 * （或把 `dispatch-timeout.mjs` 里那条期望数组改回去）→ 这里必红。 */
console.log('')
console.log('⑧b code.python 的 timeoutParam 真的生效（不是声明了没人读）')
{
  const { NODE_LIBRARY: LIB2 } = await import('../src/nodes/index.ts')
  const { readTimeout: read2 } = await import('../src/workflow/model.ts')
  const py = LIB2.find(d => d.id === 'code.python')

  check('（前置）真定义里 code.python 声明了 timeoutParam = timeout',
    py?.timeoutParam === 'timeout', String(py?.timeoutParam))
  /* 参数表里真有那个键 —— 与上一段那条「幽灵声明」同一条纪律，这里再钉一次
   * 是因为它与本段验的是同一个节点，前一段若被人删掉这里也不会哑。 */
  const pyTimeoutParam = (py?.paramDefs ?? []).find(p => p.key === 'timeout')
  check('（前置）参数表里真有 timeout 这一项', pyTimeoutParam !== undefined,
    (py?.paramDefs ?? []).map(p => p.key).join(','))

  /* ① 纯函数：实例参数优先。这是「填多少就用多少」的第一层。 */
  check('★★ 纯函数层：code.python 填 90000 → 90000',
    read2(py, { timeout: 90000 }) === 90000, String(read2(py, { timeout: 90000 })))
  /* ② 没填 → 它**没有**静态上限，所以交全局兜底（undefined），
   * 而不是某个写死的数（写死的数会让「同一个节点换个入口跑，超时不一样」）。 */
  check('★★ 纯函数层：没填 → undefined（它没有静态上限，交派发器全局兜底）',
    read2(py, {}) === undefined, String(read2(py, {})))
  check('★ 纯函数层：填 0 当没填（不因笔误的 0 立刻超时）',
    read2(py, { timeout: 0 }) === undefined, String(read2(py, { timeout: 0 })))

  /* ③ 真调度：拿**真定义**跑一次，看派发请求里的超时值。 */
  const dp = fakeDispatch(300)
  await runGraph({
    nodes: [{ id: 'py1', def: py, params: { code: 'print(1)', timeout: 12345 }, onError: 'stop', skipped: false }],
    edges: [],
  }, dp.fn, { onEvent: () => { /* 不要日志 */ } })
  const pyCall = dp.calls.find(c => c.nodeId === 'py1')
  check('★★ 真调度：code.python 填 12345 → 请求里的 timeoutMs 就是 12345',
    pyCall?.timeoutMs === 12345, JSON.stringify(pyCall))
  /* 反向：填的值不是被当成「静态上限」抄过去的 —— 换一个值必须跟着变。 */
  const dp2 = fakeDispatch(300)
  await runGraph({
    nodes: [{ id: 'py2', def: py, params: { code: 'print(1)', timeout: 7777 }, onError: 'stop', skipped: false }],
    edges: [],
  }, dp2.fn, { onEvent: () => { /* 不要日志 */ } })
  const pyCall2 = dp2.calls.find(c => c.nodeId === 'py2')
  check('★★ 换个值也跟着变（说明读的是实例参数，不是写死的数）',
    pyCall2?.timeoutMs === 7777, JSON.stringify(pyCall2))
}

/* ── ⑨ sys.http 真跑：慢服务 3 秒，填 1000 看它多久断（契约 CG）──────
 *
 * ## 为什么这一段必须真量
 *
 * 上面几段都是「假派发器看 req.timeoutMs」—— 它验的是**调度层有没有把值递下来**。
 * 但 `sys.http` 这次修的是**另一半**：命令体里的 `timeout` 参数原本压根不参与
 * 超时计算（`command.ts` 的 http 分支只拼 url/method/headers/body）。
 *
 * 只断言「源码里有 timeoutParam」挡不住「字段加了、下游没接」——
 * 那正是这个 bug 原来的形状（`executors.ts` 类型里有 timeoutMs、行为里没有）。
 * 所以这里起一个**真的**慢 HTTP 服务，把两半接起来量一次。 */
console.log('')
console.log('⑨ sys.http 真跑：慢服务 3 秒 + timeout 填 1000')
{
  const { createServer } = await import('node:http')
  const { WorkflowDispatcher } = await import('../src/dispatch/dispatcher.ts')
  const { createHttpExecutor } = await import('../src/dispatch/executors.ts')
  const { readTimeout } = await import('../src/workflow/model.ts')
  /* ⚠️ `NODE_LIBRARY` 是 ⑧ 段里 `const` 声明的（块作用域），这里拿不到 —— 重新取一次。 */
  const { NODE_LIBRARY: LIB } = await import('../src/nodes/index.ts')
  const httpDef = LIB.find(d => d.id === 'sys.http')

  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ ok: true }))
    }, 3000)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + String(port) + '/slow'

  /**
   * 建一个只注册 http 执行方的派发器。
   * @param {number} globalMs - 全局兜底。
   * @returns {object} 派发器。
   */
  const mk = (globalMs) => {
    const d = new WorkflowDispatcher({ concurrency: 4, timeoutMs: globalMs })
    d.register(createHttpExecutor())
    return d
  }
  /**
   * 发一条 http 派发。
   * @param {object} d - 派发器。
   * @param {number} [own] - 请求自己的超时。
   * @returns {Promise<object>} 结果。
   */
  const fire = (d, own) => d.dispatch({
    runId: '', nodeId: 'n-http', executor: 'http',
    command: { method: 'GET', url },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    ...own === undefined ? {} : { timeoutMs: own },
  })

  try {
    const t0 = Date.now()
    const r = await fire(mk(300_000), readTimeout(httpDef, { timeout: 1000 }))
    const spent = Date.now() - t0
    check('★★ 填 1000 的 sys.http 在 1 秒左右判超时（不是等 3 秒出结果）',
      r.status === 'failed' && spent < 2000, JSON.stringify({ status: r.status, ms: spent }))
    check('★★ 标了 timedOut（与「被取消」分开）', r.timedOut === true, String(r.timedOut))
    check('★★ 错误里写的是这次生效的 1000（不是全局 300000）',
      String(r.error ?? '').includes('1000'), String(r.error ?? ''))

    /* 反向：同一个慢服务、不填超时 → 能跑完。证明上面断的是超时而不是接口坏。 */
    const t1 = Date.now()
    const ok = await fire(mk(300_000))
    const spent2 = Date.now() - t1
    check('★★ 不填时同一个慢服务能跑完（证明上一条断的是超时，不是接口本身坏）',
      ok.status === 'success' && spent2 >= 2800, JSON.stringify({ status: ok.status, ms: spent2 }))

    /* 反向：全局 200ms、节点填 5000 → 节点自己的值压过全局（契约 AV 那层真串起来了）。 */
    const t2 = Date.now()
    const r2 = await fire(mk(200), readTimeout(httpDef, { timeout: 5000 }))
    const spent3 = Date.now() - t2
    check('★★ 节点填 5000 压过全局 200（真能等到 3 秒服务的结果）',
      r2.status === 'success' && spent3 >= 2800, JSON.stringify({ status: r2.status, ms: spent3 }))
  } finally {
    server.close()
  }
}

console.log('')
console.log(failed === 0 ? '结论：节点级超时链路全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

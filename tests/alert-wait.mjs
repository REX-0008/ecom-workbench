/** 「Windows 通知与等待」节点（`flow.alert-wait`，票 07 第一轮）的调度语义。
 *
 * ## 这一段守的是什么
 *
 * 节点定义（`src/nodes/flow/alert-wait/node.ts`）只是一份数据，真正决定行为的是
 * `run.ts` 里三处：
 *   ① `runSeq` 认得这个 id（否则会被当普通 builtin 派发 → 实现表里没有它 → 报错）；
 *   ② `runAlertWait` 按四种模式分派（`none` 走普通节点、其余三种挂起）；
 *   ③ 恢复入口的超时结论按**这个节点自己的失败策略**走（甲，用户 2026-10-27 定）。
 *
 * ## 为什么这几条必须单独测
 *
 * 「超时走失败分支」这件事在改动前**根本做不到**：恢复入口一刀切 `order = []`，
 * 后面一个节点都不跑，红出口连上的下游永远不会活。这条测试钉住的正是那个修复。
 *
 * ## 与 `wait-manual.mjs` 的分工
 *
 * | | `wait-manual.mjs` | 本文件 |
 * |---|---|---|
 * | 被测节点 | `flow.wait`（老节点） | `flow.alert-wait`（新节点） |
 * | 超时之后 | 整次运行按失败结束（**必须不变**） | 按失败策略走，**不算中断** |
 *
 * 老节点那一半一个字都不许变 —— 三份真实存档还靠它。
 *
 * 跑法：node --import <tsx> tests/alert-wait.mjs
 */
import { runGraph } from '../src/workflow/run.ts'

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

/**
 * 造一个节点规格。
 *
 * ⚠️ **`__error` 出口要自己带上**：生产路径里它是 `specs.ts` 的 `withErrorOutput`
 * 按 `onError` **派生**出来的（`toRunSpecs` 那一步），这里手搓规格绕过了那一步。
 * 不带的话 `liveHandles` 认不出这个出口、返回 `null`（= 全部出口都活），
 * 失败出口上的下游会在**任何**情况下都跑 —— 那是测试夹具的错，不是实现的。
 *
 * @param {string} id - 节点 id。
 * @param {object} opts - 选项（defId / params / onError）。
 * @returns {object} 规格。
 */
function spec(id, opts = {}) {
  const defId = opts.defId ?? 'code.js'
  const outputs = [...(opts.outputs ?? [{ id: 'out', label: '输出', type: 'any' }])]
  if (opts.onError === 'continueErrorOutput' && !outputs.some(o => o.id === '__error')) {
    outputs.push({ id: '__error', label: '失败', type: 'any' })
  }
  return {
    id,
    /* ⚠️ `opts.def` 是**整份定义覆盖**（与 `run-graph.mjs` 的 `spec()` 同一个口子）：
     * 循环这类节点的端口与 id 与本文件的默认形状不同，不覆盖就会拿 `code.js`
     * 冒充它 —— 那样图里根本没有循环，验的东西全跑偏。 */
    def: opts.def ?? {
      id: defId,
      label: opts.label ?? defId,
      executor: 'builtin',
      inputs: [{ id: 'in', label: '输入', type: 'any' }],
      outputs,
    },
    params: opts.params ?? {},
    onError: opts.onError ?? 'stop',
    skipped: false,
  }
}

/**
 * 造一条边。
 * @param {string} source - 起点。
 * @param {string} target - 终点。
 * @param {string} [sourceHandle] - 起点出口。
 * @returns {object} 边。
 */
function edge(source, target, sourceHandle) {
  return sourceHandle === undefined
    ? { id: source + '->' + target, source, target }
    : { id: source + '->' + target + ':' + sourceHandle, source, target, sourceHandle }
}

/**
 * 假派发器：记录调用、按 nodeId 给结果。
 * @param {object} script - nodeId → 结果。
 * @returns {{fn: Function, calls: object[]}} 派发器与调用记录。
 */
function fakeDispatch(script = {}) {
  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, command: req.command, upstream: req.context.upstream })
    const r = script[req.nodeId]
    if (r !== undefined) return r
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

/** 「通知发出去了」这个假结果（形状与 `flow.notify` 的实现一致）。 */
const NOTIFIED = { ok: true, status: 'success', output: { notified: true, level: 'notice', reason: '已发出：已弹出' } }
/** 「通知没发出去」这个假结果。 */
const NOT_SENT = { ok: true, status: 'success', output: { notified: false, level: 'notice', reason: '节点设为不发系统通知' } }

console.log('=== Windows 通知与等待（flow.alert-wait）===')
console.log('')

/* ── ① `mode: 'none'`：只通知，不停 ─────────────────────────────── */
console.log('① 选「只通知」时不停，发完立刻往下走')
{
  const nodes = [
    spec('a'),
    spec('w', { defId: 'flow.alert-wait', params: { content: '巡查完成', level: 'notice', system: true, mode: 'none' } }),
    spec('b'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'b')]
  const d = fakeDispatch({ w: NOTIFIED })
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })

  check('★★ 下游照跑（没有挂起）', r.ran.includes('b'), r.ran.join('→'))
  check('★★ 整次运行没有中断', r.aborted === false, String(r.aborted))
  check('★ 没有留下挂起现场', r.paused === undefined, JSON.stringify(r.paused ?? null))

  /* 发通知要**真的派发一次**，且命令体里的 `node` 是 `flow.notify` ——
   * 实现只有那一份，不在引擎里重写。 */
  const call = d.calls.find(c => c.nodeId === 'w')
  check('★★ 发通知是派发 `flow.notify` 的实现（不另写一份）',
    call?.command?.node === 'flow.notify', JSON.stringify(call?.command?.node))
  check('★ 只把三个通知参数传过去（等什么那几个不传）',
    JSON.stringify(Object.keys(call?.command?.params ?? {}).sort())
      === JSON.stringify(['content', 'level', 'system']),
    JSON.stringify(call?.command?.params))

  /* 输出形状：上游原样 + `__alert`（不平铺）。 */
  const out = r.outputs.get('w')
  check('★★ 输出里上游数据原样在（下游取 {{字段}} 照旧）',
    out?.value === 'out:a' || out?.out === 'out:a', JSON.stringify(out))
  check('★★ 提醒结果挂在 __alert 底下，不平铺', out?.__alert?.notified === true, JSON.stringify(out))
  check('★ 提醒结果没有与上游字段同级（反面：顶层不该有 notified）',
    out?.notified === undefined, JSON.stringify(Object.keys(out ?? {})))
}

/* ── ② 发通知失败**不算这个节点失败**（`onError` 那个矛盾的解法）──── */
console.log('')
console.log('② 发通知失败：吞掉，流程照走（不走失败分支）')
{
  const nodes = [
    spec('a'),
    /* 用户会在节点上选「走失败分支」—— 但它只该对「等人超时」生效。 */
    spec('w', {
      defId: 'flow.alert-wait',
      params: { content: '巡查完成', level: 'notice', system: true, mode: 'none' },
      onError: 'continueErrorOutput',
    }),
    spec('ok'),
    spec('rescue'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'ok'), edge('w', 'rescue', '__error')]
  const d = fakeDispatch({ w: { ok: false, status: 'failed', error: 'PowerShell 起不来' } })
  const r = await runGraph({ nodes, edges }, d.fn, { onEvent: () => { /* 不要日志 */ } })

  check('★★ 通知失败不算这个节点失败：正常出口的下游照跑',
    r.ran.includes('ok'), r.ran.join('→'))
  check('★★ 失败出口**不活**（不能因为一条提醒没弹就走失败分支）',
    !r.ran.includes('rescue'), r.ran.join('→'))
  check('★ 整次运行没中断', r.aborted === false, String(r.aborted))
  const out = r.outputs.get('w')
  check('★ 输出里写清了没发出去', out?.__alert?.notified === false, JSON.stringify(out?.__alert))
  check('★ 原因里带着那句原始错误', String(out?.__alert?.reason ?? '').includes('PowerShell'),
    String(out?.__alert?.reason ?? ''))
}

/* ── ③ 三种模式都会挂起 ─────────────────────────────────────────── */
console.log('')
console.log('③ 等一段时长 / 等到某个时刻 / 等人点继续：都挂起')
{
  /** 跑一次挂起，返回结果与现场。 */
  const pauseWith = async (params) => {
    const nodes = [spec('a'), spec('w', { defId: 'flow.alert-wait', params }), spec('b')]
    const d = fakeDispatch({ w: NOTIFIED })
    const r = await runGraph({ nodes, edges: [edge('a', 'w'), edge('w', 'b')] }, d.fn,
      { onEvent: () => { /* 不要日志 */ }, runId: 'aw-' + String(params.mode) })
    return { r, d }
  }

  const dur = await pauseWith({ content: 'x', mode: 'duration', ms: 60000 })
  check('★★ duration：挂起了', dur.r.paused !== undefined, String(dur.r.paused?.wait?.mode))
  check('★ duration：挂起时下游没跑', !dur.r.ran.includes('b'), dur.r.ran.join('→'))
  check('★★ duration：挂起前**已经发过通知**（不然人不知道该点继续）',
    dur.d.calls.some(c => c.nodeId === 'w' && c.command?.node === 'flow.notify'),
    dur.d.calls.map(c => c.nodeId).join(','))
  check('★ duration：现场里 wait.mode 是 duration', dur.r.paused?.wait?.mode === 'duration',
    String(dur.r.paused?.wait?.mode))

  const until = await pauseWith({ content: 'x', mode: 'until', until: '09:30' })
  check('★★ until：挂起了', until.r.paused !== undefined, String(until.r.paused?.wait?.mode))
  check('★ until：现场里记着等哪个时刻', until.r.paused?.wait?.until === '09:30',
    String(until.r.paused?.wait?.until))

  const manual = await pauseWith({ content: 'x', mode: 'manual', timeoutHours: 2 })
  check('★★ manual：挂起了', manual.r.paused !== undefined, String(manual.r.paused?.wait?.mode))
  check('★ manual：现场里带超时时刻', typeof manual.r.paused?.wait?.timeoutAtMs === 'number',
    String(manual.r.paused?.wait?.timeoutAtMs))

  /* `ms: 0` 与 `mode: none` 行为必须一致（计划 C7：同一个意图不能有两种行为）。 */
  const zero = await pauseWith({ content: 'x', mode: 'duration', ms: 0 })
  check('★★ ms: 0 不挂起（与「只通知」一致）', zero.r.paused === undefined,
    JSON.stringify(zero.r.paused?.wait?.mode ?? null))
  check('★ ms: 0 时下游照跑', zero.r.ran.includes('b'), zero.r.ran.join('→'))
}

/* ── ④ 超时：按**这个节点自己的失败策略**走（甲，票 07 的核心）─────── */
console.log('')
console.log('④ 等人超时：走失败分支，不算整次中断')
{
  /** 造一个「已经超时」的现场并恢复。 */
  const resumeExpired = async (alertParams) => {
    const nodes = [
      spec('a'),
      spec('w', { defId: 'flow.alert-wait', params: alertParams, onError: 'continueErrorOutput' }),
      spec('ok'),
      spec('rescue'),
    ]
    const edges = [edge('a', 'w'), edge('w', 'ok'), edge('w', 'rescue', '__error')]
    /* 先真跑一次拿到现场。 */
    const d1 = fakeDispatch({ w: NOTIFIED })
    const r1 = await runGraph({ nodes, edges }, d1.fn, { runId: 'aw-timeout' })
    const snap = r1.paused
    /* 把超时时刻改成「早就过了」。 */
    const expired = {
      ...snap,
      wait: { ...snap.wait, resumeAtMs: Date.now() - 1000, timeoutAtMs: Date.now() - 1000 },
    }
    const d2 = fakeDispatch({ w: NOTIFIED })
    const events = []
    const r2 = await runGraph({ nodes, edges, resume: expired }, d2.fn, { onEvent: (e) => events.push(e) })
    return { r2, d2, events }
  }

  const { r2, d2, events } = await resumeExpired({ content: 'x', mode: 'manual', timeoutHours: 12 })

  check('★★ 超时后**不算整次中断**（aborted 为假 —— 失败被局部处理了）',
    r2.aborted === false, String(r2.aborted))
  check('★★ 超时后**失败出口**上的下游跑了（rescue）', r2.ran.includes('rescue'), r2.ran.join('→'))
  check('★★ 超时后**正常出口**上的下游不跑（ok）—— 这正是修的 bug',
    !r2.ran.includes('ok'), r2.ran.join('→'))
  check('★ 超时节点自己记了失败', events.some(e => e.kind === 'failed' && e.nodeId === 'w'),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  const failEv = events.find(e => e.kind === 'failed' && e.nodeId === 'w')
  check('★★ 失败原因说清是「人没有处理」（不是笼统的失败）',
    String(failEv?.error ?? '').includes('人没有处理'), String(failEv?.error ?? ''))
  check('★ 原因里带着填的几小时', String(failEv?.error ?? '').includes('12'), String(failEv?.error ?? ''))
  check('★ 失败出口拿得到原因（下游能据此判断）',
    String(r2.outputs.get('w')?.error ?? '').includes('人没有处理'),
    JSON.stringify(r2.outputs.get('w')))
  /* 失败原因**不进整次运行那一层**：这次跑完了，`error` 是「为什么没跑成」的意思，
   * 不能拿它冒充。 */
  check('★★ 整次运行没有 error 键（这次真的跑完了）', r2.error === undefined, String(r2.error))
  void d2
}

/* ── ⑤ 老节点一个字不变（对照，防止这次改动把 `flow.wait` 带坏）──── */
console.log('')
console.log('⑤ 对照：老的「等待」节点超时仍按整次失败结束（一个字不变）')
{
  const nodes = [
    spec('a'),
    spec('w', { defId: 'flow.wait', params: { mode: 'manual', timeoutHours: 12 }, onError: 'continue' }),
    spec('b'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'b')]
  const d1 = fakeDispatch()
  const r1 = await runGraph({ nodes, edges }, d1.fn, { runId: 'old-wait-timeout' })
  const snap = r1.paused
  const expired = {
    ...snap,
    wait: { ...snap.wait, resumeAtMs: Date.now() - 1000, timeoutAtMs: Date.now() - 1000 },
  }
  const d2 = fakeDispatch()
  const events = []
  const r2 = await runGraph({ nodes, edges, resume: expired }, d2.fn, { onEvent: (e) => events.push(e) })

  check('★★ 老节点超时：整次运行仍按失败结束（aborted 为真）', r2.aborted === true, String(r2.aborted))
  check('★★ 老节点超时：后面一个节点都不跑', !d2.calls.some(c => c.nodeId === 'b'),
    d2.calls.map(c => c.nodeId).join(','))
  check('★★ 老节点超时的原因**不是**新节点那句（两句要能分辨）',
    String(r2.error ?? '').includes('等待') && !String(r2.error ?? '').includes('人没有处理'),
    String(r2.error ?? ''))
  check('★ 老节点仍有一句失败事件', events.some(e => e.kind === 'failed'), '')
}

/* ── ⑥ 循环里不许放（与老「等待」同一条拦）─────────────────────── */
console.log('')
console.log('⑥ 放在循环体里：明确报错，不静默')
{
  const loopDef = {
    id: 'flow.loop', label: '循环', executor: 'builtin',
    inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [{ id: 'done', label: '输出', type: 'any' }],
  }
  const nodes = [
    spec('L', { def: loopDef, params: { mode: 'count', count: 2 } }),
    /* ⚠️ 用默认失败策略 `stop`：这条要验的是「配置不支持时明说」，
     * 用「走失败分支」会把这句话按失败策略吞掉，验的就不是这条了。 */
    spec('body', {
      defId: 'flow.alert-wait',
      label: 'Windows 通知与等待',
      params: { content: 'x', mode: 'manual', timeoutHours: 0 },
    }),
  ]
  nodes[1].parentId = 'L'
  const d = fakeDispatch({ L: { ok: true, status: 'success', output: [1, 2] } })
  const events = []
  const r = await runGraph({ nodes, edges: [] }, d.fn, { onEvent: (e) => events.push(e) })
  const failEv = events.find(e => e.kind === 'failed' && e.nodeId === 'body')
  check('★★ 循环体里的新节点也明确报错（不是静默挂起）', failEv !== undefined,
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  check('★ 报错里说清是「不能放在循环里」', String(failEv?.error ?? '').includes('不能放在循环里'),
    String(failEv?.error ?? '').slice(0, 90))
  /* 报错里要报**这个节点自己的名字** —— 写死「等待」会让用户对着一个
   * 不存在的节点名去找（新节点叫「Windows 通知与等待」）。 */
  check('★ 报错里用的是这个节点自己的名字（不是写死「等待」）',
    String(failEv?.error ?? '').includes('Windows 通知与等待'),
    String(failEv?.error ?? '').slice(0, 90))
  check('★ 默认失败策略下整次运行中断（配置不支持不该硬跑）', r.aborted === true, String(r.aborted))
}

/* ── 收尾 ──────────────────────────────────────────────────────── */
console.log('')
console.log(failed === 0
  ? '结论：通知与等待节点的四种模式、超时走失败分支、老节点不变，全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

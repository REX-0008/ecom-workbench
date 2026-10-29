/** 暂停与恢复：现场序列化这条路（计划 Step 12 第一步）。
 *
 * ## 为什么要单独一个测试
 *
 * 「暂停恢复」最容易坏在**看不见的地方**：跑到 wait 停住了、但现场没存全，
 * 恢复后下游全是空值 —— 界面只显示「跑完了」，没有任何报错。
 * 所以这里逐条钉住「现场里必须有什么、恢复后必须还是什么」。
 *
 * ## 盯的五件事
 *
 *   ① `flow.wait` 真的**停住**了（后面的节点一个都不许跑）；
 *   ② 现场存得全（输出 / 跑过哪些 / 输入 / 未走的分支 / 从哪继续）；
 *   ③ 恢复**从挂起点的下游**继续，且前半段的输出照样取得到；
 *   ④ 挂起**不是失败**（`ok` 仍真、`aborted` 仍假）；
 *   ⑤ 参数填错（时刻写错 / 等太久）**当失败报**，不静默变成「马上继续」。
 *
 * 跑法：node --import <tsx> tests/pause-resume.mjs
 */
import { runGraph, RunPausedError, WAIT_DEF_ID } from '../src/workflow/run.ts'
import { nextHm, readWaitPlan, WAIT_MAX_MS, asSnapshot } from '../src/workflow/snapshot.ts'

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

/** 造一个最小节点定义。 */
function def(id, label) {
  return { id, label, executor: 'builtin', inputs: [], outputs: [] }
}

/** 造一个节点规格。 */
function spec(id, opts = {}) {
  return {
    id,
    def: opts.def ?? def(opts.defId ?? 'code.js', opts.label ?? id),
    params: opts.params ?? {},
    onError: opts.onError ?? 'stop',
    skipped: opts.skipped === true,
  }
}

/** 造一条边。 */
function edge(source, target) {
  return { id: source + '->' + target, source, target }
}

/**
 * 假派发器：记录调用，按脚本给结果。
 * @param script - nodeId → 结果。
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

console.log('=== 暂停与恢复（flow.wait + 现场序列化）===')

console.log('① 跑到 wait 就停住（后面的节点一个都不许跑）')
{
  const nodes = [
    spec('a'),
    spec('w', { defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'), params: { mode: 'duration', ms: 60000 } }),
    spec('c'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn, { workflowId: '测试流', runId: 'run-1' })
  check('c 没有被派发（停住了）', !d.calls.some(x => x.nodeId === 'c'), d.calls.map(x => x.nodeId).join(','))
  check('结果里带现场', r.paused !== undefined)
  check('★ 挂起不算失败：aborted 仍为假', r.aborted === false)
  check('★ 挂起时 ran 里含 a 与 w', r.ran.join(',') === 'a,w', r.ran.join(','))
}

console.log('')
console.log('② 现场里必须有那五样')
{
  const nodes = [
    spec('a'),
    spec('w', { defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'), params: { mode: 'duration', ms: 60000 } }),
    spec('c'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'c')]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn, { workflowId: '测试流', runId: 'run-2' })
  const p = r.paused
  check('现场有 version', p.version === 1)
  check('现场记住了运行 id', p.runId === 'run-2', String(p.runId))
  check('现场记住了工作流名', p.workflowId === '测试流', String(p.workflowId))
  check('现场记住了「从哪继续」（= 等待节点自己）', p.resumeAfter === 'w', String(p.resumeAfter))
  check('★ 现场存了前半段的输出（a 的）', p.outputs.a === 'out:a', JSON.stringify(p.outputs))
  check('★ 现场存了「跑过哪些」', p.ran.join(',') === 'a,w', p.ran.join(','))
  check('现场记了要等多久', p.wait.ms === 60000 && p.wait.mode === 'duration', JSON.stringify(p.wait))
  check('现场里的恢复时刻 = 挂起时刻 + 等待时长', p.wait.resumeAtMs === p.pausedAt + 60000,
    String(p.wait.resumeAtMs - p.pausedAt))
}

console.log('')
console.log('③ 恢复：从挂起点的下游继续，前半段输出照样取得到')
{
  const nodes = [
    spec('a'),
    spec('w', { defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'), params: { mode: 'duration', ms: 60000 } }),
    spec('c'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'c')]
  const first = await runGraph({ nodes, edges }, fakeDispatch().fn, { workflowId: '测试流', runId: 'run-3' })
  const snap = first.paused
  /* 恢复：同一张图 + 现场。 */
  const d2 = fakeDispatch()
  const second = await runGraph({ nodes, edges, resume: snap }, d2.fn, { workflowId: '测试流' })
  check('★ 恢复后没有重跑 a', !d2.calls.some(x => x.nodeId === 'a'), d2.calls.map(x => x.nodeId).join(','))
  check('★ 恢复后没有重跑等待节点（否则会再挂一次）',
    !d2.calls.some(x => x.nodeId === 'w'), d2.calls.map(x => x.nodeId).join(','))
  check('★ 恢复后跑了 c', d2.calls.some(x => x.nodeId === 'c'))
  const cCall = d2.calls.find(x => x.nodeId === 'c')
  check('★★ c 拿到了挂起前的上游输出（现场真的恢复了）',
    JSON.stringify(cCall.upstream) === JSON.stringify(['out:a']), JSON.stringify(cCall.upstream))
  check('恢复后这次不再挂起', second.paused === undefined)
  check('恢复后 ran 含前半段（不是从零数）', second.ran.join(',') === 'a,w,c', second.ran.join(','))
}

console.log('')
console.log('④ 未走的分支恢复后仍然不走（**自证**：把现场里那一项去掉，测试必须变红）')
{
  /* 场景：d 报「只走 true 出口」，于是接在 false 出口上的 x 被判「没走」；
   * x 的输出在整份运行里**从来没产出过**。而 x → e 这条边在 e 前面，
   * 挂起发生在 e 之前 —— 所以「恢复后 e 该不该跑」全靠现场里那份 unreachable。
   *
   * ⚠️ 判据不是「标了终点」，而是**起点不可达**（见 run.ts 的 `edgeAlive`：
   * 它看的是 `unreachable.has(e.source)`）。第一版测试标的是终点，白红一次。 */
  /* ⚠️ 用一个**自定义的普通节点**造分流，不要用 `flow.if`：
   * 那个节点由调度器特判（`ifPlanOf`），没填条件会**直接报错**，
   * 整条 run 在到达等待节点之前就中断了（第一版这么写，白红一次）。
   * 这里只要「输出带 `__handle`」就够了 —— 分流约定看的是输出，不是节点类型。 */
  const twoOut = { id: 'code.js', label: '分流', executor: 'builtin', inputs: [], outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }] }
  /* 图的形状（**顺序很关键，别随手改**）：
   *
   *   a → d（报「只走 true」）
   *   d --false--> x  →  z        （x 挂在没走的出口上，z 只吃 x）
   *   d ---------> w（等待）→ e    （e 只吃 w）
   *
   * 拓扑序 = a, d, x, w, z, e —— 所以 **z 在挂起点之后**，
   * 而它唯一的上游 x 在挂起前就被判「没走」了。
   * 这正是「现场里的 unreachable 到底有没有用」能观察到的唯一位置。 */
  const nodes = [
    spec('a'),
    spec('d', { def: twoOut, params: {} }),
    spec('x'),
    spec('w', { defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'), params: { mode: 'duration', ms: 60000 } }),
    spec('z'),
    spec('e'),
  ]
  const edges = [
    { id: 'a->d', source: 'a', target: 'd' },
    { id: 'd->x', source: 'd', target: 'x', sourceHandle: 'false' },
    { id: 'd->w', source: 'd', target: 'w' },
    { id: 'x->z', source: 'x', target: 'z' },
    { id: 'w->e', source: 'w', target: 'e' },
  ]
  const d = fakeDispatch({ d: { ok: true, status: 'success', output: { __handle: 'true', v: 1 } } })
  const first = await runGraph({ nodes, edges }, d.fn, { workflowId: '测试流' })
  const snap = first.paused
  check('挂起前：x 被判「没走」（没派发）', !d.calls.some(c => c.nodeId === 'x'), d.calls.map(c => c.nodeId).join(','))
  check('现场里记下了「x 没走」', snap.unreachable.includes('x'), JSON.stringify(snap.unreachable))

  /* ① 按原样恢复：x 仍然没走 → z 跟着也不跑；e 照常跑。 */
  const d2 = fakeDispatch()
  await runGraph({ nodes, edges, resume: snap }, d2.fn, { workflowId: '测试流' })
  check('★ 恢复后 x 仍然不派发', !d2.calls.some(c => c.nodeId === 'x'), d2.calls.map(c => c.nodeId).join(','))
  check('★ 恢复后 z 也不跑（它的唯一上游没走）', !d2.calls.some(c => c.nodeId === 'z'), d2.calls.map(c => c.nodeId).join(','))
  check('★ e 照常跑（挂起点的下游）', d2.calls.some(c => c.nodeId === 'e'), d2.calls.map(c => c.nodeId).join(','))

  /* ② **自证**：把现场里的 unreachable 清空 → z 会**被派发**（上游没了却仍算「活」）。
   *    这条证明「那个字段真的在起作用」，不是重复断言。 */
  const d3 = fakeDispatch()
  await runGraph({ nodes, edges, resume: { ...snap, unreachable: [] } }, d3.fn, { workflowId: '测试流' })
  check('★★ 自证：清空 unreachable 后 z **会**被派发（说明那一项是真在起作用）',
    d3.calls.some(c => c.nodeId === 'z'), d3.calls.map(c => c.nodeId).join(','))
}

console.log('')
console.log('⑤ 参数填错 → 当失败报（不静默变成「马上继续」）')
{
  const nodes = [
    spec('a'),
    spec('w', {
      defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'),
      params: { mode: 'until', until: '25:99' },
      onError: 'continue',
    }),
    spec('c'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'c')]
  const lines = []
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn, {
    workflowId: '测试流',
    onEvent: (e) => { if (e.kind === 'log') lines.push(e.line) },
  })
  check('时刻写错 → 不挂起', r.paused === undefined)
  check('★ 明确说了原因', lines.some(l => l.includes('格式不对')), lines.slice(-3).join(' | '))
  check('按「继续」策略往下走了（下游照跑）', d.calls.some(x => x.nodeId === 'c'))
}

console.log('')
console.log('⑥ 等到某个时刻：今天没过就今天，过了就明天')
{
  /* 2026-10-21 08:00 本地时间 → 等到 09:30 应当是同一天。 */
  const at8 = new Date(2026, 9, 21, 8, 0, 0, 0).getTime()
  const got = nextHm('09:30', at8)
  const d = new Date(got)
  check('同一天 09:30', d.getDate() === 21 && d.getHours() === 9 && d.getMinutes() === 30,
    d.toString())
  /* 10:00 时问 09:30 → 明天。 */
  const at10 = new Date(2026, 9, 21, 10, 0, 0, 0).getTime()
  const next = new Date(nextHm('09:30', at10))
  check('已经过了 → 明天', next.getDate() === 22 && next.getHours() === 9, next.toString())
  check('格式不对给 null', nextHm('9点半', at8) === null)
  check('小时越界给 null', nextHm('25:00', at8) === null)
}

console.log('')
console.log('⑦ 上限与参数读取')
{
  const r1 = readWaitPlan({ mode: 'duration', ms: WAIT_MAX_MS + 1 }, Date.now())
  check('超过上限（20 天）→ 给一句可读的错', r1.plan === undefined && String(r1.error).includes('20 天'),
    String(r1.error))
  const r2 = readWaitPlan({ mode: 'until', until: '' }, Date.now())
  check('「等到几点」没填 → 明说', r2.plan === undefined && String(r2.error).includes('没填'), String(r2.error))
  const r3 = readWaitPlan({ mode: 'duration', ms: 3000 }, 1000)
  check('等 3 秒 → resumeAt = 现在 + 3000', r3.plan.resumeAtMs === 4000, String(r3.plan.resumeAtMs))
  const r4 = readWaitPlan({}, 1000)
  check('没填时长 → 用默认 5000（不是 0，不会立刻继续）', r4.plan.ms === 5000, String(r4.plan.ms))
}

console.log('')
console.log('⑧ 坏现场读回来要 null（不抛）')
{
  check('不是对象 → null', asSnapshot('abc') === null)
  check('版本不对 → null', asSnapshot({ version: 2 }) === null)
  check('缺 runId → null', asSnapshot({ version: 1, workflowId: 'x', resumeAfter: 'w', pausedAt: 1, wait: {} }) === null)
  const ok = asSnapshot({
    version: 1, runId: 'r', workflowId: 'x', resumeAfter: 'w', pausedAt: 1,
    wait: { mode: 'duration', resumeAtMs: 2, ms: 1 },
  })
  check('形状对 → 读得出来', ok !== null && ok.runId === 'r')
  check('缺的数组字段补成空数组（不崩）', ok.ran.length === 0 && ok.unreachable.length === 0)
}

console.log('')
console.log('⑨ 放在循环里的等待**明确报错**（不是静默变成「整份重跑」）')
{
  /* 循环体的节点不在主序里 → 恢复时切片落空 → 会「再挂一次」，永远跑不完。
   * 与其那样，不如当场说清「本版本不支持」。 */
  const loopDef = { id: 'flow.loop', label: '循环', executor: 'builtin', inputs: [], outputs: [] }
  const nodes = [
    spec('a'),
    spec('L', { def: loopDef, params: { mode: 'count', times: 2 } }),
    /* 循环体里的两个节点（parentId 指向循环）。 */
    { ...spec('w', { defId: WAIT_DEF_ID, def: def(WAIT_DEF_ID, '等待'), params: { mode: 'duration', ms: 60000 }, onError: 'continue' }), parentId: 'L' },
  ]
  const edges = [edge('a', 'L')]
  const lines = []
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges }, d.fn, {
    workflowId: '测试流',
    onEvent: (e) => { if (e.kind === 'log') lines.push(e.line) },
  })
  check('★ 没有挂起（不支持就明说，不是静默挂起）', r.paused === undefined)
  check('★ 明确说了「不能放在循环里」', lines.some(l => l.includes('不能放在循环里')),
    lines.slice(-3).join(' | '))
  check('还指了替代方案（用「延迟」）', lines.some(l => l.includes('延迟')), lines.slice(-2).join(' | '))
}

console.log('')
console.log('⑩ RunPausedError 带着现场（调用方能拿到它去落盘）')
{
  const err = new RunPausedError({ version: 1, runId: 'r9', workflowId: 'x', resumeAfter: 'w', pausedAt: 1, startedAt: 1, ran: [], executions: 0, outputs: {}, unreachable: [], inputs: {}, wait: { mode: 'duration', resumeAtMs: 2, ms: 1 } })
  check('它是个 Error', err instanceof Error)
  check('★ 带着现场（runId 对得上）', err.snapshot.runId === 'r9', err.snapshot.runId)
  check('名字是 RunPausedError（catch 里靠 instanceof 认，不靠名字）', err.name === 'RunPausedError')
}

console.log('')
console.log('⑪ 「等人点继续」（manual）：计划形状与老两档没被碰（2026-10-22 追加）')
{
  /* ⚠️ 这一段只钉「新增那一档」的纯逻辑；完整链路（停住 / 落盘 / 恢复 / 超时）
   * 在 `tests/wait-manual.mjs`。挨着另外两档放，方便对照「老两种没变」。 */
  const now = 1_800_000_000_000
  const m = readWaitPlan({ mode: 'manual', timeoutHours: 0 }, now)
  check('★ manual 不限超时 → 给出计划', m.plan !== undefined, JSON.stringify(m))
  check('★ manual 的 mode 是 manual', m.plan?.mode === 'manual', String(m.plan?.mode))
  check('★ manual 不受 20 天上限（它本来就是无限等）', m.plan !== undefined)
  /* 老两档的计划形状一个字都不许变。 */
  check('★ duration 仍不受影响', readWaitPlan({ mode: 'duration', ms: 1000 }, now).plan?.resumeAtMs === now + 1000)
  check('★ until 仍不受影响', readWaitPlan({ mode: 'until', until: '09:30' }, now).plan?.mode === 'until')
  check('★ 不带 mode 的老存档仍按 duration 处理',
    readWaitPlan({ ms: 2000 }, now).plan?.mode === 'duration')

  /* `asSnapshot` 读回老现场（没有 manual 这个概念）时仍落成老两档。 */
  const old = asSnapshot({
    version: 1, runId: 'r-old', workflowId: 'x', resumeAfter: 'w', pausedAt: 1, startedAt: 1,
    ran: [], executions: 0, outputs: {}, unreachable: [], inputs: {},
    wait: { mode: 'until', resumeAtMs: 2, ms: 1, until: '09:30' },
  })
  check('★ 老现场的 until 读回来还是 until', old?.wait.mode === 'until', String(old?.wait.mode))
  check('★ 老现场没有 manual 那两个新字段',
    old?.wait.timeoutAtMs === undefined && old?.wait.timeoutHours === undefined)
}

console.log('')
console.log(failed === 0 ? '结论：暂停恢复（现场序列化）全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

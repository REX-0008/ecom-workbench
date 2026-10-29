/** 「等待」节点的第三种模式：**等人点继续**（2026-10-22）。
 *
 * ## 为什么单独一份
 *
 * 用户要的原话：「登录检测到登录失败后提醒并进入等待点，然后等待节点触发后，
 * 是否有继续执行的按钮？……比如我不是在画布打开工作流，进入等待后怎么让他继续？」
 *
 * 前两种模式（等一段时长 / 等到某个时刻）都是「到点自动继续」。这一种**永远不自动继续**，
 * 必须有人在运行列表里点「继续」。它有两处最容易坏、且坏了是静默的：
 *
 *   ① **「永远不到点」落成什么数** —— 选 Infinity 会因为 JSON 往返变成 null，
 *      整份现场作废（挂起的运行凭空消失）；
 *   ② **自动扫盘器会不会把它捡走** —— 捡走就等于「没等人」，那个按钮永远用不上。
 *
 * 所以这里既验纯逻辑（`readWaitPlan` / `asSnapshot` / `manualTimeoutReason`），
 * 也验真调度器（跑到这儿停住、恢复后跑完、超时判失败）。
 *
 * ## 扫盘器怎么验（说明为什么是「照它的判据」而不是「调它的函数」）
 *
 * 扫盘那一段住在 `src/index.ts` 的 `ctx.effect` 里（内联、不导出），
 * 而且它不在本轮的改动范围内。所以这里**照抄它那一行判据**
 * （`snap.wait.resumeAtMs > now` 就跳过）来验「会不会被捡走」——
 * 判据只有一条，抄过来等价；差别是它不会起真定时器（那会让测试拖着进程）。
 *
 * 跑法：node --import <tsx> tests/wait-manual.mjs
 */
const { mkdtemp, readFile, writeFile, readdir } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-wait-manual-'))
process.env.EWB_TEST_HOME = join(sandbox, 'home')

const { runGraph, RunPausedError } = await import('../src/workflow/run.ts')
const {
  readWaitPlan, asSnapshot, manualTimeoutReason, WAIT_MANUAL_FOREVER_MS, WAIT_MAX_MS,
} = await import('../src/workflow/snapshot.ts')
const { savePausedRun, loadPausedRun, listPausedRuns, pausedDir } =
  await import('../src/workflow/pause-store.ts')
const { runWorkflowFile } = await import('../src/workflow/run-file.ts')
const { saveWorkflow } = await import('../src/workflow/store.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')

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

/** 造一个最小节点定义。
 * @param {string} id - 类型 id。
 * @param {string} label - 显示名。
 * @returns {object} 定义。 */
function def(id, label) {
  return { id, label, executor: 'builtin', inputs: [], outputs: [] }
}

/** 造一个节点规格。
 * @param {string} id - 节点 id。
 * @param {object} [opts] - 选项。
 * @returns {object} 规格。 */
function spec(id, opts = {}) {
  return {
    id,
    def: opts.def ?? def(opts.defId ?? 'code.js', opts.label ?? id),
    params: opts.params ?? {},
    onError: opts.onError ?? 'stop',
    skipped: opts.skipped === true,
  }
}

/** 造一条边。
 * @param {string} source - 起点。
 * @param {string} target - 终点。
 * @returns {object} 边。 */
function edge(source, target) {
  return { id: source + '->' + target, source, target }
}

/**
 * 假派发器：记录调用，一律成功。
 * @returns {{fn: Function, calls: object[]}} 派发器与调用记录。
 */
function fakeDispatch() {
  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, upstream: req.context.upstream })
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

/**
 * 照抄扫盘器那一行判据：这份现场这次会不会被自动捡走。
 *
 * ⚠️ 只有这一条判据（`src/index.ts` 的 `:602`）。改那里就要**同时改这里**。
 *
 * @param {object} snap - 现场。
 * @param {number} now - 现在（毫秒）。
 * @returns {boolean} 会被自动恢复就 true。
 */
function scannerWouldPick(snap, now) {
  return !(snap.wait.resumeAtMs > now)
}

const waitDef = def('flow.wait', '等待')

console.log('=== ① readWaitPlan：manual 的计划形状 ===')
{
  const now = 1_800_000_000_000
  const r = readWaitPlan({ mode: 'manual', timeoutHours: 0 }, now)
  check('★ manual + 不限超时 → 拿到计划', r.plan !== undefined, JSON.stringify(r))
  check('★★ resumeAtMs 是「永远不到点」那个值', r.plan?.resumeAtMs === WAIT_MANUAL_FOREVER_MS,
    String(r.plan?.resumeAtMs))
  check('★★ 那个值远大于任何真实时刻', (r.plan?.resumeAtMs ?? 0) > now + 100 * 365 * 86400000,
    String(r.plan?.resumeAtMs))
  check('ms 是 0（不是「等 0 毫秒」的意思，见注释）', r.plan?.ms === 0, String(r.plan?.ms))
  check('没有超时时刻（不限超时时不该有这个字段）', r.plan?.timeoutAtMs === undefined,
    JSON.stringify(r.plan?.timeoutAtMs))

  /* 不适用 20 天上限 —— manual 本来的意思就是「可能等很久」。 */
  check('manual 不受 20 天上限约束（它本来就是无限等）', r.plan !== undefined)

  const t = readWaitPlan({ mode: 'manual', timeoutHours: 2 }, now)
  check('★ manual + 超时 2 小时 → resumeAtMs = 现在 + 2 小时的时刻',
    t.plan?.resumeAtMs === now + 2 * 3600 * 1000, String((t.plan?.resumeAtMs ?? 0) - now))
  check('★ 超时时刻单独存一份（timeoutAtMs）', t.plan?.timeoutAtMs === t.plan?.resumeAtMs,
    String(t.plan?.timeoutAtMs))
  check('★ 记下了填的几小时', t.plan?.timeoutHours === 2, String(t.plan?.timeoutHours))

  const neg = readWaitPlan({ mode: 'manual', timeoutHours: -1 }, now)
  check('★★ 负数超时被明确拒绝（不是当成 0 静默不限）', neg.plan === undefined && String(neg.error).includes('负数'),
    String(neg.error))

  const tooLong = readWaitPlan({ mode: 'manual', timeoutHours: 500 }, now)
  check('★ 超时超过 20 天上限 → 明确拒绝',
    tooLong.plan === undefined && String(tooLong.error).includes('上限'), String(tooLong.error))

  /* 前两种模式的计划形状**一个字节都不许变**。 */
  const d = readWaitPlan({ mode: 'duration', ms: 3000 }, now)
  check('★ duration 不变：resumeAtMs = now + ms', d.plan?.resumeAtMs === now + 3000, String(d.plan?.resumeAtMs))
  check('★ duration 不变：没有 manual 那两个字段',
    d.plan?.timeoutAtMs === undefined && d.plan?.timeoutHours === undefined)
  const u = readWaitPlan({ mode: 'until', until: '09:30' }, now)
  check('★ until 不变：带了 until 文本', typeof u.plan?.until === 'string' && u.plan.until === '09:30',
    String(u.plan?.until))
}

console.log('')
console.log('=== ② JSON 往返：写盘再读回，mode 与 resumeAtMs 都不失真 ===')
{
  const now = Date.now()
  const plan = readWaitPlan({ mode: 'manual', timeoutHours: 0 }, now).plan
  const snap = {
    version: 1, runId: 'r-roundtrip', workflowId: '往返测试', startedAt: now, pausedAt: now,
    resumeAfter: 'w1', ran: ['a'], executions: 1, outputs: {}, unreachable: [], inputs: {}, wait: plan,
  }
  /** 纯 JSON 往返（不碰磁盘）。 */
  const viaJson = asSnapshot(JSON.parse(JSON.stringify(snap)))
  check('★★ 纯 JSON 往返后 mode 仍是 manual', viaJson?.wait.mode === 'manual', String(viaJson?.wait.mode))
  check('★★ 纯 JSON 往返后 resumeAtMs 逐位相等', viaJson?.wait.resumeAtMs === plan.resumeAtMs,
    String(viaJson?.wait.resumeAtMs) + ' vs ' + String(plan.resumeAtMs))
  check('★ 往返后不是 null（Infinity 那条坑没踩）', viaJson !== null)
  check('★ 那个值在 JSON 里是有限数（typeof number）',
    typeof JSON.parse(JSON.stringify(plan)).resumeAtMs === 'number',
    typeof JSON.parse(JSON.stringify(plan)).resumeAtMs)

  /* 真写盘再读回（沙箱）。 */
  const saved = await savePausedRun(snap)
  check('★ 现场写盘成功', saved === true, String(saved))
  const back = await loadPausedRun('r-roundtrip')
  check('★★ 磁盘往返后 mode 仍是 manual', back?.wait.mode === 'manual', String(back?.wait.mode))
  check('★★ 磁盘往返后 resumeAtMs 逐位相等', back?.wait.resumeAtMs === plan.resumeAtMs,
    String(back?.wait.resumeAtMs))
  check('★ 磁盘往返后 resumeAfter 没变', back?.resumeAfter === 'w1', String(back?.resumeAfter))

  const raw = JSON.parse(await readFile(join(pausedDir(), 'r-roundtrip.json'), 'utf8'))
  check('★ 盘上那个值确实是数字（不是 null）', typeof raw.wait.resumeAtMs === 'number',
    JSON.stringify(raw.wait))

  /* 带超时的那一份也要往返得住。 */
  const toPlan = readWaitPlan({ mode: 'manual', timeoutHours: 3 }, now).plan
  const toSnap = { ...snap, runId: 'r-roundtrip-to', wait: toPlan }
  await savePausedRun(toSnap)
  const toBack = await loadPausedRun('r-roundtrip-to')
  check('★★ 带超时的现场往返后 timeoutAtMs 还在', toBack?.wait.timeoutAtMs === toPlan.timeoutAtMs,
    String(toBack?.wait.timeoutAtMs))
  check('★★ 带超时的现场往返后 timeoutHours 还在', toBack?.wait.timeoutHours === 3,
    String(toBack?.wait.timeoutHours))
}

console.log('')
console.log('=== ③ 自动扫盘器不会把「等人点继续」捡走 ===')
{
  const now = Date.now()
  const forever = readWaitPlan({ mode: 'manual', timeoutHours: 0 }, now).plan
  const snap = {
    version: 1, runId: 'r-forever', workflowId: '扫盘测试', startedAt: now, pausedAt: now,
    resumeAfter: 'w1', ran: [], executions: 0, outputs: {}, unreachable: [], inputs: {}, wait: forever,
  }
  /* 系统时间推过很多：1 小时后、30 天后、10 年后 —— 都不许被捡。 */
  for (const [name, at] of [
    ['1 小时后', now + 3600 * 1000],
    ['30 天后', now + 30 * 86400 * 1000],
    ['10 年后', now + 10 * 365 * 86400 * 1000],
  ]) {
    check('★★ ' + name + ' 仍不会被自动恢复', scannerWouldPick(snap, at) === false, String(at))
  }
  check('★ 扫盘判据对它永远为「跳过」（这就是扫盘器不用改的原因）', scannerWouldPick(snap, now) === false)

  /* 设了超时的那一份：到点**会**被捡起来 —— 那时才判失败（见第 ⑤ 段）。 */
  const timed = readWaitPlan({ mode: 'manual', timeoutHours: 1 }, now).plan
  const timedSnap = { ...snap, runId: 'r-timed', wait: timed }
  check('★ 设了超时 → 未到点不捡', scannerWouldPick(timedSnap, now + 1800 * 1000) === false)
  check('★ 设了超时 → 到点会被捡（恢复入口据此判失败）',
    scannerWouldPick(timedSnap, now + 3600 * 1000) === true)

  /* 前两种模式照旧：到点会被捡。 */
  const dur = readWaitPlan({ mode: 'duration', ms: 60000 }, now).plan
  check('★ duration 到点仍会被捡（老行为不变）',
    scannerWouldPick({ ...snap, wait: dur }, now + 61000) === true)
}

console.log('')
console.log('=== ④ 跑到该节点就停住：后续节点一个都不跑 ===')
{
  const nodes = [
    spec('a'),
    spec('w', { def: waitDef, defId: 'flow.wait', params: { mode: 'manual', timeoutHours: 0 }, onError: 'continue' }),
    spec('b'),
    spec('c'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'b'), edge('b', 'c')]
  const d = fakeDispatch()
  /* ⚠️ `runGraph` **不抛**：内部的 `RunPausedError` 被它接住、作为 `r.paused` 交回来
   * （见 `runGraph` 跑主序那一段）。所以判据是 `r.paused`，不是 try/catch。 */
  const r = await runGraph({ nodes, edges }, d.fn, { workflowId: '等人测试', runId: 'r-manual' })
  const paused = r.paused
  check('★★ 挂起了（`paused` 有值），不是跑完', paused !== undefined && paused !== null,
    JSON.stringify(r.paused === undefined ? null : { mode: r.paused.wait.mode }))
  check('★★ 挂起时 ok 语义：没中断（aborted 为假）', r.aborted === false, String(r.aborted))
  check('★★ 挂起点的后续节点一个都没派发',
    !d.calls.some(c => c.nodeId === 'b' || c.nodeId === 'c'), d.calls.map(c => c.nodeId).join(','))
  check('★★ 前面那个节点跑了', d.calls.some(c => c.nodeId === 'a'), d.calls.map(c => c.nodeId).join(','))
  check('★ 现场里 mode 是 manual', paused?.wait.mode === 'manual', String(paused?.wait.mode))
  check('★ 现场记的从哪继续 = 那个等待节点', paused?.resumeAfter === 'w', String(paused?.resumeAfter))
  check('★ 现场里上游原样穿过去了（b 将来读得到 a 的输出）',
    paused?.outputs?.w === 'out:a', JSON.stringify(paused?.outputs?.w))
}

console.log('')
console.log('=== ⑤ 超时：判失败，不是静默继续、也不是永远挂着 ===')
{
  const now = Date.now()
  /* 不限超时 → 推多久都不超时。 */
  const forever = readWaitPlan({ mode: 'manual', timeoutHours: 0 }, now).plan
  check('★★ timeoutHours 0 → 1 年后仍不算超时',
    manualTimeoutReason(forever, now + 365 * 86400 * 1000) === null)

  /* 超时 1 小时 → 到点、过点都是超时。 */
  const timed = readWaitPlan({ mode: 'manual', timeoutHours: 1 }, now).plan
  check('★ 未到点不算超时', manualTimeoutReason(timed, now + 1800 * 1000) === null)
  check('★★ 刚好到点算超时（与扫盘器的判据一致）',
    manualTimeoutReason(timed, now + 3600 * 1000) !== null, String(manualTimeoutReason(timed, now + 3600 * 1000)))
  const late = manualTimeoutReason(timed, now + 2 * 3600 * 1000)
  check('★★ 过点算超时，且原因里说清等了多久、会怎么样',
    late !== null && late.includes('1 小时') && late.includes('失败'), String(late))
  check('★ 原因里给了下一步怎么办（重新跑 / 先处理好再恢复）',
    String(late).includes('重新跑') || String(late).includes('手动恢复'), String(late))

  /* 前两种模式不受这个判断影响。 */
  const dur = readWaitPlan({ mode: 'duration', ms: 1000 }, now).plan
  check('★ duration 不会被判超时（这个判断只管 manual）',
    manualTimeoutReason(dur, now + 1e12) === null)
}

console.log('')
console.log('=== ⑥ 走完整调度：超时的现场恢复时判失败（aborted，且不再往下跑）===')
{
  const now = Date.now()
  const nodes = [
    spec('a'),
    spec('w', { def: waitDef, defId: 'flow.wait', params: { mode: 'manual', timeoutHours: 1 }, onError: 'continue' }),
    spec('b'),
  ]
  const edges = [edge('a', 'w'), edge('w', 'b')]

  /* 先真跑一次拿到现场（`runGraph` 不抛，挂起在 `r.paused` 里）。 */
  const d1 = fakeDispatch()
  const r1 = await runGraph({ nodes, edges }, d1.fn, { workflowId: '超时测试', runId: 'r-timeout' })
  const snap = r1.paused
  check('★ 先挂起、拿到现场', snap !== null && snap !== undefined,
    String(snap?.wait?.mode))

  /* 把现场的超时时刻改成「早就过了」，再按恢复语义跑一次。 */
  const expired = {
    ...snap,
    wait: { ...snap.wait, resumeAtMs: now - 1000, timeoutAtMs: now - 1000 },
  }
  const d2 = fakeDispatch()
  const events = []
  const r2 = await runGraph({ nodes, edges, resume: expired }, d2.fn, { onEvent: (e) => events.push(e) })
  check('★★ 超时恢复 → 标为中断（不是静默继续）', r2.aborted === true, String(r2.aborted))
  check('★★ 超时恢复 → 后续节点一个都没跑', !d2.calls.some(c => c.nodeId === 'b'),
    d2.calls.map(c => c.nodeId).join(','))
  check('★★ 超时恢复 → 发了 failed 事件', events.some(e => e.kind === 'failed'),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  check('★ 超时恢复 → 日志里说清是超时',
    events.some(e => e.kind === 'log' && String(e.line).includes('超时')),
    events.filter(e => e.kind === 'log').map(e => e.line).join(' | ').slice(0, 120))
  check('★ 没被当成「又挂起」（没有新的现场）', r2.paused === undefined)

  /* 对照：同一个现场若**没超时**，恢复能正常跑完（证明上面那条不是「恢复坏了」）。 */
  const okSnap = { ...snap, wait: { ...snap.wait, resumeAtMs: WAIT_MANUAL_FOREVER_MS, timeoutAtMs: undefined } }
  const d3 = fakeDispatch()
  const r3 = await runGraph({ nodes, edges, resume: okSnap }, d3.fn)
  check('★★ 对照：未超时的现场恢复后跑完了（后续节点跑了）',
    r3.aborted === false && d3.calls.some(c => c.nodeId === 'b'),
    'aborted=' + String(r3.aborted) + ' calls=' + d3.calls.map(c => c.nodeId).join(','))
}

console.log('')
console.log('=== ⑦ 端到端：存档 → 挂起 → 落盘 → 从盘上读回 → 恢复跑完 ===')
{
  const WF = '等待-等人点继续（测试）'
  const doc = {
    version: 1,
    name: WF,
    nodes: [
      { id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return { v: 1 }' }, onError: 'stop' },
      { id: 'n2', defId: 'flow.wait', position: { x: 200, y: 0 }, params: { mode: 'manual', timeoutHours: 0 }, onError: 'continue' },
      { id: 'n3', defId: 'code.js', position: { x: 400, y: 0 }, params: { code: 'return { done: true }' }, onError: 'stop' },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  await saveWorkflow(doc, WF)

  /** 假派发（真跑路要的那个形状）。 */
  const calls = []
  const dispatch = async (req) => {
    calls.push(req.nodeId)
    if (req.nodeId === 'n1') return { ok: true, status: 'success', output: { v: 1 }, logs: [] }
    return { ok: true, status: 'success', output: { done: true }, logs: [] }
  }

  const runId = 'r-e2e-manual'
  const first = await runWorkflowFile(WF, NODE_LIBRARY, dispatch, { workdir: sandbox, runId })
  check('★★ 第一次跑：挂起了（ok 仍真）', first.ok === true && first.paused !== undefined,
    JSON.stringify({ ok: first.ok, paused: first.paused !== undefined }))
  check('★ 挂起时后续节点没跑', !calls.includes('n3'), calls.join(','))

  const saved = await savePausedRun(first.paused)
  check('★ 现场落盘成功', saved === true)

  /* 盘上确实有它（并且扫盘器列表里也看得到）。 */
  const files = await readdir(pausedDir()).catch(() => [])
  check('★ paused/ 里有这一份', files.includes(runId + '.json'), files.join(','))
  const listed = await listPausedRuns()
  check('★ 列表里能列出它（界面「等待中」靠这个）',
    listed.some(s => s.runId === runId), listed.map(s => s.runId).join(','))
  check('★★ 列表里它的 mode 仍是 manual', listed.find(s => s.runId === runId)?.wait.mode === 'manual',
    String(listed.find(s => s.runId === runId)?.wait.mode))

  /* 时间推很久：扫盘判据仍跳过它（第 ③ 段已经在纯逻辑上验过，这里验盘上那份）。 */
  const fromDisk = await loadPausedRun(runId)
  check('★★ 盘上那份推 10 年后仍不会被自动恢复',
    scannerWouldPick(fromDisk, Date.now() + 10 * 365 * 86400 * 1000) === false)

  /* 人工恢复（= `POST /workflow/resume` 那条路）→ 跑完。 */
  calls.length = 0
  const resumed = await runWorkflowFile(WF, NODE_LIBRARY, dispatch, {
    workdir: sandbox, resume: fromDisk, runId: 'r-e2e-manual-resumed',
  })
  check('★★ 恢复后跑完了（ok 真、没中断）', resumed.ok === true && resumed.aborted === false,
    JSON.stringify({ ok: resumed.ok, aborted: resumed.aborted }))
  check('★★ 恢复后**只**跑了挂起点的下游（n1 不重跑、n3 跑了）',
    calls.join(',') === 'n3', calls.join(','))
}

console.log('')
if (failed === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(failed) + ' 条红的 ✗')
process.exit(1)

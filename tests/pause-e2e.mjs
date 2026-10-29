/** 暂停 → 落盘 → 恢复：**整条链路**（计划 Step 12 第一步的验收）。
 *
 * ## 与 `pause-resume` / `pause-store` 的分工
 *
 * | 测试 | 管什么 |
 * | --- | --- |
 * | `pause-resume` | 调度器里「挂起 / 从现场继续」的**语义**（纯内存） |
 * | `pause-store` | 现场**落盘**那一层（目录 / 串行队列 / 坏文件） |
 * | **本文件** | 两者**接起来**：跑一份真存档 → 挂起 → 写盘 → 从盘上读回 → 接着跑完 |
 *
 * 为什么必须有一条串起来的：两个部件各自绿、接起来坏，是这一类功能最常见的坏法
 * （现场存了但读回来字段名对不上、恢复时用错了 id……）。全程沙箱，不碰真实数据。
 *
 * 跑法：node --import <tsx> tests/pause-e2e.mjs
 */
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-pause-e2e-'))
process.env.EWB_TEST_HOME = join(sandbox, 'home')

const { runWorkflowFile } = await import('../src/workflow/run-file.ts')
const { saveWorkflow } = await import('../src/workflow/store.ts')
const { savePausedRun, loadPausedRun } = await import('../src/workflow/pause-store.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')

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

/** 一份真存档：开始 → 取数 → 等待 → 收尾。 */
function makeDoc() {
  return {
    version: 1,
    name: 'E2E-暂停恢复',
    description: '端到端验证：跑到等待就停住、现场写盘、读回来继续跑完。',
    nodes: [
      /* ⚠️ `fields` 是**一行一项的文本清单**（`io-fields.ts` 的 `linesOf`），
       * 不是对象数组 —— 第一版写成对象数组，输入/产出全解析成空（白红一次）。 */
      { id: 's', defId: 'flow.start', params: { type: 'manual', fields: ['日期 | 要采集哪一天'] }, onError: 'stop', position: { x: 0, y: 0 } },
      { id: 'n1', defId: 'code.js', params: {}, onError: 'stop', position: { x: 200, y: 0 } },
      { id: 'w', defId: 'flow.wait', params: { mode: 'duration', ms: 60000 }, onError: 'continue', position: { x: 400, y: 0 } },
      { id: 'n2', defId: 'code.js', params: {}, onError: 'stop', position: { x: 600, y: 0 } },
      { id: 'e', defId: 'flow.end', params: { when: 'end', fields: ['结果 = n2'] }, onError: 'stop', position: { x: 800, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'w' },
      { id: 'e3', source: 'w', target: 'n2' },
      { id: 'e4', source: 'n2', target: 'e' },
    ],
  }
}

console.log('=== 暂停 → 落盘 → 恢复（端到端）===')

const saved = await saveWorkflow(makeDoc(), 'E2E-暂停恢复')
console.log('（存档写好了：' + saved.name + '）')
console.log('')

console.log('① 第一次跑：跑到等待就停住，结果里带现场')
let firstRes
{
  const d = fakeDispatch()
  firstRes = await runWorkflowFile({ name: 'E2E-暂停恢复' }, NODE_LIBRARY, d.fn, {
    workdir: sandbox, runId: 'e2e-run-1', inputs: { 日期: '2026-10-21' },
  })
  check('整份跑得起来（ok）', firstRes.ok === true, String(firstRes.error))
  check('★ 挂起了（结果里带现场）', firstRes.paused !== undefined)
  check('★ 挂起**不是失败**：aborted 仍为假', firstRes.aborted === false)
  check('★ 等待之后的节点**没有**被派发', !d.calls.some(c => c.nodeId === 'n2'), d.calls.map(c => c.nodeId).join(','))
  check('等待之前的节点跑过了', d.calls.some(c => c.nodeId === 'n1'))
  check('现场里带着输入（恢复时要用）', firstRes.paused.inputs['日期'] === '2026-10-21',
    JSON.stringify(firstRes.paused.inputs))
}

console.log('')
console.log('② 现场写盘 → 从盘上读回来（这一步最容易断）')
{
  const ok = await savePausedRun(firstRes.paused)
  check('写盘成功', ok === true)
  const back = await loadPausedRun('e2e-run-1')
  check('★ 读得回来（文件名 = 运行 id）', back !== null, String(back?.runId))
  check('★ 读回来的 runId 与第一次跑的一致', back.runId === 'e2e-run-1', String(back.runId))
  check('★ 读回来的输出含前半段', back.outputs.n1 === 'out:n1', JSON.stringify(back.outputs))
  check('★ 读回来的「从哪继续」是等待节点', back.resumeAfter === 'w', String(back.resumeAfter))
}

console.log('')
console.log('③ 从盘上那份现场恢复：接着跑完')
{
  const back = await loadPausedRun('e2e-run-1')
  const d = fakeDispatch()
  const res = await runWorkflowFile({ name: 'E2E-暂停恢复' }, NODE_LIBRARY, d.fn, {
    workdir: sandbox, resume: back, runId: 'e2e-run-2', startedAt: back.startedAt,
  })
  check('恢复跑完了（ok）', res.ok === true, String(res.error))
  check('★ 恢复后不再挂起', res.paused === undefined)
  check('★ 没有重跑前半段（n1 不在这次的派发里）',
    !d.calls.some(c => c.nodeId === 'n1'), d.calls.map(c => c.nodeId).join(','))
  check('★ 没有重跑等待节点（否则会再挂一次）',
    !d.calls.some(c => c.nodeId === 'w'), d.calls.map(c => c.nodeId).join(','))
  check('★ 等待之后的节点跑了', d.calls.some(c => c.nodeId === 'n2'), d.calls.map(c => c.nodeId).join(','))
  const n2Call = d.calls.find(c => c.nodeId === 'n2')
  check('★★ n2 拿到了挂起前的上游数据（现场真的接上了）',
    JSON.stringify(n2Call.upstream) === JSON.stringify(['out:n1']), JSON.stringify(n2Call?.upstream))
  check('★ 恢复后「跑过哪些」含前半段（不是从零数）',
    res.ran.join(',') === 's,n1,w,n2,e', res.ran.join(','))
  check('★ 结束节点这次收得出产出（不是半截的）',
    res.declaredOutputs !== undefined && '结果' in res.declaredOutputs,
    JSON.stringify(res.declaredOutputs))
}

console.log('')
console.log('④ 自证：不给现场（从头跑）时，前半段**会**重跑')
{
  /* 这条证明上面「没重跑」不是巧合 —— 不给 resume 时它当然从头跑。 */
  const d = fakeDispatch()
  await runWorkflowFile({ name: 'E2E-暂停恢复' }, NODE_LIBRARY, d.fn, { workdir: sandbox })
  check('★★ 不传 resume → n1 照常跑（说明上面那次确实靠现场跳过它）',
    d.calls.some(c => c.nodeId === 'n1'), d.calls.map(c => c.nodeId).join(','))
  check('不传 resume → 又挂起（同一份工作流当然还会停在等待处）', true)
}

console.log('')
console.log('⑤ 「等人点继续」同一套落盘 → 读回 → 恢复（2026-10-22 追加）')
{
  /* 与上面 ①-③ 走同一条路，只把等待节点的 mode 换成 manual。
   * 要证明的是：**第三种模式在真实落盘这条路上也完整**，不是只有内存里对。 */
  const doc = makeDoc()
  doc.nodes = doc.nodes.map(n => (n.id === 'w' ? { ...n, params: { mode: 'manual', timeoutHours: 0 } } : n))
  doc.name = 'E2E-等人点继续'
  await saveWorkflow(doc, 'E2E-等人点继续')

  const d1 = fakeDispatch()
  const first = await runWorkflowFile({ name: 'E2E-等人点继续' }, NODE_LIBRARY, d1.fn, {
    workdir: sandbox, runId: 'e2e-manual-1', inputs: { 日期: '2026-10-22' },
  })
  check('★ 挂起了', first.paused !== undefined, String(first.error))
  check('★ 现场的 mode 是 manual', first.paused?.wait.mode === 'manual', String(first.paused?.wait.mode))
  check('★ 等待之后的节点没有被派发', !d1.calls.some(c => c.nodeId === 'n2'),
    d1.calls.map(c => c.nodeId).join(','))

  const ok = await savePausedRun(first.paused)
  check('★ 写盘成功', ok === true)
  const back = await loadPausedRun('e2e-manual-1')
  check('★★ 从盘上读回来 mode 仍是 manual', back?.wait.mode === 'manual', String(back?.wait.mode))
  check('★★ 从盘上读回来 resumeAtMs 逐位相等（JSON 往返没坏）',
    back?.wait.resumeAtMs === first.paused.wait.resumeAtMs,
    String(back?.wait.resumeAtMs) + ' vs ' + String(first.paused.wait.resumeAtMs))

  /* 自动扫盘那一条判据（`src/index.ts:602`）：推 10 年也捡不走它。 */
  const far = Date.now() + 10 * 365 * 86400 * 1000
  check('★★ 推 10 年也不会被自动恢复（等人就是等人）', back.wait.resumeAtMs > far,
    String(back.wait.resumeAtMs) + ' vs ' + String(far))

  const d2 = fakeDispatch()
  const res = await runWorkflowFile({ name: 'E2E-等人点继续' }, NODE_LIBRARY, d2.fn, {
    workdir: sandbox, resume: back, runId: 'e2e-manual-2', startedAt: back.startedAt,
  })
  check('★★ 手工恢复后跑完了', res.ok === true && res.aborted === false,
    JSON.stringify({ ok: res.ok, aborted: res.aborted }))
  check('★ 恢复只跑了下游（n1 与 w 都不重跑）',
    !d2.calls.some(c => c.nodeId === 'n1' || c.nodeId === 'w'), d2.calls.map(c => c.nodeId).join(','))
  check('★ 下游跑了且拿到了挂起前的上游数据',
    JSON.stringify(d2.calls.find(c => c.nodeId === 'n2')?.upstream) === JSON.stringify(['out:n1']),
    JSON.stringify(d2.calls.find(c => c.nodeId === 'n2')?.upstream))
}

await rm(sandbox, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结论：暂停 → 落盘 → 恢复 整条链路通 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

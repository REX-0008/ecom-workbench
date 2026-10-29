/** 恢复前核一次工作流指纹（票 17，2026-10-27）。
 *
 * ## 它防的是什么
 *
 * 挂起时存了现场，但没存「当时这份工作流长什么样」。恢复时不管改没改都按旧现场跑。
 * 用户改过节点参数、删过节点，点「继续」后界面显示成功，实际跑的是旧数据 ——
 * **这比报错更糟，因为看不出来。**
 *
 * ## 这一条为什么必须真跑一遍「挂起 → 改档 → 恢复」
 *
 * 只验指纹函数本身（同一份得同一个值）是假绿：那条证明的是「哈希稳定」，
 * 不是「恢复会被拦住」。所以这里走完整条链：
 * 真存档 → `runWorkflowFile` 挂起 → 存现场 → **改存档** → 再从现场恢复。
 *
 * ## 判据落在「拒绝的理由对不对」，不是「拒绝了」
 *
 * 「一律拒绝」也能让「改过 → 拒绝」变绿，所以这里另有一条
 * 「没改过 → 照常恢复」守着。两条一起才说明它是在**比对**，不是在**总拒**。
 *
 * 跑法：`node --import <tsx loader> tests/resume-fingerprint.mjs`
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SANDBOX = await mkdtemp(join(tmpdir(), 'ewb-fingerprint-'))
process.env.EWB_TEST_HOME = SANDBOX

/** 本目录（源码层断言要用）。 */
const HERE = fileURLToPath(new URL('.', import.meta.url))

const { runWorkflowFile } = await import('../src/workflow/run-file.ts')
const { saveWorkflow, loadWorkflowByRef } = await import('../src/workflow/store.ts')
const { savePausedRun, loadPausedRun } = await import('../src/workflow/pause-store.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { docFingerprint, checkResumeFingerprint } = await import('../src/workflow/fingerprint.ts')

const OPTS = { dshHome: SANDBOX, profile: 'test' }

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
 * 派发替身：`code.js` 走真实现，`flow.wait` 由调度器解释、这里永远走不到。
 * @param req - 派发请求。
 * @returns 结果。
 */
async function fakeDispatch(req) {
  const { runCodeFn } = await import('../src/dispatch/builtins.ts')
  const out = await runCodeFn(req.command, { nodeId: req.nodeId, workdir: SANDBOX, upstream: req.context.upstream })
  return { ok: true, status: 'success', output: out, logs: [] }
}

/** 一份「跑一半会挂起」的最小工作流：n1 算个值 → n2 等人点继续 → n3 用它。 */
function docOf(overrides = {}) {
  return {
    version: 1,
    name: '指纹用的',
    nodes: [
      { id: 'n1', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1', timeout: 5000 }, onError: 'stop', skipped: false },
      { id: 'n2', type: 'v1', defId: 'flow.wait', position: { x: 200, y: 0 }, params: { mode: 'manual', timeoutHours: 0 }, onError: 'stop', skipped: false },
      { id: 'n3', type: 'v1', defId: 'code.js', position: { x: 400, y: 0 }, params: { code: 'return input + 1', timeout: 5000 }, onError: 'stop', skipped: false },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', targetHandle: 'in' },
      { id: 'e2', source: 'n2', target: 'n3', targetHandle: 'in' },
    ],
    ...overrides,
  }
}

console.log('=== 恢复前核一次工作流指纹（票 17）===')
console.log('')

/* ── ⓪ 指纹函数本身：稳定、且只认执行相关字段 ──────────────────────
 *
 * 这一段守的是「算法判对了没有」。它单独成立还不够（下面还要端到端），
 * 但它是最便宜的一层：字段挑错时，这里立刻就能看出来是哪一项。 */
console.log('⓪ 指纹算哪些字段')
{
  const base = docOf()
  const fp = docFingerprint(base)
  check('★ 同一份存档得同一个值', docFingerprint(docOf()) === fp, fp)
  check('★ 是 16 位十六进制', /^[0-9a-f]{16}$/.test(fp), fp)

  /* 挪坐标：**不该**变（纯视觉）。 */
  const moved = docOf()
  moved.nodes[0].position = { x: 999, y: 888 }
  check('★★ 只挪节点坐标，指纹不变（纯视觉不算）', docFingerprint(moved) === fp, docFingerprint(moved))

  /* 改实例名 / 备注：**不该**变（只影响显示）。 */
  const renamed = docOf()
  renamed.nodes[1].label = '改了个名字'
  renamed.nodes[1].note = '加了句备注'
  check('★★ 只改节点名与备注，指纹不变', docFingerprint(renamed) === fp, docFingerprint(renamed))

  /* 改顶层名字 / 说明：**不该**变（改名不该让跑一半的运行作废）。 */
  const renamedWf = docOf({ name: '换了个工作流名', description: '加了说明' })
  check('★★ 只改工作流名字与说明，指纹不变', docFingerprint(renamedWf) === fp, docFingerprint(renamedWf))

  /* 改节点参数：**该**变。 */
  const param = docOf()
  param.nodes[0].params.code = 'return 2'
  check('★★ 改节点参数，指纹变（会改变执行结果）', docFingerprint(param) !== fp, docFingerprint(param))

  /* 改失败策略：**该**变。 */
  const onerr = docOf()
  onerr.nodes[0].onError = 'continue'
  check('★★ 改失败策略，指纹变', docFingerprint(onerr) !== fp, docFingerprint(onerr))

  /* 换节点类型：**该**变。 */
  const defid = docOf()
  defid.nodes[2].defId = 'code.shell'
  check('★★ 换节点类型，指纹变', docFingerprint(defid) !== fp, docFingerprint(defid))

  /* 删节点：**该**变。 */
  const cut = docOf()
  cut.nodes.pop()
  check('★★ 删掉一个节点，指纹变', docFingerprint(cut) !== fp, docFingerprint(cut))

  /* 改连线（含出口）：**该**变 —— `sourceHandle` 决定走哪条分支，最容易漏。 */
  const edge = docOf()
  edge.edges[0].sourceHandle = 'false'
  check('★★ 改连线的出口（sourceHandle），指纹变', docFingerprint(edge) !== fp, docFingerprint(edge))

  /* 参数键的顺序不影响（同一份内容的两种写法应当等价）。 */
  const reordered = docOf()
  reordered.nodes[0].params = { timeout: 5000, code: 'return 1' }
  check('★ 参数键顺序不同、内容相同 → 指纹不变（键序已规范化）',
    docFingerprint(reordered) === fp, docFingerprint(reordered))
}

/* ── ① 真跑一遍：挂起 → 存现场 → 改档 → 恢复被拒 ──────────────── */
console.log('')
console.log('① 改过工作流 → 拒绝恢复（且理由说清是「工作流已改动」）')
{
  await saveWorkflow(docOf(), '指纹用的', OPTS)
  const first = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, runId: 'fp-run-1', dshHome: SANDBOX, profile: 'test',
  })
  check('★ 第一次真挂起了', first.paused !== undefined, String(first.ok))
  check('★★ 现场里带上了指纹', typeof first.paused?.fingerprint === 'string' && first.paused.fingerprint !== '',
    String(first.paused?.fingerprint))
  await savePausedRun(first.paused, { dshHome: SANDBOX, profile: 'test' })
  const back = await loadPausedRun('fp-run-1', { dshHome: SANDBOX, profile: 'test' })
  check('★★ 存盘再读回来，指纹还在（不是只在内存里）',
    back?.fingerprint === first.paused.fingerprint, String(back?.fingerprint))

  /* 改档：把 n1 的参数改掉（真改动，不是挪位置）。 */
  const changed = docOf()
  changed.nodes[0].params.code = 'return 42'
  await saveWorkflow(changed, '指纹用的', OPTS)

  const res = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, resume: back, runId: 'fp-run-2', dshHome: SANDBOX, profile: 'test',
  })
  check('★★ 拒绝恢复（ok 为假）', res.ok === false, String(res.ok))
  /* ⚠️ 判据落在**理由对不对**上，不是「拒绝了」——「一律拒绝」也能让上一条变绿。 */
  check('★★ 理由里说清是「工作流已改动」', String(res.error ?? '').includes('工作流已改动'),
    String(res.error ?? '').slice(0, 60))
  check('★★ 理由里说明了「此前存的现场不再适用」',
    String(res.error ?? '').includes('不再适用'), '')
  check('★★ 理由里给了下一步（重新运行一次）',
    String(res.error ?? '').includes('重新运行'), '')
  check('★★ 一个字都没跑（ran 为空）', res.ran.length === 0, JSON.stringify(res.ran))
}

/* ── ② 没改过 → 照常恢复（这条防「一律拒绝」） ────────────────── */
console.log('')
console.log('② 没改过 → 正常恢复')
{
  await saveWorkflow(docOf(), '指纹用的', OPTS)
  const first = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, runId: 'fp-run-3', dshHome: SANDBOX, profile: 'test',
  })
  await savePausedRun(first.paused, { dshHome: SANDBOX, profile: 'test' })
  const back = await loadPausedRun('fp-run-3', { dshHome: SANDBOX, profile: 'test' })

  /* 存档一个字没动，直接从现场恢复。 */
  const res = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, resume: back, runId: 'fp-run-4', dshHome: SANDBOX, profile: 'test',
  })
  check('★★ 没改过时照常恢复（ok 为真、没被中断）', res.ok === true && res.aborted === false,
    'ok=' + String(res.ok) + ' aborted=' + String(res.aborted))
  check('★★ 恢复后真的往下跑了（n3 跑到了）', res.ran.includes('n3'), JSON.stringify(res.ran))
  check('★ 没有 error', res.error === undefined, String(res.error))
}

/* ── ③ 只挪坐标 → 仍然恢复（验「一」那条判对了没有） ───────────── */
console.log('')
console.log('③ 只挪节点坐标 → 仍然恢复')
{
  await saveWorkflow(docOf(), '指纹用的', OPTS)
  const first = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, runId: 'fp-run-5', dshHome: SANDBOX, profile: 'test',
  })
  await savePausedRun(first.paused, { dshHome: SANDBOX, profile: 'test' })
  const back = await loadPausedRun('fp-run-5', { dshHome: SANDBOX, profile: 'test' })

  /* 把三个节点全部挪到别处 + 改实例名与备注（都是纯视觉）。 */
  const moved = docOf()
  moved.nodes[0].position = { x: 11, y: 22 }
  moved.nodes[1].position = { x: 333, y: 444 }
  moved.nodes[1].label = '等人'
  moved.nodes[2].note = '算加一'
  moved.name = '换个名字也一样'
  await saveWorkflow(moved, '换个名字也一样', OPTS)

  const res = await runWorkflowFile({ name: '换个名字也一样' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, resume: back, runId: 'fp-run-6', dshHome: SANDBOX, profile: 'test',
  })
  /* ⚠️ 这里**必须**仍然恢复。判错了的症状：用户只是拖了一下节点位置，
   * 点继续就被拒，他会以为是自己操作错了。 */
  check('★★ 只挪位置 / 改名 / 改备注 → 照样恢复', res.ok === true && res.aborted === false,
    'ok=' + String(res.ok) + ' error=' + String(res.error ?? '（无）'))
  check('★ 也真的往下跑了', res.ran.includes('n3'), JSON.stringify(res.ran))
}

/* ── ④ 旧现场（没有指纹字段）→ 不炸，按「一致」处理 ────────────── */
console.log('')
console.log('④ 老现场没有指纹字段')
{
  await saveWorkflow(docOf(), '指纹用的', OPTS)
  /* 造一份**删掉 fingerprint** 的现场（模拟加这个字段之前存的）。 */
  const old = {
    version: 1, runId: 'fp-run-7', workflowId: '指纹用的',
    startedAt: Date.now() - 1000, pausedAt: Date.now() - 1000,
    resumeAfter: 'n2', ran: ['n1'], executions: 1,
    outputs: { n1: 1 }, unreachable: [], inputs: {},
    wait: { mode: 'manual', resumeAtMs: Number.MAX_SAFE_INTEGER, ms: 0 },
  }
  await savePausedRun(old, { dshHome: SANDBOX, profile: 'test' })
  const back = await loadPausedRun('fp-run-7', { dshHome: SANDBOX, profile: 'test' })
  check('★ 读回来没有 fingerprint 这个键', back.fingerprint === undefined, String(back.fingerprint))

  /* 放开一记日志的观察点。 */
  const logs = []
  const res = await runWorkflowFile({ name: '指纹用的' }, NODE_LIBRARY, fakeDispatch, {
    workdir: SANDBOX, resume: back, runId: 'fp-run-8', dshHome: SANDBOX, profile: 'test',
    onEvent: (e) => { if (e.kind === 'log') logs.push(e.line) },
  })
  check('★★ 老现场不炸，照常恢复（不能一律拒绝）', res.ok === true && res.aborted === false,
    'ok=' + String(res.ok) + ' error=' + String(res.error ?? '（无）'))
  /* 但必须**说出来**：不记一笔的话，以后没人知道这次没核。 */
  const said = logs.find(l => l.includes('指纹'))
  check('★★ 记了一笔「这份现场没法核对」的日志（不静默）',
    said !== undefined, said ?? logs.slice(0, 2).join(' / '))
  check('★ 那一行说清了按原样继续', String(said ?? '').includes('按原样继续'), String(said ?? ''))
}

/* ── ⑤ 比对函数本身的三档 ──────────────────────────────────────── */
console.log('')
console.log('⑤ checkResumeFingerprint 的三档')
{
  const doc = docOf()
  const fp = docFingerprint(doc)
  check('★ 一致 → 放行、不是 legacy', (() => { const v = checkResumeFingerprint(fp, doc); return v.ok === true && v.legacy === false })())
  check('★ 没有指纹 → 放行且标 legacy', (() => { const v = checkResumeFingerprint(undefined, doc); return v.ok === true && v.legacy === true })())
  check('★ 空串也当 legacy', (() => { const v = checkResumeFingerprint('', doc); return v.ok === true && v.legacy === true })())
  check('★ 不一致 → 拒绝且带理由', (() => {
    const v = checkResumeFingerprint('0000000000000000', doc)
    return v.ok === false && v.reason.includes('工作流已改动')
  })())
}

console.log('')
console.log('⑥ 被拒绝的现场会留记号，自动恢复不再反复捡它（票 17 的副作用）')
{
  /* ## 为什么要这一段
   *
   * 拒绝时现场**留着**（让用户有机会把工作流改回去），而它到点了仍然「该恢复」。
   * 不记号的话自动恢复每 30 秒扫一遍、每轮拒一次 —— 用户每分钟一条通知。
   *
   * ## 这一段验到哪一层，如实说
   *
   * · **记号能存能读**：真走 `savePausedRun` / `loadPausedRun`（磁盘往返）。
   * · **扫盘器会跳过它**：只能核源码（`beat` 那个循环在 `apply()` 里的闭包中，
   *   起它要一整套假 ctx 且要等 30 秒）。这里核的是那一行判据在不在、位置对不对，
   *   并在下面标明这一条比别的弱 —— 它是「接线检查」，不是行为验证。
   *
   * 为什么仍然要它：这个副作用是本单**自己造出来的**，没有一条断言看着它的话，
   * 下一个人删掉那行 `continue` 不会有任何东西变红。 */
  const blocked = {
    version: 1, runId: 'fp-run-9', workflowId: '指纹用的',
    startedAt: 1, pausedAt: 1, resumeAfter: 'n2', ran: [], executions: 0,
    outputs: {}, unreachable: [], inputs: {},
    wait: { mode: 'duration', resumeAtMs: 1, ms: 0 },
    fingerprint: 'abcabcabcabcabca',
    resumeBlocked: '工作流已改动，此前存的现场不再适用：……',
  }
  await savePausedRun(blocked, OPTS)
  const got = await loadPausedRun('fp-run-9', OPTS)
  check('★★ 拒绝的记号能存能读（磁盘往返）',
    typeof got?.resumeBlocked === 'string' && got.resumeBlocked.includes('工作流已改动'),
    String(got?.resumeBlocked ?? '').slice(0, 30))

  /* 没有这个键时读回来应当是 `undefined`，不是空串（与其它可选字段同一条纪律）。 */
  await savePausedRun({ ...blocked, runId: 'fp-run-10', resumeBlocked: undefined }, OPTS)
  const clean = await loadPausedRun('fp-run-10', OPTS)
  check('★ 没有记号时不写这个键', clean?.resumeBlocked === undefined, String(clean?.resumeBlocked))

  /* 扫盘器那一行：接线检查（见上面说明，这一条比别的弱）。 */
  const src = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  check('★★ 自动恢复会跳过带记号的现场（接线检查）',
    /if \(snap\.resumeBlocked !== undefined\) continue/.test(src), '')
  const at = src.indexOf('if (snap.resumeBlocked !== undefined) continue')
  const inBeat = at > src.indexOf('const beat = ') && at < src.indexOf("'ecom-workbench: paused resume'")
  check('★★ 那行在扫盘器循环里（不是写在别处当摆设）', inBeat, String(at))
}

console.log('')
console.log(failed === 0
  ? '结论：恢复前会核工作流指纹，改了档就拒绝并说清原因，只挪位置照样恢复 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')

await rm(SANDBOX, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

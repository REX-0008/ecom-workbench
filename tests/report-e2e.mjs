/** 端到端：**真跑一份工作流 → 汇报真的落进运行记录与任务记录**（契约 AQ，2026-10-25）。
 *
 * ## 为什么这条必须存在
 *
 * 契约 AM / AN 各自的证据都是**在测试夹具里**验的：
 *   · `collect.mjs` 用一张**假的内置表**（`createBuiltinExecutor(new Map([[…假函数…]]))`）
 *     验「执行方会把汇报带回来」；
 *   · `schedule-notify.mjs` 用**假派发器**验「调度器把事件攒进明细」。
 *
 * 两边都对，但**磁盘上一条真实的、带 `reports` 的记录都还没有**。
 * 也就是说「从节点实现到落盘文件」这条完整链路，**一次都没真跑通过**。
 * 用户对这一批的硬要求是「不要做半成品」，所以这里把它接上：
 *
 * ```
 * 真工作流存档（flow.start → sys.fs.write）
 *   → runWorkflowFile 真跑（真调度器 / 真内置执行方 / 真写文件）
 *   → run.ts:1320 把 RunOutcome.reports 转成 report 事件
 *   → mergeNodeEvent 攒进节点明细（与运行历史同一份数据）
 *   → archiveOutputs 写任务记录
 *   → 读回磁盘上的 JSON
 * ```
 *
 * ## 这一份与 `collect.mjs` ⑫ 的分工（别重复，也别互相替代）
 *
 * | | `collect.mjs` ⑫ | 本文件 |
 * |---|---|---|
 * | 内置表 | **假的**（桩函数） | **真的** `NODE_IMPLS` |
 * | 工作流 | 不跑工作流，直接调执行方 | **真存档、真跑** |
 * | 写文件 | 不写 | **真写一个临时文件** |
 * | 落盘 | 手搓 `ArchiveInput` | 从**真跑的结果**里汇总 |
 *
 * `collect.mjs` 守的是「执行方那一层」；这里守的是「整条链没断」。
 * 两条都要有 —— 只留本文件的话，执行方内部哪一步坏了会表现成
 * 「端到端也红」但看不出是哪一环；只留那一份的话，中间接线断了没人发现。
 *
 * ## 沙箱（三个都必须隔离）
 *
 * ① `EWB_TEST_HOME` —— 存档目录与 `collect/` / `patrol/` 的根
 *    （`workflowsDir()` 与 `dataRoot()` 都从它算，见 `src/workflow/store.ts`）；
 * ② 工作流写出的那个**目标文件** —— 放同一个沙箱里；
 * ③ **临时目录名按 `process.pid` 隔离**。
 *    这个项目已经踩过：`tests/douyin-download-live.mjs` 用固定路径 `%TEMP%\名字`，
 *    两个人同时跑就互相 `rmSync` 删对方的文件，产生一串「看着像代码坏了」的假红。
 *
 * 跑法：node --import <tsx> tests/report-e2e.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ⚠️ 沙箱必须在 import 任何 src 模块**之前**设好：`workflowsDir()` 虽然在调用时才读环境变量，
 * 但 `dataRoot()` / `collectRecordsDir()` 都是一路算下来的，早设最保险
 * （与 `sub-workflow.mjs` / `pause-e2e.mjs` 同一做法）。
 *
 * ⚠️ **目录名带 `process.pid`** —— 见文件头第 ③ 条。这条不是保险起见，
 * 是踩过的坑：固定路径 + 并发 = 互相删目录。 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-report-e2e-' + String(process.pid) + '-'))
process.env.EWB_TEST_HOME = SANDBOX
mkdirSync(join(SANDBOX, 'workflows'), { recursive: true })

const { runWorkflowFile } = await import('../src/workflow/run-file.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { NODE_IMPLS } = await import('../src/nodes/impls.ts')
const { saveWorkflow } = await import('../src/workflow/store.ts')
const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
const { mergeNodeEvent } = await import('../src/workflow/node-events.ts')
const { archiveOutputs, collectRecordsDir, patrolDir } = await import('../src/schedule/records.ts')

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

console.log('=== 汇报端到端：真跑工作流 → 运行记录 → 任务记录 ===')
console.log('沙箱：' + SANDBOX)
console.log('')

/** 工作流名（**不能以「巡查-」开头**，否则记录会落到 `patrol/` 而不是 `collect/`）。 */
const WF_NAME = 'AQ汇报端到端'
/** 工作流要写出的目标文件（在沙箱里，绝不碰真实数据）。 */
const OUT_FILE = join(SANDBOX, 'aq-out', '汇报产物.txt')
/** 写进去的内容（下面断言字节数要用它的真实长度）。 */
const CONTENT = '契约 AQ：这一行是从工作流里真写出来的。'

/* ── ① 造一份真存档：flow.start → sys.fs.write ────────────────────
 *
 * 为什么用 `sys.fs.write`：它是**唯一一个已经在推汇报的内置节点**
 * （`src/dispatch/builtins.ts:104` 的 `reporter?.(…)`）。
 * 换成别的节点这条测试就验不到汇报 —— 这是它作为被测对象的原因，不是随便挑的。
 *
 * `code.js` 放在中间给写入内容：`sys.fs.write` 取 `ctx.upstream[0]` 当正文
 * （见 `builtins.ts:86`），所以上游给它一段文字，写出来的就是那段。 */
{
  await saveWorkflow({
    version: 1,
    name: WF_NAME,
    nodes: [
      {
        id: 'n1', type: 'v1', defId: 'flow.start', position: { x: 0, y: 0 },
        params: { type: 'manual', fields: [], model: '' }, onError: 'stop',
      },
      {
        id: 'n2', type: 'v1', defId: 'code.js', position: { x: 300, y: 0 },
        /* 代码节点返回字符串 —— 直接被 sys.fs.write 当正文写出去。 */
        params: { code: 'return ' + JSON.stringify(CONTENT), timeout: 10000 }, onError: 'stop',
      },
      {
        id: 'n3', type: 'v1', defId: 'sys.fs.write', position: { x: 600, y: 0 },
        params: { path: OUT_FILE, mode: 'overwrite', mkdir: true }, onError: 'stop',
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', targetHandle: 'in' },
      { id: 'e2', source: 'n2', target: 'n3', targetHandle: 'in' },
    ],
  }, WF_NAME, {})
  check('（前置）真存档写好了', existsSync(join(SANDBOX, 'workflows', WF_NAME + '.json')))
}

/* ── ② 真跑：真调度器 + 真内置执行方 ─────────────────────────────
 *
 * 派发函数**不手搓**：直接把请求交给 `createBuiltinExecutor(NODE_IMPLS)`
 * —— 与 `src/index.ts:518` 注册进派发器的是同一个东西。
 * 这样测的是「产品里真跑的那条路」，不是另写一套。
 *
 * ⚠️ 用 `NODE_IMPLS` 而不是自己塞几个假函数：一旦哪天某个节点实现不再推汇报，
 * 这条测试会红 —— 那正是它该发现的事。 */
const builtinExec = createBuiltinExecutor(NODE_IMPLS)
/** 收集节点事件（与 `src/index.ts:831` 的 `feed` 同一个函数）。 */
const byNode = new Map()

/* ⚠️ **走 `onEvent` 收事件，不自己造**（这是我的第一版写法，已改）：
 *
 * 第一版我在派发函数里手搓 `mergeNodeEvent(byNode, { kind: 'report', … })`，
 * 结果只有「汇报」那一种事件进了明细 —— `started` / `success` 全没喂，
 * 于是**没推汇报的节点（n2）根本没有明细行**，那条反面断言就假红了
 * （报「没有 n2」，而真实原因是我的测试没喂它的生命周期事件）。
 *
 * 现在把引擎的**真事件流**接进来（`run.ts:597` 的 `rawEmit` 会把它收到的
 * 每一条都交给 `opts.onEvent`）—— 这样 `byNode` 的内容与运行历史里那份
 * 是**同一个来源、同一套规则**，不是我另造一份。
 *
 * 这也顺带修掉一个更隐蔽的问题：手搓的做法验不到「`run.ts:1320` 真的把
 * `RunOutcome.reports` emit 成了 `report` 事件」—— 那一步正是链路上最容易断的一环。
 * */
let eventCount = 0
const res = await runWorkflowFile(WF_NAME, NODE_LIBRARY, async (req) => {
  const out = await builtinExec.run({
    runId: req.runId,
    nodeId: req.nodeId,
    executor: req.executor,
    command: req.command,
    context: req.context,
  })
  return {
    ok: out.status === 'success',
    status: out.status,
    ...out.output === undefined ? {} : { output: out.output },
    ...out.error === undefined ? {} : { error: out.error },
    /* ⚠️ 汇报**必须**随结果交回去：引擎（`run.ts:1320`）从 `outcome.reports`
     * 转成 `report` 事件。少这一行，`onEvent` 那边一条汇报都收不到。 */
    ...out.reports === undefined ? {} : { reports: out.reports },
  }
}, {
  workdir: SANDBOX,
  onEvent: (e) => {
    eventCount += 1
    mergeNodeEvent(byNode, e)
  },
})

check('（前置）工作流整体跑成功了', res.ok === true && res.aborted === false,
  JSON.stringify({ ok: res.ok, aborted: res.aborted, error: res.error }))
check('（前置）三个节点都跑了', res.ran.length === 3, res.ran.join(','))
check('（前置）目标文件真的被写出来了', existsSync(OUT_FILE), OUT_FILE)

/* ── ③ 断言 ①：运行记录的 nodes[] 里那个节点 reports 非空 ──────────
 *
 * 这是**上游第一环**：节点实现推的汇报，得先活到节点明细上。
 * 明细就是运行历史界面显示的那一份（`workflow-runs.ts` 的 `RunNodeLine`）。 */
const line = [...byNode.values()].find(l => l.nodeId === 'n3')
check('★★ 断言① 运行记录里 n3 的 reports 非空',
  line !== undefined && Array.isArray(line.reports) && line.reports.length > 0,
  JSON.stringify({ 有明细: line !== undefined, reports: line?.reports }))

const first = line?.reports?.[0]

/* ── ④ 断言 ②：message 里有路径、有字节数，且不是「完成」两个字 ──────
 *
 * 用户明确要求「不许拿空话充数」（`model.ts:209` 纪律 5）。
 * 所以这里同时验三样：路径在里面、字节数在里面、整句不是敷衍。 */
const msg = String(first?.message ?? '')
check('★★ 断言②a 汇报里写明了文件路径', msg.includes(OUT_FILE),
  msg.slice(0, 160))
/* 字节数：用真实内容算，不写死数字 —— 写死的话改一行文案就假红。 */
const realBytes = Buffer.byteLength(CONTENT, 'utf8')
check('★★ 断言②b 汇报里写明了字节数（' + String(realBytes) + '）',
  msg.includes(String(realBytes)), msg.slice(0, 160))
check('★★ 断言②c 汇报说的字节数与盘上文件大小一致',
  existsSync(OUT_FILE) && readFileSync(OUT_FILE, 'utf8') === CONTENT,
  String(existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8').length : '文件不在'))
check('★★ 断言②d 不是「完成」这类空话',
  msg !== '完成' && msg !== '完成。' && msg.trim().length > 10, JSON.stringify(msg))
/* 顺带：路径与字节数不能只是「碰巧」都在 —— 得是同一句话里说这两件事。 */
check('★ 汇报里路径与字节数在同一句',
  /写到 |追加到 /.test(msg) && msg.includes(String(realBytes)), msg.slice(0, 160))

/* ── ⑤ 断言 ③ + ④：archiveOutputs 落盘 → 读回来 ─────────────────
 *
 * 这里调的是**产品里那个** `archiveOutputs`，输入从真跑结果里汇总
 * （`collectReports` 的同一套规则：从明细取、挂上 node id）。 */
const startedAt = Date.now()
const reports = []
for (const l of byNode.values()) {
  for (const entry of l.reports ?? []) reports.push({ ...entry, node: l.nodeId })
}
const runId = 'aq-run-' + String(startedAt)

const archived = await archiveOutputs({
  workflowName: WF_NAME,
  ...res.declaredOutputs === undefined ? {} : { declaredOutputs: res.declaredOutputs },
  ...reports.length === 0 ? {} : { reports },
  ok: res.ok && !res.aborted,
  via: 'list',
  runId,
  startedAt,
  endedAt: Date.now(),
})
check('（前置）任务记录写成功了', archived.path !== null, archived.path ?? archived.reason)

/* ⚠️ **按节点查，不按下标取**（2026-10-27 改，票 08）。
 *
 * 原来这里写的是 `raw.reports[0]`，隐含「第一个汇报一定是 `n3`（`sys.fs.write`）的」。
 * 那个前提在 2026-10-27 之后不成立了：`code.js`（`n2`）也开始推汇报
 * （票 08，`builtins.ts` 的 `runCodeFn`），而它在图上排在 `n3` 前面，
 * 于是 `reports[0]` 变成 `n2` 那条 —— 断言红了，但**产品没坏**。
 *
 * 改成按节点 id 查之后，这几条断言的**原意一个字没变**（「`sys.fs.write` 那条
 * 汇报真的落盘了」「写的时候没改内容」），只是不再依赖「谁排第一」这个
 * 与产品无关的顺序。 */
if (archived.path !== null) {
  const raw = JSON.parse(readFileSync(archived.path, 'utf8'))
  /* 按节点查那一条（不依赖顺序）。 */
  const writeReport = raw.reports?.find(r => r.node === 'n3')
  /* 断言 ③：记录里有 reports、**没有** outputs（契约 AN 验收第 4 项）。
   * 两个都写会让读的人不知道该信哪个 —— 键名本身就是来源标记。 */
  check('★★ 断言③a 记录文件里有 reports',
    Array.isArray(raw.reports) && raw.reports.length > 0, JSON.stringify(Object.keys(raw)))
  check('★★ 断言③b 记录文件里**没有** outputs 键',
    !('outputs' in raw), JSON.stringify(Object.keys(raw)))
  /* 断言 ④：记录里找得到 `sys.fs.write` 那个节点的那条（按 node 查，不依赖顺序）。 */
  check('★★ 断言④ 记录里找得到 n3（sys.fs.write）那条汇报',
    writeReport !== undefined && writeReport.node === 'n3',
    JSON.stringify({ 记录里的节点: raw.reports?.map(r => r.node), 期望: 'n3' }))
  /* 落盘那条与内存里那条必须是同一句话 —— 防「写的时候改了内容」。 */
  check('★ 记录里的 message 与运行记录里那条一字不差',
    writeReport?.message === msg, JSON.stringify(writeReport?.message).slice(0, 160))
  /* 记录要落在 `collect/`（工作流名不以「巡查-」开头），不是 `patrol/`。 */
  check('★ 记录落在 collect/ 下', archived.path.startsWith(collectRecordsDir()),
    archived.path.replace(collectRecordsDir(), '<collect>'))
  check('★ 没有误写到 patrol/ 下', !archived.path.startsWith(patrolDir()),
    archived.path.replace(SANDBOX, '<sandbox>'))
}

/* ── ⑥ 反面：没汇报的节点**不许**冒出 reports 键 ────────────────
 *
 * ⚠️ **被测节点从 `n2`（`code.js`）换成了 `n1`（`flow.start`）**（2026-10-27，票 08）：
 * `code.js` 现在**会**推汇报了（`builtins.ts` 的 `runCodeFn`，票 08 接上的），
 * 拿它当「没汇报的节点」验反面，验的就不是这条规定了。
 * `flow.start` 确实不推汇报（它只把外部输入交出去，没有产出一说）——
 * 换掉的是**样本**，判据（不推汇报就不写空数组）**一个字没放宽**。
 *
 * 写个空数组等于多一种「有值但看不出来」的状态（与 `llm` / `depth` 同一纪律）。 */
{
  const n1 = [...byNode.values()].find(l => l.nodeId === 'n1')
  check('★ 没推汇报的节点（n1 / flow.start）明细上没有 reports 键',
    n1 !== undefined && !('reports' in n1), JSON.stringify(n1 === undefined ? '(没有 n1)' : Object.keys(n1)))
}

/* ── 收尾 ──────────────────────────────────────────────────────── */
rmSync(SANDBOX, { recursive: true, force: true })
check('临时沙箱已清理', !existsSync(SANDBOX))

console.log('')
console.log(failed === 0
  ? '结论：汇报从节点一路落进任务记录（含运行记录明细）✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

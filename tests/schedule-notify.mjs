/** 定时执行器 / 通知 / BI / 产出归档的检查（2026-10-21）。
 *
 * ## 为什么这一份必须存在
 *
 * 本轮加了五件事（产出归档、采集记录读取、BI 启动、定时执行器、系统通知），
 * 其中**四件的失败都是静默的**：
 *   · 归档没写 → 界面上「采集记录」是空的，看着像「还没跑过」；
 *   · 定时到点没跑 → 什么都不会发生（没有报错，也没有记录）；
 *   · 同一天跑两次 → 悄悄多跑一遍（采集会重复下载）；
 *   · 通知发不出去 → 用户以为「跑完了，只是没提醒」。
 *
 * 所以这里**直接验行为**，不验实现：
 *   · 真存一份带结束节点的工作流、真走 `/workflow/run`、真去看盘上有没有那个记录文件；
 *   · 真把任务时间设成「此刻」、真调 `tick()`、真数它跑了几次；
 *   · 归档的边界（没有产出 → 不写空文件）。
 *
 * 跑法：node tests/schedule-notify.mjs（`npm test` 会带上它）
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── 沙箱（必须在载入插件之前设好：模块读环境变量定目录）────────── */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-sched-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
/* 闸门：不弹通知、不起 BI 脚本（跑测试弹气球 / 开窗口会打断用户）。
 * 与 `host-dispatch` 同一个闸门。 */
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../lib/index.js')
const { seedDefaultTasks, loadTasks, updateTasks, normalizeTime, normalizeTask, tasksFile } =
  await import('../src/schedule/store.ts')
const { archiveOutputs, readCollectRecords, boardOf } = await import('../src/schedule/records.ts')
const { tick } = await import('../src/schedule/runner.ts')

/** 捕获路由处理函数。 */
let handler = null
/** 假 diag 上下文：只提供 apply 用到的 inject / effect。 */
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('subprocess')) {
      fn({
        subprocess: {
          spawn() {
            return {
              pid: 1,
              terminate() { /* 假句柄 */ },
              waitForExit: async () => true,
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
            }
          },
        },
      })
    }
  },
  /* ⚠️ 故意**不执行**回调：真 cordis 会执行（于是起定时器），
   * 测试里起一个每分钟走的定时器没有意义、还会拖着进程不干净。
   * 首次启动写默认任务这件事由下面直接调 `seedDefaultTasks()` 验。 */
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

/** 模拟一次 HTTP 调用。 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  res.writeHead = () => { /* 忽略状态码 */ }
  res.end = (s) => { out = s }
  res.writableEnded = false
  let out = ''
  await handler(req, res)
  return JSON.parse(out)
}

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} [detail] - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

console.log('① 路由注册:', handler === null ? '失败 ✗' : '成功 ✓')

/* ── 一、产出归档（计划 Step 2 第 2 条）──────────────────────────
 *
 * 存一份**带结束节点**的工作流，真跑一遍，然后去盘上看记录文件。 */
const OUT_WF = '采集归档测试'
const docWithEnd = {
  version: 1,
  name: OUT_WF,
  nodes: [
    { id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return { 件数: 42, 明细: [1,2] }' }, onError: 'stop' },
    { id: 'n2', defId: 'flow.end', position: { x: 300, y: 0 }, params: { fields: ['结果 = n1'] }, onError: 'stop' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
}
await call('POST', '/api/ecom-workbench/workflows', { name: OUT_WF, doc: docWithEnd })
const ran = await call('POST', '/api/ecom-workbench/workflow/run', { name: OUT_WF })
check('带结束节点的工作流跑成功', ran.ok === true, JSON.stringify(ran).slice(0, 200))
check('结束节点交出了产出', JSON.stringify(ran.declaredOutputs?.结果) === '{"件数":42,"明细":[1,2]}',
  JSON.stringify(ran.declaredOutputs))

const recDir = join(process.env.EWB_TEST_HOME, 'collect', OUT_WF)
const files = await readdir(recDir).catch(() => [])
check('★ 板块记录真的落到了 collect/<工作流名>/', files.filter(f => f.endsWith('.json')).length === 1,
  recDir + ' → ' + JSON.stringify(files))
const archived = files.length > 0 ? JSON.parse(await readFile(join(recDir, files[0]), 'utf8')) : {}
/* ── 记录里到底写了什么：**汇报优先**（契约 AN，`records.ts:236-242`）──────
 *
 * ## 这条断言 2026-10-28 改过判据，不是为了让测试变绿
 *
 * 原来只验一句：`archived.outputs.结果` 等于 `{件数:42,明细:[1,2]}`。
 * 那是**汇报优先之前**的规则（产出一定进 `outputs`）。
 *
 * `code.js` 补上运行时汇报之后（票 08、`src/dispatch/builtins.ts:311`），
 * `records.ts:238-242` 那条规则生效：**有汇报就写 `reports`、不写 `outputs`**。
 * 于是 `outputs` 整个消失，旧断言红 —— 但产品没坏，是断言没跟。
 *
 * ## 现在三条一起钉（少了任何一条都等于放宽）
 *
 *   ① 记录里**必须有 `reports`**；
 *   ② 那条汇报说的是**业务内容**（算出了什么、几个键），不是「完成」；
 *   ③ 记录里**不许同时有 `outputs`** —— 这条直接钉住 `records.ts` 的「只写一条」规则，
 *      把那条规则改成「两个都写」这条就红。
 *
 * ⚠️ 别把 ③ 弱化成「有 reports 就行」。两条都写会让读的人不知道该信哪个，
 * 而键名本身就是来源标记（`records.ts:239` 的原话）。 */
check('★ 记录里写的是汇报（有 reports 键）', Array.isArray(archived.reports) && archived.reports.length > 0,
  JSON.stringify(archived.reports))
/* 业务内容判据：必须命中「数字 / 键名 / 条数 / 字节 / 文件名」，不许是「完成」这类空话。 */
const archMsg = String(archived.reports?.[0]?.message ?? '')
check('★★ 那条汇报说的是业务内容（算出了什么、几个键），不是「完成」',
  archMsg.includes('键') && archMsg.includes('件数') && archMsg !== '完成', archMsg)
check('★★ 记录里**没有** outputs 键（有汇报就不写产出，契约 AN 验收第 4 项）',
  !('outputs' in archived), JSON.stringify(Object.keys(archived)))

/* ── 同一条规则再走一遍**源码**那一份 `archiveOutputs`（2026-10-28 加）─────
 *
 * ## 为什么不能只靠上面三条
 *
 * 上面读的那个 `archived` 来自 `apply()` 那条路 —— 这条测试 `:32` 是
 * `await import('../lib/index.js')`，**读的是打包产物**。于是「把 `src/schedule/records.ts`
 * 的汇报优先改成两个都写」这种改动，在这里**不会变红**（产物没重打包）。
 * 我第一版的自证就栽在这：改了 `src`，这条测试照样绿。
 *
 * 而 `tests/schedule-notify.mjs:35` 早就 import 了**源码**那份 `archiveOutputs`
 * （下面「归档的边界」那几段用的就是它）。所以这里补一条直接调它、两种内容同时给：
 * 落盘文件里必须**只有 `reports`**、`outputs` 一个键都不许有。
 *
 * ⚠️ 这条与上面三条**不是重复**：上一条验「整条链路跑出来是什么样」（产物），
 * 这一条验「现在这份源码的规则是什么」（改坏了当场就红）。两种失效原因不同。 */
{
  const both = await archiveOutputs({
    workflowName: '两条路都给内容', ok: true, via: 'list', runId: 'r-both', startedAt: 1, endedAt: 2,
    declaredOutputs: { 结果: { 件数: 42, 明细: [1, 2] } },
    reports: [{ message: '算出了对象，2 个键：件数、明细', type: 'info', location: 'ndv', node: 'n1' }],
  })
  const bothRaw = both.path === null ? {} : JSON.parse(await readFile(both.path, 'utf8'))
  check('★★ 源码版 archiveOutputs：汇报与产出同时给 → 写的是 reports',
    Array.isArray(bothRaw.reports) && bothRaw.reports.length === 1, JSON.stringify(Object.keys(bothRaw)))
  check('★★ 源码版 archiveOutputs：那种情况下**一个 outputs 键都不许有**（规则本身被钉住）',
    !('outputs' in bothRaw), JSON.stringify(Object.keys(bothRaw)))
  /* 反向：只有产出、没有汇报时仍然写 `outputs`（老机制不能因为新规则就断掉）。 */
  const outOnly = await archiveOutputs({
    workflowName: '只有产出', ok: true, via: 'list', runId: 'r-out', startedAt: 1, endedAt: 2,
    declaredOutputs: { 结果: { 件数: 42, 明细: [1, 2] } },
  })
  const outRaw = outOnly.path === null ? {} : JSON.parse(await readFile(outOnly.path, 'utf8'))
  check('★ 反向：没汇报时照样写 outputs（老存档的产出不能被这条新规则吃掉）',
    JSON.stringify(outRaw.outputs?.结果) === '{"件数":42,"明细":[1,2]}' && !('reports' in outRaw),
    JSON.stringify(Object.keys(outRaw)))
}
check('记录里能对上运行历史（runId）', typeof archived.runId === 'string' && archived.runId !== '', String(archived.runId))
check('记录带「谁跑的」', archived.via === 'list', String(archived.via))

/* 采集记录读取路由 */
const lr = await call('GET', '/api/ecom-workbench/collect/records')
check('采集记录路由能列出刚那条', Array.isArray(lr.records) && lr.records.some(x => x.workflow === OUT_WF),
  JSON.stringify(lr.records?.map(x => x.workflow)))
const lrOne = await call('GET', '/api/ecom-workbench/collect/records?workflow=' + encodeURIComponent(OUT_WF))
check('按工作流名过滤只剩那一份', Array.isArray(lrOne.records) && lrOne.records.length === 1,
  String(lrOne.records?.length))
const lrNone = await call('GET', '/api/ecom-workbench/collect/records?workflow=' + encodeURIComponent('没有这份'))
check('过滤到不存在的名字 → 空列表（不报错）', Array.isArray(lrNone.records) && lrNone.records.length === 0)

/* 归档的边界：没有产出**不写空文件**（否则采集记录列表会冒出一堆空条目） */
const noOut = await archiveOutputs({ workflowName: '没结束节点的流', ok: true, via: 'list', runId: 'r1', startedAt: 1, endedAt: 2 })
check('没有产出 → 不写文件、并说明原因', noOut.path === null && noOut.reason.includes('没有结束节点'),
  JSON.stringify(noOut))

/* 名字撞上收藏板块（collect/ 下已有的 skills / notes）时**不能写坏它们** */
const reserved = await archiveOutputs({
  workflowName: 'skills', declaredOutputs: { x: 1 }, ok: true, via: 'list', runId: 'r3', startedAt: 1, endedAt: 2,
})
check('★ 名字撞上收藏板块的目录名 → 加前缀、不写进 skills/',
  reserved.path !== null && reserved.path.includes('wf-skills') && !reserved.path.includes('collect\\skills'),
  String(reserved.path))
const reservedRead = await readCollectRecords({ workflow: 'skills' })
check('按原名还能查回那条（读与写用同一个派生）', reservedRead.length === 1, String(reservedRead.length))

/* 巡查类落到 patrol/（复用既有目录） */
check('巡查类判据看名字前缀', boardOf('巡查-天猫-店铺数据') === 'patrol' && boardOf('取数-天猫生意参谋') === 'collect')
const patrolOut = await archiveOutputs({
  workflowName: '巡查-天猫-店铺数据', declaredOutputs: { 摘要: 'ok' }, ok: true, via: 'schedule', runId: 'r2', startedAt: 1, endedAt: 2,
})
check('★ 巡查类落到 patrol/（不是 collect/）',
  patrolOut.path !== null && patrolOut.path.includes('patrol'), String(patrolOut.path))

/* ── 二、定时：首次启动写默认任务（计划 Step 5/6/7）───────────── */
const seeded = await seedDefaultTasks()
const tasks = await loadTasks()
check('★ 首次启动写入五份巡查默认任务', seeded === 5 && tasks.length === 5, String(seeded) + ' / ' + String(tasks.length))
check('默认任务时间是 09:30', tasks.every(t => t.time === '09:30'), JSON.stringify(tasks.map(t => t.time)))
check('★ 默认任务名字前带「[自动生成]」', tasks.every(t => t.name.startsWith('[自动生成] ')),
  JSON.stringify(tasks.map(t => t.name)))
check('默认牵涉的五份工作流名字对得上', tasks.map(t => t.workflowName).join(',')
  === '巡查-天猫-店铺数据,巡查-天猫-活动报名,巡查-抖音-店铺数据,巡查-抖音-活动报名,巡查-抖音-千川余额',
  tasks.map(t => t.workflowName).join(','))
const again = await seedDefaultTasks()
check('再启动一次不再重复塞（表里已有 5 条）', again === 0, String(again))
check('任务表文件真的在盘上', await readFile(tasksFile(), 'utf8').then(() => true).catch(() => false), tasksFile())

/* 时间归一（写错的时间应当读出来就不可用） */
check('9:30 归一成 09:30', normalizeTime('9:30') === '09:30')
check('25:00 判不合法', normalizeTime('25:00') === '')
check('缺字段的任务洗不出来', normalizeTask({ id: 'x', workflowName: 'y' }) === null)

/* ── 三、到点真的跑，且同一天不跑两次 ────────────────────────────
 *
 * 把一条任务的时间设成「此刻」，调 tick() 两次：
 * 第一次应当跑，第二次**必须不跑**（否则采集会一天跑很多遍）。 */
const NOW = new Date()
const hhmm = String(NOW.getHours()).padStart(2, '0') + ':' + String(NOW.getMinutes()).padStart(2, '0')
await updateTasks(list => list.map((t, i) => i === 0
  ? { ...t, time: hhmm, workflowName: OUT_WF, name: '[自动生成] 到点测试' }
  : { ...t, enabled: false }))

/** 假派发：不真跑节点，只回成功（本测试要验的是「跑没跑」，不是节点实现）。 */
const fakeDispatch = async () => ({ ok: true, status: 'success', output: 'ok', logs: ['假装跑了一步'] })

const ranIds = await tick(fakeDispatch, { workdir: process.env.EWB_TEST_HOME }, NOW)
check('★ 到点的那条真的跑了', ranIds.length === 1, JSON.stringify(ranIds))
const afterFirst = await loadTasks()
check('跑完把日子记下了（防同一天跑两次）', afterFirst[0].lastRunDate !== undefined, String(afterFirst[0].lastRunDate))
check('跑完把结果写回任务表', typeof afterFirst[0].lastResult === 'string' && afterFirst[0].lastResult.includes('成功'),
  String(afterFirst[0].lastResult))

const ranAgain = await tick(fakeDispatch, { workdir: process.env.EWB_TEST_HOME }, NOW)
check('★ 同一分钟再扫一次不再跑（幂等）', ranAgain.length === 0, JSON.stringify(ranAgain))

const laterDay = new Date(NOW.getTime() + 24 * 3600 * 1000)
const ranNextDay = await tick(fakeDispatch, { workdir: process.env.EWB_TEST_HOME }, laterDay)
check('第二天到点会再跑', ranNextDay.length === 1, JSON.stringify(ranNextDay))

/* ── 三之二、定时跑的节点明细必须与另外两条入口同形（契约 AR）─────────
 *
 * ## 这两条守的是什么
 *
 * `runner.ts` 里原来有一份**手抄的**事件归并链（`feed`），与 `src/index.ts` 的
 * `mergeNodeEvent` 已经漏了两个分支：
 *
 * | 分支 | index.ts | 原 runner.ts |
 * | --- | --- | --- |
 * | `cancelled` | 有 | **没有** |
 * | 挂模型痕迹（`llm`） | 有 | **没有** |
 *
 * 后果都是用户能看到的：
 *   · 定时跑的运行记录里**没有模型痕迹**（不知道用的哪个模型、花了多少 token）；
 *   · 定时跑中断后，未执行的节点停在 `queued` 而不是 `cancelled`
 *     —— 契约 AB 修的那个显示问题，在定时这条路上又回来了。
 *
 * 而这两个分支**原来一条断言都没有**（本文件里 `cancelled` / `llm` 零命中），
 * 所以漏了也没人发现。这里补上：真的定时跑一次，去磁盘上的运行记录里看。
 *
 * ⚠️ 用**真派发器**（不是 `fakeDispatch`）—— 模型痕迹与 cancelled 都是
 * 「跑过之后才有」的东西，桩掉的派发不会产生它们。 */
{
  const { runTaskOnce } = await import('../src/schedule/runner.ts')
  const { mergeNodeEvent } = await import('../src/workflow/node-events.ts')

  /* ① 模型痕迹：一个 ai.agent 节点，派发方返回带 llm 的结果。
   *
   * 这模拟的是 `dispatchNode` 的真实行为：它把 `DispatchResult.llm` 原样交回，
   * 调度器再随 `success` 事件发出来。收集层挂不上就丢。 */
  const traceWf = '定时带痕迹测试'
  const traceDoc = {
    version: 1,
    name: traceWf,
    nodes: [
      { id: 'a1', defId: 'ai.agent', position: { x: 0, y: 0 }, params: { prompt: '写一句' }, onError: 'stop' },
    ],
    edges: [],
  }
  const traceSaved = await call('POST', '/api/ecom-workbench/workflows', { name: traceWf, doc: traceDoc })
  check('★ 带痕迹的测试工作流存下来了', traceSaved.ok === true, JSON.stringify(traceSaved).slice(0, 120))

  const trace = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    inputTokens: 88, outputTokens: 12, finish: 'stop',
  }
  const traceResult = await runTaskOnce(
    { id: 's-trace', name: '痕迹测试任务', workflowName: traceWf, time: '00:00', enabled: true, days: [] },
    async () => ({ ok: true, status: 'success', output: '模型答的', logs: [], llm: trace }),
    { workdir: process.env.EWB_TEST_HOME },
  )
  check('★ 定时跑那一次成功了', traceResult.ok === true, JSON.stringify(traceResult))

  const { loadRuns } = await import('../src/workflow/workflow-runs.ts')
  const traceRuns = await loadRuns(traceWf)
  const traceNode = traceRuns[0]?.nodes?.find(n => n.nodeId === 'a1')
  check('★★ 定时跑的运行记录里**有模型痕迹**（llm 键）',
    traceNode?.llm !== undefined, JSON.stringify(traceNode))
  check('★★ 痕迹内容是那一份（路由与 token 在）',
    traceNode?.llm?.provider === 'deepseek-official' && traceNode?.llm?.inputTokens === 88,
    JSON.stringify(traceNode?.llm))

  /* ② 中断后未执行的节点必须是 `cancelled`，不是 `queued`。
   *
   * 直接喂事件流给**共用的** `mergeNodeEvent`（定时这条走的就是它）：
   * 一条 started → 一条 cancelled，验状态。这比真造一份会中断的工作流稳
   * （中断要靠 `onError: stop` + 某节点真失败，而失败消息文案会变）。 */
  const map = new Map()
  mergeNodeEvent(map, { kind: 'started', nodeId: 'k1' })
  mergeNodeEvent(map, { kind: 'success', nodeId: 'k1' })
  mergeNodeEvent(map, { kind: 'cancelled', nodeId: 'k2' })
  const k1 = [...map.values()].find(l => l.nodeId === 'k1')
  const k2 = [...map.values()].find(l => l.nodeId === 'k2')
  check('★★ 中断后未执行的节点是 cancelled（不是 queued）',
    k2?.state === 'cancelled', String(k2?.state))
  check('★ 它带上了 endedAt（界面按它算时长）',
    typeof k2?.endedAt === 'number', String(k2?.endedAt))
  check('★ 跑过的那个仍是 success（没被收尾改写）', k1?.state === 'success', String(k1?.state))
}

/* 停用的不跑（用户关掉的开关必须真生效）。
 *
 * ⚠️ 这一段**必须把第 0 条也关掉**：它上一段刚跑过「第二天」，时间是 hhmm、
 * 日期是「明天」—— 到了第三天它照样是「到点且今天没跑」，会跑。
 * 第一版漏了这一步，于是红的是测试而不是代码。 */
await updateTasks(list => list.map((t, i) => i === 1
  ? { ...t, enabled: true, time: hhmm, workflowName: OUT_WF, lastRunDate: undefined }
  : { ...t, enabled: false }))
await updateTasks(list => list.map((t, i) => i === 1 ? { ...t, enabled: false } : t))
const ranDisabled = await tick(fakeDispatch, { workdir: process.env.EWB_TEST_HOME }, new Date(NOW.getTime() + 3 * 24 * 3600 * 1000))
check('停用的任务到点也不跑', ranDisabled.length === 0, JSON.stringify(ranDisabled))

/* 定时跑的也要进运行历史 + 板块记录（与人工跑同一份实现） */
const schedRuns = await call('GET', '/api/ecom-workbench/workflow/runs?name=' + encodeURIComponent(OUT_WF))
check('★ 定时跑也写进了运行历史', Array.isArray(schedRuns.runs) && schedRuns.runs.some(r => r.via === 'schedule'),
  JSON.stringify(schedRuns.runs?.map(r => r.via)))

/* ── 四、定时任务的路由（界面用）────────────────────────────── */
const t1 = await call('POST', '/api/ecom-workbench/schedule/tasks', { name: '手工加一条', workflowName: OUT_WF, time: '8:05' })
check('新建任务成功', t1.ok === true, JSON.stringify(t1).slice(0, 160))
check('新建时时间被归一', t1.task?.time === '08:05', String(t1.task?.time))
const t1Bad = await call('POST', '/api/ecom-workbench/schedule/tasks', { name: 'x', workflowName: OUT_WF, time: '99:99' })
check('时间不合法 → 明确拒绝', t1Bad.error !== undefined, JSON.stringify(t1Bad))
const t1NoWf = await call('POST', '/api/ecom-workbench/schedule/tasks', { name: 'x', time: '08:05' })
check('没给工作流 → 明确拒绝', String(t1NoWf.error).includes('workflowName'), JSON.stringify(t1NoWf))

const t2 = await call('PUT', '/api/ecom-workbench/schedule/tasks', { id: t1.task.id, time: '10:15', enabled: false })
check('改任务成功', t2.ok === true, JSON.stringify(t2).slice(0, 120))
const afterEdit = (await loadTasks()).find(t => t.id === t1.task.id)
check('改到的是那一份（时间与开关都变了）', afterEdit?.time === '10:15' && afterEdit?.enabled === false,
  JSON.stringify(afterEdit))
const t2None = await call('PUT', '/api/ecom-workbench/schedule/tasks', { id: 's-没有这个' })
check('改不存在的任务 → 明确失败', t2None.ok === false, JSON.stringify(t2None))

const t3 = await call('DELETE', '/api/ecom-workbench/schedule/tasks?id=' + encodeURIComponent(t1.task.id))
check('删任务成功', t3.ok === true, JSON.stringify(t3).slice(0, 120))
check('删掉之后表里没了', !(await loadTasks()).some(t => t.id === t1.task.id))

const runNow = await call('POST', '/api/ecom-workbench/schedule/run/' + encodeURIComponent(afterFirst[0].id))
check('「立即执行」能跑一份并回报结果', typeof runNow.summary === 'string' && runNow.summary !== '',
  JSON.stringify(runNow).slice(0, 200))
const runNone = await call('POST', '/api/ecom-workbench/schedule/run/s-不存在')
check('跑不存在的任务 → 明确失败', runNone.ok === false, JSON.stringify(runNone))

/* ── 五、BI（启动 + 探端口）────────────────────────────────── */
const biStart = await call('POST', '/api/ecom-workbench/bi/start')
check('BI 启动：闸门下报告「已发起」', biStart.ok === true, JSON.stringify(biStart))
const biStat = await call('GET', '/api/ecom-workbench/bi/status')
check('BI 状态：给出监听结果与端口', typeof biStat.listening === 'boolean' && biStat.port === 8088, JSON.stringify(biStat))
check('BI 状态：带上要嵌的地址', String(biStat.url).includes('8088'), String(biStat.url))

/* ── 五之二、BI 启动走哪条路（契约 Z，2026-10-23）────────────────
 *
 * ## 为什么这一段直接 import `src/schedule/bi.ts`，不走 HTTP 路由
 *
 * 上面那三条走的是 `call()` → `lib/index.js`（**编译产物**）。产物要靠
 * `npm run bundle` 刷新，而本轮不许打包 —— 于是产物里的 `startBi()` 还是旧版
 * （只认 bat、没有 `via`）。若这一段也走路由，验的就是旧代码，
 * **改坏了也不会红**，等于白写。
 *
 * 走源码这条路能当场自证；产物那条路由留给打包之后的全量。
 * （这是 `docs/机制-测试分两路.md` 那条「自证用源码路 / 产物路验真实路径」的现场应用。）
 *
 * ## 三个用例对应三种现实
 *
 * ① 机器上有 docker.exe → 走官方命令，`via = 'docker-desktop'`（首选，不是 bat）
 * ② 两样都没有 → 必须 `ok: false`，且**两条路径都写在 reason 里**
 *    （用户抱怨的正是「明明没启动却说已发起」，所以「缺什么」必须说全）
 * ③ docker 没有、脚本在 → 退回 bat，`via = 'bat'`
 *
 * ⚠️ 闸门 `EWB_TEST_NO_SPAWN=1` 全程开着，所以这里**不会真的起进程**。
 * ⚠️ 每个用例结束都要把环境变量还原，否则会污染后面别的断言。 */
{
  const {
    startBi, BI_DOCKER_EXE: BI_DOCKER_EXE_PATH, BI_DOCKER_ARGS, BI_REASON_DOCKER_DESKTOP,
  } = await import('../src/schedule/bi.ts')
  const { existsSync } = await import('node:fs')

  /** 存/还原两个环境变量（用例之间必须干净）。 */
  const ENV_KEYS = ['EWB_BI_DOCKER_EXE', 'EWB_BI_LAUNCHER']
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  /**
   * 按给定值设置环境变量（`undefined` = 删掉）。
   * @param over - 键值对。
   */
  const setEnv = (over) => {
    for (const k of ENV_KEYS) {
      const v = over[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  /** 恢复原状。 */
  const restoreEnv = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }

  try {
    /* ① 首选官方命令：把 docker 指到一个**确实存在**的文件上（`node` 自己），
     * 这样这条断言不依赖「本机装没装 Docker」，换机器也照样绿。 */
    setEnv({ EWB_BI_DOCKER_EXE: process.execPath, EWB_BI_LAUNCHER: 'Z:/不存在的脚本.bat' })
    const r1 = startBi()
    check('★★ BI 首选走官方命令（不是 bat）', r1.via === 'docker-desktop', JSON.stringify(r1))
    check('★★ 官方命令那条也算「已发起」', r1.ok === true, JSON.stringify(r1))
    check('★ 文案说清走的是官方命令', String(r1.reason).includes('官方命令'), String(r1.reason))

    /* ② 两条路都缺 → 必须明确失败，且两个路径都要出现。 */
    const noDocker = 'Z:/不存在的 docker.exe'
    const noBat = 'Z:/不存在的脚本.bat'
    setEnv({ EWB_BI_DOCKER_EXE: noDocker, EWB_BI_LAUNCHER: noBat })
    const r2 = startBi()
    check('★★ BI 两条路都缺 → ok: false（不再假装已发起）', r2.ok === false, JSON.stringify(r2))
    check('★★ 失败文案里同时出现两个路径（说清缺什么）',
      String(r2.reason).includes(noDocker) && String(r2.reason).includes(noBat), String(r2.reason))
    check('★ 两条都缺时 via 是 none', r2.via === 'none', String(r2.via))

    /* ③ docker 没有、脚本在 → 退回 bat（脚本指到任何存在的文件即可，闸门不会真跑）。 */
    setEnv({ EWB_BI_DOCKER_EXE: 'Z:/不存在的 docker.exe', EWB_BI_LAUNCHER: process.execPath })
    const r3 = startBi()
    check('★★ BI 没有 docker 命令时退回启动脚本', r3.via === 'bat', JSON.stringify(r3))
    check('★★ 退回脚本时仍算「已发起」', r3.ok === true, JSON.stringify(r3))
    check('★ 退回时 path 指向那个脚本', r3.path === process.execPath, String(r3.path))

    /* ④ 另一个方向：不设环境变量时，按本机**真实情况**判 —— 标准路径存在就必须首选官方命令，
     * 不存在就必须不是 `docker-desktop`。这是真断言，不是「打印一下」。
     *
     * ⚠️ 第一版这里写成 `r4.via === (stdExists ? 'docker-desktop' : r4.via)` ——
     * 后半截 `r4.via === r4.via` 恒真，等于把断言写废了。自己发现并改掉。 */
    setEnv({ EWB_BI_DOCKER_EXE: undefined, EWB_BI_LAUNCHER: undefined })
    const r4 = startBi()
    const stdExists = existsSync(BI_DOCKER_EXE_PATH)
    console.log('  （本机事实：' + BI_DOCKER_EXE_PATH + ' → ' + (stdExists ? '存在' : '不存在') + '）')
    check('★★ 不设环境变量时按本机标准路径判：存在就首选官方命令',
      stdExists ? r4.via === 'docker-desktop' : r4.via !== 'docker-desktop',
      '标准路径' + (stdExists ? '存在' : '不存在') + '，实际 via=' + r4.via)
    check('★ 不设环境变量时也不许出现「两条都缺却还说 ok」',
      !(r4.via === 'none' && r4.ok === true), JSON.stringify(r4))

    /* ⑤ 命令参数对不对 —— 这一条补的是「闸门下 spawn 分支根本没执行」那个缺口。
     *
     * 闸门在 `spawn` 之前就 return，所以「真正传给 docker 的参数」那一层
     * 靠 `startBi()` 的返回值验不到。第一版自证就是这么失败的：
     * 把 docker 分支里的 `via` 写死成 `'bat'`，测试照样全绿。
     * 所以参数单独抽成常量 `BI_DOCKER_ARGS`，在这里直接钉住。 */
    check('★★ 官方命令的参数是 desktop start -d',
      JSON.stringify([...BI_DOCKER_ARGS]) === JSON.stringify(['desktop', 'start', '-d']),
      JSON.stringify(BI_DOCKER_ARGS))
    check('★★ 必须带 -d（不带就是同步等，一次点击要挂几十秒）',
      [...BI_DOCKER_ARGS].includes('-d'), JSON.stringify(BI_DOCKER_ARGS))

    /* ⑥ 文案措辞：说「约 N 秒后可用」，不许说「已就绪」。
     *
     * 依据（工作台·lead 2026-10-23 在 Docker 全停状态下的实测）：
     *   21:50:20 发命令 → 21:50:23 查 status 仍报「没在跑」→ 21:50:37 引擎就绪
     *   → 21:50:50 8088 开始监听 → 21:50:55 HTTP 200。
     * 命令是**异步**的，返回 `ok: true` 只表示「请求已发出」。
     * 文案若写「已就绪」，用户点完看页面还是白的，会以为按钮又坏了。 */
    check('★★ 文案说清「约 N 秒后可用」而不是「已就绪」',
      /约 30 秒后可用/.test(BI_REASON_DOCKER_DESKTOP), BI_REASON_DOCKER_DESKTOP)
    check('★★ 文案里不出现「已就绪」这个会误导读者的说法',
      !BI_REASON_DOCKER_DESKTOP.includes('已就绪'), BI_REASON_DOCKER_DESKTOP)
    check('★ 文案里标明这是异步的（只表示请求已发出）',
      /异步/.test(BI_REASON_DOCKER_DESKTOP) && /请求已发出/.test(BI_REASON_DOCKER_DESKTOP),
      BI_REASON_DOCKER_DESKTOP)
    /* 分支真的用了这个常量（不是另写一句）—— 防「文案抽出来了但分支还在写死」。
     * ⚠️ 不能靠返回值判：闸门下返回的是**闸门那句**，写成
     * 「r1.reason === 常量 || 含『测试闸门』」就恒真了（第一版就是这么写的，等于没断言）。
     * 所以去源码里查：官方命令那条 return 的 reason 必须**引用常量名**。 */
    const biSrc = (await import('node:fs')).readFileSync(
      new URL('../src/schedule/bi.ts', import.meta.url), 'utf8')
    const dockerBranch = biSrc.slice(
      biSrc.indexOf("if (via === 'docker-desktop')"),
      biSrc.indexOf('/* `.bat` 必须经 `cmd /c`'),
    )
    check('★★ 官方命令那条分支的 reason 引用常量（不是另写一句）',
      /reason:\s*BI_REASON_DOCKER_DESKTOP/.test(dockerBranch),
      dockerBranch.split('\n').filter(l => l.includes('reason')).join(' | '))
  } finally {
    restoreEnv()
  }
}

/* ── 六、通知自检三项分别给结论（计划「提醒」板块）────────────── */
const nf = await call('POST', '/api/ecom-workbench/notify/selfcheck')
check('自检返回三项', typeof nf.powershell === 'object' && typeof nf.balloon === 'object' && typeof nf.pushSwitch === 'object',
  JSON.stringify(nf).slice(0, 240))
check('三项都带 ok 与 reason（界面要照原因说清怎么修）',
  [nf.powershell, nf.balloon, nf.pushSwitch].every(x => typeof x.ok === 'boolean' && typeof x.reason === 'string' && x.reason !== ''),
  JSON.stringify(nf).slice(0, 240))
check('能不能起 PowerShell 这一项在本机为真', nf.powershell.ok === true, JSON.stringify(nf.powershell))
check('闸门开着时不真的弹（只报命令拼装）', nf.balloon.ok === true && String(nf.balloon.reason).includes('闸门'),
  JSON.stringify(nf.balloon))

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(bad) + ' 条红的 ✗')
process.exit(1)

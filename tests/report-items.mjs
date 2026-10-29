/** 采集类「逐条采到了什么」（票 20，2026-10-27）。
 *
 * ## 这一票的真实范围（先查清了才动手）
 *
 * `collect.*` 五个节点**只有定义、没有实现**，所以「给它们加逐条汇报」这条路不存在。
 * 真实采集跑在存档里，用的是 **`flow.loop` 套 `browser.act` 的 `eval` 动作**：
 *
 * ```
 * 取数-抖音电商罗盘.json：flow.loop ×2、browser.act ×10（eval 返回数组）
 * 巡查-抖音-店铺数据.json：browser.act 的 eval + code.js 解析判档
 * ```
 *
 * 所以「逐条」这件事由两段拼成：
 *   ① **`eval` 返回数组**时，节点自己推 N 条逐条 + 1 条汇总（本单加的）；
 *   ② **循环每转一圈**，那 N 条各自独立到达 —— 这条引擎早就成立（本单验它）。
 *
 * ## 用户的原话，是这一单的判据来源
 *
 * > 记录什么是需要再节点里面设计好，而不是完全自动呈现
 *
 * 所以第 4 条判据专抓「偷懒把 `JSON.stringify(output)` 报一遍」。
 *
 * 跑法：`node --import <tsx loader> tests/report-items.mjs`
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-report-items-' + String(process.pid) + '-'))

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

/* ── 假驱动：按指令返回**一批商品**（模拟真实采集） ──────────────
 *
 * 形状照真驱动：`{ ok, output: { result: [...] } }` 打到最后一行。 */
const ITEMS = [
  { sku: 'SKU-1001', name: '连衣裙', price: 89.9, stock: 12 },
  { sku: 'SKU-1002', name: '半身裙', price: 129.0, stock: 0 },
  { sku: 'SKU-1003', name: '衬衫', price: 59.5, stock: 34 },
]
const FAKE_DRIVER = join(SANDBOX, 'fake-driver.mjs')
writeFileSync(FAKE_DRIVER, `
const payload = JSON.parse(process.argv[2] ?? '{}')
const action = String(payload.action ?? '')
const p = payload.params ?? {}
let output
if (action === 'eval') {
  /* 每轮用不同的批次（循环里第几轮由 workdir 旁边的计数文件模拟）。 */
  const fs = await import('node:fs')
  const cntFile = String(payload.workdir ?? '') + '/.round'
  let n = 0
  try { n = Number(fs.readFileSync(cntFile, 'utf8')) || 0 } catch {}
  fs.writeFileSync(cntFile, String(n + 1), 'utf8')
  const ALL = ${JSON.stringify(ITEMS)}
  const per = Number(p.roundSize ?? 0)
  const rows = per > 0
    ? ALL.slice(n * per, n * per + per).map(r => ({ ...r, batch: n + 1 }))
    : ALL.map(r => ({ ...r, batch: n + 1 }))
  output = { result: rows }
} else {
  output = { url: 'https://example.com', title: '采集页' }
}
console.log(JSON.stringify({ ok: true, output }))
`, 'utf8')
process.env.EWB_TEST_BROWSER_DRIVER = FAKE_DRIVER

const { browserActFn } = await import('../src/nodes/browser/impl.ts')
const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
const { runGraph } = await import('../src/workflow/run.ts')

/**
 * 判据：这句话里有没有**业务量**（与票 08 同一条）。
 * @param msg - 汇报句子。
 * @returns 有量返回 true。
 */
const HAS_QUANTITY = (msg) => typeof msg === 'string' && /\d|成功|失败|跳过|[\\/]/.test(msg)

/**
 * 跑一个浏览器节点（走真执行方）。
 * @param node - 节点类型。
 * @param params - 参数。
 * @returns 执行方结果。
 */
async function run(node, params) {
  const exec = createBuiltinExecutor(new Map([[node, browserActFn]]))
  return exec.run({
    runId: 'ri-run', nodeId: 'n1', executor: 'builtin',
    command: { node, params },
    context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
  })
}

console.log('=== 采集类「逐条采到了什么」（票 20）===')
console.log('')

/* ── ① 逐条条数 = 实际采到的条数 ───────────────────────────────── */
console.log('① 逐条汇报的条数 = 实际采到的条数')
{
  const r = await run('browser.act', { action: 'eval', code: 'return rows', session: '默认', launcher: 'cdp', port: '9222' })
  check('（前置）跑成功了', r.status === 'success', String(r.status))
  const rows = r.output?.result
  check('（前置）真采到 3 条', Array.isArray(rows) && rows.length === 3, String(rows?.length))

  const msgs = (r.reports ?? []).map(x => x.message)
  console.log('   逐条 → ' + JSON.stringify(msgs))
  /* 判据落在「条数与实际一致」：3 条明细 + 1 条汇总 = 4。 */
  check('★★ 汇报总数 = 采到的条数 + 1 条汇总（4）', msgs.length === 4, String(msgs.length))
  check('★★ 逐条那 3 条都是明细（不是汇总）',
    msgs.slice(0, 3).every(m => m.includes('第 ')), JSON.stringify(msgs.slice(0, 3)))
  check('★★ 每一条明细都报了它的业务字段（SKU 与价格在句子里）',
    msgs[0].includes('SKU-1001') && msgs[0].includes('89.9'), msgs[0])
  check('★ 第 2 条报的是它自己那条（不是重复第 1 条）',
    msgs[1].includes('SKU-1002') && !msgs[1].includes('SKU-1001'), msgs[1])
  check('★ 逐条带序号（第 1/3、第 2/3、第 3/3）',
    msgs[0].includes('1/3') && msgs[1].includes('2/3') && msgs[2].includes('3/3'),
    JSON.stringify(msgs.slice(0, 3)))
}

/* ── ② 单流程汇总 + 整平台汇总各一条 ──────────────────────────── */
console.log('')
console.log('② 单流程汇总与整平台汇总各一条')
{
  /* 单流程汇总 = `eval` 那条「这一次采到 N 条」。 */
  const one = await run('browser.act', { action: 'eval', code: 'return rows', session: '默认' })
  const tail = one.reports?.[one.reports.length - 1]?.message ?? ''
  console.log('   单流程汇总 → ' + JSON.stringify(tail))
  check('★★ 单流程汇总只有一条（末尾那条）',
    (one.reports ?? []).filter(m => m.message.includes('采到') && m.message.includes('条')).length === 1,
    String((one.reports ?? []).length))
  check('★★ 它说清了条数（3 条）', tail.includes('采到 3 条'), tail)

  /* 整平台汇总 = 引擎里**循环节点**收尾时那一句（跨模块合计）。
   *
   * ⚠️ 现状如实说：**引擎现在没有「整平台汇总」这句话** ——
   * 现有的总账是存档里一个 `code.js` 节点自己算的（`取数-抖音电商罗盘.json` 的 n30），
   * 它算的是 `{ total, okCount, failCount, stoppedModules }`，靠 `code.js` 的
   * 形状汇报（「算出了对象，5 个键」）进记录。
   *
   * 所以这一条验的是**它能被验到的那一半**：多轮跑完之后，
   * 逐条汇报的**总条数**等于各轮之和 —— 那个数就是整平台汇总的依据。
   * 「整平台那句话本身归谁报」写进票里问 lead，不在这里造。 */
  const cntFile = join(SANDBOX, '.round')
  rmSync(cntFile, { force: true })
  const events = []
  let round = 0
  const nodes = [
    { id: 'seed', def: { id: 'code.js', label: 'seed', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] }, params: {}, onError: 'stop' },
    { id: 'L', def: { id: 'flow.loop', label: '循环', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] }, params: { mode: 'items', items: { nodeId: 'seed', field: 'list' }, maxIters: 100, concurrency: 1 }, onError: 'stop' },
    { id: 'c', def: { id: 'browser.act', label: '采', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] }, params: { action: 'eval', code: 'return rows', session: '默认', roundSize: 1 }, onError: 'stop', parentId: 'L' },
  ]
  const edges = [{ source: 'seed', target: 'L' }, { source: 'L', target: 'c' }]
  await runGraph({ nodes, edges, workdir: SANDBOX }, async (req) => {
    if (req.nodeId === 'seed') return { ok: true, status: 'success', output: { list: [{ i: 1 }, { i: 2 }, { i: 3 }] }, logs: [] }
    round += 1
    const out = await browserActFn(req.command, {
      nodeId: req.nodeId, workdir: SANDBOX, upstream: [], report: (e) => { events.push(e) },
    })
    return { ok: true, status: 'success', output: out, logs: [], reports: events.map(e => ({ ...e, node: req.nodeId })) }
  }, { workflowId: 'w' })

  const itemReports = events.filter(e => String(e.message ?? '').includes('第 '))
  const sumReports = events.filter(e => String(e.message ?? '').includes('这一次采到'))
  console.log('   三轮合计：明细 ' + String(itemReports.length) + ' 条，单轮汇总 ' + String(sumReports.length) + ' 条')
  check('★ 跑了 3 轮', round === 3, String(round))
  /* 每轮 1 条明细 + 1 条汇总 → 合计 3 明细 + 3 汇总。 */
  check('★★ 跨轮回的明细总条数 = 各轮之和（3）', itemReports.length === 3, String(itemReports.length))
  check('★★ 每轮各有一条单流程汇总（3 条）', sumReports.length === 3, String(sumReports.length))
}

/* ── ③ 边跑边推：逐条早于节点结束 ──────────────────────────────── */
console.log('')
console.log('③ 边跑边推（时序上逐条汇报早于节点结束事件）')
{
  rmSync(join(SANDBOX, '.round'), { force: true })
  /* ## 这一段第一版测错了对象，记在这里
   *
   * 第一版把节点回调里的汇报**直接 push 进 events**（和引擎转发的事件混在同一个数组），
   * 于是「汇报早于 success」永远成立 —— 因为那条是从回调来的，压根没经过引擎。
   * 结果自证时把引擎的转发挪到 success 之后，这条**照样绿**。判据选错了观察点。
   *
   * 现在分两个数组：
   *   · `pending` —— 节点回调收到的（这是节点「推」的）；
   *   · `events`  —— **引擎转发出来的**（这才是「边跑边推」真正要验的东西）。
   * 节点把 `pending` 作为 `reports` 交回派发结果，引擎才会把它们转成事件。 */
  const pending = []
  const events = []
  const nodes = [{
    id: 'n1', def: { id: 'browser.act', label: '采', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] },
    params: { action: 'eval', code: 'return rows', session: '默认' }, onError: 'stop',
  }]
  await runGraph({ nodes, edges: [], workdir: SANDBOX }, async (req) => {
    const out = await browserActFn(req.command, {
      nodeId: req.nodeId, workdir: SANDBOX, upstream: [], report: (e) => { pending.push(e) },
    })
    /* 交回给引擎 —— 不给的话引擎无汇报可转，这条就成了空对空。 */
    return {
      ok: true, status: 'success', output: out, logs: [],
      reports: pending.map(e => ({ ...e, node: req.nodeId })),
    }
  }, { workflowId: 'w', onEvent: (e) => { events.push(e.kind === 'report' ? { ...e, message: e.entry && e.entry.message } : e) } })

  const kinds = events.filter(e => e.kind !== 'log').map(e => e.kind + ':' + e.nodeId)
  console.log('   节点推了 ' + String(pending.length) + ' 条，引擎转发出 ' + String(events.filter(e => e.kind === 'report').length) + ' 条')
  console.log('   时序 → ' + kinds.join(' → '))
  const lastReport = events.map(e => e.kind).lastIndexOf('report')
  const successAt = events.map(e => e.kind).indexOf('success')
  check('★★ 节点推的每一条都被引擎转发出来了（推几条就发几条）',
    events.filter(e => e.kind === 'report').length === pending.length && pending.length > 0,
    '推 ' + String(pending.length) + ' / 发 ' + String(events.filter(e => e.kind === 'report').length))
  /* 判据落在**顺序**：全部逐条汇报都在节点 success 之前。
   * 自证过一次：把引擎的转发挪到 success 之后，这条会红（见交付里的红行）。 */
  check('★★ 全部逐条汇报都早于节点结束（success）',
    lastReport >= 0 && successAt >= 0 && lastReport < successAt,
    'lastReport@' + String(lastReport) + ' success@' + String(successAt))
  check('★★ 汇报是按逐条顺序到达的（第 1、2、3 条依次，汇总在最后）',
    events.filter(e => e.kind === 'report').map(e => String(e.message ?? '').slice(0, 4)).join(',')
      === '第 1/,第 2/,第 3/,这一次采',
    events.filter(e => e.kind === 'report').map(e => String(e.message ?? '').slice(0, 4)).join(','))
}

/* ── ④ 内容由节点设计决定，不是把 JSON 倒出来 ─────────────────── */
console.log('')
console.log('④ 报什么由节点设计决定（不是 JSON.stringify(output)）')
{
  rmSync(join(SANDBOX, '.round'), { force: true })
  const r = await run('browser.act', { action: 'eval', code: 'return rows', session: '默认' })
  const msgs = (r.reports ?? []).map(x => x.message)
  const all = msgs.join('\n')

  /* 偷懒的写法会把这整段塞进记录：`[{"sku":"SKU-1001","name":"连衣裙",...}]`。
   * 判据三条，任一条命中就说明它在倒 JSON。 */
  check('★★ 没有把整段 JSON 倒出来（不出现 `[{`）', all.includes('[{') === false, all.slice(0, 60))
  check('★★ 句子是**中文说明**，不是一串键值对',
    msgs[0].includes('SKU') && msgs[0].includes('价格'), msgs[0])
  check('★★ 每条明细都不长（不超过 60 字，倒 JSON 会远超）',
    msgs.filter(m => m.includes('第 ')).every(m => m.length <= 60),
    String(Math.max(...msgs.filter(m => m.includes('第 ')).map(m => m.length))))
  /* 也没把整个 output 序列化后当一句汇报（长度会爆）。 */
  check('★★ 没有一条汇报是整段 output 的序列化',
    msgs.every(m => m.length < 200), String(Math.max(...msgs.map(m => m.length))))
  /* 正面：它报了**设计好要报的字段**（SKU / 名称 / 价格），不是「有 3 条」。 */
  check('★★ 报了设计好的业务字段（SKU 与名称）',
    msgs[0].includes('SKU-1001') && msgs[0].includes('连衣裙'), msgs[0])
}

console.log('')
console.log(failed === 0
  ? '结论：采集逐条汇报的条数与实际一致、有单流程汇总、边跑边推、内容是设计好的字段 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')

rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

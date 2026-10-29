/** 节点自己指定汇报那句话（`__report`，票 20 后半，2026-10-27）。
 *
 * ## 它解决什么
 *
 * `code.js` 原来只能报**形状**（「算出了对象，4 个键」）—— 因为它没有
 * 「我想说这句话」的通道（`builtins.ts` 里写死 `describeOutput(out)`）。
 * 而真实采集的汇总节点算出来的正是业务总账：它知道「采了 32 条、跳过 2 条」，
 * 却只能报成「算出了对象，4 个键」。用户点开记录看到的是一句没信息的话。
 *
 * ## 三条判据
 *
 * 1. **带 `__report` 就用它当那句话**（不再报形状描述）
 * 2. **它必须从输出里摘掉**：① 下游 `{{变量}}` 取不到它；
 *    ② `sys.fs.write` 拿到的上游没有它 —— 否则内部标记会被写进结果文件
 * 3. **摘除只摘这一个键**：业务字段一个都不许少（这是工作台·工作流
 *    点名要的自证点，见下面 ③ 那一段）
 *
 * 跑法：`node --import <tsx loader> tests/report-own.mjs`
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-report-own-' + String(process.pid) + '-'))

const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
const { runCodeFn, writeFileFn } = await import('../src/dispatch/builtins.ts')
const { runGraph } = await import('../src/workflow/run.ts')

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
 * 跑一次内置节点（走真执行方）。
 * @param node - 节点类型 id。
 * @param impl - 实现函数。
 * @param params - 参数。
 * @returns 执行方结果。
 */
async function run(node, impl, params) {
  const exec = createBuiltinExecutor(new Map([[node, impl]]))
  return exec.run({
    runId: 'ro-run', nodeId: 'n1', executor: 'builtin',
    command: { node, params },
    context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
  })
}

console.log('=== 节点自己指定汇报那句话（__report）===')
console.log('')

/* ── ① 带 `__report` 就用它当那句话 ────────────────────────────── */
console.log('① 带 __report 时用它当那句话')
{
  /* 用**真实的抖音汇总代码形状**（那是工作台·工作流给的基线）：
   * 6 个业务键 + 一句自己写的总账。 */
  const CODE = `
return {
  ok: true, total: 32, okCount: 30, failCount: 2,
  stoppedModules: ['商品'],
  note: '',
  __report: '共采到 32 条，成功 30 条，失败 2 条（1 个模块被连续失败护栏停下）',
}`

  const r = await run('code.js', runCodeFn, { code: CODE, timeout: 5000 })
  check('（前置）跑成功了', r.status === 'success', String(r.status))

  const msg = String(r.reports?.[0]?.message ?? '')
  console.log('   汇报 → ' + JSON.stringify(msg))
  check('★★ 用的是节点自己那句（不是形状描述）',
    msg.includes('共采到 32 条') && msg.includes('失败 2 条'), msg)
  check('★★ 不再是「算出了对象，N 个键」', msg.includes('算出了对象') === false, msg)
  check('★ 那句话带业务量（32 / 30 / 2）',
    msg.includes('32') && msg.includes('30') && msg.includes('2'), msg)
}

/* ── ② `__report` 从输出里摘掉：下游与写盘都看不到 ──────────────── */
console.log('')
console.log('② __report 从输出里摘掉')
{
  const r = await run('code.js', runCodeFn, {
    code: 'return { total: 3, note: "x", __report: "共采到 3 条" }', timeout: 5000,
  })
  check('★★ 输出里没有 __report 这个键', r.output?.__report === undefined,
    JSON.stringify(Object.keys(r.output ?? {})))
  check('★★ 业务字段一个都没少（total 与 note 都在）',
    r.output?.total === 3 && r.output?.note === 'x', JSON.stringify(r.output))
  check('★ 键的数量与「只有业务字段」对得上（2 个）',
    Object.keys(r.output ?? {}).length === 2, JSON.stringify(Object.keys(r.output ?? {})))

  /* 没有 `__report` 时输出**原样不动**（一个字节都不改）。 */
  const plain = await run('code.js', runCodeFn, { code: 'return { a: 1, b: 2 }', timeout: 5000 })
  check('★★ 没带 __report 时输出原样不动',
    JSON.stringify(plain.output) === JSON.stringify({ a: 1, b: 2 }), JSON.stringify(plain.output))
  check('★★ 没带时仍报形状描述',
    String(plain.reports?.[0]?.message ?? '').includes('算出了对象'),
    String(plain.reports?.[0]?.message ?? ''))
}

/* ── ③ 字段完整性：写盘拿到的上游不多不少（工作台·工作流点名要的） ──
 *
 * ## 这一段为什么必须真跑到磁盘
 *
 * 「摘除只摘一个键」这句话，光看输出对象就能验。但**真要担心的是**：
 * 下游 `sys.fs.write` 拿到的是不是同样那份 —— 若摘除多删了（比如浅拷贝时
 * 漏掉 `stoppedModules`），结果文件就少字段，而那种少是**看不出来**的
 * （文件照样写成功、`ok` 照样绿）。
 *
 * 所以这里真写一个文件、读回来逐键比对。 */
console.log('')
console.log('③ 写盘拿到的上游：字段不多不少，__report 不落盘')
{
  const target = join(SANDBOX, '结果.json')
  /* 先跑汇总节点。 */
  const summary = await run('code.js', runCodeFn, {
    code: `return { ok: true, total: 32, okCount: 30, failCount: 2,
      stoppedModules: ['商品'], note: '', __report: '共采到 32 条' }`,
    timeout: 5000,
  })

  const exec = createBuiltinExecutor(new Map([['sys.fs.write', writeFileFn]]))
  const w = await exec.run({
    runId: 'ro-w', nodeId: 'w1', executor: 'builtin',
    command: { node: 'sys.fs.write', params: { path: target, mode: 'overwrite' } },
    context: { workflowId: 'w', upstream: [summary.output], workdir: SANDBOX },
  })
  check('（前置）写盘成功', w.status === 'success', String(w.status))
  check('★ 写盘汇报说清了字节数', String(w.reports?.[0]?.message ?? '').includes('字节'),
    String(w.reports?.[0]?.message ?? ''))

  const raw = readFileSync(target, 'utf8')
  const parsed = JSON.parse(raw)
  console.log('   落盘键名 → ' + JSON.stringify(Object.keys(parsed)))
  /* 判据 1：`__report` 一个字节都不许出现在文件里。 */
  check('★★ 结果文件里没有 __report', raw.includes('__report') === false,
    raw.includes('__report') ? '出现了' : '零处')
  /* 判据 2：业务键**一个不少**（抖音那份基线是 6 个键）。 */
  const WANT = ['ok', 'total', 'okCount', 'failCount', 'stoppedModules', 'note']
  const got = Object.keys(parsed)
  check('★★ 业务键一个不少（' + WANT.join(' / ') + '）',
    WANT.every(k => got.includes(k)), JSON.stringify(got))
  /* 判据 3：也**一个不多** —— 多出来的只可能是内部标记。 */
  check('★★ 业务键一个不多（' + String(WANT.length) + ' 个）',
    got.length === WANT.length, String(got.length) + '：' + JSON.stringify(got))
  /* 值也要对（不只是键名齐）。 */
  check('★★ 值没被摘除那一步动过（stoppedModules 还在）',
    Array.isArray(parsed.stoppedModules) && parsed.stoppedModules[0] === '商品',
    JSON.stringify(parsed.stoppedModules))
}

/* ── ④ 端到端：走真调度，下游取不到 __report ────────────────────── */
console.log('')
console.log('④ 走真调度：下游 {{变量}} 取不到 __report')
{
  const events = []
  const nodes = [
    { id: 's', def: { id: 'code.js', label: '汇总', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] },
      params: { code: 'return { total: 5, __report: "共采到 5 条" }', timeout: 5000 }, onError: 'stop' },
    /* 下游用变量引用那个键 —— 摘掉了就取不到，会原样保留占位并给一条警告。
     * ⚠️ `input` 是**数组**（上游平铺），所以序列化再看，别 `String(input)`
     * （那只会得到 `[object Object]` —— 第一版就是这么写错的）。 */
    { id: 'd', def: { id: 'code.js', label: '下游', executor: 'builtin', inputs: [{ id: 'in', label: '输入' }], outputs: [{ id: 'out', label: '输出' }] },
      params: { code: 'return JSON.stringify(input)', timeout: 5000 }, onError: 'stop' },
  ]
  const edges = [{ source: 's', target: 'd' }]
  let seen = null
  const r = await runGraph({ nodes, edges, workdir: SANDBOX }, async (req) => {
    const isSummary = req.nodeId === 's'
    const out = isSummary
      ? await runCodeFn(req.command, { nodeId: req.nodeId, workdir: SANDBOX, upstream: [], report: (e) => { events.push(e) } })
      : await runCodeFn(req.command, { nodeId: req.nodeId, workdir: SANDBOX, upstream: req.context.upstream })
    if (!isSummary) seen = out
    return {
      ok: true, status: 'success', output: out, logs: [],
      ...isSummary ? { reports: events.map(e => ({ ...e, node: req.nodeId })) } : {},
    }
  }, { workflowId: 'w' })

  check('（前置）真跑完了', r.aborted !== true, String(r.aborted))
  console.log('   下游拿到 → ' + JSON.stringify(seen))
  check('★★ 下游拿到的上游里没有 __report',
    seen !== null && String(seen).includes('__report') === false, String(seen))
  check('★ 下游仍拿得到业务字段（total=5 在里面）',
    String(seen).includes('total') || String(seen).includes('5'), String(seen))
  check('★★ 汇总那条汇报仍是节点自己那句',
    events.some(e => String(e.message ?? '').includes('共采到 5 条')),
    JSON.stringify(events.map(e => e.message)))
}

/* ── ⑤ 边界：`__report` 不是字符串时不认（不报出乱七八糟的东西） ── */
console.log('')
console.log('⑤ 边界：__report 不是非空字符串时不认')
{
  const notString = await run('code.js', runCodeFn, {
    code: 'return { a: 1, __report: { x: 1 } }', timeout: 5000,
  })
  check('★★ 对象形式的 __report 不被当成那句话（退回形状描述）',
    String(notString.reports?.[0]?.message ?? '').includes('算出了对象'),
    String(notString.reports?.[0]?.message ?? ''))
  /* 但它仍在输出里（引擎只认字符串那种写法）—— 这条如实说清边界。 */
  check('★ 非字符串的 __report 原样留在输出里（只认字符串那种写法）',
    notString.output?.__report !== undefined, JSON.stringify(Object.keys(notString.output ?? {})))

  const empty = await run('code.js', runCodeFn, { code: 'return { a: 1, __report: "  " }', timeout: 5000 })
  check('★★ 空白串不认（退回形状描述）',
    String(empty.reports?.[0]?.message ?? '').includes('算出了对象'),
    String(empty.reports?.[0]?.message ?? ''))
}

console.log('')
console.log(failed === 0
  ? '结论：节点能用 __report 自己说那句话，它从输出里摘掉、业务字段一个不少、下游取不到 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')

rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

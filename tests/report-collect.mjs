/** 浏览器采集类节点的运行时汇报（票 08 后半，2026-10-27）。
 *
 * ## 这一条守的是什么
 *
 * `src/nodes/browser/impl.ts` 原先**零汇报** —— 采集类节点跑完，任务记录那一行是空的。
 * 用户最关心的那一步（下载）恰恰最需要说清「下到了什么、多少字节、落到哪」。
 *
 * ## 为什么用假驱动，而不是「有浏览器就真跑」
 *
 * 真跑要一台开着调试端口的浏览器 —— 那种测试进不了套件
 * （`tests/browser-driver.mjs` 文件头写过为什么不这么做）。所以这里用一个
 * **假驱动脚本**：`EWB_TEST_BROWSER_DRIVER` 指过去，它打印**与真驱动同形状**的 JSON。
 *
 * 于是 `browserActFn` 那整段照跑真的：起子进程 → 收 stdout → 解析最后一行
 * → `reportOf` 翻成汇报 → 执行方收下。**没有被跳过的分支**。
 *
 * ## 核心判据：业务量词
 *
 * 「`reports` 非空」这件事太容易满足 —— 把节点自己的说明文字原样报一遍也能过。
 * 所以这里每条断言都要求句子里有**有实际意义的量**：
 * 字节数 / 字数 / 次数 / 条数 / 文件路径。见文件末尾的 `HAS_QUANTITY` 判据。
 *
 * 跑法：`node --import <tsx loader> tests/report-collect.mjs`
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-report-collect-' + String(process.pid) + '-'))

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

/* ── 假驱动：吃指令、按动作打印同形状的 JSON ─────────────────────
 *
 * ⚠️ 它必须与真驱动打印**同一个形状**（`{ ok, output }` 打到最后一行），
 * 否则验的就不是产品那条路。真驱动的 `act*` 返回形状见
 * `src/nodes/browser/driver.mjs` 各自的 `return`。 */
const FAKE_DRIVER = join(SANDBOX, 'fake-driver.mjs')
writeFileSync(FAKE_DRIVER, `
const payload = JSON.parse(process.argv[2] ?? '{}')
const action = String(payload.action ?? '')
const p = payload.params ?? {}
const workdir = String(payload.workdir ?? '')
let output
if (action === 'goto' && String(p.url ?? '').includes('fail.example.com')) {
  /* 专门留一条**失败**路径：③ 要验「失败时不谎报完成」。 */
  console.log(JSON.stringify({ ok: false, error: '故意失败：这个地址打不开' }))
  process.exit(1)
} else if (action === 'download') {
  /* 造一个真实文件：汇报里的字节数是 statSync 读的，文件必须真存在。 */
  const dir = String(p.dir || (workdir + '/downloads'))
  const fs = await import('node:fs')
  fs.mkdirSync(dir, { recursive: true })
  const file = dir + '/商品主图.txt'
  fs.writeFileSync(file, 'x'.repeat(2048), 'utf8')
  output = { path: file, suggested: '商品主图.txt', dir }
} else if (action === 'goto') {
  output = { url: 'https://example.com/list', title: '商品列表' }
} else if (action === 'click') {
  output = { clicked: p.selector, url: 'https://example.com/list?page=2' }
} else if (action === 'input') {
  output = { filled: p.selector, text: String(p.text ?? '') }
} else if (action === 'text') {
  output = { text: '这是页面上的一段文字', length: 10, url: 'https://example.com/list' }
} else if (action === 'screenshot') {
  const fs = await import('node:fs')
  const file = workdir + '/shot.png'
  fs.writeFileSync(file, 'y'.repeat(512), 'utf8')
  output = { path: file, scope: 'viewport' }
} else if (action === 'eval') {
  output = { result: String(p.code ?? '').includes('RETURN_OBJECT') ? { a: 1 } : [1, 2, 3] }
} else {
  console.error(JSON.stringify({ ok: false, error: '假驱动不认识的动作：' + action }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, output }))
`, 'utf8')
process.env.EWB_TEST_BROWSER_DRIVER = FAKE_DRIVER

const { browserActFn } = await import('../src/nodes/browser/impl.ts')
const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')

/**
 * 判据：这句话里有没有**业务量**。
 *
 * ## 为什么需要它，而不只是断言 `reports` 非空
 *
 * 「有汇报」太容易满足：节点把自己的说明文字原样报一遍（「浏览器采集节点」）
 * 也能让 `reports` 非空、让任务记录那一行有字 —— 但一个数字都没有，
 * 用户仍然不知道「下到了什么、多少、成没成」。
 *
 * ## 判据本身
 *
 * 至少命中一条：数字（后面跟单位）、文件名、路径、【成功/失败/跳过】这类结果词。
 * 这几种都是**读者据此能判断「做成了没有」**的东西。
 */
const HAS_QUANTITY = (msg) => {
  if (typeof msg !== 'string' || msg.trim() === '') return false
  const patterns = [
    /\d/,                        // 任何数字（字节数 / 字数 / 次数）
    /\.(txt|png|json|csv|xlsx|zip|pdf|jpg|jpeg|webp)/i,  // 文件名
    /[\\/]/,                     // 路径分隔符
    /成功|失败|跳过/,             // 结果词
  ]
  return patterns.some(re => re.test(msg))
}

/**
 * 跑一个浏览器节点（走真的执行方）。
 * @param node - 节点类型（`browser.act` / `browser.download`）。
 * @param params - 参数。
 * @returns 执行方结果。
 */
async function run(node, params) {
  const exec = createBuiltinExecutor(new Map([[node, browserActFn]]))
  return exec.run({
    runId: 'rc-run', nodeId: 'n1', executor: 'builtin',
    command: { node, params },
    context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
  })
}

console.log('=== 浏览器采集类节点的运行时汇报（票 08 后半）===')
console.log('沙箱：' + SANDBOX)
console.log('')

/* ── ① browser.download（最高优先级）：下到了什么、多少字节、落到哪 ── */
console.log('① browser.download：下到了什么、多少字节、落到哪')
{
  const r = await run('browser.download', {
    selector: '#export', dir: join(SANDBOX, 'dl'), trigger: 'click', timeout: 5000,
    session: '默认', launcher: 'cdp', exePort: '', port: '9222',
  })
  check('（前置）下载节点跑成功了', r.status === 'success', JSON.stringify(r.status))
  const rep = r.reports?.[0]
  const msg = String(rep?.message ?? '')
  console.log('   真实汇报样例 → ' + JSON.stringify(msg))

  check('★★ 推了一条汇报', Array.isArray(r.reports) && r.reports.length === 1, JSON.stringify(r.reports?.length))
  check('★★ 汇报里有**字节数**（2048，磁盘上真实大小）', msg.includes('2048'), msg)
  check('★★ 汇报里有**文件名**', msg.includes('商品主图.txt'), msg)
  check('★★ 汇报里有**落盘路径**', msg.includes(join(SANDBOX, 'dl')) || msg.includes('商品主图'), msg)
  check('★★ 汇报里有人话大小（2.0 KB）', msg.includes('KB'), msg)
  /* 核心判据：不是一句没有量的话。 */
  check('★★ 这句话带业务量（不是「下载完成」那种空话）', HAS_QUANTITY(msg), msg)
  check('★★ 这句话**不是**「下载完成」这类废话', msg !== '下载完成' && msg.length > 15, msg)
  check('★ 结构化字段齐（bytes 指标 + files 路径）',
    rep?.metrics?.bytes === 2048 && Array.isArray(rep?.files) && rep.files[0]?.endsWith('.txt'),
    JSON.stringify({ metrics: rep?.metrics, files: rep?.files }))
  check('★ 汇报里补上了节点 id', rep?.node === 'n1', String(rep?.node))
  /* 汇报不进 outputs 的前半（数据流仍是驱动返回的那个对象）。 */
  check('★★ 汇报不进 outputs：输出仍是 { path, suggested, dir }',
    typeof r.output === 'object' && r.output !== null && 'path' in r.output && !('message' in r.output),
    JSON.stringify(Object.keys(r.output ?? {})))
}

/* ── ② browser.act 的六种动作，各说各的量 ────────────────────── */
console.log('')
console.log('② browser.act：每种动作都说清做了什么、多少')
{
  /** 跑一个动作并取出汇报。 */
  const act = async (params) => {
    const r = await run('browser.act', { session: '默认', launcher: 'cdp', port: '9222', ...params })
    return { r, msg: String(r.reports?.[0]?.message ?? ''), rep: r.reports?.[0] }
  }

  {
    const { r, msg } = await act({ action: 'goto', url: 'https://example.com/list' })
    console.log('   goto  → ' + JSON.stringify(msg))
    check('（前置）打开页面成功', r.status === 'success', JSON.stringify(r.status))
    check('★★ 打开页面：汇报里有页面标题', msg.includes('商品列表'), msg)
    check('★★ 打开页面：汇报里有最终网址', msg.includes('example.com/list'), msg)
    check('★★ 打开页面：这句话带业务量', HAS_QUANTITY(msg), msg)
  }

  {
    const { msg } = await act({ action: 'click', selector: '#下一步' })
    console.log('   click → ' + JSON.stringify(msg))
    check('★★ 点击：汇报里说清点了哪个元素', msg.includes('#下一步'), msg)
    check('★★ 点击：说了页面变成什么样（新地址）', msg.includes('page=2'), msg)
    check('★★ 点击：这句话带业务量', HAS_QUANTITY(msg), msg)
  }

  {
    const { msg } = await act({ action: 'input', selector: '#搜索框', text: '连衣裙' })
    console.log('   input → ' + JSON.stringify(msg))
    check('★★ 输入：汇报里说清填到哪个元素', msg.includes('#搜索框'), msg)
    check('★★ 输入：说了填了多少个字（3）', msg.includes('3'), msg)
    check('★★ 输入：这句话带业务量', HAS_QUANTITY(msg), msg)
  }

  {
    const { r, msg } = await act({ action: 'text', selector: 'h1' })
    console.log('   text  → ' + JSON.stringify(msg))
    check('★★ 取文本：说了取到多少个字（10）', msg.includes('10'), msg)
    check('★★ 取文本：说清从哪个元素取的', msg.includes('h1'), msg)
    check('★★ 取文本：这句话带业务量', HAS_QUANTITY(msg), msg)
    /* ⚠️ 驱动 `actText` 返回的是**对象** `{ text, length, url }`（见 `driver.mjs` 的 return），
     * 不是裸字符串 —— 第一版这里断言成字符串，是我的判据写错了，不是实现错。 */
    check('（前置）取文本的输出仍是驱动返回的那个对象',
      r.output?.text === '这是页面上的一段文字' && r.output?.length === 10,
      JSON.stringify(r.output))
  }

  {
    const { msg } = await act({ action: 'screenshot', scope: 'viewport' })
    console.log('   shot  → ' + JSON.stringify(msg))
    check('★★ 截图：汇报里有落盘路径', msg.includes('shot.png'), msg)
    check('★★ 截图：汇报里有字节数（512）', msg.includes('512'), msg)
    check('★★ 截图：这句话带业务量', HAS_QUANTITY(msg), msg)
  }

  {
    /* ⚠️ 票 20（2026-10-27）之后，`eval` 返回**数组**时改成「逐条 + 汇总」多句，
     * 不再只有一句形状描述。这里断言随之调整：
     *   · 返回数组 → 3 条逐条 + 1 条汇总；
     *   · 返回非数组 → 仍是原来那一句形状描述（见下面第二段）。 */
    const { r, msg } = await act({ action: 'eval', code: 'return [1,2,3]' })
    console.log('   eval(数组) → ' + JSON.stringify(r.reports?.map(x => x.message)))
    check('★★ 执行脚本返回数组时：逐条 3 条 + 汇总 1 条 = 4 条',
      r.reports?.length === 4, String(r.reports?.length))
    check('★★ 最后一条是汇总（「采到 3 条」）',
      String(r.reports?.[3]?.message ?? '').includes('采到 3 条'),
      String(r.reports?.[3]?.message ?? ''))
    check('★ 逐条那句话带业务量', HAS_QUANTITY(msg), msg)
  }

  {
    /* 非数组：退回原来那句形状描述（这条守着「别把没明细的东西也拆成一堆」）。 */
    const { r } = await act({ action: 'eval', code: 'RETURN_OBJECT' })
    console.log('   eval(对象) → ' + JSON.stringify(r.reports?.map(x => x.message)))
    check('★★ 执行脚本返回对象时：只有一句形状描述（不逐条）',
      r.reports?.length === 1, String(r.reports?.length))
    check('★★ 那句说了形状与规模（对象 1 个字段）',
      String(r.reports?.[0]?.message ?? '').includes('对象'),
      String(r.reports?.[0]?.message ?? ''))
  }
}

/* ── ③ 失败时不报「完成」 ──────────────────────────────────────── */
console.log('')
console.log('③ 失败时不报假的「完成」')
{
  /* ## 第一版这条写错了，记在这里
   *
   * 原先我用「参数空」去触发失败 —— 但假驱动**不看参数**（它直接造文件），
   * 所以两次都成功了，那条断言（`bad.status !== 'failed' || …`）就变成空对空：
   * 前提不成立时它自动为真，等于什么都没验。
   *
   * 现在让假驱动对这个特定 url 明确失败（与真驱动的 `{ ok: false, error }` 同形状），
   * 于是「失败 → 一条汇报都不发」才真的被走到。 */
  const r = await run('browser.act', {
    action: 'goto', url: 'https://fail.example.com', session: '默认', launcher: 'cdp', port: '9222',
  })
  check('（前置）这条路真的失败了', r.status === 'failed', String(r.status))
  check('（前置）失败原因是假驱动给的那句', String(r.error ?? '').includes('故意失败'),
    String(r.error ?? '').slice(0, 50))
  check('★★ 失败时一条汇报都不发（不谎报完成）',
    r.reports === undefined || r.reports.length === 0, JSON.stringify(r.reports))
}

/* ── ④ 端到端：汇报能落进任务记录（records.ts 那条规则仍在生效） ── */
console.log('')
console.log('④ 端到端：真跑 → 任务记录里能读到汇报，且**不写 outputs**')
{
  process.env.EWB_TEST_HOME = SANDBOX
  const { runGraph } = await import('../src/workflow/run.ts')
  const { archiveOutputs } = await import('../src/schedule/records.ts')
  const { readCollectRecords } = await import('../src/schedule/records.ts')

  /* 用一条真调度把下载节点的汇报收集起来（与生产同一条：引擎→事件→明细）。 */
  const nodes = [{
    id: 'n1',
    def: { id: 'browser.download', label: '下载', paramDefs: [], executor: 'builtin' },
    params: {
      selector: '#export', dir: join(SANDBOX, 'dl2'), trigger: 'click', timeout: 5000,
      session: '默认', launcher: 'cdp', port: '9222',
    },
    onError: 'stop',
  }]
  const events = []
  /** 调度器途中发的全部事件（要在 `runGraph` **之前**声明，否则 onEvent 里拿到 undefined）。 */
  const collected = []
  const r = await runGraph(
    { nodes, edges: [], workdir: SANDBOX },
    async (req) => {
      const out = await browserActFn(req.command, {
        nodeId: req.nodeId, workdir: SANDBOX, upstream: [], report: (e) => { events.push(e) },
      })
      return { ok: true, status: 'success', output: out, logs: [], reports: events.map(e => ({ ...e, node: req.nodeId })) }
    },
    { workflowId: 'w', onEvent: (e) => { collected.push(e) } },
  )
  check('（前置）真跑完了', r.aborted !== true, String(r.aborted))

  const { mergeNodeEvent } = await import('../src/workflow/node-events.ts')
  const byNode = new Map()
  for (const e of collected) mergeNodeEvent(byNode, e)
  const lines = [...byNode.values()]
  check('★ 节点明细收下了那条汇报', (lines[0]?.reports ?? []).length === 1,
    JSON.stringify(lines[0]?.reports?.length))

  /* 归档：汇报优先于 outputs（`records.ts:240` 那条规则）。 */
  const saved = await archiveOutputs({
    workflowName: '采集汇报端到端',
    declaredOutputs: { 某个产出: '这里是结束节点声明的旧式产出' },
    reports: [{ ...(lines[0]?.reports ?? [])[0], node: 'n1' }],
    ok: true,
    via: 'test',
    runId: 'rc-e2e-1',
    startedAt: Date.now() - 100,
    endedAt: Date.now(),
  })
  check('★ 归档写成功了', saved.path !== null, String(saved.reason))
  const raw = readFileSync(saved.path, 'utf8')
  check('★★ 落盘文件里有 reports', raw.includes('"reports"'), raw.slice(0, 80))
  check('★★ 落盘文件里**没有** outputs（有汇报就不写它）', raw.includes('"outputs"') === false, '')
  check('★★ 落盘文件里的那句话带业务量', HAS_QUANTITY(raw), '')
  const recs = await readCollectRecords()
  check('★★ 从任务记录里读得回来', recs.length >= 1, String(recs.length))
  check('★★ 读回来的那条带着那句汇报',
    String(recs[0]?.reports?.[0]?.message ?? '').includes('2048'),
    JSON.stringify(recs[0]?.reports?.[0]?.message ?? ''))
}

console.log('')
console.log(failed === 0
  ? '结论：浏览器采集类节点会报「做了什么、多少、落到哪」，任务记录能读回来，汇报不进 outputs ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')

rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

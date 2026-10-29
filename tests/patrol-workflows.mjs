/** 端到端跑**五份巡查工作流**（真引擎 + 真节点实现，浏览器步骤用真实样本）。
 *
 * ## 用户红线
 *
 * 「测试时**不允许打开抖音与天猫页面**」→ 浏览器两步**返回真实样本文件的内容**
 * （`out/debug-*.txt`，是之前真跑时存下来的），不真的开页面。
 *
 * ## ⚠️ 2026-10-14 大改：从 3 份混平台的改成 5 份单平台的
 *
 * 用户原话：「将巡查根据平台、任务命名，如果当前有两个平台混在一起的就拆分。」
 * 于是本测试的「一份工作流跑两个平台、再合并」那套断言**整体作废**，改成：
 * **每份只验自己那一个平台**（不再有合并节点、不再有「两平台块数相加」的期望值）。
 *
 * 这也让期望值更清楚：**每份工作流的块数与它是哪个平台有关**，
 * 而不是「两个平台加起来多少」。
 *
 * 跑完即删临时目录（不碰真实数据目录）。
 */
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { runCodeFn, writeFileFn, readFileFn, branchFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { PATROL_JOBS } from '../scripts/patrol/jobs.mjs'

const HOME = process.env.DSH_HOME ?? ''
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const WF_DIR = join(HOME, 'profiles', PROFILE, 'data', 'ecom-workbench', 'workflows')
const SAMPLES = 'D:/ecom-data/自动巡查/out'
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`）。理由见 `tests/ingest-steps.mjs` 那段注释：
 * 写死的目录名会让「两个进程同时跑」与「上次残留」都变成假红（2026-10-20 修）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-patrol-e2e-'))

/* 前置：工作流文件与样本都要在（不在就**说清缺什么**，不静默跳过）。 */
{
  const missingWf = PATROL_JOBS.filter((j) => !existsSync(join(WF_DIR, j.name + '.json')))
  if (missingWf.length > 0) {
    console.log('★ 缺工作流文件（先跑 node scripts/build-patrol-workflows.mjs）：'
      + missingWf.map((j) => j.name).join(', '))
    process.exit(1)
  }
  const need = ['debug-qianchuan.txt', 'debug-shop-tm.txt', 'debug-shop-dy.txt',
    'debug-activity-tm.txt', 'debug-activity-dy.txt']
  const missingSample = need.filter((n) => !existsSync(join(SAMPLES, n)))
  if (missingSample.length > 0) {
    console.log('★ 缺真实样本（本测试没法离线验解析）：' + missingSample.join(', '))
    console.log('  样本目录：' + SAMPLES)
    process.exit(1)
  }
}

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}
const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]

/** 读一个真实样本。 */
function sample(name) {
  const p = join(SAMPLES, name)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/**
 * 这一份该用哪个样本。
 *
 * ⚠️ 拆开后**样本选择变简单了**：每份只有一个平台，直接按 `kind` + `platform` 定，
 * 不再需要「按会话标签猜是哪个平台」那套（那是混平台时代的产物）。
 *
 * @param job - `PATROL_JOBS` 里的一项。
 * @returns 样本文件名。
 */
function sampleFor(job) {
  if (job.kind === 'qianchuan') return 'debug-qianchuan.txt'
  if (job.kind === 'activity') return 'debug-activity-' + job.platform + '.txt'
  return 'debug-shop-' + job.platform + '.txt'
}

/**
 * 跑一份工作流（浏览器两步被替换掉）。
 *
 * @param job - `PATROL_JOBS` 里的一项。
 * @param opts - `{ noConfig, emptyText, tag }`。
 * @returns `{ doc, out, logs, outFile }`。
 */
async function runWorkflow(job, opts = {}) {
  const doc = JSON.parse(readFileSync(join(WF_DIR, job.name + '.json'), 'utf8'))
  const outDir = join(TMP, job.id + (opts.tag ?? ''))
  /* ⚠️ **每次跑之前清掉这个目录**（2026-10-14 踩到）：
   * 只建目录不清的话，同一份工作流跑两遍会**读到上一遍的结果文件** ——
   * 表现是「块数莫名变多」，而我以为是代码 bug，查了很久。 */
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  /* 等待节点**立即返回**（2026-10-26 改）。
   *
   * 这份测试验的是「五份巡查各自的解析与判档对不对、夜禁走哪支、块数对不对」
   * —— 与「等了多久」无关（全仓没有一条断言在判 `waitedMs`，已核）。
   *
   * ⚠️ 返回值形状要与真 `delayFn` 一致（`src/dispatch/builtins.ts:151`）：
   * 有上游就透传上游，没有就给 `{ waitedMs }`。
   * 改前这份测试真等，耗时 42 秒；改后 2 秒左右，断言一条不少。 */
  const noWaitFn = async (cmd, ctx) =>
    ctx.upstream.length > 0 ? ctx.upstream[0] : { waitedMs: 0 }

  const IMPLS = new Map([
    ['code.js', runCodeFn],
    ['sys.fs.read', readFileFn],
    ['sys.fs.write', writeFileFn],
    ['flow.if', branchFn],
    ['flow.delay', noWaitFn],
    /* 浏览器两步：**不真的开浏览器**。返回形状与真 driver 一致。 */
    ['browser.act', async (cmd) => {
      const p = cmd.params ?? {}
      if (p.action === 'goto') return { url: p.url, title: '(测试：未真的打开页面)' }
      if (p.action === 'eval') return { result: { text: opts.emptyText === true ? '' : sample(sampleFor(job)) } }
      throw new Error('测试里不该跑到这个动作：' + String(p.action))
    }],
  ])

  /* 结果文件的路径改到临时目录（**不碰真实数据目录**）。 */
  /* ⚠️ 翻译走共用的 `toRunSpecsFromCanvas`（2026-10-15）——
   * 别再手写映射：手写的那份曾经漏掉 `parentId`/`sourceHandle`，
   * 于是测试一直测自己那份、真实代码坏着也全绿。 */
  const specs = toRunSpecsFromCanvas(
    doc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: {
        def: lib.find(d => d.id === n.defId),
        params: n.defId === 'sys.fs.write'
          ? { ...n.params, path: join(outDir, 'result.json') }
          : (n.defId === 'sys.fs.read' && opts.noConfig === true ? { ...n.params, path: join(outDir, '不存在.json') } : n.params),
        onError: n.onError,
        skipped: n.skipped === true,
      },
    })),
    doc.edges,
  )

  const logs = []
  const out = await runGraph(
    { nodes: specs.nodes, edges: specs.edges, workdir: outDir },
    async (req) => {
      const fn = IMPLS.get(String(req.command?.node ?? ''))
      if (fn === undefined) return { ok: false, status: 'failed', error: '没有实现: ' + String(req.command?.node), logs: [] }
      try {
        const v = await fn(req.command, { nodeId: req.nodeId, workdir: outDir, upstream: req.context?.upstream ?? [] })
        return { ok: true, status: 'success', output: v, logs: [] }
      } catch (e) {
        return { ok: false, status: 'failed', error: String(e?.message ?? e), logs: [] }
      }
    },
    { onEvent: (e) => { if (e.kind === 'log') logs.push(e.nodeId + ': ' + e.line) } },
  )
  return { doc, out, logs, outFile: join(outDir, 'result.json') }
}

/**
 * 每份工作流的期望值（用**真实样本 + 真实阈值**推出来的）。
 *
 * ⚠️ 拆开后每份只有**一个平台**，所以块数不再需要相加：
 *   · 店铺数据：**3 个块**（评分 / 告警 / 销售）
 *   · 活动报名：**1 个块**
 *   · 千川：**1 个块**
 */
const EXPECT = {
  'patrol-tm-shop': { blocks: 3, ids: 'tm-score,tm-alert,tm-sales' },
  'patrol-dy-shop': { blocks: 3, ids: 'dy-score,dy-alert,dy-sales' },
  'patrol-tm-activity': { blocks: 1, ids: 'tm-activity' },
  'patrol-dy-activity': { blocks: 1, ids: 'dy-activity' },
  'patrol-dy-qianchuan': { blocks: 1, ids: 'qianchuan' },
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它。 */

/* ── ① 每份都端到端跑一遍 ── */
for (const job of PATROL_JOBS) {
  console.log('')
  console.log('════ ' + job.name + ' ════')
  const { doc, out, logs, outFile } = await runWorkflow(job)
  const exp = EXPECT[job.id]

  console.log('  跑过的: ' + JSON.stringify(out.ran))
  check('存档合法（节点数 = ' + String(doc.nodes.length) + '）', doc.nodes.length > 0)
  check('★ 整条跑通（没中断）', out.aborted !== true, String(out.error ?? ''))

  /* ★ 说明字段（用户 2026-10-14 要求显示在列表里）。 */
  check('★ 存档带「说明」字段（列表要显示它）',
    typeof doc.description === 'string' && doc.description !== '', JSON.stringify(doc.description))
  check('  说明里有平台名（一眼看出是哪个平台）',
    String(doc.description).includes(job.platform === 'tm' ? '天猫' : '抖音'), String(doc.description))

  /* ★ 拆开后**不该有合并节点**（它只为合两个平台而存在）。 */
  const mergeNodes = doc.nodes.filter(n => String(n.label ?? '').includes('合并'))
  check('★ 没有「合并两平台」节点（拆开后用不着）', mergeNodes.length === 0,
    JSON.stringify(mergeNodes.map(n => n.label)))

  /* ★ 只该有一个浏览器会话标签（单平台）。 */
  const tags = new Set(doc.nodes.filter(n => n.defId === 'browser.act').map(n => String(n.params?.session ?? '')))
  check('★ 只用一个浏览器会话（单平台）', tags.size === 1, JSON.stringify([...tags]))
  check('  那个会话就是本份的平台标签', tags.has(job.tag), JSON.stringify([...tags]))

  /* 主链必须走到「写结果文件」。 */
  const writeIds = doc.nodes.filter(n => n.defId === 'sys.fs.write').map(n => n.id)
  check('★ 走了「能跑」那条（到了写结果文件）', out.ran.includes(writeIds[writeIds.length - 1]), '')

  check('结果文件存在', existsSync(outFile), outFile)
  if (existsSync(outFile)) {
    const r = JSON.parse(readFileSync(outFile, 'utf8'))
    console.log('  结果: job=' + r.job + ' ok=' + r.ok + ' blocks=' + r.blocks.length)
    console.log('  块: ' + r.blocks.map(b => b.id + '(' + b.state + ')').join(', '))
    check('job 名对', r.job === job.id, r.job)
    check('★ 块数对（' + String(exp.blocks) + '）', r.blocks.length === exp.blocks, String(r.blocks.length))
    check('★ 块 id 与顺序对', r.blocks.map(b => b.id).join(',') === exp.ids, r.blocks.map(b => b.id).join(','))
    check('★ ok=true（采到了）', r.ok === true, String(r.ok))
    check('输出形状是 PatrolResult', typeof r.job === 'string' && typeof r.runAt === 'string'
      && typeof r.dataDate === 'string' && typeof r.ok === 'boolean'
      && (r.error === null || typeof r.error === 'string') && Array.isArray(r.blocks))
    const badBlock = r.blocks.find(b => typeof b.id !== 'string' || typeof b.title !== 'string'
      || typeof b.state !== 'string' || typeof b.summary !== 'string' || !Array.isArray(b.items))
    check('每个块都有面板要的字段', badBlock === undefined, JSON.stringify(badBlock)?.slice(0, 90) ?? '')
    /* ★ 单平台的结果文件里**不该出现另一个平台**的块（拆开的直接证据）。 */
    const otherPrefix = job.platform === 'tm' ? 'dy-' : 'tm-'
    const leaked = r.blocks.filter(b => String(b.id).startsWith(otherPrefix))
    check('★ 结果里**没有另一个平台**的块（拆干净了）', leaked.length === 0,
      JSON.stringify(leaked.map(b => b.id)))
  }

  const errs = logs.filter(l => l.includes('✕'))
  check('日志里没有失败', errs.length === 0, errs.slice(0, 2).join(' | '))

  /* 夜禁那条分支**不该**被走到（默认绕过夜禁）。 */
  const skipIds = doc.nodes.filter(n => String(n.label ?? '').includes('夜禁：')).map(n => n.id)
  check('没走「夜禁未跑」那条（默认绕过夜禁）', !skipIds.some(id => out.ran.includes(id)), '')
}

/* ── ② 配置读不到时也要能跑（sys.fs.read 的 continue 策略）── */
console.log('')
console.log('════ 配置读不到时（sys.fs.read 失败 → 用内置默认）════')
{
  const job = PATROL_JOBS.find(j => j.kind === 'qianchuan')
  const { out, outFile } = await runWorkflow(job, { noConfig: true, tag: '-nocfg' })
  console.log('  跑过的: ' + JSON.stringify(out.ran))
  check('★ 配置不存在时**整条仍跑通**（不是中断）', out.aborted !== true, String(out.error ?? ''))
  check('结果文件仍写了', existsSync(outFile))
  if (existsSync(outFile)) {
    const r = JSON.parse(readFileSync(outFile, 'utf8'))
    /* ⚠️ 用内置默认（预算 20000、余额 crit 1000）时：
     * 消耗 0 → ok；余额 240.52 <= 1000 → **crit**（与读真配置时的 warn 不同）。
     * 这条判据正好证明「配置真的被读了 / 没读时用的是默认」。 */
    const bal = r.blocks[0].items.find(i => i.label === '账户余额')
    check('★ 用内置默认时余额判 crit（证明真读不到配置时走了默认值）', bal.state === 'crit', bal.state)
  }
}

/* ── ③ 空文本（页面没打开）也要有可读的结果 ── */
console.log('')
console.log('════ 页面文本为空时（模拟页面没打开）════')
{
  const job = PATROL_JOBS.find(j => j.id === 'patrol-tm-shop')
  /* ⚠️ 独立目录（`tag`）：同一份工作流跑两遍若共用目录，第二遍会读到第一遍的结果文件 ——
   * 这类「测试自己造出来的假象」我在这轮里踩过一次，所以显式隔开。 */
  const { out, outFile } = await runWorkflow(job, { emptyText: true, tag: '-empty' })
  check('空文本时不中断（仍写出结果）', out.aborted !== true, String(out.error ?? ''))
  if (existsSync(outFile)) {
    const r = JSON.parse(readFileSync(outFile, 'utf8'))
    console.log('  ok=' + r.ok + '  blocks=' + r.blocks.length + '  error=' + String(r.error).slice(0, 70))
    check('★ 空文本时 ok=false（没采到）', r.ok === false, String(r.ok))
    check('★ 但块还在（面板能看到「未采集到」而不是空白）', r.blocks.length > 0, String(r.blocks.length))
  }
}

/* ── ④ ★ 五份互不重叠（拆开的整体检查）── */
console.log('')
console.log('════ 五份的覆盖（拆开后不该有重叠）════')
{
  const names = PATROL_JOBS.map(j => j.name)
  console.log('  ' + names.join(' / '))
  check('★ 五份名字各不相同', new Set(names).size === 5, String(new Set(names).size))
  check('★ 每份名字里都有平台（天猫/抖音）',
    PATROL_JOBS.every(j => j.name.includes('天猫') || j.name.includes('抖音')), '')
  check('★ 每份名字里都有任务（不是内部代号）',
    PATROL_JOBS.every(j => /店铺数据|活动报名|千川余额/.test(j.name)), '')
  check('★ 每个平台-任务组合只出现一次',
    new Set(PATROL_JOBS.map(j => j.platform + '-' + j.kind)).size === PATROL_JOBS.length, '')
  check('  没有内部代号泄漏到名字里（shop/activity/qianchuan）',
    !PATROL_JOBS.some(j => /shop|activity|qianchuan/.test(j.name)), '')
  check('结果文件各不相同', new Set(PATROL_JOBS.map(j => j.outFile)).size === 5, '')
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('  （临时目录已清理：' + TMP + '）')

console.log('')
console.log(failed === 0
  ? '结论：五份巡查工作流都端到端跑通（未开任何真实页面）✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

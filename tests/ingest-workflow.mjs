/** 端到端跑「清洗入库」工作流：**真引擎 + 真节点实现 + 真 shell 子进程**。
 *
 * ⚠️ 只在临时目录跑：临时 manifest、临时数据目录、临时库。
 * 真实 `ecom.db` 与真实 `原始数据` **一个字节都不动**（跑完比对指纹）。
 *
 * 做法：把工作流里那几个写死的路径**换成临时的**再跑
 * （等价于「用户在自己机器上按实际路径改节点参数」—— 那正是这份工作流的设计）。
 *
 * 跑完即删（验过后收成常驻测试）。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { runCodeFn, writeFileFn, readFileFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
/* 生成器里那个「把 shell 脚本落盘」的函数 —— 复用它，别在这里手抄一份。
 * 理由是 `pitfalls/同一件事写两份迟早漂.md`：测试自己拼一套脚本内容，
 * 生成器改了它就静默失效。 */
import { writeShellScripts } from '../scripts/ingest/build.mjs'
import { STEP_LIST, STEP_READ_CLEAN, STEP_WRITE_DB } from '../scripts/ingest/shell-steps.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = 'D:/ecom-data/清洗入库'
const REAL_DB = join(PROJECT, 'ecom.db')
const REAL_DATA = 'D:/ecom-data/原始数据'
const WF_DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`）。理由同 `tests/ingest-steps.mjs` 那段注释：
 * 写死的目录名会让「两个进程同时跑」与「上次残留」都变成假红（2026-10-20 修）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-ingest-wf-'))

/** 反斜杠路径 → 正斜杠（`writeJson` 之后 node 都能认，且不涉及转义）。 */
const fwdSlash = (p) => String(p).replace(/\\/g, '/')

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它（那是本次唯一的那份）。 */

const { statSync } = await import('node:fs')
const dbBefore = existsSync(REAL_DB) ? { size: statSync(REAL_DB).size, mtime: statSync(REAL_DB).mtimeMs } : null
const dataBefore = (() => {
  try { return statSync(REAL_DATA).mtimeMs } catch { return null }
})()

/* ── 造临时数据 + 临时 manifest ── */
const dataRoot = join(TMP, '原始数据')
mkdirSync(join(dataRoot, 'D-店铺-整体-天猫'), { recursive: true })
const dbPath = join(TMP, 'out.db')
const manifestPath = join(TMP, 'manifest.json')
{
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(join(PROJECT, 'node_modules/exceljs/lib/exceljs.nodejs.js')).href)
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('主数据')
  ws.addRow(['商品ID', '商品名称', '支付金额'])
  /* 长 ID（验保精度）+ 千分位（验转 number）。 */
  ws.addRow(['1234567890123456789', '长ID商品', '1,234.5'])
  await wb.xlsx.writeFile(join(dataRoot, 'D-店铺-整体-天猫', 'DemoShop-20260630.xlsx'))
}
writeFileSync(manifestPath, JSON.stringify({
  meta: { version: 3, db_path: dbPath, derived_views: [{ view: 'v_demo', sql: 'SELECT 平台, SUM(支付金额) AS 总额 FROM tm_overview_demo GROUP BY 平台' }] },
  tables: [{
    id: 'tm_overview', table: 'tm_overview_demo', folder: 'D-店铺-整体-天猫', sheet: 'first',
    platform: '天猫', shop_regex: '(?<shop>[^-]+)-',
    date: { source: 'filename', pattern: '(20\\d{2})(\\d{2})(\\d{2})' },
    primary_key: ['商品ID', '日期'], exclude_columns: [],
  }],
}, null, 2), 'utf8')

/* ── 跑工作流（把写死的路径换成临时的）── */
/* ⚠️ **落进本次的沙箱目录**，不是真实的 `$DSH_HOME/tmp`（2026-10-20 修）。
 * 原来写的是 `$DSH_HOME/tmp/ewb-ingest` —— 那是**真实目录**，
 * 两个进程同时跑会互相覆盖 config.json，而且会在用户机器上留垃圾。
 * 现在用 `TMP` 下的子目录：随本次跑完一起删。 */
const SHELL_DIR = join(TMP, 'shell')
mkdirSync(SHELL_DIR, { recursive: true })
/* ⚠️ **shell 脚本本身也要搬进沙箱**（2026-10-20 修）：
 * 生成器把 step 脚本写进真实的 `$DSH_HOME/tmp/ewb-ingest/`，而工作流的命令行里
 * 写死了那个路径。只改 `sys.fs.write` 的 path 会出现「配置写进沙箱、
 * 脚本仍读真实目录」——症状是「临时库建不出来」（我第一版就是这样）。
 * 这里用生成器**同一个函数**把脚本写进本次沙箱，再把命令行指过去。 */
{
  const cleanLib = readFileSync(join(HERE, '..', 'scripts', 'ingest', 'clean-lib.mjs'), 'utf8')
  writeShellScripts(SHELL_DIR, { STEP_LIST, STEP_READ_CLEAN, STEP_WRITE_DB }, cleanLib, { mkdirSync, writeFileSync })
}
console.log('=== 跑「清洗入库」===')
console.log('  工作流文件: ' + join(WF_DIR, '清洗入库.json'))
console.log('  shell 脚本: ' + SHELL_DIR)
console.log('')

const doc = JSON.parse(readFileSync(join(WF_DIR, '清洗入库.json'), 'utf8'))
const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]

/* ⚠️ 2026-10-21：节点数**不再写死 6**。
 *
 * 这份工作流补了「⓪ 开始」这个节点（输入=开始，用户 m00901 定案），
 * 于是总数从 6 变成 6 + 1 + 1。写死数字的断言会在**功能完全正常**时红，
 * 而且它测的是「数数」不是「六步都在」——那是假断言。
 *
 * 现在改成：**六个干活步骤一个不少**（按 defId 数，不算开始 / 结束这些机制节点），
 * 新增步骤不会让它假红，删掉步骤仍然会红。
 *
 * ⚠️ 2026-10-25：用户决定**存档里不再有结束节点**，所以下面那条从
 * 「开始与结束各一个」改成「开始一个、结束零个」。判据方向跟用户决定走。 */
const FLOW_IO = ['flow.start', 'flow.end']
const workNodes = doc.nodes.filter((n) => !FLOW_IO.includes(n.defId))
check('工作流文件存在且能读（六个干活步骤都在）', workNodes.length === 6, String(workNodes.length))
check('有一个开始节点、没有结束节点（用户 2026-10-25 定）',
  doc.nodes.filter((n) => n.defId === 'flow.start').length === 1
  && doc.nodes.filter((n) => n.defId === 'flow.end').length === 0,
  doc.nodes.map((n) => n.defId).join(','))

/* ⚠️ 把路径参数换成临时的 —— 这份工作流的设计就是「路径在节点参数里写死、换机器要改」。
 *
 * ## ★ 这里曾经出过一次**真事故**（2026-10-14），必须记住
 *
 * 我第一版只换了 `sys.fs.read` 的 `path`（也就是临时 manifest），
 * **没换 `config.json` 里的 `dbPath` / `dataRoot`** ——
 * 而那两个值是在 `code.js`（② 拼配置）里**写死**的，来自生成器。
 * 后果：步骤③ 用**真实路径**打开了**真实 `ecom.db`** 并写了进去
 * （建了一张测试表 + 一条 ETL 日志），违反用户「不改真实文件」的红线。
 *
 * **补救**：逐条核对后删掉我建的那张表/视图/日志（见提交说明），
 * 并复核用户原有 29 张表 + 4 个视图**一行未动**。
 *
 * **修法（本文件现在的做法）**：测试**不能只换一处路径** ——
 * 凡是工作流里**任何**指向真实数据的地方都要换掉。
 * 具体是「把 ② 拼配置那步的 SQL 里那几个常量替换成临时路径」，
 * 并**在跑完后立刻断言真实库指纹没变**（本文件末尾那两条断言就是安全网）。
 */
const specs = toRunSpecsFromCanvas(
  doc.nodes.map(n => {
    const params = { ...n.params }
    if (n.defId === 'sys.fs.read') params.path = manifestPath
    if (n.defId === 'sys.fs.write') params.path = join(SHELL_DIR, 'config.json')
    /* ⚠️ **`code.shell` 的命令行里也写死了真实目录**（生成器把 `shellDir` 编进了
     * `node <shellDir>/step-list.mjs <workDir>`）—— 只换 `sys.fs.write` 的 path
     * 会让「配置写进沙箱、脚本却读真实目录」两边对不上，症状是「临时库建不出来」。
     * 所以这里也要一起换：脚本路径与工作目录都指到本次的沙箱。 */
    if (n.defId === 'code.shell') {
      const realShellDir = join(process.env.DSH_HOME ?? '', 'tmp', 'ewb-ingest')
      params.command = String(params.command ?? '')
        .split(fwdSlash(realShellDir)).join(fwdSlash(SHELL_DIR))
        .split(realShellDir).join(fwdSlash(SHELL_DIR))
    }
    if (n.defId === 'code.js' && String(params.code ?? '').includes('dbPath:')) {
      /* 把 ② 拼配置里的真实路径全换成临时的。
       *
       * ⚠️ **不能用 `.replace(/…/g, 含反斜杠的字符串)`** —— 替换串里的 `\U` 之类
       * 会被当转义吃掉，实测把 `C:\Users\...` 变成了 `C:Users...`（路径全烂）。
       * 所以这里用**拆分再拼**（split/join），它是纯字面替换、不做转义。 */
      const realDb = 'D:/ecom-data/清洗入库/ecom.db'
      const realData = 'D:/ecom-data/原始数据'
      params.code = String(params.code).split(realDb).join(fwdSlash(dbPath)).split(realData).join(fwdSlash(dataRoot))
    }
    return {
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: { def: lib.find(d => d.id === n.defId), params, onError: n.onError, skipped: n.skipped === true },
    }
  }),
  doc.edges,
)

/* ⚠️ code.shell 走的是**真子进程**（经 cmd /c）—— 这里要用真的 shell 执行方。
 * 但它依赖 dsh 的 ctx.subprocess，测试里没有，所以用 node:child_process 直接起。 */
const { spawnSync } = await import('node:child_process')
const shellFn = async (cmd) => {
  const argv = cmd.argv ?? []
  if (argv.length === 0) throw new Error('空命令')
  /* argv 形如 ['cmd','/c','node "x.mjs" "y"'] —— 直接交给 cmd /c 跑（与真机上一致）。 */
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true })
  const out = String(r.stdout ?? '')
  const err = String(r.stderr ?? '')
  const lines = out.trim().split('\n').filter(l => l.trim() !== '')
  /* ⚠️⚠️ **返回值必须是纯文本，与真执行方一致**（2026-10-16 修）。
   * code.shell 的约定是「下游拿到命令的 stdout 原文」（`src/dispatch/executors.ts`
   * 返回 `{ status:'success', output: out.trim() }`），**不是**解析好的对象。
   * 原先这里把最后一行 JSON 解析成对象再给下游 —— 那是执行方的**第二份实现**，
   * 抖音那边因此漏掉一个真 BUG（用户报的「拿不到目录清单」）。
   * 详见 `pitfalls/同一件事写两份迟早漂.md`。
   *
   * ⚠️ 清洗入库这条链**不靠 stdout 传数据**（三步之间用固定工作目录里的
   * `files.json` / `cleaned.json` 交接，见 scripts/ingest/shell-steps.mjs 的文件头），
   * 所以改这一行对它本来没有影响 —— 但替身必须与真执行方同形，
   * 否则下一个人加一个「靠 stdout 拿数据」的 code.js 时又会踩同一个坑。 */
  if (r.status !== 0) {
    /* 失败时**可以**帮它解读 JSON，只为让报错可读 —— 返回值不带它。 */
    let why = ''
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o?.error !== undefined) { why = String(o.error); break } } catch { /* 往前找 */ }
    }
    throw new Error('命令失败（退出码 ' + String(r.status) + '）：' + (why !== '' ? why : err.slice(0, 200)))
  }
  return out.trim()
}

const IMPLS = new Map([
  ['code.js', runCodeFn],
  ['sys.fs.read', readFileFn],
  ['sys.fs.write', writeFileFn],
  ['code.shell', shellFn],
])

const logs = []
const out = await runGraph(
  { nodes: specs.nodes, edges: specs.edges, workdir: TMP },
  async (req) => {
    /* ⚠️ 命令体形状按执行方不同：
     *   - builtin（`code.js` / `sys.fs.*`）→ `{ node: 'code.js', params }`
     *   - shell（`code.shell`）           → `{ argv: [...] }`
     * 所以我第一版只认 `command.node` 时，`code.shell` 那步报「没有实现: undefined」。
     * 判据要按**执行方**分（`req.executor` 就是它）。 */
    const kind = String(req.executor ?? '')
    const isShell = kind === 'shell'
    const fn = isShell ? shellFn : IMPLS.get(String(req.command?.node ?? ''))
    if (fn === undefined) {
      return { ok: false, status: 'failed', error: '没有实现: ' + (isShell ? 'shell' : String(req.command?.node)), logs: [] }
    }
    try {
      const v = await fn(req.command, { nodeId: req.nodeId, workdir: TMP, upstream: req.context?.upstream ?? [] })
      return { ok: true, status: 'success', output: v, logs: [] }
    } catch (e) {
      return { ok: false, status: 'failed', error: String(e?.message ?? e), logs: [] }
    }
  },
  { onEvent: (e) => { if (e.kind === 'log') logs.push(e.nodeId + ': ' + e.line) } },
)

console.log('  跑过的: ' + JSON.stringify(out.ran))
console.log('  aborted: ' + String(out.aborted))
if (out.error !== undefined) console.log('  error: ' + String(out.error))
console.log('')
console.log('=== 日志 ===')
for (const l of logs) console.log('  ' + l.slice(0, 140))

check('★ 整条跑通（没中断）', out.aborted !== true, String(out.error ?? ''))
/* 同上：现在还会跑 ⓪ 开始 这个机制节点 —— 只数**干活**的那六个。
 *
 * ⚠️ 2026-10-25：原来这条还要求 `end` 也跑过（「产出才有地方声明」）。
 * 用户决定存档里去掉结束节点之后，`end` 不再存在，那条判据的两半要分开看：
 *   · 开始节点仍必须跑（它是这条链的入口，没跑说明图断了）；
 *   · 结束节点必须**没跑**（它已不在存档里，出现在 ran 里才是异常）。 */
{
  const ranNodes = out.ran.filter((id) => id !== 'start' && id !== 'end')
  check('★ 六个干活步骤都跑到了', ranNodes.length === 6, JSON.stringify(out.ran))
  check('★ 开始节点跑了', out.ran.includes('start'), JSON.stringify(out.ran))
  check('★★ 没有结束节点跑（存档里已经没有它了）',
    !out.ran.includes('end'), JSON.stringify(out.ran))
}

/* ── 验结果 ── */
console.log('')
console.log('=== 结果 ===')
check('临时库建出来了', existsSync(dbPath), dbPath)
if (existsSync(dbPath)) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT * FROM tm_overview_demo').all()
  const v = db.prepare('SELECT * FROM v_demo').all()
  console.log('  表内容: ' + JSON.stringify(rows))
  console.log('  视图: ' + JSON.stringify(v))
  check('★ 写了 1 行', rows.length === 1, String(rows.length))
  check('★ 19 位 ID 保文本', rows[0]?.商品ID === '1234567890123456789', String(rows[0]?.商品ID))
  check('★ 日期来自文件名（2026-06-30，没差一天）', String(rows[0]?.日期).startsWith('2026-06-30'), String(rows[0]?.日期))
  check('★ 千分位转成了数值 1234.5', Number(rows[0]?.支付金额) === 1234.5, JSON.stringify(rows[0]?.支付金额))
  check('★ 视图建出来了', v.length === 1, JSON.stringify(v))
  db.close()
}

/* ── 真实数据与真库没被动过 ── */
console.log('')
console.log('=== 真实文件没被动过 ===')
if (dbBefore === null) {
  console.log('  （真实 ecom.db 原本不在，跳过）')
} else {
  const now = statSync(REAL_DB)
  check('★ 真实 ecom.db 大小不变', now.size === dbBefore.size, String(dbBefore.size) + ' → ' + String(now.size))
  check('★ 真实 ecom.db 修改时间不变', now.mtimeMs === dbBefore.mtime, new Date(dbBefore.mtime).toISOString())
}
if (dataBefore !== null) {
  check('★ 真实「原始数据」目录没被改（只读它列文件）',
    statSync(REAL_DATA).mtimeMs === dataBefore, new Date(dataBefore).toISOString())
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('  （临时目录已清理）')
console.log(failed === 0 ? '结论：「清洗入库」工作流端到端跑通，真实文件没被动过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

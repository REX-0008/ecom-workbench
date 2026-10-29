/** 离线验「天猫取数」工作流（真引擎 + 真节点实现，浏览器步骤用假数据）。
 *
 * ## 用户红线
 *
 * 「测试的时候**不允许打开抖音与天猫页面**」→ 浏览器三步（打开/取名单/触发轮询）
 * 在这里**返回构造的数据**，不真的开页面。
 *
 * ## 这条链能离线验到什么
 *
 * 除那三步外全是真实现：夜禁判断、列目录（**真 code.shell 子进程**）、
 * 过滤、护栏、取值、**下载落盘（真子进程，但 URL 指向本地临时 HTTP 服务）**。
 *
 * ⚠️ 下载那步要真的下载一个 URL —— 所以我起一个**本地临时 HTTP 服务**返回
 * 一个**真的 xlsx**（造出来的）+ 一个**假 xlsx**（验 PK 校验会拦住）。
 * 这样「PK 校验」这条护栏才真的被验到。
 *
 * 跑完即删（验过后收成常驻测试）。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { runCodeFn, writeFileFn, readFileFn, branchFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { TM_LIST_DIRS, TM_DOWNLOAD } from '../scripts/browser/tmall-shell.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/* ⚠️ 存档名**由生成器决定**，别在这里写死（2026-10-19 踩过，同日/抖音同理）。 */
const WF_NAME = (() => {
  const src = readFileSync(new URL('../scripts/browser/build-tmall.mjs', import.meta.url), 'utf8')
  const m = /new Builder\('([^']+)'/.exec(src)
  if (m === null) throw new Error('读不到 build-tmall.mjs 里的工作流名')
  return m[1]
})()
const WF = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows', WF_NAME + '.json')
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`）。理由见 `tests/ingest-steps.mjs` 那段注释：
 * 写死的目录名会让「两个进程同时跑」与「上次残留」都变成假红（2026-10-20 修）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-tmall-e2e-'))
/* ⚠️ **落进本次的沙箱目录**，不是真实的 `$DSH_HOME/tmp`（2026-10-20 修，理由同 ingest-workflow）。
 * 顺序：必须在 `TMP` 之后声明 —— 声明在前面会命中「用在定义之前」（TDZ，`check:tdz` 专抓，
 * 本项目的高频白屏坑；这份是测试文件所以不白屏，但一样是 ReferenceError）。 */
const SHELL_DIR = join(TMP, 'shell')
mkdirSync(SHELL_DIR, { recursive: true })
/* ⚠️ **shell 脚本也要搬进沙箱**（2026-10-20 修）：生成器把 `tm-list-dirs.mjs` /
 * `tm-download.mjs` 写进真实的 `$DSH_HOME/tmp/ewb-tmall/`，而命令行里写死了那个路径。
 * 脚本内容来自 `scripts/browser/tmall-shell.mjs`（与生成器**同一份**常量，
 * 不在这里手抄 —— 见 `pitfalls/同一件事写两份迟早漂.md`）。 */
writeFileSync(join(SHELL_DIR, 'tm-list-dirs.mjs'), TM_LIST_DIRS, 'utf8')
writeFileSync(join(SHELL_DIR, 'tm-download.mjs'), TM_DOWNLOAD, 'utf8')
const REAL_DATA = 'D:/ecom-data/原始数据'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它。 */

const { statSync } = await import('node:fs')
const dataBefore = (() => { try { return statSync(REAL_DATA).mtimeMs } catch { return null } })()

/* ── 造一个临时数据根（三张报表的文件夹，其中一个「今天已下过」）── */
const dataRoot = join(TMP, '原始数据')
const now = new Date()
const todayYMD = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
mkdirSync(join(dataRoot, 'D-店铺-整体-天猫'), { recursive: true })
mkdirSync(join(dataRoot, 'D-店铺-搜索-天猫'), { recursive: true })
mkdirSync(join(dataRoot, 'S-商品-整体-天猫'), { recursive: true })
/* ⚠️ 「D-店铺-整体-天猫」里放一个**今天**的文件 → 该报表要被跳过。 */
writeFileSync(join(dataRoot, 'D-店铺-整体-天猫', '整体_' + todayYMD + '.xlsx'), 'dummy')

/* ── 起本地 HTTP 服务，供「下载落盘」那步真下 ── */
const XLSX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('假的xlsx内容但头是对的')])
const HTML_BYTES = Buffer.from('<html>这不是 xlsx</html>')
const server = createServer((req, res) => {
  if (req.url.startsWith('/good1')) { res.writeHead(200); res.end(XLSX_BYTES); return }
  if (req.url.startsWith('/good2')) { res.writeHead(200); res.end(XLSX_BYTES); return }
  if (req.url.startsWith('/bad')) { res.writeHead(200); res.end(HTML_BYTES); return }
  res.writeHead(404); res.end('no')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = 'http://127.0.0.1:' + String(port)
console.log('  本地测试 HTTP 服务: ' + base)

/* ── 跑工作流 ── */
const doc = JSON.parse(readFileSync(WF, 'utf8'))
const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]
/* ⚠️ **别把节点数写死成具体数字**（2026-10-15 踩过）：删掉「⑨ 连续失败护栏」
 * 那个节点后节点数 18→17，于是这条断言变红 —— 而**功能是好的**
 * （同一份档案里主链跑到 n17，全部节点都执行了）。
 * 写死数字等于把「节点个数」偷偷编进断言，而节点个数本来就会随业务调整变。
 *
 * 改成判**形状**：每个节点都从起点可达（不靠数字）。
 * ⚠️ 可达 = **连线 ∪ 循环容器归属** —— 循环体的成员靠 `parentId` 归属，
 * 不看外部连线（`flow.loop` 只由 items/result 参数进出，那条边不算图上的边）。
 * 少算后一半会把循环体成员全判成孤岛（抖音那份实测 9 个）。 */
check('工作流文件能读', doc.nodes.length > 0, '节点 ' + String(doc.nodes.length))
check('每个节点都有 id 与 label（没有空壳）', doc.nodes.every(n => n.id && n.label), '')
{
  const reach = new Set([doc.nodes[0].id])
  let grew = true
  while (grew) {
    grew = false
    for (const e of doc.edges) if (reach.has(e.source) && !reach.has(e.target)) { reach.add(e.target); grew = true }
    for (const n of doc.nodes) if (n.parentId && reach.has(n.parentId) && !reach.has(n.id)) { reach.add(n.id); grew = true }
  }
  const orphans = doc.nodes.filter(n => !reach.has(n.id)).map(n => n.id)
  check('★ 没有断链/孤岛节点（每个都能从起点走到）', orphans.length === 0,
    orphans.length ? '孤岛: ' + orphans.join(',') : String(reach.size) + '/' + String(doc.nodes.length))
}

/* ⚠️ 报表名单（假的，代替页面内 fetch）：
 *   · 整体 → 今天已下过（应跳过）
 *   · 搜索 → 要下，且给一个**有效** URL
 *   · 商品 → 要下，但给一个**假 xlsx** 的 URL（验 PK 校验会拦住）
 *   · 再加一张 → 故意给 null（验「未拿到地址」的计数） */
const FAKE_REPORTS = {
  reports: [
    { id: 1, name: '店铺-整体-日', folder: 'D-店铺-整体-天猫' },
    { id: 2, name: '店铺-搜索-关键词', folder: 'D-店铺-搜索-天猫' },
    { id: 3, name: '商品-整体', folder: 'S-商品-整体-天猫' },
    { id: 4, name: '商品-其他', folder: 'S-商品-整体-天猫' },
  ],
}
/** 页面内「触发+轮询」的假结果（按上面 4 张报表，两张拿到地址、一张拿假 xlsx、一张 null）。 */
const FAKE_TRIGGER = {
  results: [
    { id: 2, name: '店铺-搜索-关键词', folder: 'D-店铺-搜索-天猫', url: base + '/good1/search-20260101.xlsx' },
    { id: 3, name: '商品-整体', folder: 'S-商品-整体-天猫', url: base + '/bad/bad-20260101.xlsx' },
    { id: 4, name: '商品-其他', folder: 'S-商品-整体-天猫', url: null },
  ],
}

const specs = toRunSpecsFromCanvas(
  doc.nodes.map(n => {
  const params = { ...n.params }
  /* 把真实数据根换成临时的（所有出现它的地方）。 */
  const swap = (s) => String(s ?? '').split('D:/ecom-data/原始数据').join(dataRoot.replace(/\\/g, '/'))
  if (n.defId === 'sys.fs.write') params.path = join(SHELL_DIR, String(params.path).split('/').pop())
  /* ⚠️ **命令行里的 shellDir 也要换到沙箱**（2026-10-20 修）：
   * 生成器写的是 `node <真实 shellDir>/tm-list-dirs.mjs <真实 shellDir>`，
   * 只换 `sys.fs.write` 的 path 会出现「输入写沙箱、脚本读真实目录」。 */
  if (n.defId === 'code.shell') {
    const realShellDir = join(process.env.DSH_HOME ?? '', 'tmp', 'ewb-tmall')
    params.command = swap(params.command)
      .split(realShellDir.replace(/\\/g, '/')).join(SHELL_DIR.replace(/\\/g, '/'))
  }
  if (n.defId === 'code.js') params.code = swap(params.code)
  /* ⚠️ **把「现在几点」钉死成白天**（2026-10-16 修的真问题）。
   *
   * 症状：整套测试在**凌晨 01:00–06:00 之间必红**，而且报的是
   * 「主链跑通（夜禁那支没走）」—— 看起来像功能坏了。
   * 真因：n1 读的是**真实系统时钟**（`new Date().getHours()`），
   * 而这条工作流的夜禁判据是 `hour < 1 || hour >= 6`。
   * 于是凌晨跑测试时走的**正是夜禁支**（走 n3/n4、跳过 n5 起的整条主链）——
   * **那是正确行为**，是断言拿「当前时刻」当隐含输入（不可控依赖）。
   *
   * 修法：只把 n1 的 `hour` 换成固定值 12，其余一字不动 ——
   * 这样同一条断言在**任何时刻**都验「非夜禁那条路」，
   * 而夜禁支本身由 `branch` 测试（`flow.if` 的分流语义）覆盖，不靠撞时间验。
   * 第一次修时是 01:38，改完立刻确定性地走主链。 */
  if (n.id === 'n1') {
    params.code = [
      '/* 测试用：把「现在几点」钉成白天 12 点（理由见下面那段长注释）。 */',
      'return {',
      '  hour: 12,',
      '  todayYMD: String(new Date().getFullYear())',
      '    + String(new Date().getMonth() + 1).padStart(2, "0")',
      '    + String(new Date().getDate()).padStart(2, "0"),',
      '}',
    ].join('\n')
  }
  /* shell 的 cwd 也要指到临时目录？不必 —— shellDir 本来就是 $DSH_HOME/tmp/ewb-tmall，
   * 而它的脚本读 argv[2]（工作目录）。**但那正是问题**：argv[2] 是 shellDir，
   * 里面放 reports.json / plan.json。所以它们要写到 shellDir。这里保持不动。 */
  return {
    id: n.id,
    ...n.parentId === undefined ? {} : { parentId: n.parentId },
    data: { def: lib.find(d => d.id === n.defId), params, onError: n.onError, skipped: n.skipped === true },
  }
  }),
  doc.edges,
)

/* ⚠️ 「下载落盘」那步的工作目录由命令行给，而那命令里写的是真实 shellDir ——
 * 所以 reports.json / plan.json 会落在 shellDir（$DSH_HOME/tmp/ewb-tmall），
 * 那是**临时目录**，不是真实数据目录，可以接受。 */

/** shell 执行方（真子进程，经 cmd /c）。
 *
 * ⚠️ **必须用异步 `spawn`，不能用 `spawnSync`**（2026-10-14 实测踩到）：
 * 本测试在**同一个进程**里起了一个本地 HTTP 服务（供「下载落盘」那步真的下）。
 * 而 `spawnSync` 会**阻塞主线程** —— 主线程既在等子进程、又是那个 HTTP 服务的
 * 事件循环 → **死锁**：子进程的 `fetch` 永远等不到响应，报 `fetch failed`。
 * （我第一版就是 spawnSync，症状是「下载全失败」，而 URL 与文件都是对的。）
 */
const shellFn = async (cmd) => {
  const argv = cmd.argv ?? []
  if (argv.length === 0) throw new Error('空命令')
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', (e) => { reject(new Error('子进程起不来：' + String(e.message))) })
    p.on('close', (status) => {
      /* ⚠️⚠️ **返回值必须是纯文本，与真执行方一致**（2026-10-16 修）。
       *
       * 原先这里把最后一行 JSON 解析成对象再 `resolve` —— 那是 shell 执行方的
       * **第二份实现**，而真的那份（`src/dispatch/executors.ts`）返回
       * `{ status:'success', output: out.trim() }`，**纯文本**。
       * 抖音那边因此漏掉了一个真 BUG（用户 2026-10-16 报的「拿不到目录清单」）。
       * 详见 `pitfalls/同一件事写两份迟早漂.md`。
       * 需要解析 JSON 的节点（如这里的 ⑦ 过滤）**自己负责解析**。 */
      const lines = out.trim().split('\n').filter(l => l.trim() !== '')
      if (status !== 0) {
        /* 失败时**可以**帮它解读 JSON，只为让报错可读 —— 返回值不带它。 */
        let why = ''
        for (let i = lines.length - 1; i >= 0; i--) {
          try { const o = JSON.parse(lines[i]); if (o?.error !== undefined) { why = String(o.error); break } } catch { /* 往前找 */ }
        }
        reject(new Error('命令失败（退出码 ' + String(status) + '）：' + (why !== '' ? why : err.slice(0, 160))))
        return
      }
      resolve(out.trim())
    })
  })
}

/* 等待节点**立即返回**（2026-10-26 改）。
 *
 * 这份测试验的是「名单 → 跳过今天已下的 → 取直链 → 下载落盘」这条链对不对
 * —— 与「等了多久」无关（全仓没有一条断言在判 `waitedMs`，已核）。
 *
 * ⚠️ 返回值形状要与真 `delayFn` 一致（`src/dispatch/builtins.ts:151`）：
 * 有上游就透传上游，没有就给 `{ waitedMs }`。 */
const noWaitFn = async (cmd, ctx) =>
  ctx.upstream.length > 0 ? ctx.upstream[0] : { waitedMs: 0 }

const IMPLS = new Map([
  ['code.js', runCodeFn],
  ['sys.fs.read', readFileFn],
  ['sys.fs.write', writeFileFn],
  ['flow.if', branchFn],
  ['flow.delay', noWaitFn],
  /* ⚠️ 浏览器三步返回**构造的数据**（不开页面）。 */
  ['browser.act', async (cmd) => {
    const p = cmd.params ?? {}
    if (p.action === 'goto') return { url: p.url, title: '(测试：未真的打开页面)' }
    const code = String(p.code ?? '')
    /* 按代码特征认出是哪一步（三步的代码差别很大）。 */
    if (code.includes('getReportList')) return { result: FAKE_REPORTS }
    if (code.includes('download.json?reportId=')) return { result: FAKE_TRIGGER }
    /* ★ 登录检查（2026-10-20 加）：按它自己的判据认出是哪一步。
     *
     * ⚠️ 必须返回 loggedIn: true —— 这个测试验的是「正常取数」，
     * 不是「未登录分支」（那条放在 tmall-login.mjs）。
     * 返回 false 会让流程走进「写未登录结果」支，后面全部不跑；
     * 断言报出来是「有效的那个没下下来」，看着像下载坏了 ——
     * 实际是登录检查按预期拦住了。 */
    if (code.includes('login.htm')) {
      return { result: { ok: true, loggedIn: true, href: 'https://sycm.taobao.com/', reason: '' } }
    }
    throw new Error('测试里遇到没预期的浏览器脚本')
  }],
])

const logs = []
const out = await runGraph(
  { nodes: specs.nodes, edges: specs.edges, workdir: TMP },
  async (req) => {
    const kind = String(req.executor ?? '')
    const fn = kind === 'shell' ? shellFn : IMPLS.get(String(req.command?.node ?? ''))
    if (fn === undefined) return { ok: false, status: 'failed', error: '没有实现: ' + kind, logs: [] }
    try {
      const v = await fn(req.command, { nodeId: req.nodeId, workdir: TMP, upstream: req.context?.upstream ?? [] })
      return { ok: true, status: 'success', output: v, logs: [] }
    } catch (e) {
      return { ok: false, status: 'failed', error: String(e?.message ?? e), logs: [] }
    }
  },
  { onEvent: (e) => { if (e.kind === 'log') logs.push(e.nodeId + ': ' + e.line) } },
)

console.log('')
console.log('  跑过的: ' + JSON.stringify(out.ran))
console.log('  aborted: ' + String(out.aborted))
if (out.error !== undefined) console.log('  error: ' + String(out.error))
console.log('')
console.log('=== 日志 ===')
for (const l of logs) console.log('  ' + l.slice(0, 140))

check('★ 主链跑通（夜禁那支没走）', out.ran.includes('n1') && out.ran.includes('n5'), JSON.stringify(out.ran.slice(0, 4)))
check('★ 没走夜禁跳过那支（n3/n4 不在）', !out.ran.includes('n3'), JSON.stringify(out.ran))

console.log('')
console.log('=== 落盘结果 ===')
{
  /* 搜索那张应该下成功（good1）。 */
  const ok1 = join(dataRoot, 'D-店铺-搜索-天猫', 'search-20260101.xlsx')
  check('★ 有效的那个下下来了（PK 校验通过）', existsSync(ok1), ok1)
  if (existsSync(ok1)) check('  内容对（PK 头那两个字节）', readFileSync(ok1)[0] === 0x50 && readFileSync(ok1)[1] === 0x4b)
  /* 商品那张是假 xlsx → PK 校验必须拦住，**不许落盘**。 */
  const bad = join(dataRoot, 'S-商品-整体-天猫', 'bad-20260101.xlsx')
  check('★ 假 xlsx **没**落盘（PK 校验拦住了）', !existsSync(bad), bad)
  /* 今天已下过的那张不该再下（应被⑦跳过）。 */
  const skippedDir = join(dataRoot, 'D-店铺-整体-天猫')
  const files = readFileSync, { readdirSync } = await import('node:fs')
  const n = readdirSync(skippedDir).length
  check('今天已下过的那张没重复下（目录里仍只有 1 个文件）', n === 1, String(n))
}

console.log('')
console.log('=== 真实数据目录没被动过 ===')
if (dataBefore !== null) {
  check('★ 真实「原始数据」目录 mtime 没变', statSync(REAL_DATA).mtimeMs === dataBefore, new Date(dataBefore).toISOString())
}

server.close()
rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('  （临时目录已清理）')
console.log(failed === 0 ? '结论：天猫取数工作流离线跑通（含 PK 校验护栏）✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

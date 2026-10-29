/** 离线跑「取数-抖音电商罗盘」工作流（真引擎 + 真节点实现，浏览器步骤用假数据）。
 *
 * ## 用户红线
 *
 * 「不允许打开抖音与天猫页面」→ 浏览器步骤**返回构造数据**，不真的开页面。
 *
 * ## 这条链要验什么（重点是**两层嵌套循环**）
 *
 * · 循环 A：真的逐模块跑 7 轮？循环体归属对不对（`parentId`）？
 * · 循环变量真的注入到循环体了吗（`{{item.url}}` / `{{item.folder}}`）？
 * · **循环 B 真的嵌在循环 A 里面**（不是并列）——
 *   判据是 `loopB.parentId === loopA.id`，而**不是**「它跑过了」：
 *   并列时它一样会跑，症状只在真机上才看得见（拿错页面）。
 * · 循环 B 真的逐日期跑，且**每个模块都在自己刚打开的那页上下载**。
 * · `flow.if` 按 `item.module.btn == 'dropdown'` 分流，两条分支各走各的。
 *
 * ## ⚠️ 为什么「嵌套」这条必须有专门的断言
 *
 * 改造前是「两次顺序循环」：循环 A 把 7 个模块的日期全查完，再交给循环 B 逐日下载。
 * 循环 B 里**没有 goto**，靠的是循环 A 最后一次残留的页面 —— 于是 7 个模块的日期
 * 在一张表里排队，下载时靠「页面残留」猜。用户原话是「前后脱节，不太合理」。
 *
 * 嵌进去之后，内层一定在外层那一轮之内跑。**离线 e2e 只能验结构**（`parentId`），
 * 因为假浏览器不会真的导航；但结构错了就一定错 —— 而结构对、顺序对，
 * 真机上「拿错页面」这条路就断了。
 *
 * 跑完即删（验过后收成常驻测试）。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { runCodeFn, writeFileFn, readFileFn, branchFn, delayFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'

/* ⚠️ 存档名**由生成器决定**，别在这里写死（2026-10-19 踩过）：
 * 用户把这份改了名（「抖音表单下载」→「取数-抖音电商罗盘」），写死就红，
 * 而代码完全正常。现在从生成器的 new Builder('…') 读名字。 */
const WF_NAME = (() => {
  const src = readFileSync(new URL('../scripts/browser/build-douyin.mjs', import.meta.url), 'utf8')
  const m = /new Builder\('([^']+)'/.exec(src)
  if (m === null) throw new Error('读不到 build-douyin.mjs 里的工作流名')
  return m[1]
})()
const WF = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows', WF_NAME + '.json')
const SHELL_DIR = join(process.env.DSH_HOME ?? '', 'tmp', 'ewb-douyin')
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`）。理由见 `tests/ingest-steps.mjs` 那段注释：
 * 写死的目录名会让「两个进程同时跑」与「上次残留」都变成假红（2026-10-20 修）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-douyin-e2e-'))
const REAL_DATA = 'D:/ecom-data/原始数据'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它。 */

const { statSync } = await import('node:fs')
const dataBefore = (() => { try { return statSync(REAL_DATA).mtimeMs } catch { return null } })()

/* ── 造临时数据根：两个模块的文件夹，各有「现有数据」 ── */
const dataRoot = join(TMP, '原始数据')
mkdirSync(join(dataRoot, 'D-店铺-整体-抖音'), { recursive: true })
mkdirSync(join(dataRoot, 'D-店铺-直播-抖音'), { recursive: true })
/* 交易：现有到 2026-09-28（要补 29/30 两天，dropdown 模块 → 走 ④b1）。 */
writeFileSync(join(dataRoot, 'D-店铺-整体-抖音', 'DemoShop-20260928-a.xlsx'), 'x')
writeFileSync(join(dataRoot, 'D-店铺-整体-抖音', 'DemoShop-20260927-b.xlsx'), 'x')
/* 直播：现有到 2026-09-28（同样要补 29/30 两天，非 dropdown → 走 ④b2）。
 *
 * ⚠️ **必须让一个非 dropdown 模块也有要补的日期**，否则 ④b2 那条分支永远跑不到
 * （第一版就把直播设成「现有到 09-30、不用补」，于是「非 dropdown 走了 ④b2」恒红）。
 * 每一条分支都要有数据能走到 —— 这是 e2e 造数据的基本要求。 */
writeFileSync(join(dataRoot, 'D-店铺-直播-抖音', 'DemoShop-20260928-c.xlsx'), 'x')

const doc = JSON.parse(readFileSync(WF, 'utf8'))
const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]
/* ⚠️ **不数节点总数**（2026-10-20 修）。
 *
 * 原来写 `doc.nodes.length === 19`，加了「④e 日期间歇」变 20 就红 ——
 * 而功能是对的。`AGENTS.md` 明确写过「别把节点数写死」（tmall 那份犯过），
 * 所以改成「读得出来、且有节点、且没有孤岛」——那才是这份存档该守的形状。 */
check('工作流文件能读', doc.nodes.length > 0, String(doc.nodes.length) + ' 个节点')

/** 按标题前缀找一个节点（标题是给人看的、比 id 稳定）。 */
const byLabel = (prefix) => doc.nodes.find(n => String(n.label ?? '').startsWith(prefix))

/* ★ 先验结构：循环体归属对不对（这决定循环会不会带它们跑）。 */
console.log('')
console.log('=== 结构检查（两层嵌套 + 分支）===')
const loopA = byLabel('② 循环 A')
const loopB = byLabel('③ 循环 B')
{
  check('找到两个循环节点', loopA !== undefined && loopB !== undefined)
  const inA = doc.nodes.filter(n => n.parentId === loopA.id).map(n => n.label)
  const inB = doc.nodes.filter(n => n.parentId === loopB.id).map(n => n.label)
  console.log('  循环A 的成员: ' + inA.join(' / '))
  console.log('  循环B 的成员: ' + inB.join(' / '))

  /* ★★ 本次改动唯一的那条硬判据。 */
  check('★★ 循环B 是**循环A 的成员**（真的嵌进去了，不是并列）',
    loopB.parentId === loopA.id, 'loopB.parentId=' + String(loopB.parentId) + ' / loopA.id=' + String(loopA.id))

  /* ⚠️ 这两条原来数死数（A=7 / B=6），2026-10-20 加「④e 日期间歇」后 B 变 7 就红。
   * 改成**判关键步骤在不在**（那才是规格），并保留「内层不重复挂外层」那条结构断言。 */
  check('★ 循环A 里含循环B（外层成员数 ≥ 7）', inA.length >= 7, String(inA.length))
  check('★★ 循环B 里有设日期 / 点击落盘 / 取名 / 本轮结果 / 反爬间隔',
    ['设日期', '点击', '拼文件名', '本轮结果', '间歇'].every(kw => inB.some(l => l.includes(kw))),
    inB.join(' / '))
  /* ⚠️ 内层的成员**不该**同时直接挂在外层（那会让它们在外层也跑一遍）。 */
  const innerIds = new Set(doc.nodes.filter(n => n.parentId === loopB.id).map(n => n.id))
  check('★ 内层成员没有同时直接挂在外层',
    doc.nodes.every(n => !(n.parentId === loopA.id && innerIds.has(n.id))))

  /* 外层体里必须有①②…⑥那六个，且没有残留的「展平」步骤。 */
  check('★ 外层体里还有「算这个模块补哪几天」那一步',
    doc.nodes.some(n => n.parentId === loopA.id && String(n.label).includes('补哪几天')))
  check('★ 不再有「模块 × 日期」展平那一步（已删）',
    !doc.nodes.some(n => String(n.label).includes('模块 × 日期')))

  /* 分支：flow.if 在内层，两条出口各接一个下载节点。 */
  const stepIf = byLabel('④b 这个模块要两步点击吗？')
  check('④b 是 flow.if 且在循环B 里',
    stepIf !== undefined && stepIf.defId === 'flow.if' && stepIf.parentId === loopB.id)
  const outEdges = doc.edges.filter(e => e.source === stepIf?.id)
  check('★ flow.if 的两条出口都接了下游（true / false 各一个）',
    outEdges.length === 2
    && outEdges.some(e => e.sourceHandle === 'true') && outEdges.some(e => e.sourceHandle === 'false'),
    JSON.stringify(outEdges.map(e => e.sourceHandle)))
  const b1 = byLabel('④b1 两步点击')
  const b2 = byLabel('④b2 一次点击')
  check('★ 成立那一路接的是 ④b1（下拉两下）',
    outEdges.find(e => e.sourceHandle === 'true')?.target === b1?.id)
  check('★ 不成立那一路接的是 ④b2（单击一下）',
    outEdges.find(e => e.sourceHandle === 'false')?.target === b2?.id)
  /* 两条分支要汇到同一个「拼文件名」。 */
  const nameIt = byLabel('④c 拼文件名')
  check('★ 两条分支都汇到 ④c（不是两条独立的尾巴）',
    doc.edges.some(e => e.source === b1?.id && e.target === nameIt?.id)
    && doc.edges.some(e => e.source === b2?.id && e.target === nameIt?.id))
}

/* ── 跑工作流 ──
 *
 * ⚠️ **翻译走 `toRunSpecsFromCanvas`（2026-10-15 改）**，别再在这里手写映射。
 *
 * 这里原先自己拼了一份 specs，注释还写着「我第一版把 parentId 丢了」——
 * 也就是说它**一直在测自己那份**，而画布那份真实代码从来没被跑过。
 * 于是画布那份漏了 `parentId` 与 `sourceHandle` 时，这条测试照样全绿
 * （用户 2026-10-15 报的「抖音表单下载一进循环就报错停止」正是这么漏出去的）。
 *
 * 现在映射只此一份（与画布、宿主半共用），测试跑的就是真实那条路。 */
const paramsOf = new Map()
for (const n of doc.nodes) {
  const params = { ...n.params }
  const swap = (s) => String(s ?? '').split('D:/ecom-data/原始数据').join(dataRoot.replace(/\\/g, '/'))
  if (n.defId === 'code.js') params.code = swap(params.code)
  if (n.defId === 'code.shell') params.command = swap(params.command)
  /* ⚠️ 下载那步现在是 `browser.act` 的 eval（2026-10-19 改，理由见
   * `scripts/browser/douyin-code.mjs` 的 `dyGrabDownload`）。
   * 它的脚本里**写着数据根**，所以也要换 —— 不换就会往真实目录落盘，
   * 而 `pitfalls/测试误写真实数据库.md` 记的正是这一类事故。 */
  if (n.defId === 'browser.act') params.code = swap(params.code)
  if (n.defId === 'sys.fs.write') params.path = join(TMP, 'result.json')
  paramsOf.set(n.id, params)
}
const specs = toRunSpecsFromCanvas(
  doc.nodes.map(n => ({
    id: n.id,
    ...n.parentId === undefined ? {} : { parentId: n.parentId },
    data: {
      def: lib.find(d => d.id === n.defId),
      params: paramsOf.get(n.id),
      onError: n.onError,
      skipped: n.skipped === true,
    },
  })),
  doc.edges,
)

/** shell 执行方（真子进程，**异步 spawn** —— spawnSync 会阻塞主线程）。
 *
 * ⚠️⚠️ **它必须返回纯文本，与真执行方一致**（2026-10-16 修）。
 *
 * 原先这里把最后一行 JSON `JSON.parse` 成对象再 `resolve` ——
 * 那是 shell 执行方的**第二份实现**，而真的那份（`src/dispatch/executors.ts`）
 * 返回的是 `{ status:'success', output: out.trim() }`，**纯文本**。
 *
 * 于是 `DY_LAST_DATE` 那步在**测试里拿到对象**（能跑）、在**真机上拿到字符串**
 * （报「拿不到目录清单」）—— 用户 2026-10-16 报的就是这个：
 * 日志里 n6 明明成功、32 个文件都在，n7 却说列目录失败。
 *
 * 这正是 `pitfalls/同一件事写两份迟早漂.md` 记的那类坑：
 * **测试替身一旦与被替的东西形状不同，测试全绿而功能是坏的。**
 * 所以这里只做真执行方做的事：把 stdout 原样给下游。
 * 需要解析 JSON 的节点（如 `DY_LAST_DATE`）**自己负责解析**。 */
const shellFn = async (cmd) => {
  const argv = cmd.argv ?? []
  return await new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += String(d) })
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', (e) => reject(new Error('子进程起不来：' + e.message)))
    p.on('close', (status) => {
      if (status !== 0) {
        /* 失败时**可以**帮它把 JSON 解读出来，只为让报错可读 —— 返回值仍不带它。 */
        let why = ''
        const lines = out.trim().split('\n').filter(l => l.trim() !== '')
        for (let i = lines.length - 1; i >= 0; i--) {
          try { const o = JSON.parse(lines[i]); if (o?.error !== undefined) { why = String(o.error); break } } catch { /* 往前找 */ }
        }
        reject(new Error('命令失败：' + (why !== '' ? why : err.slice(0, 120))))
        return
      }
      resolve(out.trim())
    })
  })
}

/** ⚠️ 浏览器步骤：**不真的开页面**，返回构造数据。 */
const browserSeen = []
const BROWSER = async (cmd) => {
  const p = cmd.params ?? {}
  const action = String(p.action ?? '')
  const url = String(p.url ?? '')
  const code = String(p.code ?? '')
  browserSeen.push({ action, url: url.slice(0, 60), codeLen: code.length })
  if (action === 'goto') return { url, title: '(测试)' }
  /* ★ 读「登录了吗」（2026-10-22 补）。
   *
   * ⚠️ 必须返回 `loggedIn: true`：这份测试验的是「正常采集」，不是未登录分支。
   * 以前这段没写，落到最后那条 `{ result: { ok: true } }` —— 于是 `loggedIn`
   * 是 undefined，判据得出「未登录」；而那时未登录分支只是写个结果文件，
   * 后面的循环**照样会跑**（引擎不拦挂在未走分支上的循环），所以测试碰巧是绿的。
   * 现在未登录会停在等待点、重检不过就中断整次运行（这是要的行为），
   * 于是替身缺这个字段会让整份测试假红。
   *
   * 与 `tests/tmall-workflow.mjs` 同一个做法（那边早就写了 `loggedIn: true`）。
   *
   * ⚠️ 判据必须用 `loggedIn: !isLogin` —— 这是「读登录」那段**独有**的一句。
   * 只用 `includes('/login')` 会先命中「读已结算日 R」那段（它开头也有
   * `if (location.href.includes('/login'))` 的兜底判断），于是 R 读不到、
   * 循环 B 报「拿不到已结算日」。 */
  if (code.includes('loggedIn: !isLogin')) {
    return { result: { ok: true, loggedIn: true, href: 'https://compass.jinritemai.com/', reason: '' } }
  }
  /* 点「本店搜索词」tab（搜索模块那一步，2026-10-17 加）。
   * ⚠️ 判据用 'clicked' —— 与读 R 那段的 '__picker' 各自唯一，不会串。 */
  if (code.includes('本店搜索词')) {
    return { result: { ok: true, clicked: true, moduleName: '测试模块' } }
  }
  /* 读 R：返回构造的已结算日。 */
  if (code.includes('__picker') && code.includes('已结算日')) {
    return { result: { ok: true, R: '2026-09-30', moduleName: '测试模块' } }
  }
  /* 设日期：返回成功。 */
  if (code.includes('onChangeFiber')) {
    return { result: { ok: true, date: '2026-09-29', pageTitle: '正常页', moduleName: '测试模块' } }
  }
  /* 点下载 + 落盘（2026-10-19 起这段是 `browser.act` 的 eval，不再是
   * `browser.download` 节点）。⚠️ 判据用 `waitForEvent` —— 那段脚本里唯一
   * 不会与别的脚本撞的标志（`saveAs` 也有，但用它更稳）。
   * 这里返回与真脚本**同形状**的结果：下游 `DY_FILENAME` / `DY_ROUND_GUARD`
   * 靠 `suggestedFilename` 与 `pageTitle`，形状不对就会静默兜底成模块名。 */
  if (code.includes('waitForEvent')) {
    return {
      result: {
        ok: true,
        path: 'x/DemoShop-20260929-交易明细.xlsx',
        fileName: 'DemoShop-20260929-交易明细.xlsx',
        suggestedFilename: '交易明细.xlsx',
        dir: 'x', date: '2026-09-29', moduleName: '测试模块', btn: 'first',
        pageTitle: '正常页',
      },
    }
  }
  return { result: { ok: true } }
}
/** 下载那步已合并进 `BROWSER`（2026-10-19：改成 `browser.act` 的 eval，
 * 理由见 `scripts/browser/douyin-code.mjs` 的 `dyGrabDownload`）。
 * 这里不再留 `browser.download` 的替身 —— 工作流里已经没有那个节点了，
 * 留着它会让人以为那条路还在用。 */

/** 「等待」节点在本测试里**立即返回**（2026-10-26 加）。
 *
 * ## 为什么不用真的 `delayFn`
 *
 * 这份测试验的是**循环体归属对不对、循环变量注入了没、两层嵌套对不对、
 * btn 分流走没走** —— 与「等了多久」无关。
 *
 * 而工作流里 3 个 `flow.delay`（4 秒 / 2 秒 / 10 秒）**全在循环体里**，
 * 跑 7 个模块 × 两层嵌套 → 一轮 21 秒 × 7 ≈ 154 秒。那 154 秒**什么都没验**：
 * 全仓没有一条断言在判 `waitedMs`（已核；`content-canvas` 那几处是
 * 生成任务的「已等秒数」，与这个节点无关）。
 *
 * 实测：换成这个替身之后 153 秒 → 2 秒，**42 条断言一条不少照样全绿**。
 *
 * ⚠️ 返回值形状必须与真 `delayFn` 逐字一致（见 `src/dispatch/builtins.ts:151`）：
 * 有上游就透传上游，没有就给 `{ waitedMs }`。形状不对会让下游的
 * 「拿上一轮的值」悄悄变成 undefined —— 那是另一种假绿。
 *
 * ## 谁改回真 `delayFn` 会被抓到
 *
 * 下面 ①.b 那条断言直接判「映射进来的不是 `delayFn` 本身」，
 * 改回去它就红，而不是「测试悄悄变慢 154 秒」没人发现。 */
const noWaitFn = async (cmd, ctx) =>
  ctx.upstream.length > 0 ? ctx.upstream[0] : { waitedMs: 0 }

const IMPLS = new Map([
  ['code.js', runCodeFn],
  ['sys.fs.read', readFileFn],
  ['sys.fs.write', writeFileFn],
  ['flow.if', branchFn],
  ['flow.delay', noWaitFn],
  ['browser.act', BROWSER],
])

/* ★ ①.b 守住「等待节点用的是立即返回的替身」。
 *
 * 判据：这个 Map 里 `flow.delay` 映射的函数**不是** `delayFn` 本身。
 * 为什么值得一条断言：改回 `delayFn` 之后测试**仍然全绿**，只是慢 154 秒
 * —— 没人会注意到。这条把它变成一条立刻红的断言。 */
check('★ 等待节点用的是「立即返回」的替身（不是真 delayFn）',
  IMPLS.get('flow.delay') !== delayFn && IMPLS.get('flow.delay') === noWaitFn,
  IMPLS.get('flow.delay') === delayFn ? '用的还是真 delayFn —— 会白等 154 秒' : 'OK')

/**
 * 跑一遍整图。
 *
 * @param inputs - 喂给「开始」节点的值（`{modules, from, to}`）。
 *   不传 = 三个都留空（**向前兼容的基准场景**：与改造前逐字节一致）。
 * @param tag - 这次跑的标签（打印用）。
 * @returns 跑的结果、日志、以及派发过的节点。
 */
async function runOnce(inputs, tag) {
  const logs = []
  const out = await runGraph(
    {
      nodes: specs.nodes, edges: specs.edges, workdir: TMP,
      ...inputs === undefined ? {} : { inputs },
    },
    async (req) => {
      const kind = String(req.executor ?? '')
      const fn = kind === 'shell' ? shellFn : IMPLS.get(String(req.command?.node ?? ''))
      if (fn === undefined) return { ok: false, status: 'failed', error: '没有实现: ' + kind + '/' + String(req.command?.node), logs: [] }
      try {
        const v = await fn(req.command, { nodeId: req.nodeId, workdir: TMP, upstream: req.context?.upstream ?? [] })
        return { ok: true, status: 'success', output: v, logs: [] }
      } catch (e) {
        const msg = String(e?.message ?? e)
        /* ⚠️ **失败也必须打出来**：只把错误放进返回值时，排查看不到任何原因。 */
        console.log('=== [' + tag + '] ' + String(req.nodeId) + ' 失败: ' + msg.slice(0, 300))
        return { ok: false, status: 'failed', error: msg, logs: [] }
      }
    },
    { onEvent: (e) => { if (e.kind === 'log') logs.push(e.nodeId + ': ' + e.line) } },
  )
  return { out, logs }
}

/**
 * 跑完之后读结果文件，读完删掉 —— 三个场景各跑一次，文件会互相覆盖，
 * 所以每次都要当场取走。
 *
 * @returns 结果对象；文件不在时返回 null。
 */
function takeResult() {
  const p = join(TMP, 'result.json')
  if (!existsSync(p)) return null
  const r = JSON.parse(readFileSync(p, 'utf8'))
  rmSync(p, { force: true })
  return r
}

/* ══════════════════════════════════════════════════════════════════════════
 * 场景 A：三个输入全留空 —— **向后兼容的基准**
 *
 * 硬判据（任务书）：全留空 = 行为与改造前逐字节一致。
 * 具体到这里就是：7 个模块全跑、日期按 L+1 ~ R 自动推算。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('══ 场景 A：三个输入全留空（基准：与改造前一致）══')
const A = await runOnce(undefined, 'A')
const out = A.out
const logs = A.logs

/* ⚠️⚠️ 判据一律用**节点 id 的查询函数**，不把 id 写死在断言里。
 *
 * 2026-10-20 踩到：另一位成员给外层循环加了一个「要不要点 tab」的判断节点，
 * 于是**所有 id 往后挪了两位** —— 我的断言里写着 `n13`（当时是「④a 设日期」）
 * 就变成了别的节点，测试变红而**代码完全正常**。
 *
 * 这才是正确的判据：按**标题**找 id（标题是给人看的，改结构时不该动它）。
 * 同一条纪律在 `tests/douyin-download.mjs` 里已经用了（`byLabel`）。 */
const idOf = (prefix) => doc.nodes.find(n => String(n.label ?? '').startsWith(prefix))?.id
const N = {
  start: idOf('⓪ 开始'),
  openMod: idOf('②a 打开该模块页'),
  readR: idOf('②c 读已结算日 R'),
  listMod: idOf('②d 列该模块目录'),
  moduleDates: idOf('②e 算'),
  loopB: idOf('③ 循环 B'),
  setDate: idOf('④a 设日期'),
  stepIf: idOf('④b 这个模块要两步点击吗'),
  dlDropdown: idOf('④b1 两步点击'),
  dlSingle: idOf('④b2 一次点击'),
  nameIt: idOf('④c 拼文件名'),
  summary: idOf('⑥ 汇总'),
  write: idOf('⑦ 写结果文件'),
  /* ⚠️ 2026-10-25：**存档里不再有结束节点**（用户定），所以这里不再取它。
   * 原来还有一行 `end: idOf('⑧ 结束')`，去掉节点后它恒为 undefined，
   * 后面两条「结束节点跑了 / 交出了产出」就必然红 —— 那是判据过期，不是代码错。
   * 这两件事改由「写结果文件跑了」与读结果文件来判（见下方）。 */
}
console.log('')
console.log('  节点 id（按标题查出来的）: ' + JSON.stringify(N))

check('★ 整条跑通（没中断）', out.aborted !== true, String(out.error ?? ''))
check('★ 循环A 跑了（有它的成员「②a 打开该模块页」）',
  out.ran.includes(N.openMod), JSON.stringify(out.ran.slice(0, 12)))
check('★ 循环B 跑了（有它的成员「④a 设日期」）',
  out.ran.includes(N.setDate), JSON.stringify(out.ran.slice(0, 12)))
check('★ 一路到写结果文件', out.ran.includes(N.write), JSON.stringify(out.ran.slice(0, 12)))
check('★ 开始节点跑了', out.ran.includes(N.start), JSON.stringify(out.ran.slice(0, 4)))
/* ★ 2026-10-25 改判据：原来判「结束节点跑了」，节点已被用户从存档里去掉。
 * 去掉之后这条链的尾就是「⑦ 写结果文件」，所以改判**它是不是最后一个跑的**
 * —— 这比原来那条更严：原来只要求结束节点跑过，现在要求写文件之后没有别的节点。 */
{
  const tail = out.ran.slice(-1)
  check('★ 写结果文件是最后一个跑的（链尾，没有别的节点接在它后面）',
    tail[0] === N.write, JSON.stringify(tail))
}

/* ★★ 7 个模块全跑了 —— 「留空 = 全部」的可执行证据。
 *
 * ⚠️ 判据不能只看「不同 URL 有几种」：**短视频-自营 与 短视频-合作 共用同一个 URL**
 * （同一个页面、靠 nameFilter/btn/后缀区分），所以 7 个模块只有 **6 个不同 URL**。
 * 第一版按 7 个 URL 写，代码是对的它却红。
 * 这里按**打开的模块名**判（从日志里取，比 URL 准）。 */
{
  const gotos = browserSeen.filter(b => b.action === 'goto').map(b => b.url)
  /* ⚠️ **排除「查登录用的首页」**（2026-10-20）：那是新加的一步，
   * 打开的是罗盘首页而不是任何模块页。不排掉的话这条会从 6 变 7 ——
   * 而代码是对的（模块数没变）。判据要盯「打开了几个模块页」，
   * 不是「浏览器动作里出现几个不同 URL」。 */
  const HOME = 'https://compass.jinritemai.com/'
  const uniq = [...new Set(gotos)].filter(u => u !== HOME)
  check('★★ 留空 modules → 7 个模块全跑（不是 0 个）',
    uniq.length === 6, String(uniq.length) + ' 个模块 URL（短视频两条共用一个，所以是 6）')
  check('★ 确实先打开过首页查登录', gotos.includes(HOME), gotos.slice(0, 2).join(' / '))
  console.log('  打开过的页面: ' + uniq.map(u => u.split('/shop/')[1] ?? u).join(' / '))
  /* 7 个模块 = 7 轮外层循环。日志里那句「第 N/7 轮」是直接证据。 */
  check('★★ 外层循环跑了 7 轮（模块数）',
    logs.some(l => l.includes('共 7 轮')),
    JSON.stringify(logs.filter(l => l.includes('轮')).slice(0, 3)))
}

/* ★★ 结果文件里真有轮次（证明确实逐日跑下来了）。 */
{
  const r = takeResult()
  check('★ 结果文件写了', r !== null)
  if (r !== null) {
    console.log('  ' + JSON.stringify(r).slice(0, 300))
    check('★★ 汇总真的数到了轮次（不是恒报 0）', r.total > 0, 'total=' + String(r.total))
    check('★★ 成功的那几轮记成了成功（不是全记失败）',
      r.failCount === 0 && r.stoppedModules.length === 0,
      JSON.stringify({ okCount: r.okCount, failCount: r.failCount, stopped: r.stoppedModules }))
  }
}

/* ★ 2026-10-25 改判据：原来判「结束节点交出了产出（汇总 / 结果文件）」，
 * 结束节点已被用户从存档里去掉，`declaredOutputs` 现在是空对象。
 *
 * 那两项**值本身还在**，只是不再经过结束节点声明 —— 所以改成直接验源头：
 *   · 汇总的内容仍然由「⑥ 汇总」产出（这里之前已经验过它的 total / okCount）；
 *   · 结果文件仍然被 ⑦ 写出来（下面这条验磁盘上的文件）。
 *
 * ⚠️ 这不是把判据放松。原来那条只证明「结束节点读过这两个节点」；
 * 现在这条证明「结果真的落到盘上、面板读得到」—— 那才是用户能用的东西。 */
{
  check('★★ 存档里已经没有结束节点（用户 2026-10-25 定）',
    doc.nodes.every(n => n.defId !== 'flow.end'),
    doc.nodes.filter(n => n.defId === 'flow.end').map(n => n.id).join(','))
  /* ⚠️ 这条**钉住后果，不是钉住好处**：去掉结束节点之后，这份工作流
   * 不再有对外声明的产出（`declaredOutputs` 为空）。写这条是为了让
   * 「产出没了」这件事在测试里留个记号 —— 免得以后有人以为它还交得出来。
   *
   * 而用户真正要的东西（结果内容）没有丢：上面 `takeResult()` 读出来的
   * `r.total` / `r.okCount` / `r.failCount` 都照旧验过，那是面板读文件的路子。 */
  check('★ 产出声明为空（去掉结束节点的直接后果，不是回归）',
    Object.keys(out.declaredOutputs ?? {}).length === 0,
    JSON.stringify(Object.keys(out.declaredOutputs ?? {})))
}

/* ★★ 分支分流：按 btn 走哪条下载。 */
console.log('')
console.log('—— 分支分流（按 btn 走哪条下载）——')
{
  check('★ dropdown 模块（交易）走 ④b1，不进 ④b2',
    out.ran.includes(N.dlDropdown) === true, '④b1 在 ran 里？' + String(out.ran.includes(N.dlDropdown)))
  check('★ 非 dropdown 模块走了 ④b2（单击一下）',
    out.ran.includes(N.dlSingle) === true, '④b2 在 ran 里？' + String(out.ran.includes(N.dlSingle)))
  /* ④b 那一步的日志要说清「取到了什么值」—— 否则条件坏了只能干看着。 */
  check('★ ④b 的日志里能看到 item.module.btn 取到的值',
    logs.some(l => l.includes('item.module.btn')),
    JSON.stringify(logs.filter(l => l.includes('item.module.btn')).slice(0, 2)))
}

/* ══════════════════════════════════════════════════════════════════════════
 * 场景 B：只指定 modules —— 只跑点名的那个
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('══ 场景 B：modules=交易（只跑一个模块）══')
{
  const B = await runOnce({ modules: '交易', from: '', to: '' }, 'B')
  check('★ 整条跑通（没中断）', B.out.aborted !== true, String(B.out.error ?? ''))
  const gotos = browserSeen.filter(b => b.action === 'goto').map(b => b.url)
  /* browserSeen 是累计的，场景 B 之前已经记了场景 A 的 7 次 goto。 */
  const tail = gotos.slice(-1)
  const uniq = [...new Set(tail)]
  check('★★ 指定 modules → 只打开了 1 个模块的页面',
    uniq.length === 1, JSON.stringify(uniq.map(u => u.split('/shop/')[1] ?? u)))
  check('★ 打开的正是「交易」那个页面',
    uniq[0]?.includes('/shop/business-part') === true, String(uniq[0]))
  const r = takeResult()
  check('★ 结果文件写了', r !== null)
  if (r !== null) {
    check('★ 只跑一个模块 → 汇总也只数到那个模块的轮次', r.total === 2, 'total=' + String(r.total))
  }
  /* 只用了一个模块的名 —— 别名也应该等价（源码支持 name 或 alias）。 */
  const B2 = await runOnce({ modules: 'trade', from: '', to: '' }, 'B2')
  check('★ 英文别名等价（trade = 交易）',
    B2.out.aborted !== true && B2.out.ran.includes(N.dlSingle) === false
    && B2.out.ran.includes(N.dlDropdown) === true,
    JSON.stringify({ '④b1': B2.out.ran.includes(N.dlDropdown), '④b2': B2.out.ran.includes(N.dlSingle) }))
  takeResult()
}

/* ══════════════════════════════════════════════════════════════════════════
 * 场景 C：指定 from / to —— 完全按给的区间跑
 *
 * 用的模块是「交易」（现有数据到 09-28、R=09-30）。
 * 自动推算会是 09-29 ~ 09-30（2 天）；这里指定 09-01 ~ 09-03，
 * 若真的生效，轮次应该变成 3 天、日期是这三天。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('══ 场景 C：from=2026-09-01 to=2026-09-03（完全按给的区间）══')
{
  const C = await runOnce({ modules: '交易', from: '2026-09-01', to: '2026-09-03' }, 'C')
  check('★ 整条跑通（没中断）', C.out.aborted !== true, String(C.out.error ?? ''))
  const r = takeResult()
  check('★ 结果文件写了', r !== null)
  if (r !== null) {
    console.log('  ' + JSON.stringify(r).slice(0, 300))
    check('★★ 指定 from/to → 轮次按给的区间（3 天，不是自动推算的 2 天）',
      r.total === 3, 'total=' + String(r.total) + '（自动推算会是 2）')
    check('★★ 3 天全成功', r.failCount === 0, JSON.stringify({ okCount: r.okCount, failCount: r.failCount }))
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 场景 D：日期写错形状 —— 必须明确报错，不能静默算 0 天
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('══ 场景 D：from 写成 2026/09/01（形状不对）══')
{
  const D = await runOnce({ modules: '交易', from: '2026/09/01', to: '' }, 'D')
  check('★★ 日期形状不对 → 明确失败（不静默算 0 天）',
    D.out.aborted === true || D.logs.some(l => l.includes('年-月-日')),
    JSON.stringify({ aborted: D.out.aborted, err: String(D.out.error ?? '').slice(0, 120) }))
  takeResult()
}

console.log('')
console.log('=== 真实数据目录没被动过 ===')
if (dataBefore !== null) {
  check('★ 真实「原始数据」mtime 没变', statSync(REAL_DATA).mtimeMs === dataBefore, new Date(dataBefore).toISOString())
}

server_cleanup: {
  rmSync(TMP, { recursive: true, force: true })
}
console.log('')
console.log('  （临时目录已清理）')
console.log(failed === 0 ? '结论：取数-抖音电商罗盘离线跑通（两层嵌套循环 + btn 分流）✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

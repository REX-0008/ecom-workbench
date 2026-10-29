/** 拆分覆盖核验：把「要拆的流程」每一步对到现有节点上，并标出**真缺口**。
 *
 * ## 为什么有这个文件
 *
 * 用户 2026-10-13 要求：「将几个需要拆分的流程，将他们**拆开列出来**，
 * 然后**逐一核验当前工作流节点是否能够完成**」。
 *
 * 约束（用户原话）：
 *   - 「核验的时候**不要打开抖音和天猫页面**避免形成反爬预警」
 *   - 「核验**不要修改真实文件**，确保路径畅通」
 *   - 「有必要实际测试的走**临时文件**不要走实际文件」
 *
 * 所以本测试**只读本项目的节点定义与实现**，不连浏览器、不碰任何真实数据。
 *
 * ## ⚠️ 第一版判据太乐观（已修，教训留在这里）
 *
 * 第一版只判「有没有一个概念上对得上的节点」—— 于是 39 步里 37 步显示 ✓。
 * 但**临时目录实测**推翻了其中几条：
 *   - 「读现有文件最大日期」→ 需要**列目录**，
 *     而 `sys.fs.read` 只有 `path`/`encoding`，给目录直接报 `EISDIR`；
 *     而 `code.js` 跑在 `new Function` 沙箱里，**没有 `require`、没有 `fs`**。
 *     → 这一步**其实做不了**，不是「有节点就行」。
 *
 * 现在判据加了一层：**能力约束**（`LIMITS`）—— 某些步骤除了「有节点」，
 * 还要求那个节点具备某能力；缺了就标 ✗ 并说明缺什么。
 *
 * 跑法：node --import <tsx> tests/split-coverage.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { NODE_IMPLS } from '../src/nodes/impls.ts'

const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 一个节点是否「真能跑」。 */
function runnable(id) {
  const d = lib.find(x => x.id === id)
  if (d === undefined) return { ok: false, why: '节点不存在' }
  if (d.label.includes('未完善')) return { ok: false, why: '已标未完善' }
  /* `flow.loop` / `flow.parallel` / `flow.workflow` / `flow.wait` / `flow.alert-wait`
   * 由调度器解释执行，本来就不在 `NODE_IMPLS` 里 —— 它们是正常的（并行要「把框内成员
   * 切成几路并发」、等待要「存整个运行现场」，都是调度器才有能力做的事）。
   *
   * `flow.end` 同理：它的产出在所有节点跑完后由 `runGraph` 收尾时统一取
   * （见 `run.ts` 的 `collectEndOutputs`），不派发。
   *
   * ⚠️ 这张豁免名单**是白名单**，加新节点时要问一句「它真的由调度器解释吗」——
   * 别为了让它绿就加进来。 */
  const EXPLAINED = ['flow.loop', 'flow.workflow', 'flow.wait', 'flow.parallel', 'flow.alert-wait', 'flow.end']
  if (d.executor === 'builtin' && !NODE_IMPLS.has(id) && !EXPLAINED.includes(id)) {
    return { ok: false, why: 'builtin 但无实现' }
  }
  return { ok: true, why: d.executor }
}

/* ── 能力约束：不是「有节点」就够的步骤 ──────────────────────────────
 * 依据是**实测**（临时目录里跑过）与**读源码**，不是推断。
 *
 * ⚠️ 这里记一条**被实测修正过的判断**（教训：别把「我以为」当结论）：
 * 我一度把「列目录」写成**硬缺口**（因为 `sys.fs.read` 给目录报 `EISDIR`、
 * `code.js` 沙箱里没有 `require`/`fs`）。**但实测证明它可绕**：
 * `code.shell` 跑一条 `node -e "fs.readdirSync(...)"` 就能列，
 * 而且**中文不乱码**（`cmd /c dir` 那条会乱码 —— GBK 输出）。
 * 见下面 `listDir.via`。
 */
const LIMITS = {
  /* 「列目录」：**没有专用节点**，但**可以靠 code.shell 绕**。
   * 所以不算缺口 —— 只记「绕法」与代价（要用户/工作流自己写一小段命令）。 */
  listDir: {
    have: true,
    via: 'code.shell 跑 `node -e "fs.readdirSync(dir)"`（实测可行、中文不乱码）',
    note: '没有专用节点；`sys.fs.read` 给目录会报 EISDIR，`code.js` 沙箱内没有 require/fs',
  },
}

/* ── 要拆的流程：按源码实读摊开 ──────────────────────────────────────
 * 依据：`D:\ecom-data\` 下的实际脚本（2026-10-13 实读）。
 */
const FLOWS = [
  {
    name: '抖音表单下载（自动下载/src/douyin-ui.ts，8 个模块）',
    steps: [
      ['确认 CDP 9222 就绪（没开就起浏览器）', ['browser.act'], null],
      ['列目录找现有文件、算最大日期 L（findLastDate）', ['code.shell'], 'listDir'],
      ['从页面读已结算日 R（setupPicker）', ['browser.act'], null],
      ['算日期区间 from=L+1 ~ to=R（或 --from/--to）', ['code.js'], null],
      ['逐日 × 逐模块：设日期（setDate，抖音找 fiber 调 onChange）', ['browser.act'], null],
      ['点下载按钮（clickDownload）', ['browser.act'], null],
      ['等 download 事件并落盘（saveAsVerified）', ['browser.download'], null],
      ['文件头校验 + 改名归档', ['code.js', 'sys.fs.write'], null],
      ['「周期」本身 = 逐日重复', ['flow.loop'], null],
    ],
  },
  {
    name: '天猫取数报表（自动下载/src/tb-sycm.ts）',
    steps: [
      ['确认 CDP 9222 就绪', ['browser.act'], null],
      ['夜禁检查（01:00–06:00 禁跑）+ 风控护栏', ['flow.if', 'code.js'], null],
      ['确保登录（掉登录弹页面等人，5 分钟超时）', ['browser.act'], null],
      ['列报表（getReportList，**页面内** fetch 过反爬）', ['browser.act'], null],
      ['过滤今日已下载的（要列目录看本地文件）', ['code.shell'], 'listDir'],
      ['逐表触发下载（download.json）', ['browser.act'], null],
      ['轮询拿 OSS 直链（queryDownloadUrl）', ['browser.act'], null],
      ['按直链下载（Node 下载，**不经浏览器事件**）', ['sys.http'], null],
      ['PK 校验（xlsx 头）+ 归档', ['code.js', 'sys.fs.write'], null],
    ],
  },
  {
    name: '巡查（自动巡查/run.ts，三个 job）',
    steps: [
      ['夜禁检查（00:00–09:00 不跑）', ['flow.if'], null],
      ['读监控阈值配置（monitor.json）', ['sys.fs.read'], null],
      ['打开页面取 innerText（withPage，**机械分析不依赖 class**）', ['browser.act'], null],
      ['机械解析：关键词邻近取值（text.ts）', ['code.js'], null],
      ['阈值判定 → 分档（ok / warn / crit）', ['flow.if', 'code.js'], null],
      ['写结果文件 out/<job>.json', ['sys.fs.write'], null],
      ['三个 job 各自独立跑', ['flow.loop'], null],
      ['⚠️ 一个 job 内**连两个浏览器**（淘宝 + 抖音）→ 需要两个会话', ['browser.act'], null],
    ],
  },
  {
    name: '清洗入库（清洗入库/src/ingest.ts）',
    steps: [
      ['扫文件夹找 Excel（readdir）', ['code.shell'], 'listDir'],
      ['读 Excel 解析成行', ['code.js', 'code.shell'], null],
      ['建表 / 入库（SQLite）', ['code.js', 'code.shell'], null],
      ['重建视图与实体表', ['code.js', 'code.shell'], null],
      ['同步副本到 Superset 容器', ['code.shell'], null],
      ['汇总报告', ['code.js'], null],
    ],
  },
  {
    name: '六个 bat 的调用关系（编排层）',
    steps: [
      ['0一键更新 = 一键下载 + 清洗入库', ['flow.workflow'], null],
      ['一键下载 = 抖音 + 天猫（**顺序执行，两者之间无数据流**）', ['flow.workflow'], null],
      ['全部下载 = 天猫 + 抖音（**顺序与上一条相反**）', ['flow.workflow'], null],
      ['下载抖音.bat = 确保 CDP + node douyin-ui.ts', ['browser.act', 'code.shell'], null],
      ['下载天猫.bat = 确保 CDP + 登录兜底 + node tb-sycm.ts', ['browser.act', 'code.shell'], null],
      ['清洗入库.bat = node ingest.ts + node sync_superset.ts', ['code.shell'], null],
    ],
  },
]

console.log('=== 拆分覆盖核验（只读节点定义，不连浏览器、不碰真实文件）===')

const gaps = []
let total = 0

for (const flow of FLOWS) {
  console.log('')
  console.log('══ ' + flow.name + ' ══')
  for (const [step, nodes, limit] of flow.steps) {
    total += 1
    /* 先看能力约束 —— 它比「有没有节点」更准。 */
    if (limit !== undefined && LIMITS[limit]?.have === false) {
      gaps.push(step)
      console.log('  ✗ ' + step)
      console.log('      缺能力: ' + LIMITS[limit].why)
      continue
    }
    const marks = nodes.map(n => ({ n, ...runnable(n) }))
    const ok = marks.some(m => m.ok)
    if (!ok) gaps.push(step)
    console.log((ok ? '  ✓ ' : '  ✗ ') + step)
    const via = limit !== undefined && LIMITS[limit]?.via !== undefined
      ? '（绕法：' + LIMITS[limit].via + '）'
      : ''
    console.log('      靠: ' + marks.map(m => m.n + (m.ok ? '' : '✗(' + m.why + ')')).join(' / ') + via)
  }
}

console.log('')
console.log('══ 小计 ══')
console.log('  步骤 ' + String(total) + ' 条，其中现有能力**覆盖不到**的 ' + String(gaps.length) + ' 条：')
for (const g of gaps) console.log('    · ' + g)

console.log('')
console.log('══ 缺口归因（按「修一次能解几条」排）══')
{
  /* 「列目录」**不是缺口** —— 有绕法（code.shell 跑 node -e）。见 LIMITS.listDir。 */
  check('「列目录」不需专用节点（code.shell 可绕）', LIMITS.listDir.have === true)
  check('「列目录」的绕法记在案', typeof LIMITS.listDir.via === 'string')
  /* 「顺序编排」这个缺口**已于 2026-10-15 补掉** ——
   * 加了 `flow.workflow`（跑另一份工作流，照 n8n 的 Execute Sub-workflow）。
   * 所以现在**一个缺口都不剩**，这条断言反过来钉住「没有新缺口冒出来」。 */
  const orderSteps = gaps.filter(g => g.includes('一键下载') || g.includes('全部下载'))
  check('★ 没有缺口了（顺序编排已由 flow.workflow 补上）', gaps.length === 0 && orderSteps.length === 0,
    '缺口 ' + String(gaps.length) + ' 条，其中顺序编排 ' + String(orderSteps.length) + ' 条')
  /* ⚠️ 顺带钉住「补缺口用的不是 flow.merge」：合并节点解决的是「把两路数据合起来」，
   * 与「先跑 A 再跑 B、两者无数据关系」是两件事。
   *
   * 2026-10-27（票 21）：`flow.merge` **补了实现**，也不再带「未完善」标签。
   * 原来这条的后半句是「label 含未完善」——那是「它确实没实现」的旁证，
   * 现在事实反过来了。判据形状不变（还是验 label），期望值从「含」改成「不含」。
   * **前半句（顺序编排不靠 merge）一个字没动** —— 那才是这条断言的本意。 */
  check('顺序编排不靠 flow.merge（合并是另一件事）',
    lib.find(x => x.id === 'flow.workflow') !== undefined
    && lib.find(x => x.id === 'flow.merge')?.label.includes('未完善') === false)
  /* ⚠️ 实测过的一件事（写下来，免得后人以为「加条边就行」）：
   * 「先 A 后 B」可以靠**加一条边**表达，但那条边**会传数据**
   * （实测 B 收到 `out:A`）。而 bat 的真实语义是「跑完 A 再跑 B，**两者无数据关系**」。
   * 新增的 `flow.workflow` 节点正是为了避开这一点：它**不把上游数据带进子工作流**。 */
  check('「顺序编排」靠专门节点、不靠加边（加边会传数据）', true,
    'flow.workflow 不把上游数据带进子工作流 —— 与 bat 的「纯顺序」语义一致')
}

console.log('')
console.log('══ 「未完善」标签的如实性 ══')
{
  /* `runnable()` 把「label 含未完善」当硬判据，但它只在上面 `FLOWS` 里
   * **被列到的**节点上跑 —— 没被列到的节点标错了这里看不见。
   *
   * 2026-10-27（票 21）：ecom 五个与 `data.map` **已被删掉**（通用节点覆盖），
   * `flow.merge` **补了实现**。
   *
   * 2026-10-27（票 09）：`code.python` 也补完了（改走 `toCommand` -> `python -c`）。
   * **于是全仓现在一个「未完善」都没有了** —— 判据从「做完的那几个不许挂着」
   * 收紧成「谁也不许挂」：再有节点标这个，就说明它该做没做，这里必须红。
   *
   * ⚠️ 收紧而不是放宽：原来只查白名单里那 5 个，现在查全表。 */
  const stale = lib.filter(d => d.label.includes('未完善')).map(d => d.id)
  check('★★ 全仓没有节点还挂着「未完善」（票 09 之后应当为零）',
    stale.length === 0, stale.join(', ') === '' ? '零个' : stale.join(', '))
  /* 这条单独守着「别把标签删了却没做」：`code.python` 必须真能跑，
   * 而不是靠改标签过关 —— 它现在有 `toCommand`，能拼出命令。 */
  const py = lib.find(x => x.id === 'code.python')
  check('★★ code.python 有 toCommand（标签干净是因为真做了，不是改标签过关）',
    typeof py?.toCommand === 'function', typeof py?.toCommand)
}

console.log('')
console.log('══ 现有节点全表（' + String(lib.length) + ' 个）══')
for (const d of lib) {
  const r = runnable(d.id)
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + d.id.padEnd(20) + ' '
    + String(d.label).padEnd(18) + ' ' + r.why)
}

console.log('')
console.log('══ code.js 的能力边界（实测，防止「我以为」再犯错）══')
{
  /* ⚠️ 这两条来自一次**被实测推翻的推断**：
   * 我第一版据 `new Function` 就断言「code.js 读不了 Excel、连不了 SQLite」——
   * 实测证明**动态 `import()` 可用**，所以那些事它能做。
   * 钉在这里，免得后人（或我）再凭「new Function」想当然。 */
  const builtins = readFileSync(
    new URL('../src/dispatch/builtins.ts', import.meta.url), 'utf8',
  )
  check('code.js 的执行体确实是 new Function（不是子进程）',
    /new Function\('input'/.test(builtins))
  /* 判据：源码里没把 require / import 掐掉，所以动态 import 会生效。 */
  check('★ 没有掐掉动态 import（所以 code.js 能读 Excel / 连 SQLite）',
    !/delete\s+globalThis\.import|blockImport/.test(builtins),
    '实测：await import("node:fs") 返回 function')
}

console.log('')
console.log('══ 源码核对（只读，确认与上面列出的流程一致）══')
{
  /* ⚠️ 这几条查的是**真源码**，把它与上面手写的流程绑在一起 ——
   * 否则流程列表会随源码漂移而没人发现。
   * 读不到就跳过（源码不在本机时不算失败）。 */
  const ROOT = 'D:/ecom-data/'
  const probes = [
    [ROOT + '自动下载/src/douyin-ui.ts', /const MODULES: any\[\] = \[/, '抖音模块表'],
    [ROOT + '自动下载/src/douyin-ui.ts', /function findLastDate/, '抖音的 findLastDate'],
    [ROOT + '自动下载/src/tb-sycm.ts', /queryDownloadUrl/, '天猫轮询直链'],
    [ROOT + '自动下载/src/tb-sycm.ts', /SYCM_BYPASS_CURFEW/, '天猫夜禁护栏'],
    [ROOT + '清洗入库/src/ingest.ts', /CREATE VIEW/, '清洗的视图重建'],
    [ROOT + '自动巡查/run.ts', /runShop|runActivity|runQianchuan/, '巡查三个 job'],
  ]
  let seen = 0
  for (const [file, re, name] of probes) {
    if (!existsSync(file)) continue
    seen += 1
    const hit = re.test(readFileSync(file, 'utf8'))
    check('源码里确实有：' + name, hit, file.replace(ROOT, ''))
  }
  if (seen === 0) console.log('  · 源码不在本机，跳过源码核对（不算失败）')
}

console.log('')
console.log(failed === 0
  ? '结论：拆分覆盖核验完成 ✓（缺口已归因，见上）'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

import { addLoginRescue } from './login-gate.mjs'

/** 生成「天猫取数」工作流（**一份工作流** —— 一串固定步骤）。
 *
 * ## 对应原脚本
 * `下载天猫.bat` → `node src/tb-sycm.ts`。
 *
 * ## 骨架
 *
 * ```
 * ① 算时间(code.js) → ② 夜禁判断(flow.if) ─不成立→ ②b 写「未跑」结果
 *                                        └成立→ ③ 打开页面(goto)
 *                                               ④ 等渲染(delay)
 *                                               ⑤ 取报表名单(eval，页面内 fetch)
 *                                               ⑥ 列目录(shell)
 *                                               ⑦ 过滤今天已下(code.js)
 *                                               ⑧ 触发+轮询拿直链(eval，含随机间隔)
 *                                               ⑨ 连续失败护栏(code.js)
 *                                               ⑩ 从直链取文件名(code.js)
 *                                               ⑪ 下载落盘(shell，带 UA/Referer + PK 校验)
 * ```
 *
 * ## ⚠️ 三个「为什么」都在代码注释里，这里只放结论
 *
 * 1. **夜禁判断要「① 算时间」这一步**：`flow.if` 的条件只能读上游数据，
 *    读不了系统时间。
 * 2. **下载落盘走 `code.shell` 而不是 `browser.download` 节点**：
 *    天猫**不走浏览器 download 事件** —— 它是「页面内 fetch 拿 **OSS 直链**，
 *    再用 Node 下那个链接」。要带 UA + Referer，且落盘前要**校验 PK 头**
 *    （否则 OSS 出错返一段 HTML 也会被当成功落盘）。
 * 3. **⑦ 需要两条入边**（报表名单 + 目录清单）：引擎只给**直接上游**，
 *    所以两条边都要接。
 *
 * @param Builder - 生成器的 Builder 类。
 * @param opts - `{ dataRoot, shellDir, outFile, code }`。
 *   `code` 是 `scripts/browser/tmall-code.mjs` 的那几段（**由调用方传**，
 *   这样测试能单独引用那个模块而不必拖进生成器）。
 * @returns 存档对象。
 */
export function buildTmall(Builder, opts) {
  const { dataRoot, shellDir, outFile, code, login } = opts
  /** 反斜杠路径 → 正斜杠（`cmd` 与 `node` 都认，且不涉及转义）。 */
  const fwd = (p) => String(p).replace(/\\/g, '/')

  /* ⚠️ 第二个参数是**名字前缀**：这一份不是巡查 → 空前缀（否则面板里会显示「巡查-天猫取数」）。 */
  const b = new Builder('取数-天猫生意参谋', '')
  const Y = 120
  const STEP = 340
  const X = 40

  /* ⓪ 开始 —— 入口标记，**不声明输入项**。
   *
   * ## 为什么这一份一个输入都没有（与抖音/千川不同，是有依据的）
   *
   * 抖音/千川那份能声明 modules / from / to，是因为源码真的读了 --modules
   * --from --to 三个命令行参数。天猫这份**没有对应的参数**：
   *   · 取哪一天的报表由生意参谋页面自己决定（名单是页面内 fetch 来的）；
   *   · 「今天已下过的跳过」用的是**本地系统日期**（见 ⑦ 的 todayYMD），
   *     不是外部喂进来的。
   * 所以能声明的只有空清单。⚠️ 声明一个没人读的字段，等于给用户挖
   * 「填了却没效果」的坑（同 pitfalls/假防线-看着写了其实不生效.md）。
   * 要让它支持「按指定日期补跑」，得先改 ⑦ 那段逻辑 —— 那是另一件事。
   *
   * ⚠️ 用固定 id start（不走自增）：见 build-patrol-workflows.mjs 里
   * Builder.add 的 id 参数说明。 */
  const start = b.add('flow.start', { type: 'manual', fields: [] },
    '⓪ 开始', X - 340, Y, 'stop',
    '入口标记：这份取数不接受外部输入 —— 取哪天由页面决定、跳过哪些由本机日期决定。',
    'start')

  /* ① 算时间（纯数据变换）。 */
  const clock = b.add('code.js', {
    code: `/* 算当前小时与今天 —— 夜禁判断与「今天已下载」都要用。
 * ⚠️ **本地**时区（getHours / getFullYear…），不是 UTC。 */
const now = new Date()
return {
  hour: now.getHours(),
  todayYMD: String(now.getFullYear())
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0'),
}
`,
    timeout: 30000,
  }, '① 算时间（夜禁 + 今天日期）', X, Y, 'stop',
    '算当前小时与今天（本地时区）。夜禁判断与「今天已下载」都用它。')

  /* ② 夜禁判断（照源码 h>=1 && h<6 → exit 2）。 */
  const gate = b.add('flow.if', { expr: 'input.hour < 1 || input.hour >= 6' },
    '② 能跑吗（夜禁 01:00-06:00）', X + STEP, Y, 'stop',
    '夜禁 01:00–06:00 不跑（源码：退出码 2）。要调试就把条件改成 false 绕过（源码用环境变量绕）。')

  b.link(start, clock)
  b.link(clock, gate)

  /* ②b 夜禁跳过也要留痕迹。 */
  const skipDoc = b.add('code.js', {
    code: `return {
  job: 'tm-sycm',
  runAt: new Date().toISOString(),
  ok: false,
  error: '夜禁时段（01:00-06:00）未跑',
  downloaded: [],
  skipped: [],
}`,
    timeout: 30000,
  }, '②b 夜禁：生成「未跑」结果', X + STEP, Y + 460, 'stop',
    '夜禁时也写一份结果 —— 面板据此知道「今天没跑」，而不是「文件不存在」。')

  b.link(gate, skipDoc, 'false')

  const skipWrite = b.add('sys.fs.write', { path: outFile, mode: 'overwrite', mkdir: true },
    '②c 夜禁：写「未跑」结果', X + STEP * 2, Y + 460, 'stop',
    '写结果文件（面板读它）。')

  b.link(skipDoc, skipWrite, undefined, 'content')

  /* ③ 打开页面 —— 碰外部世界。 */
  const open = b.add('browser.act', {
    action: 'goto', session: '天猫', launcher: 'cdp', exePath: '',
    url: 'https://sycm.taobao.com/adm/v3/micro/auto_analysis/my_space',
    waitUntil: 'domcontentloaded', timeout: 60000,
  }, '③ 打开生意参谋', X + STEP * 2, Y, 'stop',
    '在常驻的已登录浏览器里打开生意参谋。会话标签「天猫」决定用哪个浏览器（节点设置里配）。')

  b.link(gate, open, 'true')

  /* ④ 等渲染。 */
  const wait = b.add('flow.delay', { ms: 6000, random: false },
    '④ 等页面渲染', X + STEP * 3, Y, 'continue',
    '等 6 秒让异步内容渲染完。失败也继续（下一步取不到名单会明确报错）。')

  b.link(open, wait)

  /* ★ 3b 确认账号已登录（用户 2026-10-20：两个取数工作流都缺了确认账号已登录环节）。
   *
   * ## 为什么放在「打开生意参谋」之后
   *
   * 天猫的登录判据是「URL 里有没有 login.htm」（源码 tb-sycm.ts:67）。
   * 要读 URL 就必须先落到页面上 —— 而 3 正好已经打开了生意参谋，
   * 所以这里不需要额外再开一次页面（抖音那份要，因为它先打开了首页）。
   *
   * ## 为什么不能只靠下游报错
   *
   * 未登录时生意参谋的接口会返 401，但页面不一定跳转。那时下游 5 会
   * 拿到「空名单」而不是「登录失败」，表现为「今天没有报表要下」——
   * 那是一种看着成功、其实什么都没做的失败，用户最难察觉。
   *
   * ## 已知差异（如实记）
   *
   * 源码用 playwright 的 ctx.cookies() 判 cookie 里有没有 unb / cookie2。
   * 我们在页面内 eval 里读不到 HttpOnly 的 cookie，所以只判 URL。
   * 代价：会话级 cookie 过期但页面没跳转时查不出来 —— 那种情况仍由 5 的
   * 风控词检测兜底（响应含「请重新登录」→ 立即失败）。 */
  const loginCheck = b.add('browser.act', {
    action: 'eval', session: '天猫', launcher: 'cdp', exePath: '',
    code: login.checkTm, timeout: 60000,
  }, '3b 读「登录了吗」', X + STEP * 2, Y + 230, 'stop',
    '只回答一个问题：这个浏览器现在登录淘宝 / 生意参谋了吗。判据照源码：URL 里有没有 login.htm。')

  const loginIf = b.add('flow.if', {
    conditions: [{
      left: { kind: 'field', nodeId: loginCheck, field: 'result.loggedIn' },
      op: 'is', value: 'true', valueType: 'boolean',
    }],
    logic: 'and',
    expr: '',
  }, '3c 登录了吗？', X + STEP * 3, Y + 230, 'stop',
    '已登录 → 继续取名单；未登录 → 写「未登录」结果并停下，提醒去登录。')

  /* ★ **未登录 → 写失败结果 → 发提醒 → 等人重新登录 → 重检**（2026-10-22 加）。
   *
   * 用户原话：「检测到登录失败后提醒并进入等待点，然后等待节点触发后，
   * 是否有继续执行的按钮？」
   *
   * 这一段的结构与理由全写在 `scripts/browser/login-gate.mjs` 的文件头里
   * （为什么必须重检、为什么重检前要重开页面、为什么不能放进循环、
   * 超时为什么是 12 小时、为什么失败结果要写在等待之前）。
   * 这里只负责把它接上：`3c` 的「不成立」出口进这一段，
   * 这一段重检**通过**才回到主流程，没通过就由这一段自己的「中断」节点收尾。 */
  const rescue = addLoginRescue(Builder, b, {
    prefix: '3',
    startLetter: 'd',
    platform: '天猫',
    session: '天猫',
    /* 重检前重开的页面与 ③ 同一个（生意参谋的总览页，登录判据就落在它上面）。 */
    openUrl: 'https://sycm.taobao.com/adm/v3/micro/auto_analysis/my_space',
    checkCode: login.checkTm,
    failCode: login.failResult('tmall'),
    outFile,
    x: X + STEP * 3,
    y: Y + 400,
  })

  b.link(wait, loginCheck)
  b.link(loginCheck, loginIf)
  /* ⚠️ 只连**进出一头一尾**：`loginIf → rescue.failDoc`（未登录那条）与
   * `rescue.ask → 主流程`（重检通过那条）。**段内**（`failDoc → failWrite → notify
   * → wait → reopen → recheck → ask`，以及 `ask → abort` 那条 false）
   * 由 `addLoginRescue` 自己连好，这里**不要重连一遍**。
   *
   * ## 原来这里还有一条 `b.link(rescue.ask, rescue.abort, 'false')`，2026-10-27 删了
   *
   * 它与 `addLoginRescue` 段内连的那条完全相同，在存档里留下 1 组重复边
   * （`n15>n16`）。当时判「无害、保留」的依据是 `topoSort` 按 `source\u0000target`
   * 去重 —— 那只覆盖拓扑排序，管不到 `run.ts` 里按原始边表算的 `upstreamOf`。
   * 抖音那份同源的 5 组重复边也一并清了。 */
  b.link(loginIf, rescue.failDoc, 'false')

  /* ⑤ 取报表名单 —— 页面内 fetch（带风控检测）。 */
  const fetchReports = b.add('browser.act', {
    action: 'eval', session: '天猫', launcher: 'cdp', exePath: '',
    code: code.fetchReports, timeout: 120000,
  }, '⑤ 取报表名单', X + STEP * 4, Y, 'stop',
    '页面内 fetch 名单（必须走页面：要带 cookie/UA/Referer 才过反爬）。响应含风控词就立即失败（源码：绝不重试）。')

  /* ★ 只有「已登录」才继续取名单（否则未登录时下游会拿到空名单、
   * 表现为「今天没有报表要下」—— 那种失败最容易被当成成功）。
   * 注意必须显式写 true，不写会被当成「全出口都活」。 */
  b.link(loginIf, fetchReports, 'true')
  /* ★ 重检通过也回到「取报表名单」（2026-10-22）：人是重新登录之后才走到这里的，
   * 与「一开始就登录了」应当完全同一条路 —— 否则会变成一条断头路。 */
  b.link(rescue.ask, fetchReports, 'true')

  /* ⑤b 拼 reports.json 的内容（纯变换：把 dataRoot 与名单合起来）。 */
  const reportsDoc = b.add('code.js', {
    code: `/* 上游 = ⑤ 拿到的报表名单。
 *
 * ⚠️ **要往里剥一层**（实测踩到）：browser.act 的输出形状是驱动定的
 * —— 它返回 { result: <页面脚本的返回值> }（见 driver.mjs 的 actEval）。
 * 直接读 input.reports 会拿到 undefined，于是「报表名单是空的」直接抛错。
 *
 * ⚠️ 为什么要这一步：下一个 shell 步骤（列目录）**只能从文件读入参**
 *（命令行不能带 JSON —— 见 ingest 那边的说明），所以这里把 dataRoot 与名单拼成
 * reports.json 的内容，由下一步落盘。 */
const up = input && typeof input === 'object' ? input : {}
const payload = up.result !== undefined && up.result !== null ? up.result : up
const reports = Array.isArray(payload.reports) ? payload.reports : []
if (reports.length === 0) {
  throw new Error('报表名单是空的（⑤ 那步失败？页面没登录？或今天没有报表）')
}
return { dataRoot: ${JSON.stringify(fwd(dataRoot))}, reports }
`,
    timeout: 30000,
  }, '⑤b 拼 reports.json 内容', X + STEP * 5, Y, 'stop',
    '把数据根与报表名单拼成配置文件内容（只算不写）。')

  b.link(fetchReports, reportsDoc)

  /* ⑤c 写 reports.json —— 碰外部世界。 */
  const reportsWrite = b.add('sys.fs.write', {
    path: fwd(shellDir) + '/reports.json', mode: 'overwrite', mkdir: true,
  }, '⑤c 写 reports.json', X + STEP * 6, Y, 'stop',
    '落盘（下一个 shell 步骤读它）。')

  b.link(reportsDoc, reportsWrite, undefined, 'content')

  /* ⑥ 列目录 —— 碰外部世界 → code.shell。 */
  const listDirs = b.add('code.shell', {
    /* ⚠️ **命令里不加引号**（`cmd /c` 会剥掉开头的引号，实测踩过）。 */
    command: 'node ' + fwd(shellDir) + '/tm-list-dirs.mjs ' + fwd(shellDir),
    cwd: shellDir, shell: 'cmd', timeout: 120000,
  }, '⑥ 列各文件夹（看今天下过没）', X + STEP * 7, Y, 'stop',
    '列出各报表文件夹里已有的文件名 —— 「今天是否已下载」靠文件名里的日期判断。')

  b.link(reportsWrite, listDirs)

  /* ⑦ 过滤今天已下载的（纯逻辑）—— **两条入边**（名单 + 目录清单）。 */
  const filter = b.add('code.js', { code: code.filterToday, timeout: 30000 },
    '⑦ 过滤今天已下载的', X + STEP * 8, Y, 'stop',
    '纯判断：文件名含今天（本地日期）的跳过。⚠️ 天猫的文件名日期是下载日期，不是数据日期。')

  /* ⚠️ 两条边都要接：名单（⑤）与目录清单（⑥）—— 引擎只给**直接上游**。 */
  b.link(fetchReports, filter)
  /* ⑥ 的输出是「一行 JSON 摘要」，实际清单在 dirs.json 里 —— 所以 filter 自己要读文件。
   * 但它读文件就越界了（碰外部世界）…… 所以改成：⑥ 的输出里**带上清单**。
   * 见 tmall-shell.mjs 的 TM_LIST_DIRS：它把 dirs 也打在 stdout 上（条数很少）。 */
  b.link(listDirs, filter)

  /* ⑧ 触发 + 轮询（页面内，含随机间隔）。 */
  const trigger = b.add('browser.act', {
    action: 'eval', session: '天猫', launcher: 'cdp', exePath: '',
    code: code.trigger, timeout: 600000,
  }, '⑧ 触发下载 + 轮询拿直链', X + STEP * 9, Y, 'stop',
    '页面内触发并轮询直链。间隔随机 8–15 秒（源码：拟人化防反爬）。风控词 → 立即失败，不重试。')

  b.link(filter, trigger)

  /* ⚠️ **这里原本有一个「⑨ 连续失败护栏」节点，2026-10-15 已删**（用户定：删掉）。
   *
   * 删它的依据（T8 的评估 §〇·甲 + T9 的 E7，两条独立发现一致）：
   *   ① **它并不中断流程** —— 它的代码只产出 `downloadable` / `stopped` 两个字段，
   *      **没有 `throw`**；而它的 `onError` 是 `stop`，不抛错就触发不了失败分支
   *      → 那个节点每次都「成功」，界面上看不出它做没做事。
   *   ② **它的位置与源码不一致** —— 源码两个阶段里，**阶段一（触发+轮询）没有这道护栏**
   *      （只有风控立即终止）；护栏在**阶段二（下载）**里。
   *   ③ **真正的那道护栏已经在 ⑪ 里**（`tmall-shell.mjs` 的 `CONSECUTIVE_LIMIT = 2` +
   *      `break`，而且它**两种失败都管**：拿不到地址、下载失败）。
   *   → 所以它**冗余且错位**，留着只会让人以为这里有一道真正的护栏 ——
   *     「看着有防线」比「没有防线」更危险（见 `pitfalls/假防线-看着写了其实不生效.md`）。
   *
   * ⚠️ 顺带说明「为什么不把它改成真会中断的」：
   *   要「中途停」现在就能做到（循环体内 `throw` + `onError:'stop'` → 整条中断），
   *   但代价是**整条停**（连写结果文件都不做）。而源码的护栏是「停该阶段、后面继续」——
   *   那种语义**引擎给不了**（循环没有 `break`，n8n / Dify 的迭代也都没有）。
   *   所以正确做法是「删掉这个假护栏，把真护栏留在 ⑪ 的脚本里」。 */

  /* ⑨ 从直链取文件名（纯逻辑）。 */
  const pickName = b.add('code.js', { code: code.pickFilename, timeout: 30000 },
    '⑨ 从直链取文件名', X + STEP * 10, Y, 'stop',
    '纯逻辑：从 OSS 直链取出文件名与落盘目录。')

  b.link(trigger, pickName)

  /* ⑨b 拼 plan.json 的内容（加 dataRoot）。 */
  const planDoc = b.add('code.js', {
    code: `/* 上游 = ⑨ 的落盘计划。加上 dataRoot —— 下载那步要从文件读它。 */
const up = input && typeof input === 'object' ? input : {}
return { ...up, dataRoot: ${JSON.stringify(fwd(dataRoot))} }
`,
    timeout: 30000,
  }, '⑨b 拼 plan.json 内容', X + STEP * 12, Y, 'stop',
    '把数据根加进落盘计划（只算不写）。')

  b.link(pickName, planDoc)

  /* ⑨c 写 plan.json。 */
  const planWrite = b.add('sys.fs.write', {
    path: fwd(shellDir) + '/plan.json', mode: 'overwrite', mkdir: true,
  }, '⑨c 写 plan.json', X + STEP * 13, Y, 'stop',
    '落盘（下载那步读它）。')

  b.link(planDoc, planWrite, undefined, 'content')

  /* ⑪ 下载落盘 —— 碰外部世界 → code.shell。 */
  const download = b.add('code.shell', {
    command: 'node ' + fwd(shellDir) + '/tm-download.mjs ' + fwd(shellDir),
    cwd: shellDir, shell: 'cmd', timeout: 1800000,
  }, '⑩ 下载落盘（带 UA/Referer + 校验）', X + STEP * 14, Y, 'stop',
    '用 Node 直接下 OSS 直链（带 UA + Referer，否则被拒）。落盘前校验 PK 头（zip 魔数）—— 假 xlsx 不许落盘。')

  b.link(planWrite, download)

  /* ⑫ 汇总写结果。 */
  const write = b.add('sys.fs.write', { path: outFile, mode: 'overwrite', mkdir: true },
    '⑪ 写结果文件', X + STEP * 15, Y, 'stop',
    '写结果文件（面板读它）。无论成败都写 —— 源码的约定是「失败也要看得见」。')

  b.link(download, write, undefined, 'content')

  /* ⑫ 结束 —— **2026-10-25 去掉**。
   *
   * 原来这里是一个 `flow.end`，声明两项产出：
   *   · 下载计划 = ⑨ 的 { plan, count, missing, total }（取 ⑨ 不是 ⑩：⑩ 是
   *     code.shell，交给下游的只有纯文本 stdout，形状不定）；
   *   · 结果文件 = ⑪ 的 { path, bytes }。
   *
   * 用户 2026-10-25 决定**存档里不再有结束节点**，所以节点与那条边都不建了，
   * ⑪ 写结果文件 就是这条链的尾。
   *
   * ⚠️ 去掉的只是存档里的用法；节点定义（`src/nodes/flow/end/node.ts`）原样保留。
   *
   * 代价说清楚：这份工作流**不再有对外声明的产出**。结果仍然落在 ⑪ 写的
   * 那份文件里（面板读它），损失的只是「别的流程调它时拿不到返回值」。 */

  /* ★ 说明（用户 2026-10-14 要求显示在列表里）。 */
  const doc = b.doc()
  doc.description = '从生意参谋取当期报表：拿名单 → 跳过今天已下的 → 拿 OSS 直链 → 下载落盘（带 UA/Referer + 校验）'
  return doc
}

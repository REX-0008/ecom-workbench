/* 救援段在 `login-gate.mjs`（与抖音、天猫共用同一段逻辑）。
 * ⚠️ 这里**必须 import 真的那份**、不许在本文件里抄一遍：
 * 五条设计判断都写在那个文件头，抄一份迟早漂（本项目已有教训）。 */
import { addLoginRescue } from './login-gate.mjs'
import { loginFailResult } from './login-check.mjs'

/** 生成「取数-千川全域推广」工作流。
 *
 * ## 对应原脚本
 *
 * `D:\ecom-data\自动下载\src\douyin-ui.ts` 的千川那一段
 * （L224–473；`qianchuanFlow` 在 L377-456）。
 *
 * ## ⚠️ 为什么它是**单独一份**工作流，不是罗盘那份的一个分支
 *
 * 源码主流程里 `if (mod.qianchuan) { qianchuanFlow(...) }` 就走另一条完全不同的路：
 *
 * | | 罗盘那 7 个模块 | 千川这 2 个模块 |
 * |---|---|---|
 * | 时间 | 逐日设单日 | **区间滚动，最多 7 天一段** |
 * | 日期怎么设 | fiber 的 `onChange`（罗盘有） | **fiber 上没 onChange** → 只能点格子 / 快捷 |
 * | 页面状态 | 打开就是那个模块 | **每次导航后回默认「商品」维度，必须重选** |
 * | 幂等 | 文件名含 8 位日期 | **文件名尾部 id 每次都变 → 按「类型+区间结束日」判** |
 *
 * 四条都不一样，塞进一份工作流只会让两边都难读。所以两份。
 *
 * ## ★ 结构（三层嵌套循环，与源码的三层对应）
 *
 * 源码 `qianchuanFlow` 的实际嵌套（**不是我一开始猜的形状**，读源码后定的）：
 *
 * ```
 * main(): for (const mod of MODULES)          ← 模块（千川那两条）
 *    if (mod.qianchuan) qianchuanFlow(mod)     ← 一个模块进一次页面
 *      goto + 等 + 登录检查 + 点「素材」radio   ← **在类型循环之外**
 *      R = ...; types = ...
 *      for (const type of types)              ← 类型（视频/图片；商品维度只有「商品」）
 *        L = qcLastEndDate(); segs = qcSegRange()
 *        for (let i = 0; i < segs.length; i++) ← 分段（≤7 天）
 *          设区间 → 点类型 radio + 等表头 → 下载
 *        sleep(5~10s)                          ← 类型间停顿
 * ```
 *
 * 对应到画布：
 *
 * ```
 * ⓪ 开始（from / to 两个可选参数）
 * ① 模块清单
 * ①L 打开第一个模块页 → ①M 等渲染 → ①N 检查登录 → ①P「登录了吗？」
 *     ├ true  → ② 循环 A（逐模块）
 *     └ false → ①Q 写失败结果 → ①R 写盘 → ①S 提醒 → ①T 等人点「继续」
 *                → ①U 重开页面 → ①V 重检 → ①W「重检结果？」
 *                     ├ true  → ② 循环 A（人已登录）
 *                     └ false → ①X 中断（结果已写好）
 * ② 循环 A：逐模块
 *     ②a 打开该模块页        ②b 等页面渲染
 *     ②d 点「素材」维度 radio（商品维度跳过）     ②e 算 R 与本模块的类型
 *     ③ 循环 B：逐类型（嵌在 A 里）
 *          ③a 列该模块目录      ③b 算 L / 分段
 *          ④ 循环 C：逐分段（嵌在 B 里）
 *               ④a 设区间      ④b 点类型 radio    ④c 点下载并落盘    ④d 本轮结果
 *          ③c 类型间停顿
 *     ②f 模块间停顿
 * ⑤ 汇总 → ⑥ 写结果文件 → ⑦ 结束
 * ```
 *
 * ## ★ 登录检查在循环外（2026-10-23 改，用户方案 A）
 *
 * 原来 ②c「检查登录」在**循环 A 体内**，于是接不上「暂停等人登录」——
 * 引擎的两条硬限制之一：`flow.wait` 的 manual 模式不能进循环体
 * （挂起现场按主序切片恢复，循环体成员不在主序里，`runWait` 会**明确报错**）。
 *
 * 现在照 `scripts/browser/login-gate.mjs` 那段现成写法，把「登录检查 + 救援」
 * 整段提到循环 A **之外**：先打开第一个模块页查一次登录，通过了才进循环采集。
 * 那一段有五条设计判断（必须重检、重检前先重开页面、等待点只能在顶层、
 * 超时 12 小时、失败结果要在等待之前写），逐条在那边写着，这里只是调用它。
 *
 * ### ⚠️ 方案 A 的假设与代价（如实写，不粉饰）
 *
 * **假设**：登录一次对整次采集**全局有效**。这点对千川成立度较高：
 * 两个模块都在 `qianchuan.jinritemai.com` 同一个域下，登录态是域级 cookie。
 *
 * **代价**：**采集中途掉登录仍然接不住**。如果第 1 个模块跑完、第 2 个模块
 * 打开时才发现登录失效，这一轮会直接失败（走 ②c 那道旧的失败退出），
 * 而不是停下来等人。要接住那种情况，得让等待能被放进循环体 —— 那是引擎改动，
 * 用户已明确选方案 A（改存档），不在本轮范围。
 *
 * 所以 ②c 那一处「检查登录」**保留**（作为体内兜底），只是它失败时**不**进救援段。
 *
 * ## ⚠️ 三条「照搬源码」的硬约束（改了就静默出错）
 *
 * 1. **每次导航后重选维度**（源码 L226）：`goto` 之后页面回默认「商品」维度，
 *    URL query **不被读取**。所以「点素材 radio」这一步**不能省**，
 *    也不能挪到类型循环里面去（一个模块只进一次页面，源码也是这么排的）。
 * 2. **幂等按「类型 + 区间结束日」**（源码 L230-231）：文件名尾部 id 每次都变。
 * 3. **`qcSetRange` 逐句照搬**：点格子、翻月（最多 30 次）、**设完校验 input 值**。
 *    那是唯一验证过能设日期的版本。
 *
 * @param Builder - 生成器的 Builder 类。
 * @param opts - `{ dataRoot, outFile, code, loginCheck }`。
 *   `loginCheck` = 千川那份「登录了吗」的页面内代码（`LOGIN_CHECK_QC`）。
 * @returns 存档对象。
 */
export function buildQianchuan(Builder, opts) {
  const { dataRoot, shellDir, outFile, code, loginCheck } = opts
  if (shellDir === undefined || shellDir === '') {
    throw new Error('buildQianchuan 缺 shellDir（列目录那个脚本放哪）')
  }
  if (loginCheck === undefined) {
    throw new Error('buildQianchuan 缺 loginCheck（登录救援那一段的判据）')
  }
  const fwd = (p) => String(p).replace(/\\/g, '/')
  /* 空前缀：这一份不是巡查。 */
  const b = new Builder('取数-千川全域推广', '')
  const Y = 120

  /* ── ⓪ 开始 ────────────────────────────────────────────────────────
   *
   * 照源码 `--from` / `--to`（L406-408：填了用填的，没填才自动推算）。
   * 两项都**选填** —— 用户原则：留空 = 走原来的自动推算，不是「什么都不跑」。 */
  const start = b.add('flow.start', {
    type: 'manual',
    fields: [
      'from | 从哪天开始（格式 2026-10-01），留空 = 已有数据的最后一天 +1 | 选填 | ',
      'to | 到哪天结束（格式 2026-10-01），留空 = 素材维度按昨天、商品维度按今天 | 选填 | ',
    ],
  }, '⓪ 开始：可选日期区间', 40, Y - 240, 'stop',
    '两项都选填。留空时与源码默认行为一致：起点按「已有数据的最后一天+1」、'
    + '终点素材维度按昨天、商品维度按今天。')

  /* ① 模块清单（2 个）。 */
  const modules = b.add('code.js', { code: code.stepModules, timeout: 30000 },
    '① 模块清单', 400, Y - 240, 'stop',
    '两个千川模块：推广（素材维度，视频+图片两张表）、推广商品（商品维度，一张表）。')
  b.link(start, modules)

  /* ── ①L～①X 登录检查 + 救援（**在循环 A 之外**）──────────────────────
   *
   * ## 为什么要提到循环外（2026-10-23，用户方案 A）
   *
   * 这一段原来只有一个 ②c 在循环 A 体内。而 `flow.wait` 的 manual 模式
   * **不能进循环体**（引擎硬限制：挂起现场按主序切片恢复，循环体成员不在主序里，
   * `runWait` 会明确报错）。所以想「暂停等登录」就必须把它挪出来。
   *
   * ## 为什么先打开第一个模块页
   *
   * 登录判据要让「读登录」那段 eval 落在**真实的千川页面**上（URL 里有
   * `site-promotion`）。空白页会让判据得出「已登录」—— 那是最坏的一类错
   * （见 `login-gate.mjs` 文件头第 ② 条）。所以先 goto，再读。
   *
   * 用第 1 个模块的 URL 是因为：两个模块同域同登录态，任取一个都代表整站；
   * 取第 1 个还能让循环 A 的第一轮少一次导航的「意外」（它本来也要打开这个页）。 */
  const loginOpen = b.add('browser.act', {
    action: 'goto', session: '千川', launcher: 'cdp', exePath: '',
    url: 'https://qianchuan.jinritemai.com/dataV2/bidding/site-promotion',
    waitUntil: 'domcontentloaded', timeout: 60000,
  }, '①L 打开千川页面（查登录用）', 760, Y - 440, 'stop',
    '先打开千川首页，让下一步的登录判据落在真实页面上（空白页会被误判成已登录）。'
    + '两个模块同域同登录态，所以这里打开哪个都不影响结论。')

  /* 等 2.5 秒 —— 与 ②b 同一个理由（照源码 waitForTimeout(2500)），
   * 让页面跳到登录域这件事发生完，再去读 URL。 */
  const loginSettle = b.add('flow.delay', { ms: 2500, random: false },
    '①M 等页面跳转完成', 1020, Y - 440, 'continue',
    '等 2.5 秒。未登录时页面会跳登录域，这个跳转是异步的，读得太早会读到原页。')

  const loginCheck2 = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    code: loginCheck, timeout: 60000,
  }, '①N 读「登录了吗」', 1280, Y - 440, 'stop',
    '只回答一个问题：登录了吗。判据照源码：未登录会跳登录域，URL 里不再有 site-promotion。'
    + '形状与抖音/天猫那份一致（结论放在 result.loggedIn），好让救援那段三份共用。')

  const loginIf = b.add('flow.if', {
    conditions: [{
      left: { kind: 'field', nodeId: loginCheck2, field: 'result.loggedIn' },
      op: 'is', value: 'true', valueType: 'boolean',
    }],
    logic: 'and',
    expr: '',
  }, '①P 登录了吗', 1540, Y - 440, 'stop',
    '已登录 → 进循环 A 开始采集；未登录 → 走救援段（写结果 → 提醒 → 等人点「继续」→ 重检）。')

  b.link(modules, loginOpen)
  b.link(loginOpen, loginSettle)
  b.link(loginSettle, loginCheck2)
  b.link(loginCheck2, loginIf)

  /* 救援段（写失败结果 → 写盘 → 提醒 → 等人 → 重开页面 → 重检 → 判断 → 中断）。
   * 五条设计判断都在 `login-gate.mjs` 的文件头，这里只是调用它。 */
  const rescue = addLoginRescue(Builder, b, {
    prefix: '①',
    startLetter: 'Q',
    platform: '千川',
    session: '千川',
    openUrl: 'https://qianchuan.jinritemai.com/dataV2/bidding/site-promotion',
    checkCode: loginCheck,
    failCode: loginFailResult('qianchuan'),
    outFile,
    x: 760,
    y: Y - 200,
  })
  b.link(loginIf, rescue.failDoc, 'false')
  /* ⚠️ **段内的连线由 `addLoginRescue` 自己连好**（failDoc → failWrite → notify → wait
   * → reopen → recheck → ask，以及 ask→abort 那条 false）。这里**不要重连一遍** ——
   * 第一版照着抖音那份抄了那几行，结果每次生成都多出 5 条重复边（`e14`–`e18`），
   * 引擎按顺序入队会让同一对节点被走两遍。抖音那份之所以没暴露出问题，
   * 是因为它连的与我删掉的这几行**完全相同**（重复边被拓扑去重时吃掉了一次，
   * 但那是运气，不是设计）。 */
  /* ⚠️ 失败那条边**必须先加**（`login-gate.mjs` 文件头第 ⑤ 条）：
   * 它与「成功 → 循环」那条同层，主序按连线顺序入队；先加失败边，
   * 中断就跑在循环前面。 */

  /* ── ② 循环 A：逐模块 ──
   *
   * ⚠️ 这一层的存在理由与源码一致：**一个模块只进一次页面**，
   * 然后在这个页面里把所有类型跑完。压成一层会让每个类型都重新打开页面。 */
  const loopA = b.add('flow.loop', {
    mode: 'items',
    items: { nodeId: modules, field: 'modules' },
    result: null,
    count: 5,
    maxIters: 10,
    concurrency: 1,
  }, '② 循环 A：逐模块', 760, Y - 240, 'stop',
    '两个千川模块各一轮。循环体：打开页面 → 检查登录 → 点维度 → 算类型，然后进内层逐类型。')

  const openMod = b.add('browser.act', {
    action: 'goto', session: '千川', launcher: 'cdp', exePath: '',
    url: '{{item.url}}',
    waitUntil: 'domcontentloaded', timeout: 60000,
  }, '②a 打开该模块页', 1120, Y - 400, 'stop',
    'URL 用 {{item.url}}。⚠️ 打开后页面会回默认「商品」维度 —— URL 里的 query 不被读取，'
    + '所以下面必须重新点维度。')

  const waitMod = b.add('flow.delay', { ms: 2500, random: false },
    '②b 等页面渲染', 1420, Y - 400, 'continue',
    '等 2.5 秒（照源码 L395 的 waitForTimeout(2500)）。源码还会先等 picker 出现最多 20 秒，'
    + '这里靠这一固定等待 + 下一步的检查兜底。')

  const checkLogin = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    code: code.checkLogin, timeout: 60000,
  }, '②c 检查登录', 1720, Y - 400, 'stop',
    '千川未登录会跳登录域（URL 里不再有 site-promotion）。检查到就明确报错让人去登录，'
    + '不猜、不静默往下走。')

  /* ②d 点「素材」维度 radio。
   *
   * ⚠️ **商品维度没有这一步**（源码 L397 `if (!mod.product)`）：商品维度默认就是
   * tab=product。所以这一步必须能「按项跳过」—— 而我们**没有按项跳过节点**的能力
   * （跳过是节点级静态开关），所以照 ②c 那个写法的老经验：**脚本自己判**。
   *
   * 与罗盘那份的 `shopTab` 同一条设计：一张图、数据层区分。
   * ⚠️ 但商品维度**没有**「素材」这个 radio 可选，脚本必须知道该不该点 ——
   * 用 `{{item.product}}` 判，判据来自循环变量（不是硬编码）。 */
  const clickDim = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    code: code.clickDim, timeout: 60000,
  }, '②d 点「素材」维度（商品维度跳过）', 2020, Y - 400, 'stop',
    '照源码：素材维度每次导航后都要重选「素材」radio（页面回默认「商品」维度）；'
    + '商品维度默认就是它，不用点。脚本按 item.product 判，跳过不算失败。')

  const planTypes = b.add('code.js', { code: code.planTypes, timeout: 30000 },
    '②e 算 R 与本模块的类型', 2320, Y - 400, 'stop',
    'R：素材维度按昨天、商品维度含今天（照源码那行三元）。'
    + '类型：素材维度是视频/图片，商品维度只有「商品」。')

  b.link(openMod, waitMod)
  b.link(waitMod, checkLogin)
  b.link(checkLogin, clickDim)
  b.link(clickDim, planTypes)

  /* ── ③ 循环 B：逐类型（**嵌在循环 A 里**）──
   *
   * ⚠️ 它必须嵌进去而不是与 A 并列：`goto` 与「点素材 radio」在源码里是
   * **一个模块一次**，类型循环在它里面。并列的话每个类型都会重新打开页面 +
   * 重点维度 —— 那是改变行为，且是多出来的反爬风险。 */
  const loopB = b.add('flow.loop', {
    mode: 'items',
    items: { nodeId: planTypes, field: 'rows' },
    result: null,
    count: 5,
    maxIters: 20,
    concurrency: 1,
  }, '③ 循环 B：逐类型（在循环 A 里）', 2620, Y - 400, 'stop',
    '素材维度跑视频、图片两张表；商品维度只有一张。每项自带 module / R / type。')

  const listDir = b.add('code.shell', {
    /* ⚠️ 命令里不加引号（cmd /c 会剥掉开头的引号，实测踩过）。 */
    command: 'node ' + fwd(shellDir) + '/qc-list-one.mjs ' + fwd(shellDir) + ' ' + fwd(dataRoot) + ' {{item.module.folder}}',
    cwd: shellDir, shell: 'cmd', timeout: 120000,
  }, '③a 列该模块目录', 2920, Y - 560, 'stop',
    '扫这个模块文件夹里已有的文件名。⚠️ 不按完整文件名判重 —— 千川导出名尾部有随机 id。')

  const typePlan = b.add('code.js', { code: code.typePlan, timeout: 30000 },
    '③b 算 L / 起点终点 / 分段', 3220, Y - 560, 'stop',
    '现有数据到哪天（按「类型+区间结束日」抠，不看文件名里的 id）+ 按 7 天切段。'
    + '已有数据覆盖到目标日 → 本类型跳过（不是报错）。')

  /* ⚠️ 循环 B 的**入口**是 `③a 列目录`（它没有体内入边，循环会直接给它注入 item）。
   * `③b` 接在它后面。 */
  b.link(listDir, typePlan)

  /* ── ④ 循环 C：逐 7 天分段（**嵌在循环 B 里**）── */
  const loopC = b.add('flow.loop', {
    mode: 'items',
    items: { nodeId: typePlan, field: 'segs' },
    result: null,
    count: 5,
    maxIters: 100,
    concurrency: 1,
    /* ⚠️ 连续失败护栏开在**分段层**（照源码 L445-450：连续 2 段失败 → 停该类型）。 */
    maxConsecutiveFailures: 2,
  }, '④ 循环 C：逐 7 天分段（在循环 B 里）', 3520, Y - 560, 'stop',
    '每段最多 7 天（照源码 QC_MAX_SEG，用户 2026-09-04 定案）。'
    + '连续 2 段失败自动停这个类型（照源码护栏，不算报错）。')

  b.link(typePlan, loopC)

  const setRange = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    code: code.setRange, timeout: 180000,
  }, '④a 设区间（≤7天走快捷，否则点日历）', 3820, Y - 720, 'stop',
    '照源码：整批只有一段且就是「最近7天」时点面板快捷；否则点日历格子（翻月最多 30 次）。'
    + '⚠️ 设完要回读输入框的值校验 —— 不校验就会出现「以为设了其实没设」，然后下错区间。')

  const pickType = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    code: code.pickType, timeout: 60000,
  }, '④b 点类型 + 等表头切过去', 4120, Y - 720, 'stop',
    '点「视频 / 图片 / 商品」radio。点了之后要等表头出现那个词（最多 15 秒）——'
    + '不等就会拿到上一类型的表（切换是异步的）。本来就是这个类型时不用等。')

  const download = b.add('browser.act', {
    action: 'eval', session: '千川', launcher: 'cdp', exePath: '',
    /* 传**函数**、由本生成器用同一个 dataRoot 调它 —— 数据根只有一处来源。 */
    code: code.download(fwd(dataRoot)), timeout: 180000,
    /* ⚠️ 下载那一步失败要**重试一次**（源码 qcDownload 也有「整段重跑一次」，
     * 间隔 DL_RETRY_DELAY_MS = 5000ms）。
     * 用节点级重试表达：等价、且不必在脚本里再套一层 —— 脚本里那层递归重试
     * 要重新点按钮、重新等事件，而节点级重试把整段重跑一遍，做的事一样。
     * ⚠️ 参数名是 `retryTimes` / `retryDelayMs`（见 `model.ts` 的 `readRetry`）。 */
    retryTimes: 1, retryDelayMs: 5000,
  }, '④c 点下载并落盘', 4420, Y - 720, 'stop',
    '照源码：先挂 download 监听再点按钮；主类名没了用子串兜底（改了要记一笔）；'
    + '导出名必须含「全域推广数据」与类型词，否则不落盘直接报错；'
    + '落盘名 = DemoShop-{区间结束日}-{导出原名}；已存在就取消这次下载并报「已存在跳过」。')

  const roundGuard = b.add('code.js', { code: code.roundGuard, timeout: 30000 },
    '④d 本轮结果（含风控立即终止）', 4720, Y - 720, 'stop',
    '记这一段成败。疑似验证页立即抛错（照源码退出码 2，绝不重试，等 24 小时）。')

  b.link(setRange, pickType)
  b.link(pickType, download)
  b.link(download, roundGuard)
  b.setParent([setRange, pickType, download, roundGuard], loopC)

  /* ③c 类型间停顿（照源码 L453 `await sleep(rand(5000, 10000))`）。
   *
   * ⚠️ **位置是「这个类型全部跑完之后」**，所以它接在 `④ 循环 C` 后面，
   * 不是接在 `③b` 后面 —— 接错了就变成「每算一次分段就停 5 秒」，
   * 而实际上一段都没下（症状是「跑得很慢但什么也没下」）。
   *
   * ⚠️ 间隔**不能省**：千川比罗盘敏感。源码是 5~10 秒随机；我们的
   * `flow.delay` 开抖动后的区间是「设定值的一半到一倍半」（2.5~7.5 秒），
   * 与源码不完全一致但同量级 —— **如实记**，别以为一模一样。 */
  const typeGap = b.add('flow.delay', { ms: 5000, random: true },
    '③c 类型间停顿（反爬）', 3220, Y - 640, 'continue',
    '照源码：每跑完一个类型停 5~10 秒。这里 5 秒起步 + 随机抖动（实际 2.5~7.5 秒）。'
    + '反爬节奏别调小 —— 千川比罗盘敏感。')

  b.link(loopC, typeGap)

  /* ★ 循环 B 的成员：列目录 → 算分段 → 内层循环 → 类型间停顿。 */
  b.setParent([listDir, typePlan, loopC, typeGap], loopB)

  /* ②f 模块间停顿。 */
  const modGap = b.add('flow.delay', { ms: 5000, random: true },
    '②f 模块间停顿（反爬）', 2320, Y - 320, 'continue',
    '两个模块之间停一下（5 秒 + 随机抖动）。换的是完全不同的页面，多等一会儿更稳。')

  /* ★ 外层循环体 = 六个步骤 + 内层循环 B + 模块间停顿。
   * ⚠️ 漏掉哪一项，它就会掉回顶层、在循环外面跑一次（不报错，症状是「只跑了第一个模块」）。 */
  b.setParent([openMod, waitMod, checkLogin, clickDim, planTypes, loopB, modGap], loopA)

  /* 循环体内的顺序：②a→②b→②c→②d→②e→③循环B→②f。 */
  b.link(planTypes, loopB)
  b.link(loopB, modGap)

  /* ── 循环 A 的入口：「已登录」那两条出口 ─────────────────────────────
   *
   * ⚠️ **两条**，不是一条（2026-10-23 加登录救援时一并处理）：
   *   · `①P 登录了吗` 的 true —— 一开始就登录了，直接进循环采集；
   *   · `①W 重检结果` 的 true —— 人点了「继续」并且真登录了，也进循环采集。
   *
   * 少接哪一条，那种情况就会「登录也白登」：节点跑到这里没有出边，
   * 后面的循环一个都不启动，运行记录显示「跑完了，什么都没做」。
   *
   * ⚠️ 顺序：**先接重检那条（true）再接受中断那条（false）**，
   * 理由见 `login-gate.mjs` 文件头第 ⑤ 条 —— 两份同层，主序按连线顺序入队。
   * `addLoginRescue` 内部已经连了 `ask → abort(false)`，所以这里只补 `ask → loopA(true)`。 */
  b.link(loginIf, loopA, 'true')
  b.link(rescue.ask, loopA, 'true')

  /* ── ⑤ 汇总 ── */
  const summary = b.add('code.js', { code: code.summary, timeout: 30000 },
    '⑤ 汇总', 5080, Y - 240, 'stop',
    '总账 + 按类型分账（每张表补了几段、跳过几段、失败几段）。'
    + '跳过是幂等命中，属正常情况，不混进失败数。')

  b.link(loopA, summary)

  const write = b.add('sys.fs.write', { path: outFile, mode: 'overwrite', mkdir: true },
    '⑥ 写结果文件', 5380, Y - 240, 'stop',
    '写结果文件（面板读它）。无论成败都写 —— 失败也要看得见。')

  b.link(summary, write, undefined, 'content')

  /* ── ⑦ 结束 —— **2026-10-25 去掉** ──
   *
   * 原来这里是一个 `flow.end`，声明「汇总」与「结果文件」两项产出。
   * 用户 2026-10-25 决定**存档里不再有结束节点**，所以节点与那条边都不建了，
   * ⑥ 写结果文件 就是这条链的尾。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * 代价说清楚：这份工作流不再有对外声明的产出；结果仍在 ⑥ 写的那份文件里。 */

  const doc = b.doc()
  doc.description = '千川全域推广下载（推广：视频/图片；推广商品：商品）：逐模块打开页面 → '
    + '重选维度 → 逐类型 → 按 7 天分段设区间点下载（三层嵌套循环）。'
    + '幂等按「类型 + 区间结束日」判断 —— 千川导出名尾部 id 每次都变，不能按文件名判重。'
  return doc
}

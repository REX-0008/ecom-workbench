import { addLoginRescue } from './login-gate.mjs'

/** 生成「取数-抖音电商罗盘」工作流。
 *
 * ## 对应原脚本
 * `下载抖音.bat` → `node src/douyin-ui.ts`（612 行，最大的一份）。
 *
 * ## ★ 结构（2026-10-19 改成**两层嵌套循环**，用户定的「严格内连」）
 *
 * 原脚本是**二维循环**（9 模块 × 逐日）。我们一度拆成**两次顺序循环**，
 * 但那有个真问题：循环 A 把 7 个模块的日期**全查完**，再交给循环 B 逐日下载 ——
 * 而循环 B 里**没有「打开页面」这一步**，靠的是循环 A 最后一次残留的页面。
 * 于是「哪个模块在哪个页面上」全靠**顺序巧合**，任一模块失败或页面被导航走，
 * 后面就会在**上一个模块的页面**上下载。用户原话：
 *
 * > 「按照原本 TS 的逻辑，打开网页，排查日期，查到日期后下载。然后继续下一个表格，
 * >  而不是当前的先全部排查，然后下载（前后脱节，不太合理）。」
 *
 * 现在：
 *
 * ```
 * ① 模块清单 (code.js)
 * ② 循环 A「逐模块」（items = ①.modules）
 *      ②a 打开该模块页 (goto {{item.url}})      ②b 等 4 秒
 *      ②b2 点「本店搜索词」tab（仅搜索模块）     ②c 读已结算日 R
 *      ②d 列该模块目录得 L                      ②e 算「这个模块补哪几天」→ dates
 *      ③ 循环 B「逐日期」（**嵌在循环 A 里面**，items = ②e.dates）
 *           ④a 设日期
 *           ④b 条件判断：这个模块要两步点击吗？（item.module.btn == 'dropdown'）
 *                 ├ 成立 → ④b1 代码节点（两下点击 + 落盘）
 *                 └ 不成立 → ④b2 代码节点（一下点击 + 落盘）
 *           ④c 拼文件名                ④d 本轮结果（含风控立即终止）
 * ⑤ 汇总（连续失败护栏）(code.js) → 写结果文件 (sys.fs.write)
 * ```
 *
 * ## 三条与「两次顺序循环」不同的地方（别改回去）
 *
 * 1. **不再有「展平模块×日期」那一步**。每模块算自己的日期（②e），
 *    判据就地得出、就地消费，不存在「一张全局待办表」。
 * 2. **循环 B 的 `parentId` 指向循环 A**，不是顶层。所以它在**外层那一轮之内**跑：
 *    页面是外层刚打开的那个，不会再拿错页面。
 * 3. **循环 B 里没有 goto**，也不需要 —— 外层 ②a 刚打开过。
 *    （反过来说：一旦把循环 B 移回顶层，它就会在**别人的页面**上下载。
 *      这是本次改动的唯一硬理由，`tests/douyin-workflow.mjs` 有一条断言钉住它。）
 *
 * ## ⚠️ 为什么 ④b1 / ④b2 两个分支都是**代码节点**
 *
 * 用户画的结构里 ④b2 写的是「下载-playwright」（即 `browser.download` 节点）。
 * 实测**做不到**，原因是文件名：
 *
 *   · `browser.download` 定名只有两种：`filename` 填死，或「建议名 + 时间戳」。
 *     前者拼不出「建议名」（那要等下载事件才知道），后者名字里**没有 8 位日期**。
 *   · 下游「清洗入库」**从文件名取数据日与店铺**
 *     （`scripts/ingest/clean-lib.mjs:49` `dateFromFilename`、
 *      `:102` `shopFromFilename`），短视频两条还靠 `-自营` / `-合作` 判账号类型。
 *     时间戳名会让入库**静默取不到日期**、账号类型也判错。
 *   · 而用户明确要求「5 个非 dropdown 模块的下载行为**一字不变**」。
 *
 * 两者直接冲突，只能取后者。所以两个分支共用同一段落盘脚本
 * （`douyin-code.mjs` 的 `composeDownload`），**只换点击那几行**：
 * 两下（dropdown）vs 一下（其余 5 个）。这样 ④b 那个 `flow.if` 照用户画的保留，
 * 「每模块内连、判要不要两下」全部成立，而 5 个模块的点击与落盘逐字不变。
 *
 * ⚠️ 循环变量经**变量替换**注入（`{{item}}` / `{{item.xxx}}`）——
 * 见 `scripts/browser/douyin-code.mjs` 的文件头（我在那里记了两次写错的过程）。
 *
 * @param Builder - 生成器的 Builder 类。
 * @param opts - `{ dataRoot, shellDir, outFile, code, login }`。
 * @returns 存档对象。
 */
export function buildDouyin(Builder, opts) {
  const { dataRoot, shellDir, outFile, code, login } = opts
  const fwd = (p) => String(p).replace(/\\/g, '/')
  /* ⚠️ 第二个参数是**名字前缀**：这一份不是巡查 → 空前缀。 */
  const b = new Builder('取数-抖音电商罗盘', '')
  const Y = 120

  /* ── ⓪ 开始（用户 m00901 定案：「输入=开始节点」）────────────────────
   *
   * 这三个输入对应 bat 的 `--modules` / `--from` / `--to`。
   *
   * ## ⚠️⚠️ 全部**不必填**，这是刻意的
   *
   * 用户 2026-10-19 的原则：
   * > 「删模块这种事情，不应该，工作流做好了就应该兼容而不是为了部分去删基础结构。」
   *
   * 三个都留空 → 行为与「没有开始节点」时**逐字一致**（跑全部模块、按 L+1 ~ R 自动推算）。
   * 所以三个都是「选填」，默认值是空串。把任何一项标成必填，等于让「日常增量跑」
   * 这个最常用的情况必须先填东西 —— 那是把兼容性做没了。
   *
   * ## 为什么默认值是空串而不是写死一个值
   *
   * `resolveInputs` 的语义是「外部给的值 > 默认值」。默认值写空串 = 没有默认值，
   * 于是「外部没给」与「给了空」在下游是同一件事（都当作「没填」）。
   * 这正好是我们要的：留空 = 走自动推算。 */
  const start = b.add('flow.start', {
    type: 'manual',
    fields: [
      'modules | 要跑哪些模块，留空 = 全部（可写中文名或英文别名，逗号分隔；写「短视频」就包含自营与合作两个）| 选填 | ',
      'from | 从哪天开始，留空 = 按已有数据的最后一天 +1 自动推算（格式 2026-10-01）| 选填 | ',
      'to | 到哪天结束，留空 = 按页面上的最近已结算日 R（格式 2026-10-01）| 选填 | ',
    ],
  }, '⓪ 开始：要跑哪些模块、哪段日期', 40, Y - 200, 'stop',
    '三个输入都不必填。全留空时与改造前完全一样：跑全部 7 个模块、按「已有数据最后一天+1 ~ 最近已结算日」自动推算日期。')

  /* ① 模块清单（纯逻辑，按开始节点的 modules 过滤）。 */
  const modules = b.add('code.js', { code: code.stepModules, timeout: 30000 },
    '① 模块清单', 400, Y - 200, 'stop',
    '7 个罗盘模块（商品卡已停用、千川那 2 个走另一套流程）。模块是配置不是流程。'
    + '按开始节点的 modules 过滤；留空时跑全部。')

  /* ★ **①b-①f 确认账号已登录**（用户 2026-10-20：「两个取数工作流都缺了确认账号已登录环节」）。
   *
   * ## 为什么放在这里（第一个模块之前）
   *
   * 源码的登录检查在**每个模块打开之后**（`douyin-ui.ts:524`），而且是
   * 「等人 5 分钟」的死循环。那段在我们的结构里放不下（节点一次性执行）。
   * 按用户定的「增加 if 或者失败节点，走提醒流程，当前输出原因即可」，
   * 改成**开工前统一查一次**：没登录就别跑整个流程，直接说清原因。
   *
   * ⚠️ **代价（如实记）**：跑到一半登录态掉了（cookie 过期 / 用户在别处退出），
   * 这一次查不出来。那种情况仍由循环 A 里原有的 `LOGIN_REQUIRED` 兜底
   * （它会让那个模块失败，而不是静默跑空）。
   *
   * ⚠️ 为什么不在循环 A 里面查：那就变成「每个模块都查一次」，
   * 7 个模块 = 7 次多余的页面读；而登录态不会在几秒内反复变。 */
  const loginOpen = b.add('browser.act', {
    action: 'goto', session: '抖音', launcher: 'cdp', exePath: '',
    url: 'https://compass.jinritemai.com/', waitUntil: 'domcontentloaded', timeout: 60000,
  }, '①b 打开罗盘首页（查登录用）', 640, Y - 200, 'stop',
    '为了判断「登录了吗」必须先落到一个页面上。首页最轻（不是任何模块页）。')

  const loginCheck = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: login.checkDy, timeout: 60000,
  }, '①c 读「登录了吗」', 880, Y - 200, 'stop',
    '只回答一个问题：现在这个浏览器登录抖音了吗。判据照源码：URL 里有没有 /login。')

  const loginIf = b.add('flow.if', {
    conditions: [{
      left: { kind: 'field', nodeId: loginCheck, field: 'result.loggedIn' },
      op: 'is', value: 'true', valueType: 'boolean',
    }],
    logic: 'and',
    expr: '',
  }, '①d 登录了吗？', 1120, Y - 200, 'stop',
    '已登录 → 继续原来的采集流程；未登录 → 走「写未登录结果」那条路，提醒去登录。')

  /* ★ **未登录 → 写失败结果 → 发提醒 → 等人重新登录 → 重检**（2026-10-22 加）。
   *
   * 用户原话：「检测到登录失败后提醒并进入等待点，然后等待节点触发后，
   * 是否有继续执行的按钮？」
   *
   * 这一段的结构与理由全写在 `scripts/browser/login-gate.mjs` 的文件头里
   * （为什么必须重检、为什么重检前要重开页面、为什么不能放进循环、
   * 超时为什么是 12 小时、为什么失败结果要写在等待之前）。
   * 这里只负责把它接上：`①d` 的「不成立」出口进这一段，
   * 这一段重检**通过**才回到主流程，没通过就由这一段自己的「中断」节点收尾。 */
  const rescue = addLoginRescue(Builder, b, {
    prefix: '①',
    startLetter: 'g',
    platform: '抖音',
    session: '抖音',
    openUrl: 'https://compass.jinritemai.com/',
    checkCode: login.checkDy,
    failCode: login.failResult('douyin'),
    outFile,
    x: 1120,
    y: Y - 60,
  })

  /* ⓪ → ① → ①b → ①c → ①d ┬ true  → ② 循环A（照旧）
   *                        └ false → ①g 写结果 → ①h 写盘 → ①i 提醒 → ①j 等人
   *                                  → ①k 重开页 → ①l 重检 → ①m
   *                                    ├ true  → ② 循环A（人已登录，回到主流程）
   *                                    └ false → ①n 中断（结果已写好） */
  b.link(start, modules)
  b.link(modules, loginOpen)
  b.link(loginOpen, loginCheck)
  b.link(loginCheck, loginIf)
  b.link(loginIf, rescue.failDoc, 'false')
  /* ⚠️ **段内的连线由 `addLoginRescue` 自己连好**（`failDoc → failWrite → notify → wait
   * → reopen → recheck → ask`，以及 `ask → abort` 那条 false）。这里**不要再连一遍**。
   *
   * ## 那五行重复边已于 2026-10-27 删掉（用户 m00008）
   *
   * 原来这里重连了 `notify→wait`、`wait→reopen`、`reopen→recheck`、`recheck→ask`、
   * `ask→abort('false')` 五行，与 `addLoginRescue` 段内连的**完全相同**，
   * 于是在存档里留下 5 组重复边（`n8>n9`、`n9>n10`、`n10>n11`、`n11>n12`、`n12>n13`）。
   *
   * 当时（2026-10-23）判「无害、保留不动」，依据是 `topo.ts` 的 `topoSort` 按
   * `source\u0000target` 去重。**那条只覆盖拓扑排序**：`run.ts:1506` 的
   * `inEdges = edges.filter(e => e.target === id && edgeAlive(e, ctx))` 是按**原始
   * 边表**算的，去重管不到那里 —— 重复边会让同一个上游在 `upstreamOf` 里出现两次。
   * 引擎现在没有因此出错，但那是运气，不是设计（千川那份的注释里也写过这句）。
   *
   * 清掉之后连线数 38 → 33，执行语义不变（少的是纯重复）。
   *
   * ⚠️ **新写的照千川那份**：只连 `loginIf → rescue.failDoc('false')` 与
   * `rescue.ask → 循环(true)` 这两条进出线。 */

  /* ── ② 循环A（模块）───────────────────────────────────────────────
   *
   * ⚠️ 循环体里的节点要挂 `parentId = 循环节点 id`（容器归属）。
   * 循环的 `items` 是「选节点 + 选字段」：选 ① 模块清单 的 `modules` 字段。 */

  const loopA = b.add('flow.loop', {
    mode: 'items',
    /* 「遍历哪个数据」= ① 输出的 modules 字段（照 Dify 的 nodeField）。 */
    items: { nodeId: modules, field: 'modules' },
    result: null,
    count: 5,
    maxIters: 100,
    concurrency: 1,
  }, '② 循环 A：逐模块', 400, Y, 'stop',
    '逐模块采集。每个模块一轮。循环体：打开该模块页 → 读已结算日 R → 列目录得 L。')

  /* 循环体（都挂 parentId = loopA）。位置放在循环框内（右侧一列）。 */
  const openMod = b.add('browser.act', {
    action: 'goto', session: '抖音', launcher: 'cdp', exePath: '',
    /* ⚠️ 变量替换：`{{item.url}}` —— 循环变量经 scope.fields 注入。 */
    url: '{{item.url}}',
    waitUntil: 'domcontentloaded', timeout: 60000,
  }, '②a 打开该模块页', 760, Y - 160, 'stop',
    'URL 用 `{{item.url}}` —— 循环变量经变量替换注入（不是塞在上游数据里）。')

  const waitMod = b.add('flow.delay', { ms: 4000, random: false },
    '②b 等页面渲染', 1120, Y - 160, 'continue',
    '等 4 秒。源码这里是 waitForSelector(picker, 20s) + 2s —— 我们的等法不一样，见「②c」的备注。')

  /* ②b1 分岔：搜索模块走「点 tab → 等 2 秒」，其余 6 个直接去读 R。
   *
   * ## 为什么要改成 IF（用户原话，2026-10-20）
   *
   * > 「将搜索部分还是改成 if，应该用 if 的地方就用 if。」
   *
   * 原来这一下对所有 7 个模块都跑，靠脚本「找不到 tab 就 `clicked:false`」空转。
   * 两个问题：
   *   1. 其余 6 个模块每轮白跑一个节点 + 白等 2 秒
   *      （补 30 天 × 6 个模块 ≈ 白等 6 分钟）；
   *   2. 「这个模块要不要点 tab」本来是流程结构上的差异，
   *      用脚本内部兜底表达，等于把它藏起来了 —— 看画布看不出来。
   *
   * ## ⚠️ 层级：`item.shopTab`，不是 `item.module.shopTab`
   *
   * 循环 A 的 `items` 指向 ① 的 `modules` 字段，而那个字段是模块对象本身的数组
   * （`{ name, url, shopTab, … }`）。所以循环 A 的 `item` 就是模块对象。
   *
   * 而循环 B 的 `item` 是 `{ module, date }` 包装（②e 塞进去的），
   * 所以那里才写 `item.module.btn`（见下面 ④b）。
   * 两个循环的 item 形状不同，别互相照抄 —— 抄错了不报错，
   * 只是条件永远取到 undefined、永远走 false：
   * 搜索模块从此不再点 tab，症状会变成「搜索模块读不到日期控件」，
   * 与这次要修的病一模一样。
   *
   * ## 判据为什么是「等于 true」而不是「不为空」
   *
   * 模块表里只有搜索那一条有 `shopTab: true`，其余模块压根没这个字段（undefined）。
   * 用「不为空」也能区分，但那是在拿「有没有这个键」当业务条件 ——
   * 万一哪天给别的模块加个 `shopTab: false` 显式声明，它就全误判了。
   * 用「等于 true（真假）」语义最直白：声明的就是「要不要」。 */
  const shopTabIf = b.add('flow.if', {
    conditions: [{
      left: { kind: 'loop', name: 'item.shopTab' },
      op: 'is',
      value: 'true',
      valueType: 'boolean',
    }],
    logic: 'and',
    expr: '',
  }, '②b1 这个模块要先点「本店搜索词」吗？', 1260, Y - 160, 'stop',
    '左边选循环变量 item.shopTab（循环 A 的 item 就是模块对象本身，不是 item.module）。'
    + '只有「搜索」模块是 true；其余 6 个模块没有这个字段 = undefined，走 false 那一支。')

  /* ②b2 点「本店搜索词」tab —— 只在搜索模块那一支上。 */
  const shopTab = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: code.shopTab, timeout: 60000,
  }, '②b2 点「本店搜索词」tab（仅搜索模块）', 1420, Y - 240, 'stop',
    '搜索页默认不在「本店搜索词」那一栏，要先点一下日期控件才出来（照源码 douyin-ui.ts:538-545）。'
    + '只在 item.shopTab 为 true 时走这一步。'
    + '脚本里「找不到 tab 就返回 clicked:false」是保留的防御：万一页面改版把 tab 名字改了，'
    + '这一步不该让整轮失败（但那时该照新名字改选择器，不能一直靠兜底）。')

  const readR = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: code.readR, timeout: 120000,
  }, '②c 读已结算日 R', 1480, Y - 160, 'stop',
    '页面内：找 picker 的 fiber、存 dayjs 到 window.__picker（循环 B 设日期要用），并读 R。读不到就明确报错，不猜日期。自己会等控件最多 12 秒（源码是 waitForSelector 20 秒，我们改成就地轮询再找一次）。')

  const listMod = b.add('code.shell', {
    /* ⚠️ 命令里不加引号（cmd /c 会剥掉开头的引号，实测踩过）。 */
    command: 'node ' + fwd(shellDir) + '/dy-list-one.mjs ' + fwd(shellDir) + ' ' + fwd(dataRoot) + ' {{item.folder}}',
    cwd: shellDir, shell: 'cmd', timeout: 120000,
  }, '②d 列该模块目录（得 L）', 1840, Y - 160, 'stop',
    '扫该模块文件夹里已有的文件名，用来算「现有最大日期 L」。')

  /* ②e：算 L，并算出**这个模块**要补哪些日期（`dates`）。
   *
   * ⚠️ 这一步就是「前后脱节」被修好的地方：日期在**模块这一轮内部**算出来，
   * 紧接着就交给嵌套的循环 B 消费。原先它只算 L，再由顶层的「展平」步骤
   * 把 7 个模块的日期汇总成一张表 —— 那张表让「查」与「下」隔开了整段流程。 */
  const moduleDates = b.add('code.js', { code: code.moduleDates, timeout: 30000 },
    '②e 算「这个模块补哪几天」', 2200, Y - 160, 'stop',
    '现有最大日期 L（扫文件名里的 YYYYMMDD 取最大）+ 读到的 R → 本模块要补的日期 dates。'
    + 'dates 为空时内层循环跑 0 轮（不是报错）。')

  /* 循环体内串联。
   *
   * ⚠️ **`②e` 要两条边**（2026-10-14 实测踩到）：它同时需要
   *   · `②c 读已结算日 R` 的输出（R）
   *   · `②d 列该模块目录` 的输出（文件名清单 → 算 L）
   * 我第一版把它们串成一条线（`读R → 列目录 → 算L`），于是 `算L` **只拿到目录**、
   * 拿不到 R → 报「拿不到已结算日」。
   * 引擎只给**直接上游**，所以两条边都得接。 */
  /* ★ **③b 点完 tab 之后等一下**（2026-10-20 补，用户报「搜索模块读不到日期控件」）。
   *
   * ## 为什么必须有这一步
   *
   * 源码 `douyin-ui.ts:538-547` 的顺序是：
   * ```js
   * await page.evaluate(() => { ...点「本店搜索词」... })
   * await page.waitForTimeout(2000)      // ← 就是这一步
   * const setup = await setupPicker(page, mod.picker)
   * ```
   *
   * 我们原来把「点 tab」与「读日期控件」直接连起来（`shopTab → readR`），
   * 中间**一秒都不等**。而搜索模块的日期控件**是切了 tab 才渲染出来的**，
   * 点完立刻找当然找不到 —— 实测症状就是
   * 「找不到日期控件（.ecom-dorami-date-picker-wrapper）—— 等了 12 秒页面还没加载完」。
   *
   * ⚠️ 为什么**只有搜索模块**坏：其余 6 个模块页面一打开就有日期控件，
   * 这一步对它们是空转（`DY_SHOP_TAB` 找不到 tab 会 `clicked: false` 直接返回），
   * 所以等 2 秒也不影响它们。
   *
   * ⚠️ 2 秒照源码，不自己加长。
   *
   * ## ⚠️ 2026-10-20 起它只在搜索那一支上
   *
   * 与 ②b2 一起收进了 IF 的 true 分支 —— 其余 6 个模块不再白等这 2 秒
   * （补 30 天 × 6 个模块能省约 6 分钟）。 */
  const afterTab = b.add('flow.delay', { ms: 2000, random: false },
    '②b3 等 tab 切换后渲染（照源码 waitForTimeout(2000)）', 1600, Y - 240, 'continue',
    '点完「本店搜索词」之后要等一下，日期控件才渲染出来（照源码 douyin-ui.ts:544）。'
    + '只在搜索模块那一支上 —— 其余 6 个模块不点 tab，也就不必等。')

  /* ②b1 分岔：搜索走「点 tab → 等 2 秒」，其余直接去读 R。
   *
   *       ②b 等页面渲染
   *          └→ ②b1 item.shopTab 等于 true？
   *               ├ true  → ②b2 点 tab → ②b3 等 2 秒 → ②c 读 R
   *               └ false → ②c 读 R
   *
   * ⚠️ 两条出口都要接到 ②c：false 那一支不接就会让其余 6 个模块
   * 在 IF 之后断链（表现为「②c 没跑」，而不是报错）。 */
  b.link(openMod, waitMod)
  b.link(waitMod, shopTabIf)
  b.link(shopTabIf, shopTab, 'true')
  b.link(shopTab, afterTab)
  b.link(afterTab, readR)
  b.link(shopTabIf, readR, 'false')
  b.link(readR, listMod)
  b.link(listMod, moduleDates)
  /* ★ 第二条边：R 也直接连到「算日期」。 */
  b.link(readR, moduleDates)

  /* ── ③ 循环 B（逐日期）—— **嵌在循环 A 里面** ────────────────────
   *
   * ## 为什么必须嵌进去（本次改动的全部理由）
   *
   * 循环 B 的循环体里**没有 goto**：它用的是「当前打开的页面」。
   * 两个循环并列时，那个页面是循环 A 最后一次留下的 —— 于是 7 个模块的日期
   * 在一张表里排队，下载时全靠「页面残留」猜，任一模块失败就串到别人页面上。
   * 嵌进来之后，循环 B 一定在**外层那一轮之内**跑：页面是 ②a 刚打开的那一个。
   *
   * ## 变量怎么取（嵌套后有两层）
   *
   *   · `{{item.date}}` —— 内层本轮（这一天）
   *   · `{{item.module.btn}}` —— 内层每一项自带 `module`（②e 塞进去的），
   *     所以**不必**写 `{{outer.item}}`。这是有意为之：内层的每个日期项
   *     都完整知道自己属于哪个模块，条件判断在界面上能直接选到。
   *
   * ## ⚠️ 结果怎么回传
   *
   * 内层循环的输出会交到**外层那一轮的结果**里（调度器负责，见 `run.ts` 的
   * 「三处都写」）。所以 ⑤ 汇总拿到的就是「模块 → 它每天的结果」，
   * 不需要任何额外的合并节点。 */
  const loopB = b.add('flow.loop', {
    mode: 'items',
    /* 「遍历哪个数据」= ②e 输出的 dates 字段（就在外层这一轮里）。 */
    items: { nodeId: moduleDates, field: 'dates' },
    result: null,
    count: 5,
    maxIters: 500,
    concurrency: 1,
    /* ⚠️ 连续失败护栏开在**内层**（照源码：连续 2 天失败就停这个模块）。
     * 放外层没有意义 —— 外层一轮是一个模块，一个模块没有「连续」可言。 */
    maxConsecutiveFailures: 2,
  }, '③ 循环 B：逐日期（在循环 A 里）', 2560, Y - 160, 'stop',
    '内层逐日采集，嵌在循环 A 里：页面用外层刚打开的那个，不会串到别的模块。'
    + '每一项是一天（自带 module）。循环体：设日期 → 判两步还是一步 → 点下载落盘 → 拼名 → 本轮结果。'
    + '连续 2 天失败会自动停这个模块（照源码护栏，不算报错）。')

  /* ★ 这一行是整个「两层嵌套」的落点：外层循环体的成员是
   *   ①~⑥ 那六个步骤 **加上循环 B 本身**。
   *
   * ⚠️ 千万别写成只 `setParent([loopB], loopA)` —— 那样外层体只剩循环B 一个节点，
   * 循环 A 会「跑 1 轮、体内只有一个内层循环」，而那六个步骤会掉回顶层、
   * 在循环外面各跑一次（症状是「只跑了第 1 个模块就结束」，且不报错）。 */
  b.setParent([openMod, waitMod, shopTabIf, shopTab, afterTab, readR, listMod, moduleDates, loopB], loopA)

  /* ★ **①d 的 true 出口 → 循环A**（2026-10-20 改）。
   *
   * 原来是 `b.link(modules, loopA)`（模块清单直接连循环）。加登录检查之后
   * 中间插了「打开首页 → 读登录 → IF」三步，所以这里改成从 IF 的
   * true 出口进去：只有「已登录」才跑循环。
   *
   * ⚠️ 必须显式写 `'true'`：`flow.if` 有两个出口，不写 handle 那条边
   * 会被 `edgeIsLive(undefined, ['false'])` 判成活的 → 未登录时循环照跑。
   * 那正是「加了检查等于没加」。 */
  b.link(loginIf, loopA, 'true')
  /* ★ 重检通过也回到循环 A（2026-10-22）：人是重新登录之后才走到这里的，
   * 与「一开始就登录了」应当完全同一条路 —— 否则「未登录→人处理完」会变成
   * 一条断头路（流程跑完什么都没采）。 */
  b.link(rescue.ask, loopA, 'true')

  /* ③ 也挂在外层循环里 —— 去掉这一行（把 loopB 留在顶层）＝ 退回到「前后脱节」的老结构。 */

  const setDate = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: code.setDate, timeout: 120000,
  }, '④a 设日期', 2920, Y - 320, 'stop',
    '页面内设日期（照源码：dayjs 链构造当天 0:00~23:59:59.999，调 fiber 的 onChange）。日期来自 `{{item.date}}`。')

  /* ④b 条件判断：这个模块要两步点击吗？
   *
   * ⚠️ 条件左边选的是**循环变量** `item.module.btn`（不是某个节点的字段）——
   * 所以它前面**不需要**一个专门整理数据的节点（用户 2026-10-19 明确要求
   * 「这个判断应该交给 IF 这个节点」）。
   * 右边的值 `dropdown` 就是模块表里那三个取值之一（另两个是 first / last）。 */
  const stepIf = b.add('flow.if', {
    conditions: [{
      left: { kind: 'loop', name: 'item.module.btn' },
      op: 'is',
      value: 'dropdown',
      valueType: 'text',
    }],
    logic: 'and',
    expr: '',
  }, '④b 这个模块要两步点击吗？', 3280, Y - 320, 'stop',
    '左边选循环变量 item.module.btn，等于 dropdown 走「两步点击」那条路，其余走「一步点击」。'
    + '模块表里 btn 只有三个取值：dropdown（交易 / 商品列表）、first、last。')

  /* ⚠️ 两个分支都是**代码节点**（`browser.act` 的 eval）——理由见文件头那段
   * 「为什么 ④b1 / ④b2 两个分支都是代码节点」：
   * `browser.download` 定不出「带 8 位日期」的文件名，会让下游入库取不到日期。
   *
   * 两段共用同一份公共脚本（`composeDownload`），**只有点击那几行不同** ——
   * 所以 5 个非 dropdown 模块的点击与落盘与改造前**逐字一致**。 */
  const dlDropdown = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: code.downloadDropdown(fwd(dataRoot)), timeout: 180000,
  }, '④b1 两步点击 + 落盘（dropdown）', 3640, Y - 400, 'continue',
    '交易 / 商品列表专用：先点「下载」出菜单、等 1.5 秒、再点「下载当前明细」。'
    + '两下必须在同一个节点里 —— 拆成两个节点时第二个点的时候下拉已经收起（实测）。')

  const dlSingle = b.add('browser.act', {
    action: 'eval', session: '抖音', launcher: 'cdp', exePath: '',
    code: code.downloadSingle(fwd(dataRoot)), timeout: 180000,
  }, '④b2 一次点击 + 落盘（其余 5 个）', 3640, Y - 240, 'continue',
    '其余 5 个模块（btn 是 first / last）：点一次「下载明细」就落盘。'
    + '取第一个还是最后一个按 btn 决定（照源码 douyin-ui.ts:163 的三元）。'
    + '这段的点击与落盘与改造前逐字一致 —— 那 5 个模块的行为不变。')

  const nameIt = b.add('code.js', { code: code.filename, timeout: 30000 },
    '④c 拼文件名', 4000, Y - 320, 'stop',
    '照源码规则拼文件名：`{店铺}-{YYYYMMDD}-{建议名}{后缀}`，非法字符替成 _。')

  const roundGuard = b.add('code.js', { code: code.roundGuard, timeout: 30000 },
    '④d 本轮结果（含风控立即终止）', 4360, Y - 320, 'stop',
    '记本轮成败。疑似验证页立即抛错（照源码 exit 2，绝不重试）。')

  /* ★ **反爬间隔：每个日期间随机等一轮**（照源码 `douyin-ui.ts:594`）。
   *
   * ## 为什么这条不能省（2026-10-20 用户报「下到一半失败」后补的）
   *
   * 源码里那行是：
   * ```js
   * if (i < dates.length - 1) { await sleep(consecutiveFails > 0 ? rand(30000, 60000) : rand(8000, 15000)) }
   * if ((i + 1) % 5 === 0) { await sleep(rand(20000, 40000)) }
   * ```
   *
   * 我们重构时**把它漏了** —— 于是逐日下载是一个接一个连发。
   * 前几个日期抖音还认，后面就被判定成爬虫（表现是「前面几天成功、
   * 某一天开始点不到按钮 / 下载事件不来」，与源码那套「随机长停」正是防这个）。
   *
   * ⚠️ 区间只能近似：`flow.delay` 的 `random` 语义是
   * 「**设定值的一半到一倍半**之间随机」（见它的 paramDefs.hint），
   * 所以取 `ms: 10000` → 实际 5000~15000，覆盖源码的 8000~15000 主体。
   * 想更贴近就把 ms 调大，但别调到「一轮等半分钟」——每天一次会让补 30 天要 15 分钟。
   *
   * ⚠️ **固定间隔本身就是爬虫特征**，所以 `random: true` 不能省。
   *
   * ⚠️ 这条排在**下载之后**（作为循环体最后一环）：第一轮下完才等，
   * 所以不会白等一轮才开始干活。最后一轮也会多等一次 ——
   * 那点时间的代价远小于「被风控」。 */
  const dayPause = b.add('flow.delay', { ms: 10000, random: true },
    '④e 日期间歇（反爬，5~15 秒随机）', 4600, Y - 320, 'continue',
    '照源码：每两个日期之间随机停一段（源码是 8~15 秒，这里用 flow.delay 的随机抖动近似成 5~15 秒）。'
    + '固定间隔本身就是爬虫特征，所以随机必须开。')

  b.link(setDate, stepIf)
  /* ★ 两条出口分别接一个下载节点（`true` / `false` 是 flow.if 的两个出口）。 */
  b.link(stepIf, dlDropdown, 'true')
  b.link(stepIf, dlSingle, 'false')
  b.link(dlDropdown, nameIt)
  b.link(dlSingle, nameIt)
  b.link(nameIt, roundGuard)
  /* ④d → ④e：每轮收尾后停一段再进下一轮（反爬，见上面 dayPause 的说明）。 */
  b.link(roundGuard, dayPause)
  /* ★ **两个下载节点的失败策略是 continue**（2026-10-20，照源码）。
   *
   * ## 为什么（用户报「下到一半失败了」时查出来的）
   *
   * 源码里某一天下载失败是 `fail++` 然后 **`continue`** —— 继续下一天：
   * ```js
   * } else { fail++; consecutiveFails++; logErr(...) }
   * ...
   * if (consecutiveFails >= 2) { ...停止该模块... break }
   * ```
   * 也就是说：**单天失败不要紧，连续 2 天才停**。
   *
   * 我们原来是 `stop` —— 任何一天出问题就整条中断，于是用户看到
   * 「前面几天都成功，然后卡在某一天、后面全没跑」。那与源码的意图相反：
   * 采集场景里「一天失败、其余照跑」远比「一天失败、全部作废」有用。
   *
   * ⚠️ 失败仍然**留痕**：`onError: 'continue'` 让下游拿到空值，
   * 而 ④d（`DY_ROUND_GUARD`）会把这一轮记成失败，
   * 层外的 ⑥（`DY_SUMMARY`）再数「连续 2 次失败 → 停这个模块」。
   * 所以「不中断」不等于「不报错、不停」—— 停的判据搬到了汇总那一步（照源码）。
   *
   * ⚠️ **这两个值必须与上面 `b.add(...)` 的 `onError` 参数一致** ——
   * 那里已经写了 `'continue'`，这里不用再改一遍。写在一起只是让「为什么是 continue」
   * 的解释与那个参数挨得近一点。 */

  b.setParent([setDate, stepIf, dlDropdown, dlSingle, nameIt, roundGuard, dayPause], loopB)

  /* ②e → ③（把本模块的日期喂给内层循环的 items 选择器）。 */
  b.link(moduleDates, loopB)

  /* ── ⑤ 汇总 + 连续失败护栏 ──
   *
   * ⚠️ 现在上游是**外层**循环（它的每轮结果里含着内层的全部轮次）。
   * 汇总脚本会递归找「轮次」，所以形状变了它照样认（见 DY_SUMMARY）。 */
  const summary = b.add('code.js', { code: code.summary, timeout: 30000 },
    '⑥ 汇总（连续失败护栏）', 5080, Y, 'stop',
    '总账 + 连续 2 日失败的模块（照源码护栏）。这一步才判「连续」—— 循环体看不到历史。')

  b.link(loopA, summary)

  const write = b.add('sys.fs.write', { path: outFile, mode: 'overwrite', mkdir: true },
    '⑦ 写结果文件', 5440, Y, 'stop',
    '写结果文件（面板读它）。无论成败都写 —— 失败也要看得见。')

  b.link(summary, write, undefined, 'content')

  /* ── ⑧ 结束（**2026-10-25 去掉**）────────────────────────────────
   *
   * 原来这里是一个 `flow.end`：接在「写结果文件」之后，把「汇总」与
   * 「结果文件」声明成这份工作流的产出（用户 m00901 定案「输出=结束节点」）。
   *
   * 用户 2026-10-25 重新决定：**存档里不再有结束节点**。所以节点与那条边都不建了，
   * ⑦ 写结果文件 就是这条链的尾。
   *
   * ⚠️ 去掉的只是**存档里的用法**；节点定义（`src/nodes/flow/end/node.ts`）
   * 原样留在节点库里，别把这两件事混起来。
   *
   * 代价说清楚：这份工作流**不再有对外声明的产出**。要看结果就读 ⑦ 写下的
   * 那份结果文件 —— 面板本来就是读它的，所以这次的损失只落在
   * 「别的流程调它时拿不到返回值」这一处。 */

  /* ★ 说明（用户 2026-10-14 要求显示在列表里）。
   * ⚠️ 说清「两层嵌套」—— 那是这份工作流的结构特点，看名字看不出来。 */
  const doc = b.doc()
  doc.description = '从罗盘逐模块逐日下载表单（7 个模块）：每个模块打开自己的页面 → 查已结算日 → '
    + '在这个模块里逐日设日期点下载 → 再下一个模块（两层嵌套循环）。'
    + '可选参数：modules（跑哪些模块，留空全部）、from / to（日期区间，留空自动推算）'
  return doc
}

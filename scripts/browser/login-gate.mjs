/** 「检测到未登录 → 写失败结果 → 发提醒 → 停在等待点 → 人处理完再重检」这一段。
 *
 * ## 为什么单独一份（不写进各自的 build-*.mjs）
 *
 * 用户 2026-10-22 的原话：
 *   「我感觉需要增加的主要就是登录检测，检测到登录失败后提醒并进入等待点，
 *     然后等待节点触发后，是否有继续执行的按钮？」
 *
 * 两个平台的**判据不同**（抖音看 `/login`、天猫看 `login.htm`），但**这一段结构完全一样**：
 *
 * ```
 * 未登录 → 写失败结果(code.js + sys.fs.write) → 发提醒并停下(flow.alert-wait, manual)
 *        → 重开页面(goto) → 重检(browser.act) → 判断(flow.if)
 *                                            ├ 已登录 → 回到主流程
 *                                            └ 仍未登录 → 中断整次运行
 * ```
 *
 * ⚠️ 2026-10-27 起「发提醒」与「等人」是**一个节点**（`flow.alert-wait`），
 * 原来那两个 `flow.notify` + `flow.wait` 已合并。四模式语义见
 * `src/nodes/flow/alert-wait/node.ts` 的文件头。
 *
 * 写两份必然漂（本项目已有教训：同一件事写两份迟早不一致），所以只写这一处。
 *
 * ## 五个设计判断（都写在这里，改之前先读）
 *
 * ### ① 提醒之后**必须重检**，不能直接往下跑
 *
 * 人点「继续」时不代表他**已经登录**（可能只是把窗口关了，或者点了继续忘了登录）。
 * 不重检就直接往下跑，下游会拿到「空名单 / 空页面」，表现为「今天没有数据」——
 * 那是看着成功、其实什么都没做的失败，最难察觉。重检一次只多一个页面读。
 *
 * ### ② 重检之前**必须先重新打开页面**（这一步不能省）
 *
 * 等待可能长达 12 小时，那个浏览器标签早就没了（关了、浏览器重启过）。
 * 此时直接跑「读登录」的页面脚本：驱动找不到已登记的页面，会**新开一个空白页**，
 * 于是 `location.href` 是 `about:blank` —— 不含 `/login`、不含 `login.htm`，
 * 判据得出「已登录」。
 *
 * 那是最坏的一类错：**没登录却被判成登录了**，下游拿到空数据还当成功。
 * 所以重检前一律先 `goto` 那个平台的页面，让判据落在真实页面上。
 *
 * ### ③ 等待点只能放在**顶层**（不能进循环体、不能进并行框）
 *
 * 引擎有两条硬限制（`run.ts` 的 `runWait` 与 `runParallel` 都会**明确报错**，
 * 不是静默失效）：挂起的现场按「主序切片」恢复，而循环体 / 并行体的成员
 * 不在主序里，切片会落空。
 *
 * 所以这一段只适用于「登录检测本身在顶层」的存档。千川那份的检查在**循环体内**
 * （`取数-千川全域推广` 的 ②c 挂在 ② 循环 A 里），那一段**没有接**这一段 ——
 * 要接得先把检查挪到循环外，那是结构改动，不在本轮范围内。
 *
 * ### ④ 超时给 12 小时
 *
 * `manual` 模式不限时（`timeoutHours: 0`）时，一次没人处理的运行会永远躺在
 * 「等待中」里；扫盘器不会捡它，也不会有人知道。给 12 小时：覆盖一个工作日
 * （白天发现 → 当天处理完），到点仍没人管就按失败结束并记一笔，不留悬案。
 * 上限是 480 小时（20 天），12 小时远在范围内。
 *
 * ### ⑤ 失败结果要在**等待之前**写，重检失败只接一个「中断」节点
 *
 * ## 为什么不是「等人 → 重检 → 写结果 → 中断」的四步链
 *
 * 因为**引擎的循环节点不检查分支可达性**（`runLoop` 里没有 `hasLiveInput` 那道闸门，
 * 而普通节点、子工作流、等待、并行都有）。实测：挂在「未走分支」上的循环
 * **照样会被执行**，而且会真的打开浏览器页面去采集。
 *
 * 主序是按**拓扑层**排的：挂起现场从等待点之后切片继续跑，层小的先跑。
 * 天猫/抖音的采集循环挂在「已登录」那条路上，它的层由**最浅的那条入边**决定；
 * 若「仍未登录」那条链比它长，循环就会**插在链中间**先跑起来 —— 那正是
 * 「未登录却开始采集」。把失败结果写盘挪到等待之前，就让「仍未登录」
 * 只剩**一个**中断节点，它与循环**同层**，由连线顺序决定先后（本文件的连线里
 * 失败那条排在前），于是循环永远轮不到。
 *
 * ⚠️ 这不是绕开引擎的把戏：中断节点的语义就是「这次运行到此为止」，
 * 结果文件已经写好了，运行历史里也看得见这次失败。
 */

/** 等人重新登录的最长时长（小时）。0 = 不限，见文件头第 ④ 条。 */
export const LOGIN_WAIT_TIMEOUT_HOURS = 12

/**
 * 加「写失败结果 → 提醒 → 等人 → 重开页面 → 重检 → 判断 → 中断」这一串节点。
 *
 * 只负责**这一段内部**的连线；进出一头一尾由调用方接（它才知道主流程在哪）。
 *
 * @param Builder - 生成器的 Builder 类。
 * @param b - 这一份工作流的 Builder 实例。
 * @param opts - 见下。
 * @param opts.prefix - 编号前缀（抖音用 `①`、天猫用 `3`），只影响显示名。
 * @param opts.startLetter - 起始字母（接着前面已有的那几个往下排）。
 * @param opts.platform - 平台显示名（`抖音` / `天猫`）。
 * @param opts.session - 浏览器会话名（与那份里其他浏览器节点一致）。
 * @param opts.openUrl - 重检前要重新打开的页面地址。
 * @param opts.checkCode - 该平台的「读登录」页面内代码（复用同一段判据）。
 * @param opts.failCode - 生成失败结果的 `code.js` 正文（各平台的文案不同）。
 * @param opts.outFile - 结果文件路径（与正常工作流写的是同一份）。
 * @param opts.x - 起点 x。
 * @param opts.y - 起点 y。
 * @param opts.gap - 节点间距。
 * @returns 这一段各节点的 id，由调用方接进出线。
 */
export function addLoginRescue(Builder, b, opts) {
  const { prefix, startLetter, platform, session, openUrl, checkCode, failCode, outFile, x, y, gap = 260 } = opts
  /** 编号（`①g`… 或 `3f`…）。 */
  const num = (i) => prefix + String.fromCharCode(startLetter.charCodeAt(0) + i)

  /* ① 先把「未登录」写成结果文件（与正常工作流同一份、同一个形状）。
   * 放在等待之前 —— 理由见文件头第 ⑤ 条：这样「仍未登录」那条路只剩一个节点。 */
  const failDoc = b.add('code.js', { code: failCode, timeout: 30000 },
    num(0) + ' 未登录：生成失败结果（' + platform + '）', x, y, 'stop',
    '把未登录的原因写成结果对象，交给下一步写盘。')

  const failWrite = b.add('sys.fs.write', { path: outFile, mode: 'overwrite', mkdir: true },
    num(1) + ' 未登录：写结果文件（' + platform + '）', x + gap, y, 'stop',
    '与正常工作流写同一份文件、同一个形状，只是 ok:false 且带原因。')

  /* ② 发提醒 + 停下等人（2026-10-27 合并成一个节点 `flow.alert-wait`）。
   *
   * ## 原来是两个节点
   *
   * `flow.notify`（`num(2)`）→ `flow.wait`（`num(3)`，`manual` + 12 小时超时）。
   * 合成一个的理由与四模式语义见 `src/nodes/flow/alert-wait/node.ts` 的文件头；
   * 对这一段最要紧的一条：**通知必须先发出去再挂起**，否则人根本不知道要去点继续。
   * 新节点内部就是这个顺序（引擎的 `runWait` 用 `beforePause` 钩子发）。
   *
   * ## 为什么编号跳号（没有 `num(3)`）
   *
   * 合并后 `num(2)` 这一个节点同时占了原来两个位置，`num(3)` 就空了出来。
   * 后面照原样从 `num(4)` 起，**编号只空这一个**（跳两个会让人以为是漏了节点）。
   * 坐标同理：新节点占 `num(2)` 的 x，`reopen` 仍是 `num(4)` 的 x，
   * 中间留一格空档 —— 挪 `reopen` 及之后的所有节点会撞上**不属于这一段**的节点
   * （千川的 `n20` / `n21` / `n30`、抖音的 `n29` / `n30`），而这一段的边界是不碰别人的位置。
   *
   * ## 名称与参数
   *
   * 级别「严重」：登录过期会让人白等一整轮，属于要马上处理的事。
   * 实例名里保留「未登录」三个字 —— `tests/login-rescue.mjs` 判「登录了吗？」
   * 的 false 出口接到了哪一步，判据就是那个节点的 label 含「未登录」。
   *
   * `mode` / `timeoutHours` **显式写死，不靠节点默认值**：默认值是 `mode: 'none'`
   * （只通知、不挂起），而这一段必须停下等人 —— 依赖默认值的话，将来默认值一改
   * 这边就静默变成「不等人了」。
   *
   * `onError: 'stop'` 同样显式写（2026-10-27 用户定乙）。节点定义默认是
   * `continueErrorOutput`（「走失败分支」），而这一段要的是**超时 = 整次运行按失败结束**，
   * 与换节点之前的老 `flow.wait` 行为逐字一致。取默认值的后果：超时后
   * `aborted` 为假、整次运行算跑完，然后继续去 reopen / recheck —— 那是在碰运气
   * （12 小时后页面早刷新、cookie 可能过期），而且失败原因不再直接说「人没处理」。
   * 填 `stop` 之后引擎不派生失败出口（`specs.ts` 的 `withErrorOutput` 只在
   * `continueErrorOutput` 时才加那一格），所以画布上这个节点没有闲置的红出口。 */
  const alertWait = b.add('flow.alert-wait', {
    content: platform + '账号登录已过期，请在浏览器里重新登录，然后在运行记录里点「继续」。'
      + '未登录原因：{{result.reason}}',
    level: 'severe',
    system: true,
    mode: 'manual',
    timeoutHours: LOGIN_WAIT_TIMEOUT_HOURS,
  }, num(2) + ' 未登录：发提醒并等人重新登录（' + platform + '）', x + gap * 2, y, 'stop',
    '按提醒档位发出一条系统通知，然后把运行现场存盘并停下。'
    + '在运行记录里点「继续」才往下走；' + String(LOGIN_WAIT_TIMEOUT_HOURS)
    + ' 小时内没人处理则整次运行按失败结束。')

  /* ④ 重开页面。等待期间那个标签很可能已经没了，不重开就会读到空白页
   * （判据会误判成「已登录」，理由见文件头第 ② 条）。 */
  const reopen = b.add('browser.act', {
    action: 'goto', session, launcher: 'cdp', exePath: '',
    url: openUrl, waitUntil: 'domcontentloaded', timeout: 60000,
  }, num(4) + ' 重新打开页面（' + platform + '）', x + gap * 4, y, 'stop',
    '等待期间那个浏览器标签可能已经关闭，重检前先重新打开，否则会读到空白页。')

  /* ⑤ 重检：人点了「继续」不等于已经登录，所以再读一次（复用同一段判据）。 */
  const recheck = b.add('browser.act', {
    action: 'eval', session, launcher: 'cdp', exePath: '',
    code: checkCode, timeout: 60000,
  }, num(5) + ' 重新确认登录状态（' + platform + '）', x + gap * 5, y, 'stop',
    '复用与前面同一段判据再读一次。人点「继续」不代表已经登录，不重检会让下游拿到空数据。')

  const ask = b.add('flow.if', {
    conditions: [{
      left: { kind: 'field', nodeId: recheck, field: 'result.loggedIn' },
      op: 'is', value: 'true', valueType: 'boolean',
    }],
    logic: 'and',
    expr: '',
  }, num(6) + ' 重新确认登录结果（' + platform + '）', x + gap * 6, y, 'stop',
    '已登录 → 回到主流程继续执行；仍未登录 → 中断本次运行，不留假成功。')

  /* ⑥ 仍未登录 → 中断整次运行。
   *
   * 必须**主动失败**：否则主序会把后面的采集循环启动起来（引擎不拦挂在未走分支
   * 上的循环，见文件头第 ⑤ 条）。结果文件上一步已经写好，这里只负责「到此为止」。 */
  const abort = b.add('code.js', {
    code: `/* 走到这里 = 重检之后仍然未登录。失败结果已经写好，这里主动中断整次运行 ——
 * 否则后面的采集节点还会被启动（引擎不拦挂在未走分支上的循环）。 */
throw new Error('${platform}账号仍未登录，本次运行到此结束（结果文件已写入）')`,
    timeout: 30000,
  }, num(7) + ' 仍未登录：中断本次运行（' + platform + '）', x + gap * 6, y + 180, 'stop',
    '让这一步失败以中断整条流程。不做的话后面的采集循环仍会被启动。')

  /* ── 段内连线（7 条 → 6 条：两个节点合成一个）─────────────────────────
   *
   * 原来是 `failWrite → notify → wait → reopen`，现在是 `failWrite → alertWait → reopen`。
   * 合并掉的两条正是「通知与等待分家」那一段。 */
  b.link(failDoc, failWrite)
  b.link(failWrite, alertWait)
  b.link(alertWait, reopen)
  b.link(reopen, recheck)
  b.link(recheck, ask)
  /* ⚠️ 失败这条边**必须先加**：它与「成功 → 循环」那条同层，
   * 主序按连线顺序入队。先加失败边，中断就跑在循环前面。 */
  b.link(ask, abort, 'false')
  /* 返回值：`notify` / `wait` 两个键没有了（三个 build 只用 failDoc / ask / abort，
   * 全仓 grep 确认过）。`alertWait` 一并交出去，便于调用方或测试按需取用。 */
  return { failDoc, failWrite, alertWait, reopen, recheck, ask, abort }
}

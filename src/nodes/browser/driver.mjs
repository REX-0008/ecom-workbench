/** 浏览器驱动（**跑在子进程里**，不放宿主半进程内）。
 *
 * ## 为什么必须是子进程
 *
 * 依据用户现有脚本里的实战注释（`douyin-ui.ts`）：
 * > 「显式退出：playwright 的 CDP 连接（WebSocket）会挂住事件循环，
 * >   成功路径隐式退出会卡住进程 → BAT 链不执行」
 *
 * 也就是说：**连上 CDP 之后这个进程就不会自己退出了**。若把它放进宿主半进程，
 * 后果是宿主半卡住、整个 dsh 都不响应 —— 那种故障极难定位。
 * 放子进程里，退出由**进程边界**保证，不污染宿主。
 *
 * ## 用法（约定）
 *
 * 宿主半把一条 JSON 指令写进 argv[2]（或 stdin），本脚本执行完把结果
 * 以**一行 JSON** 打到 stdout。约定：
 *
 * ```
 * 入参: { action, session, params, upstream }
 * 出参: { ok: true, output } | { ok: false, error }
 * ```
 *
 * ⚠️ **结果只走 stdout 的最后一行的 JSON**，其余输出（playwright 的日志等）
 * 原样透传 —— 宿主半解析时取最后一行有效 JSON，不要假设整份 stdout 是 JSON。
 *
 * ## 会话与 CDP
 *
 * 我们连的是**用户已经在跑的浏览器**（`connectOverCDP`），不是自己启动一个。
 * 依据（`docs/调研-浏览器自动化策略.md`）：登录态是资产，
 * 接管「已登录的真实浏览器进程」比每次新建实例既少触发风控、又天然复用登录态。
 *
 * ⚠️ 本文件**不参与 tsc 检查**（是 `.mjs`，由 node 直接跑）——
 * 它是**运行期脚本**，不是插件源码的一部分。放这里的理由：
 * 它与浏览器节点一一对应，放一起最好找。若将来要类型化，再改 `.ts` + 构建。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ## ★ 端口从哪来（2026-10-14 改造：**不再硬编码 9222**）
 *
 * 用户原话：「我希望 **9222 这个不是默认而是前端可见的手填项目**，**不能是硬编码的**。」
 *
 * 所以端口**只从设置里来**（经 `impl.ts` 落到 `session.port`）。
 *
 * ⚠️ 这里**故意不留任何默认值**：留着 9222 就等于「没填也能跑」，
 * 而那正是用户不要的（他会以为自己在连 A 浏览器，实际连的是 B）。
 * 没填就**明确报错并说清怎么办** —— 见下面 `openBrowser` 里的那段。
 *
 * @param {object} session - 第二层配置：`{ name, launcher, exePath, port }`。
 * @returns {Promise<{ browser: object, kind: string, owned: boolean }>}
 *   `owned: true` 表示**是我们启动的**（那退出时该关掉它，否则会留下野进程）。
 */
async function openBrowser(session) {
  const kind = session?.launcher === 'headed' || session?.launcher === 'headless'
    ? session.launcher
    : 'cdp'
  /* ⚠️ 动态 import：本脚本按需加载 playwright，
   * 这样控制台（普通浏览器内核）里跑不到这条路，也不会因为模块加载失败而整份报错。 */
  const { chromium } = await import('playwright')

  if (kind === 'cdp') {
    /* ⚠️ **端口是手填的，没填就停在这里**（不猜、不退回 9222）。
     *
     * 为什么这么严：用户 2026-10-14 明确「不能是硬编码的」。
     * 若这里悄悄退回 9222，表现会是「界面说没填端口，但它照样连上了」
     * —— 用户永远发现不了自己连错了哪个浏览器。 */
    const raw = session?.port
    const port = raw === undefined || raw === null || String(raw).trim() === ''
      ? null
      : Number(String(raw).trim())
    if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('这一条要「连一个已经开着的浏览器」，但没有填调试端口。\n'
        + '怎么办：打开节点的「浏览器」一节 → 来源选「已开的调试端口（CDP）」→'
        + ' 在「端口」里填上那个浏览器启动时带的调试端口（或点旁边的「检测」让它自己找出来）；'
        + '也可以在「工作台设置 → 浏览器」里填一个全局默认端口，之后各标签就不用逐个填了。')
    }
    try {
      const browser = await chromium.connectOverCDP('http://127.0.0.1:' + String(port), { timeout: 8000 })
      return { browser, kind, owned: false, port }
    } catch (e) {
      /* **明确报错**，不静默 ——「什么都没发生」是用户最怕的。
       * 提示里带上端口，因为最常见的原因就是那个浏览器没开、或没带调试端口。 */
      throw new Error('连不上浏览器的调试端口 :' + String(port) + '（浏览器没开？或没带调试端口？）：'
        + (e && e.message ? e.message : String(e)))
    }
  }

  /* 启动一个新的。`executablePath` 只在明确给了时才传 ——
   * 不给就让 playwright 用自带的（实测本机有 chromium-1208/1234）。 */
  const exePath = typeof session?.exePath === 'string' && session.exePath.trim() !== ''
    ? session.exePath.trim()
    : undefined
  const opts = { headless: kind === 'headless', args: [] }
  if (exePath !== undefined) {
    if (!existsSync(exePath)) {
      throw new Error('设置里指定的浏览器不存在：' + exePath
        + '\n（去「设置 → 浏览器」重新检测，或清空那一项的路径让它用 Playwright 自带的）')
    }
    opts.executablePath = exePath
  }
  try {
    const browser = await chromium.launch(opts)
    return { browser, kind, owned: true, port: null }
  } catch (e) {
    /* 启动失败最常见的两种原因，直接说清怎么办（比抛 playwright 的英文堆栈有用）。 */
    throw new Error('启动浏览器失败（方式：' + kind + '）：' + (e && e.message ? e.message : String(e))
      + '\n（若提示找不到浏览器，去「设置 → 浏览器」点「重新检测」；'
      + '或把该标签的方式改成「连接已有（CDP）」以复用你已登录的浏览器）')
  }
}

/* ── 会话登记表：让**多个节点**复用同一个页面 ─────────────────────────
 *
 * ## 为什么必须有它（这是浏览器层最关键的机制）
 *
 * 工作流的每个节点都是**独立的子进程**（跑完就退出）。所以：
 *
 * ```
 * 节点1「打开页面」→ 开窗口、打开网址 → 进程退出
 * 节点2「点击」    → 新的进程，它怎么知道节点1开的那个窗口在哪？
 * ```
 *
 * 没有登记表的话，节点2只能自己再开一个新窗口（空白页），于是「点击」点了个空 ——
 * 表现就是「工作流跑到第二个浏览器节点就什么都没发生」。
 *
 * ## 做法照用户现有脚本（`自动巡查/src/cdp.ts` 的 `addDataTab` / `findDataPage`）
 *
 * 把「我们自己开的窗口」的 `targetId` 记到一个文件里（按**会话名**分组），
 * 下一个节点读这个文件、用 targetId 把那个页面找回来。这就是「跨进程找回同一个页面」。
 *
 * ## 会话名的作用（用户定的：「同名 = 同一个浏览器」）
 *
 * 登记表按会话名分桶：`{ "默认": [targetId,...], "淘宝": [...] }`。
 * 同一会话名的节点共用一条页面链；不同会话名各走各的。
 *
 * ⚠️ **登记表自愈**：浏览器关掉后 targetId 就失效了，所以每次读的时候
 * 剔掉已不存在的（用户脚本也这么做）。不剔的话会拿着一堆死 id 到处找不到页面。
 */

/** 登记表文件名（放在插件的数据目录里，与工作流存档同处）。 */
const TABS_FILE_NAME = 'browser-tabs.json'

/**
 * 找出数据目录（放登记表用）。
 *
 * 与宿主半 `workflow/store.ts` 的规则一致：`$DSH_HOME/profiles/<profile>/data/ecom-workbench/`。
 * 驱动是独立子进程，读不到 dsh 的 ctx，所以只能按同一套约定自己算。
 *
 * @returns {string} 目录绝对路径。
 */
function dataDir() {
  const home = process.env.DSH_HOME ?? ''
  const profile = process.env.DSH_PROFILE ?? 'desktop'
  const base = home !== ''
    ? join(home, 'profiles', profile, 'data', 'ecom-workbench')
    /* 没有 DSH_HOME 时退回用户主目录（保证一定能写，而不是整个跑不了）。 */
    : join(homedir(), '.ecom-workbench')
  const dir = join(base, 'browser')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读登记表。
 *
 * @returns {{sessions: Record<string, Array<{targetId: string, url: string, at: string}>>}} 登记表。
 */
function readTabs() {
  const p = join(dataDir(), TABS_FILE_NAME)
  if (!existsSync(p)) return { sessions: {} }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j !== null && typeof j === 'object' && j.sessions !== null && typeof j.sessions === 'object') return j
    return { sessions: {} }
  } catch {
    /* 文件坏了就当空的 —— 大不了重开一个窗口，不该因此整个工作流跑不动。 */
    return { sessions: {} }
  }
}

/**
 * 写登记表。
 *
 * @param {object} table - 登记表。
 */
function writeTabs(table) {
  const p = join(dataDir(), TABS_FILE_NAME)
  table.updatedAt = new Date().toISOString()
  writeFileSync(p, JSON.stringify(table, null, 2), 'utf8')
}

/**
 * 把**我们自己开的**页面登记到某个会话名下。
 *
 * @param {string} session - 会话名。
 * @param {string} targetId - 页面 id。
 * @param {string} url - 当前网址（用于「同一个页面」的匹配）。
 */
function addTab(session, targetId, url) {
  const t = readTabs()
  const list = Array.isArray(t.sessions[session]) ? t.sessions[session] : []
  /* 同一个 targetId 只留一条（避免同一页面反复登记把文件撑大）。 */
  const kept = list.filter(x => x.targetId !== targetId)
  kept.push({ targetId, url, at: new Date().toISOString() })
  t.sessions[session] = kept
  writeTabs(t)
}

/**
 * 在浏览器里找一个仍然存活的页面（按 targetId）。
 *
 * 同时**自愈登记表**：剔除已经不存在（浏览器关了那个窗口）的 id。
 *
 * @param {object} browser - playwright Browser。
 * @param {string} session - 会话名。
 * @returns {Promise<{page: object, targetId: string, url: string} | null>} 找到的页面，或 null。
 */
async function findSessionPage(browser, session) {
  const t = readTabs()
  const list = Array.isArray(t.sessions[session]) ? t.sessions[session] : []
  if (list.length === 0) return null

  const ctx = browser.contexts()[0]
  if (ctx === undefined) return null

  /* 问浏览器现在还活着哪些 target（这是「存活」的权威来源）。 */
  const cdp = await browser.newBrowserCDPSession()
  let infos = []
  try {
    const r = await cdp.send('Target.getTargets')
    infos = r.targetInfos ?? []
  } catch {
    return null
  } finally {
    await cdp.detach().catch(() => { /* ignore */ })
  }

  /* 自愈：只留浏览器里真的还存在的。 */
  const alive = list.filter(x => infos.some(i => i.targetId === x.targetId))
  if (alive.length !== list.length) {
    const nt = readTabs()
    nt.sessions[session] = alive
    writeTabs(nt)
  }
  if (alive.length === 0) return null

  /* 把 targetId 对回 playwright 的 page 对象（要逐个问，playwright 不给映射）。 */
  const wanted = new Set(alive.map(x => x.targetId))
  for (const page of ctx.pages()) {
    /* 精确取该 page 的 targetId（用户的 `pageTargetId` 就是这个做法）。 */
    let tid = null
    try {
      const s = await ctx.newCDPSession(page)
      const info = await s.send('Target.getTargetInfo')
      tid = info.targetInfo?.targetId ?? null
      await s.detach().catch(() => { /* ignore */ })
    } catch { continue }
    if (tid !== null && wanted.has(tid)) {
      /* 从**浏览器**问当前网址（登记表里那个可能已经过期 —— 页面自己导航过）。 */
      let url = ''
      try { url = page.url() } catch { /* ignore */ }
      return { page, targetId: tid, url }
    }
  }
  return null
}

/**
 * 开一个**自己的独立窗口**，绝不动用户已有的标签页。
 *
 * ## 为什么必须这样（这不是洁癖，是安全）
 *
 * 第一次实现用的是「取第一个标签页」—— 实测时用户的浏览器里开着 **64 个标签**。
 * 在那种环境下「取第一个」意味着：`goto` 会把用户**正在看的页面**导航走，
 * 点击会在用户的页面上乱点。用户明确要求过行动前先确认副作用，这类操作不可接受。
 *
 * ## 做法照用户现有脚本（`自动巡查/src/cdp.ts` 的 `openWindow`）
 *
 * 1. 先记下现有的页面集合；
 * 2. 用 CDP 的 `Target.createTarget({ newWindow: true })` **新建一个独立窗口**
 *    （不新开标签挤进用户当前窗口）；
 * 3. 立刻最小化它 —— 用户不会被打扰（最小化下页面 JS 与请求照常跑）；
 * 4. 靠「前后对比页面集合」认出哪一个是自己刚开的；
 * 5. 用完**只关自己开的那个**（用户的标签一个都不碰）。
 *
 * ⚠️ **失败时不回退到 `newPage`**：那会把页面开进用户当前的活动窗口 ——
 * 正是要避免的事。宁可明确报错。
 *
 * @param {object} browser - playwright Browser。
 * @returns {Promise<{page: object, targetId: string, cdp: object}>} 自己的页面与收尾所需句柄。
 */
async function openOwnWindow(browser, ctxOverride) {
  /* ⚠️ **两种浏览器的 context 情况完全不同**（2026-10-13 修，实测抓到的 bug）：
   *
   *   - `connectOverCDP`（连已有）→ 浏览器**本来就有 context**（用户开着的那个），
   *     所以 `browser.contexts()[0]` 拿得到；
   *   - `launch`（我们自己启的）→ **一个 context 都没有**（新进程是空的），
   *     要先 `newContext()`。
   *
   * 第一版没区分，于是「启动式」全部报「连上的浏览器里没有可用的上下文（contexts 为空）」
   * —— 浏览器其实**已经起来了**，只是我们没给它建 context。
   * 由调用方把「是不是我们启的」传进来（`ctxOverride`）。
   *
   * 另外：启动式**本来就不需要「新建独立窗口」**（那个新进程只有我们一个人用，
   * 不存在「别挤进用户窗口」的问题），所以那条路径更简单。 */
  const owned = ctxOverride !== undefined
  const ctx = owned ? ctxOverride : browser.contexts()[0]
  if (ctx === undefined) throw new Error('连上的浏览器里没有可用的上下文（contexts 为空）')

  /* 「自己启动的」：直接在它自己的 context 里开一个页面即可 ——
   * 不碰 `Target.createTarget`（那套是为了在**用户的浏览器**里不打扰他才需要的，
   * 而新启动的进程只有我们一个人用）。
   *
   * 有头启动时会**弹出窗口**，所以顺手最小化（无头没有窗口，这步自动无效）。 */
  if (owned) {
    const page = await ctx.newPage()
    try {
      const s = await ctx.newCDPSession(page)
      const { windowId } = await s.send('Browser.getWindowForTarget')
      await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
      await s.detach()
    } catch { /* 最小化失败不影响采集，只是会打扰用户一下 */ }
    return { page, targetId: '' }
  }

  /* ① 记下现有页面（用来认出「哪个是新的」）。 */
  const pagesBefore = new Set(ctx.pages())

  /* ② 新建独立窗口。`newWindow: true` 是关键 —— 不要挤进用户当前窗口。 */
  const cdp = await browser.newBrowserCDPSession()
  const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })
    .catch(() => ({ targetId: '' }))
  const targetId = created.targetId ?? ''

  /* ③ 立刻最小化（用 targetId 直接操作，不等 playwright —— 那样会闪一下）。 */
  if (targetId !== '') {
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    } catch { /* 最小化失败不影响采集，只是会打扰用户一下 */ }
  }

  /* ④ 靠前后对比认出自己的页面（最多等 15 秒）。 */
  let page = null
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000))
    page = ctx.pages().find(p => !pagesBefore.has(p))
    if (page !== undefined && page !== null) break
  }
  if (page === undefined || page === null) {
    await cdp.detach().catch(() => { /* 断不开就算了 */ })
    throw new Error('没能开出独立窗口（15 秒内没见到新页面）。'
      + '不会退回「在用户当前窗口开标签页」——那会动到你正在看的页面。')
  }
  /* ⑤ 这个 CDP 会话的活干完了（建窗口 + 最小化），**断开它**。
   *
   * ⚠️ 早先这里把 `cdp` 一起返回、留给「收尾关窗」用 —— 那个设计已删
   * （现在一律不关窗，见 `run` 的 finally）。若还把它返回而不断开，
   * **每个节点都会泄漏一个 CDP 会话**（它挂在浏览器的连接上不掉），
   * 跑几十个节点后浏览器侧会积累一堆无用会话。 */
  await cdp.detach().catch(() => { /* 断不开就算了，进程退出会带走 */ })
  return { page, targetId }
}

/**
 * 检查参数是否齐全（**在连浏览器之前**）。
 *
 * ## 为什么要先校验（不只是为了快）
 *
 * 第一版把校验放在动作函数里、而动作函数在**取到页面之后**才跑，
 * 于是「没填目标元素」这种请求会先报「会话里还没有打开的页面」——
 * **报的是错的那个原因**，用户照着提示去接「打开页面」，接了还是失败。
 *
 * 而且校验前置还有两个好处：
 *   ① **不用白连一次浏览器**（连 CDP 要 8 秒超时，参数错了纯浪费）；
 *   ② 报错信息**只说自己这一个问题**，用户一眼知道改哪里。
 *
 * @param {string} action - 动作。
 * @param {object} p - 参数。
 * @throws 参数不齐时，指出**具体缺哪一项**。
 */
function validateParams(action, p) {
  /** 通用必填文本项。 */
  const need = (key, label) => {
    const v = p[key]
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error('没填「' + label + '」')
    }
  }
  switch (action) {
    case 'goto':
      need('url', '网址')
      break
    case 'click':
    case 'input':
    case 'text':
      need('selector', '目标元素')
      break
    case 'screenshot':
      /* 只有「只截某个元素」才需要选择器；截整页不需要。 */
      if (String(p.scope ?? 'viewport') === 'element') need('selector', '目标元素')
      break
    case 'eval':
      need('code', '脚本')
      break
    case 'download':
      /* 两种触发方式各需一个参数 —— 按选的那种校验。 */
      if (String(p.trigger ?? 'click') === 'url') need('url', '下载链接')
      else need('selector', '下载按钮')
      need('dir', '存到哪个目录')
      break
    default:
      /* 动作合法性在调用处挡，这里不重复。 */
      break
  }
}

/**
 * 取出本次要操作的页面：**优先复用会话里已有的**，没有才开新的。
 *
 * 这就是「多个节点接成一个浏览器流程」的关键（见登记表那段说明）：
 *   节点1 开窗口 → 登记；节点2 到登记表里找回**同一个**页面，接着操作。
 *
 * ⚠️ 返回形状故意**只有 `page` 与 `targetId`**：早先这里还带 `ccp` 与 `reused`
 * （给「用完关窗」用的），但那个设计错了、已删（见 `run` 的 finally 说明）。
 * 现在**一律不关窗口**，所以「是不是复用的」没有读的人 —— 留着是死字段。
 *
 * @param {object} browser - playwright Browser。
 * @param {string} session - 会话名。
 * @param {object|null} ownedCtx - 「自己启动的」浏览器的 context（CDP 时传 null）。
 * @returns {Promise<{page: object, targetId: string}>} 要操作的页面。
 */
async function acquirePage(browser, session, ownedCtx = null) {
  const found = await findSessionPage(browser, session)
  if (found !== null) return { page: found.page, targetId: found.targetId }
  const own = await openOwnWindow(browser, ownedCtx === null ? undefined : ownedCtx)
  /* 登记：下一个节点靠它找回这个页面。
   * ⚠️ **启动式不登记** —— 那个浏览器是我们这次启的、跑完就关
   * （见 `run` 的 finally 里 `opened.owned` 分支），登记了下次也找不回来
   * （登记表里那个 targetId 属于一个已经死掉的进程），反而会让下次误判「找到了」。 */
  if (!(ownedCtx !== null)) addTab(session, own.targetId, '')
  return { page: own.page, targetId: own.targetId }
}

/**
 * 「打开页面」动作。
 *
 * ## 与「复用」的配合
 *
 * 若这个会话里已经有一个窗口（上游节点开的），**就在它上面导航** ——
 * 这正是「打开页面 → 点击 → 取文本」能串起来的原因：一条链上只有一个窗口。
 *
 * @param {object} own - 页面句柄。
 * @param {string} session - 会话名。
 * @param {object} p - 参数。
 * @returns {Promise<object>} 结果。
 */
async function actGoto(own, session, p) {
  const url = String(p.url ?? '')
  if (url === '') throw new Error('没填网址')
  await own.page.goto(url, {
    waitUntil: String(p.waitUntil ?? 'domcontentloaded'),
    timeout: Number(p.timeout ?? 30000),
  })
  const out = { url: own.page.url(), title: await own.page.title() }
  /* 登记当前网址：会话自愈时用它判断「这个窗口还是不是我们要的那个」。 */
  if (own.targetId !== '') addTab(session, own.targetId, out.url)
  return out
}

/**
 * 「点击」动作。
 *
 * @param {object} own - 页面句柄。
 * @param {object} p - 参数。
 * @returns {Promise<object>} 结果。
 */
async function actClick(own, p) {
  const selector = String(p.selector ?? '')
  if (selector === '') throw new Error('没填「目标元素」')
  await own.page.click(selector, {
    timeout: Number(p.timeout ?? 30000),
    force: p.force === true,
  })
  return { clicked: selector, url: own.page.url() }
}

/**
 * 「输入文本」动作。
 *
 * @param {object} own - 页面句柄。
 * @param {object} p - 参数。
 * @returns {Promise<object>} 结果。
 */
async function actInput(own, p) {
  const selector = String(p.selector ?? '')
  if (selector === '') throw new Error('没填「目标元素」')
  const text = String(p.text ?? '')
  /* 先清空：`fill()` 本身就覆盖，但用户可能想「追加」——
   * 我们的参数叫「先清空原来的内容」，默认 true，所以显式处理两种。 */
  if (p.clear === false) {
    await own.page.click(selector, { timeout: Number(p.timeout ?? 30000) })
    await own.page.type(selector, text, { delay: 20 })
  } else {
    await own.page.fill(selector, text, { timeout: Number(p.timeout ?? 30000) })
  }
  return { filled: selector, text }
}

/**
 * 「取文本」动作。
 *
 * ⚠️ 这是采集最常用的动作，所以输出形态刻意做成**字符串**（不是对象）——
 * 下游 `{{变量}}` 引用时直接就是文字，不用再 `结果.text`。
 * 同时把文字放进对象里（`text` 字段）供需要结构化的情况用。
 *
 * @param {object} own - 页面句柄。
 * @param {object} p - 参数。
 * @returns {Promise<object>} 结果。
 */
async function actText(own, p) {
  const selector = String(p.selector ?? '')
  if (selector === '') throw new Error('没填「目标元素」')
  /* ⚠️ `state: 'attached'` 而不是默认的 `'visible'`。
   *
   * 依据（实测到的）：我们开的窗口是**最小化**的（有意为之 —— 不打扰用户），
   * 而最小化窗口里的元素在 playwright 眼里**不可见**，默认等 `visible` 会
   * 等到超时（实测报 `waiting for locator('h1') to be visible`，
   * 而那个元素其实好好地在页面里）。
   *
   * 采集要的是**内容**，不是「用户能看见」——所以等「已挂到 DOM」即可。 */
  const el = await own.page.waitForSelector(selector, {
    timeout: Number(p.timeout ?? 30000),
    state: 'attached',
  })
  if (el === null) throw new Error('没等到元素：' + selector)
  /* `innerText` 在不可见元素上也可能拿不到，所以优先 `textContent`
   * （它不要求渲染），再退回 `innerText`（按渲染取，含换行更干净）。 */
  let text = ''
  try {
    const visible = await el.isVisible()
    text = visible ? await el.innerText() : (await el.textContent() ?? '')
  } catch {
    text = (await el.textContent().catch(() => '')) ?? ''
  }
  text = String(text).trim()
  return { text, length: text.length, url: own.page.url() }
}

/**
 * 「截图」动作。
 *
 * @param {object} own - 页面句柄。
 * @param {object} p - 参数。
 * @param {string} workdir - 落盘目录。
 * @returns {Promise<object>} 结果（含文件路径）。
 */
async function actScreenshot(own, p, workdir) {
  const dir = join(workdir === '' ? dataDir() : workdir, 'screenshots')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fmt = String(p.format ?? 'png') === 'jpeg' ? 'jpeg' : 'png'
  const file = join(dir, 'shot-' + stamp + '.' + (fmt === 'jpeg' ? 'jpg' : 'png'))
  const scope = String(p.scope ?? 'viewport')
  const opts = { path: file, type: fmt }
  if (scope === 'full') opts.fullPage = true
  if (scope === 'element') {
    const selector = String(p.selector ?? '')
    if (selector === '') throw new Error('选了「只截某个元素」，但没填「目标元素」')
    const el = await own.page.waitForSelector(selector, { timeout: Number(p.timeout ?? 30000) })
    if (el === null) throw new Error('没等到元素：' + selector)
    await el.screenshot(opts)
    return { path: file, scope }
  }
  await own.page.screenshot(opts)
  return { path: file, scope }
}

/**
 * 「执行脚本」动作（兜底手段）。
 *
 * ## 用户定的：**完整开放 page 对象**，别卡功能
 *
 * 原话：「执行脚本的目的，就是在操作浏览器的各种数据，
 * 所以完整开放 page 对象，**别卡功能**。」
 *
 * 所以「脚本」参数写的是**在页面里**跑的 JS（等价于浏览器控制台里执行）——
 * 这正是用户说的「操作浏览器的各种数据」：读写 DOM、取全局变量、翻 `window.__NUXT__`。
 *
 * ## ⚠️ 一个我踩过的错（记下来）
 *
 * 第一版把脚本用 `new Function` 在**驱动进程**里跑，于是
 * `document is not defined` —— 驱动是 Node 进程，那里没有 `document`。
 * **页面脚本必须在页面上下文里执行**（`page.evaluate`）。
 *
 * ## 但也要能拿到 page 本身（两种需求并存）
 *
 * 有些事只能在 playwright 层做（`page.goto`、`page.setCookie`、开新页），
 * 那些用页面里的 `document` 做不到。所以判定：
 *   - 脚本里引用了 `page.` / `context.` / `browser.` → 当成**驱动层脚本**，把
 *     `page`/`context`/`browser` 作为参数传进去（可以 `await page.goto(...)`）；
 *   - 否则 → 当成**页面层脚本**，用 `page.evaluate` 在页面里跑。
 *
 * 这条分界让「取个 DOM 值」和「操作 playwright」两种写法都自然，
 * 而用户不用去理解两套 API 的区别。
 *
 * @param {object} own - 页面句柄。
 * @param {object} browser - playwright Browser。
 * @param {object} p - 参数。
 * @returns {Promise<object>} 结果（脚本的返回值）。
 */
async function actEval(own, browser, p) {
  const code = String(p.code ?? '')
  if (code.trim() === '') throw new Error('没填脚本内容')
  const ctx = browser.contexts()[0]

  /* 判定是「驱动层」还是「页面层」：看有没有用 playwright 才有的东西。
   *
   * ⚠️ 判据要**只认裸标识符** —— 第一版写的是 `\b(?:page|context|browser)\s*\.`，
   * 于是 `document.querySelector('.page.active')` 里的 `.page.` 也命中，
   * 被误判成驱动层脚本 → 在 Node 里跑 → `document is not defined`。
   * 那正是「执行脚本」这一功能最容易踩的错（而且报错指向完全错误的方向）。
   *
   * ⚠️⚠️ 第二版仍然错，2026-10-19 真机抓出来（用户报「抖音取数还是有问题」）：
   * 它**没剔除注释与字符串**。节点里那段「读已结算日」的脚本，注释里写着
   * `page.waitForSelector(picker, 20000)`（解释「源码那步在 playwright 层、
   * 我们改成页面内轮询」）—— 就这一句注释让判据命中 → 整段页面脚本被送进
   * Node 跑 → 报 **`location is not defined`**（那行错指向的位置完全无关，
   * 看代码会以为是 `location` 用错了）。
   *
   * 所以现在**先去注释、去字符串字面量，再判**。这不是洁癖：
   * 节点里的脚本普遍带大段注释解释来龙去脉，注释里提到 `page.` 极常见。
   *
   * @param {string} code - 用户写的脚本源码。
   * @returns {boolean} 是否引用了 playwright 的 page/context/browser。
   */
  const looksLikeDriverScript = (code) => {
    /* ① 去块注释、行注释；② 去三种字符串字面量（含模板串）。
     * 顺序有意义：先注释后字符串 —— 反过来会把 `//` 里的引号当成字符串开头。
     * ⚠️ 正则去注释不处理「字符串里的 /*」这种变态情况，但节点脚本是自用代码，
     * 不需要完整的词法分析；**正则表达式字面量**里的 `/\//` 同样会留下一点残渣，
     * 但那种残渣不会凭空造出 `page.`。 */
    const stripped = String(code)
      /* 块注释（非贪婪、跨行）。 */
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      /* 行注释（`//` 到行尾）—— 注意别把 `http://` 里的 `//` 当注释：
       * 前面必须有行首或空白，且不能紧跟冒号。 */
      .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ')
      /* 字符串与模板串。 */
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    return /(^|[^.\w])(?:page|context|browser)\s*\./.test(stripped)
  }

  const usesPlaywright = looksLikeDriverScript(code)

  let result
  if (usesPlaywright) {
    /* 驱动层：完整开放三个对象（用户要求「别卡功能」）。
     * ⚠️ 这不是沙箱 —— 脚本能对浏览器做任何事。节点说明里已写明。 */
    const fn = new Function('page', 'context', 'browser', 'return (async () => { ' + code + ' })()')
    result = await fn(own.page, ctx, browser)
  } else {
    /* 页面层：把**代码字符串**传进页面、在页面里 eval。
     *
     * ⚠️ 不要「在 Node 里 `new Function` 再把函数传给 `evaluate`」：
     * playwright 是**序列化函数源码**再送进页面的，`new Function` 造出来的
     * 匿名函数在那边求值时行为不稳定（而且报错信息很难懂）。
     * 传字符串最直接，报错也清楚。 */
    result = await own.page.evaluate(async (src) => {
      /* eslint-disable no-eval -- 这是「执行脚本」节点的**本意**：
       * 用户要的就是「在页面里跑我写的代码」，等价于浏览器控制台。
       * 代码是用户自己写的（自用工具），不是来路不明的输入。 */
      return await eval('(async () => { ' + src + ' })()')
    }, code)
  }

  /* 返回值可能不可序列化（DOM 节点、循环引用）→ 转成安全形态，别让整个节点炸。 */
  let safe = null
  try {
    safe = JSON.parse(JSON.stringify(result ?? null))
  } catch {
    safe = String(result)
  }
  return { result: safe }
}

/**
 * 「下载-playwright」动作（节点 `browser.download`）：触发 + 等 download 事件 + 落盘，**一口气做完**。
 *
 * ## 为什么不能拆成几个节点（技术硬约束，不是设计偏好）
 *
 * 依据（Playwright 官方 Download 文档，见
 * `plans/2026-10-12-脚本拆分设计方案.md` §3.4）：
 *   - 我们走 CDP = **远程连接** → `download.path()` **会抛错**；
 *   - 下载的临时文件在**上下文关闭后就被删掉**。
 * 所以 `saveAs` 必须在同一个进程里立刻做，中间不能断。
 *
 * ## ⚠️ 一个必须照官方要求写的顺序（错了会静默丢事件）
 *
 * 官方示例注释：*Start waiting for download before clicking. **Note no await*** ——
 * 也就是**先挂监听**（拿到 Promise 但**先别 await**）、**再**点击。
 * 反过来（先点、再挂监听）会漏掉事件：点击到挂监听之间文件已经开始下了，
 * 事件早就派发完了 —— 表现是「永远等不到下载」，而且**这一步不报错**。
 *
 * @param {object} own - 页面句柄。
 * @param {object} p - 参数。
 * @param {string} workdir - 基准目录（参数没给目录时用）。
 * @returns {Promise<object>} 落盘结果。
 */
async function actDownload(own, p, workdir) {
  const page = own.page
  const timeout = Number(p.timeout ?? 120000)
  const trigger = String(p.trigger ?? 'click')

  /* 目标目录：参数优先，没给就用「工作目录/downloads」。
   * ⚠️ 参数里的 `{{变量}}` 已在**客户端**替换过（buildCommand 负责），
   * 所以这里拿到的是最终值，不用再替换一次。 */
  const rawDir = String(p.dir ?? '').trim()
  const dir = rawDir === '' ? join(workdir === '' ? dataDir() : workdir, 'downloads') : rawDir
  mkdirSync(dir, { recursive: true })

  /* ① **先挂监听**（拿到 Promise，先不 await）—— 官方明确要求的顺序。
   *
   * ⚠️ **必须先接住它的失败**。这个 Promise 要等我们点完才 await，
   * 而若「点击」那一步自己先抛错（选择器找不到元素），就再也没人来 await 它 ——
   * 于是它变成一个**未处理的 rejection**，Node 直接**崩掉进程**，
   * 用户看到的是崩溃而不是「按钮没找到」。
   * 这个坑实测踩到过（`page.waitForEvent: Timeout ... ` 直接抛到顶层）。
   * 接住之后下面 await 它仍能正常拿到结果或错误。 */
  const waiter = page.waitForEvent('download', { timeout })
  waiter.catch(() => { /* 真正的处理在下面 await 处；这里只是防止成为未处理 rejection */ })

  /* ② 再触发。 */
  if (trigger === 'url') {
    const url = String(p.url ?? '')
    if (url === '') throw new Error('没填「下载链接」')
    /* 用页面里发一个隐藏链接来触发，**不用 `page.goto(url)`** ——
     * 后者会把当前页面导航走，下游节点就找不到这个页面了。 */
    await page.evaluate((u) => {
      const a = document.createElement('a')
      a.href = u
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }, url)
  } else {
    const selector = String(p.selector ?? '')
    if (selector === '') throw new Error('没填「下载按钮」')
    /* ⚠️ 点击失败要**包一层可读的说明** —— 原始报错是
     * `page.click: Timeout 30000ms exceeded ... waiting for locator('#x')`
     * 那种英文技术堆栈，用户看不懂、也不知道该改什么。
     * 对「下载」这个动作最常见的失误就是选择器写错（按钮找不着），
     * 所以直接把排查方向写出来。 */
    try {
      await page.click(selector, { timeout: 30000 })
    } catch (e) {
      throw new Error('没找到「下载按钮」（' + selector + '）。'
        + '检查选择器：在浏览器里右键那个按钮 → 检查，复制它的 class 或 id。'
        + '注意页面改版后选择器常会失效。原始信息：'
        + String(e?.message ?? e).split('\n')[0].slice(0, 100))
    }
  }

  /* ③ 等下载开始（这里才 await）。 */
  let download
  try {
    download = await waiter
  } catch (e) {
    throw new Error('点了之后 ' + String(timeout) + ' 毫秒内没有开始下载。'
      + '检查两件事：① 按钮选择器对不对；② 这个按钮是不是真的触发下载'
      + '（有些按钮只是弹个窗、或者要等几十秒才生成文件）。'
      + '原始信息：' + String(e?.message ?? e).slice(0, 120))
  }

  /* ④ 决定文件名。
   * - 填了 → 用它（**同名会覆盖**，那是用户自己要固定名的选择）；
   * - 没填 → 「原文件名 + 时间戳」，避免连跑两次互相覆盖。 */
  const suggested = String(download.suggestedFilename() ?? 'download')
  const given = String(p.filename ?? '').trim()
  let file
  if (given !== '') {
    file = join(dir, given)
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dot = suggested.lastIndexOf('.')
    const base = dot > 0 ? suggested.slice(0, dot) : suggested
    const ext = dot > 0 ? suggested.slice(dot) : ''
    file = join(dir, base + '-' + stamp + ext)
  }

  /* ⑤ 落盘：**必须在同一进程里立刻做**（临时文件随连接结束消失）。 */
  await download.saveAs(file)

  /* 下载中途失败（被拦、断开）要报出来 —— 否则下游拿到一个残缺文件还当成功。 */
  const failure = await download.failure()
  if (failure !== null && failure !== undefined) {
    throw new Error('下载失败：' + String(failure) + '（文件可能不完整：' + file + '）')
  }
  return { path: file, suggested, dir }
}

/**
 * 执行一条指令。
 *
 * 七个动作（照 n8n 的 Playwright 节点形态：一个节点 + 动作下拉）：
 * goto / click / input / text / screenshot / eval / download。
 *
 * ⚠️ `download` 是**独立节点**（`browser.download`，显示名「下载-playwright」）
 * 而不是「浏览器」节点的第八个动作 —— 用户 2026-10-19 明确「下载与浏览器作为两个节点」，
 * 理由：它是**有结果产出**的一步（落盘文件路径），而其余六个动作更像「操作」。
 *
 * @param {object} req - 指令。
 * @returns {Promise<unknown>} 该动作的输出。
 */
async function run(req) {
  const action = String(req?.action ?? '')
  const p = req?.params ?? {}
  const session = String(req?.session?.name ?? '默认')

  /* ⚠️ **动作与参数都在连浏览器之前校验**（理由见 `validateParams`）。
   * 这样「没填目标元素」不会先报成「会话里没有页面」。 */
  const KNOWN = ['goto', 'click', 'input', 'text', 'screenshot', 'eval', 'download']
  if (!KNOWN.includes(action)) {
    throw new Error('不认识的浏览器动作：' + (action === '' ? '(空)' : action)
      + '（可选：' + KNOWN.join(' / ') + '）')
  }
  validateParams(action, p)

  /* ⚠️ 第二层配置（`launcher` / `exePath`）由宿主半从**设置里按标签解析好**再传进来 ——
   * 驱动只管**照着开**，不自己决定用哪个浏览器（那样「同名不同浏览器」就防不住了）。 */
  const opened = await openBrowser(req?.session)
  const browser = opened.browser
  /* ⚠️ **「自己启动的」要现建一个 context**（实测抓到的 bug）：
   * `connectOverCDP` 连的浏览器**本来就带着用户的 context**，
   * 而 `launch` 出来的是**空进程、一个 context 都没有** ——
   * 不建的话后面 `contexts()[0]` 拿到 undefined，报「没有可用的上下文」。
   * 这不是「启动失败」，是**我们没给它建**。 */
  const ownedCtx = opened.owned ? await browser.newContext() : null

  let own = null
  try {
    /* ⚠️ 「点击/输入/取文本/截图」都要求**已经有页面**（上游的「打开页面」开的）。
     * 没有就明确报错，**不要**默默开一个空白窗口 ——
     * 那样用户看到的是「点了没反应」，比报错难查得多。 */
    const needsPage = action !== 'goto'
    if (needsPage) {
      const found = await findSessionPage(browser, session)
      if (found === null) {
        /* ⚠️ **「启动式」的多步天然不成立**，所以这里给一条专门的说明（实测确认）。
         *
         * 原因（架构性，不是 bug）：每个浏览器节点都是**独立子进程**，
         * 而 `headed`/`headless` 启的浏览器在**那个进程退出时就被关掉了**
         * （见 `run` 的 finally 里 `opened.owned` 分支）。
         * 于是第二个节点再连时，浏览器已经没了 —— 它当然找不到页面。
         *
         * 实测（2026-10-13）：headless 单步能跑通；
         * 第二步去 eval 就报「会话里还没有打开的页面」。
         *
         * 所以「多步」必须用 `cdp`（连一个**常驻**的浏览器）。
         * 这里把话说明白，而不是让用户对着「没有页面」猜。
         *
         * ⚠️ **文案里不写死端口号**（2026-10-14）：端口是用户手填的，
         * 写一个具体数字会让人以为「就是那个端口」。 */
        if (opened.owned) {
          throw new Error('这是「启动式」（' + opened.kind + '）的浏览器，它跑完这一步就关了 —— '
            + '所以下一步找不到页面。\n'
            + '多步的流程（打开 → 点击 → 取文本）必须让浏览器常驻，'
            + '那就得用「连接已有（CDP）」：去节点的「浏览器」一节把来源改成'
            + '「已开的调试端口（CDP）」、并填上你那个浏览器的调试端口'
            + '（该浏览器要用 --remote-debugging-port=<你填的那个端口> 启动着）。\n'
            + '（启动式适合「一步做完」的活，比如打开页面截图。）')
        }
        throw new Error('会话「' + session + '」里还没有打开的页面。'
          + '请在这个节点前面先接一个「浏览器」节点、动作选「打开页面」。')
      }
      own = { page: found.page, targetId: found.targetId }
    } else {
      own = await acquirePage(browser, session, ownedCtx)
      /* ⚠️ **这里刻意不做任何「用完关窗」的标记**。
       *
       * 我第一版让 `goto` 也「用完即关」并写了个 `keepOpen` 标记来区分，
       * 结果踩了坑：节点1 开窗口 → 打开网址 → **关掉** → 登记表留下一个死 id；
       * 节点2 到登记表里找 → 自愈剔掉死 id → 报「没有页面」。
       * 表现是「第二个浏览器节点永远说前面没打开页面」，而构建、类型检查全绿。
       *
       * 现在收尾**一律不关窗口**（见 `run` 的 finally），所以那个标记没了用处、
       * 一并删掉 —— 留着它只会让下一个人以为「关不关窗还分情况」。
       *
       * 代价可控：**每个会话名最多一个窗口**（`acquirePage` 优先复用），
       * 不会越跑越多。用户想清掉就关掉那个窗口，登记表下次读会自愈剔除。 */
    }

    switch (action) {
      case 'goto': return await actGoto(own, session, p)
      case 'click': return await actClick(own, p)
      case 'input': return await actInput(own, p)
      case 'text': return await actText(own, p)
      case 'screenshot': return await actScreenshot(own, p, String(req?.workdir ?? ''))
      case 'eval': return await actEval(own, browser, p)
      case 'download': return await actDownload(own, p, String(req?.workdir ?? ''))
      default: throw new Error('不认识的浏览器动作：' + action)
    }
  } finally {
    /* ⚠️ **有意不关窗口**。理由：
     *
     * 一个工作流里「打开页面 → 点击 → 取文本」是**三段独立子进程**，
     * 中间那个窗口必须一直活着，下游节点才能接着操作同一个页面。
     * 驱动**看不到「流程什么时候结束」**，所以任何「用完即关」都是错的
     * （这正是我第一版的 bug：goto 关掉窗口 → 下游永远找不到页面）。
     *
     * 代价可控：**每个会话名最多一个窗口**（`acquirePage` 优先复用），
     * 所以不会越跑越多。用户想清掉就关掉那个窗口，登记表下次读会自愈剔除。 */
    if (opened.owned) {
      /* ⚠️ **我们自己启动的必须关掉**（`browser.close()` 对 `launch` 出来的实例
       * 是**真的杀进程**，不是断连接）—— 不关就会每跑一次留一个野进程。
       *
       * 这与 CDP 那条**方向相反**，所以必须分开：
       *   - `cdp`（连已有的）→ 只断连接，**绝不关**（那是用户的浏览器、登录态是资产）
       *   - `headed`/`headless`（我们启的）→ **要关**（是我们生的，留着就是泄漏）
       *
       * ⚠️ 但这与上面「窗口要留给下游节点」**冲突** —— 怎么办？
       *   由**宿主半**决定：它知道一个标签的第二层是 `cdp` 还是启动式，
       *   所以它**不会**让「启动式」的第一步与后续步骤分在不同进程里
       *   （见 `impl.ts` 里对 `owned` 的处理与 `driver.mjs` 的会话语义）。
       *   这里只按 `owned` 忠实执行「是我启的我就收」。 */
      await browser.close().catch(() => { /* 关不掉就算了，进程退出会带走 */ })
    } else {
      /* CDP：只断连接 —— **不关浏览器**（登录态是资产，常驻绝不关）。 */
      await browser.close().catch(() => { /* 断不开就算了，进程退出会带走 */ })
    }
  }
}

/* ── 入口 ──────────────────────────────────────────────────────────── */

const raw = process.argv[2] ?? process.stdin.read?.() ?? ''
let req = {}
try {
  req = raw === '' ? {} : JSON.parse(raw)
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: '指令不是合法 JSON：' + String(e?.message ?? e) }) + '\n')
  process.exit(1)
}

run(req)
  .then(output => {
    process.stdout.write(JSON.stringify({ ok: true, output }) + '\n')
    /* 显式退出：CDP 连接会挂住事件循环（见文件顶部的实战注释）。 */
    process.exit(0)
  })
  .catch(e => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n')
    process.exit(1)
  })

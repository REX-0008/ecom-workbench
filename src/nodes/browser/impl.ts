/** 浏览器节点（`browser.act`）的实现 —— 在宿主半进程里**起子进程**跑驱动脚本。
 *
 * ## 为什么是 builtin 而不是 shell
 *
 * 节点定义里 `executor` 写的是 `shell`（命令 = `{ argv }`），但**驱动脚本的完整路径
 * 只有宿主半知道**（它在 `lib/nodes/browser/driver.mjs`，部署后位置由宿主半自己算）。
 * 客户端算不出来 —— 客户端在浏览器里跑，拿不到文件系统路径。
 *
 * 所以这里做一件「桥接」：宿主半收到这个节点的派发时，**自己拼 argv** 再起进程。
 * 也就是说：**对外仍是 shell 语义（起子进程），但命令由宿主半生成**。
 *
 * ## 为什么不在宿主半进程内直接 import playwright
 *
 * 依据用户现有脚本的实战注释：
 * > 「playwright 的 CDP 连接（WebSocket）会挂住事件循环，成功路径隐式退出会卡住进程」
 *
 * 连上 CDP 之后那个进程就不会自己退出。放进宿主半 = dsh 卡死，故障极难定位。
 * 子进程有进程边界保底，这是唯一安全的做法。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuiltinFn } from '../../dispatch/executors.ts'
import type { ReportEntry } from '../../workflow/model.ts'

/** 本模块所在位置。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 找驱动脚本。
 *
 * ## ⚠️ 这里曾经有一个「永远找不到」的 bug（2026-10-13 修，用户报的）
 *
 * 原来的写法是**只找自己旁边**：`join(HERE, 'driver.mjs')`，
 * 假设「本模块与 `driver.mjs` 同目录」。**这个假设只在源码目录成立**：
 *   - 源码：`src/nodes/browser/impl.ts` 与 `driver.mjs` 确实同目录 ✓
 *   - **产物：`impl.ts` 被构建器内联进了 `lib/index.js`** ✗
 *     → `import.meta.url` 指向 `lib/index.js` → `HERE` = `lib/`
 *     → 它去找 `lib/driver.mjs`，而真文件在 `lib/nodes/browser/driver.mjs`
 *
 * 症状（用户原话）：「在工作流中点击运行，第一个节点就报错
 * `找不到浏览器驱动脚本：...\lib\driver.mjs`」。
 *
 * ⚠️ **这个 bug 瞒过了我自己的验证**：我此前几次「真机验证成功」都是**直接跑源码路径**
 * 的 driver，而工作流走的是**产物路径** —— 两条路不一样。
 * 教训：**验证必须走用户实际走的那条路**（下面 `tests/browser-driver-path.mjs`
 * 就是从产物验的）。
 *
 * ## 现在的做法：按候选列表逐个试，找到为止
 *
 * 候选覆盖「源码目录」「产物目录」两种布局；**找不到就明确报错**，
 * 并把「找了哪些地方」一起说出来（便于一次定位，而不是又一轮猜）。
 *
 * ## 测试接缝（`EWB_TEST_BROWSER_DRIVER`）
 *
 * 这里有一个**只认环境变量**的覆盖口：设了它就直接用那个路径当驱动脚本。
 *
 * 为什么需要它：浏览器动作的汇报必须**真跑一遍**才验得到（`reportOf` 取的是驱动
 * 真实返回的输出，尤其是 `statSync` 那个磁盘字节数）。而真跑要一台开着调试端口的
 * 浏览器 —— 那种测试进不了测试套件（别人跑、以后跑都不成立，见
 * `tests/browser-driver.mjs` 文件头那段）。
 *
 * 于是测试拿一个**假驱动脚本**（打印同样形状的 JSON）替进去，`browserActFn`
 * 那整段（起进程 / 收 stdout / 解析最后一行 / 翻成汇报）照样跑真的。
 * 这与 `EWB_TEST_NO_SPAWN` / `EWB_TEST_HOME` 是同一类做法，不是生产分支。
 *
 * @returns 驱动脚本的绝对路径。
 * @throws 所有候选都不存在时。
 */
function driverPath(): string {
  const override = process.env.EWB_TEST_BROWSER_DRIVER
  if (override !== undefined && override !== '') return override
  const candidates = [
    /* ① 同目录（源码布局：src/nodes/browser/ 下两个文件在一起）。 */
    join(HERE, 'driver.mjs'),
    /* ② 产物的真实布局：`lib/index.js` 旁边往下两层
     *    （由 `scripts/copy-runtime.mjs` 决定，那里写的是 `nodes/browser/driver.mjs`）。 */
    join(HERE, 'nodes', 'browser', 'driver.mjs'),
    /* ③ 兜底：本模块若被放在更深处（如 lib/nodes/browser/impl.js），
     *    再往上找一层仓库/lib 根。 */
    join(HERE, '..', '..', 'nodes', 'browser', 'driver.mjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('找不到浏览器驱动脚本。找过这些位置：\n  '
    + candidates.join('\n  ')
    + '\n（构建时漏了复制？见 scripts/copy-runtime.mjs）')
}

/** 驱动脚本的产出（它打到 stdout 最后一行）。 */
interface DriverResult {
  /** 成功与否。 */
  ok?: boolean
  /** 成功时的输出。 */
  output?: unknown
  /** 失败原因。 */
  error?: string
}

/**
 * 从子进程的 stdout 里取结果。
 *
 * ⚠️ **只认最后一行**的 JSON，不假设整份 stdout 是 JSON ——
 * 驱动脚本会透传 playwright 自己的日志，那些不是 JSON。
 *
 * @param out - stdout 全文。
 * @returns 解析出的结果；没有一行是合法 JSON 时返回 null。
 */
function parseDriverOutput(out: string): DriverResult | null {
  const lines = out.split('\n').map(l => l.trim()).filter(l => l !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) as DriverResult } catch { /* 不是 JSON，继续往前找 */ }
  }
  return null
}

/**
 * 跑一个浏览器动作（起子进程）。
 *
 * @param cmd - 命令体（客户端给的 `{ node, params }`）。
 * @param ctx - 节点上下文。
 * @returns 该动作的输出。
 * @throws 起不来 / 脚本报错 / 结果读不出来时。
 */
export const browserActFn: BuiltinFn = async (cmd, ctx) => {
  const body = cmd as { node?: string, params?: Record<string, unknown> } | undefined
  const params = body?.params ?? {}
  const driver = driverPath()

  /* ⚠️ **「下载-playwright」是独立节点**（`browser.download`），它没有 `action` 参数 ——
   * 若这里统一用 `params.action ?? 'goto'`，它会**被当成「打开页面」跑**，
   * 而且因为 `goto` 要求 `url`，报错会变成「没填网址」——
   * 一个完全指错方向的错误。所以按**节点 id** 决定动作。 */
  const action = body?.node === 'browser.download'
    ? 'download'
    : String(params.action ?? 'goto')

  /* 指令经 **argv 传 JSON**：比管道省事（不用处理流），且日志里能直接看到参数。 */
  const payload = JSON.stringify({
    action,
    /* 会话 = **两层结构**（用户 2026-10-13 定的）：
     *   第一层 `name`：标签（用来把几个节点绑在一起）；
     *   第二层 `launcher` / `exePath` / `port`：**由标签从设置里解析出来的快照**。
     *
     * ⚠️ 为什么第二层是**从 params 带过来**、而不是在这里查设置：
     * 设置在**浏览器那边的 localStorage** 里，宿主半（Node 进程）**读不到**。
     * 而 params 是存档的一部分 —— 客户端写、宿主半读，正好是这条数据的通道。
     *
     * ⚠️ 这也**从机制上保证**了「同名标签 → 同一个浏览器」：
     * 画布写这个值时是按标签统一算的，节点自己存不下第二套。
     * 驱动只管照着开，**不自己决定用哪个浏览器**。
     *
     * ⚠️ **`port` 是 2026-10-14 加的**（用户 #7：「9222 不能是硬编码的，
     * 要前端可见的手填项目」）。它是**手填值原样传下去** ——
     * 这里**不做任何默认值兜底**：没填就是空串，由驱动明确报错。
     * 在这里兜一个 9222 就等于把硬编码换了个地方藏。 */
    session: {
      name: String(params.session ?? '默认'),
      launcher: String(params.launcher ?? 'cdp'),
      exePath: String(params.exePath ?? ''),
      port: String(params.port ?? ''),
    },
    params,
    upstream: ctx.upstream,
    /* 截图 / 下载要落盘的动作用它当基准目录（传下去，免得驱动自己猜）。 */
    workdir: ctx.workdir ?? '',
  })

  /* ⚠️ **cwd 必须是存在的目录**（2026-10-13 修，实测抓到的静默失败）。
   *
   * `spawn` 的 `cwd` 指向一个不存在的目录时：进程**根本起不来**，
   * 退出码 1、stdout/stderr **都是空的** —— 于是上层只能报
   * 「驱动没有返回可读结果（退出码 1）：(没有任何输出)」，
   * 而真正的原因（那个目录不存在）**一个字都没提到**。
   *
   * 用户跑工作流时 `workdir` 来自宿主半的 `process.cwd()`，一般是存在的；
   * 但**任何**让那个路径失效的情形（目录被删、配置指向别处、测试传了临时目录）
   * 都会掉进这个坑，而且完全查不到原因。
   *
   * 所以这里先判存在：不存在就退回驱动自己所在的目录（那里一定在）。
   * 顺带把「用哪个 cwd」记进 payload，便于排查。 */
  const cwd = ctx.workdir !== '' && existsSync(ctx.workdir) ? ctx.workdir : dirname(driver)

  const child = spawn(process.execPath, [driver, payload], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    /* Windows 上不弹控制台窗口（否则每次跑浏览器动作都闪一下黑框）。 */
    windowsHide: true,
    /* ⚠️ **显式带上 DSH_HOME / DSH_PROFILE**：驱动要按同一套约定算数据目录
     * （会话登记表放那儿）。虽然子进程默认继承 env，但显式传更可靠 ——
     * 若哪天宿主半进程的 env 被裁剪，会话复用会**静默失效**
     * （表现是「每个浏览器节点都开一个新窗口」，很难查）。 */
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_HOME ?? '',
      DSH_PROFILE: process.env.DSH_PROFILE ?? 'desktop',
    },
  })

  let out = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
  child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })

  const code: number = await new Promise((resolve) => {
    child.on('close', (c) => { resolve(c ?? 1) })
    child.on('error', () => { resolve(1) })
  })

  const parsed = parseDriverOutput(out)
  if (parsed === null) {
    /* 连结果都读不出来：把两路输出都带上，否则用户完全不知道发生了什么。
     *
     * ⚠️ 补一句「退出码 1 + 两路全空」的专门提示（2026-10-13）：
     * 那种形状最典型的原因是**子进程根本没起来**（cwd 不存在、node 路径不对等），
     * 而「没有任何输出」这句话本身完全指不出方向。 */
    const tail = (err.trim() !== '' ? err.trim() : out.trim()).slice(0, 400)
    const silent = tail === ''
    throw new Error('浏览器驱动没有返回可读结果（退出码 ' + String(code) + '）：'
      + (silent ? '(没有任何输出)' : tail)
      + (silent && code === 1
        ? '\n（退出码 1 且两路都空，通常是子进程没起来：'
          + '运行目录不存在、node 找不到、或被安全软件拦了。'
          + '本次用的运行目录：' + cwd + '）'
        : ''))
  }
  if (parsed.ok !== true) {
    throw new Error(parsed.error ?? '浏览器动作失败（驱动没给原因）')
  }
  /* ★ 汇报这次浏览器动作到底做成了什么（票 08 后半，2026-10-27）。
   *
   * ## 为什么必须报**业务量**，不能只报「跑完了」
   *
   * 采集类节点跑完后，用户最想知道的是「下到了什么、多大、落到哪」。
   * 一句「浏览器动作完成」既不能让任务记录那一行有内容，也回答不了任何问题 ——
   * 那与没汇报几乎等价（见票 08 里「补了汇报不等于有业务产出」那条）。
   *
   * 所以每条汇报都从**驱动真返回的输出**里取量：
   *   · 下载 → 文件路径、磁盘上的真实字节数、文件名；
   *   · 打开页面 → 最终网址、页面标题；
   *   · 点击 / 输入 → 点了哪个元素、页面现在在哪；
   *   · 取文本 → 取到多少字、从哪个元素取的；
   *   · 截图 → 落到哪个文件、多大；
   *   · 执行脚本 → 结果是什么形状。
   *
   * ## 失败时不报「完成」
   *
   * 驱动报错走上面两条 throw，一条汇报都不发 —— 失败原因由引擎的 `failed` 事件说，
   * 这里再报一句「完成了」就是撒谎。 */
  const reports = reportsOf(action, parsed.output, params)
  for (const entry of reports) ctx.report?.(entry)
  return parsed.output
}

/**
 * 按动作把驱动的输出翻成**一条或几条**带业务量的汇报。
 *
 * ## 为什么返回值是数组（票 20，2026-10-27）
 *
 * 多数动作只有一件事可说（点了一下、取到 10 个字）。但 `eval` 是**采集的主力**：
 * 它返回一个数组时，那就是「这次采到了 N 条」。用户要的是**逐条**看得见
 * （「采到 SKU 1234，价格 89.9」），而不是「结果是一个数组，32 项」。
 *
 * 所以 `eval` 返回数组时推 **N 条逐条 + 1 条汇总**；其余动作推 1 条。
 *
 * ## 「报什么」由这里设计决定，不是把 JSON 倒出来
 *
 * 用户 2026-10-27 原话：「记录什么是需要在节点里面设计好，而不是完全自动呈现」。
 * 所以逐条汇报**挑字段**：优先业务上认得出的那几个（名称 / SKU / 价格 / 数量），
 * 而不是 `JSON.stringify(item)` —— 那种倒出来的东西没人读得下去，
 * 而且一个字段改名就会让记录变成几百字的噪音。
 *
 * @param action - 动作名（`download` / `goto` / `click` / …）。
 * @param output - 驱动返回的输出（形状见 `driver.mjs` 各 `act*` 的 return）。
 * @param params - 节点参数（补几条人类可读的上下文，如文件名）。
 * @returns 汇报列表；这个动作没有可量的事时是空数组（宁可不报，不报废话）。
 */
function reportsOf(action: string, output: unknown, params: Record<string, unknown>): ReportEntry[] {
  const one = reportOf(action, output, params)
  if (action !== 'eval') return one === undefined ? [] : [one]

  /* ── `eval` 返回数组 = 一次采集 ────────────────────────────────
   *
   * ⚠️ **判定「是不是一个采集」看的是数组**：真实存档里采集就是这么写的
   * （`browser.act` 的 `eval` 动作 `return [...]`），见
   * `巡查-抖音-店铺数据.json` 的 n10、`取数-抖音电商罗盘.json` 的 n25/n26。
   * 不是数组时退回原来那一句形状描述（那里没有可逐条的东西）。 */
  const out = output !== null && typeof output === 'object' ? output as Record<string, unknown> : {}
  const rows = out.result
  if (!Array.isArray(rows)) return one === undefined ? [] : [one]

  const entries: ReportEntry[] = []
  for (let i = 0; i < rows.length; i += 1) {
    entries.push({
      message: itemLine(i + 1, rows.length, rows[i]),
      type: 'info',
      location: 'ndv',
      /* `item` 给界面折叠/定位用（循环里靠它区分第几条）。 */
      item: String(i + 1),
    })
  }
  /* 汇总一条：单流程跑完「这次采到几条」。它必须**最后**出现 ——
   * 逐条在前、总账在后，读起来才是「这些明细，合计 N 条」。 */
  entries.push({
    message: '这一次采到 ' + String(rows.length) + ' 条'
      + (rows.length === 0 ? '（一条都没采到）' : ''),
    type: rows.length === 0 ? 'warning' : 'info',
    location: 'ndv',
    metrics: { count: rows.length },
  })
  return entries
}

/**
 * 一条采集明细写成一句话（**挑业务字段，不倒 JSON**）。
 *
 * 优先认这几个名字：名称 / 标题 / SKU / 价格 / 数量。挑不到就退成「第 N 条」+
 * 值的简短形状 —— 仍然**不倒全文**，因为一段几百字的 JSON 塞进记录没人读。
 *
 * @param index - 第几条（1 起）。
 * @param total - 一共几条。
 * @param row - 这一条的值。
 * @returns 一句话。
 */
function itemLine(index: number, total: number, row: unknown): string {
  const head = '第 ' + String(index) + '/' + String(total) + ' 条'
  if (row === null || row === undefined) return head + '是空值（这一条没采到东西）'
  if (typeof row !== 'object') {
    const text = String(row)
    return head + '：' + (text.length > 40 ? text.slice(0, 40) + '…' : text)
  }
  if (Array.isArray(row)) return head + '是一个数组，' + String(row.length) + ' 项'
  const o = row as Record<string, unknown>
  /* 字段优先级：先认业务上最认得出来的，再退到任意标量字段。 */
  const LIKED = ['name', 'title', 'sku', 'skuId', 'id', 'price', 'amount', 'count', 'qty']
  const parts: string[] = []
  for (const k of LIKED) {
    const v = o[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object') continue
    /* 有中文名就用中文名，别让用户读英文字段。 */
    parts.push((LABELS[k] ?? k) + ' ' + String(v))
    if (parts.length >= 3) break
  }
  if (parts.length > 0) return head + '：' + parts.join('，')
  /* 一个认识的字段都没有：说清「有几个字段」并点名前两个，仍然不倒值。 */
  const keys = Object.keys(o)
  if (keys.length === 0) return head + '是空对象'
  return head + '有 ' + String(keys.length) + ' 个字段：' + keys.slice(0, 3).join('、')
    + (keys.length > 3 ? ' 等' : '')
}

/** 采集明细里那几个字段的中文说法（没有的就不翻译，直接用原字段名）。 */
const LABELS: Record<string, string> = {
  name: '名称',
  title: '标题',
  sku: 'SKU',
  skuId: 'SKU',
  id: '编号',
  price: '价格',
  amount: '金额',
  count: '数量',
  qty: '数量',
}

/**
 * 按动作把驱动的输出翻成一句**带业务量**的汇报。
 *
 * @param action - 动作名（`download` / `goto` / `click` / …）。
 * @param output - 驱动返回的输出（形状见 `driver.mjs` 各 `act*` 的 return）。
 * @param params - 节点参数（补几条人类可读的上下文，如文件名）。
 * @returns 汇报；这个动作没有可量的事时给 `undefined`（宁可不报，不报废话）。
 */
function reportOf(action: string, output: unknown, params: Record<string, unknown>): ReportEntry | undefined {
  const out = output !== null && typeof output === 'object' ? output as Record<string, unknown> : {}

  if (action === 'download') {
    /* 下载是用户最关心的那一步：**下到了什么、多少字节、落到哪**。
     * 字节数按磁盘上真实大小取（`statSync`），不用驱动给的 `suggested` 之类 ——
     * 那是文件名，不是大小。取不到就明说「大小没读到」，不编一个数。 */
    const path = typeof out.path === 'string' ? out.path : ''
    if (path === '') return undefined
    const bytes = sizeOf(path)
    const name = typeof out.suggested === 'string' && out.suggested !== ''
      ? out.suggested
      : (path.split(/[\\/]/).pop() ?? '')
    return {
      message: '下到 ' + name + '，' + (bytes === undefined ? '大小没读到' : String(bytes) + ' 字节' + sizeNote(bytes))
        + '，存到 ' + path,
      type: 'info',
      location: 'ndv',
      /* 量在 `metrics` 上单独给一份：界面上要显示数字、以后要统计总和时不必解析这句话。 */
      ...bytes === undefined ? {} : { metrics: { bytes } },
      files: [path],
    }
  }

  if (action === 'goto') {
    const url = typeof out.url === 'string' ? out.url : ''
    const title = typeof out.title === 'string' ? out.title : ''
    if (url === '') return undefined
    return {
      message: '打开页面：' + (title === '' ? '(无标题)' : title) + '，当前地址 ' + url,
      type: 'info',
      location: 'ndv',
    }
  }

  if (action === 'click') {
    const clicked = typeof out.clicked === 'string' ? out.clicked : String(params.selector ?? '')
    const url = typeof out.url === 'string' ? out.url : ''
    return {
      message: '点了一下 ' + clicked + (url === '' ? '' : '，页面现在是 ' + url),
      type: 'info',
      location: 'ndv',
      metrics: { clicks: 1 },
    }
  }

  if (action === 'input') {
    const selector = typeof out.filled === 'string' ? out.filled : String(params.selector ?? '')
    const text = typeof out.text === 'string' ? out.text : ''
    return {
      message: '往 ' + selector + ' 填了 ' + String(text.length) + ' 个字'
        + (text === '' ? '（清空了）' : ''),
      type: 'info',
      location: 'ndv',
      metrics: { chars: text.length },
    }
  }

  if (action === 'text') {
    const length = typeof out.length === 'number' ? out.length : String(out.text ?? '').length
    const selector = String(params.selector ?? '')
    return {
      message: '从 ' + selector + ' 取到 ' + String(length) + ' 个字'
        + (length === 0 ? '（元素是空的）' : ''),
      type: 'info',
      location: 'ndv',
      metrics: { chars: length },
    }
  }

  if (action === 'screenshot') {
    const path = typeof out.path === 'string' ? out.path : ''
    if (path === '') return undefined
    const bytes = sizeOf(path)
    return {
      message: '截图落到 ' + path
        + (bytes === undefined ? '（大小没读到）' : '，' + String(bytes) + ' 字节' + sizeNote(bytes)),
      type: 'info',
      location: 'ndv',
      ...bytes === undefined ? {} : { metrics: { bytes } },
      files: [path],
    }
  }

  if (action === 'eval') {
    /* 脚本结果是**任意形状**，这里只说形状与规模，不倒全文
     * （一段几百行的 JSON 塞进汇报会把记录撑爆）。 */
    const result = out.result
    const shape = shapeOf(result)
    return {
      message: '脚本跑完，结果' + shape,
      type: 'info',
      location: 'ndv',
    }
  }

  /* 不认识的动作：不报（宁可不报，不报一句没有信息的话）。 */
  return undefined
}

/**
 * 取文件字节数（取不到给 `undefined`，**不编一个 0**）。
 *
 * @param path - 文件路径。
 * @returns 字节数；文件不在 / 读不到时 `undefined`。
 */
function sizeOf(path: string): number | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

/**
 * 把字节数背后的人话括注（`（1.2 MB）`）；小于 1 KB 时返回空串。
 *
 * 为什么这句话里既给字节又给人话：字节是**可核对**的（与文件属性一致），
 * 人话是**可判断**的（1.2 MB 一眼看出下没下到）。只给一个都不够；
 * 小于 1 KB 时两者是同一件事，所以这里省掉重复的那半。
 *
 * @param bytes - 字节数。
 * @returns 括注（带括号本身）；小于 1 KB 时是空串。
 */
function sizeNote(bytes: number): string {
  if (bytes < 1024) return ''
  return '（' + humanSize(bytes) + '）'
}

/**
 * 把字节数说成人话（`1.2 MB` 这种）。
 *
 * @param bytes - 字节数。
 * @returns 形如 `1.2 MB` / `512 字节`。
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' 字节'
  const kb = bytes / 1024
  if (kb < 1024) return kb.toFixed(1) + ' KB'
  return (kb / 1024).toFixed(1) + ' MB'
}

/**
 * 描述一个任意结果值的形状与规模（给 `eval` 的汇报用）。
 *
 * @param value - 任意值。
 * @returns 形如「是一个数组，3 项」「是一段文本，24 字」。
 */
function shapeOf(value: unknown): string {
  if (value === null || value === undefined) return '是空'
  if (Array.isArray(value)) return '是一个数组，' + String(value.length) + ' 项'
  if (typeof value === 'string') return '是一段文本，' + String(value.length) + ' 字'
  if (typeof value === 'object') {
    return '是一个对象，' + String(Object.keys(value as Record<string, unknown>).length) + ' 个字段'
  }
  if (typeof value === 'number') return '是一个数字：' + String(value)
  if (typeof value === 'boolean') return '是一个布尔值：' + String(value)
  return '是 ' + typeof value
}

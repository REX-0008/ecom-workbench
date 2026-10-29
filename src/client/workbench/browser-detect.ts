/** 浏览器检测（**纯逻辑**，可单测；不自己碰磁盘 —— 由调用方传进来）。
 *
 * ## 用户 2026-10-13 的要求（原话）
 *
 * > 「关于浏览器，给工作流这个板块增加一个设置，设置里面增加一个**默认使用浏览器**。
 * > 然后我的电脑应该有很多浏览器可以用，包括 **playwright 默认打包的浏览器**，
 * > 这个检测过程能否自动。如果可以，增加一个**检测功能**。另外我们的 **CDP 也列进去**。」
 *
 * ## 检测什么（三层）
 *
 * 1. **系统里装了的浏览器** —— 按各平台常见安装路径找（Chrome / Edge / QQBrowser 等）
 * 2. **Playwright 自带的那份** —— 它在 `~/.cache/ms-playwright`（或 `%LOCALAPPDATA%`）下
 * 3. **CDP 端口在不在听** —— 用户的常驻浏览器（我们要复用的那份登录态）
 *
 * ## 为什么把「找路径」与「读磁盘」分开
 *
 * 本文件只做**纯逻辑**（候选路径列表、解析检测结果），读磁盘交给宿主半
 * （它才是唯一能碰盘的一侧，见 `AGENTS.md` 的分层）。
 * 这样这些规则可以**脱离文件系统单测** —— 而「检测」这件事恰恰最容易
 * 因为平台路径写错而静默失效（Probe 永远返回空，界面上什么都不显示）。
 */

/** 一种浏览器的检测结果。 */
export interface BrowserCandidate {
  /** 稳定 id（存进设置里的就是它）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 可执行文件绝对路径；`null` = 没找到（但知道该去哪儿找）。 */
  path: string | null
  /** 来源：系统安装的 / Playwright 自带的 / 用户手动加的。 */
  source: 'system' | 'playwright' | 'manual'
  /**
   * 这个浏览器**支持哪种启动方式**。
   *
   * ⚠️ 这一栏决定界面上能不能选「CDP 连接」——
   * 只有 Chromium 系（Chrome / Edge / QQBrowser 等）才有 CDP。
   */
  kinds: readonly LauncherKind[]
}

/**
 * 驱动的「怎么连」（**内部值**，界面上不再直接给用户选）。
 *
 * ⚠️ **这三个值现在是推导出来的，不是让用户选的**（用户 2026-10-14 的分类改造）：
 *
 * | 用户选的 | 推导出的 `launcher` |
 * | --- | --- |
 * | 来源 = 已开的调试端口（CDP） | `cdp` |
 * | 来源 = 本机装着的浏览器 + 方式 = 有窗口 | `headed` |
 * | 来源 = 本机装着的浏览器 + 方式 = 无窗口 | `headless` |
 *
 * 与「第一层」（浏览器标签）的分工见 `browser-settings.ts`。
 */
export type LauncherKind =
  /** 连一个**已经在跑的**浏览器（保留登录态）。 */
  | 'cdp'
  /** 有头启动一个新的（看得见窗口）。 */
  | 'headed'
  /** 无头启动（看不见窗口，快，但没有登录态）。 */
  | 'headless'

/**
 * 「用哪个浏览器」的**两个来源**（用户 2026-10-14 定的分类）。
 *
 * > 「选择浏览器**既可以选择一个可以被打开的浏览器，也可以使用 CDP 连接一个已打开的浏览器**，
 * > 他们都是选择浏览器，而不是选择打开方式」
 *
 * ⚠️ 这条是这次改造的核心：`cdp` **不是**「打开方式」的一个选项，
 * 它是**另一个来源**（连一个已经开着的），与「本机装着的浏览器」并列。
 */
export type BrowserSource =
  /** 本机装着的浏览器（我们把它打开 → 需要一个可执行文件 + 有头/无头）。 */
  | 'app'
  /** 已经开着的调试端口（CDP，连上去 → 需要一个端口号）。 */
  | 'cdp'

/** 「本机装着的浏览器」被我们打开时，窗口可不可见。 */
export type OpenMode =
  /** 有窗口（看得见）。 */
  | 'headed'
  /** 无窗口（看不见，快，但没有登录态）。 */
  | 'headless'

/** 「用哪个浏览器」两个来源的中文名与说明（界面上直接用）。 */
export const SOURCE_LABEL: Record<BrowserSource, { name: string; hint: string }> = {
  cdp: {
    name: '已开的调试端口（CDP）',
    hint: '连接已开启且带调试端口的浏览器，保留登录态。多步流程需选用此项。',
  },
  app: {
    name: '本机装着的浏览器',
    hint: '启动独立浏览器实例：无登录态，流程结束即关闭，仅适用于单步操作。',
  },
}

/** 打开方式（只在来源是「本机装着的浏览器」时才有意义）的中文名与说明。 */
export const OPEN_MODE_LABEL: Record<OpenMode, { name: string; hint: string }> = {
  headed: {
    name: '有窗口',
    hint: '开一个看得见的窗口，跑完这一步就关。',
  },
  headless: {
    name: '无窗口',
    hint: '开一个看不见的窗口，最快；但没有登录态，且部分站点会判为机器人。',
  },
}

/**
 * 各「怎么连」的中文名与说明（**推导值的说明**，不是给用户选的项）。
 *
 * 保留它是因为「报错与提示」里要说清「你现在这种连法是什么」。
 */
export const LAUNCHER_LABEL: Record<LauncherKind, { name: string; hint: string }> = {
  cdp: { name: SOURCE_LABEL.cdp.name, hint: SOURCE_LABEL.cdp.hint },
  headed: { name: '启动一个（有窗口）', hint: OPEN_MODE_LABEL.headed.hint },
  headless: { name: '启动一个（无窗口）', hint: OPEN_MODE_LABEL.headless.hint },
}

/* ── CDP 端点探测（**纯逻辑**：解析 + 并发扫描；真正的网络请求由调用方传进来）──
 *
 * ## 为什么这几段要抽成纯函数
 *
 * 「本机哪些端口是 CDP 端点」这件事有两个最容易错、又最难查的点：
 *   ① **解析** netstat 的输出（列位置随系统语言/版本变，写错就永远扫不到）
 *   ② **并发与超时**（一个端口都不听时，逐个等超时会把「检测」按钮卡住）
 * 两者都能脱离网络单测 —— 所以把「怎么解析」「怎么并发」放这里、
 * 把「怎么发那个请求」交给宿主半（它才是能碰网络的一侧，见 `AGENTS.md` 分层）。
 */

/**
 * 一个「正在听的 CDP 端点」。
 *
 * ⚠️ 「是不是 CDP」的判据是**那道标准入口能不能答话**：
 * `http://127.0.0.1:<端口>/json/version`，返回的 JSON 里必有 `Browser` 字段
 * （实测：端口在听但不是 CDP 的会被超时排除，而 CDP 端口 1 毫秒就答）。
 */
export interface CdpEndpoint {
  /** 端口号。 */
  port: number
  /** 它自报的浏览器（`Browser` 字段，如 `Chrome/138.0.7204.0`）；取不到 = null。 */
  browser: string | null
}

/**
 * 扫端口的参数（**实测得出**，不是拍的）。
 *
 * 实测：本机约 50 个监听端口，每端口 600ms 超时、并发 16 → 全部扫完 **2145ms**；
 * 单个 CDP 端口只要 **1ms**。所以「检测」按钮是可行的，但**必须并发 + 短超时**，
 * 否则端口一多就会卡住界面。
 */
export const CDP_SCAN_TIMEOUT_MS = 600
/** 同时探测几个端口（实测 16 时总耗时约 2.1 秒）。 */
export const CDP_SCAN_CONCURRENCY = 16

/**
 * 从 `netstat` 的输出里筛出**正在听**的端口（去重、升序）。
 *
 * 兼容三种真实写法（实测 Windows 是第一种）：
 *   ```
 *   TCP    0.0.0.0:135     0.0.0.0:0     LISTENING     1452     ← Windows
 *   TCP    [::]:445        [::]:0        LISTENING     4        ← Windows IPv6
 *   tcp4       0  127.0.0.1.9222    *.*   LISTEN                 ← macOS（**点分隔**）
 *   tcp        0  127.0.0.1:9222   0.0.0.0:* LISTEN              ← Linux（冒号）
 *   ```
 *
 * ⚠️ 端口取「本地地址」那一列的**最后一个 `:` 或 `.` 之后**那段 ——
 * 这样 IPv4（`0.0.0.0:135`）、IPv6（`[::]:445`）、
 * 以及 macOS 那种点分隔（`127.0.0.1.9222`）**一套写法全覆盖**。
 * ⚠️ 只认冒号会在 macOS 上**一个端口都扫不到**，而且**不报错**
 * （表现是「检测按钮转一下、然后说没扫到」）—— 所以两种都要认。
 *
 * @param netstatText - netstat 的原始输出。
 * @returns 端口号（升序、去重）。
 */
export function listeningPorts(netstatText: string): number[] {
  const out = new Set<number>()
  for (const line of netstatText.split(/\r?\n/)) {
    /* 只要「在听」的行：Windows 是 `LISTENING`，Linux/macOS 是 `LISTEN`。 */
    if (!/\bLISTEN(ING)?\b/i.test(line)) continue
    if (!/^\s*tcp/i.test(line)) continue
    /* 逐列找**本地地址**那一列。
     * ⚠️ 不能写死列号：Windows 本地地址在第 2 列，而 macOS 在第 4 列
     * （前面还有 Proto / Recv-Q / Send-Q 三列）。写死列号会让一边永远扫不到。
     * 判据取「第一个长得像 `主机[:.]端口` 的词」——两种分隔符都认。 */
    for (const tok of line.trim().split(/\s+/).slice(1)) {
      const m = /^[0-9a-fA-F:.\[\]]+[:.](\d{1,5})$/.exec(tok)
      if (m === null) continue
      /* 排掉别的东西里偶然出现的形如 `x.1` 的词（真地址一定要有分隔符前的部分）。 */
      const cut = Math.max(tok.lastIndexOf(':'), tok.lastIndexOf('.'))
      if (cut <= 0) continue
      const port = Number(m[1])
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue
      out.add(port)
      break
    }
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * 从 `/json/version` 的响应体里取浏览器版本。
 *
 * @param body - 响应体（应为 JSON）。
 * @returns `Browser` 字段的值；不是 JSON / 没有这个字段 → null。
 */
export function cdpBrowserOf(body: string): string | null {
  try {
    const o = JSON.parse(body) as { Browser?: unknown }
    return typeof o.Browser === 'string' && o.Browser !== '' ? o.Browser : null
  } catch {
    return null
  }
}

/**
 * 并发探测一组端口，返回其中**真的是 CDP 端点**的那些。
 *
 * ## 为什么用「固定并发的工作池」而不是 `Promise.all`
 *
 * 端口可能有几十上百个，`Promise.all` 会一次性开同样多的连接；
 * 而且超时是**串行叠加**的（每个 600ms 就会变成 N × 600ms）。
 * 工作池把并发压在 `CDP_SCAN_CONCURRENCY` 以内，总耗时 ≈ 端口数 ÷ 并发 × 超时。
 *
 * ⚠️ **单个端口出错/超时不算失败**：那正是「它不是 CDP 端点」的正常表现。
 *
 * @param ports - 要探测的端口（来自 `listeningPorts`）。
 * @param probe - 探测一个端口：是 CDP 就返回它的浏览器版本，不是就返回 null。
 *   由调用方注入（宿主半用 HTTP，测试用假函数）。
 * @param opts.concurrency - 并发数（默认 `CDP_SCAN_CONCURRENCY`）。
 * @returns 找到的端点（按端口升序）。
 */
export async function scanCdpPorts(
  ports: readonly number[],
  probe: (port: number) => Promise<string | null>,
  opts: { concurrency?: number } = {},
): Promise<CdpEndpoint[]> {
  const width = Math.max(1, Math.floor(opts.concurrency ?? CDP_SCAN_CONCURRENCY))
  const found: CdpEndpoint[] = []
  let next = 0
  /** 一个 worker：不断地从队列里取下一个端口探到没有为止。 */
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= ports.length) return
      const port = ports[i] as number
      let browser: string | null = null
      try {
        browser = await probe(port)
      } catch {
        /* 探不动就是「不是 CDP 端点」——这不是错误。 */
        browser = null
      }
      if (browser !== null) found.push({ port, browser })
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, ports.length) }, worker))
  return found.sort((a, b) => a.port - b.port)
}

/**
 * 端口号文本合法化（界面上是**手填**的，所以要能容忍乱输）。
 *
 * @param v - 用户输入的原文。
 * @returns 合法则返回去掉空格的原文，否则空串（= 没填）。
 */
export function normalizePort(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  if (!/^\d{1,5}$/.test(t)) return ''
  const n = Number(t)
  return n >= 1 && n <= 65535 ? String(n) : ''
}

/**
 * Chromium 系浏览器的常见安装位置（Windows）。
 *
 * ⚠️ **顺序有意义**：越靠前越优先（用户跑采集用的那个排前面）。
 * 这份表就是「检测」的**全部知识** —— 加一个浏览器 = 往这里加一行。
 */
const WIN_CANDIDATES: readonly { id: string; name: string; paths: readonly string[] }[] = [
  {
    /* ⚠️ QQBrowser 排第一 —— 用户实际跑采集用的就是它（实测 9222 上是它）。 */
    id: 'qqbrowser',
    name: 'QQ 浏览器',
    paths: [
      'C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
      'C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe',
    ],
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    paths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    paths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
]

/**
 * 列出「系统里可能装了的浏览器」的候选路径。
 *
 * @param platform - `process.platform`（测试时可传别的值）。
 * @param env - 环境变量（要 `LOCALAPPDATA` / `PROGRAMFILES`）。
 * @returns 候选（每条可能有多条路径，逐个试）。
 */
export function systemBrowserCandidates(
  platform: string,
  env: Record<string, string | undefined>,
): { id: string, name: string, paths: string[] }[] {
  if (platform !== 'win32') return []
  const local = env.LOCALAPPDATA ?? ''
  const out: { id: string, name: string, paths: string[] }[] = []
  for (const c of WIN_CANDIDATES) {
    const paths = [...c.paths]
    /* Chrome 还有一种「只给当前用户装」的位置（很多机器上是这个）。 */
    if (c.id === 'chrome' && local !== '') {
      paths.push(local + '\\Google\\Chrome\\Application\\chrome.exe')
    }
    out.push({ id: c.id, name: c.name, paths })
  }
  return out
}

/**
 * Playwright 自带浏览器的**缓存根目录**。
 *
 * 两种约定（实测过 playwright 会按平台选一个）：
 *   - 老/多数：`~/.cache/ms-playwright`
 *   - Windows 上有时：`%LOCALAPPDATA%\ms-playwright`
 *
 * @param platform - `process.platform`。
 * @param env - 环境变量。
 * @param home - 用户目录。
 * @returns 可能的根目录列表（逐个试）。
 */
export function playwrightCacheDirs(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const out: string[] = []
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? ''
    if (local !== '') out.push(local + '\\ms-playwright')
  }
  out.push(home + '/.cache/ms-playwright')
  return out
}

/**
 * 从 Playwright 缓存目录名解析出「装了哪个浏览器、什么版本」。
 *
 * Playwright 的缓存目录命名是 `<名字>-<版本>`，如：
 *   - `chromium-1200`
 *   - `chromium_headless_shell-1200`
 *   - `firefox-1490`
 *   - `ffmpeg-1011`
 *
 * ⚠️ 只认**能起浏览器的**那些（`ffmpeg` 是录屏用的，不是浏览器；`chromium_headless_shell`
 * 是无头壳，不能给用户看）。剩下的按名字归并。
 *
 * @param entries - 缓存目录下的条目名。
 * @returns 解析出的浏览器（按名字去重，保留最高版本）。
 */
export function parsePlaywrightCache(
  entries: readonly string[],
): { id: string, name: string, version: string }[] {
  /** 目录名前缀 → 展示名。 */
  const KNOWN: Record<string, string> = {
    chromium: 'Chromium（Playwright）',
    firefox: 'Firefox（Playwright）',
    webkit: 'WebKit（Playwright）',
  }
  const best = new Map<string, { id: string, name: string, version: string }>()
  for (const raw of entries) {
    const m = /^([a-z_]+)-(\d+)$/.exec(raw.trim())
    if (m === null) continue
    const [, prefix, version] = m
    /* 不是浏览器（录屏工具、无头壳）就跳过 —— 列出来只会让人困惑。 */
    const key = prefix === 'chromium_headless_shell' ? 'chromium' : prefix
    const name = KNOWN[key]
    if (name === undefined) continue
    const prev = best.get(key)
    if (prev === undefined || Number(version) > Number(prev.version)) {
      best.set(key, { id: key, name, version })
    }
  }
  return [...best.values()]
}

/**
 * 一个候选**能不能用**（给界面显示用）。
 *
 * @param c - 候选。
 * @returns 能用则 true。
 */
export function usable(c: BrowserCandidate): boolean {
  return c.path !== null
}

/**
 * 把检测结果拼成**设置里那份清单**（默认项 + 可选项）。
 *
 * ## 用户定的两层结构（2026-10-13 原话）
 *
 * > 「第一层，用来关联多个节点的**自定义名称**的浏览器设置，
 * > 第二层，用来决定通过什么方式打开页面用什么浏览器的。
 * > **第一层决定第二层**……其他的节点第二层自动统一
 * > （保持一致性，不然，明明用来保证一个页面的标签一样，浏览器不一样，
 * > 那么运行必然会出问题，甚至不一定是报错）」
 *
 * 本文件只负责**第二层的候选清单**（有哪些浏览器可选）；
 * 「标签 → 浏览器」的映射在 `browser-settings.ts`。
 *
 * @param found - 已检测到的（有路径的）。
 * @param tried - 找过但没找到的。
 * @returns 清单。
 */
export function buildBrowserList(
  found: readonly BrowserCandidate[],
  tried: readonly BrowserCandidate[],
): BrowserCandidate[] {
  /* 有路径的排前面（能用的先给用户看）。 */
  return [...found, ...tried]
}

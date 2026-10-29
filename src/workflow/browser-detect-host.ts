/** 浏览器检测（宿主半的**机器事实**一侧）。
 *
 * ## 为什么单独一个文件（2026-10-17 拆，Step 5 的「大文件拆分」）
 *
 * 它原来是 `src/index.ts` 里的一大段（约 370 行）—— 而那个文件同时装着
 * 「HTTP 路由」「采集面板」「浏览器检测」三类互不相干的职责，
 * 改一次路由要在七百行里翻。
 *
 * ## 与客户端的 `browser-detect.ts` 怎么分工（这条别搞混）
 *
 * | | 谁 | 管什么 |
 * |---|---|---|
 * | 本文件 | **宿主半**（Node 进程）| **机器事实**：读磁盘找可执行文件、探端口、问 CDP |
 * | `src/client/workbench/browser-detect.ts` | 客户端（浏览器里）| **纯规则**：怎么解析 netstat、怎么并发探端口、怎么归一化端口 |
 *
 * 两者都必需：浏览器里读不了磁盘、也连不了 127.0.0.1:9222；而 Node 进程读不到
 * localStorage（用户的「默认来源 / 默认端口」偏好只有浏览器看得到）。
 * 所以「有没有这个浏览器」在宿主半算，「默认那条路通不通」在客户端下结论。
 *
 * ⚠️ **只读、不改任何东西**：`existsSync` + 一次 `net.connect` 探端口 +
 * 一次 HTTP GET 问 `/json/version`。它**不启动**任何浏览器。
 */
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import {
  listeningPorts, scanCdpPorts, cdpBrowserOf, normalizePort, CDP_SCAN_TIMEOUT_MS,
} from '../client/workbench/browser-detect.ts'

/** 一个检测到的浏览器。 */
export interface DetectedBrowser {
  /** 稳定 id（设置里存的、节点标签解析用的都是它）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 可执行文件路径；`null` = 找过但没找到。 */
  path: string | null
  /** 来源。 */
  source: 'system' | 'playwright' | 'cdp'
  /** 这个能不能「连已有的」（只有 Chromium 系能，且要端口在听）。 */
  cdpReady: boolean
}

/** 扫到的一个 CDP 端点（端口 + 它自报的浏览器）。 */
export interface CdpFound {
  /** 调试端口。 */
  port: number
  /** `Browser` 字段的值（如 `Chrome/138.0.7204.0`）。 */
  browser: string | null
}

/**
 * 探测一个 TCP 端口有没有在听（超时很短）。
 *
 * ⚠️ **注意它与「是不是 CDP 端点」不是一回事**（2026-10-14 修正）：
 * 一个端口在听只能说明「有程序占着它」，不能说明那是浏览器的调试端口。
 * 真正的判据是下面的 `probeCdp`（问 `/json/version`）。
 * 两者一起用才能给出手填端口的**三态**回复（见 `/browser/cdp` 路由）：
 *   没人在听 / 有人在听但不是浏览器调试端口 / 就是 CDP 且带版本。
 *
 * @param port - 端口。
 * @param timeoutMs - 超时（默认 600 毫秒 —— 本机端口探测够快，快了不卡界面）。
 * @returns 在听则 true。
 */
export function probePort(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    let done = false
    /** 收口一次（连接/超时/出错都走这里）。 */
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => { finish(true) })
    sock.once('timeout', () => { finish(false) })
    sock.once('error', () => { finish(false) })
  })
}

/**
 * 问一个端口「你是不是 CDP 端点」。
 *
 * ## 判据是**那道标准入口**（用户 2026-10-14 提的「端口是不是浏览器，不好检测吧」的答案）
 *
 * `http://127.0.0.1:<端口>/json/version` —— 任何 Chromium 系浏览器开了调试端口后
 * 都会答这个请求，且**返回的 JSON 里必有 `Browser` 字段**（如 `Chrome/138.0.7204.0`）。
 *
 * **实测（2026-10-14，本机）**：
 *   · 9222 → `Chrome/138.0.7204.0`（那个端口上跑的是 QQ 浏览器）
 *   · 不答这个请求的端口只能**靠超时排除**（所以超时必须短）
 *   · 单个 CDP 端口 **1ms**；扫全部约 50 个监听端口（600ms 超时 + 并发 16）**2145ms**
 *
 * @param port - 端口。
 * @param timeoutMs - 超时（默认见 `CDP_SCAN_TIMEOUT_MS`）。
 * @returns `Browser` 字段的值；不是 CDP 端点（超时/拒绝/不是 JSON/没那个字段）→ null。
 */
export function probeCdp(port: number, timeoutMs = CDP_SCAN_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    /** 收口一次。 */
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const req = get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d: string) => { body += d })
      res.on('end', () => { finish(cdpBrowserOf(body)) })
    })
    req.on('timeout', () => { req.destroy(); finish(null) })
    req.on('error', () => { finish(null) })
  })
}

/**
 * 扫本机正在听的端口，找出其中**真是 CDP 端点**的那些。
 *
 * ⚠️ **并发 + 短超时**（用户实测数据：50 个端口 2.1 秒）——
 * 逐个串行等 600ms 会让「检测」按钮卡好几十秒。
 * 并发与超时的常量在 `browser-detect.ts`（那是**可单测的纯逻辑**侧，
 * 而「怎么发那个 HTTP 请求」是宿主半的事 —— 按 `AGENTS.md` 的分层）。
 *
 * @returns 找到的端点（含端口与浏览器版本）。**失败不抛**，返回空数组。
 */
export async function scanCdp(): Promise<{ port: number, browser: string | null }[]> {
  let text = ''
  try {
    /* `netstat -ano -p tcp`：实测 90ms 左右（比 PowerShell 的 Get-NetTCPConnection 轻）。 */
    text = await runCapture('netstat', ['-ano', '-p', 'tcp'], 3000)
  } catch { /* 拿不到端口列表 = 扫不出端点，返回空 */ }
  const ports = listeningPorts(text)
  if (ports.length === 0) return []
  return await scanCdpPorts(ports, async p => await probeCdp(p))
}

/**
 * 在一份 Playwright 浏览器目录里找**可执行文件**。
 *
 * 目录结构随平台不同（Windows 是 `<dir>/chrome-win64/chrome.exe`），
 * 所以**不猜**具体子目录名，而是递归找那个已知的文件名。
 *
 * @param dir - `ms-playwright/chromium-<版本>` 那个目录。
 * @returns 可执行文件路径；找不到返回 null。
 */
export function chromiumExeOf(dir: string): string | null {
  /* 只往下一两层找 —— 目录不深（`chrome-win64/chrome.exe`），
   * 全递归没必要，也免得在大目录上耗时。 */
  const NAMES = ['chrome.exe', 'chrome', 'chrome-headless-shell.exe', 'firefox.exe', 'firefox']
  for (const sub of ['', 'chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac', 'firefox']) {
    for (const n of NAMES) {
      const p = sub === '' ? join(dir, n) : join(dir, sub, n)
      if (existsSync(p)) return p
    }
  }
  /* 再兜一层：有些布局是 `<dir>/<某名字>/<名字>.exe`。 */
  try {
    for (const e of readdirSync(dir)) {
      const sub = join(dir, e)
      for (const n of NAMES) {
        const p = join(sub, n)
        if (existsSync(p)) return p
      }
    }
  } catch { /* 读不了就算了 */ }
  return null
}

/**
 * 跑一条命令、抓它的 stdout（用于**只读探测**，不用于节点的命令执行）。
 *
 * ⚠️ 与派发器的 shell 执行方**不是一回事**：
 *   - 那个是「跑用户的工作流节点」，要有队列、超时、进程树管理；
 *   - 这个是**插件自己的一次内部探测**（拿进程列表），要求「快、失败就放弃」。
 * 所以这里不排队、超时很短、失败返回空串（让调用方退回别的办法）。
 *
 * @param cmd - 可执行文件。
 * @param args - 参数。
 * @param timeoutMs - 超时（到点杀掉，返回已抓到的）。
 * @returns stdout 文本（失败或超时返回空串，不抛）。
 */
export function runCapture(cmd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    /** 收口（只结算一次）。 */
    const done = (): void => {
      if (settled) return
      settled = true
      resolve(out)
    }
    try {
      const p = spawn(cmd, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
      p.on('error', () => { done() })
      p.on('close', () => { done() })
      const t = setTimeout(() => { try { p.kill() } catch { /* 已经退了 */ } ; done() }, timeoutMs)
      p.on('close', () => { clearTimeout(t) })
    } catch {
      done()
    }
  })
}

/**
 * 检测本机可用的浏览器（用户 2026-10-13 要的检测功能）。
 *
 * ## 三层（用户原话：「我的电脑应该有很多浏览器可以用，包括 playwright
 * 默认打包的浏览器……另外我们的 CDP 也列进去」）
 *
 * 1. **系统安装的** —— Chrome / Edge / QQBrowser，按常见路径找
 * 2. **Playwright 自带** —— 它的缓存目录（`~/.cache/ms-playwright` 或 `%LOCALAPPDATA%`）
 * 3. **CDP 端点** —— 扫本机正在听的端口，问 `/json/version`，**找出所有真的是的**
 *
 * ## ★ 2026-10-14 改了什么（用户 #7）
 *
 * 原来这里写死 `const PORT = 9222`，**只探那一个端口**、**只回报「在不在听」**。
 * 用户要的是「端口**手填**、不硬编码」+「**检测**能列出找到的端点及它的浏览器版本」，
 * 所以现在：
 *   · **不再有默认端口**（这一段源码里没有任何字面量端口）；
 *   · 扫**全部**正在听的端口，用 `/json/version` 逐个确认，**带回 `Browser` 版本**；
 *   · 找到几个就列几个（不再假设「只有一个 9222」）。
 *
 * ⚠️ **纯只读**：`existsSync` + 一次 `netstat` + 若干次 HTTP GET，不写文件、不启动进程。
 *
 * ## 为什么路径表写在这里而不是客户端
 *
 * 客户端在浏览器里跑，**拿不到文件系统** —— 它没法 `existsSync`。
 * 所以「有哪些候选路径」是数据（放 `browser-detect.ts` 那份纯逻辑里也行），
 * 但**「这个路径存不存在」只有宿主半能答**。这里就地写候选，是因为
 * 它以 Windows 为主（用户的实际环境），将来加别的平台在这里加分支即可。
 *
 * ## ⚠️ 实测教训：**硬编码安装路径不够**（2026-10-13 被真机推翻）
 *
 * 我第一版只写了 `C:\Program Files\...` 那几个常见位置，**实测全都没命中** ——
 * 用户的 QQBrowser 装在 **`D:\Program Files\Tencent\QQBrowser\QQBrowser.exe`**（D 盘！），
 * 而 9222 明明是它在听。
 *
 * 所以现在的顺序是「**先问运行中的进程，再退回常见路径**」：
 *   ① **从正在跑的进程拿真实路径**（最可靠 —— 那是它真正的安装位置）
 *   ② 退回常见路径（进程没在跑时，至少还能告诉用户「装在哪」）
 *
 * 教训一般化：**「文件在哪」不该猜，能问系统就问系统。**
 *
 * @returns 检测结果（含每一层）。
 */
export async function detectBrowsers(): Promise<{
  ok: true
  browsers: DetectedBrowser[]
  cdp: { listening: boolean, endpoints: CdpFound[] }
  platform: string
}> {
  const home = homedir()
  const win = process.platform === 'win32'
  const local = process.env.LOCALAPPDATA ?? ''

  const out: DetectedBrowser[] = []

  /* ── ⓪ 先问**运行中的进程**：它们给出了真实的安装路径 ──────────────
   * 这是最可靠的一层 —— 用户在哪儿装的、从哪儿起的，系统知道。
   * 用 `wmic`/`powershell` 代价大且可能被策略拦，所以只对**关心的那几个**名字查。
   * 拿不到就静默跳过（退回下面的常见路径），**不让探测本身变成失败点**。 */
  const runningPaths = new Map<string, string>()
  if (win) {
    try {
      /* `tasklist /FO CSV /NH` 拿不到路径，所以改用 PowerShell 的 Get-Process。
       * 超时短（2 秒）—— 探测失败不该卡住界面。 */
      const ps = 'Get-Process -Name QQBrowser,chrome,msedge,firefox -ErrorAction SilentlyContinue | '
        + 'Select-Object -ExpandProperty Path -Unique'
      const raw = await runCapture('powershell', ['-NoProfile', '-Command', ps], 2000)
      for (const line of raw.split(/\r?\n/)) {
        const p = line.trim()
        if (p === '' || !p.toLowerCase().endsWith('.exe')) continue
        const base = p.toLowerCase()
        /* 认它是哪个浏览器（按可执行文件名）。 */
        if (base.endsWith('qqbrowser.exe')) runningPaths.set('qqbrowser', p)
        else if (base.endsWith('chrome.exe')) runningPaths.set('chrome', p)
        else if (base.endsWith('msedge.exe')) runningPaths.set('edge', p)
        else if (base.endsWith('firefox.exe')) runningPaths.set('firefox', p)
      }
    } catch { /* 探测失败就用常见路径，不报错 —— 这不是关键路径 */ }
  }

  /* ── ① 系统安装的 ────────────────────────────────────────────────
   * 顺序：QQBrowser 排第一（用户实际跑采集用的就是它 —— 实测 9222 上是它）。 */
  if (win) {
    const SYS: readonly { id: string, name: string, paths: readonly string[] }[] = [
      { id: 'qqbrowser', name: 'QQ 浏览器', paths: [
        'C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
        'C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe',
        /* ⚠️ 实测：用户装在 **D 盘**（`D:\Program Files\...`）。
         * 常见盘符都列一遍 —— 猜不到就靠上面「问进程」那层。 */
        'D:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
        'D:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe',
        'E:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
        'F:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
      ] },
      { id: 'chrome', name: 'Google Chrome', paths: [
        ...(local === '' ? [] : [local + '\\Google\\Chrome\\Application\\chrome.exe']),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ] },
      { id: 'edge', name: 'Microsoft Edge', paths: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ] },
    ]
    for (const b of SYS) {
      /* ① 运行中进程给出的真实路径优先；② 退回常见路径；③ 都没有 = null（但列出「找过哪」）。 */
      const fromProc = runningPaths.get(b.id)
      const hit = fromProc !== undefined && existsSync(fromProc)
        ? fromProc
        : b.paths.find(p => existsSync(p))
      out.push({ id: b.id, name: b.name, path: hit ?? null, source: 'system', cdpReady: false })
    }
    /* 运行中但不在上表里的（如 firefox）也列出来 —— 用户机器上有什么就该看到什么。 */
    for (const [id, p] of runningPaths) {
      if (out.some(b => b.id === id)) continue
      const name = id === 'firefox' ? 'Mozilla Firefox' : id
      out.push({ id, name, path: existsSync(p) ? p : null, source: 'system', cdpReady: false })
    }
  }

  /* ── ② Playwright 自带的那份 ────────────────────────────────────
   * 它装在缓存目录里，目录名是 `<名字>-<版本>`（如 `chromium-1200`）。 */
  {
    const dirs = [
      ...(win && local !== '' ? [join(local, 'ms-playwright')] : []),
      join(home, '.cache', 'ms-playwright'),
    ]
    /** 认出最高版本的浏览器（同名只留一个）。 */
    const best = new Map<string, { version: number, dir: string }>()
    for (const d of dirs) {
      if (!existsSync(d)) continue
      let entries: string[] = []
      try { entries = readdirSync(d) } catch { continue }
      for (const e of entries) {
        const m = /^([a-z_]+)-(\d+)$/.exec(e)
        if (m === null) continue
        /* 只认能当浏览器用的（ffmpeg 是录屏工具，不是浏览器）。 */
        const key = m[1] === 'chromium_headless_shell' ? 'chromium' : m[1]
        if (key !== 'chromium' && key !== 'firefox' && key !== 'webkit') continue
        const v = Number(m[2])
        const prev = best.get(key)
        if (prev === undefined || v > prev.version) best.set(key, { version: v, dir: join(d, e) })
      }
    }
    for (const [key, v] of best) {
      const name = key === 'chromium' ? 'Chromium（Playwright 自带）'
        : key === 'firefox' ? 'Firefox（Playwright 自带）'
          : 'WebKit（Playwright 自带）'
      /* ⚠️ `path` 要指向**那一份里的可执行文件**（不是目录）——
       * 因为它会被当作 `executablePath` 传给 `chromium.launch()`，
       * 而 launch 要的是 exe 文件、不是目录。
       *
       * 实测（2026-10-13）**这条很要紧**：本机缓存里有 chromium-1208 / 1234，
       * 而 playwright 1.64.0 声明要 **1248** —— 所以「不带路径让它自己找」会失败，
       * 但**指定已有那份的 exe 就能起来**（实测跑通了 example.com）。
       * 所以这几份必须列出来让用户能选，否则「启动式」看着有、实际选不了。 */
      out.push({ id: 'pw-' + key, name, path: chromiumExeOf(v.dir) ?? v.dir, source: 'playwright', cdpReady: false })
    }
  }

  /* ── ③ CDP 端点：用户**已经开着、带调试端口**的那些浏览器 ──────────
   *
   * 这是采集唯一该用的方式（保留登录态）。
   *
   * ⚠️ **2026-10-14 改造**：原来是「探一个写死端口、只回报在不在听」。
   * 现在**扫全部监听端口**、用 `/json/version` 逐个确认，**带回浏览器版本** ——
   * 这样「检测」按钮就能列出「端口 9222 → Chrome/138.0.7204.0」这种给人看的结果，
   * 用户点一下就知道该填哪个端口（而不是靠猜）。 */
  const endpoints = await scanCdp()
  const listening = endpoints.length > 0
  for (const e of endpoints) {
    /* 找到几个列几个（每个端点一条），名称里带上端口与版本 ——
     * 界面上要能直接看懂「这条是哪个」。 */
    out.push({
      id: 'cdp-' + String(e.port),
      name: 'CDP 端口 ' + String(e.port)
        + (e.browser === null ? '' : ' —— ' + e.browser),
      path: null,
      source: 'cdp',
      cdpReady: true,
    })
  }
  /* 一个 CDP 端点都没找到时，把系统里第一个 Chromium 系标成「可作 CDP 目标」——
   * 用户手动带 `--remote-debugging-port=<端口>` 启动它，再回来点「检测」即可。 */
  const firstChromium = out.find(b => b.path !== null && ['qqbrowser', 'chrome', 'edge', 'pw-chromium'].includes(b.id))
  if (!listening && firstChromium !== undefined) firstChromium.cdpReady = true

  return {
    ok: true,
    browsers: out,
    /* ⚠️ **不再回报单个 `port`**（那个字段本身就是硬编码思路的残留）——
     * 改为回报**找到的全部端点**，让前端列出选择。 */
    cdp: { listening, endpoints },
    platform: process.platform,
  }
}

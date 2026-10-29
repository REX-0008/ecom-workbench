/** 浏览器偏好的**落盘**（用户 2026-10-20：「从画布打开不了 / 从列表启动找不到浏览器」）。
 *
 * ## 为什么要落盘
 *
 * 原来浏览器偏好只存在**浏览器的 localStorage** 里（`browser-settings.ts` 的 `KEY`）。
 * 画布在打开 / 改参数时会把它写进节点参数（`syncBrowserLayer`），所以从画布跑没问题。
 *
 * 但**从列表点「执行」不经过画布** —— 宿主半直接读存档里的参数，而存档里
 * 从来没写过端口（`port` 是 undefined）→ 驱动报「连不上浏览器」。
 *
 * 所以偏好必须落到一个**宿主半读得到**的地方：插件数据目录下的一个 JSON。
 *
 * ## 为什么不让宿主半去读 localStorage
 *
 * 读不到 —— 那是浏览器进程里的东西。宿主半是独立的 Node 进程。
 *
 * ## 两份的关系（重要）
 *
 *   - **文件是权威**：宿主半只读它。
 *   - **localStorage 是画布的快速缓存**：画布启动时先读文件、再退回 localStorage。
 *   - 写入走**两个都写**：`savePrefsFile` 写盘，`writePrefs` 写 localStorage。
 *     只写一个会让两边漂（见 `pitfalls/同一件事写两份迟早漂.md`）。
 *
 * ## 为什么这个文件里没有 IO
 *
 * 按 `AGENTS.md` 的分层：能碰磁盘的是宿主半。而这份数据**客户端也要读**
 * （它要显示设置面板），所以：
 *
 *   - 这里只放**纯规则**（解析、归一、合并），两侧共用、可单测；
 *   - 真正读写文件在宿主半那条路由里（`src/index.ts` 的 `/browser/prefs`）。
 */
import type { BrowserPrefs } from '../client/workbench/browser-settings.ts'

/** 偏好文件名（插件数据目录下）。 */
export const PREFS_FILE = 'browser-prefs.json'

/**
 * 把任意输入解析成一份**可用的**偏好。
 *
 * 容错的理由：这份文件是**手也能改**的（它就在数据目录里），
 * 而且老版本可能写出缺字段的内容。读坏一个字段不该让整个设置面板崩。
 *
 * ⚠️ 这里**不补默认端口** —— 用户 2026-10-14 明确定过「端口不能硬编码」。
 * 缺就是空串，由驱动明确报错。
 *
 * @param raw - 读到的 JSON（可能是 null / 字符串 / 残缺对象）。
 * @returns 偏好（一定带齐全部字段）。
 */
export function normalizePrefs(raw: unknown): BrowserPrefs {
  const empty: BrowserPrefs = {
    defaultBrowserId: '',
    defaultSource: 'cdp',
    defaultPort: '',
    defaultOpenMode: 'headed',
    defaultLauncher: 'cdp',
    tags: {},
  }
  if (raw === null || typeof raw !== 'object') return empty
  const o = raw as Record<string, unknown>
  const str = (v: unknown, dflt: string): string => (typeof v === 'string' ? v : dflt)
  /**
   * 端口串：**数字也收**。
   *
   * 为什么：这份文件是**手也能改**的（就在数据目录里），
   * 有人会写 `"defaultPort": 9222`（不带引号）。只认字符串的话
   * 那个值会被静默丢掉 —— 表现成「我明明填了端口，它说没填」。
   *
   * @param v - 原值。
   * @returns 端口串（非法值给空串）。
   */
  const portStr = (v: unknown): string => {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  const src = o.defaultSource === 'app' ? 'app' : o.defaultSource === 'cdp' ? 'cdp' : 'cdp'
  const openMode = o.defaultOpenMode === 'headless' ? 'headless' : 'headed'

  /** 标签表：逐项校验，坏项丢掉（不整份失败）。 */
  const tags: BrowserPrefs['tags'] = {}
  if (o.tags !== null && typeof o.tags === 'object' && !Array.isArray(o.tags)) {
    for (const [tag, v] of Object.entries(o.tags as Record<string, unknown>)) {
      if (tag.trim() === '' || v === null || typeof v !== 'object') continue
      const t = v as Record<string, unknown>
      const tSrc = t.source === 'app' ? 'app' : t.source === 'cdp' ? 'cdp' : src
      const tMode = t.openMode === 'headless' ? 'headless' : openMode
      tags[tag] = {
        source: tSrc,
        browserId: str(t.browserId, ''),
        port: portStr(t.port),
        exePath: str(t.exePath, ''),
        openMode: tMode,
        /* `launcher` 由 source + openMode 唯一决定，**不信任存档里那个值**
         * （老存档里它与 source 可能对不上）。规则只有一份：cdp 就是 cdp，
         * 否则看 openMode。 */
        launcher: tSrc === 'cdp' ? 'cdp' : (tMode === 'headless' ? 'headless' : 'headed'),
      }
    }
  }

  return {
    defaultBrowserId: str(o.defaultBrowserId, ''),
    defaultSource: src,
    defaultPort: portStr(o.defaultPort),
    defaultOpenMode: openMode,
    defaultLauncher: src === 'cdp' ? 'cdp' : (openMode === 'headless' ? 'headless' : 'headed'),
    tags,
  }
}

/**
 * 把浏览器偏好**写进一次运行的节点规格**（宿主半在跑之前调它）。
 *
 * ## 为什么必须做
 *
 * 存档里的浏览器节点只有 `session`（标签名），没有 `launcher` / `exePath` / `port`
 * —— 那三个是画布在**打开时**才补进去的（`syncBrowserLayer`）。
 * 从列表启动不经过画布，于是驱动拿到的 `port` 是空 → 报「连不上浏览器」。
 *
 * ## 为什么在宿主半补而不是改存档
 *
 * 改存档等于「跑一次就改一次文件」，用户会看到「我没动它，它却变成已修改」。
 * 而这三个值**本来就是从偏好推导出来的**（不是用户逐个节点填的），
 * 所以每次跑的时候现算才是对的。
 *
 * ⚠️ **只补缺的、不覆盖已有的**：用户在节点上显式填过端口时以他为准。
 *
 * @param specs - 这次要跑的节点规格（会被就地改）。
 * @param prefs - 当前偏好。
 * @returns 补了几个节点（0 表示不用改）。
 */
export function applyPrefsToSpecs<T extends {
  def: { id: string }
  params: Record<string, unknown>
}>(specs: readonly T[], prefs: BrowserPrefs): number {
  let n = 0
  for (const s of specs) {
    if (s.def.id !== 'browser.act' && s.def.id !== 'browser.download') continue
    /* 只有「浏览器会话」类节点会读这些（它们一定有 session 参数）。 */
    if (!('session' in s.params)) continue
    const tag = String(s.params.session ?? '默认')
    /* 解析规则与画布**同一条**：标签自己配过就用它的，否则跟全局默认。 */
    const own = prefs.tags[tag]
    const src = own?.source ?? prefs.defaultSource
    const mode = own?.openMode ?? prefs.defaultOpenMode
    const port = own?.port !== undefined && own.port !== '' ? own.port : prefs.defaultPort
    const exePath = own?.exePath ?? ''
    const launcher = src === 'cdp' ? 'cdp' : (mode === 'headless' ? 'headless' : 'headed')

    const cur = s.params
    let touched = false
    /* 缺才补（用户显式填过就不动）。 */
    if (cur.launcher === undefined || cur.launcher === '') { cur.launcher = launcher; touched = true }
    if (cur.exePath === undefined) { cur.exePath = exePath; touched = true }
    if (cur.port === undefined || cur.port === '') {
      if (port !== '') { cur.port = port; touched = true }
    }
    if (touched) n += 1
  }
  return n
}

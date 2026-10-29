/** 浏览器设置：**两层结构**（纯逻辑 + 持久化，可单测）。
 *
 * ## 用户 2026-10-13 定的两层（原话）
 *
 * > 「关于两层浏览器的选项：**第一层**，用来关联多个节点的**自定义名称**的浏览器设置，
 * > **第二层**，用来决定通过什么方式打开页面用什么浏览器的。
 * > **第一层决定第二层**，也就是，当第一层确定了第二层用什么，**其他的节点第二层自动统一**
 * > （保持一致性，不然，明明用来保证一个页面的标签一样，浏览器不一样，
 * > 那么运行必然会出问题，甚至不一定是报错）。」
 *
 * ```
 * 第一层：浏览器标签（自定义名称，如 淘宝 / 抖音 / 默认）
 *            │  决定
 *            ▼
 * 第二层：用哪个浏览器 + 用哪种启动方式（CDP / 有头 / 无头）
 * ```
 *
 * **关键约束**：同名的标签**只有一个第二层配置** —— 所以「同名不同浏览器」
 * 在**数据结构上就不可能**（不是靠校验去拦）。这正是用户要的「自动统一」。
 *
 * ## 用户还定的两条（2026-10-13）
 *
 * - **「设置里面选一个作为默认」** + 「**可全局覆盖**」：
 *   设置里指定默认浏览器；某个标签可以单独覆盖成另一个。
 * - **「不用多个端口……我要固定使用这个浏览器，使用他的 cookie 来记住并更新登录态」**：
 *   当初由此把端口**写死 9222**。
 *
 * ## ★ 2026-10-14 改造：端口**不写死**，改成前端手填（用户 #7）
 *
 * 用户原话：
 *
 * > 「我希望 **9222 这个不是默认而是前端可见的手填项目**，**不能是硬编码的**。」
 *
 * 以及对本文件这层的分类改造：
 *
 * > 「**选择浏览器既可以选择一个可以被打开的浏览器，也可以使用 CDP 连接一个已打开的浏览器，
 * > 他们都是选择浏览器，而不是选择打开方式。**」
 *
 * 所以第二层从「三选一的 `launcher`」变成了**两个来源**：
 *
 * ```
 * 第二层：source = 'cdp'  → 要 port   （连一个已开的调试端口）
 *        source = 'app'  → 要 browserId + exePath + openMode（打开一个本机装着的）
 * ```
 *
 * ⚠️ **`launcher` 仍是存进节点 params 、驱动真正读的那个值** ——
 * 但它现在是**从 `source` 推导出来的**（见 `launcherOf`），不再由用户直接选。
 * 这样驱动与存档格式**一个字都不用改**（老存档照样读得懂）。
 */

/** 「用哪个浏览器」的来源：连一个已开的 / 打开一个本机装着的。 */
export type TagSource = 'cdp' | 'app'

/** 「打开一个本机装着的」时，窗口可不可见。 */
export type TagOpenMode = 'headed' | 'headless'

/** 第二层：一个标签用哪个浏览器、怎么用。 */
export interface TagBrowser {
  /**
   * **来源**：连一个已经开着的调试端口（`cdp`）/ 打开一个本机装着的（`app`）。
   *
   * ⚠️ 这是用户实际选的那一项；下面那些字段是**跟着来源走**的。
   */
  source: TagSource
  /**
   * 用哪个浏览器（`BrowserCandidate.id`）。
   *
   * ⚠️ **空串 = 用全局默认**（用户要的「全局可覆盖」）。
   * ⚠️ 只在 `source === 'app'` 时有意义 —— `cdp` 是连一个已开的，不用选可执行文件。
   */
  browserId: string
  /**
   * **CDP 调试端口**（用户手填，**不再硬编码 9222**）。
   *
   * 只在 `source === 'cdp'` 时有意义。
   * ⚠️ **空串 = 还没填**（那是合法状态，但**跑之前会被拦住并给出明确指引**，
   * 见 `resolveTag` 的说明与驱动里的报错）。
   */
  port: string
  /**
   * 可执行文件路径（`source === 'app'` 时才用得上）。
   *
   * 留空则用该浏览器的自动检测路径。
   */
  exePath: string
  /**
   * 打开方式的属性：**有窗口 / 无窗口**（只在 `source === 'app'` 时有意义）。
   *
   * ⚠️ 用户 2026-10-14 明确：**「有头/无头」不是「用哪个浏览器」，是打开方式的属性** ——
   * 所以它降级成这里的一个附属字段，不再与「选浏览器」并列。
   */
  openMode: TagOpenMode
  /**
   * 驱动真正读的值（`cdp` / `headed` / `headless`）。
   *
   * ⚠️ **由 `launcherOf(source, openMode)` 推导，不由用户直接选** ——
   * 保留它是因为驱动与存档格式都按这个键读（行为上**一个字都没改**）。
   */
  launcher: 'cdp' | 'headed' | 'headless'
}

/**
 * 从「来源 + 打开方式」推导驱动要的 `launcher`。
 *
 * @param source - 来源。
 * @param openMode - 打开方式（只有来源是 `app` 时用得上）。
 * @returns 驱动认识的三个值之一。
 */
export function launcherOf(source: TagSource, openMode: TagOpenMode): TagBrowser['launcher'] {
  if (source === 'cdp') return 'cdp'
  return openMode === 'headless' ? 'headless' : 'headed'
}

/** 第一层 + 第二层：标签名 → 它的浏览器配置。 */
export interface BrowserPrefs {
  /**
   * **全局默认**用哪个浏览器（用户：「设置里面选一个作为默认」）。
   *
   * 空串 = 还没选过（第一次用时按检测结果自动挑一个能用的）。
   */
  defaultBrowserId: string
  /**
   * 全局默认的来源。
   *
   * ⚠️ 老存档里没有这个字段 → 按下面的 `defaultLauncher` 推断（见 `readPrefs`）。
   */
  defaultSource: TagSource
  /** 全局默认的 CDP 端口（手填）。 */
  defaultPort: string
  /** 全局默认的打开方式属性（`source === 'app'` 时用）。 */
  defaultOpenMode: TagOpenMode
  /**
   * 全局默认的 `launcher`（**推导值的缓存**，为了兼容老存档与驱动）。
   *
   * ⚠️ 现在它由 `defaultSource` + `defaultOpenMode` 推导（见 `launcherOf`）；
   * 保留它是为了**读得懂老存档**（那时只有 `launcher` 一个字段）。
   */
  defaultLauncher: TagBrowser['launcher']
  /**
   * 每个标签的第二层配置（**按标签名索引** —— 这就是「自动统一」的实现：
   * 同名只可能有一份配置）。
   */
  tags: Record<string, TagBrowser>
}

/** 一份空的偏好（第一次运行时的值）。 */
export const EMPTY_PREFS: BrowserPrefs = {
  defaultBrowserId: '',
  /* ⚠️ 默认来源是 CDP —— 实测依据（2026-10-14）：
   * 用户日常那个浏览器**已经在跑**时，再启动一次带调试端口的同一个浏览器
   * **不会起第二个主进程**（它被现有实例吸收成新标签页），所以「我们打开一个」
   * 这条路在日常场景下**本来就不可用**；而 CDP 是唯一能复用登录态的方式
   * （登录态是本项目的前提）。详细核实结论见本次 T7 交付说明。 */
  defaultSource: 'cdp',
  /** ⚠️ **不给默认端口** —— 用户明确要求「不是默认而是前端可见的手填项目」。 */
  defaultPort: '',
  defaultOpenMode: 'headed',
  defaultLauncher: 'cdp',
  tags: {},
}

/** localStorage 的键。 */
const KEY = 'ewb.browserPrefs'

/**
 * 读一个标签的第二层配置（**含老存档迁移**）。
 *
 * ## 老存档长什么样（2026-10-14 之前）
 *
 * ```
 * { browserId: 'qqbrowser', launcher: 'cdp' | 'headed' | 'headless', exePath: '' }
 * ```
 *
 * **没有 `source` / `port` / `openMode`** —— 那时端口写死 9222、CDP 与有头无头并列。
 * 迁移规则（**只补字段，不改语义**）：
 *   · `launcher === 'cdp'` → `source: 'cdp'`；**端口留空**
 *   · `launcher === 'headed' | 'headless'` → `source: 'app'` + 对应 `openMode`
 *   · 有 `source` 的新存档 → 以它为准，`launcher` 重新推导（保持自洽）
 *
 * ⚠️ **端口留空**（不是填 9222）：迁移时把 9222 塞回去就等于**继续硬编码**，
 * 而那正是这次要消灭的东西。留空后界面会提示用户填/点检测 —— 用户看得到、
 * 改得动；而 9222 那种「悄悄替你连」的做法正是他点名不要的。
 *
 * @param v - 原始值（可能是任何形状）。
 * @param fallbackPort - 没读到端口时用什么（全局默认的端口）。
 * @returns 合法的第二层配置。
 */
function readTag(v: unknown, fallbackPort: string): TagBrowser {
  const t = (v ?? {}) as Partial<TagBrowser> & { launcher?: unknown }
  const legacy: TagBrowser['launcher'] = t.launcher === 'headed' || t.launcher === 'headless'
    ? t.launcher
    : 'cdp'
  /* 有 `source` 就用它（新存档）；没有就从老的 `launcher` 反推。 */
  const source: TagSource = t.source === 'app' || t.source === 'cdp'
    ? t.source
    : legacy === 'cdp' ? 'cdp' : 'app'
  const openMode: TagOpenMode = t.openMode === 'headless' || t.openMode === 'headed'
    ? t.openMode
    : legacy === 'headless' ? 'headless' : 'headed'
  return {
    source,
    browserId: typeof t.browserId === 'string' ? t.browserId : '',
    /* 端口：**老存档没有这个字段** → 用全局默认的（通常也是空的），绝不回填 9222。 */
    port: typeof t.port === 'string' && t.port.trim() !== '' ? t.port.trim() : fallbackPort,
    exePath: typeof t.exePath === 'string' ? t.exePath : '',
    openMode,
    /* ⚠️ 一律**重新推导**，不信任存档里的值 —— 否则改坏了 `source` 之后
     * `launcher` 会与它对不上，表现为「界面说连已有的、实际去启动一个」。 */
    launcher: launcherOf(source, openMode),
  }
}

/**
 * 读偏好（容错：存档坏了就退回空值，不抛）。
 *
 * ⚠️ **必须容错**：localStorage 可能被手改、也可能存的是老版本形状。
 * 抛错会让整个画布设置面板打不开 —— 那比「读回默认值」严重得多。
 *
 * ⚠️ **也要能读懂老形状**（只有 `launcher`、没有 `source` / `port`）——
 * 用户升级后不该发现「浏览器设置全没了」。迁移规则见 `readTag`。
 *
 * @param raw - 原始字符串（不传则从 localStorage 读）。
 * @returns 偏好（保证形状正确）。
 */
export function readPrefs(raw?: string | null): BrowserPrefs {
  let text = raw
  if (text === undefined) {
    try { text = localStorage.getItem(KEY) } catch { text = null }
  }
  if (text === null || text === undefined || text.trim() === '') return { ...EMPTY_PREFS, tags: {} }
  try {
    const o = JSON.parse(text) as Partial<BrowserPrefs>
    /* 全局默认的端口先读出来 —— 标签若自己没填就跟着它。 */
    const defPort = typeof o.defaultPort === 'string' ? o.defaultPort.trim() : ''
    const tags: Record<string, TagBrowser> = {}
    if (o.tags !== null && typeof o.tags === 'object') {
      for (const [k, v] of Object.entries(o.tags as Record<string, unknown>)) {
        if (k.trim() === '' || v === null || typeof v !== 'object') continue
        tags[k] = readTag(v, defPort)
      }
    }
    /* 全局默认按**同一条迁移规则**读（老存档只有 defaultLauncher）。 */
    const def = readTag({
      source: o.defaultSource,
      browserId: o.defaultBrowserId,
      port: defPort,
      openMode: o.defaultOpenMode,
      launcher: o.defaultLauncher,
    }, '')
    return {
      defaultBrowserId: def.browserId,
      defaultSource: def.source,
      defaultPort: def.port,
      defaultOpenMode: def.openMode,
      defaultLauncher: def.launcher,
      tags,
    }
  } catch {
    return { ...EMPTY_PREFS, tags: {} }
  }
}

/**
 * 写偏好（失败静默 —— 存不了不影响本次使用）。
 *
 * @param p - 要存的偏好。
 */
export function writePrefs(p: BrowserPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* 存不了就跳过 */ }
}

/**
 * 从**可能不完整**的偏好里取出「全局默认来源」。
 *
 * ⚠️ **必须容错**（2026-10-14 加）：`source` 是这次新加的字段，
 * 而 `resolveTag` 的调用方可能拿着一个**老形状**的偏好对象
 * （只有 `defaultLauncher`），也可能拿着手写一半的对象（测试里就是）。
 * 那时若直接读 `prefs.defaultSource` 会得到 `undefined`，
 * 于是解析结果里 `source` 是 undefined —— 界面上表现为「来源那一栏是空的」，
 * 而它**不会报错**（最难查的那种）。
 *
 * 所以这里一律**从 `launcher` 反推**作为兜底：老字段能唯一确定新字段。
 *
 * @param prefs - 偏好（可能缺字段）。
 * @returns 来源。
 */
function sourceFallback(prefs: BrowserPrefs): TagSource {
  return prefs.defaultSource === 'app' || prefs.defaultSource === 'cdp'
    ? prefs.defaultSource
    : prefs.defaultLauncher === 'cdp' ? 'cdp' : 'app'
}

/**
 * 从**可能不完整**的偏好里取出「全局默认打开方式」（理由同上）。
 *
 * @param prefs - 偏好（可能缺字段）。
 * @returns 打开方式。
 */
function openModeFallback(prefs: BrowserPrefs): TagOpenMode {
  return prefs.defaultOpenMode === 'headless' || prefs.defaultOpenMode === 'headed'
    ? prefs.defaultOpenMode
    : prefs.defaultLauncher === 'headless' ? 'headless' : 'headed'
}

/**
 * **解析**：一个标签最终用哪个浏览器、怎么连。
 *
 * ## 这就是「第一层决定第二层」的落地点
 *
 * 顺序（后者覆盖前者）：
 *   1. 全局默认（设置里选的那个）
 *   2. 该标签自己的配置（若它指定了来源）—— 用户要的「可全局覆盖」
 *
 * ⚠️ 节点上**不存**第二层 —— 它只存标签名，第二层每次在这里解析。
 * 所以「改标签的浏览器设置」会**自动影响所有用该标签的节点**（用户要的自动统一）。
 *
 * ⚠️ **对老形状 / 不完整的偏好也要给出正确结论**（见 `sourceFallback`）——
 * 本函数是「界面怎么显示」与「驱动怎么连」的**唯一共同来源**，
 * 它一旦返回 undefined，两者就分叉了。
 *
 * ## ★ 「不填端口」的行为（明确，不留坑）
 *
 * 用户 2026-10-14 要求端口**手填、不硬编码**，于是「没填」就成了一个必须定义的状态。
 * 本函数**不替用户猜端口**（猜 = 又一次硬编码），而是：
 *   · `port` 原样返回空串 → 由界面**明确显示「还没填端口」**；
 *   · 由驱动在**真跑的时候拦住并说清怎么办**（见 `driver.mjs` 里的那段报错）。
 *
 * 这样「没填」的后果是**一句能看懂的报错**，而不是「悄悄连 9222、连不上还怪浏览器没开」。
 *
 * @param prefs - 偏好。
 * @param tag - 标签名（节点上的「用哪个浏览器」）。
 * @param fallbackBrowserId - 全局默认也是空时用的兜底（通常是检测到的第一个能用的）。
 * @returns 解析结果（`port` 可能为空串；`browserId` 也可能为空串 —— 调用方要处理）。
 */
export function resolveTag(
  prefs: BrowserPrefs,
  tag: string,
  fallbackBrowserId = '',
): TagBrowser {
  const own = prefs.tags[tag]
  const defSource = sourceFallback(prefs)
  const defOpenMode = openModeFallback(prefs)
  /* 来源：标签自己指定了就用它（新存档总有 `source`）；否则用全局默认的。
   * ⚠️ 老存档里标签只有 `launcher` → 按它反推（与 `readTag` 同一条规则）。 */
  const ownSource: TagSource = own?.source === 'app' || own?.source === 'cdp'
    ? own.source
    : own?.launcher === 'cdp' ? 'cdp' : own?.launcher === undefined ? defSource : 'app'
  const source: TagSource = own === undefined ? defSource : ownSource
  const browserId = (own?.browserId ?? '') !== ''
    ? (own?.browserId as string)
    : prefs.defaultBrowserId !== '' ? prefs.defaultBrowserId : fallbackBrowserId
  const ownOpen: TagOpenMode = own?.openMode === 'headless' || own?.openMode === 'headed'
    ? own.openMode
    : own?.launcher === 'headless' ? 'headless' : own?.launcher === 'headed' ? 'headed' : defOpenMode
  const openMode: TagOpenMode = own === undefined ? defOpenMode : ownOpen
  /* 端口：标签自己填了就用它，否则跟着全局默认（**全局默认也可能是空串**）。 */
  const ownPort = typeof own?.port === 'string' ? own.port : ''
  const defPort = typeof prefs.defaultPort === 'string' ? prefs.defaultPort : ''
  const port = ownPort !== '' ? ownPort : defPort
  return {
    source,
    browserId,
    /* ⚠️ 来源不是 CDP 时端口**一律清空** ——
     * 否则「切到本机浏览器」之后端口还留在解析结果里，
     * 别人看到会以为「它还在连端口」。 */
    port: source === 'cdp' ? port : '',
    exePath: own?.exePath ?? '',
    openMode,
    /* ⚠️ 从 source + openMode 推导，**不读存档里的 launcher** ——
     * 这样即使存档被手改过，「界面显示什么」与「驱动实际怎么连」也不会分叉。 */
    launcher: launcherOf(source, source === 'app' ? openMode : 'headed'),
  }
}

/**
 * 解析结果**能不能真的跑**（界面与驱动都据此拦）。
 *
 * 用户 2026-10-14 明确要「不填端口时的行为有明确定义」——这里就是那个定义：
 * **跑不了，但原因说得清**（不是「连不上 :」这种）。
 *
 * @param t - `resolveTag` 的结果。
 * @returns `ok` 与（不能跑时）一句给人看的原因。
 */
export function checkRunnable(t: TagBrowser): { ok: boolean, reason: string } {
  if (t.source === 'cdp') {
    if (t.port.trim() === '') {
      return {
        ok: false,
        reason: '这个标签是「已开的调试端口（CDP）」，但还没填端口。'
          + '去节点的浏览器设置里填一个端口，或点「检测」把它找出来。',
      }
    }
    return { ok: true, reason: '' }
  }
  /* 来源是「本机装着的浏览器」：要么指定了 exe，要么让 playwright 用自带的 ——
   * 后者是合法配置（实测可用），所以这里不拦。 */
  return { ok: true, reason: '' }
}

/**
 * 列出**所有标签名**（去重排序）。
 *
 * 用途：界面上要让人看到「哪些标签已经有了自己的设置」。
 *
 * @param prefs - 偏好。
 * @param usedTags - 画布上正在用到的标签（这些即使没配置也要列出来）。
 * @returns 标签名列表。
 */
export function allTags(prefs: BrowserPrefs, usedTags: readonly string[]): string[] {
  const s = new Set<string>([...Object.keys(prefs.tags), ...usedTags])
  return [...s].filter(t => t.trim() !== '').sort()
}

/**
 * 设置一个标签的第二层配置（返回**新对象**，不改原对象 —— 便于 React 比对）。
 *
 * @param prefs - 原偏好。
 * @param tag - 标签名。
 * @param next - 新的第二层配置。
 * @returns 新偏好。
 */
export function setTag(prefs: BrowserPrefs, tag: string, next: TagBrowser): BrowserPrefs {
  return { ...prefs, tags: { ...prefs.tags, [tag]: next } }
}

/**
 * 删掉一个标签的配置（它就退回全局默认）。
 *
 * @param prefs - 原偏好。
 * @param tag - 标签名。
 * @returns 新偏好。
 */
export function removeTag(prefs: BrowserPrefs, tag: string): BrowserPrefs {
  const tags = { ...prefs.tags }
  delete tags[tag]
  return { ...prefs, tags }
}
